// Behavioural tests for the MySQL collector's derivation logic:
// counter deltas across restarts, buffer pool / temp / cache ratios, query
// impact ranking, and the legacy payload contract.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const collector = require('../app/integrations/mysql/index');
const parsers = require('../app/integrations/mysql/parsers');
const fx = require('./fixtures/mysql-rows');

// ── counter deltas and restarts ───────────────────────────────────────────────

test('counterDelta returns the difference between consecutive samples', () => {
    assert.strictEqual(collector.counterDelta(150, 100, false), 50);
});

test('counterDelta returns 0 on the first sample, not the lifetime total', () => {
    // Emitting the lifetime counter would spike every chart the moment
    // monitoring starts.
    assert.strictEqual(collector.counterDelta(500000, null, false), 0);
    assert.strictEqual(collector.counterDelta(500000, undefined, false), 0);
});

test('counterDelta treats a backwards counter as a reset, never negative', () => {
    assert.strictEqual(collector.counterDelta(5, 500000, false), 0);
});

test('counterDelta returns 0 when a restart is signalled', () => {
    // MySQL zeroes every GLOBAL STATUS counter on restart.
    assert.strictEqual(collector.counterDelta(150, 100, true), 0);
});

test('perSecond divides by the real elapsed interval and guards zero', () => {
    assert.strictEqual(collector.perSecond(600, 60), 10);
    assert.strictEqual(collector.perSecond(600, 0), 0);
    assert.strictEqual(collector.perSecond(600, null), 0);
});

// ── buffer pool hit rate ──────────────────────────────────────────────────────

test('deriveBufferPoolHitRate uses interval deltas, not lifetime totals', () => {
    // Lifetime is 1 - 25000/10000000 = 99.75%, but this interval was
    // 1 - 500/10000 = 95%.
    const innodb = { bufferPoolReadRequests: 10010000, bufferPoolReads: 25500 };
    const previous = { bufferPoolReadRequests: 10000000, bufferPoolReads: 25000 };

    const result = collector.deriveBufferPoolHitRate(innodb, previous, false);
    assert.strictEqual(result.readRequests, 10000);
    assert.strictEqual(result.diskReads, 500);
    assert.strictEqual(result.hitRate, 95);
});

test('deriveBufferPoolHitRate returns null rather than 0% with no reads', () => {
    // No buffer pool activity is "no data", not a cache collapse.
    const innodb = { bufferPoolReadRequests: 100, bufferPoolReads: 5 };
    const previous = { bufferPoolReadRequests: 100, bufferPoolReads: 5 };
    assert.strictEqual(collector.deriveBufferPoolHitRate(innodb, previous, false).hitRate, null);
});

test('deriveBufferPoolHitRate returns null on the first sample', () => {
    const innodb = { bufferPoolReadRequests: 10000000, bufferPoolReads: 25000 };
    assert.strictEqual(collector.deriveBufferPoolHitRate(innodb, null, false).hitRate, null);
});

test('deriveBufferPoolHitRate never exceeds 100% or drops below 0%', () => {
    // A counter that moves oddly across a reset must not produce a nonsense rate.
    const innodb = { bufferPoolReadRequests: 1000, bufferPoolReads: 5000 };
    const previous = { bufferPoolReadRequests: 0, bufferPoolReads: 0 };
    const result = collector.deriveBufferPoolHitRate(innodb, previous, false);
    assert.ok(result.hitRate >= 0 && result.hitRate <= 100);
});

// ── temp tables ───────────────────────────────────────────────────────────────

test('deriveTempTableRates computes the disk share over the interval', () => {
    const temp = { createdTmpTables: 8100, createdTmpDiskTables: 2020, createdTmpFiles: 15 };
    const previous = { createdTmpTables: 8000, createdTmpDiskTables: 2000, createdTmpFiles: 15 };

    const result = collector.deriveTempTableRates(temp, previous, false);
    assert.strictEqual(result.createdTmpTables, 100);
    assert.strictEqual(result.createdTmpDiskTables, 20);
    assert.strictEqual(result.diskTempTablePercentage, 20);
});

test('deriveTempTableRates returns null when no temp tables were created', () => {
    const temp = { createdTmpTables: 8000, createdTmpDiskTables: 2000, createdTmpFiles: 15 };
    const result = collector.deriveTempTableRates(temp, temp, false);
    assert.strictEqual(result.diskTempTablePercentage, null);
});

