// Parser tests for the advanced MySQL collector.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const parsers = require('../app/integrations/mysql/parsers');
const fx = require('./fixtures/mysql-rows');

// ── status / variable parsing ─────────────────────────────────────────────────

test('parseKeyValueRows builds a flat map from SHOW GLOBAL STATUS', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    assert.strictEqual(status.Uptime, '4030');
    assert.strictEqual(status.Threads_connected, '12');
    assert.strictEqual(status.Innodb_buffer_pool_reads, '25000');
});

test('parseKeyValueRows handles the uppercase column names MariaDB uses', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS_UPPERCASE);
    assert.strictEqual(status.Uptime, '900');
    assert.strictEqual(status.Threads_connected, '4');
});

test('parseKeyValueRows falls back to positional reading for unknown column names', () => {
    const status = parsers.parseKeyValueRows([{ foo: 'Uptime', bar: '77' }]);
    assert.strictEqual(status.Uptime, '77');
});

test('parseKeyValueRows tolerates malformed input', () => {
    assert.deepStrictEqual(parsers.parseKeyValueRows(null), {});
    assert.deepStrictEqual(parsers.parseKeyValueRows([null, 5, {}]), {});
});

test('statusNumber is case-insensitive and defaults safely', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    assert.strictEqual(parsers.statusNumber(status, 'Uptime'), 4030);
    assert.strictEqual(parsers.statusNumber(status, 'uptime'), 4030);
    assert.strictEqual(parsers.statusNumber(status, 'Does_not_exist'), 0);
    assert.strictEqual(parsers.statusNumber(status, 'Does_not_exist', -1), -1);
});

// ── version detection ─────────────────────────────────────────────────────────

test('parseVersion identifies MySQL 8 capabilities', () => {
    const v = parsers.parseVersion('8.0.44');
    assert.strictEqual(v.major, 8);
    assert.strictEqual(v.isMariaDb, false);
    // SHOW REPLICA STATUS arrived in 8.0.22; data_locks in 8.0.
    assert.strictEqual(v.supportsReplicaTerminology, true);
    assert.strictEqual(v.supportsDataLocks, true);
});

test('parseVersion keeps MySQL 5.7 on the legacy statements', () => {
    const v = parsers.parseVersion('5.7.24-log');
    assert.strictEqual(v.major, 5);
    assert.strictEqual(v.supportsReplicaTerminology, false);
    assert.strictEqual(v.supportsDataLocks, false);
});

test('parseVersion detects MariaDB, which adopted neither', () => {
    const v = parsers.parseVersion('10.6.5-MariaDB');
    assert.strictEqual(v.isMariaDb, true);
    assert.strictEqual(v.supportsReplicaTerminology, false);
    assert.strictEqual(v.supportsDataLocks, false);
});

test('parseVersion pins 8.0.22 as the SHOW REPLICA STATUS boundary', () => {
    assert.strictEqual(parsers.parseVersion('8.0.21').supportsReplicaTerminology, false);
    assert.strictEqual(parsers.parseVersion('8.0.22').supportsReplicaTerminology, true);
    assert.strictEqual(parsers.parseVersion('8.1.0').supportsReplicaTerminology, true);
});

test('parseVersion never throws on garbage', () => {
    const v = parsers.parseVersion(undefined);
    assert.strictEqual(v.major, 0);
    assert.strictEqual(v.raw, '');
});

// ── timer conversion ──────────────────────────────────────────────────────────

test('picosToMs converts performance_schema picoseconds to milliseconds', () => {
    // This is the single easiest unit to get wrong: the divisor is 1e9, not 1e6.
    assert.strictEqual(parsers.picosToMs(1000000000), 1);
    assert.strictEqual(parsers.picosToMs(1500000000), 1.5);
    assert.strictEqual(parsers.picosToMs(45000000000), 45);
    assert.strictEqual(parsers.picosToMs(0), 0);
    assert.strictEqual(parsers.picosToMs(null), 0);
});

// ── server / connections / innodb ─────────────────────────────────────────────

test('buildServer collects identity without touching credentials', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    const variables = parsers.parseKeyValueRows(fx.VARIABLE_ROWS);
    const server = parsers.buildServer(variables, status, parsers.parseVersion('8.0.44'));

    assert.strictEqual(server.version, '8.0.44');
    assert.strictEqual(server.flavour, 'mysql');
    assert.strictEqual(server.hostname, 'db-primary-1');
    assert.strictEqual(server.uptimeSeconds, 4030);
    assert.strictEqual(server.readOnly, false);
    assert.strictEqual(server.maxConnections, 151);
    assert.strictEqual(server.performanceSchemaEnabled, true);
    assert.strictEqual(server.binlogEnabled, true);

    // ssl_key is present in the fixture and must not survive into the payload.
    const serialised = JSON.stringify(server);
    assert.ok(!serialised.includes('private-key'));
    assert.ok(!serialised.includes('ssl_key'));
});

