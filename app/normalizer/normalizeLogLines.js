/**
 * normalizeLogLines — groups multiline Node.js/PM2 stack traces into single
 * structured log events, and detects level/type for all log lines.
 *
 * Usage:
 *   const { events, pendingEvent } = normalizeLogLines({
 *     lines, filePath, logEntry, pendingEvent
 *   });
 *
 * Caller is responsible for persisting `pendingEvent` between reads and
 * flushing it on the next read.
 */

'use strict';

const path = require('path');
const os = require('os');

const PM2_LOGS_DIR = path.join(os.homedir(), '.pm2', 'logs');

// ─── Source detection ──────────────────────────────────────────────────────

/**
 * Infers source metadata from the file path.
 * Returns { source, pm2App, pm2Stream }.
 */
function detectSourceFromPath(filePath) {
    const norm = (filePath || '').replace(/\\/g, '/');
    const pm2Dir = PM2_LOGS_DIR.replace(/\\/g, '/');

    if (norm.startsWith(pm2Dir)) {
        const base = path.basename(filePath, '.log');
        const m = base.match(/^(.+)-(error|out)$/);
        if (m) return { source: 'pm2', pm2App: m[1], pm2Stream: m[2] };
        return { source: 'pm2', pm2App: base, pm2Stream: 'out' };
    }

    // Non-PM2 files that still follow the -error.log / -out.log convention
    if (filePath.endsWith('-error.log')) {
        return { source: 'file', pm2App: path.basename(filePath, '-error.log'), pm2Stream: 'error' };
    }
    if (filePath.endsWith('-out.log')) {
        return { source: 'file', pm2App: path.basename(filePath, '-out.log'), pm2Stream: 'out' };
    }

    return { source: 'file', pm2App: null, pm2Stream: null };
}

// ─── Level detection ───────────────────────────────────────────────────────

/**
 * Detects log level from line content, falling back to pm2Stream.
 * Returns a lowercase level string.
 */
function detectLogLevel(line, pm2Stream) {
    const l = line.toLowerCase();
    if (/\b(fatal|critical|crit|emerg|alert)\b/.test(l)) return 'fatal';
    if (/\b(error|err)\b/.test(l)) return 'error';
    if (/\b(warn|warning)\b/.test(l)) return 'warn';
    if (/\b(debug|dbg|trace|verbose)\b/.test(l)) return 'debug';
    if (/\b(info|notice)\b/.test(l)) return 'info';
    if (pm2Stream === 'error') return 'error';
    return 'info';
}

// ─── Error start detection ─────────────────────────────────────────────────

const ERROR_START_PATTERNS = [
    { re: /^uncaught\s+exception[:\s]/i,               type: 'uncaughtException'   },
    { re: /^unhandled\s+(promise\s+)?rejection[:\s]/i, type: 'unhandledRejection'  },
    { re: /^caught\s+error[:\s]/i,                     type: 'caughtError'         },
    { re: /^TypeError[:\s]/,                           type: 'typeError'           },
    { re: /^ReferenceError[:\s]/,                      type: 'referenceError'      },
    { re: /^SyntaxError[:\s]/,                         type: 'syntaxError'         },
    { re: /^RangeError[:\s]/,                          type: 'rangeError'          },
    { re: /^(Error|Exception)[:\s]/,                   type: 'error'               },
];

function isNewErrorLine(line) {
    return ERROR_START_PATTERNS.some(({ re }) => re.test(line.trim()));
}

function detectErrorType(line) {
    const trimmed = line.trim();
    for (const { re, type } of ERROR_START_PATTERNS) {
        if (re.test(trimmed)) return type;
    }
    return 'error';
}

// ─── Stack trace detection ─────────────────────────────────────────────────

const STACK_LINE_PATTERNS = [
    /^\s{2,}at\s+/,            // "    at FunctionName (...)"
    /^at\s+\S/,                // "at SomeFunction (...)"   (no indent)
    /node:internal\//,         // "node:internal/timers:614:17"
    /^\s*caused\s+by\s*/i,     // async chain: "caused by ..."
    /^\s*From\s+previous\s+event/i, // V8 async stack boundary
    /^\s+\^+\s*$/,             // "    ^" caret pointer line
];

function isStackTraceLine(line) {
    return STACK_LINE_PATTERNS.some(re => re.test(line));
}

// ─── Title extraction ──────────────────────────────────────────────────────

const TITLE_PREFIXES = [
    /^Uncaught Exception:\s*/i,
    /^Unhandled Promise Rejection:\s*/i,
    /^Unhandled Rejection:\s*/i,
    /^Caught Error:\s*/i,
    /^TypeError:\s*/i,
    /^ReferenceError:\s*/i,
    /^SyntaxError:\s*/i,
    /^RangeError:\s*/i,
    /^Error:\s*/i,
    /^Exception:\s*/i,
];

