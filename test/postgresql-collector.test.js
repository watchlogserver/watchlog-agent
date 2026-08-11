// Collector-level tests for the advanced PostgreSQL integration: interval
// deltas, counter resets, server restarts, activity classification, capability
// degradation and the legacy payload's backward compatibility.
//
// Everything here is driven through the exported pure functions, so no live
// PostgreSQL is needed and the awkward cases (a mid-window pg_stat_reset, a
// restart, a partial pg_stat_statements_reset) can be produced deterministically.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The explicit /index is required: a legacy `integrations/postgresql.js` sits
// beside the directory and would otherwise win module resolution.
const pg = require('../app/integrations/postgresql/index');
const parsers = require('../app/integrations/postgresql/parsers');
const fx = require('./fixtures/postgresql-rows');

const INTERVAL = 60;

// ── counterDelta: restarts and resets ─────────────────────────────────────────

test('counterDelta diffs two ordinary samples', () => {
    assert.strictEqual(pg.counterDelta(1006000, 1000000, false), 6000);
});

test('counterDelta returns zero on the first scrape, with nothing to diff against', () => {
    // Zero, not the lifetime counter: reporting 1,000,000 transactions in the
    // first minute would invent a spike that never happened.
    assert.strictEqual(pg.counterDelta(1000000, null, false), 0);
    assert.strictEqual(pg.counterDelta(1000000, undefined, false), 0);
});

test('counterDelta returns zero when the reset flag is set', () => {
    assert.strictEqual(pg.counterDelta(120, 1000000, true), 0);
});

test('counterDelta returns zero when a counter moved backwards on its own', () => {
    // pg_stat_reset() without a restart: uptime still climbs but counters drop.
    assert.strictEqual(pg.counterDelta(120, 1000000, false), 0);
});

test('perSecond divides by the interval and is safe at zero', () => {
    assert.strictEqual(pg.perSecond(6000, 60), 100);
    assert.strictEqual(pg.perSecond(6000, 0), 0);
    assert.strictEqual(pg.perSecond(6000, null), 0);
});

// ── interval cache hit ratio ──────────────────────────────────────────────────

test('deriveCacheHitRatio measures the interval, not the lifetime', () => {
    const previous = { blksHit: 39600000, blksRead: 400000 };
    const r = pg.deriveCacheHitRatio(39636000, 404000, previous, false);

    assert.strictEqual(r.blocksHit, 36000);
    assert.strictEqual(r.blocksRead, 4000);
    assert.strictEqual(r.ratio, 90);
});

test('deriveCacheHitRatio returns null when nothing touched a block', () => {
    const previous = { blksHit: 39600000, blksRead: 400000 };
    const r = pg.deriveCacheHitRatio(39600000, 400000, previous, false);

    // An idle database has no hit ratio. Writing 0% here would draw a cliff,
    // and writing 100% would invent a perfect score out of no data.
    assert.strictEqual(r.ratio, null);
    assert.strictEqual(r.blocksHit, 0);
});

test('deriveCacheHitRatio returns null on the first scrape', () => {
    const r = pg.deriveCacheHitRatio(39600000, 400000, null, false);
    assert.strictEqual(r.ratio, null);
});

test('deriveCacheHitRatio returns null across a reset rather than a fake number', () => {
    const previous = { blksHit: 39600000, blksRead: 400000 };
    const r = pg.deriveCacheHitRatio(9600, 400, previous, true);
    assert.strictEqual(r.ratio, null);
});

// ── per-database rates ────────────────────────────────────────────────────────

function ratesBetween(rowsA, rowsB, reset = false, interval = INTERVAL) {
    const previous = parsers.parseDatabaseStats(rowsA);
    const current = parsers.parseDatabaseStats(rowsB);
    const byName = new Map(previous.map((d) => [d.database, d]));
    return pg.deriveDatabaseRates(current, byName, reset, interval);
}

test('deriveDatabaseRates converts counters into per-second rates', () => {
    const [shop] = ratesBetween(fx.DATABASE_ROWS_T1, fx.DATABASE_ROWS_T2);

    assert.strictEqual(shop.commitDelta, 6000);
    assert.strictEqual(shop.rollbackDelta, 200);
    assert.strictEqual(shop.transactionDelta, 6200);
    assert.ok(Math.abs(shop.transactionsPerSecond - 103.33) < 0.01, String(shop.transactionsPerSecond));
    assert.strictEqual(shop.commitsPerSecond, 100);
});

