// Parser tests for the advanced Redis collector.
//
// Run with `npm test` (node:test, no dependencies).

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const parsers = require('../app/integrations/redis/parsers');
const fx = require('./fixtures/redis-info');

// ── INFO ──────────────────────────────────────────────────────────────────────

test('parseInfo reads scalars and separates keyspace and replica lines', () => {
    const { info, keyspaceLines, replicaLines } = parsers.parseInfo(fx.STANDALONE_INFO);

    assert.strictEqual(info.redis_version, '7.2.5');
    assert.strictEqual(info.redis_mode, 'standalone');
    assert.strictEqual(info.run_id, '4fef586d084699b6540a15e21a6ff1488e6bce31');
    assert.strictEqual(info.maxmemory, '0');

    // Section headers and blank lines must not become keys.
    assert.ok(!('# Server' in info));
    assert.ok(!('' in info));

    // db0/db1 are records, not scalars, so they stay out of the flat map.
    assert.deepStrictEqual(Object.keys(keyspaceLines), ['db0', 'db1']);
    assert.ok(!('db0' in info));
    assert.deepStrictEqual(replicaLines, []);
});

test('parseInfo keeps values containing colons intact', () => {
    const { info } = parsers.parseInfo(fx.STANDALONE_INFO);
    // executable is a path; splitting naively on ":" would truncate it.
    assert.strictEqual(info.executable, '/opt/homebrew/opt/redis/bin/redis-server');
    assert.strictEqual(info.os, 'Darwin 25.5.0 arm64');
});

test('parseInfo tolerates an error reply and empty input', () => {
    assert.deepStrictEqual(parsers.parseInfo(fx.NOPERM_ERROR).info, {});
    assert.deepStrictEqual(parsers.parseInfo('').info, {});
    assert.deepStrictEqual(parsers.parseInfo(null).info, {});
});

// ── keyspace ──────────────────────────────────────────────────────────────────

test('parseKeyspace derives persistentKeys and orders databases numerically', () => {
    const { keyspaceLines } = parsers.parseInfo(fx.STANDALONE_INFO);
    const databases = parsers.parseKeyspace(keyspaceLines);

    assert.strictEqual(databases.length, 2);
    assert.deepStrictEqual(databases[0], {
        database: 'db0', keys: 1200, expires: 400, persistentKeys: 800, avgTTL: 450000
    });
    assert.strictEqual(databases[1].database, 'db1');
    assert.strictEqual(databases[1].persistentKeys, 50);
});

test('parseKeyspace sorts db10 after db2 rather than lexically', () => {
    const databases = parsers.parseKeyspace({
        db10: 'keys=1,expires=0,avg_ttl=0',
        db2: 'keys=1,expires=0,avg_ttl=0'
    });
    assert.deepStrictEqual(databases.map(d => d.database), ['db2', 'db10']);
});

test('parseKeyspace never reports negative persistent keys', () => {
    // expires can momentarily exceed keys between Redis's internal updates.
    const [db] = parsers.parseKeyspace({ db0: 'keys=5,expires=9,avg_ttl=0' });
    assert.strictEqual(db.persistentKeys, 0);
});

// ── commandstats ──────────────────────────────────────────────────────────────

test('parseCommandstats reads every field including container subcommands', () => {
    const commands = parsers.parseCommandstats(fx.COMMANDSTATS);
    assert.strictEqual(commands.length, 4);

    const get = commands.find(c => c.command === 'get');
    assert.deepStrictEqual(get, {
        command: 'get', calls: 100000, usec: 120000,
        usecPerCall: 1.2, rejectedCalls: 0, failedCalls: 0
    });

    const set = commands.find(c => c.command === 'set');
    assert.strictEqual(set.rejectedCalls, 2);
    assert.strictEqual(set.failedCalls, 1);

    // `client|list` is one command name in Redis's stats, pipe included.
    assert.ok(commands.some(c => c.command === 'client|list'));
});

test('parseCommandstats returns empty on a permission error', () => {
    assert.deepStrictEqual(parsers.parseCommandstats(fx.NOPERM_ERROR), []);
});

// ── replication ───────────────────────────────────────────────────────────────

