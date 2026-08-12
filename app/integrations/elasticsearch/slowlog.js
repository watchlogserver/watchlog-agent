// Elasticsearch search / indexing slow log collection.
//
// Slow logs are the only Elasticsearch signal that is not an API call: they are
// written to files on the node's own host, which is where watchlog-agent runs.
// Following those files uses app/logTail.js — the same incremental reader the
// log watchlist uses — rather than a second tailing engine.
//
// Hard rules:
//   * Watchlog never enables a slow log. index.search.slowlog.threshold.* and
//     index.indexing.slowlog.threshold.* have a real cost, and turning them on
//     is the operator's decision. This module only reads what is already there.
//   * Query text is scrubbed by sanitize.js before it is stored, every time.
//   * Document `_source` is not stored unless the operator explicitly opted in,
//     and even then it is truncated hard. A document body is customer data.
//
// Three log formats are supported because Elasticsearch changed them twice:
//   7.x plain text   [2026-08-12T10:00:00,123][WARN ][i.s.s.query] [node] [idx][0] took[…], …
//   7.x JSON         {"type":"index_search_slowlog","took_millis":"…","source":"…"}
//   8.x/9.x ECS JSON {"@timestamp":"…","elasticsearch.slowlog.took_millis":…}

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { createTailReader } = require('../../logTail');
const sanitize = require('./sanitize');

const DEFAULTS = {
    maxEntriesPerCollection: 200,
    minDurationMs: 0,
    maxQueryLength: 2000,
    maxSourceLength: 512,
    storeSource: false,
    // Directories Elasticsearch packages write logs to, in the order a
    // distribution is most likely to use them.
    searchPaths: [
        '/var/log/elasticsearch',
        '/usr/share/elasticsearch/logs',
        '/opt/elasticsearch/logs',
        '/usr/local/var/log/elasticsearch'
    ]
};

// Matches both the 7.x and 8.x file names, for either format.
const SEARCH_SLOWLOG_FILE = /_index_search_slowlog\.(log|json)$/;
const INDEXING_SLOWLOG_FILE = /_index_indexing_slowlog\.(log|json)$/;

// One reader for the whole process: offsets must survive across collection
// cycles or every cycle would replay the file from its end and collect nothing.
const tailReader = createTailReader({
    maxReadBytes: 256 * 1024,
    maxLineLength: 32 * 1024,
    maxLinesPerRead: 2000
});

// ── discovery ─────────────────────────────────────────────────────────────────

/**
 * Finds slow log files without walking the filesystem.
 *
 * Only the directories Elasticsearch distributions actually use are listed, one
 * level deep. An agent must never be the reason a host spends a minute
 * stat()-ing every file it owns.
 */
function discoverSlowlogFiles(directories = DEFAULTS.searchPaths) {
    const found = { search: [], indexing: [] };

    for (const dir of directories) {
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch (err) {
            continue; // absent or unreadable — normal on most hosts
        }

        for (const entry of entries) {
            if (!entry.isFile()) continue;
            const full = path.join(dir, entry.name);
            if (SEARCH_SLOWLOG_FILE.test(entry.name)) found.search.push(full);
            else if (INDEXING_SLOWLOG_FILE.test(entry.name)) found.indexing.push(full);
        }
    }

    // Prefer the JSON variants: they carry the same data without the ambiguity
    // of parsing a bracketed text format.
    const preferJson = (paths) => {
        const json = paths.filter((p) => p.endsWith('.json'));
        return json.length ? json : paths;
    };

    return { search: preferJson(found.search), indexing: preferJson(found.indexing) };
}

// ── line parsing ──────────────────────────────────────────────────────────────

/** `took[1.2s]` / `took_millis[1200]` — the bracketed key/value form. */
function extractBracketed(text, key) {
    // Matches key[value] where value may itself contain balanced-looking text.
    const index = text.indexOf(`${key}[`);
    if (index === -1) return null;

    let depth = 0;
    const start = index + key.length + 1;
    for (let i = start - 1; i < text.length; i++) {
        const ch = text[i];
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) return text.slice(start, i);
        }
    }
    // Elasticsearch truncates long lines, so an unterminated bracket is normal.
    return text.slice(start);
}

/** `[my-index][0]` or `[my-index/uuid][0]` → { index, shard }. */
function extractIndexAndShard(text) {
    const match = text.match(/\[([^\][]+?)(?:\/[A-Za-z0-9_-]{20,})?\]\[(\d+)\]/);
    if (!match) return { index: '', shard: null };
    return { index: sanitize.sanitizeIdentifier(match[1]), shard: Number(match[2]) };
}

