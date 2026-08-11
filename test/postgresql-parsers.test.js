// Parser tests for the advanced PostgreSQL collector.
//
// These cover the shapes a live server cannot demonstrate on its own — a 9.6
// activity row, a 17 checkpointer row, a replica's replay status — plus the
// judgement calls the spec is explicit about: a ratio with a zero denominator
// is null and never a fabricated 100%, a sequential scan is not automatically
// bad, and a constraint-backed index is never a removal candidate.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const parsers = require('../app/integrations/postgresql/parsers');
const fx = require('./fixtures/postgresql-rows');

// ── version parsing ───────────────────────────────────────────────────────────

test('parseVersion reads the modern MMpppp numbering', () => {
    const v = parsers.parseVersion('150004', '15.4');
    assert.strictEqual(v.major, 15);
    assert.strictEqual(v.label, '15');
    assert.strictEqual(v.versionNum, 150004);
});

test('parseVersion reads the pre-10 MMmmpp numbering', () => {
    const v = parsers.parseVersion('90624', '9.6.24');
    assert.strictEqual(v.major, 9);
    assert.strictEqual(v.minor, 6);
    assert.strictEqual(v.label, '9.6');
});

test('atLeast orders both numbering eras correctly', () => {
    const v96 = parsers.parseVersion('90624', '9.6.24');
    const v10 = parsers.parseVersion('100005', '10.5');
    const v13 = parsers.parseVersion('130004', '13.4');
    const v15 = parsers.parseVersion('150004', '15.4');
    const v17 = parsers.parseVersion('170000', '17.0');

    // 9.6 has wait_event but nothing newer.
    assert.strictEqual(v96.atLeast(96), true);
    assert.strictEqual(v96.atLeast(10), false);
    assert.strictEqual(v96.atLeast(14), false);
    assert.strictEqual(v96.atLeast(17), false);

    // 10 gained pg_blocking_pids and backend_type.
    assert.strictEqual(v10.atLeast(96), true);
    assert.strictEqual(v10.atLeast(10), true);
    assert.strictEqual(v10.atLeast(13), false);

    // 13 renamed total_time to total_exec_time.
    assert.strictEqual(v13.atLeast(13), true);
    assert.strictEqual(v13.atLeast(14), false);

    // 15 has pg_stat_wal (14+) but not pg_stat_checkpointer (17+).
    assert.strictEqual(v15.atLeast(14), true);
    assert.strictEqual(v15.atLeast(15), true);
    assert.strictEqual(v15.atLeast(17), false);

    assert.strictEqual(v17.atLeast(17), true);
});

test('parseVersion is total when the server did not answer', () => {
    const v = parsers.parseVersion(null, null);
    assert.strictEqual(v.versionNum, 0);
    assert.strictEqual(v.label, '');
    assert.strictEqual(v.atLeast(10), false);
});

// ── server info ───────────────────────────────────────────────────────────────

test('parseServerInfo reports a primary and its settings', () => {
    const version = parsers.parseVersion(fx.SERVER_INFO_15.server_version_num, '15.4');
    const info = parsers.parseServerInfo(fx.SERVER_INFO_15, version);

    assert.strictEqual(info.role, 'primary');
    assert.strictEqual(info.inRecovery, false);
    assert.strictEqual(info.maxConnections, 100);
    assert.strictEqual(info.autovacuumEnabled, true);
    assert.strictEqual(info.trackIoTiming, false);
    assert.strictEqual(info.sharedBuffers, '128MB');
});

test('parseServerInfo reports a server in recovery as a replica', () => {
    const version = parsers.parseVersion('150004', '15.4');
    assert.strictEqual(parsers.parseServerInfo(fx.SERVER_INFO_REPLICA, version).role, 'replica');
});

test('parseServerInfo reflects autovacuum being off rather than assuming it on', () => {
    const version = parsers.parseVersion('90624', '9.6.24');
    assert.strictEqual(parsers.parseServerInfo(fx.SERVER_INFO_96, version).autovacuumEnabled, false);
});

test('parseServerInfo returns null when the probe failed', () => {
    assert.strictEqual(parsers.parseServerInfo(null, parsers.parseVersion(0)), null);
});

