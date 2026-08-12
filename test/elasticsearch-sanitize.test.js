// Sanitizer tests.
//
// This is the only part of the Elasticsearch integration that customer data
// passes through, so these tests are about what must NOT come out the other
// side. A failure here is a data leak, not a cosmetic bug.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const s = require('../app/integrations/elasticsearch/sanitize');

// ── credential keys ───────────────────────────────────────────────────────────

test('a value under a credential-shaped key is replaced, never truncated', () => {
    const input = '{"user":"alice","password":"hunter2","api_key":"AKIAIOSFODNN7EXAMPLE"}';
    const out = s.sanitizeQuerySource(input);

    assert.ok(!out.preview.includes('hunter2'));
    assert.ok(!out.preview.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(out.preview.includes('alice'), 'innocent fields survive');
    assert.strictEqual(out.redacted, true);
});

test('credential key matching is case- and separator-insensitive', () => {
    for (const key of ['Password', 'API-KEY', 'apiKey', 'secret_token', 'Authorization',
        'client_secret', 'private_key', 'sessionId', 'cookie']) {
        const out = s.sanitizeQuerySource(`{"${key}":"topsecretvalue"}`);
        assert.ok(!out.preview.includes('topsecretvalue'), `${key} was not redacted`);
    }
});

test('a numeric or boolean credential value is redacted too', () => {
    const out = s.sanitizeQuerySource('{"password":12345,"authorized":true}');
    assert.ok(!out.preview.includes('12345'));
});

// ── credential-shaped values ──────────────────────────────────────────────────

test('a token is redacted even under an innocent key', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk';
    const out = s.sanitizeQuerySource(`{"query":{"match":{"note":"${jwt}"}}}`);

    assert.ok(!out.preview.includes(jwt), 'a JWT pasted into a match clause is still a JWT');
    assert.strictEqual(out.redacted, true);
});

test('authorization header values are redacted wherever they appear', () => {
    for (const value of [
        'Bearer abcdefghijklmnopqrstuvwxyz123456',
        'Basic YWxpY2U6aHVudGVyMnBhc3N3b3Jk',
        'ApiKey dGhpc2lzYW5hcGlrZXl2YWx1ZQ=='
    ]) {
        const out = s.sanitizeQuerySource(`{"header":"${value}"}`);
        assert.ok(!out.preview.includes(value.split(' ')[1]), `${value.split(' ')[0]} not redacted`);
    }
});

test('an AWS access key id is redacted', () => {
    const out = s.sanitizeQuerySource('{"note":"AKIAIOSFODNN7EXAMPLE was rotated"}');
    assert.ok(!out.preview.includes('AKIAIOSFODNN7EXAMPLE'));
});

test('a connection string keeps its scheme but loses its credentials', () => {
    const out = s.sanitizeQuerySource('{"dsn":"postgres://admin:s3cr3tpw@db.internal:5432/shop"}');
    assert.ok(!out.preview.includes('s3cr3tpw'));
    assert.ok(!out.preview.includes('admin:'));
    assert.ok(out.preview.includes('postgres://'), 'the scheme is useful and reveals nothing');
});

test('a PEM private key block is removed entirely', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const out = s.sanitizeQuerySource(`{"key":"${pem}"}`);
    assert.ok(!out.preview.includes('MIIEowIBAAKCAQEA'));
});

// ── bounds ────────────────────────────────────────────────────────────────────

test('a long query is truncated and reports its original length', () => {
    const long = `{"query":{"terms":{"id":[${Array.from({ length: 5000 }, (_, i) => i).join(',')}]}}}`;
    const out = s.sanitizeQuerySource(long, 200);

    assert.ok(out.preview.length <= 201, 'bounded to the configured limit plus the ellipsis');
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.originalLength, long.length);
});

test('whitespace is collapsed so the length budget buys content', () => {
    const out = s.sanitizeQuerySource('{\n  "query" :   {\n    "match_all" : {}\n  }\n}');
    assert.ok(!out.preview.includes('\n'));
    assert.ok(out.preview.includes('"query"'));
});

