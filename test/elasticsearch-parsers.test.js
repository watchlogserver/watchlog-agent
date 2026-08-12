// Parser tests for the Elasticsearch integration.
//
// The parsers are pure and total, so these run without a cluster. What they
// mostly guard is version drift: a 7.x response shape, a JVM that names its
// collectors differently, a field Elasticsearch removed, and a permission gap
// that returns nothing at all.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const p = require('../app/integrations/elasticsearch/parsers');
const fx = require('./fixtures/elasticsearch-responses');

// ── numeric helpers ───────────────────────────────────────────────────────────

test('num coerces, nullableNum preserves the absence of a value', () => {
    assert.strictEqual(p.num('42'), 42);
    assert.strictEqual(p.num(undefined), 0);
    assert.strictEqual(p.num('not a number'), 0);

    assert.strictEqual(p.nullableNum(0), 0);
    assert.strictEqual(p.nullableNum(undefined), null);
    assert.strictEqual(p.nullableNum(null), null);
    assert.strictEqual(p.nullableNum(''), null);
    assert.strictEqual(p.nullableNum('x'), null);
});

test('counterDelta survives a restart and a shard relocating away', () => {
    assert.strictEqual(p.counterDelta(120, 100, false), 20);

    // First scrape: nothing to diff against.
    assert.strictEqual(p.counterDelta(120, null, false), 0);
    assert.strictEqual(p.counterDelta(120, undefined, false), 0);

    // Restart flag set explicitly.
    assert.strictEqual(p.counterDelta(5, 100, true), 0);

    // Counter went backwards without a flag — a shard relocated off this node,
    // taking its share of the counter with it. Never a negative delta.
    assert.strictEqual(p.counterDelta(5, 100, false), 0);
});

test('meanLatency is null with no operations, never a fabricated zero', () => {
    assert.strictEqual(p.meanLatency(500, 100), 5);
    assert.strictEqual(p.meanLatency(0, 0), null);
    assert.strictEqual(p.meanLatency(500, 0), null);
});

test('percentage and hitRate return null rather than inventing a denominator', () => {
    assert.strictEqual(p.percentage(50, 200), 25);
    assert.strictEqual(p.percentage(50, 0), null);
    assert.strictEqual(p.percentage(50, null), null);

    assert.strictEqual(p.hitRate(90, 10), 90);
    assert.strictEqual(p.hitRate(0, 0), null);
});

test('perSecond is null when the interval is unknown', () => {
    assert.strictEqual(p.perSecond(60, 60), 1);
    assert.strictEqual(p.perSecond(60, 0), null);
});

// ── version ───────────────────────────────────────────────────────────────────

test('parseRootInfo makes 8.9 and 8.17 comparable in the right order', () => {
    const v8 = p.parseRootInfo(fx.ROOT_INFO_8);
    assert.strictEqual(v8.version, '8.17.3');
    assert.strictEqual(v8.versionMajor, 8);
    assert.strictEqual(v8.versionMinor, 17);
    assert.strictEqual(v8.clusterUuid, 'AErlpT99Q_qZpfd65JLhzg');
    assert.strictEqual(v8.distribution, 'elasticsearch');

    const older = p.parseRootInfo({ version: { number: '8.9.0' } });
    assert.ok(v8.versionNum > older.versionNum, '8.17 must rank above 8.9');
});

test('parseRootInfo recognises OpenSearch rather than reading it as ancient ES', () => {
    const os = p.parseRootInfo(fx.ROOT_INFO_OPENSEARCH);
    assert.strictEqual(os.distribution, 'opensearch');
    assert.strictEqual(os.versionMajor, 2);
});

test('parseRootInfo is total on a garbage response', () => {
    assert.doesNotThrow(() => p.parseRootInfo(null));
    assert.strictEqual(p.parseRootInfo({}).version, '');
    assert.strictEqual(p.parseRootInfo(undefined).versionNum, 0);
});