// ── cache efficiency ──────────────────────────────────────────────────────────

test('deriveTableCacheEfficiency computes the interval hit rate', () => {
    const cache = { tableOpenCacheHits: 90900, tableOpenCacheMisses: 10100, tableOpenCacheOverflows: 5 };
    const previous = { tableOpenCacheHits: 90000, tableOpenCacheMisses: 10000, tableOpenCacheOverflows: 5 };

    const result = collector.deriveTableCacheEfficiency(cache, previous, false);
    assert.strictEqual(result.hits, 900);
    assert.strictEqual(result.misses, 100);
    assert.strictEqual(result.hitRate, 90);
});

test('deriveThreadCacheEfficiency reports the share of reused threads', () => {
    // 100 new connections, 10 needed a fresh OS thread => 90% reuse.
    const connections = { threadsCreated: 50, connections: 1000 };
    const previous = { threadsCreated: 40, connections: 900 };

    const result = collector.deriveThreadCacheEfficiency(connections, previous, false);
    assert.strictEqual(result.threadsCreated, 10);
    assert.strictEqual(result.connections, 100);
    assert.strictEqual(result.efficiency, 90);
});

test('deriveThreadCacheEfficiency returns null with no new connections', () => {
    const connections = { threadsCreated: 50, connections: 1000 };
    assert.strictEqual(collector.deriveThreadCacheEfficiency(connections, connections, false).efficiency, null);
});

test('cache efficiencies never go negative after a restart', () => {
    const cache = { tableOpenCacheHits: 5, tableOpenCacheMisses: 1, tableOpenCacheOverflows: 0 };
    const previous = { tableOpenCacheHits: 90000, tableOpenCacheMisses: 10000, tableOpenCacheOverflows: 5 };
    const result = collector.deriveTableCacheEfficiency(cache, previous, true);
    assert.strictEqual(result.hits, 0);
    assert.strictEqual(result.hitRate, null);
});

// ── query derivation ──────────────────────────────────────────────────────────

function digestsFrom(rows) {
    return parsers.parseDigestRows(rows);
}

test('deriveQueries ranks by impact so a hot cheap query beats a rare slow one', () => {
    const current = digestsFrom(fx.DIGEST_ROWS);
    // Previous scrape: both queries had run half as much.
    const previous = {
        queries: digestsFrom(fx.DIGEST_ROWS).map(q => Object.assign({}, q, {
            executionCount: q.executionCount - (q.digest === 'a1b2c3' ? 900 : 10),
            totalDuration: q.totalDuration - (q.digest === 'a1b2c3' ? 1350 : 5000),
            rowsExamined: 0, rowsSent: 0, tmpDiskTables: 0, noIndexUsed: 0
        }))
    };

    const derived = collector.deriveQueries(current, previous, false, 10, 100);

    const fast = derived.find(q => q.digest === 'a1b2c3');
    const slow = derived.find(q => q.digest === 'd4e5f6');

    assert.strictEqual(fast.executionCountDelta, 900);
    assert.ok(Math.abs(fast.intervalAvgDuration - 1.5) < 0.001);
    assert.ok(Math.abs(fast.impact - 1350) < 1);

    assert.strictEqual(slow.executionCountDelta, 10);
    assert.strictEqual(slow.intervalAvgDuration, 500);
    assert.strictEqual(slow.impact, 5000);

    // The 500ms query consumed more database time this interval, so it leads.
    assert.strictEqual(derived[0].digest, 'd4e5f6');
});

test('deriveQueries marks slow by average OR max against the threshold', () => {
    const current = digestsFrom(fx.DIGEST_ROWS);
    const derived = collector.deriveQueries(current, null, false, 10, 100);

    // 500ms average — clearly slow.
    assert.strictEqual(derived.find(q => q.digest === 'd4e5f6').slow, true);
    // 1.5ms average, 45ms max — under a 100ms threshold.
    assert.strictEqual(derived.find(q => q.digest === 'a1b2c3').slow, false);

    // Lowering the threshold below the max flips it, without recollection.
    const stricter = collector.deriveQueries(current, null, false, 10, 40);
    assert.strictEqual(stricter.find(q => q.digest === 'a1b2c3').slow, true);
});

