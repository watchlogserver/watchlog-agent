// Query-text safety for the advanced PostgreSQL collector.
//
// The contract these tests defend: no parameter value, password, token or bind
// argument may survive into text the agent sends. pg_stat_statements normalises
// most statements itself, but utility statements and pg_stat_activity do not
// get that treatment, so those paths are scrubbed here.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const n = require('../app/integrations/postgresql/normalize');

// ── normalizeSql: the full scrub ──────────────────────────────────────────────

test('normalizeSql replaces single-quoted string literals', () => {
    const out = n.normalizeSql("SELECT * FROM users WHERE email = 'alice@example.com'");
    assert.strictEqual(out, 'SELECT * FROM users WHERE email = $?');
    assert.ok(!out.includes('alice'));
});

test('normalizeSql handles doubled-quote escapes inside strings', () => {
    const out = n.normalizeSql("SELECT * FROM t WHERE note = 'it''s fine'");
    assert.strictEqual(out, 'SELECT * FROM t WHERE note = $?');
    assert.ok(!out.includes('fine'));
});

test('normalizeSql replaces numeric literals including decimals and exponents', () => {
    const out = n.normalizeSql('SELECT * FROM t WHERE a = 42 AND b = 3.14 AND c = 1.2e10');
    assert.ok(!/\d/.test(out.replace(/\$\?/g, '')), out);
});

test('normalizeSql strips dollar-quoted bodies, which can hold anything', () => {
    const out = n.normalizeSql("DO $$ BEGIN PERFORM set_config('x', 'secret-token', false); END $$");
    assert.ok(!out.includes('secret-token'), out);
});

test('normalizeSql strips tagged dollar-quoted bodies', () => {
    const out = n.normalizeSql('CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1 $body$ LANGUAGE sql');
    assert.ok(!out.includes('SELECT 1'), out);
});

test('normalizeSql removes comments, which developers paste credentials into', () => {
    const out = n.normalizeSql('SELECT 1 /* pwd=hunter2 */ FROM t -- token=abc123');
    assert.ok(!out.includes('hunter2'), out);
    assert.ok(!out.includes('abc123'), out);
});

test('normalizeSql replaces E-string and hex/bit constants', () => {
    const out = n.normalizeSql("SELECT E'\\x41secret', X'deadbeef', B'1010' FROM t");
    assert.ok(!out.includes('secret'), out);
    assert.ok(!out.includes('deadbeef'), out);
});

test('normalizeSql keeps identifiers and structure intact', () => {
    const out = n.normalizeSql("SELECT id, total FROM public.orders WHERE customer_id = 7 ORDER BY created_at DESC");
    assert.ok(out.includes('public.orders'));
    assert.ok(out.includes('customer_id'));
    assert.ok(out.includes('ORDER BY created_at DESC'));
});

test('normalizeSql collapses whitespace and newlines', () => {
    assert.strictEqual(n.normalizeSql('SELECT\n  a,\n  b\nFROM   t'), 'SELECT a, b FROM t');
});

test('normalizeSql truncates beyond the configured bound', () => {
    const long = `SELECT ${'x'.repeat(6000)} FROM t`;
    const out = n.normalizeSql(long, 100);
    assert.strictEqual(out.length, 101); // 100 characters plus the ellipsis
    assert.ok(out.endsWith('…'));
});

test('normalizeSql is total on null and undefined', () => {
    assert.strictEqual(n.normalizeSql(null), '');
    assert.strictEqual(n.normalizeSql(undefined), '');
});

// ── IN list and VALUES collapsing ─────────────────────────────────────────────

test('collapseInLists groups an expanded IN list into one shape', () => {
    const many = `SELECT * FROM t WHERE id IN (${Array.from({ length: 500 }, (_, i) => `$${i + 1}`).join(', ')})`;
    const out = n.collapseInLists(many);
    assert.strictEqual(out, 'SELECT * FROM t WHERE id IN (...)');
});

test('collapseValueTuples keeps one tuple and elides the repeats', () => {
    const out = n.collapseValueTuples('INSERT INTO t (a, b) VALUES ($1, $2), ($3, $4), ($5, $6)');
    assert.strictEqual(out, 'INSERT INTO t (a, b) VALUES ($1, $2), ...');
});

test('collapseValueTuples leaves a single-row INSERT alone', () => {
    const sql = 'INSERT INTO t (a, b) VALUES ($1, $2)';
    assert.strictEqual(n.collapseValueTuples(sql), sql);
});

// ── normalizeStatement: the pg_stat_statements path ───────────────────────────

test('normalizeStatement trusts an already-normalised statement', () => {
    const sql = 'SELECT id, total FROM orders WHERE customer_id = $1 AND status = $2';
    assert.strictEqual(n.normalizeStatement(sql), sql);
});

test('normalizeStatement scrubs CREATE ROLE, which PostgreSQL stores verbatim', () => {
    const out = n.normalizeStatement("CREATE ROLE app LOGIN PASSWORD 'hunter2'");
    assert.ok(!out.includes('hunter2'), out);
    assert.ok(out.includes('CREATE ROLE'));
});

test('normalizeStatement scrubs ALTER USER … PASSWORD', () => {
    const out = n.normalizeStatement("ALTER USER admin WITH PASSWORD 'S3cret!'");
    assert.ok(!out.includes('S3cret'), out);
});

test('normalizeStatement scrubs CREATE SUBSCRIPTION, whose connection string holds a password', () => {
    const out = n.normalizeStatement(
        "CREATE SUBSCRIPTION s CONNECTION 'host=1.2.3.4 password=topsecret' PUBLICATION p"
    );
    assert.ok(!out.includes('topsecret'), out);
});

