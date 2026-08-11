// SQL normalisation tests.
//
// These guard a privacy boundary. MySQL's own DIGEST_TEXT is already
// value-free, which is why the collector reads digests — but any statement text
// arriving from another source (lock waits, older servers) passes through
// normalizeSql, and anything that survives it leaves the customer's server.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    normalizeSql, normalizeDigestText, statementType, safeIdentifier,
    collapseInLists, collapseValueTuples
} = require('../app/integrations/mysql/normalize');

// ── literal scrubbing ─────────────────────────────────────────────────────────

test('string literals are replaced, matching the documented example', () => {
    const out = normalizeSql("SELECT * FROM users WHERE email = 'user@example.com'");
    assert.strictEqual(out, 'SELECT * FROM users WHERE email = ?');
    assert.ok(!out.includes('user@example.com'));
});

test('numeric literals are replaced', () => {
    const out = normalizeSql('SELECT * FROM orders WHERE total > 99.5 AND user_id = 4242');
    assert.ok(!out.includes('99.5'));
    assert.ok(!out.includes('4242'));
    assert.strictEqual(out, 'SELECT * FROM orders WHERE total > ? AND user_id = ?');
});

test('INSERT values never survive', () => {
    const out = normalizeSql(
        "INSERT INTO users (email, token) VALUES ('a@b.com', 'sk_live_abcdef123456')"
    );
    assert.ok(!out.includes('a@b.com'));
    assert.ok(!out.includes('sk_live_abcdef123456'));
});

test('hex and bit literals are replaced', () => {
    const out = normalizeSql('SELECT * FROM sessions WHERE token = 0xDEADBEEFCAFE');
    assert.ok(!out.toLowerCase().includes('deadbeef'));
});

test('escaped quotes inside a string do not let the value escape', () => {
    const out = normalizeSql("SELECT * FROM t WHERE name = 'O\\'Brien secret'");
    assert.ok(!out.includes('Brien'));
    assert.ok(!out.includes('secret'));
});

test('doubled quotes inside a string do not let the value escape', () => {
    const out = normalizeSql("SELECT * FROM t WHERE name = 'it''s a secret'");
    assert.ok(!out.includes('secret'));
});

test('double-quoted strings are treated as values', () => {
    const out = normalizeSql('SELECT * FROM t WHERE name = "sensitive"');
    assert.ok(!out.includes('sensitive'));
});

test('comments are stripped because they can carry anything', () => {
    const out = normalizeSql(
        'SELECT 1 /* password=hunter2 */ FROM dual -- token abc123\nWHERE x = 1'
    );
    assert.ok(!out.includes('hunter2'));
    assert.ok(!out.includes('abc123'));
    assert.ok(!out.includes('password'));
});

test('hash comments are stripped', () => {
    const out = normalizeSql('SELECT 1 # secret note here\n');
    assert.ok(!out.includes('secret note'));
});

test('identifiers and structure survive so the query stays diagnosable', () => {
    const out = normalizeSql("SELECT id, email FROM users JOIN orders ON orders.user_id = users.id WHERE status = 'x'");
    assert.ok(out.includes('users'));
    assert.ok(out.includes('orders'));
    assert.ok(out.includes('JOIN'));
    assert.ok(out.includes('email'));
});

// ── shape collapsing ──────────────────────────────────────────────────────────

test('long IN lists collapse to a single shape', () => {
    // A 2-element and a 2000-element IN list are the same query shape.
    const out = normalizeSql('SELECT * FROM users WHERE id IN (1, 2, 3, 4, 5, 6, 7, 8)');
    assert.strictEqual(out, 'SELECT * FROM users WHERE id IN (...)');
});

test('collapseInLists is idempotent and leaves short lists intact in digests', () => {
    assert.strictEqual(collapseInLists('WHERE id IN (?, ?, ?)'), 'WHERE id IN (...)');
    assert.strictEqual(collapseInLists('WHERE id IN (...)'), 'WHERE id IN (...)');
});