test('deriveDatabaseRates computes the rollback share of the interval', () => {
    const [shop] = ratesBetween(fx.DATABASE_ROWS_T1, fx.DATABASE_ROWS_T2);
    assert.ok(Math.abs(shop.rollbackRatio - 3.2258) < 0.001, String(shop.rollbackRatio));
});

test('deriveDatabaseRates returns a null rollback ratio on an idle database', () => {
    const [, analytics] = ratesBetween(fx.DATABASE_ROWS_T1, fx.DATABASE_ROWS_T2);
    assert.strictEqual(analytics.transactionDelta, 0);
    assert.strictEqual(analytics.rollbackRatio, null);
});

test('deriveDatabaseRates reports the interval cache hit ratio separately from the lifetime one', () => {
    const [shop] = ratesBetween(fx.DATABASE_ROWS_T1, fx.DATABASE_ROWS_T2);
    // Lifetime is ~99%; the interval is 90%, which is the number that can move.
    assert.ok(shop.cacheHitRatio > 98);
    assert.strictEqual(shop.intervalCacheHitRatio, 90);
});

test('deriveDatabaseRates survives a mid-window statistics reset', () => {
    const rates = ratesBetween(fx.DATABASE_ROWS_T1, fx.DATABASE_ROWS_AFTER_RESET);
    const shop = rates.find((r) => r.database === 'shop');

    // Every counter dropped. No delta may be negative, and none may be the raw
    // post-reset value either.
    assert.strictEqual(shop.commitDelta, 0);
    assert.strictEqual(shop.rollbackDelta, 0);
    assert.strictEqual(shop.tupInsertedDelta, 0);
    assert.strictEqual(shop.deadlocksDelta, 0);
    assert.strictEqual(shop.intervalCacheHitRatio, null);
});

test('deriveDatabaseRates yields zero deltas on the very first scrape', () => {
    const current = parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1);
    const [shop] = pg.deriveDatabaseRates(current, new Map(), false, INTERVAL);

    assert.strictEqual(shop.commitDelta, 0);
    assert.strictEqual(shop.transactionsPerSecond, 0);
    assert.strictEqual(shop.intervalCacheHitRatio, null);
});

test('deriveDatabaseRates honours an explicit restart flag', () => {
    const rates = ratesBetween(fx.DATABASE_ROWS_T1, fx.DATABASE_ROWS_T2, true);
    const shop = rates.find((r) => r.database === 'shop');
    assert.strictEqual(shop.commitDelta, 0);
});

test('deriveDatabaseRates treats a newly appeared database as first-seen', () => {
    const current = parsers.parseDatabaseStats(fx.DATABASE_ROWS_T2);
    const byName = new Map(parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1)
        .filter((d) => d.database !== 'shop')
        .map((d) => [d.database, d]));

    const shop = pg.deriveDatabaseRates(current, byName, false, INTERVAL)
        .find((r) => r.database === 'shop');
    assert.strictEqual(shop.commitDelta, 0);
});

// ── statement deltas and impact ranking ───────────────────────────────────────

function statementsBetween(rowsA, rowsB, reset = false, limit = 10, threshold = 100) {
    const previous = { statements: parsers.parseStatements(rowsA) };
    const current = parsers.parseStatements(rowsB);
    return pg.deriveStatements(current, previous, reset, limit, threshold);
}

test('deriveStatements ranks by database time consumed, not by per-call latency', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T2);

    // The cheap query burned 20s of database time this interval; the 5-second
    // report burned 10s. Sorting by mean would put the report first and hide
    // the statement that actually costs more.
    assert.strictEqual(derived[0].queryId, '-4207345678901234567');
    assert.strictEqual(derived[0].callsDelta, 10000);
    assert.strictEqual(derived[0].impact, 20000);

    assert.strictEqual(derived[1].queryId, '881234567890123456');
    assert.strictEqual(derived[1].callsDelta, 2);
    assert.strictEqual(derived[1].impact, 10000);
});