// ── connections ───────────────────────────────────────────────────────────────

test('parseConnections totals states across databases', () => {
    const c = parsers.parseConnections(fx.CONNECTION_ROWS, 100);

    assert.strictEqual(c.total, 31);
    assert.strictEqual(c.active, 8);
    assert.strictEqual(c.idle, 18);
    assert.strictEqual(c.idleInTransaction, 3);
    assert.strictEqual(c.idleInTransactionAborted, 1);
    assert.strictEqual(c.waiting, 2);
    // A state the parser does not name explicitly still gets counted.
    assert.strictEqual(c.other, 1);
});

test('parseConnections takes the maximum age, not a sum', () => {
    const c = parsers.parseConnections(fx.CONNECTION_ROWS, 100);
    assert.strictEqual(c.longestTransactionSeconds, 620.4);
    assert.strictEqual(c.longestQuerySeconds, 300.9);
    assert.strictEqual(c.longestIdleInTransactionSeconds, 600.1);
});

test('parseConnections computes usage against max_connections', () => {
    const c = parsers.parseConnections(fx.CONNECTION_ROWS, 100);
    assert.strictEqual(c.connectionUsagePercentage, 31);
});

test('parseConnections returns null usage when max_connections is unreadable', () => {
    const c = parsers.parseConnections(fx.CONNECTION_ROWS, 0);
    // No denominator means no percentage — not a gauge against a made-up limit.
    assert.strictEqual(c.connectionUsagePercentage, null);
});

test('parseConnections is total on empty input', () => {
    const c = parsers.parseConnections([], 100);
    assert.strictEqual(c.total, 0);
    assert.strictEqual(c.connectionUsagePercentage, 0);
});

// ── pg_stat_database ──────────────────────────────────────────────────────────

test('parseDatabaseStats derives a lifetime cache hit ratio', () => {
    const [shop] = parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1);
    assert.strictEqual(shop.database, 'shop');
    assert.strictEqual(shop.xactCommit, 1000000);
    assert.ok(shop.cacheHitRatio > 98 && shop.cacheHitRatio < 100, String(shop.cacheHitRatio));
});

test('parseDatabaseStats keeps 14+ session columns null on an older server', () => {
    const [, analytics] = parsers.parseDatabaseStats(fx.DATABASE_ROWS_T1);
    assert.strictEqual(analytics.sessionTime, null);
    assert.strictEqual(analytics.sessions, null);
    // Not zero — the server never reported it.
    assert.notStrictEqual(analytics.sessionTime, 0);
});

test('parseDatabaseStats keeps an unreadable database size null', () => {
    // The query guards pg_database_size behind has_database_privilege, so a
    // database the role cannot CONNECT to yields null rather than failing the
    // whole statement — and null must not become "an empty database".
    const [row] = parsers.parseDatabaseStats([
        { database: 'restricted', blks_read: '10', blks_hit: '90', database_size: null }
    ]);
    assert.strictEqual(row.databaseSize, null);
    assert.strictEqual(row.cacheHitRatio, 90);
});

test('parseDatabaseStats returns a null ratio when no block was touched', () => {
    const [row] = parsers.parseDatabaseStats([{ database: 'empty', blks_read: '0', blks_hit: '0' }]);
    assert.strictEqual(row.cacheHitRatio, null);
});

// ── pg_stat_statements ────────────────────────────────────────────────────────

test('parseStatements filters out the agent reading the statistics views', () => {
    const parsed = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    const ids = parsed.map((s) => s.queryId);
    assert.ok(!ids.includes('111111111111111111'), 'pg_stat_database probe leaked');
    assert.ok(!ids.includes('222222222222222222'), 'to_regclass capability probe leaked');
});

test('parseStatements keeps customer statements', () => {
    const parsed = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    assert.ok(parsed.some((s) => s.queryId === '-4207345678901234567'));
    assert.ok(parsed.some((s) => s.queryId === '881234567890123456'));
});

test('parseStatements can be asked to keep agent queries for debugging', () => {
    const parsed = parsers.parseStatements(fx.STATEMENT_ROWS_T1, { includeAgentQueries: true });
    assert.strictEqual(parsed.length, fx.STATEMENT_ROWS_T1.length);
});