test('parseReplication builds a primary view with per-replica byte lag', () => {
    const { info, replicaLines } = parsers.parseInfo(fx.PRIMARY_INFO);
    const repl = parsers.parseReplication(info, replicaLines);

    assert.strictEqual(repl.role, 'master');
    assert.strictEqual(repl.isPrimary, true);
    assert.strictEqual(repl.isReplica, false);
    assert.strictEqual(repl.connectedReplicas, 2);
    assert.strictEqual(repl.replicationOffset, 900000);
    assert.strictEqual(repl.replicas.length, 2);

    const online = repl.replicas[0];
    assert.strictEqual(online.host, '10.0.0.11');
    assert.strictEqual(online.port, 6379);
    assert.strictEqual(online.online, true);
    // 900000 - 889000: the byte gap catches drift that `lag: 0` hides.
    assert.strictEqual(online.offsetBytesBehind, 11000);

    const syncing = repl.replicas[1];
    assert.strictEqual(syncing.state, 'send_bulk');
    assert.strictEqual(syncing.online, false);
});

test('parseReplication builds a replica view with a down link', () => {
    const { info, replicaLines } = parsers.parseInfo(fx.REPLICA_INFO);
    const repl = parsers.parseReplication(info, replicaLines);

    assert.strictEqual(repl.isReplica, true);
    assert.strictEqual(repl.isPrimary, false);
    assert.strictEqual(repl.masterHost, '10.0.0.1');
    assert.strictEqual(repl.masterPort, 6379);
    assert.strictEqual(repl.masterLinkStatus, 'down');
    assert.strictEqual(repl.masterLinkUp, false);
    assert.strictEqual(repl.masterLastIoSecondsAgo, 42);
    assert.strictEqual(repl.replicas.length, 0);
});

// ── cluster ───────────────────────────────────────────────────────────────────

test('parseClusterInfo reads a healthy cluster', () => {
    const cluster = parsers.parseClusterInfo(fx.CLUSTER_INFO_OK);
    assert.strictEqual(cluster.enabled, true);
    assert.strictEqual(cluster.state, 'ok');
    assert.strictEqual(cluster.slotsAssigned, 16384);
    assert.strictEqual(cluster.knownNodes, 6);
    assert.strictEqual(cluster.size, 3);
});

test('parseClusterInfo reads a degraded cluster', () => {
    const cluster = parsers.parseClusterInfo(fx.CLUSTER_INFO_DEGRADED);
    assert.strictEqual(cluster.state, 'fail');
    assert.strictEqual(cluster.slotsFail, 500);
    assert.strictEqual(cluster.slotsPfail, 500);
    assert.strictEqual(cluster.slotsAssigned, 12000);
});

test('parseClusterInfo reports disabled rather than throwing on a non-cluster instance', () => {
    // This is the single most common case: cluster support is off.
    assert.deepStrictEqual(parsers.parseClusterInfo(fx.CLUSTER_DISABLED_ERROR), { enabled: false });
    assert.deepStrictEqual(parsers.parseClusterInfo(''), { enabled: false });
});

test('parseClusterNodes builds topology with roles, slots and failure flags', () => {
    const nodes = parsers.parseClusterNodes(fx.CLUSTER_NODES);
    assert.strictEqual(nodes.length, 6);

    const self = nodes.find(n => n.self);
    assert.strictEqual(self.id, 'a1b2');
    assert.strictEqual(self.host, '10.0.0.1');
    assert.strictEqual(self.port, 6379);
    assert.strictEqual(self.role, 'master');
    assert.deepStrictEqual(self.slots, ['0-5460']);
    assert.strictEqual(self.slotCount, 5461);
    // `myself` is a positional marker, not a state worth showing.
    assert.ok(!self.flags.includes('myself'));

    const replicas = nodes.filter(n => n.role === 'replica');
    assert.strictEqual(replicas.length, 3);
    assert.strictEqual(replicas[0].masterId, 'a1b2');

    // fail? (suspected) and fail (confirmed) are different states.
    assert.strictEqual(nodes.find(n => n.id === '3344').possiblyFailed, true);
    assert.strictEqual(nodes.find(n => n.id === '3344').failed, false);
    assert.strictEqual(nodes.find(n => n.id === '5566').failed, true);
    assert.strictEqual(nodes.find(n => n.id === '5566').linkState, 'disconnected');

    // Every slot is covered exactly once across the three primaries.
    const totalSlots = nodes.reduce((s, n) => s + n.slotCount, 0);
    assert.strictEqual(totalSlots, 16384);
});