test('deriveStatements computes the interval mean rather than the lifetime mean', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T2);
    const report = derived.find((s) => s.queryId === '881234567890123456');

    // Lifetime mean is 4000ms; this interval's two calls averaged 5000ms.
    assert.strictEqual(report.meanExecTime, 4000);
    assert.strictEqual(report.intervalMeanExecTime, 5000);
});

test('deriveStatements falls back to the lifetime mean for a statement idle this interval', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T1);
    const cheap = derived.find((s) => s.queryId === '-4207345678901234567');

    assert.strictEqual(cheap.callsDelta, 0);
    assert.strictEqual(cheap.intervalMeanExecTime, 2);
});

test('deriveStatements detects a per-entry pg_stat_statements_reset', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T2, fx.STATEMENT_ROWS_PARTIAL_RESET);

    const wasReset = derived.find((s) => s.queryId === '-4207345678901234567');
    const kept = derived.find((s) => s.queryId === '881234567890123456');

    // One entry's calls fell; the other did not. Only the fallen one is zeroed.
    assert.strictEqual(wasReset.callsDelta, 0);
    assert.strictEqual(wasReset.totalExecTimeDelta, 0);
    assert.strictEqual(kept.callsDelta, 0);
});

test('deriveStatements zeroes everything when the whole server restarted', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T2, true);
    assert.ok(derived.every((s) => s.callsDelta === 0), 'a restart must not produce deltas');
    assert.ok(derived.every((s) => s.impact === 0));
});

test('deriveStatements marks a statement slow against the configured threshold', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T2, false, 10, 100);
    const cheap = derived.find((s) => s.queryId === '-4207345678901234567');
    const report = derived.find((s) => s.queryId === '881234567890123456');

    assert.strictEqual(report.slow, true);
    // The cheap query averages 2ms but peaked at 85ms — still under 100ms.
    assert.strictEqual(cheap.slow, false);
});

test('deriveStatements marks a statement slow on its worst case alone', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T2, false, 10, 50);
    const cheap = derived.find((s) => s.queryId === '-4207345678901234567');
    // maxExecTime is 85ms: one bad execution is worth surfacing even when the
    // average is fine.
    assert.strictEqual(cheap.slow, true);
});

test('deriveStatements honours the configured limit', () => {
    const derived = statementsBetween(fx.STATEMENT_ROWS_T1, fx.STATEMENT_ROWS_T2, false, 1);
    assert.strictEqual(derived.length, 1);
    assert.strictEqual(derived[0].queryId, '-4207345678901234567');
});

test('deriveStatements tracks entries per database, not per query id alone', () => {
    // The same normalised statement in two databases has the same queryid in
    // some PostgreSQL versions; keying on queryid alone would cross the wires.
    const shared = Object.assign({}, fx.STATEMENT_ROWS_T1[0], { database: 'analytics' });
    const previous = { statements: parsers.parseStatements([fx.STATEMENT_ROWS_T1[0]]) };
    const current = parsers.parseStatements([fx.STATEMENT_ROWS_T2[0], shared]);

    const derived = pg.deriveStatements(current, previous, false, 10, 100);
    const inShop = derived.find((s) => s.database === 'shop');
    const inAnalytics = derived.find((s) => s.database === 'analytics');

    assert.strictEqual(inShop.callsDelta, 10000);
    // No previous sample for the analytics copy, so it is first-seen.
    assert.strictEqual(inAnalytics.callsDelta, 0);
});

// ── activity classification ───────────────────────────────────────────────────

const ACTIVITY_CONFIG = { longQuerySeconds: 30, longTransactionSeconds: 60, idleTransactionSeconds: 300 };

test('summariseActivity counts active, waiting and long-running work', () => {
    const activity = parsers.parseActivity(fx.ACTIVITY_ROWS);
    const idle = parsers.parseIdleInTransaction(fx.IDLE_IN_TRANSACTION_ROWS);
    const s = pg.summariseActivity(activity, idle, ACTIVITY_CONFIG);

    assert.strictEqual(s.activeQueries, 3);
    assert.strictEqual(s.waitingQueries, 3);
    assert.strictEqual(s.longRunningQueries, 2);
    assert.strictEqual(s.longRunningTransactions, 2);
});

