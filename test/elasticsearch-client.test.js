// Elasticsearch client tests.
//
// Two things are being protected here, and both are security properties rather
// than behaviour:
//
//   1. No credential ever reaches an error message, a log line or a payload.
//      The client builds every message from the status code and Elasticsearch's
//      own error type, and discards the driver's message — which for a
//      connection error can contain the URL it was given, userinfo included.
//   2. The integration cannot express a mutation. Only GET and the one
//      diagnostic POST are accepted, so there is no code path through which it
//      could delete an index or reroute a shard even if asked to.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    ElasticsearchClient, describeError, resolveEndpoint, buildAuthHeader
} = require('../app/integrations/elasticsearch/client');

const SECRET = 'sup3r-s3cret-p4ssw0rd';

// ── endpoint resolution ───────────────────────────────────────────────────────

test('resolveEndpoint accepts the host/port/protocol triple', () => {
    const plain = resolveEndpoint({ host: 'es.internal', port: 9200 });
    assert.strictEqual(plain.protocol, 'http');
    assert.strictEqual(plain.host, 'es.internal');
    assert.strictEqual(plain.port, 9200);
    assert.strictEqual(plain.basePath, '');

    const secure = resolveEndpoint({ host: 'es.internal', port: 9243, protocol: 'https' });
    assert.strictEqual(secure.protocol, 'https');

    // `ssl: true` is the spelling some existing integration entries use.
    assert.strictEqual(resolveEndpoint({ host: 'x', ssl: true }).protocol, 'https');
});

test('resolveEndpoint accepts a full URL with a path prefix', () => {
    const parsed = resolveEndpoint({ url: 'https://es.example.com:9243/elastic/' });
    assert.strictEqual(parsed.protocol, 'https');
    assert.strictEqual(parsed.host, 'es.example.com');
    assert.strictEqual(parsed.port, 9243);
    // Trailing slash removed so path joining is unambiguous.
    assert.strictEqual(parsed.basePath, '/elastic');
});

test('resolveEndpoint defaults the port from the scheme', () => {
    assert.strictEqual(resolveEndpoint({ url: 'https://es.example.com' }).port, 443);
    assert.strictEqual(resolveEndpoint({ url: 'http://es.example.com' }).port, 80);
});

test('resolveEndpoint strips credentials out of a URL', () => {
    // Embedded userinfo is moved into the credential fields so it can never be
    // logged as part of a URL.
    const parsed = resolveEndpoint({ url: `https://elastic:${SECRET}@es.example.com:9243` });
    assert.strictEqual(parsed.embeddedUsername, 'elastic');
    assert.strictEqual(parsed.embeddedPassword, SECRET);
    assert.ok(!JSON.stringify({ h: parsed.host, p: parsed.basePath }).includes(SECRET));
});

test('resolveEndpoint rejects an unparseable URL rather than guessing', () => {
    // An unterminated IPv6 literal: `new URL` genuinely cannot parse it, where a
    // merely odd-looking string is happily accepted once the scheme is prefixed.
    assert.throws(() => resolveEndpoint({ url: 'http://[not-an-ipv6' }), /not valid/);
});

test('resolveEndpoint tolerates a bare host:port, prefixing the scheme', () => {
    // What an operator pastes most often.
    const parsed = resolveEndpoint({ url: 'es.internal:9200' });
    assert.strictEqual(parsed.protocol, 'http');
    assert.strictEqual(parsed.host, 'es.internal');
    assert.strictEqual(parsed.port, 9200);
});

test('describeEndpoint never contains a credential', () => {
    const client = new ElasticsearchClient({
        url: `https://elastic:${SECRET}@es.example.com:9243/prefix`
    });
    const described = client.describeEndpoint();
    client.destroy();

    assert.strictEqual(described, 'https://es.example.com:9243/prefix');
    assert.ok(!described.includes(SECRET));
    assert.ok(!described.includes('elastic'));
});

// ── authentication ────────────────────────────────────────────────────────────

test('buildAuthHeader prefers an API key over basic auth', () => {
    // An API key is the narrower credential, so preferring it is the safer
    // default when both happen to be configured.
    const header = buildAuthHeader({ apiKey: 'AbCdEf123456', username: 'elastic', password: SECRET });
    assert.ok(header.startsWith('ApiKey '));
    assert.ok(!header.includes(SECRET));
});

test('buildAuthHeader encodes an id:key pair, and passes an encoded key through', () => {
    const pair = buildAuthHeader({ apiKey: 'keyId:keySecret' });
    assert.strictEqual(pair, `ApiKey ${Buffer.from('keyId:keySecret', 'utf8').toString('base64')}`);

    const already = buildAuthHeader({ apiKey: 'YWxyZWFkeS1lbmNvZGVk' });
    assert.strictEqual(already, 'ApiKey YWxyZWFkeS1lbmNvZGVk');
});

test('buildAuthHeader builds basic auth, and returns null with no credentials', () => {
    const basic = buildAuthHeader({ username: 'elastic', password: SECRET });
    assert.strictEqual(basic, `Basic ${Buffer.from(`elastic:${SECRET}`, 'utf8').toString('base64')}`);
    assert.strictEqual(buildAuthHeader({}), null);
});