/** `100 hits` / `1000+ hits` / `eq: 100` → a number, or null when not reported. */
function extractTotalHits(value) {
    if (value === null || value === undefined) return null;
    const match = String(value).match(/(\d+)/);
    return match ? Number(match[1]) : null;
}

/**
 * ECS JSON (Elasticsearch 8.x and 9.x) or legacy JSON (7.x).
 * Returns null when the object is not a slow log entry at all.
 */
function parseJsonSlowlogEntry(obj, type) {
    if (!obj || typeof obj !== 'object') return null;

    const ecs = obj['elasticsearch.slowlog.took_millis'] !== undefined ||
        obj['event.dataset'] !== undefined ||
        obj['elasticsearch.slowlog.message'] !== undefined;

    if (ecs) {
        const dataset = String(obj['event.dataset'] || '');
        // Reject a line from a different logger that happens to be in the file.
        if (dataset && !dataset.includes('slowlog')) return null;

        const message = String(obj['elasticsearch.slowlog.message'] || '');
        const { index, shard } = extractIndexAndShard(message);

        return {
            type,
            timestamp: obj['@timestamp'] || null,
            node: sanitize.sanitizeIdentifier(obj['elasticsearch.node.name'] || obj['node.name'] || ''),
            nodeId: sanitize.sanitizeIdentifier(obj['elasticsearch.node.id'] || ''),
            cluster: sanitize.sanitizeIdentifier(obj['elasticsearch.cluster.name'] || ''),
            level: String(obj['log.level'] || '').toUpperCase(),
            // `log.logger` distinguishes the query phase from the fetch phase:
            // index.search.slowlog.query vs index.search.slowlog.fetch.
            logger: String(obj['log.logger'] || ''),
            index: index || sanitize.sanitizeIdentifier(obj['elasticsearch.slowlog.index'] || ''),
            shard: shard !== null ? shard : null,
            tookMillis: Number(obj['elasticsearch.slowlog.took_millis']),
            took: String(obj['elasticsearch.slowlog.took'] || ''),
            totalHits: extractTotalHits(obj['elasticsearch.slowlog.total_hits']),
            searchType: String(obj['elasticsearch.slowlog.search_type'] || ''),
            totalShards: Number(obj['elasticsearch.slowlog.total_shards']),
            source: obj['elasticsearch.slowlog.source'],
            documentId: obj['elasticsearch.slowlog.id'],
            routing: obj['elasticsearch.slowlog.routing']
        };
    }

    // Legacy 7.x JSON layout.
    const declaredType = String(obj.type || '');
    if (declaredType && !declaredType.includes('slowlog')) return null;

    const message = String(obj.message || '');
    const { index, shard } = extractIndexAndShard(message);

    return {
        type,
        timestamp: obj.timestamp || obj['@timestamp'] || null,
        node: sanitize.sanitizeIdentifier(obj['node.name'] || ''),
        nodeId: sanitize.sanitizeIdentifier(obj['node.id'] || ''),
        cluster: sanitize.sanitizeIdentifier(obj['cluster.name'] || ''),
        level: String(obj.level || '').toUpperCase(),
        logger: String(obj.component || ''),
        index,
        shard: shard !== null ? shard : null,
        tookMillis: Number(obj.took_millis),
        took: String(obj.took || ''),
        totalHits: extractTotalHits(obj.total_hits),
        searchType: String(obj.search_type || ''),
        totalShards: Number(obj.total_shards),
        source: obj.source,
        documentId: obj.id,
        routing: obj.routing
    };
}

/** 7.x/8.x plain-text layout. */
function parseTextSlowlogLine(line, type) {
    // [2026-08-12T10:00:00,123][WARN ][i.s.s.query    ] [node-1] [idx][0] took[…]
    const header = line.match(/^\[([^\]]+)\]\[\s*([A-Z]+)\s*\]\[([^\]]+)\]\s*\[([^\]]*)\]\s*(.*)$/);
    if (!header) return null;

    const rest = header[5] || '';
    const { index, shard } = extractIndexAndShard(rest);

    // `Number(null)` is 0, which is finite — so an absent took_millis would sail
    // past a plain isFinite check and be stored as a 0 ms operation. A line with
    // no timing is not a slow operation at all.
    const tookRaw = extractBracketed(rest, 'took_millis');
    if (tookRaw === null || tookRaw === '') return null;
    const tookMillis = Number(tookRaw);
    if (!Number.isFinite(tookMillis)) return null;

    const totalShardsRaw = extractBracketed(rest, 'total_shards');

    return {
        type,
        // Elasticsearch writes `2026-08-12T10:00:00,123` — a comma, not a dot.
        timestamp: header[1].replace(',', '.'),
        level: header[2],
        logger: header[3].trim(),
        node: sanitize.sanitizeIdentifier(header[4]),
        nodeId: '',
        cluster: '',
        index,
        shard: shard !== null ? shard : null,
        tookMillis,
        took: extractBracketed(rest, 'took') || '',
        totalHits: extractTotalHits(extractBracketed(rest, 'total_hits')),
        searchType: extractBracketed(rest, 'search_type') || '',
        // NaN rather than 0 when absent, so toSlowOperation stores null.
        totalShards: totalShardsRaw === null || totalShardsRaw === '' ? NaN : Number(totalShardsRaw),
        source: extractBracketed(rest, 'source'),
        documentId: extractBracketed(rest, 'id'),
        routing: extractBracketed(rest, 'routing')
    };
}