test('deriveQueries zeroes deltas on restart but keeps lifetime figures', () => {
    const current = digestsFrom(fx.DIGEST_ROWS);
    const previous = { queries: digestsFrom(fx.DIGEST_ROWS) };

    const derived = collector.deriveQueries(current, previous, true, 10, 100);
    const q = derived.find(x => x.digest === 'a1b2c3');

    assert.strictEqual(q.executionCountDelta, 0);
    assert.strictEqual(q.totalDurationDelta, 0);
    assert.strictEqual(q.impact, 0);
    assert.strictEqual(q.executionCount, 1000);
    // With no executions this interval it falls back to MySQL's lifetime average.
    assert.strictEqual(q.intervalAvgDuration, 1.5);
});

test('deriveQueries respects the cap', () => {
    const many = [];
    for (let i = 0; i < 50; i++) {
        many.push({
            digest: `d${i}`, digestText: `SELECT ${i}`, statementType: 'SELECT', database: 'shop',
            executionCount: i, totalDuration: i, avgDuration: 1, maxDuration: 1, minDuration: 1,
            rowsExamined: 0, rowsSent: 0, rowsExaminedPerRow: 0, tmpTables: 0, tmpDiskTables: 0,
            sortRows: 0, noIndexUsed: 0, noGoodIndexUsed: 0, errors: 0, warnings: 0,
            firstSeen: 0, lastSeen: 0
        });
    }
    assert.strictEqual(collector.deriveQueries(many, null, false, 10, 100).length, 10);
});

// ── legacy payload contract ───────────────────────────────────────────────────

test('toLegacyPayload reproduces the original collector shape exactly', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    const variables = parsers.parseKeyValueRows(fx.VARIABLE_ROWS);
    const databases = parsers.aggregateDatabases(parsers.parseTableRows(fx.TABLE_ROWS));
    for (const db of databases) db.indexCount = 6;

    const config = { host: 'localhost', port: 3306 };
    const legacy = collector.toLegacyPayload(config, variables, status, databases);

    assert.strictEqual(legacy.id, 'localhost:3306');
    assert.deepStrictEqual(Object.keys(legacy), ['id', 'host', 'port', 'globalMetrics', 'databases']);
    assert.deepStrictEqual(Object.keys(legacy.globalMetrics), [
        'version', 'uptime', 'threads_connected', 'max_connections',
        'insert_queries', 'update_queries', 'delete_queries', 'select_queries',
        'slow_queries', 'connections', 'aborted_clients', 'opened_tables'
    ]);
    assert.strictEqual(legacy.globalMetrics.version, '8.0.44');
    assert.strictEqual(legacy.globalMetrics.select_queries, 300000);
    assert.strictEqual(legacy.globalMetrics.slow_queries, 340);

    // Per-database entries keep the legacy three-key shape.
    assert.deepStrictEqual(Object.keys(legacy.databases[0]), ['db', 'table_count', 'index_count', 'db_size']);
    assert.strictEqual(legacy.databases[0].db, 'shop');
});

// ── config normalisation ──────────────────────────────────────────────────────

test('normalizeConfig applies safe defaults', () => {
    const config = collector.normalizeConfig({ service: 'mysql' });
    assert.strictEqual(config.host, 'localhost');
    assert.strictEqual(config.port, 3306);
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.slowQueryThresholdMs, 100);
    assert.strictEqual(config.schemaIntervalSeconds, 300);
});

test('normalizeConfig honours overrides including a zero threshold', () => {
    const config = collector.normalizeConfig({
        service: 'mysql', host: 'db.internal', port: '3307',
        advanced: { enabled: true, locks: false, maxDigests: 25 },
        slowQuery: { thresholdMs: 0 }
    });
    assert.strictEqual(config.host, 'db.internal');
    assert.strictEqual(config.port, 3307);
    assert.strictEqual(config.locks, false);
    assert.strictEqual(config.maxDigests, 25);
    // 0 is a legitimate threshold meaning "everything is slow"; it must not be
    // swallowed by a falsy-default.
    assert.strictEqual(config.slowQueryThresholdMs, 0);
});

test('normalizeConfig lets advanced.enabled=false disable the extension', () => {
    assert.strictEqual(collector.normalizeConfig({ service: 'mysql', advanced: { enabled: false } }).enabled, false);
});

test('system schemas are excluded from every schema-level query', () => {
    // These would otherwise dominate any "largest table" ranking.
    assert.deepStrictEqual(collector.SYSTEM_SCHEMAS,
        ['information_schema', 'performance_schema', 'mysql', 'sys']);
});
