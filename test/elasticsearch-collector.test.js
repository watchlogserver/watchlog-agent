// Collector derivation tests.
//
// These drive the scenarios a live cluster will not produce on demand: a node
// restarting mid-window, a shard relocating away and taking its counters with
// it, an idle interval that must not report zero latency, a cluster where one
// node carries far more load than its peers, and a JVM whose collectors are
// named differently.
//
// Required as `integrations/elasticsearch/index` — `integrations/elasticsearch`
// alone would resolve to a sibling legacy file if one is ever added, which is
// the trap the other integrations document.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const es = require('../app/integrations/elasticsearch/index');
const parsers = require('../app/integrations/elasticsearch/parsers');
const fx = require('./fixtures/elasticsearch-responses');

const INTERVAL = 60;

// ── configuration ─────────────────────────────────────────────────────────────

test('normalizeConfig defaults to a safe, verified, read-only setup', () => {
    const config = es.normalizeConfig({ service: 'elasticsearch' });

    assert.strictEqual(config.protocol, 'http');
    assert.strictEqual(config.host, '127.0.0.1');
    assert.strictEqual(config.port, 9200);
    assert.strictEqual(config.rejectUnauthorized, true, 'verification is on unless disabled');
    assert.strictEqual(config.enabled, true);
    assert.strictEqual(config.slowlog.enabled, false, 'slow log collection is opt-in');
    assert.strictEqual(config.slowlog.storeSource, false, 'document bodies are never stored by default');
});

test('normalizeConfig honours https, an explicit URL and disabled verification', () => {
    const config = es.normalizeConfig({
        url: 'https://es.example.com:9243/prefix',
        verifyCertificate: false
    });
    assert.strictEqual(config.url, 'https://es.example.com:9243/prefix');
    assert.strictEqual(config.rejectUnauthorized, false);

    const viaTls = es.normalizeConfig({ host: 'es.example.com', tls: { enabled: true } });
    assert.strictEqual(viaTls.protocol, 'https');
});

test('normalizeConfig lets advanced settings override the collection intervals', () => {
    const config = es.normalizeConfig({
        advanced: { indexIntervalSeconds: 120, maxIndices: 50, shards: false }
    });
    assert.strictEqual(config.indexIntervalSeconds, 120);
    assert.strictEqual(config.maxIndices, 50);
    assert.strictEqual(config.shards, false);
});

// ── garbage collection ────────────────────────────────────────────────────────

test('deriveGc reports GC cost as a share of wall-clock time', () => {
    const current = { young: { collectionCount: 200, collectionTimeMillis: 3000 } };
    const previous = { young: { collectionCount: 100, collectionTimeMillis: 1500 } };

    const gc = es.deriveGc(current, previous, false, INTERVAL);

    assert.strictEqual(gc.totalCountDelta, 100);
    assert.strictEqual(gc.totalTimeDelta, 1500);
    // 1.5s of collecting in a 60s window.
    assert.ok(Math.abs(gc.gcTimePercentage - 2.5) < 0.001);
    assert.strictEqual(gc.collectors.young.averagePauseMillis, 15);
});

test('deriveGc separates old-generation collectors across JVM naming schemes', () => {
    const g1 = es.deriveGc(
        { young: { collectionCount: 10, collectionTimeMillis: 100 },
          old: { collectionCount: 2, collectionTimeMillis: 1800 } },
        { young: { collectionCount: 0, collectionTimeMillis: 0 },
          old: { collectionCount: 0, collectionTimeMillis: 0 } },
        false, INTERVAL
    );
    assert.strictEqual(g1.oldCountDelta, 2);
    assert.strictEqual(g1.oldTimeDelta, 1800);
    assert.strictEqual(g1.youngCountDelta, 10);

    // CMS names from a 7.x JVM.
    const cms = es.deriveGc(
        { ParNew: { collectionCount: 10, collectionTimeMillis: 100 },
          ConcurrentMarkSweep: { collectionCount: 2, collectionTimeMillis: 1800 } },
        { ParNew: { collectionCount: 0, collectionTimeMillis: 0 },
          ConcurrentMarkSweep: { collectionCount: 0, collectionTimeMillis: 0 } },
        false, INTERVAL
    );
    assert.strictEqual(cms.oldCountDelta, 2, 'ConcurrentMarkSweep is an old-generation collector');
    assert.strictEqual(cms.youngCountDelta, 10);

    // A newer JDK adds a concurrent phase alongside young/old.
    const concurrent = es.deriveGc(
        { 'G1 Concurrent GC': { collectionCount: 5, collectionTimeMillis: 500 } },
        { 'G1 Concurrent GC': { collectionCount: 0, collectionTimeMillis: 0 } },
        false, INTERVAL
    );
    assert.strictEqual(concurrent.oldCountDelta, 5);
});