test('normalizeStatement scrubs COPY, whose inline data is raw customer rows', () => {
    const out = n.normalizeStatement(
        "COPY users FROM '/tmp/export/customers-2026.csv' WITH (FORMAT csv, DELIMITER ',')"
    );
    // The path and the delimiter are values; FORMAT/csv are keywords and stay.
    assert.ok(!out.includes('customers-2026'), out);
    assert.ok(!out.includes("','"), out);
    assert.ok(out.startsWith('COPY users FROM $?'), out);
});

test('normalizeStatement scrubs SET, which PostgreSQL also stores verbatim', () => {
    // Seen live: pg_stat_statements recorded `SET work_mem = '64kB'` with the
    // literal intact. The setting name is the useful part; the value is not.
    const out = n.normalizeStatement("SET work_mem = '64kB'");
    assert.ok(out.startsWith('SET work_mem = '), out);
    assert.ok(!out.includes('64kB'), out);
});

test('normalizeStatement scrubs a SET that carries an identity or a secret', () => {
    assert.ok(!n.normalizeStatement("SET session_authorization = 'admin'").includes('admin'));
    assert.ok(!n.normalizeStatement("SET search_path = 'tenant_4711'").includes('tenant_4711'));
    assert.ok(!n.normalizeStatement("RESET ALL").includes("'"));
});

test('normalizeStatement reports unreadable text rather than an empty string', () => {
    assert.strictEqual(n.normalizeStatement('<insufficient privilege>'), '<insufficient privilege>');
    assert.strictEqual(n.normalizeStatement(''), '<unavailable>');
    assert.strictEqual(n.normalizeStatement(null), '<unavailable>');
    assert.strictEqual(n.normalizeStatement('   '), '<unavailable>');
});

test('normalizeStatement collapses an expanded IN list from a pre-14 server', () => {
    const many = `SELECT * FROM t WHERE id IN (${Array.from({ length: 300 }, (_, i) => `$${i + 1}`).join(', ')})`;
    assert.strictEqual(n.normalizeStatement(many), 'SELECT * FROM t WHERE id IN (...)');
});

test('normalizeStatement strips comments even on the trusted path', () => {
    const out = n.normalizeStatement('SELECT $1 /* apiKey=live_abc */ FROM t');
    assert.ok(!out.includes('live_abc'), out);
});

// ── normalizeActivityQuery: always the full scrub ─────────────────────────────

test('normalizeActivityQuery never trusts pg_stat_activity text', () => {
    const out = n.normalizeActivityQuery("UPDATE users SET token = 'live_sk_9910' WHERE id = 4");
    assert.ok(!out.includes('live_sk_9910'), out);
    assert.ok(!out.includes('4') || out.includes('$?'), out);
    assert.ok(out.startsWith('UPDATE users SET token = $?'));
});

test('normalizeActivityQuery is bounded more tightly than a stored digest', () => {
    const long = `SELECT ${'y'.repeat(5000)} FROM t`;
    const out = n.normalizeActivityQuery(long);
    assert.ok(out.length <= n.MAX_ACTIVITY_LENGTH + 1);
    assert.ok(n.MAX_ACTIVITY_LENGTH < n.MAX_LENGTH);
});

test('normalizeActivityQuery returns an empty string for an idle backend', () => {
    assert.strictEqual(n.normalizeActivityQuery(null), '');
    assert.strictEqual(n.normalizeActivityQuery(''), '');
});

// ── statementType ─────────────────────────────────────────────────────────────

test('statementType reads the leading verb', () => {
    assert.strictEqual(n.statementType('SELECT 1'), 'SELECT');
    assert.strictEqual(n.statementType('  insert into t values ($1)'), 'INSERT');
    assert.strictEqual(n.statementType('UPDATE t SET a = $1'), 'UPDATE');
    assert.strictEqual(n.statementType('DELETE FROM t'), 'DELETE');
    assert.strictEqual(n.statementType('COMMIT'), 'COMMIT');
});

test('statementType resolves a CTE to the operative verb, not the inner SELECT', () => {
    assert.strictEqual(
        n.statementType('WITH stale AS (SELECT id FROM sessions WHERE ts < $1) DELETE FROM sessions USING stale'),
        'DELETE'
    );
    assert.strictEqual(
        n.statementType('WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x'),
        'INSERT'
    );
    assert.strictEqual(
        n.statementType('WITH x AS (SELECT 1) UPDATE t SET a = x.a FROM x'),
        'UPDATE'
    );
});

test('statementType handles nested CTE parentheses', () => {
    assert.strictEqual(
        n.statementType('WITH a AS (SELECT (SELECT 1) AS v FROM (SELECT 2) s) DELETE FROM t USING a'),
        'DELETE'
    );
});

test('statementType falls back to SELECT for a read-only CTE', () => {
    assert.strictEqual(n.statementType('WITH x AS (SELECT 1) SELECT * FROM x'), 'SELECT');
});

test('statementType is total on junk', () => {
    assert.strictEqual(n.statementType(''), 'UNKNOWN');
    assert.strictEqual(n.statementType(null), 'UNKNOWN');
    assert.strictEqual(n.statementType('/* only a comment */'), 'UNKNOWN');
});

// ── safeIdentifier ────────────────────────────────────────────────────────────

test('safeIdentifier bounds length and is total', () => {
    assert.strictEqual(n.safeIdentifier('public'), 'public');
    assert.strictEqual(n.safeIdentifier('x'.repeat(500)).length, 128);
    assert.strictEqual(n.safeIdentifier('x'.repeat(500), 32).length, 32);
    assert.strictEqual(n.safeIdentifier(null), '');
    assert.strictEqual(n.safeIdentifier(undefined), '');
});