test('atLeast gates version-specific capabilities', () => {
    const v7 = p.parseRootInfo(fx.ROOT_INFO_7);
    const v8 = p.parseRootInfo(fx.ROOT_INFO_8);
    const v9 = p.parseRootInfo(fx.ROOT_INFO_9);

    assert.strictEqual(p.atLeast(v7, 7, 9), true);
    assert.strictEqual(p.atLeast(v7, 8), false);
    assert.strictEqual(p.atLeast(v8, 8), true);
    assert.strictEqual(p.atLeast(v9, 8), true);
    assert.strictEqual(p.atLeast(null, 7), false);
});

// ── cluster health ────────────────────────────────────────────────────────────

test('parseClusterHealth reads every field and normalises status', () => {
    const h = p.parseClusterHealth(fx.CLUSTER_HEALTH_RED);
    assert.strictEqual(h.status, 'red');
    assert.strictEqual(h.statusCode, 2);
    assert.strictEqual(h.numberOfNodes, 3);
    assert.strictEqual(h.unassignedShards, 6);
    assert.strictEqual(h.unassignedPrimaryShards, 2);
    assert.strictEqual(h.relocatingShards, 2);
    assert.strictEqual(h.taskMaxWaitingInQueueMillis, 12000);
    assert.strictEqual(h.activeShardsPercentAsNumber, 91.76);
});

test('parseClusterHealth leaves unassignedPrimaryShards null on 7.x', () => {
    // The field does not exist before 8.x. Guessing zero would claim every
    // primary is assigned on a cluster that might be red.
    const h = p.parseClusterHealth(fx.CLUSTER_HEALTH_YELLOW_7X);
    assert.strictEqual(h.unassignedPrimaryShards, null);
    assert.strictEqual(h.status, 'yellow');
    assert.strictEqual(h.statusCode, 1);
});

test('parseClusterHealth normalises an unknown status rather than passing it through', () => {
    const h = p.parseClusterHealth({ status: 'purple' });
    assert.strictEqual(h.status, 'unknown');
    assert.strictEqual(h.statusCode, 3);
});

// ── cluster stats ─────────────────────────────────────────────────────────────

test('parseClusterStats keeps per-role counts without double-counting tiers', () => {
    const s = p.parseClusterStats(fx.CLUSTER_STATS_8);

    assert.strictEqual(s.nodes.total, 3);
    // Three nodes each hold data_content AND data_hot. Summing the tiers would
    // report six data nodes; the role counts are reported as-is instead.
    assert.strictEqual(s.nodes.roleCounts.data_hot, 3);
    assert.strictEqual(s.nodes.roleCounts.data_content, 3);
    assert.strictEqual(s.nodes.master, 3);

    assert.strictEqual(s.indices.count, 240);
    assert.strictEqual(s.indices.docsCount, 1500000000);
    assert.strictEqual(s.indices.shardsTotal, 480);
    assert.strictEqual(s.indices.shardsReplication, 1.0);
    assert.ok(Math.abs(s.jvm.heapUsedPercentage - 50) < 0.001);
});

test('parseClusterStats is total on an empty response', () => {
    assert.doesNotThrow(() => p.parseClusterStats(null));
    assert.strictEqual(p.parseClusterStats({}).indices.count, 0);
});

// ── node stats ────────────────────────────────────────────────────────────────

