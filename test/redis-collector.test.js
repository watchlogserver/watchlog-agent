// Behavioural tests for the Redis collector's derivation logic:
// counter deltas across restarts, hit-rate handling, command impact ranking,
// slowlog deduplication, and the maxmemory/maxclients null cases.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const collector = require('../app/integrations/redis/index');
const parsers = require('../app/integrations/redis/parsers');
const fx = require('./fixtures/redis-info');

// ── counter deltas and restarts ───────────────────────────────────────────────

test('counterDelta returns the difference between consecutive samples', () => {
    assert.strictEqual(collector.counterDelta(150, 100, false), 50);
});

test('counterDelta returns 0 on the first sample, not the lifetime total', () => {
    // Without a previous sample the lifetime counter is not a rate; emitting it
    // would spike every chart at the moment monitoring starts.
    assert.strictEqual(collector.counterDelta(100000, null, false), 0);
    assert.strictEqual(collector.counterDelta(100000, undefined, false), 0);
});

test('counterDelta treats a backwards counter as a restart, never negative', () => {
    assert.strictEqual(collector.counterDelta(5, 100000, false), 0);
});

test('counterDelta returns 0 when a restart is signalled by run_id', () => {
    assert.strictEqual(collector.counterDelta(150, 100, true), 0);
});

// ── cache hit rate ────────────────────────────────────────────────────────────

test('deriveHitRate computes the interval rate, not the lifetime rate', () => {
    // Lifetime is 900/1000 = 90%, but this interval was 50/100 = 50%.
    const result = collector.deriveHitRate(950, 1050, { keyspaceHits: 900, keyspaceMisses: 1000 }, false);
    assert.strictEqual(result.hits, 50);
    assert.strictEqual(result.misses, 50);
    assert.strictEqual(result.rate, 50);
    assert.ok(Math.abs(result.lifetimeRate - 47.5) < 0.01);
});

test('deriveHitRate returns null rather than 0% when there was no traffic', () => {
    // An idle Redis has no hit rate. Reporting 0% would draw a cache collapse
    // that never happened and would drag the health score down.
    const result = collector.deriveHitRate(900, 100, { keyspaceHits: 900, keyspaceMisses: 100 }, false);
    assert.strictEqual(result.hits, 0);
    assert.strictEqual(result.misses, 0);
    assert.strictEqual(result.rate, null);
});

test('deriveHitRate never returns a negative rate after a restart', () => {
    const result = collector.deriveHitRate(10, 5, { keyspaceHits: 90000, keyspaceMisses: 1000 }, true);
    assert.strictEqual(result.hits, 0);
    assert.strictEqual(result.misses, 0);
    assert.strictEqual(result.rate, null);
    assert.ok(result.lifetimeRate >= 0);
});

test('deriveHitRate reports 100% when every lookup hit', () => {
    const result = collector.deriveHitRate(1100, 100, { keyspaceHits: 1000, keyspaceMisses: 100 }, false);
    assert.strictEqual(result.rate, 100);
});

// ── command derivation ────────────────────────────────────────────────────────

test('deriveCommands ranks by impact, so a hot cheap command beats a rare slow one', () => {
    const current = [
        // 100k calls at ~1.2us => impact 120000
        { command: 'get', calls: 200000, usec: 240000, usecPerCall: 1.2, rejectedCalls: 0, failedCalls: 0 },
        // 1 call at 300ms => impact 300000... but only 1 call this interval
        { command: 'keys', calls: 4, usec: 1200000, usecPerCall: 300000, rejectedCalls: 0, failedCalls: 0 }
    ];
    const previous = {
        commands: [
            { command: 'get', calls: 100000, usec: 120000, usecPerCall: 1.2, rejectedCalls: 0, failedCalls: 0 },
            { command: 'keys', calls: 3, usec: 900000, usecPerCall: 300000, rejectedCalls: 0, failedCalls: 0 }
        ]
    };

    const derived = collector.deriveCommands(current, previous, false, 10);

    const get = derived.find(c => c.command === 'get');
    const keys = derived.find(c => c.command === 'keys');

    assert.strictEqual(get.callsDelta, 100000);
    assert.strictEqual(get.usecDelta, 120000);
    assert.ok(Math.abs(get.avgUsec - 1.2) < 0.001);
    assert.ok(Math.abs(get.impact - 120000) < 1);

    assert.strictEqual(keys.callsDelta, 1);
    assert.strictEqual(keys.usecDelta, 300000);
    assert.strictEqual(keys.impact, 300000);

    // KEYS consumed more total time this interval, so it ranks first.
    assert.strictEqual(derived[0].command, 'keys');
});