test('parseStatements treats pg_stat_statements timings as milliseconds', () => {
    const [cheap] = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    // 100000ms over 50000 calls is 2ms per call — no unit conversion applied.
    assert.strictEqual(cheap.totalExecTime, 100000);
    assert.strictEqual(cheap.meanExecTime, 2);
});

test('parseStatements computes rows per call', () => {
    const [cheap] = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    assert.strictEqual(cheap.rowsPerCall, 3);
});

test('parseStatements classifies statement type from the normalised text', () => {
    const parsed = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    const byId = new Map(parsed.map((s) => [s.queryId, s.statementType]));
    assert.strictEqual(byId.get('-4207345678901234567'), 'SELECT');
    assert.strictEqual(byId.get('881234567890123456'), 'SELECT');
    // Text the role could not read has no verb to classify, and guessing one
    // would put a fabricated statement into the grouping.
    assert.strictEqual(byId.get('333333333333333333'), 'UNKNOWN');
});

test('parseStatements surfaces text the role could not read as unavailable', () => {
    const parsed = parsers.parseStatements(fx.STATEMENT_ROWS_T1);
    const hidden = parsed.find((s) => s.queryId === '333333333333333333');
    assert.strictEqual(hidden.query, '<insufficient privilege>');
});

test('isAgentStatement matches every statistics view the collector reads', () => {
    const samples = [
        'SELECT * FROM pg_stat_activity',
        'SELECT * FROM pg_stat_statements',
        'SELECT * FROM pg_stat_user_tables',
        'SELECT * FROM pg_statio_user_indexes',
        'SELECT * FROM pg_locks',
        'SELECT pg_blocking_pids(pid)',
        'SHOW max_connections',
        "SELECT current_setting('autovacuum')",
        'SELECT pg_postmaster_start_time()',
        'SELECT pg_is_in_recovery()',
        'SELECT to_regclass($1)',
        'SELECT 1 FROM pg_extension WHERE extname = $1',
        'SELECT pg_backend_pid()',
        'SELECT pg_last_wal_replay_lsn()',
        'SELECT pg_wal_lsn_diff($1, $2)',
        'SELECT setting FROM pg_settings WHERE name = $1',
        'SELECT EXISTS (SELECT $1 FROM pg_views WHERE viewname = $2)',
        'SELECT * FROM pg_stat_io',
        // Pre-10 spellings of the replication position functions.
        'SELECT pg_last_xlog_replay_location()',
        'SELECT pg_xlog_location_diff($1, $2)',
        'SELECT pg_last_xact_replay_timestamp()',
        // Relation sizing, read once per storage scrape.
        'SELECT pg_total_relation_size($1)',
        'SELECT pg_database_size($1)',
        'SELECT pg_indexes_size($1)'
    ];
    for (const sql of samples) {
        assert.strictEqual(parsers.isAgentStatement(sql), true, sql);
    }
});

test('isAgentStatement does not match ordinary customer SQL', () => {
    assert.strictEqual(parsers.isAgentStatement('SELECT * FROM orders WHERE id = $1'), false);
    assert.strictEqual(parsers.isAgentStatement('UPDATE stats SET n = n + 1'), false);
    assert.strictEqual(parsers.isAgentStatement(''), false);
});

// ── activity, idle-in-transaction, blocking, locks ────────────────────────────

test('parseActivity scrubs the raw query text it reads', () => {
    const parsed = parsers.parseActivity(fx.ACTIVITY_ROWS);
    assert.ok(!JSON.stringify(parsed).includes('alice@example.com'));
    assert.ok(parsed[0].query.startsWith('SELECT * FROM users WHERE email = $?'));
});

test('parseActivity marks a backend as waiting when it has a wait event', () => {
    const parsed = parsers.parseActivity(fx.ACTIVITY_ROWS);
    assert.strictEqual(parsed[0].waiting, false);
    assert.strictEqual(parsed[1].waiting, true);
    assert.strictEqual(parsed[1].waitEventType, 'Lock');
});

test('parseActivity keeps 10+ backend_type when present', () => {
    const parsed = parsers.parseActivity(fx.ACTIVITY_ROWS);
    assert.strictEqual(parsed[0].backendType, 'client backend');
});