test('deriveGc reports no pause length when nothing collected', () => {
    const gc = es.deriveGc(
        { young: { collectionCount: 100, collectionTimeMillis: 1000 } },
        { young: { collectionCount: 100, collectionTimeMillis: 1000 } },
        false, INTERVAL
    );
    assert.strictEqual(gc.collectors.young.averagePauseMillis, null,
        'no collections is not a 0 ms pause');
    assert.strictEqual(gc.gcTimePercentage, 0);
});

// ── thread pools ──────────────────────────────────────────────────────────────

test('deriveThreadPools drops permanently-idle pools but keeps the critical ones', () => {
    const current = {
        search: { threads: 13, queue: 0, active: 0, rejected: 0, largest: 13, completed: 100 },
        azure_event_loop: { threads: 0, queue: 0, active: 0, rejected: 0, largest: 0, completed: 0 },
        force_merge: { threads: 1, queue: 0, active: 1, rejected: 0, largest: 1, completed: 5 }
    };
    const pools = es.deriveThreadPools(current, null, true, INTERVAL);
    const names = pools.map((p) => p.pool);

    assert.ok(names.includes('search'), 'a critical pool is always kept');
    assert.ok(names.includes('force_merge'), 'a pool that is doing work is kept');
    assert.ok(!names.includes('azure_event_loop'),
        'forty permanently-zero pools per node would be forty dead Influx series');
});

test('deriveThreadPools flags saturation and ranks rejections first', () => {
    const current = {
        search: { threads: 4, queue: 900, active: 4, rejected: 120, largest: 4, completed: 90000 },
        write: { threads: 8, queue: 0, active: 8, rejected: 0, largest: 8, completed: 5000 },
        get: { threads: 8, queue: 0, active: 1, rejected: 0, largest: 8, completed: 100 }
    };
    const previous = {
        search: { threads: 4, queue: 0, active: 0, rejected: 100, largest: 4, completed: 80000 },
        write: { threads: 8, queue: 0, active: 0, rejected: 0, largest: 8, completed: 4000 },
        get: { threads: 8, queue: 0, active: 0, rejected: 0, largest: 8, completed: 50 }
    };

    const pools = es.deriveThreadPools(current, previous, false, INTERVAL);

    assert.strictEqual(pools[0].pool, 'search', 'the pool that rejected sorts first');
    assert.strictEqual(pools[0].rejectedDelta, 20, 'the interval delta, not the lifetime count');
    assert.strictEqual(pools[0].saturated, true);

    const write = pools.find((p) => p.pool === 'write');
    assert.strictEqual(write.saturated, false, 'all threads busy with an empty queue is just work');
    assert.strictEqual(write.saturationPercentage, 100);

    const get = pools.find((p) => p.pool === 'get');
    assert.strictEqual(get.saturationPercentage, 12.5);
});

test('deriveThreadPools leaves saturation null on a scaling pool at rest', () => {
    const pools = es.deriveThreadPools(
        { search: { threads: 0, queue: 0, active: 0, rejected: 0, largest: 0, completed: 0 } },
        null, true, INTERVAL
    );
    assert.strictEqual(pools[0].saturationPercentage, null);
});

// ── circuit breakers ──────────────────────────────────────────────────────────

test('deriveBreakers reports trips during the interval, not since boot', () => {
    const current = {
        parent: { estimatedBytes: 900, limitBytes: 1000, overhead: 1, tripped: 12, usagePercentage: 90 },
        fielddata: { estimatedBytes: 10, limitBytes: 1000, overhead: 1.03, tripped: 4, usagePercentage: 1 }
    };
    const previous = {
        parent: { tripped: 10 },
        fielddata: { tripped: 4 }
    };

    const breakers = es.deriveBreakers(current, previous, false);

    assert.strictEqual(breakers[0].breaker, 'parent', 'the breaker that tripped sorts first');
    assert.strictEqual(breakers[0].trippedDelta, 2);
    assert.strictEqual(breakers[1].trippedDelta, 0,
        'a trip from months ago is not a trip now');
});