test('empty and non-string input returns a safe empty result', () => {
    for (const input of ['', '   ', null, undefined, 42, {}]) {
        const out = s.sanitizeQuerySource(input);
        assert.strictEqual(out.preview, '');
        assert.strictEqual(out.redacted, false);
    }
});

test('a truncated, unparseable JSON fragment is still scrubbed', () => {
    // Elasticsearch truncates slowlog source itself, so the scrubber must not
    // depend on the text being valid JSON.
    const out = s.sanitizeQuerySource('{"query":{"match":{"x":"y"}},"password":"hunter2её');
    assert.ok(!out.preview.includes('hunter2'));
});

// ── document source ───────────────────────────────────────────────────────────

test('a document source is NOT stored by default', () => {
    const body = '{"customer":"acme","ssn":"123-45-6789","total":42}';
    const out = s.sanitizeDocumentSource(body);

    assert.strictEqual(out.stored, false);
    assert.strictEqual(out.preview, '', 'a document body is customer data by default');
    assert.strictEqual(out.available, true, 'the fact that a body existed is still useful');
    assert.strictEqual(out.sizeBytes, Buffer.byteLength(body, 'utf8'),
        'an oversized document explains a slow index operation');
});

test('an opted-in document source is scrubbed and truncated hard', () => {
    const body = `{"customer":"acme","password":"hunter2","notes":"${'x'.repeat(2000)}"}`;
    const out = s.sanitizeDocumentSource(body, { storeSource: true, maxLength: 100 });

    assert.strictEqual(out.stored, true);
    assert.ok(!out.preview.includes('hunter2'));
    assert.ok(out.preview.length <= 101);
    assert.strictEqual(out.truncated, true);
});

test('an absent document source reports nothing available', () => {
    const out = s.sanitizeDocumentSource('', { storeSource: true });
    assert.strictEqual(out.available, false);
    assert.strictEqual(out.sizeBytes, 0);
});

// ── identifiers ───────────────────────────────────────────────────────────────

test('an opaque document id is kept, a meaningful one is hashed', () => {
    // Elasticsearch auto-ids and UUIDs reveal nothing.
    assert.strictEqual(s.sanitizeDocumentId('AbCdEfGhIjKlMnOpQrSt'), 'AbCdEfGhIjKlMnOpQrSt');
    assert.strictEqual(
        s.sanitizeDocumentId('3f2504e0-4f89-11d3-9a0c-0305e82c3301'),
        '3f2504e0-4f89-11d3-9a0c-0305e82c3301'
    );
    assert.strictEqual(s.sanitizeDocumentId('12345'), '12345');

    // An email used as an _id is common and is personal data.
    const hashed = s.sanitizeDocumentId('user@example.com');
    assert.ok(hashed.startsWith('sha1:'));
    assert.ok(!hashed.includes('example.com'));

    // Stable, so repeated slow operations on the same document still group.
    assert.strictEqual(hashed, s.sanitizeDocumentId('user@example.com'));
});

test('sanitizeIdentifier strips newlines and bounds length', () => {
    assert.strictEqual(s.sanitizeIdentifier('  orders-2026\n.08.12  '), 'orders-2026 .08.12');
    assert.strictEqual(s.sanitizeIdentifier('x'.repeat(500)).length, 255);
    assert.strictEqual(s.sanitizeIdentifier(null), '');
});

// ── regex state ───────────────────────────────────────────────────────────────

test('repeated calls do not leak regex lastIndex between them', () => {
    // The value rules are global regexes reused across calls; a stale lastIndex
    // would make every second call miss.
    const input = '{"note":"Bearer abcdefghijklmnopqrstuvwxyz123456"}';
    for (let i = 0; i < 5; i++) {
        const out = s.sanitizeQuerySource(input);
        assert.strictEqual(out.redacted, true, `call ${i + 1} failed to redact`);
    }
});