test('deriveCommands zeroes deltas on restart but keeps lifetime counters', () => {
    const current = [{ command: 'get', calls: 5, usec: 10, usecPerCall: 2, rejectedCalls: 0, failedCalls: 0 }];
    const previous = { commands: [{ command: 'get', calls: 100000, usec: 120000, usecPerCall: 1.2, rejectedCalls: 0, failedCalls: 0 }] };

    const [get] = collector.deriveCommands(current, previous, true, 10);
    assert.strictEqual(get.callsDelta, 0);
    assert.strictEqual(get.usecDelta, 0);
    assert.strictEqual(get.calls, 5);
    assert.strictEqual(get.impact, 0);
});

test('deriveCommands falls back to usec_per_call when the interval had no calls', () => {
    const current = [{ command: 'get', calls: 100, usec: 200, usecPerCall: 2, rejectedCalls: 0, failedCalls: 0 }];
    const previous = { commands: [{ command: 'get', calls: 100, usec: 200, usecPerCall: 2, rejectedCalls: 0, failedCalls: 0 }] };

    const [get] = collector.deriveCommands(current, previous, false, 10);
    assert.strictEqual(get.callsDelta, 0);
    assert.strictEqual(get.avgUsec, 2);
});

test('deriveCommands respects the cap', () => {
    const current = [];
    for (let i = 0; i < 50; i++) {
        current.push({ command: `cmd${i}`, calls: i, usec: i, usecPerCall: 1, rejectedCalls: 0, failedCalls: 0 });
    }
    assert.strictEqual(collector.deriveCommands(current, null, false, 10).length, 10);
});

// ── slowlog deduplication ─────────────────────────────────────────────────────

function makeEntries(ids) {
    return ids.map(id => ({
        id, timestamp: 1786450000000 + id, durationMicroseconds: 1000,
        durationMilliseconds: 1, commandName: 'GET', args: ['GET', `key:${id}`],
        clientAddress: '127.0.0.1:1', clientName: ''
    }));
}

test('selectNewSlowlogEntries ships everything on the first scrape', () => {
    const st = { lastSlowlogId: -1, lastRunId: null };
    const result = collector.selectNewSlowlogEntries(makeEntries([0, 1, 2]), st, 'run-a', 100);

    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.highestId, 2);
    assert.strictEqual(result.restarted, false);
});

test('selectNewSlowlogEntries suppresses already-shipped entries', () => {
    const st = { lastSlowlogId: 2, lastRunId: 'run-a' };
    const result = collector.selectNewSlowlogEntries(makeEntries([0, 1, 2, 3, 4]), st, 'run-a', 100);

    assert.deepStrictEqual(result.entries.map(e => e.id), [4, 3]);
    assert.strictEqual(result.highestId, 4);
});

test('selectNewSlowlogEntries ships nothing when there is nothing new', () => {
    const st = { lastSlowlogId: 4, lastRunId: 'run-a' };
    const result = collector.selectNewSlowlogEntries(makeEntries([2, 3, 4]), st, 'run-a', 100);

    assert.strictEqual(result.entries.length, 0);
    assert.strictEqual(result.highestId, 4);
});

test('a Redis restart resets the slowlog watermark so new entries are not suppressed', () => {
    // After a restart Redis numbers slowlog entries from 0 again. Keeping the
    // old high-water mark would silently drop every entry until the counter
    // climbed past it — potentially forever on a quiet instance.
    const st = { lastSlowlogId: 5000, lastRunId: 'run-a' };
    const result = collector.selectNewSlowlogEntries(makeEntries([0, 1, 2]), st, 'run-b', 100);

    assert.strictEqual(result.restarted, true);
    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.highestId, 2);
});

test('selectNewSlowlogEntries stamps each entry with the run id for downstream identity', () => {
    const st = { lastSlowlogId: -1, lastRunId: null };
    const result = collector.selectNewSlowlogEntries(makeEntries([7]), st, 'run-xyz', 100);
    assert.strictEqual(result.entries[0].runId, 'run-xyz');
});

test('selectNewSlowlogEntries redacts arguments and never exposes raw values', () => {
    const entries = [{
        id: 1, timestamp: 1, durationMicroseconds: 1, durationMilliseconds: 0.001,
        commandName: 'SET', args: ['SET', 'user:token', 'super-secret'],
        clientAddress: '', clientName: ''
    }];
    const st = { lastSlowlogId: -1, lastRunId: null };
    const [entry] = collector.selectNewSlowlogEntries(entries, st, 'run-a', 100).entries;

    assert.strictEqual(entry.command, 'SET user:token [REDACTED]');
    assert.strictEqual(entry.redactedArguments, 1);
    // The raw argument array must not survive onto the shipped object.
    assert.strictEqual(entry.args, undefined);
});