test('parseNodesStats reads an 8.x node completely', () => {
    const [node] = p.parseNodesStats(fx.nodeStats8());

    assert.strictEqual(node.nodeId, 'node-a');
    assert.strictEqual(node.name, 'es-data-01');
    assert.strictEqual(node.isDataNode, true);
    assert.strictEqual(node.isMasterEligible, true);
    assert.deepStrictEqual(node.tiers, ['data_content', 'data_hot']);

    assert.strictEqual(node.jvm.heapUsedPercent, 62);
    assert.strictEqual(node.jvm.threadCount, 120);
    assert.strictEqual(node.os.load1m, 3.5);
    assert.strictEqual(node.os.swapUsedPercentage, 0);
    assert.strictEqual(node.process.openFileDescriptors, 1200);
    assert.ok(node.process.fileDescriptorUsagePercentage > 1.8);

    assert.strictEqual(node.indices.search.queryTotal, 100000);
    assert.strictEqual(node.indices.indexing.indexFailed, 4);
    assert.strictEqual(node.indices.translog.uncommittedOperations, 2000);
    assert.strictEqual(node.indices.bulk.totalOperations, 12000);

    assert.strictEqual(node.fs.paths.length, 1);
    assert.ok(node.fs.usagePercentage > 69 && node.fs.usagePercentage < 71);
});

test('parseNodesStats handles a 7.x node with different GC names and no bulk stats', () => {
    const [node] = p.parseNodesStats(fx.NODE_STATS_7X);

    assert.strictEqual(node.name, 'es7-data-01');
    assert.strictEqual(node.isDataNode, true, 'the classic `data` role must still count');
    assert.deepStrictEqual(node.tiers, [], 'a 7.x node without tiers has none, not a fabricated one');

    // CMS collector names.
    assert.ok('ParNew' in node.jvm.gc);
    assert.ok('ConcurrentMarkSweep' in node.jvm.gc);

    // Node-level bulk stats arrived in 8.0.
    assert.strictEqual(node.indices.bulk, null);

    // Load average is simply absent on this platform.
    assert.strictEqual(node.os.load1m, null);
    assert.strictEqual(node.os.load5m, null);

    // Segment memory still reported on 7.x.
    assert.strictEqual(node.indices.segments.termsMemoryBytes, 41943040);

    // Two data paths.
    assert.strictEqual(node.fs.paths.length, 2);
});

test('parseNodesStats leaves disk usage null on a node with no data path', () => {
    const [node] = p.parseNodesStats(fx.NODE_STATS_COORDINATING);
    assert.strictEqual(node.fs.usagePercentage, null,
        'a coordinating node has no data path — that is not 0% disk usage');
    assert.strictEqual(node.fs.paths.length, 0);
    assert.strictEqual(node.isDataNode, false);
});

test('parseNodesHeader reports partial responses instead of hiding them', () => {
    const header = p.parseNodesHeader(fx.NODE_STATS_7X);
    assert.strictEqual(header.total, 2);
    assert.strictEqual(header.successful, 1);
    assert.strictEqual(header.failed, 1);
    assert.match(header.failureReasons[0], /did not respond/);
});

test('parseBreakers computes usage and leaves it null without a limit', () => {
    const [node] = p.parseNodesStats(fx.nodeStats8({ parentTripped: 7 }));
    assert.strictEqual(node.breakers.parent.tripped, 7);
    assert.ok(node.breakers.parent.usagePercentage > 60);

    const noLimit = p.parseBreakers({ parent: { estimated_size_in_bytes: 100, limit_size_in_bytes: 0 } });
    assert.strictEqual(noLimit.parent.usagePercentage, null);
});

test('parseThreadPools keeps every pool the node reported', () => {
    const [node] = p.parseNodesStats(fx.nodeStats8());
    assert.ok('search' in node.threadPools);
    assert.ok('azure_event_loop' in node.threadPools,
        'the parser keeps everything; filtering is the collector’s decision');
    assert.strictEqual(node.threadPools.search.threads, 13);
});

// ── indices ───────────────────────────────────────────────────────────────────

test('parseCatIndices flags system indices and derives the deleted ratio', () => {
    const rows = p.parseCatIndices(fx.CAT_INDICES);
    assert.strictEqual(rows.length, 3);

    const orders = rows.find((r) => r.index === 'orders-2026.08.12');
    assert.strictEqual(orders.primaryShards, 3);
    assert.strictEqual(orders.replicas, 1);
    assert.strictEqual(orders.storeSizeBytes, 80000000000);
    assert.strictEqual(orders.system, false);
    // 1.5M deleted of 5.5M total.
    assert.ok(Math.abs(orders.deletedPercentage - 27.27) < 0.1);

    assert.strictEqual(rows.find((r) => r.index === '.kibana_8.17.3_001').system, true);
});