function extractErrorTitle(message) {
    let title = message.trim();
    for (const prefix of TITLE_PREFIXES) {
        const stripped = title.replace(prefix, '');
        if (stripped !== title) { title = stripped; break; }
    }
    return title.split('\n')[0].trim();
}

// ─── Location extraction ───────────────────────────────────────────────────

function extractFirstLocation(stackLines) {
    for (const line of stackLines) {
        const inParen = line.match(/\(([^)]+:\d+:\d+)\)/);
        if (inParen) return inParen[1];
        const bare = line.match(/at\s+([^\s(]+:\d+:\d+)/);
        if (bare) return bare[1];
    }
    return null;
}

// ─── Event builders ────────────────────────────────────────────────────────

function buildPlainEvent(rawLine, now, sourceInfo, baseService, baseName, filePath) {
    const trimmed = rawLine.trim();
    return {
        date: now,
        level: detectLogLevel(rawLine, sourceInfo.pm2Stream),
        message: trimmed,
        title: null,
        type: null,
        service: baseService,
        name: baseName,
        file: filePath,
        source: sourceInfo.source,
        pm2App: sourceInfo.pm2App,
        pm2Stream: sourceInfo.pm2Stream,
        stack: [],
        stackCount: 0,
        location: null,
        raw: rawLine,
    };
}

function buildErrorEvent(rawLine, now, sourceInfo, baseService, baseName, filePath) {
    const trimmed = rawLine.trim();
    return {
        date: now,
        level: 'error',
        message: trimmed,
        title: extractErrorTitle(trimmed),
        type: detectErrorType(trimmed),
        service: baseService,
        name: baseName,
        file: filePath,
        source: sourceInfo.source,
        pm2App: sourceInfo.pm2App,
        pm2Stream: sourceInfo.pm2Stream,
        stack: [],
        stackCount: 0,
        location: null,
        raw: rawLine,
        _pending: true,
    };
}

function finalizeEvent(event) {
    const { _pending, ...clean } = event;
    return clean;
}

// ─── Main export ───────────────────────────────────────────────────────────

/**
 * Normalizes a batch of complete log lines into structured events.
 *
 * @param {string[]} lines - Complete log lines (no trailing partial line).
 * @param {string}   filePath - Absolute path of the log file.
 * @param {object}   logEntry - Watchlist entry ({ service, name, ... }).
 * @param {object|null} pendingEvent - Unfinished event carried over from
 *                                    the previous read (may be null).
 *
 * @returns {{ events: object[], pendingEvent: object|null }}
 *   `events` are ready to emit.  `pendingEvent` must be stored by the caller
 *   and passed back on the next call for the same file.
 */
function normalizeLogLines({ lines, filePath, logEntry = {}, pendingEvent = null }) {
    const events = [];
    const now = new Date().toISOString();
    const sourceInfo = detectSourceFromPath(filePath);
    const baseService = logEntry.service || sourceInfo.source || 'unknown';
    const baseName = logEntry.name || '';

    let current = pendingEvent;

    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;

        if (isNewErrorLine(trimmed)) {
            // Flush any open event
            if (current) events.push(finalizeEvent(current));
            // Start a new error event
            current = buildErrorEvent(rawLine, now, sourceInfo, baseService, baseName, filePath);

        } else if (current && current._pending && isStackTraceLine(rawLine)) {
            // Continue the current error event
            current.stack.push(trimmed);
            current.stackCount++;
            current.raw += '\n' + rawLine;
            if (!current.location) {
                current.location = extractFirstLocation([trimmed]);
            }

        } else {
            // Not an error and not a stack continuation — flush open event
            if (current && current._pending) {
                events.push(finalizeEvent(current));
                current = null;
            }
            // Plain single-line event
            events.push(buildPlainEvent(rawLine, now, sourceInfo, baseService, baseName, filePath));
        }
    }

    // If the open event already has stack frames it arrived complete in this
    // batch — flush it now instead of waiting for the next read.
    if (current && current._pending && current.stackCount > 0) {
        events.push(finalizeEvent(current));
        current = null;
    }
    // (If current has 0 stack frames, keep it pending so the next read
    //  can attach the stack that may follow.)

    return { events, pendingEvent: current };
}

module.exports = {
    normalizeLogLines,
    detectSourceFromPath,
    detectLogLevel,
    isNewErrorLine,
    isStackTraceLine,
    detectErrorType,
    extractErrorTitle,
};