test('selectNewSlowlogEntries caps the batch at the configured limit', () => {
    const st = { lastSlowlogId: -1, lastRunId: null };
    const ids = Array.from({ length: 200 }, (_, i) => i);
    const result = collector.selectNewSlowlogEntries(makeEntries(ids), st, 'run-a', 25);

    assert.strictEqual(result.entries.length, 25);
    // Newest first, so a burst keeps the most recent rather than the oldest.
    assert.strictEqual(result.entries[0].id, 199);
    assert.strictEqual(result.highestId, 199);
});

// ── memory and client edge cases ──────────────────────────────────────────────

test('buildMemory reports no percentage when maxmemory is unset', () => {
    const { info } = parsers.parseInfo(fx.STANDALONE_INFO);
    const memory = collector.buildMemory(info);

    assert.strictEqual(memory.maxMemory, 0);
    assert.strictEqual(memory.memoryLimitConfigured, false);
    // A percentage of an unlimited budget is meaningless, so it must be null
    // rather than 0 — 0% would read as "plenty of headroom".
    assert.strictEqual(memory.memoryUsagePercentage, null);
    assert.strictEqual(memory.usedMemory, 1558432);
    assert.strictEqual(memory.fragmentationRatio, 16.19);
});

test('buildMemory computes a percentage when maxmemory is configured', () => {
    const { info } = parsers.parseInfo(fx.MAXMEMORY_INFO);
    const memory = collector.buildMemory(info);

    assert.strictEqual(memory.memoryLimitConfigured, true);
    assert.strictEqual(memory.maxMemory, 1000000000);
    assert.strictEqual(memory.memoryUsagePercentage, 90);
    assert.strictEqual(memory.maxMemoryPolicy, 'allkeys-lru');
});

test('buildClients computes utilization and handles a missing maxclients', () => {
    const { info } = parsers.parseInfo(fx.STANDALONE_INFO);
    const clients = collector.buildClients(info);

    assert.strictEqual(clients.connectedClients, 4);
    assert.strictEqual(clients.maxClients, 10000);
    assert.strictEqual(clients.connectionUtilization, 0.04);

    // Some managed Redis providers omit maxclients from INFO.
    const without = collector.buildClients({ connected_clients: '5' });
    assert.strictEqual(without.connectionUtilization, null);
});

test('buildPersistence normalises Redis 0/1 flags into booleans', () => {
    const { info } = parsers.parseInfo(fx.STANDALONE_INFO);
    const persistence = collector.buildPersistence(info);

    assert.strictEqual(persistence.aofEnabled, true);
    assert.strictEqual(persistence.rdbBgsaveInProgress, false);
    assert.strictEqual(persistence.loading, false);
    assert.strictEqual(persistence.rdbLastBgsaveStatus, 'ok');
    // Redis reports seconds; the pipeline works in milliseconds.
    assert.strictEqual(persistence.rdbLastSaveTime, 1786450000 * 1000);
});

// ── config normalisation ──────────────────────────────────────────────────────

test('normalizeConfig applies safe defaults and honours overrides', () => {
    const defaults = collector.normalizeConfig({ service: 'redis' });
    assert.strictEqual(defaults.host, '127.0.0.1');
    assert.strictEqual(defaults.port, '6379');
    assert.strictEqual(defaults.enabled, true);
    assert.strictEqual(defaults.slowlogEnabled, true);

    const custom = collector.normalizeConfig({
        service: 'redis', host: 'redis.internal', port: 6380,
        advanced: { enabled: true, cluster: false, maxCommands: 25 },
        slowlog: { enabled: false, maxPerScrape: 10 }
    });
    assert.strictEqual(custom.host, 'redis.internal');
    assert.strictEqual(custom.port, '6380');
    assert.strictEqual(custom.cluster, false);
    assert.strictEqual(custom.maxCommands, 25);
    assert.strictEqual(custom.slowlogEnabled, false);
    assert.strictEqual(custom.maxSlowlogPerScrape, 10);
});

test('normalizeConfig lets advanced.enabled=false disable the whole extension', () => {
    const config = collector.normalizeConfig({ service: 'redis', advanced: { enabled: false } });
    assert.strictEqual(config.enabled, false);
});