test('parseCatIndices returns null deleted ratio for an empty index', () => {
    const [row] = p.parseCatIndices([{ index: 'empty', 'docs.count': '0', 'docs.deleted': '0' }]);
    assert.strictEqual(row.deletedPercentage, null,
        '0 of 0 is "no documents", not "no deleted documents"');
});

test('parseIndexStats separates primaries from total', () => {
    const [entry] = p.parseIndexStats(fx.indexStats());
    assert.strictEqual(entry.index, 'orders-2026.08.12');
    assert.strictEqual(entry.health, 'green');
    // The fixture makes `total` exactly double `primaries`, which is what a
    // one-replica index reports — reading indexing from `total` would double it.
    assert.strictEqual(entry.total.indexing.indexTotal, entry.primaries.indexing.indexTotal * 2);
});

test('parseAllIndicesStats reads the _all rollup', () => {
    const all = p.parseAllIndicesStats(fx.indexStats());
    assert.strictEqual(all.primaries.docs.count, 4000000);
    assert.strictEqual(all.total.docs.count, 8000000);
});

// ── shards ────────────────────────────────────────────────────────────────────

test('parseCatShards splits the relocation arrow out of the node column', () => {
    const shards = p.parseCatShards(fx.CAT_SHARDS);
    const relocating = shards.find((s) => s.state === 'RELOCATING');

    assert.strictEqual(relocating.node, 'es-data-01');
    assert.strictEqual(relocating.relocatingNode, 'es-warm-01',
        '_cat/shards has no relocation column — it is embedded in `node`');
});

test('parseCatShards keeps the unassigned reason verbatim', () => {
    const shards = p.parseCatShards(fx.CAT_SHARDS);
    const failed = shards.find((s) => s.state === 'UNASSIGNED' && s.primary);

    assert.strictEqual(failed.unassignedReason, 'ALLOCATION_FAILED');
    assert.strictEqual(failed.unassignedFor, '2.4h');
    assert.match(failed.unassignedDetails, /failed shard on node/);
    // Not reported for an unassigned shard, and not invented as zero.
    assert.strictEqual(failed.docs, null);
    assert.strictEqual(failed.storeBytes, null);
});

test('summariseShards counts states and separates unassigned primaries', () => {
    const summary = p.summariseShards(p.parseCatShards(fx.CAT_SHARDS));

    assert.strictEqual(summary.total, 6);
    assert.strictEqual(summary.primaries, 4);
    assert.strictEqual(summary.replicas, 2);
    assert.strictEqual(summary.started, 2);
    assert.strictEqual(summary.relocating, 1);
    assert.strictEqual(summary.initializing, 1);
    assert.strictEqual(summary.unassigned, 2);
    assert.strictEqual(summary.unassignedPrimaries, 1);
    assert.strictEqual(summary.unassignedReplicas, 1);
    assert.strictEqual(summary.indicesWithUnassigned.length, 2);
});

test('summariseShards reports no imbalance on a single node', () => {
    const single = p.summariseShards([
        { index: 'a', shard: 0, primary: true, state: 'STARTED', node: 'n1', storeBytes: 10 },
        { index: 'a', shard: 1, primary: true, state: 'STARTED', node: 'n1', storeBytes: 10 }
    ]);
    assert.strictEqual(single.imbalancePercentage, null,
        'one node cannot be imbalanced against itself');
});

