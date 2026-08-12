// Minimal Elasticsearch HTTP client for the Watchlog agent.
//
// Deliberately built on node's own http/https rather than
// @elastic/elasticsearch: the official client refuses to talk to a cluster
// whose major version does not match its own, and Watchlog has to monitor 7.x,
// 8.x and 9.x from one agent build. Every call here is a plain GET (plus the
// one POST that Cluster Allocation Explain requires), so a full client buys
// nothing and costs compatibility.
//
// Rules this module enforces for the whole integration:
//   * Read-only. `request()` accepts GET and POST, and the only POST caller is
//     _cluster/allocation/explain, which is a diagnostic query. Nothing here can
//     express DELETE, PUT or _cluster/reroute.
//   * Credentials never leave this file. They go into the Authorization header
//     and are never logged, never echoed into an error message and never
//     copied into a payload. `describeError()` builds its message from the
//     status code and Elasticsearch's own error type only.
//   * Responses are bounded. A 4 GB _stats response on a huge cluster must not
//     be able to exhaust the agent's heap, so the socket is destroyed once the
//     configured ceiling is passed.

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const DEFAULTS = {
    requestTimeoutMs: 15000,
    maxResponseBytes: 24 * 1024 * 1024,
    retries: 2,
    retryBaseDelayMs: 250
};

// Transport-level failures that are worth one more attempt. A refused
// connection is not: the port is either listening or it is not, and retrying
// only delays the collection cycle.
const RETRYABLE_CODES = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ESOCKETTIMEDOUT', 'TIMEOUT'
]);
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

// TLS failures are worth reporting distinctly: "certificate has expired" tells
// an operator exactly what to fix, where "request failed" does not.
const TLS_CODE_HINTS = {
    DEPTH_ZERO_SELF_SIGNED_CERT: 'the server presented a self-signed certificate',
    SELF_SIGNED_CERT_IN_CHAIN: 'the certificate chain contains a self-signed certificate',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'the certificate chain could not be verified',
    CERT_HAS_EXPIRED: 'the server certificate has expired',
    ERR_TLS_CERT_ALTNAME_INVALID: 'the certificate does not match the hostname',
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'the issuing certificate is not trusted locally'
};

/**
 * Error carrying a classified, credential-free description.
 *
 * `kind` is what the connection test and the capability probe branch on;
 * `message` is safe to show a user and safe to write to a log.
 */
class ElasticsearchRequestError extends Error {
    constructor(kind, message, extra) {
        super(message);
        this.name = 'ElasticsearchRequestError';
        this.kind = kind;
        Object.assign(this, extra || {});
    }
}

/**
 * Resolves the configured endpoint into a base URL.
 *
 * Accepts either a full `url` or the host/port/protocol triple. Any userinfo
 * embedded in the URL (https://user:pass@host:9200) is stripped and moved into
 * the credential fields so it can never be logged as part of a URL.
 */
function resolveEndpoint(config) {
    const raw = String(config.url || '').trim();

    if (raw) {
        let parsed;
        try {
            parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
        } catch (err) {
            throw new ElasticsearchRequestError('config', 'Elasticsearch URL is not valid');
        }

        const username = parsed.username ? decodeURIComponent(parsed.username) : '';
        const password = parsed.password ? decodeURIComponent(parsed.password) : '';
        parsed.username = '';
        parsed.password = '';

        const protocol = parsed.protocol.replace(':', '');
        const port = Number(parsed.port || (protocol === 'https' ? 443 : 80));

        return {
            protocol,
            host: parsed.hostname,
            port,
            // Trailing slash removed so path joining is unambiguous.
            basePath: parsed.pathname.replace(/\/+$/, ''),
            // URL credentials only apply when the config does not carry its own.
            embeddedUsername: username,
            embeddedPassword: password
        };
    }

    const protocol = String(config.protocol || (config.ssl || config.tls ? 'https' : 'http'))
        .replace(':', '').toLowerCase() === 'https' ? 'https' : 'http';
    const host = String(config.host || '127.0.0.1').trim() || '127.0.0.1';
    const port = Number(config.port || 9200);

    return { protocol, host, port, basePath: '', embeddedUsername: '', embeddedPassword: '' };
}