test('buildConnections computes usage and handles a missing max_connections', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    const variables = parsers.parseKeyValueRows(fx.VARIABLE_ROWS);
    const connections = parsers.buildConnections(variables, status);

    assert.strictEqual(connections.threadsConnected, 12);
    assert.strictEqual(connections.threadsRunning, 3);
    assert.ok(Math.abs(connections.connectionUsagePercentage - (12 / 151) * 100) < 0.001);

    // Without a limit there is no denominator; null keeps the UI from drawing a
    // gauge against a made-up maximum.
    const without = parsers.buildConnections({}, status);
    assert.strictEqual(without.connectionUsagePercentage, null);
});

test('buildInnodb derives buffer pool ratios and reads lock counters', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    const innodb = parsers.buildInnodb(status);

    assert.strictEqual(innodb.bufferPoolPagesTotal, 8192);
    assert.ok(Math.abs(innodb.bufferPoolUtilization - (6000 / 8192) * 100) < 0.001);
    assert.strictEqual(innodb.dirtyPagePercentage, 10);   // 600 / 6000
    assert.strictEqual(innodb.rowLockWaits, 375);
    assert.strictEqual(innodb.rowLockCurrentWaits, 2);
    assert.strictEqual(innodb.logWaits, 3);
});

test('buildInnodb returns null ratios rather than 0 when the pool is empty', () => {
    const innodb = parsers.buildInnodb({});
    assert.strictEqual(innodb.bufferPoolUtilization, null);
    assert.strictEqual(innodb.dirtyPagePercentage, null);
});

test('buildTableCache and buildTempAndSort read their counters', () => {
    const status = parsers.parseKeyValueRows(fx.STATUS_ROWS);
    const variables = parsers.parseKeyValueRows(fx.VARIABLE_ROWS);

    const cache = parsers.buildTableCache(variables, status);
    assert.strictEqual(cache.openTables, 180);
    assert.strictEqual(cache.tableOpenCache, 4000);

    const temp = parsers.buildTempAndSort(status);
    assert.strictEqual(temp.createdTmpTables, 8000);
    assert.strictEqual(temp.createdTmpDiskTables, 2000);
    assert.strictEqual(temp.sortMergePasses, 120);
});

// ── digest parsing ────────────────────────────────────────────────────────────

test('parseDigestRows converts timers and derives the scan ratio', () => {
    const queries = parsers.parseDigestRows(fx.DIGEST_ROWS);
    const indexed = queries.find(q => q.digest === 'a1b2c3');

    assert.strictEqual(indexed.avgDuration, 1.5);      // 1_500_000_000 picos
    assert.strictEqual(indexed.maxDuration, 45);
    assert.strictEqual(indexed.totalDuration, 1500);
    assert.strictEqual(indexed.statementType, 'SELECT');
    assert.strictEqual(indexed.database, 'shop');
    // 1000 examined for 1000 sent: an index doing its job.
    assert.strictEqual(indexed.rowsExaminedPerRow, 1);

    const scanning = queries.find(q => q.digest === 'd4e5f6');
    assert.strictEqual(scanning.avgDuration, 500);
    assert.strictEqual(scanning.noIndexUsed, 50);
    assert.strictEqual(scanning.rowsExaminedPerRow, 5000);   // 250000 / 50
    assert.strictEqual(scanning.tmpDiskTables, 12);
});

test('parseDigestRows filters out the agent’s own monitoring queries', () => {
    const queries = parsers.parseDigestRows(fx.DIGEST_ROWS);
    // Otherwise "top queries" is dominated by Watchlog reading
    // performance_schema every minute.
    assert.ok(!queries.some(q => q.digest === 'agent1'));
    assert.ok(!queries.some(q => /performance_schema/i.test(q.digestText)));
});

test('parseDigestRows can include agent queries when explicitly asked', () => {
    const queries = parsers.parseDigestRows(fx.DIGEST_ROWS, { includeAgentQueries: true });
    assert.ok(queries.some(q => q.digest === 'agent1'));
});