test('summariseShards measures imbalance across nodes', () => {
    const rows = [];
    for (let i = 0; i < 10; i++) rows.push({ index: 'a', shard: i, primary: true, state: 'STARTED', node: 'hot', storeBytes: 1 });
    for (let i = 0; i < 2; i++) rows.push({ index: 'a', shard: 100 + i, primary: true, state: 'STARTED', node: 'cold', storeBytes: 1 });

    const summary = p.summariseShards(rows);
    assert.strictEqual(summary.maxShardsOnNode, 10);
    assert.strictEqual(summary.minShardsOnNode, 2);
    assert.ok(summary.imbalancePercentage > 0);
});

test('summariseShards is total on empty input', () => {
    const summary = p.summariseShards(null);
    assert.strictEqual(summary.total, 0);
    assert.strictEqual(summary.imbalancePercentage, null);
});

// ── cluster management ────────────────────────────────────────────────────────

test('parsePendingTasks ranks priority and finds the oldest wait', () => {
    const pending = p.parsePendingTasks(fx.PENDING_TASKS);
    assert.strictEqual(pending.count, 3);
    assert.strictEqual(pending.oldestTimeInQueueMillis, 45000);
    assert.strictEqual(pending.highPriorityCount, 2, 'URGENT and HIGH count, NORMAL does not');
    assert.strictEqual(pending.executingCount, 1);
});

test('parseRecovery derives progress from bytes', () => {
    const [entry] = p.parseRecovery(fx.RECOVERY);
    assert.strictEqual(entry.index, 'orders-2026.08.12');
    assert.strictEqual(entry.shard, 1);
    assert.strictEqual(entry.sourceNode, 'es-data-01');
    assert.strictEqual(entry.targetNode, 'es-warm-01');
    assert.strictEqual(entry.stage, 'INDEX');
    assert.strictEqual(entry.bytesPercent, 50);
    assert.strictEqual(entry.progressPercentage, 50);
});

test('parseTasks keeps long-running work and drops routine traffic', () => {
    const tasks = p.parseTasks(fx.TASKS);

    assert.strictEqual(tasks.length, 1, 'only the reindex qualifies');
    assert.strictEqual(tasks[0].action, 'indices:data/write/reindex');
    assert.strictEqual(tasks[0].runningTimeMillis, 900000);
    assert.strictEqual(tasks[0].cancellable, true);
    assert.strictEqual(tasks[0].status.total, 4000000);
});

test('parseTasks reads the grouped-by-node response shape too', () => {
    const grouped = {
        nodes: {
            'node-a': {
                tasks: {
                    'node-a:1': {
                        node: 'node-a', id: 1, action: 'indices:data/write/update/byquery',
                        description: 'update-by-query', running_time_in_nanos: 60000000000,
                        cancellable: true
                    }
                }
            }
        }
    };
    const tasks = p.parseTasks(grouped);
    assert.strictEqual(tasks.length, 1);
    assert.strictEqual(tasks[0].action, 'indices:data/write/update/byquery');
});

// ── disk watermarks ───────────────────────────────────────────────────────────

test('parseWatermarkValue understands percentages, ratios and sizes', () => {
    assert.deepStrictEqual(p.parseWatermarkValue('85%'), { type: 'percentage', percentage: 85, raw: '85%' });
    assert.deepStrictEqual(p.parseWatermarkValue('0.9'), { type: 'percentage', percentage: 90, raw: '0.9' });

    const size = p.parseWatermarkValue('100gb');
    assert.strictEqual(size.type, 'bytes');
    assert.strictEqual(size.freeBytes, 100 * 1024 ** 3);

    assert.strictEqual(p.parseWatermarkValue(''), null);
    assert.strictEqual(p.parseWatermarkValue(null), null);
});

test('parseDiskWatermarks prefers persistent settings over defaults', () => {
    const defaults = p.parseDiskWatermarks(fx.CLUSTER_SETTINGS_DEFAULT);
    assert.strictEqual(defaults.available, true);
    assert.strictEqual(defaults.high.percentage, 90);
    assert.strictEqual(defaults.thresholdEnabled, true);

    const custom = p.parseDiskWatermarks(fx.CLUSTER_SETTINGS_CUSTOM);
    assert.strictEqual(custom.high.type, 'bytes');
    assert.strictEqual(custom.high.freeBytes, 100 * 1024 ** 3);
});