test('parseActivity tolerates a 9.6 row with no wait_event or backend_type', () => {
    const parsed = parsers.parseActivity([{
        pid: '7', database: 'shop', username: 'app', state: 'active',
        query_seconds: '1', xact_seconds: '1', state_seconds: '1', query: 'SELECT 1'
    }]);
    assert.strictEqual(parsed[0].waitEventType, '');
    assert.strictEqual(parsed[0].backendType, '');
    assert.strictEqual(parsed[0].waiting, false);
});

test('parseIdleInTransaction distinguishes aborted transactions and scrubs text', () => {
    const parsed = parsers.parseIdleInTransaction(fx.IDLE_IN_TRANSACTION_ROWS);
    assert.strictEqual(parsed[0].aborted, false);
    assert.strictEqual(parsed[1].aborted, true);
    assert.ok(!JSON.stringify(parsed).includes('manual fix'));
});

test('parseBlockingQueries deduplicates one pair reported per ungranted lock', () => {
    const parsed = parsers.parseBlockingQueries(fx.BLOCKING_ROWS);
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].blockedPid, 4211);
    assert.strictEqual(parsed[0].blockingPid, 4310);
});

test('parseBlockingQueries scrubs both the blocked and blocking statements', () => {
    const parsed = parsers.parseBlockingQueries(fx.BLOCKING_ROWS);
    assert.ok(!JSON.stringify(parsed).includes('manual fix'));
    assert.ok(parsed[0].blockedQuery.includes('UPDATE inventory'));
});

test('parseLockSummary splits granted from waiting', () => {
    const s = parsers.parseLockSummary(fx.LOCK_ROWS);
    assert.strictEqual(s.total, 141);
    assert.strictEqual(s.granted, 138);
    assert.strictEqual(s.waiting, 3);
    assert.strictEqual(s.byMode.ShareLock, 2);
});

// ── tables ────────────────────────────────────────────────────────────────────

test('parseTableStats derives dead-tuple and index-scan ratios', () => {
    const tables = parsers.parseTableStats(fx.TABLE_ROWS, 'shop');
    const orders = tables.find((t) => t.table === 'orders');

    assert.ok(Math.abs(orders.deadTupleRatio - 1.4285) < 0.01, String(orders.deadTupleRatio));
    assert.ok(orders.indexScanRatio > 99, String(orders.indexScanRatio));
});

test('parseTableStats returns a null dead ratio for an empty table', () => {
    const tables = parsers.parseTableStats(fx.TABLE_ROWS, 'shop');
    const empty = tables.find((t) => t.table === 'migrations_lock');
    // Zero live and zero dead is not a 0% ratio; it is no ratio.
    assert.strictEqual(empty.deadTupleRatio, null);
    assert.strictEqual(empty.indexScanRatio, null);
    assert.strictEqual(empty.heapCacheHitRatio, null);
});

test('parseTableStats does not judge sequential scans on its own', () => {
    const tables = parsers.parseTableStats(fx.TABLE_ROWS, 'shop');
    const flags = tables.find((t) => t.table === 'feature_flags');
    const events = tables.find((t) => t.table === 'events');

    // Both are scan-dominated. The parser reports the numbers; only a consumer
    // that also weighs table size can call one of them a problem.
    assert.strictEqual(flags.indexScanRatio, 0);
    assert.ok(events.indexScanRatio < 1);
    assert.strictEqual(flags.liveTuples, 20);
    assert.strictEqual(events.liveTuples, 400000000);
});

test('parseTableStats keeps a high dead ratio on a tiny table as a plain number', () => {
    const tables = parsers.parseTableStats(fx.TABLE_ROWS, 'shop');
    const flags = tables.find((t) => t.table === 'feature_flags');
    assert.strictEqual(flags.deadTupleRatio, 60);
    // 30 dead rows: the absolute count is what stops this reading as bloat.
    assert.strictEqual(flags.deadTuples, 30);
});

test('parseTableStats converts vacuum timestamps to epoch milliseconds', () => {
    const tables = parsers.parseTableStats(fx.TABLE_ROWS, 'shop');
    const orders = tables.find((t) => t.table === 'orders');
    assert.strictEqual(orders.lastVacuum, 0);
    assert.strictEqual(orders.lastAutovacuum, Date.parse('2026-08-11T09:00:00.000Z'));
});