/** Base64 basic-auth header value. Never logged. */
function basicAuth(username, password) {
    return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

/**
 * Builds the Authorization header.
 *
 * API key wins over basic auth when both are configured: an API key is the
 * narrower credential, so preferring it is the safer default.
 */
function buildAuthHeader(config) {
    const apiKey = String(config.apiKey || '').trim();
    if (apiKey) {
        // Elasticsearch accepts the base64 `id:api_key` form. A key pasted as
        // `id:api_key` is encoded here so both shapes work.
        const encoded = apiKey.includes(':')
            ? Buffer.from(apiKey, 'utf8').toString('base64')
            : apiKey;
        return `ApiKey ${encoded}`;
    }

    const username = String(config.username || '').trim();
    if (username) return basicAuth(username, String(config.password || ''));

    return null;
}

/**
 * Turns a transport error or a non-2xx response into a classified,
 * credential-free ElasticsearchRequestError.
 */
function describeError(err, statusCode, bodyText) {
    if (statusCode) {
        const type = extractErrorType(bodyText);
        if (statusCode === 401) {
            return new ElasticsearchRequestError('authentication_failed',
                'Authentication failed: Elasticsearch rejected the supplied credentials', { statusCode });
        }
        if (statusCode === 403) {
            return new ElasticsearchRequestError('permission_denied',
                `Permission denied: the monitoring user lacks the required privilege${type ? ` (${type})` : ''}`, { statusCode });
        }
        if (statusCode === 404) {
            return new ElasticsearchRequestError('unsupported_endpoint',
                'Endpoint not found: this Elasticsearch version does not expose that API', { statusCode });
        }
        if (statusCode === 429) {
            return new ElasticsearchRequestError('throttled',
                'Elasticsearch rejected the request because it is currently overloaded', { statusCode });
        }
        if (statusCode >= 500) {
            return new ElasticsearchRequestError('server_error',
                `Elasticsearch returned ${statusCode}${type ? ` (${type})` : ''}`, { statusCode });
        }
        return new ElasticsearchRequestError('request_failed',
            `Elasticsearch returned ${statusCode}${type ? ` (${type})` : ''}`, { statusCode });
    }

    const code = err && (err.code || err.name);

    if (code === 'ECONNREFUSED') {
        return new ElasticsearchRequestError('connection_refused',
            'Connection refused: nothing is listening on that host and port');
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return new ElasticsearchRequestError('host_not_found',
            'Host not found: the Elasticsearch hostname could not be resolved');
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
        return new ElasticsearchRequestError('connection_reset',
            'Connection reset by Elasticsearch before the response completed');
    }
    if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
        return new ElasticsearchRequestError('timeout',
            'Timed out waiting for Elasticsearch to respond');
    }
    if (code === 'RESPONSE_TOO_LARGE') {
        return new ElasticsearchRequestError('response_too_large',
            'Elasticsearch response exceeded the size the agent is willing to buffer');
    }
    if (code === 'INVALID_JSON') {
        return new ElasticsearchRequestError('invalid_response',
            'Elasticsearch returned a response that is not valid JSON');
    }
    if (code && TLS_CODE_HINTS[code]) {
        return new ElasticsearchRequestError('tls_error', `TLS error: ${TLS_CODE_HINTS[code]}`);
    }
    // EPROTO is what a TLS handshake against a plaintext port produces — the
    // single most common Elasticsearch misconfiguration, since 8.x defaults to
    // https and a self-managed cluster is frequently left on http.
    if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') {
        return new ElasticsearchRequestError('tls_error',
            'TLS error: the endpoint did not complete a TLS handshake. Check whether it serves http rather than https.');
    }
    if (code && (String(code).startsWith('ERR_TLS') || String(code).startsWith('ERR_SSL') ||
        String(code).includes('CERT') || String(code) === 'ERR_INVALID_PROTOCOL')) {
        return new ElasticsearchRequestError('tls_error', `TLS error: ${code}`);
    }

    // Falls back to the driver message, which for a plain socket error never
    // contains credentials — the Authorization header is not part of it.
    return new ElasticsearchRequestError('request_failed',
        `Request to Elasticsearch failed${code ? ` (${code})` : ''}`);
}