test('parseDiskWatermarks reports unavailability rather than guessing', () => {
    const none = p.parseDiskWatermarks({});
    assert.strictEqual(none.available, false);
    assert.strictEqual(none.low, null);
});

test('evaluateWatermark compares against the configured thresholds', () => {
    const watermarks = p.parseDiskWatermarks(fx.CLUSTER_SETTINGS_DEFAULT);

    const ok = p.evaluateWatermark(
        { totalBytes: 1000, availableBytes: 500, usagePercentage: 50 }, watermarks
    );
    assert.strictEqual(ok.level, 'ok');
    assert.strictEqual(ok.marginToLow, 35);

    const high = p.evaluateWatermark(
        { totalBytes: 1000, availableBytes: 80, usagePercentage: 92 }, watermarks
    );
    assert.strictEqual(high.level, 'high');

    const flood = p.evaluateWatermark(
        { totalBytes: 1000, availableBytes: 20, usagePercentage: 98 }, watermarks
    );
    assert.strictEqual(flood.level, 'flood_stage');
});

test('evaluateWatermark handles byte-based watermarks', () => {
    const watermarks = p.parseDiskWatermarks(fx.CLUSTER_SETTINGS_CUSTOM);

    // 150 GB free: above the 100 GB high watermark, below the 200 GB low one.
    const between = p.evaluateWatermark(
        { totalBytes: 1024 ** 4, availableBytes: 150 * 1024 ** 3, usagePercentage: 85 },
        watermarks
    );
    assert.strictEqual(between.level, 'low');
});

test('evaluateWatermark returns null when there is nothing to judge', () => {
    assert.strictEqual(p.evaluateWatermark(null, null), null);
    assert.strictEqual(
        p.evaluateWatermark({ totalBytes: 0 }, p.parseDiskWatermarks(fx.CLUSTER_SETTINGS_DEFAULT)),
        null
    );
});

// ── allocation explain ────────────────────────────────────────────────────────

test('parseAllocationExplain picks the most specific blocking decider', () => {
    const explain = p.parseAllocationExplain(fx.ALLOCATION_EXPLAIN_DISK);

    assert.strictEqual(explain.index, 'orders-2026.08.12');
    assert.strictEqual(explain.shard, 2);
    assert.strictEqual(explain.primary, true);
    assert.strictEqual(explain.canAllocate, 'no');
    assert.strictEqual(explain.failedAllocationAttempts, 5);

    // disk_threshold outranks same_shard: it explains more.
    assert.strictEqual(explain.primaryDecider, 'disk_threshold');
    assert.match(explain.recommendation, /disk watermark/i);
    assert.strictEqual(explain.nodes.length, 2);
});

test('parseAllocationExplain falls back to the raw explanation for an unknown decider', () => {
    const explain = p.parseAllocationExplain({
        index: 'x', shard: 0, primary: false,
        allocate_explanation: 'something specific happened',
        node_allocation_decisions: [
            { node_id: 'n', node_name: 'n', node_decision: 'no', deciders: [{ decider: 'brand_new_decider', decision: 'NO', explanation: 'nope' }] }
        ]
    });
    assert.strictEqual(explain.primaryDecider, 'brand_new_decider');
    assert.strictEqual(explain.recommendation, 'something specific happened');
});

test('parseAllocationExplain is total on an empty body', () => {
    assert.doesNotThrow(() => p.parseAllocationExplain(null));
    assert.ok(p.parseAllocationExplain({}).recommendation.length > 0);
});

// ── hot threads ───────────────────────────────────────────────────────────────