test('parseTableStats reports a never-vacuumed table as zero, not as now', () => {
    const tables = parsers.parseTableStats(fx.TABLE_ROWS, 'shop');
    const events = tables.find((t) => t.table === 'events');
    assert.strictEqual(events.lastVacuum, 0);
    assert.strictEqual(events.lastAutovacuum, 0);
});

// ── indexes ───────────────────────────────────────────────────────────────────

test('parseIndexStats never marks a primary key as an unused candidate', () => {
    const idx = parsers.parseIndexStats(fx.INDEX_ROWS, 'shop');
    const pk = idx.find((i) => i.index === 'orders_pkey');
    assert.strictEqual(pk.idxScan, 0);
    assert.strictEqual(pk.unusedCandidate, false);
});

test('parseIndexStats never marks a unique or constraint index as a candidate', () => {
    const idx = parsers.parseIndexStats(fx.INDEX_ROWS, 'shop');
    const unique = idx.find((i) => i.index === 'orders_email_key');
    assert.strictEqual(unique.idxScan, 0);
    assert.strictEqual(unique.isUnique, true);
    assert.strictEqual(unique.unusedCandidate, false);
});

test('parseIndexStats marks a plain unused index as a candidate', () => {
    const idx = parsers.parseIndexStats(fx.INDEX_ROWS, 'shop');
    const legacy = idx.find((i) => i.index === 'orders_legacy_ref_idx');
    assert.strictEqual(legacy.unusedCandidate, true);
    assert.strictEqual(legacy.indexSize, 805306368);
});

test('parseIndexStats does not mark a used index as a candidate', () => {
    const idx = parsers.parseIndexStats(fx.INDEX_ROWS, 'shop');
    const used = idx.find((i) => i.index === 'orders_customer_id_idx');
    assert.strictEqual(used.unusedCandidate, false);
});

// ── WAL and checkpoints ───────────────────────────────────────────────────────

test('parseWalStats returns null before PostgreSQL 14, where the view does not exist', () => {
    assert.strictEqual(parsers.parseWalStats(null), null);
});

test('parseWalStats reads the 14–17 shape', () => {
    const wal = parsers.parseWalStats(fx.WAL_ROW_T1);
    assert.strictEqual(wal.walBytes, 10737418240);
    assert.strictEqual(wal.walBuffersFull, 120);
    assert.strictEqual(wal.walWrite, 400000);
});

test('parseWalStats keeps columns removed in 18 as null rather than zero', () => {
    const wal = parsers.parseWalStats(fx.WAL_ROW_18);
    assert.strictEqual(wal.walRecords, 5000000);
    assert.strictEqual(wal.walWrite, null);
    assert.strictEqual(wal.walSyncTime, null);
});

test('parseCheckpointStats returns null when neither view was readable', () => {
    assert.strictEqual(parsers.parseCheckpointStats(null), null);
});

test('parseCheckpointStats reads the pre-17 pg_stat_bgwriter shape', () => {
    const cp = parsers.parseCheckpointStats(fx.CHECKPOINT_ROW_T1);
    assert.strictEqual(cp.checkpointsTimed, 2000);
    assert.strictEqual(cp.checkpointsRequested, 30);
    assert.strictEqual(cp.buffersBackend, 80000);
});

test('parseCheckpointStats reads the 17+ pg_stat_checkpointer shape, which drops buffers_backend', () => {
    const cp = parsers.parseCheckpointStats(fx.CHECKPOINT_ROW_17);
    assert.strictEqual(cp.checkpointsTimed, 2000);
    assert.strictEqual(cp.buffersCheckpoint, 9000000);
    // The column is genuinely gone in 17; zero is the honest count for a sum.
    assert.strictEqual(cp.buffersBackend, 0);
});

// ── replication ───────────────────────────────────────────────────────────────

test('parseReplication summarises streaming and synchronous replicas', () => {
    const r = parsers.parseReplication(fx.REPLICATION_ROWS);
    assert.strictEqual(r.enabled, true);
    assert.strictEqual(r.replicas.length, 2);
    assert.strictEqual(r.streamingCount, 1);
    assert.strictEqual(r.synchronousCount, 1);
});