/** Pulls `error.type` out of an Elasticsearch error body without throwing. */
function extractErrorType(bodyText) {
    if (!bodyText) return '';
    try {
        const parsed = JSON.parse(bodyText);
        const error = parsed && parsed.error;
        if (!error) return '';
        if (typeof error === 'string') return String(error).slice(0, 120);
        return String(error.type || error.reason || '').slice(0, 120);
    } catch (e) {
        return '';
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Elasticsearch client bound to one configured endpoint.
 *
 * One instance per collection cycle; it holds a keep-alive agent so the ten or
 * so calls in a cycle reuse a single TCP (and TLS) connection.
 */
class ElasticsearchClient {
    constructor(config) {
        const endpoint = resolveEndpoint(config);

        this.protocol = endpoint.protocol;
        this.host = endpoint.host;
        this.port = endpoint.port;
        this.basePath = endpoint.basePath;

        this.authHeader = buildAuthHeader({
            apiKey: config.apiKey,
            username: config.username || endpoint.embeddedUsername,
            password: config.password || endpoint.embeddedPassword
        });

        this.requestTimeoutMs = Number(config.requestTimeoutMs) > 0
            ? Number(config.requestTimeoutMs) : DEFAULTS.requestTimeoutMs;
        this.maxResponseBytes = Number(config.maxResponseBytes) > 0
            ? Number(config.maxResponseBytes) : DEFAULTS.maxResponseBytes;
        this.retries = Number.isInteger(config.retries) ? config.retries : DEFAULTS.retries;

        const isHttps = this.protocol === 'https';
        this.transport = isHttps ? https : http;

        const agentOptions = { keepAlive: true, maxSockets: 4 };
        if (isHttps) {
            // Certificate verification stays on unless the operator explicitly
            // turned it off, and a supplied CA is honoured either way.
            agentOptions.rejectUnauthorized = config.rejectUnauthorized !== false;
            if (config.ca) agentOptions.ca = config.ca;
            if (config.servername) agentOptions.servername = config.servername;
        }
        this.agent = new (isHttps ? https.Agent : http.Agent)(agentOptions);
    }

    /** Endpoint identity, safe to embed in payloads: never carries credentials. */
    describeEndpoint() {
        return `${this.protocol}://${this.host}:${this.port}${this.basePath}`;
    }

    destroy() {
        try { this.agent.destroy(); } catch (e) { /* already closed */ }
    }

    /**
     * Issues one request, retrying transient failures with linear backoff.
     *
     * @param {string} path   absolute API path, e.g. '/_cluster/health'
     * @param {object} [opts] { method, body, timeoutMs, raw }
     *                        `raw` returns the response body as text without
     *                        parsing it — _nodes/hot_threads answers text/plain.
     */
    async request(path, opts = {}) {
        const method = String(opts.method || 'GET').toUpperCase();
        if (method !== 'GET' && method !== 'POST') {
            // Structural guarantee that this integration cannot mutate a cluster.
            throw new ElasticsearchRequestError('forbidden_method',
                'Watchlog only issues read-only Elasticsearch requests');
        }

        const attempts = this.retries + 1;
        let lastError = null;

        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return await this._once(path, method, opts);
            } catch (err) {
                lastError = err;
                const retryable = RETRYABLE_CODES.has(err.transportCode) ||
                    RETRYABLE_STATUS.has(err.statusCode);
                if (!retryable || attempt === attempts - 1) throw err;
                await sleep(DEFAULTS.retryBaseDelayMs * (attempt + 1));
            }
        }

        throw lastError;
    }

    _once(path, method, opts) {
        return new Promise((resolve, reject) => {
            const headers = {
                Accept: 'application/json',
                'User-Agent': 'watchlog-agent'
            };
            if (this.authHeader) headers.Authorization = this.authHeader;

            let payload = null;
            if (opts.body !== undefined && opts.body !== null) {
                payload = Buffer.from(JSON.stringify(opts.body), 'utf8');
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = payload.length;
            }

            const req = this.transport.request({
                protocol: `${this.protocol}:`,
                host: this.host,
                port: this.port,
                path: `${this.basePath}${path}`,
                method,
                headers,
                agent: this.agent
            });

            let settled = false;
            const fail = (err, statusCode, bodyText) => {
                if (settled) return;
                settled = true;
                const described = describeError(err, statusCode, bodyText);
                described.transportCode = err && (err.code || err.name);
                if (statusCode) described.statusCode = statusCode;
                reject(described);
            };

            req.setTimeout(Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.requestTimeoutMs, () => {
                const err = new Error('timeout');
                err.code = 'TIMEOUT';
                req.destroy(err);
            });

            req.on('error', (err) => fail(err));

            req.on('response', (res) => {
                const chunks = [];
                let size = 0;

                res.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > this.maxResponseBytes) {
                        const err = new Error('response too large');
                        err.code = 'RESPONSE_TOO_LARGE';
                        res.destroy();
                        req.destroy();
                        fail(err);
                        return;
                    }
                    chunks.push(chunk);
                });

                res.on('aborted', () => {
                    const err = new Error('aborted');
                    err.code = 'ECONNRESET';
                    fail(err);
                });

                res.on('end', () => {
                    if (settled) return;
                    const text = Buffer.concat(chunks).toString('utf8');

                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        fail(new Error('http error'), res.statusCode, text);
                        return;
                    }

                    if (opts.raw) {
                        settled = true;
                        resolve(text);
                        return;
                    }

                    try {
                        settled = true;
                        resolve(text ? JSON.parse(text) : {});
                    } catch (e) {
                        settled = false;
                        const err = new Error('invalid json');
                        err.code = 'INVALID_JSON';
                        fail(err);
                    }
                });
            });

            if (payload) req.write(payload);
            req.end();
        });
    }
}

module.exports = {
    ElasticsearchClient,
    ElasticsearchRequestError,
    resolveEndpoint,
    buildAuthHeader,
    describeError,
    DEFAULTS
};