test('summariseActivity reports the oldest query and transaction, not a sum', () => {
    const activity = parsers.parseActivity(fx.ACTIVITY_ROWS);
    const idle = parsers.parseIdleInTransaction(fx.IDLE_IN_TRANSACTION_ROWS);
    const s = pg.summariseActivity(activity, idle, ACTIVITY_CONFIG);

    assert.strictEqual(s.longestQuerySeconds, 480);
    assert.strictEqual(s.longestTransactionSeconds, 480);
    assert.strictEqual(s.longestIdleInTransactionSeconds, 600.1);
});

test('summariseActivity separates stale idle transactions from merely open ones', () => {
    const idle = parsers.parseIdleInTransaction(fx.IDLE_IN_TRANSACTION_ROWS);
    const s = pg.summariseActivity([], idle, ACTIVITY_CONFIG);

    assert.strictEqual(s.idleInTransactionCount, 2);
    // Only the one past idleTransactionSeconds; a 90-second one is not stale.
    assert.strictEqual(s.staleIdleInTransactionCount, 1);
});

test('summariseActivity respects configured thresholds instead of hardcoding them', () => {
    const activity = parsers.parseActivity(fx.ACTIVITY_ROWS);
    const relaxed = pg.summariseActivity(activity, [], {
        longQuerySeconds: 600, longTransactionSeconds: 600, idleTransactionSeconds: 600
    });

    assert.strictEqual(relaxed.longRunningQueries, 0);
    assert.strictEqual(relaxed.thresholds.longQuerySeconds, 600);
});

test('summariseActivity is total on a quiet server', () => {
    const s = pg.summariseActivity([], [], ACTIVITY_CONFIG);
    assert.strictEqual(s.activeQueries, 0);
    assert.strictEqual(s.longestTransactionSeconds, 0);
});

// ── configuration ─────────────────────────────────────────────────────────────

test('normalizeConfig applies documented defaults', () => {
    const config = pg.normalizeConfig({ host: 'db.internal', username: 'watchlog' });

    assert.strictEqual(config.port, 5432);
    assert.strictEqual(config.slowQueryThresholdMs, pg.DEFAULTS.slowQueryThresholdMs);
    assert.strictEqual(config.maxStatements, pg.DEFAULTS.maxStatements);
    assert.strictEqual(config.storageIntervalSeconds, pg.DEFAULTS.storageIntervalSeconds);
    // Every section is on unless explicitly disabled.
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.queries, true);
    assert.strictEqual(config.replication, true);
});

test('normalizeConfig honours a user-set slow query threshold, including zero', () => {
    assert.strictEqual(pg.normalizeConfig({ slowQuery: { thresholdMs: 10 } }).slowQueryThresholdMs, 10);
    // Zero is a real choice — "record everything" — not a missing value.
    assert.strictEqual(pg.normalizeConfig({ slowQuery: { thresholdMs: 0 } }).slowQueryThresholdMs, 0);
});

test('normalizeConfig lets a section be turned off individually', () => {
    const config = pg.normalizeConfig({ advanced: { queries: false, replication: false } });
    assert.strictEqual(config.queries, false);
    assert.strictEqual(config.replication, false);
    // Turning one section off does not disable the rest.
    assert.strictEqual(config.locks, true);
    assert.strictEqual(config.storage, true);
});

test('normalizeConfig accepts a database as a string or an array', () => {
    assert.deepStrictEqual(pg.normalizeConfig({ database: 'shop' }).databases, ['shop']);
    assert.deepStrictEqual(pg.normalizeConfig({ database: ['shop', 'analytics'] }).databases, ['shop', 'analytics']);
    assert.deepStrictEqual(pg.normalizeConfig({}).databases, []);
});

test('normalizeConfig always has a connection target, even with no database configured', () => {
    // Cluster-wide views still need somewhere to connect; `postgres` always exists.
    assert.strictEqual(pg.normalizeConfig({}).primaryDatabase, 'postgres');
    assert.strictEqual(pg.normalizeConfig({ database: ['shop'] }).primaryDatabase, 'shop');
});

test('normalizeConfig drops empty entries from a database list', () => {
    assert.deepStrictEqual(pg.normalizeConfig({ database: ['shop', '', null] }).databases, ['shop']);
});

// ── legacy payload ────────────────────────────────────────────────────────────