test('isAgentQuery recognises the agent’s statements without eating user SQL', () => {
    assert.strictEqual(parsers.isAgentQuery('SELECT * FROM `performance_schema` . `threads`'), true);
    assert.strictEqual(parsers.isAgentQuery('SHOW GLOBAL STATUS'), true);
    assert.strictEqual(parsers.isAgentQuery('SHOW REPLICA STATUS'), true);
    assert.strictEqual(parsers.isAgentQuery('SELECT @@`version`'), true);
    assert.strictEqual(parsers.isAgentQuery('SELECT * FROM `users` WHERE `id` = ?'), false);
    assert.strictEqual(parsers.isAgentQuery('UPDATE `orders` SET `state` = ?'), false);
});

test('parseDigestRows labels the performance_schema overflow row honestly', () => {
    const queries = parsers.parseDigestRows(fx.DIGEST_ROWS);
    const overflow = queries.find(q => q.digestText.includes('overflow'));
    // A NULL DIGEST_TEXT is the catch-all row, not an empty query.
    assert.ok(overflow);
    assert.strictEqual(overflow.digestText, '<digest table overflow>');
});

// ── table / database stats ────────────────────────────────────────────────────

test('parseTableRows reads sizes and derives totalSize', () => {
    const tables = parsers.parseTableRows(fx.TABLE_ROWS);
    const orders = tables.find(t => t.table === 'orders');

    assert.strictEqual(orders.database, 'shop');
    assert.strictEqual(orders.engine, 'InnoDB');
    assert.strictEqual(orders.dataSize, 1589248);
    assert.strictEqual(orders.indexSize, 229376);
    assert.strictEqual(orders.totalSize, 1589248 + 229376);
    assert.strictEqual(orders.dataFree, 4194304);
    assert.strictEqual(orders.autoIncrement, 5001);

    // A NULL UPDATE_TIME / AUTO_INCREMENT must not become NaN.
    const users = tables.find(t => t.table === 'users');
    assert.strictEqual(users.updateTime, 0);
    const events = tables.find(t => t.table === 'events');
    assert.strictEqual(events.autoIncrement, 0);
});

test('aggregateDatabases rolls tables up per schema, largest first', () => {
    const tables = parsers.parseTableRows(fx.TABLE_ROWS);
    const databases = parsers.aggregateDatabases(tables);

    assert.strictEqual(databases.length, 2);
    assert.strictEqual(databases[0].database, 'shop');
    assert.strictEqual(databases[0].tableCount, 2);
    assert.strictEqual(databases[0].dataSize, 1589248 + 360448);
    assert.strictEqual(databases[0].totalSize, 1589248 + 229376 + 360448 + 409600);
    assert.strictEqual(databases[1].database, 'analytics');
});

// ── index stats ───────────────────────────────────────────────────────────────

test('parseIndexRows flags unused indexes by zero reads, not zero writes', () => {
    const indexes = parsers.parseIndexRows(fx.INDEX_ROWS);

    const neverUsed = indexes.find(i => i.index === 'idx_never_used');
    assert.strictEqual(neverUsed.unused, true);

    const used = indexes.find(i => i.index === 'idx_status');
    assert.strictEqual(used.unused, false);

    // PRIMARY is structural and can never be dropped.
    const primary = indexes.find(i => i.index === 'PRIMARY');
    assert.strictEqual(primary.isPrimary, true);
    assert.strictEqual(primary.unused, false);
});

test('parseIndexRows keeps the NULL-index row as table-scan activity', () => {
    const indexes = parsers.parseIndexRows(fx.INDEX_ROWS);
    const noIndex = indexes.find(i => i.isNoIndex);

    assert.ok(noIndex);
    assert.strictEqual(noIndex.index, '(no index)');
    assert.strictEqual(noIndex.reads, 15001);
    // It is activity, not an index, so it is never an unused candidate.
    assert.strictEqual(noIndex.unused, false);
});

test('parseIndexRows converts wait timers to milliseconds', () => {
    const indexes = parsers.parseIndexRows(fx.INDEX_ROWS);
    const idx = indexes.find(i => i.index === 'idx_status');
    assert.ok(Math.abs(idx.totalWait - 78.978) < 0.001);
});

test('mergeIndexMetadata protects UNIQUE indexes from the unused flag', () => {
    const indexes = parsers.parseIndexRows(fx.INDEX_ROWS);

    // uq_email has zero reads, so it starts out flagged...
    assert.strictEqual(indexes.find(i => i.index === 'uq_email').unused, true);

    parsers.mergeIndexMetadata(indexes, fx.INDEX_METADATA_ROWS);

    // ...and is cleared once we know it enforces a constraint.
    const unique = indexes.find(i => i.index === 'uq_email');
    assert.strictEqual(unique.isUnique, true);
    assert.strictEqual(unique.unused, false);
    assert.strictEqual(unique.cardinality, 4970);

    // A plain secondary index with no reads stays flagged.
    const neverUsed = indexes.find(i => i.index === 'idx_never_used');
    assert.strictEqual(neverUsed.isUnique, false);
    assert.strictEqual(neverUsed.unused, true);
});