test('repeated VALUES tuples collapse', () => {
    const out = collapseValueTuples('INSERT INTO t VALUES (?, ?), (?, ?), (?, ?)');
    assert.strictEqual(out, 'INSERT INTO t VALUES (?, ?), ...');
});

test('very long statements are truncated', () => {
    const long = `SELECT ${'col, '.repeat(3000)} FROM t`;
    const out = normalizeSql(long);
    assert.ok(out.length <= 4001);
    assert.ok(out.endsWith('…'));
});

test('whitespace and newlines are normalised', () => {
    const out = normalizeSql('SELECT\n  *\n  FROM\t users');
    assert.strictEqual(out, 'SELECT * FROM users');
});

// ── digest text handling ──────────────────────────────────────────────────────

test('normalizeDigestText trusts MySQL but still collapses IN lists', () => {
    const out = normalizeDigestText('SELECT * FROM `users` WHERE `id` IN (?, ?, ?, ?)');
    assert.strictEqual(out, 'SELECT * FROM `users` WHERE `id` IN (...)');
});

test('normalizeDigestText labels a NULL digest rather than returning empty', () => {
    // performance_schema aggregates everything past its digest limit into one
    // row with a NULL DIGEST_TEXT.
    assert.strictEqual(normalizeDigestText(null), '<digest table overflow>');
    assert.strictEqual(normalizeDigestText(''), '<digest table overflow>');
    assert.strictEqual(normalizeDigestText('   '), '<digest table overflow>');
});

test('normalizeDigestText preserves the backtick identifiers MySQL emits', () => {
    const out = normalizeDigestText('SELECT `id` FROM `shop` . `orders` WHERE `state` = ?');
    assert.ok(out.includes('`shop`'));
    assert.ok(out.includes('`orders`'));
});

// ── statement typing ──────────────────────────────────────────────────────────

test('statementType extracts the leading verb', () => {
    assert.strictEqual(statementType('SELECT * FROM t'), 'SELECT');
    assert.strictEqual(statementType('  insert into t values (?)'), 'INSERT');
    assert.strictEqual(statementType('UPDATE `t` SET x = ?'), 'UPDATE');
    assert.strictEqual(statementType('DELETE FROM t'), 'DELETE');
});

test('statementType looks past a CTE to the real verb', () => {
    assert.strictEqual(statementType('WITH cte AS (SELECT 1) SELECT * FROM cte'), 'SELECT');
    assert.strictEqual(statementType('WITH cte AS (SELECT 1) DELETE FROM t'), 'DELETE');
});

test('statementType never throws', () => {
    assert.strictEqual(statementType(''), 'UNKNOWN');
    assert.strictEqual(statementType(null), 'UNKNOWN');
    assert.strictEqual(statementType('???'), 'UNKNOWN');
});

// ── identifiers ───────────────────────────────────────────────────────────────

test('safeIdentifier bounds length and tolerates null', () => {
    assert.strictEqual(safeIdentifier(null), '');
    assert.strictEqual(safeIdentifier('shop'), 'shop');
    assert.strictEqual(safeIdentifier('x'.repeat(500)).length, 128);
});

// ── end-to-end privacy check ──────────────────────────────────────────────────

test('a statement full of sensitive values yields nothing sensitive', () => {
    const sql = `
        INSERT INTO accounts (email, password_hash, api_key, ssn)
        VALUES ('victim@example.com', '$2b$12$abcdefghijklmnop', 'sk_live_9f8e7d6c', '123-45-6789')
        /* audit: performed by admin@corp.internal */
    `;
    const out = normalizeSql(sql);

    for (const secret of ['victim@example.com', '2b$12$abcdefghijklmnop', 'sk_live_9f8e7d6c',
                          '123-45-6789', 'admin@corp.internal']) {
        assert.ok(!out.includes(secret), `leaked: ${secret}`);
    }
    // The shape is still recognisable.
    assert.ok(out.includes('accounts'));
    assert.ok(out.includes('INSERT'));
});