test('parseHotThreads groups threads by node and bounds the stack', () => {
    const nodes = p.parseHotThreads(fx.HOT_THREADS_TEXT);

    assert.strictEqual(nodes.length, 2);
    assert.strictEqual(nodes[0].nodeName, 'es-data-01');
    assert.strictEqual(nodes[0].nodeId, 'node-a');
    assert.strictEqual(nodes[0].threads.length, 2);

    const hottest = nodes[0].threads[0];
    assert.strictEqual(hottest.percentage, 61.4);
    assert.strictEqual(hottest.type, 'CPU');
    assert.match(hottest.thread, /\[search\]\[T#3\]/);
    assert.match(hottest.snapshots, /10\/10 snapshots/);
    assert.ok(hottest.stack.length > 0);

    // A BLOCK-type entry on the second node.
    assert.strictEqual(nodes[1].threads[0].type, 'BLOCK');
});

test('parseHotThreads is total on empty or non-report text', () => {
    assert.deepStrictEqual(p.parseHotThreads(''), []);
    assert.deepStrictEqual(p.parseHotThreads(null), []);
    assert.deepStrictEqual(p.parseHotThreads('some unrelated text'), []);
});

// ── optional features ─────────────────────────────────────────────────────────

test('parseDataStreams reads backing indices and generation', () => {
    const [stream] = p.parseDataStreams(fx.DATA_STREAMS);
    assert.strictEqual(stream.name, 'logs-app-default');
    assert.strictEqual(stream.generation, 2);
    assert.strictEqual(stream.backingIndexCount, 2);
    assert.strictEqual(stream.status, 'green');
});

test('parseDataStreams is total when the API does not exist', () => {
    assert.deepStrictEqual(p.parseDataStreams(null), []);
    assert.deepStrictEqual(p.parseDataStreams({}), []);
});

test('parseSlowlogSettings does not count a disabled threshold as configured', () => {
    const settings = p.parseSlowlogSettings(fx.SLOWLOG_SETTINGS);

    assert.strictEqual(settings.searchSlowlogConfigured, true);
    assert.strictEqual(settings.indexingSlowlogConfigured, true);
    assert.deepStrictEqual(settings.searchSlowlogIndices, ['orders-2026.08.12']);
    assert.ok(!settings.searchSlowlogIndices.includes('logs-2026.08.12'),
        'a threshold of -1 means slow logging is off for that index');
});

test('parseSlowlogSettings reports nothing configured on an empty response', () => {
    const settings = p.parseSlowlogSettings({});
    assert.strictEqual(settings.searchSlowlogConfigured, false);
    assert.strictEqual(settings.indexingSlowlogConfigured, false);
});

// ── topology ──────────────────────────────────────────────────────────────────

test('parseNodesInfo classifies roles, tiers and coordinating-only nodes', () => {
    const nodes = p.parseNodesInfo(fx.NODES_INFO);
    assert.strictEqual(nodes.length, 3);

    const hot = nodes.find((n) => n.name === 'es-data-01');
    assert.strictEqual(hot.isDataNode, true);
    assert.strictEqual(hot.isMasterEligible, true);
    assert.deepStrictEqual(hot.tiers, ['data_content', 'data_hot']);
    assert.strictEqual(hot.attributes.zone, 'eu-west-1a');

    const warm = nodes.find((n) => n.name === 'es-warm-01');
    assert.deepStrictEqual(warm.tiers, ['data_warm']);
    assert.strictEqual(warm.isMasterEligible, false);

    const coord = nodes.find((n) => n.name === 'es-coord-01');
    assert.strictEqual(coord.isDataNode, false);
    assert.strictEqual(coord.isCoordinatingOnly, true);
});

test('parseCatMaster identifies the elected master', () => {
    const master = p.parseCatMaster(fx.CAT_MASTER);
    assert.strictEqual(master.nodeId, 'node-a');
    assert.strictEqual(master.name, 'es-data-01');
    assert.strictEqual(p.parseCatMaster([]), null);
    assert.strictEqual(p.parseCatMaster(null), null);
});