// ── indices rates ─────────────────────────────────────────────────────────────

function indicesSectionFromFixture(overrides) {
    const [node] = parsers.parseNodesStats(fx.nodeStats8(overrides));
    return node.indices;
}

test('deriveIndicesRates reports null latency on an idle interval', () => {
    const section = indicesSectionFromFixture();
    const rates = es.deriveIndicesRates(section, section, false, INTERVAL);

    assert.strictEqual(rates.search.queryDelta, 0);
    assert.strictEqual(rates.search.averageQueryLatencyMs, null,
        'no queries is not "the cluster answered instantly"');
    assert.strictEqual(rates.indexing.averageLatencyMs, null);
    assert.strictEqual(rates.queryCache.hitRate, null, 'no lookups is not a 0% hit rate');
    assert.strictEqual(rates.get.missingPercentage, null);
});

test('deriveIndicesRates computes latency from the interval, not the lifetime', () => {
    const previous = indicesSectionFromFixture({ queryTotal: 100000, indexTotal: 2000000 });
    const current = indicesSectionFromFixture({
        // 1000 more queries costing 20 000 ms → 20 ms each this interval, even
        // though the lifetime mean is 5 ms.
        queryTotal: 101000, queryTimeMillis: 520000,
        indexTotal: 2010000, indexTimeMillis: 410000
    });

    const rates = es.deriveIndicesRates(current, previous, false, INTERVAL);

    assert.strictEqual(rates.search.queryDelta, 1000);
    assert.strictEqual(rates.search.averageQueryLatencyMs, 20);
    assert.ok(Math.abs(rates.search.queriesPerSecond - 1000 / 60) < 0.001);
    assert.strictEqual(rates.indexing.averageLatencyMs, 1);
});

test('deriveIndicesRates reports no delta when a node restarted', () => {
    const previous = indicesSectionFromFixture({ queryTotal: 100000 });
    const current = indicesSectionFromFixture({ queryTotal: 500 });

    const rates = es.deriveIndicesRates(current, previous, true, INTERVAL);
    assert.strictEqual(rates.search.queryDelta, 0, 'a restart is not 500 queries');
    assert.strictEqual(rates.search.averageQueryLatencyMs, null);
});

test('deriveIndicesRates never emits a negative delta when a shard relocates away', () => {
    // The shard left, taking its share of this node's counters with it. That
    // looks exactly like a partial reset.
    const previous = indicesSectionFromFixture({ queryTotal: 100000 });
    const current = indicesSectionFromFixture({ queryTotal: 60000 });

    const rates = es.deriveIndicesRates(current, previous, false, INTERVAL);
    assert.strictEqual(rates.search.queryDelta, 0);
    assert.ok(rates.search.queriesPerSecond >= 0);
});

test('deriveIndicesRates computes cache hit rate over interval deltas', () => {
    const previous = indicesSectionFromFixture({ queryCacheHit: 900, queryCacheMiss: 100 });
    // 100 hits and 100 misses this interval → 50%, not the 90% lifetime figure.
    const current = indicesSectionFromFixture({ queryCacheHit: 1000, queryCacheMiss: 200 });

    const rates = es.deriveIndicesRates(current, previous, false, INTERVAL);
    assert.strictEqual(rates.queryCache.hitRate, 50);
});

test('deriveIndicesRates derives merge and indexing throttle shares', () => {
    const previous = indicesSectionFromFixture();
    const current = indicesSectionFromFixture();
    // 30s of a 60s interval spent throttled.
    current.indexing.throttleTimeMillis = previous.indexing.throttleTimeMillis + 30000;
    current.merges.totalTimeMillis = previous.merges.totalTimeMillis + 10000;
    current.merges.totalThrottledTimeMillis = previous.merges.totalThrottledTimeMillis + 5000;

    const rates = es.deriveIndicesRates(current, previous, false, INTERVAL);
    assert.strictEqual(rates.indexing.throttlePercentage, 50);
    assert.strictEqual(rates.merges.throttlePercentage, 50);
});