// ── replication ───────────────────────────────────────────────────────────────

test('parseReplicaStatus reads the MySQL 8 SHOW REPLICA STATUS shape', () => {
    const repl = parsers.parseReplicaStatus(fx.REPLICA_STATUS_ROWS);

    assert.strictEqual(repl.enabled, true);
    assert.strictEqual(repl.role, 'replica');
    assert.strictEqual(repl.replicas.length, 1);

    const r = repl.replicas[0];
    assert.strictEqual(r.sourceHost, '10.0.0.1');
    assert.strictEqual(r.sourcePort, 3306);
    assert.strictEqual(r.ioRunning, true);
    assert.strictEqual(r.sqlRunning, true);
    assert.strictEqual(r.secondsBehind, 12);
    assert.strictEqual(repl.healthy, true);
    assert.strictEqual(repl.hasErrors, false);
});

test('parseReplicaStatus reads the legacy SHOW SLAVE STATUS shape identically', () => {
    const repl = parsers.parseReplicaStatus(fx.SLAVE_STATUS_ROWS);

    assert.strictEqual(repl.enabled, true);
    const r = repl.replicas[0];
    // Master_Host/Slave_IO_Running normalise to the same fields.
    assert.strictEqual(r.sourceHost, '10.0.0.1');
    assert.strictEqual(r.ioRunning, false);
    assert.strictEqual(r.sqlRunning, true);
    assert.strictEqual(r.lastIoErrno, 2003);
    assert.strictEqual(repl.healthy, false);
    assert.strictEqual(repl.hasErrors, true);
});

test('a NULL Seconds_Behind stays null rather than becoming a healthy 0', () => {
    const repl = parsers.parseReplicaStatus(fx.SLAVE_STATUS_ROWS);
    // NULL means "not connected", which must not read as "caught up".
    assert.strictEqual(repl.replicas[0].secondsBehind, null);
    assert.strictEqual(repl.anyDisconnected, true);
    assert.strictEqual(repl.maxSecondsBehind, 0);
});

test('parseReplicaStatus never collects replication credentials', () => {
    const repl = parsers.parseReplicaStatus(fx.REPLICA_STATUS_ROWS);
    const serialised = JSON.stringify(repl);
    // Source_User is present in the row set and must not survive.
    assert.ok(!serialised.includes('repl"'));
    assert.ok(!Object.keys(repl.replicas[0]).some(k => /user|password/i.test(k)));
});

test('parseReplicaStatus reports standalone for an empty result', () => {
    const repl = parsers.parseReplicaStatus([]);
    assert.strictEqual(repl.enabled, false);
    assert.strictEqual(repl.role, 'source');
});

test('parseConnectedReplicas handles both column spellings', () => {
    const replicas = parsers.parseConnectedReplicas(fx.CONNECTED_REPLICA_ROWS);
    assert.strictEqual(replicas.length, 2);
    assert.strictEqual(replicas[0].serverId, 2);
    assert.strictEqual(replicas[0].replicaUuid, 'uuid-2');
    // Server_id / Slave_UUID (lowercase d, legacy naming) read the same.
    assert.strictEqual(replicas[1].serverId, 3);
    assert.strictEqual(replicas[1].replicaUuid, 'uuid-3');
});

// ── locks ─────────────────────────────────────────────────────────────────────

test('parseLockWaits builds the wait graph with normalised query text', () => {
    const waits = parsers.parseLockWaits(fx.LOCK_WAIT_ROWS);
    assert.strictEqual(waits.length, 1);

    const w = waits[0];
    assert.strictEqual(w.waitingProcessId, 101);
    assert.strictEqual(w.blockingProcessId, 108);
    assert.strictEqual(w.database, 'shop');
    assert.strictEqual(w.table, 'orders');
    assert.strictEqual(w.lockMode, 'X,REC_NOT_GAP');
    assert.strictEqual(w.waitAgeSeconds, 14);
    // Values are already `?` placeholders — no literals stored.
    assert.ok(w.waitingQuery.includes('?'));
    assert.ok(!/\d{3,}/.test(w.waitingQuery));
});

test('parseLockWaits returns empty for missing input', () => {
    assert.deepStrictEqual(parsers.parseLockWaits(null), []);
    assert.deepStrictEqual(parsers.parseLockWaits([]), []);
});