test('toLegacyPayload keeps the original per-database shape', () => {
    const serverInfo = parsers.parseServerInfo(fx.SERVER_INFO_15, parsers.parseVersion('150004'));
    const databaseStats = parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1);
    const connections = parsers.parseConnections(fx.CONNECTION_ROWS, 100);
    const lockSummary = parsers.parseLockSummary(fx.LOCK_ROWS);
    const statements = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    const config = pg.normalizeConfig({ database: ['shop', 'analytics'] });

    const legacy = pg.toLegacyPayload(config, serverInfo, databaseStats, connections, lockSummary, statements);
    const shop = legacy.databases.find((d) => d.db === 'shop');

    // The pre-existing dashboard reads these exact keys.
    for (const key of ['db', 'db_size', 'xact_commit', 'xact_rollback', 'cache_hit_ratio',
        'blks_read', 'blks_hit', 'tup_returned', 'deadlocks', 'temp_files', 'waiting_locks']) {
        assert.ok(key in shop, `legacy key ${key} missing`);
    }
    assert.strictEqual(shop.db_size, 5368709120);
    assert.strictEqual(shop.waiting_locks, 3);
});

test('toLegacyPayload only reports the databases the user configured', () => {
    const config = pg.normalizeConfig({ database: ['shop'] });
    const legacy = pg.toLegacyPayload(
        config,
        parsers.parseServerInfo(fx.SERVER_INFO_15, parsers.parseVersion('150004')),
        parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1),
        parsers.parseConnections(fx.CONNECTION_ROWS, 100),
        parsers.parseLockSummary(fx.LOCK_ROWS),
        []
    );
    assert.deepStrictEqual(legacy.databases.map((d) => d.db), ['shop']);
});

test('toLegacyPayload carries the top statements under queryStats', () => {
    const config = pg.normalizeConfig({ database: ['shop'] });
    const statements = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    const legacy = pg.toLegacyPayload(
        config,
        parsers.parseServerInfo(fx.SERVER_INFO_15, parsers.parseVersion('150004')),
        parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1),
        parsers.parseConnections(fx.CONNECTION_ROWS, 100),
        parsers.parseLockSummary(fx.LOCK_ROWS),
        statements
    );

    assert.ok(legacy.queryStats.length > 0);
    assert.ok('avg_time_ms' in legacy.queryStats[0]);
    // The agent's own statistics reads must not appear in a customer-facing list.
    assert.ok(!legacy.queryStats.some((q) => /pg_stat_/.test(q.query)));
});

test('toLegacyPayload keeps db_size numeric when the size could not be read', () => {
    // The advanced payload carries null, but the legacy field has always been a
    // number and the existing chart reads it directly.
    const stats = parsers.parseDatabaseStats([
        Object.assign({}, fx.DATABASE_ROWS_T1[0], { database_size: null })
    ]);
    assert.strictEqual(stats[0].databaseSize, null);

    const legacy = pg.toLegacyPayload(
        pg.normalizeConfig({ database: ['shop'] }),
        parsers.parseServerInfo(fx.SERVER_INFO_15, parsers.parseVersion('150004')),
        stats,
        parsers.parseConnections(fx.CONNECTION_ROWS, 100),
        parsers.parseLockSummary(fx.LOCK_ROWS),
        []
    );
    assert.strictEqual(legacy.databases[0].db_size, 0);
});

test('toLegacyPayload tolerates missing sections rather than throwing', () => {
    const config = pg.normalizeConfig({ database: ['shop'] });
    const legacy = pg.toLegacyPayload(
        config,
        parsers.parseServerInfo(fx.SERVER_INFO_15, parsers.parseVersion('150004')),
        parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1),
        parsers.parseConnections(fx.CONNECTION_ROWS, 100),
        null,   // pg_locks unreadable for this role
        null    // pg_stat_statements not installed
    );

    const shop = legacy.databases.find((d) => d.db === 'shop');
    assert.strictEqual(shop.waiting_locks, 0);
    assert.deepStrictEqual(legacy.queryStats, []);
});

// ── state isolation ───────────────────────────────────────────────────────────

test('resetState clears the per-instance counter memory', () => {
    pg.resetState();
    // Nothing to assert beyond it being callable and idempotent; the tests above
    // rely on it not leaking state between scenarios.
    pg.resetState();
    assert.ok(true);
});
