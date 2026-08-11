// normalize.js — makes PostgreSQL query text safe to leave the customer's
// server.
//
// pg_stat_statements already does the important work: it stores a normalised
// statement where every literal has been replaced with `$1`, `$2`, … before we
// ever read it. That is precisely why the collector reads pg_stat_statements
// rather than pg_stat_activity for query performance.
//
// This module is defence in depth on top of that, because three things can put
// real values into text we handle:
//   1. `pg_stat_statements.track_utility` is on by default, and utility
//      statements (CREATE ROLE … PASSWORD, COPY … FROM) are NOT normalised.
//   2. pg_stat_activity, used for the Activity and Locks tabs, holds the raw
//      executing statement with its literals intact.
//   3. Older servers and some pooler setups produce text pg_stat_statements
//      never normalised.
//
// The rule is: identifiers and structure survive, values do not.

'use strict';

const PLACEHOLDER = '$?';
const MAX_LENGTH = 4000;
// pg_stat_activity text is only ever shown, never aggregated, so it is held to
// a tighter bound than a stored digest.
const MAX_ACTIVITY_LENGTH = 1000;

// Literal forms in rough order of specificity. Dollar-quoted bodies go first
// because they can legally contain any other form.
const LITERAL_PATTERNS = [
    // Dollar-quoted strings: $$ … $$ or $tag$ … $tag$ (function bodies, COPY data).
    { re: /\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1?\$/g, to: PLACEHOLDER },
    // Standard single-quoted strings, including '' escapes.
    { re: /'(?:[^']|'')*'/g, to: PLACEHOLDER },
    // E'' escape strings, which also allow backslash escapes.
    { re: /\bE'(?:[^'\\]|\\.|'')*'/gi, to: PLACEHOLDER },
    // Bit and hex string constants.
    { re: /\b[BX]'[0-9a-fA-F]*'/g, to: PLACEHOLDER },
    // Numbers, including decimals, exponents and negatives.
    { re: /\b\d+\.\d+([eE][+-]?\d+)?\b/g, to: PLACEHOLDER },
    { re: /\b\d+\b/g, to: PLACEHOLDER }
];

/**
 * Collapses a long `IN ($1, $2, $3, …)` list to `IN (...)`.
 *
 * pg_stat_statements does this itself from PostgreSQL 14 onward, but earlier
 * versions expand every parameter, so a 2000-element IN list becomes its own
 * distinct entry. Collapsing keeps those grouped and bounds the stored text.
 */
function collapseInLists(sql) {
    return sql.replace(/\bIN\s*\(\s*\$\??\d*(?:\s*,\s*\$\??\d*)*\s*\)/gi, 'IN (...)');
}

/** Collapses repeated VALUES tuples from a multi-row INSERT. */
function collapseValueTuples(sql) {
    return sql.replace(
        /\bVALUES\s*(\(\s*\$\??\d*(?:\s*,\s*\$\??\d*)*\s*\))(\s*,\s*\(\s*\$\??\d*(?:\s*,\s*\$\??\d*)*\s*\))+/gi,
        'VALUES $1, ...'
    );
}

/**
 * Full value scrubbing for statement text that pg_stat_statements did NOT
 * normalise: pg_stat_activity queries, utility statements, and older servers.
 */
function normalizeSql(sql, maxLength = MAX_LENGTH) {
    if (sql === null || sql === undefined) return '';

    let out = String(sql);

    // Comments can carry anything, including credentials pasted by a developer.
    out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
    out = out.replace(/--[^\n\r]*/g, ' ');

    for (const { re, to } of LITERAL_PATTERNS) {
        out = out.replace(re, to);
    }

    out = collapseInLists(out);
    out = collapseValueTuples(out);
    out = out.replace(/\s+/g, ' ').trim();

    if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
    return out;
}

// Utility statements pg_stat_statements records verbatim. Anything matching
// these is scrubbed rather than trusted, because the parameter is the secret.
//
// SET is included because pg_stat_statements stores `SET x = 'value'` exactly
// as written, and the value can be a role name, a search_path, or a connection
// secret. The setting name survives the scrub, which is all that is useful.
const UNSAFE_UTILITY = /^\s*(CREATE|ALTER)\s+(ROLE|USER|GROUP)\b|^\s*(CREATE|ALTER)\s+SUBSCRIPTION\b|\bPASSWORD\b|\bCONNECTION\s+LIMIT\b|^\s*COPY\b|^\s*(SET|RESET)\b/i;

/**
 * Prepares a pg_stat_statements query for storage.
 *
 * Normalised statements are trusted (their literals are already `$n`) and only
 * tidied. Utility statements are scrubbed in full, because PostgreSQL stores
 * those verbatim — `CREATE ROLE app PASSWORD 'hunter2'` reaches
 * pg_stat_statements exactly as written.
 */
function normalizeStatement(query, maxLength = MAX_LENGTH) {
    if (query === null || query === undefined || String(query).trim() === '') {
        // pg_stat_statements shows `<insufficient privilege>` for statements
        // belonging to other roles when the reader is not a superuser and lacks
        // pg_read_all_stats.
        return '<unavailable>';
    }

    const raw = String(query);
    if (UNSAFE_UTILITY.test(raw)) {
        return normalizeSql(raw, maxLength);
    }

    let out = raw;
    out = out.replace(/\/\*[\s\S]*?\*\//g, ' ');
    out = out.replace(/--[^\n\r]*/g, ' ');
    out = collapseInLists(out);
    out = collapseValueTuples(out);
    out = out.replace(/\s+/g, ' ').trim();

    if (out.length > maxLength) out = `${out.slice(0, maxLength)}…`;
    return out || '<unavailable>';
}

/**
 * pg_stat_activity holds the raw statement with real values, so it always gets
 * the full scrub — never the trusting path.
 */
function normalizeActivityQuery(query) {
    if (query === null || query === undefined || String(query).trim() === '') return '';
    return normalizeSql(query, MAX_ACTIVITY_LENGTH);
}

/** Statement kind for grouping, without keeping the statement. */
function statementType(sql) {
    if (!sql) return 'UNKNOWN';
    const text = String(sql).trim();
    const match = text.match(/^([A-Za-z_]+)/);
    if (!match) return 'UNKNOWN';

    const verb = match[1].toUpperCase();
    if (verb !== 'WITH') return verb;

    // A leading WITH is a CTE, and the operative verb is the one after the CTE
    // definitions close. Taking the first verb anywhere would return the SELECT
    // inside the CTE, mislabelling `WITH x AS (SELECT …) DELETE …` as a read.
    let depth = 0;
    const tokens = text.match(/[()]|\b[A-Za-z_]+\b/g) || [];
    for (let i = 1; i < tokens.length; i++) {
        const token = tokens[i];
        if (token === '(') { depth++; continue; }
        if (token === ')') { depth = Math.max(0, depth - 1); continue; }
        if (depth !== 0) continue;
        const upper = token.toUpperCase();
        if (['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(upper)) return upper;
    }
    return 'SELECT';
}

function safeIdentifier(value, max = 128) {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, max);
}

module.exports = {
    normalizeSql,
    normalizeStatement,
    normalizeActivityQuery,
    statementType,
    safeIdentifier,
    collapseInLists,
    collapseValueTuples,
    PLACEHOLDER,
    MAX_LENGTH,
    MAX_ACTIVITY_LENGTH,
    UNSAFE_UTILITY
};
