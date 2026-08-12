// Slow log parsing tests.
//
// Elasticsearch changed the slow log format twice — 7.x plain text, 7.x JSON,
// 8.x/9.x ECS JSON — and all three appear in the wild depending on which
// distribution and which log4j2.properties the operator has. These tests cover
// all three plus the shapes that must be ignored rather than guessed at.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const slowlog = require('../app/integrations/elasticsearch/slowlog');
const fx = require('./fixtures/elasticsearch-responses');

const LINES = fx.SLOWLOG_LINES;

const config = (overrides = {}) => slowlog.normalizeSlowlogConfig(
    Object.assign({ enabled: true }, overrides)
);

// ── bracket extraction ────────────────────────────────────────────────────────

test('extractBracketed handles nested brackets inside a value', () => {
    const line = 'took[1.2s], source[{"query":{"terms":{"id":[1,2,3]}}}], id[]';
    assert.strictEqual(slowlog.extractBracketed(line, 'took'), '1.2s');
    assert.strictEqual(
        slowlog.extractBracketed(line, 'source'),
        '{"query":{"terms":{"id":[1,2,3]}}}'
    );
    assert.strictEqual(slowlog.extractBracketed(line, 'id'), '');
    assert.strictEqual(slowlog.extractBracketed(line, 'absent'), null);
});

test('extractBracketed returns what it has when the line was truncated', () => {
    // Elasticsearch truncates long lines, so an unterminated bracket is normal.
    assert.strictEqual(
        slowlog.extractBracketed('source[{"query":{"match', 'source'),
        '{"query":{"match'
    );
});

test('extractIndexAndShard strips the index uuid the indexing log adds', () => {
    assert.deepStrictEqual(
        slowlog.extractIndexAndShard('[orders-2026.08.12][0] took[1s]'),
        { index: 'orders-2026.08.12', shard: 0 }
    );
    assert.deepStrictEqual(
        slowlog.extractIndexAndShard('[orders-2026.08.12/abcdefghijklmnopqrstuv][2]'),
        { index: 'orders-2026.08.12', shard: 2 }
    );
    assert.deepStrictEqual(
        slowlog.extractIndexAndShard('nothing here'),
        { index: '', shard: null }
    );
});

test('extractTotalHits reads every shape Elasticsearch has used', () => {
    assert.strictEqual(slowlog.extractTotalHits('482 hits'), 482);
    assert.strictEqual(slowlog.extractTotalHits('1000+ hits'), 1000);
    assert.strictEqual(slowlog.extractTotalHits(9000), 9000);
    assert.strictEqual(slowlog.extractTotalHits(null), null);
    assert.strictEqual(slowlog.extractTotalHits('unknown'), null);
});

// ── format dispatch ───────────────────────────────────────────────────────────

test('7.x plain-text search line parses completely', () => {
    const op = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.searchText7, 'search'), config());

    assert.strictEqual(op.type, 'search');
    assert.strictEqual(op.phase, 'query');
    assert.strictEqual(op.node, 'es-data-01');
    assert.strictEqual(op.index, 'orders-2026.08.12');
    assert.strictEqual(op.shard, 0);
    assert.strictEqual(op.durationMs, 1200);
    assert.strictEqual(op.totalHits, 482);
    assert.strictEqual(op.searchType, 'QUERY_THEN_FETCH');
    assert.strictEqual(op.totalShards, 3);
    assert.match(op.queryPreview, /"customer":"acme"/);
    // Elasticsearch writes the millisecond separator as a comma.
    assert.strictEqual(new Date(op.timestamp).getUTCFullYear(), 2026);
});

test('the fetch logger produces the fetch phase, not the query phase', () => {
    const op = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.fetchText8, 'search'), config());
    assert.strictEqual(op.phase, 'fetch', 'a slow fetch and a slow query have different causes');
    assert.strictEqual(op.durationMs, 800);
});

test('7.x JSON search line parses', () => {
    const op = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.searchJson7, 'search'), config());

    assert.strictEqual(op.durationMs, 2100);
    assert.strictEqual(op.node, 'es-data-01');
    assert.strictEqual(op.cluster, 'production');
    assert.strictEqual(op.index, 'orders-2026.08.12');
    assert.strictEqual(op.totalHits, 1000);
    assert.match(op.queryPreview, /"status":"open"/);
});

test('8.x ECS JSON search line parses and its query is scrubbed', () => {
    const op = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.searchEcs8, 'search'), config());

    assert.strictEqual(op.durationMs, 3400);
    assert.strictEqual(op.index, 'orders-2026.08.12');
    assert.strictEqual(op.shard, 2);
    assert.strictEqual(op.totalShards, 3);

    // The fixture hides an api_key in the source.
    assert.ok(!op.queryPreview.includes('AAAAB3NzaC1yc2EAAAADAQ'));
    assert.strictEqual(op.queryRedacted, true);
});