test('parseClusterNodes ignores migrating slot markers', () => {
    const nodes = parsers.parseClusterNodes(
        'a1b2 10.0.0.1:6379@16379 myself,master - 0 1 1 connected 0-10 [11-<-c3d4]'
    );
    assert.deepStrictEqual(nodes[0].slots, ['0-10']);
    assert.strictEqual(nodes[0].slotCount, 11);
});

test('parseClusterNodes handles the hostname suffix form', () => {
    const nodes = parsers.parseClusterNodes(
        'a1b2 10.0.0.1:6379@16379,node1.example.com master - 0 1 1 connected 0-10'
    );
    assert.strictEqual(nodes[0].host, '10.0.0.1');
    assert.strictEqual(nodes[0].hostname, 'node1.example.com');
});

// ── slowlog ───────────────────────────────────────────────────────────────────

test('parseSlowlog reads the --json form and converts microseconds', () => {
    const entries = parsers.parseSlowlog(fx.SLOWLOG_JSON);
    assert.strictEqual(entries.length, 4);

    const first = entries[0];
    assert.strictEqual(first.id, 12);
    assert.strictEqual(first.durationMicroseconds, 211861);
    assert.strictEqual(first.durationMilliseconds, 211.861);
    // Redis reports seconds; the pipeline works in milliseconds throughout.
    assert.strictEqual(first.timestamp, 1786450837 * 1000);
    assert.strictEqual(first.commandName, 'EVAL');
    assert.strictEqual(first.clientAddress, '127.0.0.1:53275');
    assert.strictEqual(first.clientName, '');

    assert.strictEqual(entries[1].clientName, 'worker-1');
});

test('parseSlowlog returns empty for malformed or errored output', () => {
    assert.deepStrictEqual(parsers.parseSlowlog(fx.NOPERM_ERROR), []);
    assert.deepStrictEqual(parsers.parseSlowlog('not json'), []);
    assert.deepStrictEqual(parsers.parseSlowlog('{}'), []);
    assert.deepStrictEqual(parsers.parseSlowlog(''), []);
});

// ── CONFIG GET ────────────────────────────────────────────────────────────────

test('parseConfigGet accepts both the RESP3 map and RESP2 array forms', () => {
    const expected = { 'slowlog-log-slower-than': '10000', 'slowlog-max-len': '128' };
    assert.deepStrictEqual(parsers.parseConfigGet(fx.CONFIG_GET_RESP3), expected);
    assert.deepStrictEqual(parsers.parseConfigGet(fx.CONFIG_GET_RESP2), expected);
});

// ── section splitting ─────────────────────────────────────────────────────────

test('splitSections divides piped output on the echo marker', () => {
    const marker = '__WL_REDIS_SEP__';
    const stdout = [
        `"${marker}"`, 'first section',
        `"${marker}"`, 'second', 'section',
        `"${marker}"`, fx.CLUSTER_DISABLED_ERROR
    ].join('\n');

    const sections = parsers.splitSections(stdout, marker);
    assert.strictEqual(sections.length, 3);
    assert.strictEqual(sections[0], 'first section');
    assert.strictEqual(sections[1], 'second\nsection');
    assert.strictEqual(sections[2], fx.CLUSTER_DISABLED_ERROR);
});

test('splitSections accepts the unquoted marker form', () => {
    const sections = parsers.splitSections('__M__\na\n__M__\nb', '__M__');
    assert.deepStrictEqual(sections, ['a', 'b']);
});

test('isErrorSection recognises redis-cli error replies printed to stdout', () => {
    assert.strictEqual(parsers.isErrorSection(fx.CLUSTER_DISABLED_ERROR), true);
    assert.strictEqual(parsers.isErrorSection(fx.NOPERM_ERROR), true);
    assert.strictEqual(parsers.isErrorSection('redis_version:7.2.5'), false);
    assert.strictEqual(parsers.isErrorSection(''), false);
});
