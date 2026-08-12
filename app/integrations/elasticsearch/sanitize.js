// Makes Elasticsearch slow-log text safe to leave the customer's host.
//
// Elasticsearch slow logs are the one place in this integration where customer
// data can appear: a search slowlog line carries the query source, and an
// indexing slowlog line can carry the whole document `_source`. Neither is
// metrics data, so both are treated as untrusted text and scrubbed here before
// anything else in the collector is allowed to see them.
//
// Three rules, in order of importance:
//   1. A value belonging to a key that names a credential is replaced, never
//      truncated. Truncation leaks a prefix, and a prefix of an API key is
//      still a fact about the key.
//   2. Values that *look* like credentials are replaced even when the key is
//      innocent — a bearer token pasted into a `match` clause is still a token.
//   3. Whatever survives is bounded. A 2 MB query is a payload-size problem
//      long before it is an observability feature.
//
// Everything here is pure and total: malformed input returns a safe string,
// never an exception.

'use strict';

const DEFAULT_MAX_QUERY_LENGTH = 2000;
const DEFAULT_MAX_SOURCE_LENGTH = 512;

const REDACTED = '"[REDACTED]"';

// Keys whose value is a secret whatever it looks like. Matched case-insensitively
// against the JSON key, so `apiKey`, `api_key` and `API-KEY` all hit.
const SECRET_KEY_PATTERN =
    /(pass(word|wd)?|secret|token|api[-_]?key|apikey|auth(orization)?|credential(s)?|private[-_]?key|access[-_]?key|secret[-_]?key|session[-_]?id|cookie|bearer|client[-_]?secret)/i;

// Values that are self-evidently credentials regardless of the key they sit
// under. Ordered most specific first so a JWT is not merely caught by the
// generic long-base64 rule and mislabelled.
const SECRET_VALUE_RULES = [
    // JSON Web Token: three dot-separated base64url segments.
    { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g },
    // HTTP authorization values pasted into a field.
    { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
    { name: 'basic', pattern: /\bBasic\s+[A-Za-z0-9+/=]{12,}/gi },
    { name: 'apikey_header', pattern: /\bApiKey\s+[A-Za-z0-9+/=]{12,}/gi },
    // Cloud provider access key ids.
    { name: 'aws_key', pattern: /\b(?:AKIA|ASIA|AIDA|AROA)[0-9A-Z]{16}\b/g },
    // PEM private key blocks.
    { name: 'pem', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
    // A connection string with inline credentials.
    { name: 'uri_credentials', pattern: /\b([a-z][a-z0-9+.-]*):\/\/[^\s:@/"']+:[^\s@/"']+@/gi }
];

const REDACTED_BARE = '[REDACTED]';

function isString(value) {
    return typeof value === 'string';
}

/**
 * Replaces credential-shaped substrings anywhere in a piece of text.
 *
 * Returns the scrubbed text plus how many replacements happened, so the caller
 * can record that redaction occurred without recording what was redacted.
 */
function redactSecretValues(text) {
    if (!isString(text) || !text) return { text: text || '', redactions: 0 };

    let out = text;
    let redactions = 0;

    for (const rule of SECRET_VALUE_RULES) {
        // Fresh lastIndex each pass: these are global regexes reused across calls.
        rule.pattern.lastIndex = 0;
        out = out.replace(rule.pattern, (match, scheme) => {
            redactions++;
            // A connection string keeps its scheme so the reader still knows
            // what the field was, without the user:password pair.
            return rule.name === 'uri_credentials' ? `${scheme}://${REDACTED_BARE}@` : REDACTED_BARE;
        });
    }

    return { text: out, redactions };
}

/**
 * Replaces the value of any JSON key that names a credential.
 *
 * Operates on the raw text rather than a parsed object on purpose: slowlog
 * lines are frequently truncated by Elasticsearch itself, so the query source
 * often is not parseable JSON, and a scrubber that only works on valid JSON
 * would silently pass the broken ones through untouched.
 */
function redactSecretKeys(text) {
    if (!isString(text) || !text) return { text: text || '', redactions: 0 };

    let redactions = 0;

    // "key" : "value"  |  "key" : 12345  |  "key" : true — the string form is
    // matched non-greedily and stops at the first unescaped closing quote.
    let out = text.replace(
        /"([^"\\]{1,64})"\s*:\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null)/g,
        (match, key) => {
            if (!SECRET_KEY_PATTERN.test(key)) return match;
            redactions++;
            return `"${key}":${REDACTED}`;
        }
    );

    // Elasticsearch truncates its own slowlog source, so the last value in a
    // line is frequently cut off mid-string. The rule above cannot match an
    // unterminated value — and a *prefix* of an API key is still a fact about
    // the key — so a credential key whose value runs to the end of the text has
    // everything after the colon removed.
    out = out.replace(
        /"([^"\\]{1,64})"\s*:\s*(?:"(?:[^"\\]|\\.)*|[^,{}[\]\s"]*)$/,
        (match, key) => {
            if (!SECRET_KEY_PATTERN.test(key)) return match;
            redactions++;
            return `"${key}":${REDACTED}`;
        }
    );

    return { text: out, redactions };
}