test('indexing lines withhold the document source by default', () => {
    const op = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.indexingText7, 'indexing'), config());

    assert.strictEqual(op.type, 'indexing');
    assert.strictEqual(op.phase, 'index');
    assert.strictEqual(op.durationMs, 600);
    assert.strictEqual(op.sourceAvailable, true);
    assert.strictEqual(op.sourceStored, false);
    assert.strictEqual(op.sourcePreview, '', 'a document body is customer data');
    assert.ok(op.sourceSizeBytes > 0, 'its size is still useful signal');
    // The document body contained a password; nothing of it may appear.
    assert.ok(!JSON.stringify(op).includes('hunter2'));
});

test('an opted-in indexing source is scrubbed before it is stored', () => {
    const op = slowlog.toSlowOperation(
        slowlog.parseSlowlogLine(LINES.indexingText7, 'indexing'),
        config({ storeSource: true, maxSourceLength: 200 })
    );

    assert.strictEqual(op.sourceStored, true);
    assert.ok(op.sourcePreview.includes('acme'));
    assert.ok(!op.sourcePreview.includes('hunter2'));
});

test('an indexing document id that is personal data is hashed', () => {
    const op = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.indexingEcs8, 'indexing'), config());
    assert.ok(op.documentId.startsWith('sha1:'));
    assert.ok(!op.documentId.includes('example.com'));
});

test('a non-opaque indexing document id is hashed, an opaque one is kept', () => {
    // `order-12345` carries meaning, so it is replaced by a stable digest.
    const meaningful = slowlog.toSlowOperation(
        slowlog.parseSlowlogLine(LINES.indexingText7, 'indexing'), config()
    );
    assert.ok(meaningful.documentId.startsWith('sha1:'));
    assert.ok(!meaningful.documentId.includes('order-12345'));

    // An Elasticsearch auto-id reveals nothing and is kept verbatim.
    const autoId = slowlog.toSlowOperation(slowlog.parseSlowlogLine(
        '[2026-08-12T10:00:02,000][WARN ][i.i.s.index][es-data-01] [orders][2] ' +
        'took[600ms], took_millis[600], id[AbCdEfGhIjKlMnOpQrSt], source[{}]',
        'indexing'
    ), config());
    assert.strictEqual(autoId.documentId, 'AbCdEfGhIjKlMnOpQrSt');
});

// ── lines that must be ignored ────────────────────────────────────────────────

test('unrecognised, truncated and foreign lines produce nothing', () => {
    assert.strictEqual(slowlog.parseSlowlogLine(LINES.garbage, 'search'), null);
    assert.strictEqual(slowlog.parseSlowlogLine(LINES.truncatedJson, 'search'), null);
    assert.strictEqual(slowlog.parseSlowlogLine('', 'search'), null);
    assert.strictEqual(slowlog.parseSlowlogLine(null, 'search'), null);

    // A server log line that happens to sit in the same file.
    assert.strictEqual(slowlog.parseSlowlogLine(LINES.otherLogger, 'search'), null);
});

test('a line with no duration is dropped rather than stored as zero', () => {
    const parsed = slowlog.parseSlowlogLine(
        '[2026-08-12T10:00:00,123][WARN ][i.s.s.query][node] [idx][0] no timing here', 'search'
    );
    assert.strictEqual(parsed, null);
});

test('toSlowOperation honours the minimum duration filter', () => {
    const parsed = slowlog.parseSlowlogLine(LINES.fetchText8, 'search');
    assert.ok(slowlog.toSlowOperation(parsed, config({ minDurationMs: 500 })));
    assert.strictEqual(slowlog.toSlowOperation(parsed, config({ minDurationMs: 1000 })), null);
});

// ── event identity ────────────────────────────────────────────────────────────

test('the event id is deterministic so a replayed batch overwrites', () => {
    const a = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.searchText7, 'search'), config());
    const b = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.searchText7, 'search'), config());
    assert.strictEqual(a.eventId, b.eventId);

    const other = slowlog.toSlowOperation(slowlog.parseSlowlogLine(LINES.searchJson7, 'search'), config());
    assert.notStrictEqual(a.eventId, other.eventId);
});

// ── config ────────────────────────────────────────────────────────────────────

test('slow log collection is off, and source storage is off, by default', () => {
    const defaults = slowlog.normalizeSlowlogConfig({});
    assert.strictEqual(defaults.enabled, false, 'Watchlog never turns slow logging on');
    assert.strictEqual(defaults.storeSource, false);
    assert.strictEqual(defaults.minDurationMs, 0);
    assert.ok(defaults.logDirectories.length > 0);
});

