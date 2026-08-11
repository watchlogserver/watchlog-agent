// normalize.js — makes MySQL query text safe to leave the customer's server.
//
// MySQL already does most of this work: DIGEST_TEXT from performance_schema has
// every literal replaced with `?` before we ever see it, which is exactly why
// the collector reads digests rather than raw statements. This module is
// defence in depth on top of that, for three reasons:
//
//   1. Not every source is a digest. Lock and deadlock reporting can surface
//      statement text from other performance_schema tables, and some MySQL
//      builds leave literals in place where the digest normaliser did not run.
//   2. Object identifiers are not normalised by MySQL, and a schema/table name
//      is occasionally itself sensitive (a per-tenant database name).
//   3. `IN (?, ?, ?, …)` lists and very long statements bloat storage without
//      adding information.
//
// The rule is: identifiers and structure survive, values do not.

'use strict';

const PLACEHOLDER = '?';
const MAX_LENGTH = 4000;

// Literal forms MySQL's digest normaliser would already have collapsed. Applied
// in order; each is anchored to avoid eating surrounding structure.
const LITERAL_PATTERNS = [
    // Single-quoted strings, including doubled-quote and backslash escapes.
    { re: /'(?:[^'\\]|\\.|'')*'/g, to: PLACEHOLDER },
    // Double-quoted strings. Ambiguous with quoted identifiers under
    // ANSI_QUOTES, but a value leaking is worse than an identifier being masked.
    { re: /"(?:[^"\\]|\\.|"")*"/g, to: PLACEHOLDER },
    // Hex and bit literals — often binary payloads or UUIDs.
    { re: /\b0x[0-9a-fA-F]+\b/g, to: PLACEHOLDER },
    { re: /\bb'[01]+'/g, to: PLACEHOLDER },
    // Numbers, including decimals, exponents and negatives.
    { re: /\b\d+\.\d+([eE][+-]?\d+)?\b/g, to: PLACEHOLDER },
    { re: /\b\d+\b/g, to: PLACEHOLDER }
];

/**
 * Collapses a long `IN (?, ?, ?, ...)` list to `IN (...)`.
 *
 * A 2000-element IN list and a 2-element one are the same query shape; keeping
 * the full list costs storage and tells the operator nothing.
 */
function collapseInLists(sql) {
    return sql.replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/gi, 'IN (...)');
}

/**
 * Collapses repeated VALUES tuples from a multi-row INSERT.
 */
function collapseValueTuples(sql) {
    return sql.replace(
        /\bVALUES\s*(\(\s*\?(?:\s*,\s*\?)*\s*\))(\s*,\s*\(\s*\?(?:\s*,\s*\?)*\s*\))+/gi,
        'VALUES $1, ...'
    );
}

/**
 * Normalises arbitrary SQL text into a value-free shape.
 *
 * Use this for any statement text that is NOT already a MySQL digest. For
 * digests, prefer normalizeDigestText, which trusts MySQL's own normalisation
 * and only tidies up.
 */
function normalizeSql(sql) {
    if (sql === null || sql === undefined) return '';

    let out = String(sql);

    // Comments can carry anything, including credentials pasted by a developer.
    out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
    out = out.replace(/--[^\n\r]*/g, ' ');
    out = out.replace(/#[^\n\r]*/g, ' ');

    for (const { re, to } of LITERAL_PATTERNS) {
        out = out.replace(re, to);
    }

    out = collapseInLists(out);
    out = collapseValueTuples(out);

    // Whitespace and newlines carry no meaning here and make storage noisy.
    out = out.replace(/\s+/g, ' ').trim();

    if (out.length > MAX_LENGTH) out = `${out.slice(0, MAX_LENGTH)}…`;
    return out;
}

/**
 * Tidies a DIGEST_TEXT that MySQL has already normalised.
 *
 * MySQL emits `?` for every literal, so no value scrubbing is needed — but it
 * does leave `IN (?, ?, ?)` lists expanded and can emit very long text, and
 * some builds append a trailing ellipsis when the digest is truncated.
 *
 * A digest whose text is missing entirely (the digest table can hold a NULL
 * DIGEST_TEXT once it overflows into the catch-all row) becomes a marker rather
 * than an empty string, so the UI can label it honestly.
 */
function normalizeDigestText(digestText) {
    if (digestText === null || digestText === undefined || String(digestText).trim() === '') {
        // performance_schema aggregates everything past
        // performance_schema_digests_size into one row with a NULL digest.
        return '<digest table overflow>';
    }

    let out = String(digestText);
    out = collapseInLists(out);
    out = collapseValueTuples(out);
    out = out.replace(/\s+/g, ' ').trim();

    if (out.length > MAX_LENGTH) out = `${out.slice(0, MAX_LENGTH)}…`;
    return out;
}

/**
 * Extracts the statement kind for grouping and filtering, without keeping the
 * statement itself. Returns an upper-case verb such as SELECT or INSERT.
 */
function statementType(sql) {
    if (!sql) return 'UNKNOWN';
    const text = String(sql).trim();
    const match = text.match(/^([A-Za-z_]+)/);
    if (!match) return 'UNKNOWN';

    const verb = match[1].toUpperCase();
    if (verb !== 'WITH') return verb;

    // A leading WITH is a CTE, and the operative verb is the one after the CTE
    // definitions close. Taking the first verb anywhere would return the SELECT
    // *inside* the CTE, mislabelling `WITH x AS (SELECT …) DELETE …` as a read.
    let depth = 0;
    const tokens = text.match(/[()]|\b[A-Za-z_]+\b/g) || [];

    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '(') { depth++; continue; }
        if (token === ')') { depth = Math.max(0, depth - 1); continue; }
        if (depth !== 0) continue;
        const upper = token.toUpperCase();
        if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'].includes(upper)) return upper;
    }

    // A CTE that only ever feeds a SELECT is the common case.
    return 'SELECT';
}

/**
 * Schema names can themselves be sensitive in multi-tenant deployments
 * (`tenant_<customer>`), but they are also the primary grouping key the whole
 * feature is built around. They are kept, only bounded in length.
 */
function safeIdentifier(value, max = 128) {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, max);
}

module.exports = {
    normalizeSql,
    normalizeDigestText,
    statementType,
    safeIdentifier,
    collapseInLists,
    collapseValueTuples,
    PLACEHOLDER,
    MAX_LENGTH
};