/**
 * Full scrub for a slow-log query source.
 *
 * @param {string} text        raw source text from the slow log line
 * @param {number} maxLength   hard ceiling on what is stored
 * @returns {{ preview: string, redacted: boolean, truncated: boolean, originalLength: number }}
 */
function sanitizeQuerySource(text, maxLength = DEFAULT_MAX_QUERY_LENGTH) {
    if (!isString(text) || !text.trim()) {
        return { preview: '', redacted: false, truncated: false, originalLength: 0 };
    }

    const originalLength = text.length;
    const limit = Number(maxLength) > 0 ? Number(maxLength) : DEFAULT_MAX_QUERY_LENGTH;

    // Collapse whitespace first so the length budget is spent on content rather
    // than the pretty-printing Elasticsearch applies to some slowlog formats.
    let working = text.replace(/\s+/g, ' ').trim();

    const byKey = redactSecretKeys(working);
    const byValue = redactSecretValues(byKey.text);
    working = byValue.text;

    const truncated = working.length > limit;
    if (truncated) working = `${working.slice(0, limit)}…`;

    return {
        preview: working,
        redacted: byKey.redactions + byValue.redactions > 0,
        truncated,
        originalLength
    };
}

/**
 * Document `_source` from an indexing slow log.
 *
 * Never returned unless the operator explicitly opted in. A document body is
 * customer data by definition — orders, messages, medical records — and no
 * amount of pattern matching makes storing it safe by default. When enabled it
 * is scrubbed with the same rules and truncated far harder than a query.
 */
function sanitizeDocumentSource(text, { storeSource = false, maxLength = DEFAULT_MAX_SOURCE_LENGTH } = {}) {
    if (!isString(text) || !text.trim()) {
        return { preview: '', available: false, stored: false, redacted: false, truncated: false, sizeBytes: 0 };
    }

    const sizeBytes = Buffer.byteLength(text, 'utf8');

    if (!storeSource) {
        // The fact that a source existed, and how large it was, is useful
        // signal — an oversized document explains a slow index operation.
        // The content itself stays on the customer's host.
        return { preview: '', available: true, stored: false, redacted: false, truncated: false, sizeBytes };
    }

    const scrubbed = sanitizeQuerySource(text, maxLength);
    return {
        preview: scrubbed.preview,
        available: true,
        stored: true,
        redacted: scrubbed.redacted,
        truncated: scrubbed.truncated,
        sizeBytes
    };
}

/**
 * Index names are safe to store, but they arrive from a log line and are used
 * as an InfluxDB tag and an Elasticsearch keyword, so they are bounded and
 * stripped of the characters that break line protocol.
 */
function sanitizeIdentifier(value, maxLength = 255) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/[\r\n\t]+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

/**
 * Document ids can themselves be sensitive (an email used as `_id` is common),
 * so they are hashed rather than stored when they do not look like an opaque
 * identifier. An id that is already opaque — a UUID or Elasticsearch's own
 * base64 auto id — is kept, because it is useful and reveals nothing.
 */
function sanitizeDocumentId(value) {
    if (value === null || value === undefined) return '';
    const id = String(value).trim();
    if (!id) return '';

    const opaque = /^[A-Za-z0-9_-]{20,32}$/.test(id) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
        /^\d{1,19}$/.test(id);

    if (opaque) return id.slice(0, 64);

    // Anything else is replaced by a stable short digest so repeated slow
    // operations on the same document still group together.
    const crypto = require('crypto');
    return `sha1:${crypto.createHash('sha1').update(id).digest('hex').slice(0, 16)}`;
}

module.exports = {
    sanitizeQuerySource,
    sanitizeDocumentSource,
    sanitizeIdentifier,
    sanitizeDocumentId,
    redactSecretKeys,
    redactSecretValues,
    DEFAULT_MAX_QUERY_LENGTH,
    DEFAULT_MAX_SOURCE_LENGTH
};