test('explicit log paths override discovery', () => {
    const explicit = slowlog.normalizeSlowlogConfig({
        enabled: true,
        searchLogPath: '/custom/search_slowlog.json',
        indexingLogPath: '/custom/indexing_slowlog.json'
    });
    assert.deepStrictEqual(explicit.searchLogPaths, ['/custom/search_slowlog.json']);
    assert.deepStrictEqual(explicit.indexingLogPaths, ['/custom/indexing_slowlog.json']);
});

test('collectSlowOperations returns nothing when disabled', () => {
    const result = slowlog.collectSlowOperations(slowlog.normalizeSlowlogConfig({ enabled: false }));
    assert.deepStrictEqual(result.operations, []);
});

// ── discovery and file reading ────────────────────────────────────────────────

test('discovery finds slow log files and prefers the JSON variants', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-es-slowlog-'));
    try {
        fs.writeFileSync(path.join(dir, 'production_index_search_slowlog.log'), '');
        fs.writeFileSync(path.join(dir, 'production_index_search_slowlog.json'), '');
        fs.writeFileSync(path.join(dir, 'production_index_indexing_slowlog.json'), '');
        fs.writeFileSync(path.join(dir, 'production_server.json'), '');

        const found = slowlog.discoverSlowlogFiles([dir]);

        assert.strictEqual(found.search.length, 1);
        assert.ok(found.search[0].endsWith('.json'),
            'the JSON variant carries the same data without format ambiguity');
        assert.strictEqual(found.indexing.length, 1);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('discovery ignores directories it cannot read', () => {
    const found = slowlog.discoverSlowlogFiles(['/definitely/not/a/real/path']);
    assert.deepStrictEqual(found.search, []);
    assert.deepStrictEqual(found.indexing, []);
});

test('collection reads only what was appended since the previous cycle', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-es-slowlog-read-'));
    const file = path.join(dir, 'production_index_search_slowlog.json');

    try {
        slowlog.resetTailState();
        fs.writeFileSync(file, `${LINES.searchJson7}\n`);

        const cfg = slowlog.normalizeSlowlogConfig({
            enabled: true, searchLogPath: file, indexingLogPath: ''
        });

        // First pass positions at the end: existing history is never replayed.
        const first = slowlog.collectSlowOperations(cfg);
        assert.strictEqual(first.operations.length, 0);

        fs.appendFileSync(file, `${LINES.searchEcs8}\n${LINES.garbage}\n`);

        const second = slowlog.collectSlowOperations(cfg);
        assert.strictEqual(second.operations.length, 1, 'the garbage line is dropped');
        assert.strictEqual(second.operations[0].durationMs, 3400);

        // Nothing new appended, so nothing is re-read.
        assert.strictEqual(slowlog.collectSlowOperations(cfg).operations.length, 0);
    } finally {
        slowlog.resetTailState();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('collection sorts slowest first so a capped payload keeps what matters', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-es-slowlog-cap-'));
    const file = path.join(dir, 'production_index_search_slowlog.json');

    try {
        slowlog.resetTailState();
        fs.writeFileSync(file, '');

        const cfg = slowlog.normalizeSlowlogConfig({
            enabled: true, searchLogPath: file, indexingLogPath: '', maxEntriesPerCollection: 2
        });
        slowlog.collectSlowOperations(cfg); // seed at end of file

        fs.appendFileSync(file, [
            LINES.searchJson7,   // 2100ms
            LINES.searchEcs8,    // 3400ms
            LINES.fetchText8     // 800ms
        ].join('\n') + '\n');

        const result = slowlog.collectSlowOperations(cfg);
        assert.strictEqual(result.operations.length, 2);
        assert.strictEqual(result.truncated, true);
        assert.strictEqual(result.operations[0].durationMs, 3400);
        assert.strictEqual(result.operations[1].durationMs, 2100);
    } finally {
        slowlog.resetTailState();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('summariseSlowOperations reports the shape the tab header needs', () => {
    const ops = [
        { type: 'search', durationMs: 3400, index: 'orders' },
        { type: 'search', durationMs: 2100, index: 'orders' },
        { type: 'indexing', durationMs: 900, index: 'logs' }
    ];
    const summary = slowlog.summariseSlowOperations(ops);

    assert.strictEqual(summary.total, 3);
    assert.strictEqual(summary.searchCount, 2);
    assert.strictEqual(summary.indexingCount, 1);
    assert.strictEqual(summary.slowestSearchMs, 3400);
    assert.strictEqual(summary.slowestIndexingMs, 900);
    assert.strictEqual(summary.topIndex, 'orders');
    assert.strictEqual(summary.topIndexCount, 2);
});

test('summariseSlowOperations reports null, not zero, with nothing of a type', () => {
    const summary = slowlog.summariseSlowOperations([{ type: 'search', durationMs: 100, index: 'a' }]);
    assert.strictEqual(summary.slowestIndexingMs, null,
        'no slow indexing operations is not "the slowest took 0ms"');
});