// ── nodes ─────────────────────────────────────────────────────────────────────

test('deriveNodes detects a restart from JVM uptime going backwards', () => {
    const [previousNode] = parsers.parseNodesStats(fx.nodeStats8({ uptimeMillis: 864000000, queryTotal: 100000 }));
    const [currentNode] = parsers.parseNodesStats(fx.nodeStats8({ uptimeMillis: 30000, queryTotal: 42 }));

    const [derived] = es.deriveNodes([currentNode], { 'node-a': previousNode }, INTERVAL, null, {});

    assert.strictEqual(derived.restarted, true);
    assert.strictEqual(derived.indices.search.queryDelta, 0,
        'every counter this node owns reset with it');
});

test('deriveNodes evaluates disk against the configured watermarks', () => {
    const watermarks = parsers.parseDiskWatermarks(fx.CLUSTER_SETTINGS_DEFAULT);

    // 30 GB of 1 TB available → 97% used, past flood stage.
    const [full] = parsers.parseNodesStats(fx.nodeStats8({ availableBytes: 30000000000 }));
    const [derivedFull] = es.deriveNodes([full], null, INTERVAL, watermarks, {});
    assert.strictEqual(derivedFull.watermark.level, 'flood_stage');

    // 700 GB available → 30% used.
    const [roomy] = parsers.parseNodesStats(fx.nodeStats8({ availableBytes: 700000000000 }));
    const [derivedRoomy] = es.deriveNodes([roomy], null, INTERVAL, watermarks, {});
    assert.strictEqual(derivedRoomy.watermark.level, 'ok');
});

test('deriveNodes leaves the watermark unevaluated when the settings are unreadable', () => {
    const [node] = parsers.parseNodesStats(fx.nodeStats8());
    const [derived] = es.deriveNodes([node], null, INTERVAL, null, {});
    assert.strictEqual(derived.watermark, null,
        'unknown thresholds must read as "not evaluated", never as "fine"');
});

test('deriveNodes carries the shard count between shard scrapes', () => {
    const [node] = parsers.parseNodesStats(fx.nodeStats8());
    const [derived] = es.deriveNodes([node], null, INTERVAL, null, { 'es-data-01': 157 });
    assert.strictEqual(derived.shardCount, 157);
});

// ── cluster rollups ───────────────────────────────────────────────────────────

test('summariseNodes aggregates cluster totals and finds the worst node', () => {
    const nodes = es.deriveNodes(
        parsers.parseNodesStats(fx.nodeStats8({ searchRejected: 5, parentTripped: 2 })),
        null, INTERVAL, parsers.parseDiskWatermarks(fx.CLUSTER_SETTINGS_DEFAULT), {}
    );

    const totals = es.summariseNodes(nodes, INTERVAL);

    assert.strictEqual(totals.maxHeapPercent, 62);
    assert.strictEqual(totals.maxCpuPercent, 41);
    assert.ok(totals.diskTotalBytes > 0);
    assert.strictEqual(totals.nodesSwapping, 0);
    // First scrape: no previous counters, so every delta is zero rather than
    // the lifetime value.
    assert.strictEqual(totals.searchRejectedDelta, 0);
    assert.strictEqual(totals.breakerTripsDelta, 0);
});

test('summariseNodes counts a swapping node', () => {
    const stats = fx.nodeStats8();
    stats.nodes['node-a'].os.swap.used_in_bytes = 1073741824;
    stats.nodes['node-a'].os.swap.free_in_bytes = 1073741824;

    const nodes = es.deriveNodes(parsers.parseNodesStats(stats), null, INTERVAL, null, {});
    const totals = es.summariseNodes(nodes, INTERVAL);

    assert.strictEqual(totals.nodesSwapping, 1,
        'Elasticsearch degrades sharply once heap pages are swapped out');
});

test('summariseNodes reports latency as null across an idle cluster', () => {
    const nodes = es.deriveNodes(parsers.parseNodesStats(fx.nodeStats8()), null, INTERVAL, null, {});
    const totals = es.summariseNodes(nodes, INTERVAL);
    assert.strictEqual(totals.averageQueryLatencyMs, null);
    assert.strictEqual(totals.queryCacheHitRate, null);
});