/** Dispatches on the line shape. Returns null for anything unrecognised. */
function parseSlowlogLine(line, type) {
    if (typeof line !== 'string') return null;
    const trimmed = line.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith('{')) {
        let obj;
        try {
            obj = JSON.parse(trimmed);
        } catch (err) {
            return null; // truncated JSON line — dropped, never guessed at
        }
        return parseJsonSlowlogEntry(obj, type);
    }

    return parseTextSlowlogLine(trimmed, type);
}

/**
 * Turns a parsed line into the stored event.
 *
 * This is the only place query text and document sources reach, and both leave
 * it scrubbed. `phase` distinguishes the query phase from the fetch phase,
 * which matters: a slow fetch and a slow query have different causes.
 */
function toSlowOperation(parsed, config) {
    if (!parsed) return null;

    const durationMs = Number(parsed.tookMillis);
    if (!Number.isFinite(durationMs) || durationMs < 0) return null;
    if (durationMs < config.minDurationMs) return null;

    const timestampMs = parsed.timestamp ? Date.parse(parsed.timestamp) : NaN;
    const timestamp = Number.isFinite(timestampMs) ? new Date(timestampMs) : new Date();

    const logger = String(parsed.logger || '').toLowerCase();
    const phase = parsed.type === 'search'
        ? (logger.includes('fetch') ? 'fetch' : 'query')
        : 'index';

    const query = parsed.type === 'search'
        ? sanitize.sanitizeQuerySource(
            typeof parsed.source === 'string' ? parsed.source : JSON.stringify(parsed.source || ''),
            config.maxQueryLength
        )
        : { preview: '', redacted: false, truncated: false, originalLength: 0 };

    const source = parsed.type === 'indexing'
        ? sanitize.sanitizeDocumentSource(
            typeof parsed.source === 'string' ? parsed.source : JSON.stringify(parsed.source || ''),
            { storeSource: config.storeSource, maxLength: config.maxSourceLength }
        )
        : { preview: '', available: false, stored: false, redacted: false, truncated: false, sizeBytes: 0 };

    return {
        type: parsed.type,
        timestamp: timestamp.toISOString(),
        timestampMs: timestamp.getTime(),
        node: parsed.node || '',
        nodeId: parsed.nodeId || '',
        cluster: parsed.cluster || '',
        index: parsed.index || '',
        shard: Number.isFinite(parsed.shard) ? parsed.shard : null,
        phase,
        level: parsed.level || '',
        durationMs,
        took: parsed.took || '',
        totalHits: parsed.totalHits,
        searchType: parsed.searchType || '',
        totalShards: Number.isFinite(parsed.totalShards) ? parsed.totalShards : null,

        queryPreview: query.preview,
        queryRedacted: query.redacted,
        queryTruncated: query.truncated,
        queryLength: query.originalLength,

        // For an indexing operation: whether a document body existed, how big it
        // was, and — only on explicit opt-in — a scrubbed preview of it.
        sourceAvailable: source.available,
        sourceStored: source.stored,
        sourcePreview: source.preview,
        sourceSizeBytes: source.sizeBytes,

        documentId: parsed.type === 'indexing' ? sanitize.sanitizeDocumentId(parsed.documentId) : '',
        routing: sanitize.sanitizeIdentifier(parsed.routing || '', 128),

        // Deterministic id so a replayed offline batch overwrites rather than
        // duplicating. Node + index + shard + timestamp + duration identifies one
        // logged operation; two operations that genuinely collide on all five are
        // indistinguishable in the log itself.
        eventId: crypto.createHash('sha1')
            .update(`${parsed.type}|${parsed.node}|${parsed.index}|${parsed.shard}|${timestamp.getTime()}|${durationMs}|${phase}`)
            .digest('hex')
    };
}

// ── collection ────────────────────────────────────────────────────────────────