test('parseReplication keeps an unmeasured lag null rather than calling it zero', () => {
    const r = parsers.parseReplication(fx.REPLICATION_ROWS);
    const catchup = r.replicas.find((x) => x.applicationName === 'replica-2');
    assert.strictEqual(catchup.replayLag, null);
    assert.strictEqual(catchup.streaming, false);
    // The byte gap is measured even when the interval lags are not.
    assert.strictEqual(catchup.walLagBytes, 2097152);
});

test('parseReplication treats quorum as synchronous', () => {
    const r = parsers.parseReplication([
        { application_name: 'q', state: 'streaming', sync_state: 'quorum', wal_lag_bytes: '0' }
    ]);
    assert.strictEqual(r.synchronousCount, 1);
});

test('parseReplication reports a standalone server as not enabled', () => {
    const r = parsers.parseReplication([]);
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.maxReplayLag, 0);
});

test('parseReplicaStatus does not read an old replay timestamp as lag', () => {
    const s = parsers.parseReplicaStatus(fx.REPLICA_STATUS_IDLE_PRIMARY);
    // 90 minutes since the last replayed transaction, but nothing outstanding.
    assert.strictEqual(s.replayAgeSeconds, 5400);
    assert.strictEqual(s.replayLagBytes, 0);
    assert.strictEqual(s.caughtUp, true);
});

test('parseReplicaStatus reports a genuine byte gap as not caught up', () => {
    const s = parsers.parseReplicaStatus(fx.REPLICA_STATUS_LAGGING);
    assert.strictEqual(s.caughtUp, false);
    assert.strictEqual(s.replayLagBytes, 104857600);
});

test('parseReplicaStatus returns null on a primary, which has no replay position', () => {
    assert.strictEqual(parsers.parseReplicaStatus(null), null);
});

// ── vacuum progress ───────────────────────────────────────────────────────────

test('parseVacuumProgress reports a percentage only while scanning the heap', () => {
    const [scanning, indexing] = parsers.parseVacuumProgress(fx.VACUUM_PROGRESS_ROWS);
    assert.strictEqual(scanning.progressPercentage, 25);
    // The index phase has no heap denominator, so there is no percentage.
    assert.strictEqual(indexing.progressPercentage, null);
});

test('parseVacuumProgress is total on an idle server', () => {
    assert.deepStrictEqual(parsers.parseVacuumProgress([]), []);
    assert.deepStrictEqual(parsers.parseVacuumProgress(null), []);
});

// ── totality ──────────────────────────────────────────────────────────────────

test('every parser tolerates null input rather than throwing', () => {
    // One unreadable view must never take down the whole integration.
    assert.deepStrictEqual(parsers.parseDatabaseStats(null), []);
    assert.deepStrictEqual(parsers.parseStatements(null), []);
    assert.deepStrictEqual(parsers.parseActivity(null), []);
    assert.deepStrictEqual(parsers.parseIdleInTransaction(null), []);
    assert.deepStrictEqual(parsers.parseBlockingQueries(null), []);
    assert.deepStrictEqual(parsers.parseTableStats(null, 'shop'), []);
    assert.deepStrictEqual(parsers.parseIndexStats(null, 'shop'), []);
    assert.strictEqual(parsers.parseLockSummary(null).total, 0);
    assert.strictEqual(parsers.parseReplication(null).enabled, false);
});

test('num and nullableNum disagree deliberately about missing values', () => {
    assert.strictEqual(parsers.num(null), 0);
    assert.strictEqual(parsers.num('12'), 12);
    assert.strictEqual(parsers.num('not a number'), 0);

    assert.strictEqual(parsers.nullableNum(null), null);
    assert.strictEqual(parsers.nullableNum(''), null);
    assert.strictEqual(parsers.nullableNum('0'), 0);
    assert.strictEqual(parsers.nullableNum('12.5'), 12.5);
});

test('num reads the strings pg returns for bigint without losing precision below 2^53', () => {
    assert.strictEqual(parsers.num('9007199254740991'), 9007199254740991);
});