// ── error classification ──────────────────────────────────────────────────────

test('HTTP statuses map to the classifications the setup UI branches on', () => {
    const cases = [
        [401, 'security_exception', 'authentication_failed'],
        [403, 'security_exception', 'permission_denied'],
        [404, 'index_not_found_exception', 'unsupported_endpoint'],
        [429, 'circuit_breaking_exception', 'throttled'],
        [503, 'unavailable_shards_exception', 'server_error'],
        [400, 'illegal_argument_exception', 'request_failed']
    ];

    for (const [status, type, expected] of cases) {
        const err = describeError(new Error('http'), status, JSON.stringify({ error: { type }, status }));
        assert.strictEqual(err.kind, expected, `status ${status}`);
        assert.ok(err.message.length > 0);
    }
});

test('transport codes map to distinct, actionable classifications', () => {
    const cases = [
        ['ECONNREFUSED', 'connection_refused'],
        ['ENOTFOUND', 'host_not_found'],
        ['EAI_AGAIN', 'host_not_found'],
        ['ECONNRESET', 'connection_reset'],
        ['EPIPE', 'connection_reset'],
        ['ETIMEDOUT', 'timeout'],
        ['TIMEOUT', 'timeout'],
        ['RESPONSE_TOO_LARGE', 'response_too_large'],
        ['INVALID_JSON', 'invalid_response']
    ];

    for (const [code, expected] of cases) {
        const err = new Error('x');
        err.code = code;
        assert.strictEqual(describeError(err).kind, expected, code);
    }
});

test('TLS failures are reported as TLS failures, including the plaintext mix-up', () => {
    for (const code of [
        'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
        // A TLS handshake against a plaintext port: the single most common
        // Elasticsearch misconfiguration, since 8.x defaults to https and a
        // self-managed cluster is frequently left on http.
        'EPROTO', 'ERR_SSL_WRONG_VERSION_NUMBER'
    ]) {
        const err = new Error('x');
        err.code = code;
        const described = describeError(err);
        assert.strictEqual(described.kind, 'tls_error', code);
        assert.match(described.message, /TLS error/);
    }
});

test('the driver message is discarded, so a URL credential cannot survive into it', () => {
    // Node puts the target it was given into a connection error message. If the
    // configuration carried userinfo, that message contains the password.
    const err = new Error(`connect ECONNREFUSED elastic:${SECRET}@10.0.0.1:9200`);
    err.code = 'ECONNREFUSED';

    const described = describeError(err);
    assert.ok(!described.message.includes(SECRET),
        'the driver message must be replaced, never wrapped');
    assert.ok(!JSON.stringify(described).includes(SECRET));
});

test('an Elasticsearch error body contributes only its type, never its content', () => {
    const body = JSON.stringify({
        error: {
            type: 'security_exception',
            reason: `unable to authenticate user [elastic] with password [${SECRET}]`
        },
        status: 401
    });

    const described = describeError(new Error('http'), 401, body);
    assert.ok(!described.message.includes(SECRET),
        'only error.type is read; reason text is not echoed');
});

test('describeError is total on a bare error', () => {
    assert.doesNotThrow(() => describeError(new Error('anything')));
    assert.strictEqual(describeError(new Error('anything')).kind, 'request_failed');
    assert.doesNotThrow(() => describeError(null, 500, null));
});

// ── read-only guarantee ───────────────────────────────────────────────────────

test('the client refuses every mutating HTTP method', async () => {
    const client = new ElasticsearchClient({ host: '127.0.0.1', port: 1 });

    try {
        for (const method of ['DELETE', 'PUT', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE']) {
            await assert.rejects(
                () => client.request('/some-index', { method }),
                (err) => {
                    assert.strictEqual(err.kind, 'forbidden_method');
                    assert.match(err.message, /read-only/);
                    return true;
                },
                `${method} must be refused before a socket is opened`
            );
        }
    } finally {
        client.destroy();
    }
});

test('GET and POST are permitted, because allocation explain needs a POST', async () => {
    const client = new ElasticsearchClient({ host: '127.0.0.1', port: 1, retries: 0 });

    try {
        // Port 1 refuses, which proves the method passed the guard and a socket
        // was actually attempted.
        for (const method of ['GET', 'POST']) {
            await assert.rejects(
                () => client.request('/', { method }),
                (err) => {
                    assert.notStrictEqual(err.kind, 'forbidden_method');
                    return true;
                }
            );
        }
    } finally {
        client.destroy();
    }
});

test('certificate verification is on unless it is explicitly disabled', () => {
    const strict = new ElasticsearchClient({ host: 'x', protocol: 'https' });
    assert.strictEqual(strict.agent.options.rejectUnauthorized, true);
    strict.destroy();

    const relaxed = new ElasticsearchClient({ host: 'x', protocol: 'https', rejectUnauthorized: false });
    assert.strictEqual(relaxed.agent.options.rejectUnauthorized, false);
    relaxed.destroy();
});