// ── node comparison ───────────────────────────────────────────────────────────

function nodeWith(nodeId, name, overrides) {
    const stats = fx.nodeStats8(Object.assign({ nodeId, name }, overrides));
    return parsers.parseNodesStats(stats)[0];
}

test('compareNodes says nothing about a single-node cluster', () => {
    const nodes = es.deriveNodes([nodeWith('node-a', 'es-data-01')], null, INTERVAL, null, {});
    const comparison = es.compareNodes(nodes);
    assert.strictEqual(comparison.comparable, false);
});

test('compareNodes uses the median so one outlier does not hide itself', () => {
    const raw = [
        nodeWith('n1', 'es-data-01', { heapUsedPercent: 30 }),
        nodeWith('n2', 'es-data-02', { heapUsedPercent: 32 }),
        nodeWith('n3', 'es-data-03', { heapUsedPercent: 90 })
    ];
    const nodes = es.deriveNodes(raw, null, INTERVAL, null, {});
    const comparison = es.compareNodes(nodes);

    assert.strictEqual(comparison.comparable, true);
    const heap = comparison.dimensions.find((d) => d.key === 'heap');
    assert.strictEqual(heap.median, 32, 'the mean would be dragged toward the outlier');
    assert.strictEqual(heap.highest.node, 'es-data-03');
    assert.ok(heap.deviationPercentage > 100);
});

test('compareNodes reports no deviation on an idle cluster rather than infinity', () => {
    const raw = [nodeWith('n1', 'a'), nodeWith('n2', 'b')];
    const nodes = es.deriveNodes(raw, null, INTERVAL, null, {});
    const comparison = es.compareNodes(nodes);

    const search = comparison.dimensions.find((d) => d.key === 'search');
    // Every node at zero: a median of zero must not produce an infinite ratio.
    if (search) assert.strictEqual(search.deviationPercentage, null);
});

// ── index derivation ──────────────────────────────────────────────────────────

test('deriveIndices reads storage from primaries and search from total', () => {
    const previous = parsers.parseIndexStats(fx.indexStats({ queryTotal: 40000, indexTotal: 900000 }));
    const current = parsers.parseIndexStats(fx.indexStats({ queryTotal: 41000, indexTotal: 906000 }));

    const previousByName = Object.fromEntries(previous.map((i) => [i.index, i]));
    const [derived] = es.deriveIndices(current, previousByName, INTERVAL, null);

    // The fixture doubles `total` against `primaries`, matching one replica.
    assert.strictEqual(derived.docsCount, 4000000, 'document count comes from primaries');
    assert.strictEqual(derived.searchDelta, 2000, 'search runs on replicas too — total');
    assert.strictEqual(derived.indexingDelta, 6000, 'indexing is counted per primary');
});

test('deriveIndices treats a reindexed index as a reset rather than a negative rate', () => {
    const previous = parsers.parseIndexStats(fx.indexStats({ queryTotal: 40000 }));
    const previousByName = Object.fromEntries(previous.map((i) => [i.index, i]));

    // The index was deleted and recreated: document count collapsed.
    const current = parsers.parseIndexStats(fx.indexStats({ queryTotal: 10 }));
    current[0].primaries.docs.count = 100;

    const [derived] = es.deriveIndices(current, previousByName, INTERVAL, null);
    assert.strictEqual(derived.searchDelta, 0);
    assert.ok(derived.searchesPerSecond === 0 || derived.searchesPerSecond === null);
});

test('deriveIndices merges the _cat basics for health and shard counts', () => {
    const current = parsers.parseIndexStats(fx.indexStats());
    const catByName = Object.fromEntries(
        parsers.parseCatIndices(fx.CAT_INDICES).map((i) => [i.index, i])
    );

    const [derived] = es.deriveIndices(current, null, INTERVAL, catByName);
    assert.strictEqual(derived.primaryShards, 3);
    assert.strictEqual(derived.replicas, 1);
    assert.strictEqual(derived.health, 'green');
});

// ── state isolation ───────────────────────────────────────────────────────────

test('resetState clears per-instance memory so tests do not leak into each other', () => {
    assert.doesNotThrow(() => es.resetState());
});