function normalizeSlowlogConfig(raw = {}) {
    const explicitSearch = []
        .concat(raw.searchLogPath || [], raw.searchLogPaths || [])
        .filter(Boolean)
        .map(String);
    const explicitIndexing = []
        .concat(raw.indexingLogPath || [], raw.indexingLogPaths || [])
        .filter(Boolean)
        .map(String);

    return {
        enabled: raw.enabled === true,
        searchLogPaths: explicitSearch,
        indexingLogPaths: explicitIndexing,
        logDirectories: Array.isArray(raw.logDirectories) && raw.logDirectories.length
            ? raw.logDirectories.map(String)
            : DEFAULTS.searchPaths,
        maxEntriesPerCollection: Number(raw.maxEntriesPerCollection) > 0
            ? Number(raw.maxEntriesPerCollection) : DEFAULTS.maxEntriesPerCollection,
        minDurationMs: Number(raw.minDurationMs) >= 0
            ? Number(raw.minDurationMs) : DEFAULTS.minDurationMs,
        maxQueryLength: Number(raw.maxQueryLength) > 0
            ? Number(raw.maxQueryLength) : DEFAULTS.maxQueryLength,
        maxSourceLength: Number(raw.maxSourceLength) > 0
            ? Number(raw.maxSourceLength) : DEFAULTS.maxSourceLength,
        // Opt-in only, and false by default. A document `_source` can hold
        // anything the customer indexes.
        storeSource: raw.storeSource === true
    };
}

/**
 * Reads whatever the slow log files have appended since the last cycle.
 *
 * @returns {{ operations: array, files: object, truncated: boolean, errors: array }}
 */
function collectSlowOperations(config) {
    const result = {
        operations: [],
        files: { search: [], indexing: [] },
        truncated: false,
        errors: []
    };

    if (!config.enabled) return result;

    const discovered = discoverSlowlogFiles(config.logDirectories);
    const searchFiles = config.searchLogPaths.length ? config.searchLogPaths : discovered.search;
    const indexingFiles = config.indexingLogPaths.length ? config.indexingLogPaths : discovered.indexing;

    result.files.search = searchFiles.slice(0, 8);
    result.files.indexing = indexingFiles.slice(0, 8);

    const readFiles = (paths, type) => {
        for (const filePath of paths.slice(0, 8)) {
            const { lines, error, truncatedLines } = tailReader.drain(filePath, 4);

            if (error) {
                // A missing or unreadable slow log is a configuration fact, not a
                // failure: it usually means slow logging is simply not enabled.
                result.errors.push({ scope: `slowlog:${type}`, code: error, path: path.basename(filePath) });
                continue;
            }
            if (truncatedLines) result.truncated = true;

            for (const line of lines) {
                const operation = toSlowOperation(parseSlowlogLine(line, type), config);
                if (operation) result.operations.push(operation);
            }
        }
    };

    readFiles(searchFiles, 'search');
    readFiles(indexingFiles, 'indexing');

    // Slowest first, so a payload capped mid-way keeps the operations that
    // actually matter rather than an arbitrary chronological prefix.
    result.operations.sort((a, b) => b.durationMs - a.durationMs);

    if (result.operations.length > config.maxEntriesPerCollection) {
        result.truncated = true;
        result.operations = result.operations.slice(0, config.maxEntriesPerCollection);
    }

    return result;
}

/** Summary for the payload and the Slow Operations tab's header cards. */
function summariseSlowOperations(operations) {
    const list = Array.isArray(operations) ? operations : [];
    const searches = list.filter((o) => o.type === 'search');
    const indexing = list.filter((o) => o.type === 'indexing');

    const byIndex = new Map();
    for (const op of list) {
        if (!op.index) continue;
        byIndex.set(op.index, (byIndex.get(op.index) || 0) + 1);
    }
    const topIndex = [...byIndex.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    return {
        total: list.length,
        searchCount: searches.length,
        indexingCount: indexing.length,
        slowestSearchMs: searches.length ? Math.max(...searches.map((o) => o.durationMs)) : null,
        slowestIndexingMs: indexing.length ? Math.max(...indexing.map((o) => o.durationMs)) : null,
        topIndex: topIndex ? topIndex[0] : null,
        topIndexCount: topIndex ? topIndex[1] : 0
    };
}

function resetTailState() {
    tailReader.reset();
}

module.exports = {
    collectSlowOperations,
    summariseSlowOperations,
    normalizeSlowlogConfig,
    discoverSlowlogFiles,
    parseSlowlogLine,
    parseJsonSlowlogEntry,
    parseTextSlowlogLine,
    toSlowOperation,
    extractBracketed,
    extractIndexAndShard,
    extractTotalHits,
    resetTailState,
    DEFAULTS
};
