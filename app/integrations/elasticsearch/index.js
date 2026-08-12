// Elasticsearch advanced collector.
//
// Shaped like the MongoDB, Redis, MySQL and PostgreSQL advanced collectors:
// one entry point that connects, probes what this cluster and this user can
// actually provide, runs each section inside a wrapper that turns a failure into
// a capability gap rather than an exception, derives interval deltas from the
// previous scrape, and returns a bounded payload.
//
// Elasticsearch-specific design notes:
//
//   * The agent needs one reachable endpoint. Everything else — nodes, roles,
//     tiers, indices, shards — is discovered from the cluster itself, so a
//     ten-node cluster is configured exactly like a single-node one.
//
//   * Not every API runs every minute. Cluster health and node stats are the
//     fast path; index and shard listings are throttled; recovery, topology,
//     tasks and cluster settings are slower still; allocation explain and hot
//     threads are on demand. `GET /_cluster/state` is never called at all — it
//     is the classic way to knock over a large cluster with monitoring.
//
//   * Every request is a GET, except the one POST that Cluster Allocation
//     Explain requires. client.js refuses any other method, so this integration
//     structurally cannot delete an index, reroute a shard, cancel a task,
//     force-merge, clear a cache or change a setting.
//
//   * Counters reset in two ways here. A node restart zeroes that node's
//     counters, detected by its JVM uptime going backwards. A shard relocating
//     off a node takes its share of that node's index/search counters with it,
//     which looks like a partial reset — handled the same way, by reporting no
//     delta rather than a negative one.

'use strict';

const { ElasticsearchClient, ElasticsearchRequestError } = require('./client');
const parsers = require('./parsers');
const slowlog = require('./slowlog');

const SCHEMA_VERSION = 1;

const DEFAULTS = {
    requestTimeoutMs: 15000,

    // Section throttles, in seconds. The fast path (cluster health, node stats,
    // pending tasks) runs on every tick with no throttle.
    indexIntervalSeconds: 300,
    shardIntervalSeconds: 300,
    clusterStatsIntervalSeconds: 300,
    metadataIntervalSeconds: 900,
    recoveryIntervalSeconds: 300,
    taskIntervalSeconds: 600,
    capabilityIntervalSeconds: 900,
    allocationExplainIntervalSeconds: 300,

    // Payload ceilings. A cluster with 40 000 indices must not be able to make
    // the agent build a 200 MB payload.
    maxIndices: 200,
    maxIndicesPerPayload: 200,
    maxIndexDetail: 200,
    maxShards: 2000,
    maxUnassignedShards: 200,
    maxNodes: 200,
    maxTasks: 100,
    maxRecovery: 200,
    maxDataStreams: 200,
    maxAllocationExplanations: 10,

    // How long a slow node stats call is allowed to hold the whole cycle.
    nodeStatsTimeoutMs: 30000,
    heavyRequestTimeoutMs: 30000,

    // A search averaging above this is "slow" for the purposes of the health
    // score, so the agent, the API and the UI cannot disagree.
    slowSearchThresholdMs: 500,
    slowIndexingThresholdMs: 500
};

// The node stats metrics Watchlog reads. Requesting them explicitly rather than
// taking the default keeps `ingest`, `script`, `discovery`, `adaptive_selection`
// and `indices` sub-shards out of the response.
const NODE_STATS_METRICS = 'indices,os,process,jvm,thread_pool,fs,transport,http,breaker';

// _cat columns. Requested explicitly so the response stays small and stable
// across versions rather than whatever the default column set happens to be.
const CAT_INDICES_COLUMNS =
    'health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size';
// `_cat/shards` rejects `expand_wildcards` (unlike `_cat/indices`), and it has
// no relocation column — a relocating shard reports "source -> target" inside
// `node`, which parseCatShards splits back apart.
const CAT_SHARDS_COLUMNS =
    'index,shard,prirep,state,docs,store,id,ip,node,unassigned.reason,unassigned.at,unassigned.for,unassigned.details';

// Disk watermarks, read from the cluster's own settings rather than hardcoded.
//
// `include_defaults` is essential: watermarks are rarely set explicitly, so
// without it the response is empty on most clusters. `flat_settings` keeps the
// keys as literal dotted strings — which is why filter_path has to escape those
// dots, since it otherwise reads them as path separators and matches nothing.
const DISK_SETTINGS_PATH =
    '/_cluster/settings?include_defaults=true&flat_settings=true&filter_path=' +
    encodeURIComponent('*.cluster\\.routing\\.allocation\\.disk*');

// Pools the UI highlights and the health score judges. Every other pool is still
// collected — this list only decides emphasis.
const CRITICAL_THREAD_POOLS = ['search', 'write', 'get', 'management', 'search_throttled', 'system_write', 'system_read'];

// Per-instance memory: previous counters for deltas, throttle clocks, caches.
const state = new Map();

function instanceState(id) {
    if (!state.has(id)) {
        state.set(id, {
            previous: null,
            lastIndexAt: 0,
            lastShardAt: 0,
            lastClusterStatsAt: 0,
            lastMetadataAt: 0,
            lastRecoveryAt: 0,
            lastTaskAt: 0,
            lastCapabilityAt: 0,
            lastAllocationExplainAt: 0,
            capabilities: null,
            metadata: null,
            watermarks: null,
            allocationExplanations: [],
            shardCountsByNode: {},
            lastMasterNodeId: null,
            masterChanges: 0
        });
    }
    return state.get(id);
}

/** Exposed for tests so restart/reset scenarios run deterministically. */
function resetState() {
    state.clear();
    slowlog.resetTailState();
}

// ── configuration ─────────────────────────────────────────────────────────────

/**
 * Reads the elasticsearch entry from integration.json and fills in defaults.
 *
 * Credentials are copied straight through to the client and never stored on the
 * returned object beyond what the client needs — nothing downstream of
 * `collect()` ever sees them.
 */
function normalizeConfig(integrate = {}) {
    const advanced = integrate.advanced || {};
    const tls = integrate.tls && typeof integrate.tls === 'object' ? integrate.tls : {};

    const protocol = String(
        integrate.protocol || (integrate.ssl === true || tls.enabled === true ? 'https' : 'http')
    ).replace(':', '').toLowerCase();

    // A CA can be given inline as PEM or as a path on the agent's host.
    let ca = null;
    const caValue = tls.ca || integrate.ca || integrate.caCert;
    if (caValue) {
        const raw = String(caValue);
        if (raw.includes('-----BEGIN')) {
            ca = raw;
        } else {
            try {
                ca = require('fs').readFileSync(raw, 'utf8');
            } catch (err) {
                // Reported as a capability note by the caller rather than
                // failing the whole integration: TLS may still verify against
                // the system trust store.
                ca = null;
            }
        }
    }

    return {
        url: integrate.url || '',
        protocol: protocol === 'https' ? 'https' : 'http',
        host: integrate.host || '127.0.0.1',
        port: Number(integrate.port || 9200),

        username: integrate.username || '',
        password: integrate.password || '',
        apiKey: integrate.apiKey || integrate.api_key || '',

        // Verification stays on unless explicitly disabled. `verifyCertificate`
        // is the field the setup UI writes; `rejectUnauthorized` is accepted as
        // the node-native spelling.
        rejectUnauthorized: !(
            integrate.verifyCertificate === false ||
            tls.verifyCertificate === false ||
            integrate.rejectUnauthorized === false ||
            tls.rejectUnauthorized === false
        ),
        ca,
        caConfigured: !!caValue,
        caLoaded: !!ca,
        servername: tls.servername || integrate.servername || '',

        requestTimeoutMs: Number(integrate.requestTimeoutMs || advanced.requestTimeoutMs || DEFAULTS.requestTimeoutMs),

        enabled: advanced.enabled !== false,
        indices: advanced.indices !== false,
        shards: advanced.shards !== false,
        clusterStats: advanced.clusterStats !== false,
        pendingTasks: advanced.pendingTasks !== false,
        recovery: advanced.recovery !== false,
        tasks: advanced.tasks !== false,
        dataStreams: advanced.dataStreams !== false,
        allocationExplain: advanced.allocationExplain !== false,

        maxIndices: Number(advanced.maxIndices || DEFAULTS.maxIndices),
        maxIndicesPerPayload: Number(advanced.maxIndicesPerPayload || DEFAULTS.maxIndicesPerPayload),
        maxShards: Number(advanced.maxShards || DEFAULTS.maxShards),
        maxNodes: Number(advanced.maxNodes || DEFAULTS.maxNodes),

        indexIntervalSeconds: Number(advanced.indexIntervalSeconds || DEFAULTS.indexIntervalSeconds),
        shardIntervalSeconds: Number(advanced.shardIntervalSeconds || DEFAULTS.shardIntervalSeconds),
        clusterStatsIntervalSeconds: Number(advanced.clusterStatsIntervalSeconds || DEFAULTS.clusterStatsIntervalSeconds),
        metadataIntervalSeconds: Number(advanced.metadataIntervalSeconds || DEFAULTS.metadataIntervalSeconds),
        recoveryIntervalSeconds: Number(advanced.recoveryIntervalSeconds || DEFAULTS.recoveryIntervalSeconds),
        taskIntervalSeconds: Number(advanced.taskIntervalSeconds || DEFAULTS.taskIntervalSeconds),

        slowSearchThresholdMs: Number(advanced.slowSearchThresholdMs || DEFAULTS.slowSearchThresholdMs),
        slowIndexingThresholdMs: Number(advanced.slowIndexingThresholdMs || DEFAULTS.slowIndexingThresholdMs),

        slowlog: slowlog.normalizeSlowlogConfig(integrate.slowlog || {})
    };
}

// ── request wrapper ───────────────────────────────────────────────────────────

/**
 * Runs one API call, converting a failure into a recorded capability gap.
 *
 * A monitoring user without `manage` cannot read `_cluster/settings`, a 7.x
 * cluster has no `_data_stream`, and a security-hardened deployment may block
 * `_nodes/hot_threads`. Each of those degrades exactly one section.
 */
async function tryRequest(client, path, errors, scope, opts = {}) {
    try {
        return await client.request(path, opts);
    } catch (err) {
        if (errors) {
            errors.push({
                scope,
                kind: err instanceof ElasticsearchRequestError ? err.kind : 'request_failed',
                // Credential-free by construction — see client.describeError().
                message: String(err.message || '').slice(0, 200)
            });
        }
        return null;
    }
}

// ── capability probing ────────────────────────────────────────────────────────

/**
 * Establishes what this cluster and this user can actually provide.
 *
 * Probes are the cheapest possible form of each call — `size=0`, one row, one
 * index — because this runs on a throttle but still runs against production.
 */
async function probeCapabilities(client, version, config, errors) {
    const capabilities = {
        clusterHealth: false,
        clusterStats: false,
        nodeStats: false,
        nodesInfo: false,
        indexStats: false,
        shards: false,
        pendingTasks: false,
        allocationExplain: false,
        recovery: false,
        tasks: false,
        diskWatermarks: false,
        dataStreams: false,
        hotThreads: false,
        searchSlowlog: false,
        indexingSlowlog: false,
        // Elasticsearch 7.x–9.x exposes no request/query log distinct from the
        // search slow log, and Watchlog does not read audit logs. Represented
        // separately so the UI can say so rather than implying a missing feature.
        queryLogging: false,
        bulkStats: parsers.atLeast(version, 8),
        segmentMemory: false
    };

    const notes = [];

    capabilities.clusterHealth = (await tryRequest(
        client, '/_cluster/health?timeout=10s', errors, 'capability:cluster_health'
    )) !== null;

    capabilities.nodeStats = (await tryRequest(
        client, '/_nodes/stats/jvm?timeout=10s', errors, 'capability:node_stats'
    )) !== null;

    capabilities.nodesInfo = (await tryRequest(
        client, '/_nodes?filter_path=nodes.*.name&timeout=10s', errors, 'capability:nodes_info'
    )) !== null;

    if (config.clusterStats) {
        capabilities.clusterStats = (await tryRequest(
            client, '/_cluster/stats?timeout=15s&filter_path=cluster_name', errors, 'capability:cluster_stats'
        )) !== null;
    }

    if (config.indices) {
        capabilities.indexStats = (await tryRequest(
            client, '/_cat/indices?format=json&h=index&s=index&size=1', errors, 'capability:cat_indices'
        )) !== null;
    }

    if (config.shards) {
        capabilities.shards = (await tryRequest(
            client, '/_cat/shards?format=json&h=index&s=index', errors, 'capability:cat_shards'
        )) !== null;
    }

    if (config.pendingTasks) {
        capabilities.pendingTasks = (await tryRequest(
            client, '/_cluster/pending_tasks', errors, 'capability:pending_tasks'
        )) !== null;
    }

    if (config.recovery) {
        capabilities.recovery = (await tryRequest(
            client, '/_recovery?active_only=true', errors, 'capability:recovery'
        )) !== null;
    }

    if (config.tasks) {
        capabilities.tasks = (await tryRequest(
            client, '/_tasks?actions=*reindex&detailed=false&group_by=none', errors, 'capability:tasks'
        )) !== null;
    }

    const settings = await tryRequest(
        client, DISK_SETTINGS_PATH, errors, 'capability:cluster_settings'
    );
    capabilities.diskWatermarks = !!(settings && parsers.parseDiskWatermarks(settings).available);

    // 7.9+, and absent on some licences even then.
    if (config.dataStreams && parsers.atLeast(version, 7, 9)) {
        capabilities.dataStreams = (await tryRequest(
            client, '/_data_stream?expand_wildcards=open', errors, 'capability:data_streams'
        )) !== null;
    }

    // Allocation explain answers 400 when nothing is unassigned, which proves
    // the endpoint and the privilege are both there.
    if (config.allocationExplain) {
        try {
            await client.request('/_cluster/allocation/explain', { method: 'POST', body: {} });
            capabilities.allocationExplain = true;
        } catch (err) {
            const kind = err instanceof ElasticsearchRequestError ? err.kind : '';
            capabilities.allocationExplain = kind === 'request_failed' && err.statusCode === 400;
            if (!capabilities.allocationExplain) {
                errors.push({ scope: 'capability:allocation_explain', kind, message: String(err.message).slice(0, 200) });
            }
        }
    }

    // Hot threads answers text/plain, so it is fetched raw. The probe uses the
    // shortest sampling interval the API accepts — proving the privilege exists
    // must not itself cost half a second of thread sampling on every node.
    capabilities.hotThreads = (await tryRequest(
        client, '/_nodes/hot_threads?threads=1&interval=10ms&snapshots=1',
        errors, 'capability:hot_threads', { raw: true }
    )) !== null;

    // Whether an index slow log is configured anywhere. Watchlog never changes
    // these — it only reports whether the operator turned them on.
    const slowlogSettings = await tryRequest(
        client,
        '/*/_settings/index.search.slowlog.threshold.*,index.indexing.slowlog.threshold.*' +
        '?flat_settings=true&expand_wildcards=open&ignore_unavailable=true',
        errors, 'capability:slowlog_settings'
    );
    if (slowlogSettings) {
        const parsed = parsers.parseSlowlogSettings(slowlogSettings);
        capabilities.searchSlowlog = parsed.searchSlowlogConfigured;
        capabilities.indexingSlowlog = parsed.indexingSlowlogConfigured;
        capabilities.slowlogIndexCount = parsed.configuredIndexCount;
    }

    if (!config.slowlog.enabled) {
        notes.push('Slow operation collection is disabled in the Watchlog integration configuration.');
    } else if (!capabilities.searchSlowlog && !capabilities.indexingSlowlog) {
        notes.push('No index has a search or indexing slowlog threshold configured. Watchlog never enables slow logging — set index.search.slowlog.threshold.query.* on the indices you want traced.');
    }

    if (config.caConfigured && !config.caLoaded) {
        notes.push('The configured CA certificate could not be read; TLS is being verified against the system trust store instead.');
    }
    if (!config.rejectUnauthorized && config.protocol === 'https') {
        notes.push('TLS certificate verification is disabled for this endpoint.');
    }

    return { capabilities, notes };
}

// ── derivation ────────────────────────────────────────────────────────────────

/** Interval rates for one node's JVM garbage collectors. */
function deriveGc(current, previous, reset, intervalSeconds) {
    const collectors = {};
    let totalCountDelta = 0;
    let totalTimeDelta = 0;

    for (const [name, entry] of Object.entries(current || {})) {
        const prev = previous ? previous[name] : null;
        const countDelta = parsers.counterDelta(entry.collectionCount, prev && prev.collectionCount, reset);
        const timeDelta = parsers.counterDelta(entry.collectionTimeMillis, prev && prev.collectionTimeMillis, reset);

        totalCountDelta += countDelta;
        totalTimeDelta += timeDelta;

        collectors[name] = {
            collectionCount: entry.collectionCount,
            collectionTimeMillis: entry.collectionTimeMillis,
            countDelta,
            timeDelta,
            collectionsPerSecond: parsers.perSecond(countDelta, intervalSeconds),
            // Mean pause length. Null with no collections — not zero, which
            // would read as "GC completed instantly".
            averagePauseMillis: parsers.meanLatency(timeDelta, countDelta)
        };
    }

    // Share of wall-clock time this node spent collecting. This is the figure
    // that actually matters: 200 collections costing 2ms each is healthy, while
    // 4 costing 900ms each is not.
    const gcTimePercentage = intervalSeconds > 0
        ? (totalTimeDelta / (intervalSeconds * 1000)) * 100
        : null;

    // Old-generation collections are the expensive ones. Collector names differ
    // per JVM and per JDK — Elasticsearch reports `young`/`old` on G1, but a
    // newer JDK also reports `G1 Concurrent GC`, and ZGC and Shenandoah use
    // their own names entirely — so they are matched by substring rather than
    // enumerated.
    const oldKeys = Object.keys(collectors).filter(
        (k) => /old|marksweep|mark_sweep|concurrent|zgc|shenandoah|global/i.test(k)
    );
    const youngKeys = Object.keys(collectors).filter((k) => !oldKeys.includes(k));

    const sum = (keys, field) => keys.reduce((acc, key) => acc + parsers.num(collectors[key][field]), 0);

    return {
        collectors,
        totalCountDelta,
        totalTimeDelta,
        gcTimePercentage,
        youngCountDelta: sum(youngKeys, 'countDelta'),
        youngTimeDelta: sum(youngKeys, 'timeDelta'),
        oldCountDelta: sum(oldKeys, 'countDelta'),
        oldTimeDelta: sum(oldKeys, 'timeDelta'),
        collectionsPerSecond: parsers.perSecond(totalCountDelta, intervalSeconds)
    };
}

/** Interval rates for one node's thread pools. */
function deriveThreadPools(current, previous, reset, intervalSeconds) {
    const pools = [];

    for (const [name, entry] of Object.entries(current || {})) {
        const prev = previous ? previous[name] : null;
        const rejectedDelta = parsers.counterDelta(entry.rejected, prev && prev.rejected, reset);
        const completedDelta = parsers.counterDelta(entry.completed, prev && prev.completed, reset);

        pools.push({
            pool: name,
            threads: entry.threads,
            queue: entry.queue,
            active: entry.active,
            largest: entry.largest,
            rejected: entry.rejected,
            completed: entry.completed,
            rejectedDelta,
            completedDelta,
            completedPerSecond: parsers.perSecond(completedDelta, intervalSeconds),
            // Saturation is "every thread busy", not "some threads busy". Null
            // on a pool that reports no threads (a scaling pool at rest).
            saturationPercentage: parsers.percentage(entry.active, entry.threads),
            critical: CRITICAL_THREAD_POOLS.includes(name),
            // A queue on a saturated pool is the shape that precedes rejections.
            saturated: entry.threads > 0 && entry.active >= entry.threads && entry.queue > 0
        });
    }

    // Elasticsearch 8 reports around forty thread pools per node, most of them
    // permanently at zero (azure_event_loop, repository_azure, …). Carrying all
    // of them would put forty InfluxDB series per node behind charts that never
    // move, so a pool is kept when it is one of the ones an operator judges the
    // cluster by, or when it actually did something.
    const interesting = pools.filter((p) =>
        p.critical || p.threads > 0 || p.queue > 0 || p.active > 0 ||
        p.rejected > 0 || p.completedDelta > 0
    );

    return interesting.sort((a, b) => (b.rejectedDelta - a.rejectedDelta) || (b.queue - a.queue));
}

/** Interval deltas for one node's circuit breakers. */
function deriveBreakers(current, previous, reset) {
    const breakers = [];

    for (const [name, entry] of Object.entries(current || {})) {
        const prev = previous ? previous[name] : null;
        breakers.push({
            breaker: name,
            estimatedBytes: entry.estimatedBytes,
            limitBytes: entry.limitBytes,
            overhead: entry.overhead,
            tripped: entry.tripped,
            // A trip during the interval is a real, user-visible rejection. The
            // lifetime count is not — it may be years old.
            trippedDelta: parsers.counterDelta(entry.tripped, prev && prev.tripped, reset),
            usagePercentage: entry.usagePercentage
        });
    }

    return breakers.sort((a, b) => (b.trippedDelta - a.trippedDelta) || ((b.usagePercentage || 0) - (a.usagePercentage || 0)));
}

/**
 * Rates and latencies for the `indices` section of a node or an index.
 *
 * Shared by both because Elasticsearch reports the same structure at both
 * levels — which means a fix to how indexing latency is derived applies
 * everywhere at once.
 */
function deriveIndicesRates(current, previous, reset, intervalSeconds) {
    const d = (path, field) => parsers.counterDelta(
        current[path][field],
        previous ? previous[path][field] : null,
        reset
    );

    const indexTotalDelta = d('indexing', 'indexTotal');
    const indexTimeDelta = d('indexing', 'indexTimeMillis');
    const deleteTotalDelta = d('indexing', 'deleteTotal');
    const deleteTimeDelta = d('indexing', 'deleteTimeMillis');
    const indexFailedDelta = d('indexing', 'indexFailed');
    const throttleTimeDelta = d('indexing', 'throttleTimeMillis');

    const queryTotalDelta = d('search', 'queryTotal');
    const queryTimeDelta = d('search', 'queryTimeMillis');
    const fetchTotalDelta = d('search', 'fetchTotal');
    const fetchTimeDelta = d('search', 'fetchTimeMillis');
    const scrollTotalDelta = d('search', 'scrollTotal');
    const scrollTimeDelta = d('search', 'scrollTimeMillis');
    const suggestTotalDelta = d('search', 'suggestTotal');
    const suggestTimeDelta = d('search', 'suggestTimeMillis');

    const getTotalDelta = d('get', 'total');
    const getTimeDelta = d('get', 'timeMillis');
    const getExistsDelta = d('get', 'existsTotal');
    const getMissingDelta = d('get', 'missingTotal');

    const queryCacheHitDelta = d('queryCache', 'hitCount');
    const queryCacheMissDelta = d('queryCache', 'missCount');
    const queryCacheEvictionDelta = d('queryCache', 'evictions');

    const requestCacheHitDelta = d('requestCache', 'hitCount');
    const requestCacheMissDelta = d('requestCache', 'missCount');
    const requestCacheEvictionDelta = d('requestCache', 'evictions');

    const fielddataEvictionDelta = d('fielddata', 'evictions');

    const mergeTotalDelta = d('merges', 'total');
    const mergeTimeDelta = d('merges', 'totalTimeMillis');
    const mergeDocsDelta = d('merges', 'totalDocs');
    const mergeSizeDelta = d('merges', 'totalSizeBytes');
    const mergeThrottledDelta = d('merges', 'totalThrottledTimeMillis');
    const mergeStoppedDelta = d('merges', 'totalStoppedTimeMillis');

    const refreshTotalDelta = d('refresh', 'total');
    const refreshTimeDelta = d('refresh', 'totalTimeMillis');

    const flushTotalDelta = d('flush', 'total');
    const flushTimeDelta = d('flush', 'totalTimeMillis');
    const flushPeriodicDelta = d('flush', 'periodic');

    return {
        indexing: {
            operationsDelta: indexTotalDelta,
            operationsPerSecond: parsers.perSecond(indexTotalDelta, intervalSeconds),
            timeDelta: indexTimeDelta,
            // Null when nothing was indexed. A fabricated 0 ms would look like
            // the fastest cluster in the world on an idle system.
            averageLatencyMs: parsers.meanLatency(indexTimeDelta, indexTotalDelta),
            current: current.indexing.indexCurrent,
            failedDelta: indexFailedDelta,
            failuresPerSecond: parsers.perSecond(indexFailedDelta, intervalSeconds),
            failureRatePercentage: parsers.percentage(indexFailedDelta, indexTotalDelta),
            deletesDelta: deleteTotalDelta,
            deletesPerSecond: parsers.perSecond(deleteTotalDelta, intervalSeconds),
            averageDeleteLatencyMs: parsers.meanLatency(deleteTimeDelta, deleteTotalDelta),
            noopUpdateDelta: d('indexing', 'noopUpdateTotal'),
            throttleTimeDelta,
            // Share of the interval the shard spent throttled by merge pressure.
            throttlePercentage: intervalSeconds > 0
                ? (throttleTimeDelta / (intervalSeconds * 1000)) * 100 : null,
            isThrottled: current.indexing.isThrottled
        },

        search: {
            queryDelta: queryTotalDelta,
            queriesPerSecond: parsers.perSecond(queryTotalDelta, intervalSeconds),
            queryTimeDelta,
            averageQueryLatencyMs: parsers.meanLatency(queryTimeDelta, queryTotalDelta),
            queryCurrent: current.search.queryCurrent,
            fetchDelta: fetchTotalDelta,
            fetchesPerSecond: parsers.perSecond(fetchTotalDelta, intervalSeconds),
            averageFetchLatencyMs: parsers.meanLatency(fetchTimeDelta, fetchTotalDelta),
            fetchCurrent: current.search.fetchCurrent,
            scrollDelta: scrollTotalDelta,
            averageScrollLatencyMs: parsers.meanLatency(scrollTimeDelta, scrollTotalDelta),
            scrollCurrent: current.search.scrollCurrent,
            suggestDelta: suggestTotalDelta,
            averageSuggestLatencyMs: parsers.meanLatency(suggestTimeDelta, suggestTotalDelta),
            openContexts: current.search.openContexts
        },

        get: {
            totalDelta: getTotalDelta,
            getsPerSecond: parsers.perSecond(getTotalDelta, intervalSeconds),
            averageLatencyMs: parsers.meanLatency(getTimeDelta, getTotalDelta),
            current: current.get.current,
            existsDelta: getExistsDelta,
            missingDelta: getMissingDelta,
            // Share of GETs that found nothing. Null with no GETs at all.
            missingPercentage: parsers.percentage(getMissingDelta, getTotalDelta)
        },

        queryCache: {
            memoryBytes: current.queryCache.memoryBytes,
            cacheSize: current.queryCache.cacheSize,
            cacheCount: current.queryCache.cacheCount,
            hitDelta: queryCacheHitDelta,
            missDelta: queryCacheMissDelta,
            evictionDelta: queryCacheEvictionDelta,
            // Interval hit rate, not the lifetime one — a cluster up for months
            // reports a lifetime ratio that cannot move.
            hitRate: parsers.hitRate(queryCacheHitDelta, queryCacheMissDelta)
        },

        requestCache: {
            memoryBytes: current.requestCache.memoryBytes,
            hitDelta: requestCacheHitDelta,
            missDelta: requestCacheMissDelta,
            evictionDelta: requestCacheEvictionDelta,
            hitRate: parsers.hitRate(requestCacheHitDelta, requestCacheMissDelta)
        },

        fielddata: {
            memoryBytes: current.fielddata.memoryBytes,
            evictionDelta: fielddataEvictionDelta
        },

        segments: current.segments,

        merges: {
            current: current.merges.current,
            currentDocs: current.merges.currentDocs,
            currentSizeBytes: current.merges.currentSizeBytes,
            totalDelta: mergeTotalDelta,
            mergesPerSecond: parsers.perSecond(mergeTotalDelta, intervalSeconds),
            timeDelta: mergeTimeDelta,
            averageMergeTimeMs: parsers.meanLatency(mergeTimeDelta, mergeTotalDelta),
            docsDelta: mergeDocsDelta,
            sizeDelta: mergeSizeDelta,
            throughputBytesPerSecond: parsers.perSecond(mergeSizeDelta, intervalSeconds),
            throttledTimeDelta: mergeThrottledDelta,
            stoppedTimeDelta: mergeStoppedDelta,
            autoThrottleBytes: current.merges.totalAutoThrottleBytes,
            // Share of merge time spent throttled — the signal that indexing is
            // outrunning what the disk can merge.
            throttlePercentage: parsers.percentage(mergeThrottledDelta, mergeTimeDelta)
        },

        refresh: {
            totalDelta: refreshTotalDelta,
            refreshesPerSecond: parsers.perSecond(refreshTotalDelta, intervalSeconds),
            timeDelta: refreshTimeDelta,
            averageRefreshTimeMs: parsers.meanLatency(refreshTimeDelta, refreshTotalDelta),
            listeners: current.refresh.listeners
        },

        flush: {
            totalDelta: flushTotalDelta,
            flushesPerSecond: parsers.perSecond(flushTotalDelta, intervalSeconds),
            periodicDelta: flushPeriodicDelta,
            timeDelta: flushTimeDelta,
            averageFlushTimeMs: parsers.meanLatency(flushTimeDelta, flushTotalDelta)
        },

        translog: current.translog,
        docs: current.docs,
        store: current.store,
        bulk: current.bulk
    };
}

/**
 * Full per-node derivation.
 *
 * `reset` is decided per node: JVM uptime going backwards is that node
 * restarting, which zeroes every counter it owns while its neighbours keep
 * climbing.
 */
function deriveNodes(nodes, previousByNode, intervalSeconds, watermarks, shardCountsByNode) {
    return nodes.map((node) => {
        const previous = previousByNode ? previousByNode[node.nodeId] : null;
        const restarted = !!(previous && node.jvm.uptimeMillis < previous.jvm.uptimeMillis);
        const reset = restarted || !previous;

        const cpuTotalDelta = parsers.counterDelta(
            node.process.cpuTotalMillis, previous && previous.process.cpuTotalMillis, reset
        );

        return {
            nodeId: node.nodeId,
            name: node.name,
            host: node.host,
            ip: node.ip,
            transportAddress: node.transportAddress,
            roles: node.roles,
            tiers: node.tiers,
            isDataNode: node.isDataNode,
            isMasterEligible: node.isMasterEligible,
            restarted,

            jvm: {
                uptimeMillis: node.jvm.uptimeMillis,
                uptimeSeconds: Math.floor(node.jvm.uptimeMillis / 1000),
                heapUsedBytes: node.jvm.heapUsedBytes,
                heapUsedPercent: node.jvm.heapUsedPercent,
                heapCommittedBytes: node.jvm.heapCommittedBytes,
                heapMaxBytes: node.jvm.heapMaxBytes,
                nonHeapUsedBytes: node.jvm.nonHeapUsedBytes,
                nonHeapCommittedBytes: node.jvm.nonHeapCommittedBytes,
                threadCount: node.jvm.threadCount,
                threadPeakCount: node.jvm.threadPeakCount
            },

            gc: deriveGc(node.jvm.gc, previous && previous.jvm.gc, reset, intervalSeconds),

            os: node.os,

            process: Object.assign({}, node.process, {
                cpuTotalDelta,
                // Process CPU as a share of one core over the interval; the
                // instantaneous `cpuPercent` is a single sample and jitters.
                intervalCpuPercentage: intervalSeconds > 0
                    ? (cpuTotalDelta / (intervalSeconds * 1000)) * 100 : null
            }),

            fs: node.fs,
            // Compared against the cluster's own configured watermarks, not a
            // hardcoded threshold — a cluster that moved flood stage to 97%
            // should not be warned at 90%.
            watermark: parsers.evaluateWatermark(node.fs, watermarks),

            indices: deriveIndicesRates(
                node.indices, previous ? previous.indices : null, reset, intervalSeconds
            ),

            threadPools: deriveThreadPools(
                node.threadPools, previous && previous.threadPools, reset, intervalSeconds
            ),
            breakers: deriveBreakers(node.breakers, previous && previous.breakers, reset),

            transport: node.transport,
            http: node.http,

            // Carried over between shard scrapes so a node card never blanks out
            // on the ticks where shards were not re-listed.
            shardCount: parsers.num(shardCountsByNode && shardCountsByNode[node.name])
        };
    });
}

/**
 * Cross-node comparison.
 *
 * Median rather than mean: on a cluster where one node is pathological, the
 * mean moves toward it and hides exactly the imbalance being looked for.
 */
function compareNodes(nodes) {
    const dataNodes = nodes.filter((n) => n.isDataNode);
    if (dataNodes.length < 2) {
        return { comparable: false, nodeCount: dataNodes.length, dimensions: [] };
    }

    const median = (values) => {
        const sorted = values.filter((v) => v !== null && v !== undefined).sort((a, b) => a - b);
        if (!sorted.length) return null;
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const dimension = (key, label, extract, unit) => {
        const values = dataNodes.map((n) => ({ node: n.name, value: extract(n) }))
            .filter((v) => v.value !== null && v.value !== undefined && Number.isFinite(v.value));
        if (values.length < 2) return null;

        const med = median(values.map((v) => v.value));
        const highest = values.reduce((a, b) => (b.value > a.value ? b : a));
        const lowest = values.reduce((a, b) => (b.value < a.value ? b : a));

        return {
            key,
            label,
            unit,
            median: med,
            highest,
            lowest,
            // How far above the median the busiest node sits. Null when the
            // median is zero — an idle cluster is not "infinitely imbalanced".
            deviationPercentage: med > 0 ? ((highest.value - med) / med) * 100 : null,
            values: values.sort((a, b) => b.value - a.value)
        };
    };

    const dimensions = [
        dimension('cpu', 'CPU', (n) => n.os.cpuPercent, '%'),
        dimension('heap', 'JVM heap', (n) => n.jvm.heapUsedPercent, '%'),
        dimension('disk', 'Disk usage', (n) => (n.fs ? n.fs.usagePercentage : null), '%'),
        dimension('search', 'Search rate', (n) => n.indices.search.queriesPerSecond, '/s'),
        dimension('indexing', 'Indexing rate', (n) => n.indices.indexing.operationsPerSecond, '/s'),
        dimension('shards', 'Shards', (n) => n.shardCount, '')
    ].filter(Boolean);

    return { comparable: true, nodeCount: dataNodes.length, dimensions };
}

/** Cluster-wide totals, summed across the nodes that answered. */
function summariseNodes(nodes, intervalSeconds) {
    const totals = {
        searchesPerSecond: 0,
        indexingPerSecond: 0,
        queryTimeDelta: 0,
        queryDelta: 0,
        fetchTimeDelta: 0,
        fetchDelta: 0,
        indexTimeDelta: 0,
        indexDelta: 0,
        indexFailedDelta: 0,
        getDelta: 0,
        getTimeDelta: 0,
        rejectedDelta: 0,
        searchRejectedDelta: 0,
        writeRejectedDelta: 0,
        breakerTripsDelta: 0,
        queryCacheHitDelta: 0,
        queryCacheMissDelta: 0,
        requestCacheHitDelta: 0,
        requestCacheMissDelta: 0,
        fielddataMemoryBytes: 0,
        segmentCount: 0,
        mergeCurrent: 0,
        translogUncommittedBytes: 0,
        heapUsedBytes: 0,
        heapMaxBytes: 0,
        diskTotalBytes: 0,
        diskAvailableBytes: 0,
        gcTimeDelta: 0,
        nodesAtLowWatermark: 0,
        nodesAtHighWatermark: 0,
        nodesAtFloodStage: 0,
        nodesSwapping: 0
    };

    let maxHeapPercent = null;
    let maxCpuPercent = null;
    let maxDiskPercent = null;

    for (const node of nodes) {
        const idx = node.indices;

        totals.queryDelta += parsers.num(idx.search.queryDelta);
        totals.queryTimeDelta += parsers.num(idx.search.queryTimeDelta);
        totals.fetchDelta += parsers.num(idx.search.fetchDelta);
        totals.fetchTimeDelta += parsers.num(idx.search.fetchTimeDelta);
        totals.indexDelta += parsers.num(idx.indexing.operationsDelta);
        totals.indexTimeDelta += parsers.num(idx.indexing.timeDelta);
        totals.indexFailedDelta += parsers.num(idx.indexing.failedDelta);
        totals.getDelta += parsers.num(idx.get.totalDelta);
        totals.getTimeDelta += parsers.num(idx.get.averageLatencyMs) * parsers.num(idx.get.totalDelta);

        totals.queryCacheHitDelta += parsers.num(idx.queryCache.hitDelta);
        totals.queryCacheMissDelta += parsers.num(idx.queryCache.missDelta);
        totals.requestCacheHitDelta += parsers.num(idx.requestCache.hitDelta);
        totals.requestCacheMissDelta += parsers.num(idx.requestCache.missDelta);
        totals.fielddataMemoryBytes += parsers.num(idx.fielddata.memoryBytes);
        totals.segmentCount += parsers.num(idx.segments.count);
        totals.mergeCurrent += parsers.num(idx.merges.current);
        totals.translogUncommittedBytes += parsers.num(idx.translog.uncommittedSizeBytes);

        totals.heapUsedBytes += parsers.num(node.jvm.heapUsedBytes);
        totals.heapMaxBytes += parsers.num(node.jvm.heapMaxBytes);
        totals.gcTimeDelta += parsers.num(node.gc.totalTimeDelta);

        if (node.fs) {
            totals.diskTotalBytes += parsers.num(node.fs.totalBytes);
            totals.diskAvailableBytes += parsers.num(node.fs.availableBytes);
        }

        for (const pool of node.threadPools) {
            totals.rejectedDelta += pool.rejectedDelta;
            if (pool.pool === 'search') totals.searchRejectedDelta += pool.rejectedDelta;
            if (pool.pool === 'write' || pool.pool === 'bulk') totals.writeRejectedDelta += pool.rejectedDelta;
        }

        for (const breaker of node.breakers) totals.breakerTripsDelta += breaker.trippedDelta;

        if (node.jvm.heapUsedPercent !== null) {
            maxHeapPercent = maxHeapPercent === null
                ? node.jvm.heapUsedPercent : Math.max(maxHeapPercent, node.jvm.heapUsedPercent);
        }
        if (node.os.cpuPercent !== null) {
            maxCpuPercent = maxCpuPercent === null
                ? node.os.cpuPercent : Math.max(maxCpuPercent, node.os.cpuPercent);
        }
        if (node.fs && node.fs.usagePercentage !== null) {
            maxDiskPercent = maxDiskPercent === null
                ? node.fs.usagePercentage : Math.max(maxDiskPercent, node.fs.usagePercentage);
        }

        if (node.watermark) {
            if (node.watermark.level === 'flood_stage') totals.nodesAtFloodStage++;
            else if (node.watermark.level === 'high') totals.nodesAtHighWatermark++;
            else if (node.watermark.level === 'low') totals.nodesAtLowWatermark++;
        }

        // Elasticsearch documents swap as something to disable entirely; any
        // meaningful swap usage on a data node is worth surfacing.
        if (node.os.swapUsedPercentage !== null && node.os.swapUsedPercentage > 5) totals.nodesSwapping++;
    }

    totals.searchesPerSecond = parsers.perSecond(totals.queryDelta, intervalSeconds);
    totals.indexingPerSecond = parsers.perSecond(totals.indexDelta, intervalSeconds);
    totals.averageQueryLatencyMs = parsers.meanLatency(totals.queryTimeDelta, totals.queryDelta);
    totals.averageFetchLatencyMs = parsers.meanLatency(totals.fetchTimeDelta, totals.fetchDelta);
    totals.averageIndexingLatencyMs = parsers.meanLatency(totals.indexTimeDelta, totals.indexDelta);
    totals.averageGetLatencyMs = parsers.meanLatency(totals.getTimeDelta, totals.getDelta);
    totals.queryCacheHitRate = parsers.hitRate(totals.queryCacheHitDelta, totals.queryCacheMissDelta);
    totals.requestCacheHitRate = parsers.hitRate(totals.requestCacheHitDelta, totals.requestCacheMissDelta);
    totals.heapUsedPercentage = parsers.percentage(totals.heapUsedBytes, totals.heapMaxBytes);
    totals.diskUsedBytes = totals.diskTotalBytes - totals.diskAvailableBytes;
    totals.diskUsagePercentage = parsers.percentage(totals.diskUsedBytes, totals.diskTotalBytes);
    totals.indexingFailureRate = parsers.percentage(totals.indexFailedDelta, totals.indexDelta);
    totals.maxHeapPercent = maxHeapPercent;
    totals.maxCpuPercent = maxCpuPercent;
    totals.maxDiskPercent = maxDiskPercent;
    totals.gcTimePercentage = nodes.length && intervalSeconds > 0
        ? (totals.gcTimeDelta / (nodes.length * intervalSeconds * 1000)) * 100 : null;

    return totals;
}

/** Per-index derivation, using `primaries` for storage and `total` for traffic. */
function deriveIndices(current, previousByIndex, intervalSeconds, catByName) {
    return current.map((entry) => {
        const previous = previousByIndex ? previousByIndex[entry.index] : null;

        // An index whose primary document count dropped was reindexed, deleted
        // and recreated, or had its counters reset by a restore. Treat it as a
        // reset rather than reporting a negative rate.
        const reset = !previous ||
            entry.primaries.docs.count < previous.primaries.docs.count * 0.5;

        const rates = deriveIndicesRates(
            entry.total, previous ? previous.total : null, reset, intervalSeconds
        );
        const primaryRates = deriveIndicesRates(
            entry.primaries, previous ? previous.primaries : null, reset, intervalSeconds
        );

        const cat = catByName ? catByName[entry.index] : null;

        return {
            index: entry.index,
            uuid: entry.uuid || (cat ? cat.uuid : ''),
            health: entry.health || (cat ? cat.health : null),
            healthCode: entry.healthCode !== null && entry.healthCode !== undefined
                ? entry.healthCode
                : (cat ? cat.healthCode : null),
            status: entry.status || (cat ? cat.status : null),
            system: cat ? cat.system : entry.index.startsWith('.'),

            primaryShards: cat ? cat.primaryShards : null,
            replicas: cat ? cat.replicas : null,

            docsCount: entry.primaries.docs.count,
            docsDeleted: entry.primaries.docs.deleted,
            deletedPercentage: entry.primaries.docs.deletedPercentage,

            storeSizeBytes: entry.total.store.sizeBytes,
            primaryStoreSizeBytes: entry.primaries.store.sizeBytes,

            // Search runs on replicas too, so search traffic comes from `total`.
            searchesPerSecond: rates.search.queriesPerSecond,
            searchDelta: rates.search.queryDelta,
            averageQueryLatencyMs: rates.search.averageQueryLatencyMs,
            averageFetchLatencyMs: rates.search.averageFetchLatencyMs,
            queryCurrent: rates.search.queryCurrent,

            // Indexing is counted per primary: `total` double-counts every
            // replica, so a 1-replica index would appear to index twice.
            indexingPerSecond: primaryRates.indexing.operationsPerSecond,
            indexingDelta: primaryRates.indexing.operationsDelta,
            averageIndexingLatencyMs: primaryRates.indexing.averageLatencyMs,
            indexingFailedDelta: primaryRates.indexing.failedDelta,
            indexingThrottlePercentage: primaryRates.indexing.throttlePercentage,
            isThrottled: entry.total.indexing.isThrottled,

            getsPerSecond: rates.get.getsPerSecond,
            averageGetLatencyMs: rates.get.averageLatencyMs,

            segmentCount: entry.primaries.segments.count,
            segmentMemoryBytes: entry.primaries.segments.memoryBytes,

            mergeCurrent: entry.total.merges.current,
            mergesDelta: rates.merges.totalDelta,
            mergeTimeDelta: rates.merges.timeDelta,
            mergeThrottlePercentage: rates.merges.throttlePercentage,

            refreshDelta: rates.refresh.totalDelta,
            averageRefreshTimeMs: rates.refresh.averageRefreshTimeMs,
            flushDelta: rates.flush.totalDelta,
            averageFlushTimeMs: rates.flush.averageFlushTimeMs,

            translogOperations: entry.total.translog.operations,
            translogSizeBytes: entry.total.translog.sizeBytes,
            translogUncommittedOperations: entry.total.translog.uncommittedOperations,
            translogUncommittedSizeBytes: entry.total.translog.uncommittedSizeBytes,
            translogEarliestLastModifiedAge: entry.total.translog.earliestLastModifiedAge,

            queryCacheHitRate: rates.queryCache.hitRate,
            queryCacheMemoryBytes: rates.queryCache.memoryBytes,
            queryCacheEvictionDelta: rates.queryCache.evictionDelta,
            requestCacheHitRate: rates.requestCache.hitRate,
            requestCacheMemoryBytes: rates.requestCache.memoryBytes,
            requestCacheEvictionDelta: rates.requestCache.evictionDelta,
            fielddataMemoryBytes: rates.fielddata.memoryBytes,
            fielddataEvictionDelta: rates.fielddata.evictionDelta
        };
    });
}

// ── collection sections ───────────────────────────────────────────────────────

/**
 * Index metrics in two steps.
 *
 * `_cat/indices` is one small row per index and gives the full inventory
 * cheaply. Detailed `_stats` is then requested only for the indices worth
 * charting, which keeps the response bounded on a cluster with tens of
 * thousands of indices where a blanket `GET /_stats` would be measured in
 * hundreds of megabytes.
 */
async function collectIndices(client, config, errors) {
    const catRows = await tryRequest(
        client,
        `/_cat/indices?format=json&bytes=b&h=${CAT_INDICES_COLUMNS}&expand_wildcards=open&ignore_unavailable=true`,
        errors, 'cat_indices',
        { timeoutMs: DEFAULTS.heavyRequestTimeoutMs }
    );
    if (catRows === null) return null;

    const all = parsers.parseCatIndices(catRows);

    // Ranked by store size: the indices that dominate storage are the ones an
    // operator is looking for, and detailed stats for the other 39 800 would
    // not fit in a payload anyway.
    const ranked = all.slice().sort((a, b) => b.storeSizeBytes - a.storeSizeBytes);
    const selected = ranked.slice(0, Math.min(config.maxIndices, DEFAULTS.maxIndexDetail));

    const clusterTotals = await tryRequest(
        client, '/_stats?level=cluster', errors, 'index_stats_cluster',
        { timeoutMs: DEFAULTS.heavyRequestTimeoutMs }
    );

    let detailed = [];
    if (selected.length) {
        // Index names are URL-encoded individually: a name can contain '+' or
        // other characters that change meaning in a path.
        const names = selected.map((i) => encodeURIComponent(i.index)).join(',');
        const stats = await tryRequest(
            client,
            `/${names}/_stats?level=indices&ignore_unavailable=true&expand_wildcards=open`,
            errors, 'index_stats',
            { timeoutMs: DEFAULTS.heavyRequestTimeoutMs }
        );
        if (stats) detailed = parsers.parseIndexStats(stats);
    }

    return {
        all,
        detailed,
        totals: clusterTotals ? parsers.parseAllIndicesStats(clusterTotals) : null,
        totalIndexCount: all.length,
        detailedCount: detailed.length,
        truncated: all.length > selected.length
    };
}

/** `_cat/shards` plus the derived summary and unassigned listing. */
async function collectShards(client, config, errors) {
    const rows = await tryRequest(
        client,
        `/_cat/shards?format=json&bytes=b&h=${CAT_SHARDS_COLUMNS}`,
        errors, 'cat_shards',
        { timeoutMs: DEFAULTS.heavyRequestTimeoutMs }
    );
    if (rows === null) return null;

    const all = parsers.parseCatShards(rows);
    const summary = parsers.summariseShards(all);

    // Unassigned shards are always kept in full up to the cap — they are the
    // reason someone opens this tab. Assigned shards are the ones that get
    // truncated when a cluster is enormous.
    const unassigned = all.filter((s) => s.state === 'UNASSIGNED');
    const assigned = all.filter((s) => s.state !== 'UNASSIGNED');

    const cappedUnassigned = unassigned.slice(0, DEFAULTS.maxUnassignedShards);
    const remaining = Math.max(0, config.maxShards - cappedUnassigned.length);

    // Non-STARTED shards first: an initializing or relocating shard is what an
    // operator is watching, and a truncated listing must not drop it.
    const rankedAssigned = assigned.slice().sort((a, b) => {
        const rank = (s) => (s.state === 'STARTED' ? 1 : 0);
        return rank(a) - rank(b) || parsers.num(b.storeBytes) - parsers.num(a.storeBytes);
    });

    const shardCountsByNode = {};
    for (const entry of summary.perNode) shardCountsByNode[entry.node] = entry.total;

    return {
        summary,
        unassigned: cappedUnassigned,
        rows: cappedUnassigned.concat(rankedAssigned.slice(0, remaining)),
        shardCountsByNode,
        truncated: all.length > config.maxShards
    };
}

/**
 * Cluster Allocation Explain, for unassigned shards only.
 *
 * Never called on a schedule and never called when nothing is unassigned: it is
 * an expensive API, and the answer only changes when allocation changes. The
 * result is cached so opening the Shards tab reads a stored explanation rather
 * than hitting the cluster again.
 */
async function explainUnassignedShards(client, unassigned, errors) {
    const explanations = [];

    // Primaries first — an unassigned primary means data is unavailable, an
    // unassigned replica only means redundancy is lost.
    const ranked = unassigned.slice().sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0));

    // Coverage beats depth. A cluster with 200 unassigned shards usually has
    // two or three distinct causes, so explaining ten shards of the same index
    // for the same reason teaches nothing that explaining one does not.
    // Sampling across (reason, primary) groups means the budget is spent on
    // distinct causes, and get_metric can then attribute an explanation to the
    // other shards that share the group.
    const perGroup = new Map();
    const selected = [];

    for (const shard of ranked) {
        if (selected.length >= DEFAULTS.maxAllocationExplanations) break;
        const group = `${shard.unassignedReason || 'UNKNOWN'}|${shard.primary}`;
        const taken = perGroup.get(group) || 0;
        // An unassigned primary is always worth its own explanation; replicas
        // are sampled two per group.
        if (!shard.primary && taken >= 2) continue;
        perGroup.set(group, taken + 1);
        selected.push(shard);
    }

    for (const shard of selected) {
        try {
            const body = await client.request('/_cluster/allocation/explain', {
                method: 'POST',
                body: { index: shard.index, shard: shard.shard, primary: shard.primary }
            });
            explanations.push(parsers.parseAllocationExplain(body));
        } catch (err) {
            errors.push({
                scope: 'allocation_explain',
                kind: err.kind || 'request_failed',
                message: String(err.message || '').slice(0, 200)
            });
            // One shard failing to explain must not stop the rest.
        }
    }

    return explanations;
}

/** Topology, watermarks, data streams and the master node. */
async function collectMetadata(client, config, version, errors) {
    const [nodesInfo, master, settings, dataStreams] = await Promise.all([
        tryRequest(
            client,
            '/_nodes?filter_path=nodes.*.name,nodes.*.version,nodes.*.roles,nodes.*.host,' +
            'nodes.*.ip,nodes.*.transport_address,nodes.*.attributes,nodes.*.build_flavor',
            errors, 'nodes_info', { timeoutMs: DEFAULTS.heavyRequestTimeoutMs }
        ),
        tryRequest(client, '/_cat/master?format=json', errors, 'cat_master'),
        tryRequest(client, DISK_SETTINGS_PATH, errors, 'cluster_settings'),
        config.dataStreams && parsers.atLeast(version, 7, 9)
            ? tryRequest(client, '/_data_stream?expand_wildcards=open', errors, 'data_streams',
                { timeoutMs: DEFAULTS.heavyRequestTimeoutMs })
            : Promise.resolve(null)
    ]);

    return {
        nodes: nodesInfo ? parsers.parseNodesInfo(nodesInfo).slice(0, config.maxNodes) : [],
        master: master ? parsers.parseCatMaster(master) : null,
        watermarks: settings ? parsers.parseDiskWatermarks(settings) : null,
        dataStreams: dataStreams ? parsers.parseDataStreams(dataStreams).slice(0, DEFAULTS.maxDataStreams) : []
    };
}

// ── connection test ───────────────────────────────────────────────────────────

/**
 * Validates a configuration before it is saved.
 *
 * Answers four questions in order: is the endpoint reachable, does
 * authentication work, does the cluster respond, and what version is it. Every
 * error message is safe to show a user — no password, no API key, no URL with
 * embedded credentials.
 */
async function testConnection(integrate) {
    const config = normalizeConfig(integrate);
    const client = new ElasticsearchClient(config);
    const endpoint = client.describeEndpoint();

    try {
        const root = await client.request('/', { timeoutMs: config.requestTimeoutMs });
        const info = parsers.parseRootInfo(root);

        if (!info.version) {
            return {
                ok: false,
                endpoint,
                kind: 'unsupported_endpoint',
                message: 'The endpoint responded but did not identify itself as Elasticsearch.'
            };
        }

        // A reachable node is not the same as a readable cluster: a monitoring
        // user can authenticate and still lack `monitor` on the cluster.
        const errors = [];
        const health = await tryRequest(client, '/_cluster/health?timeout=10s', errors, 'cluster_health');

        if (!health) {
            return {
                ok: false,
                endpoint,
                kind: 'permission_denied',
                version: info.version,
                distribution: info.distribution,
                message: 'Connected and authenticated, but the cluster health API is not readable. The user needs the `monitor` cluster privilege.',
                details: errors
            };
        }

        const parsedHealth = parsers.parseClusterHealth(health);

        return {
            ok: true,
            endpoint,
            kind: 'ok',
            clusterName: info.clusterName || parsedHealth.clusterName,
            clusterUuid: info.clusterUuid,
            version: info.version,
            versionNum: info.versionNum,
            distribution: info.distribution,
            status: parsedHealth.status,
            nodes: parsedHealth.numberOfNodes,
            dataNodes: parsedHealth.numberOfDataNodes,
            authentication: config.apiKey ? 'api_key' : (config.username ? 'basic' : 'none'),
            tls: config.protocol === 'https',
            certificateVerification: config.protocol === 'https' ? config.rejectUnauthorized : null,
            message: `Connected to ${info.clusterName || 'the cluster'} (Elasticsearch ${info.version}), ${parsedHealth.numberOfNodes} node(s), status ${parsedHealth.status}.`
        };
    } catch (err) {
        return {
            ok: false,
            endpoint,
            kind: err instanceof ElasticsearchRequestError ? err.kind : 'request_failed',
            message: String(err.message || 'Connection failed').slice(0, 300)
        };
    } finally {
        client.destroy();
    }
}

/**
 * Hot Threads, on demand only.
 *
 * Deliberately not part of `collect()`: hot threads samples every thread on
 * every node for the configured interval, which is exactly the kind of call
 * that must never run on a timer.
 */
async function captureHotThreads(integrate, options = {}) {
    const config = normalizeConfig(integrate);
    const client = new ElasticsearchClient(config);

    const threads = Math.min(Math.max(Number(options.threads) || 3, 1), 10);
    const interval = /^\d+(ms|s)$/.test(String(options.interval)) ? String(options.interval) : '500ms';
    const type = ['cpu', 'wait', 'block'].includes(String(options.type)) ? String(options.type) : 'cpu';

    try {
        const text = await client.request(
            `/_nodes/hot_threads?threads=${threads}&interval=${interval}&type=${type}&snapshots=10`,
            { raw: true, timeoutMs: DEFAULTS.heavyRequestTimeoutMs }
        );

        return {
            ok: true,
            capturedAt: new Date().toISOString(),
            type: type.toUpperCase(),
            interval,
            nodes: parsers.parseHotThreads(text)
        };
    } catch (err) {
        return {
            ok: false,
            capturedAt: new Date().toISOString(),
            kind: err.kind || 'request_failed',
            message: String(err.message || '').slice(0, 300),
            nodes: []
        };
    } finally {
        client.destroy();
    }
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Collects Elasticsearch metrics.
 *
 * @param {object} integrate  the elasticsearch entry from integration.json
 * @param {function} callback (err, { advanced, batches })
 */
async function collect(integrate, callback) {
    const config = normalizeConfig(integrate);
    const client = new ElasticsearchClient(config);
    const origin = client.describeEndpoint();
    const now = Date.now();
    const errors = [];

    try {
        // ── identity ─────────────────────────────────────────────────────────
        const root = await client.request('/');
        const version = parsers.parseRootInfo(root);

        if (!version.version) {
            throw new ElasticsearchRequestError('unsupported_endpoint',
                'The endpoint did not identify itself as Elasticsearch');
        }

        // Cluster UUID is the stable identity: an endpoint can be re-pointed at
        // a different cluster, and a cluster can be reached through several
        // endpoints, but its UUID outlives both.
        const id = version.clusterUuid || `${client.host}:${client.port}`;
        const st = instanceState(id);

        const previous = st.previous;

        // ── capabilities ─────────────────────────────────────────────────────
        let capabilities = st.capabilities;
        let capabilityNotes = st.capabilityNotes || [];
        if (!capabilities || now - st.lastCapabilityAt >= DEFAULTS.capabilityIntervalSeconds * 1000) {
            const probed = await probeCapabilities(client, version, config, errors);
            capabilities = probed.capabilities;
            capabilityNotes = probed.notes;
            st.capabilities = capabilities;
            st.capabilityNotes = capabilityNotes;
            st.lastCapabilityAt = now;
        }

        // ── which sections run this tick ─────────────────────────────────────
        const due = (last, seconds) => now - last >= seconds * 1000;

        const collected = {
            cluster: capabilities.clusterHealth,
            nodes: capabilities.nodeStats,
            clusterStats: config.clusterStats && capabilities.clusterStats &&
                due(st.lastClusterStatsAt, config.clusterStatsIntervalSeconds),
            indices: config.indices && capabilities.indexStats &&
                due(st.lastIndexAt, config.indexIntervalSeconds),
            shards: config.shards && capabilities.shards &&
                due(st.lastShardAt, config.shardIntervalSeconds),
            pendingTasks: config.pendingTasks && capabilities.pendingTasks,
            recovery: config.recovery && capabilities.recovery &&
                due(st.lastRecoveryAt, config.recoveryIntervalSeconds),
            tasks: config.tasks && capabilities.tasks &&
                due(st.lastTaskAt, config.taskIntervalSeconds),
            metadata: due(st.lastMetadataAt, config.metadataIntervalSeconds),
            slowOperations: config.slowlog.enabled
        };

        // ── metadata (topology, watermarks, data streams, master) ────────────
        let metadata = st.metadata;
        if (collected.metadata) {
            const fetched = await collectMetadata(client, config, version, errors);
            // A metadata refresh that returned nothing keeps the previous
            // topology rather than blanking the Nodes tab.
            metadata = {
                nodes: fetched.nodes.length ? fetched.nodes : (metadata ? metadata.nodes : []),
                master: fetched.master || (metadata ? metadata.master : null),
                dataStreams: fetched.dataStreams
            };
            if (fetched.watermarks) st.watermarks = fetched.watermarks;
            st.metadata = metadata;
            st.lastMetadataAt = now;
        }
        const watermarks = st.watermarks;

        // Master identity changes are only reported when both the old and the
        // new master were actually observed — inventing an election from a
        // single missing sample would be worse than saying nothing.
        let masterChanged = false;
        if (metadata && metadata.master && metadata.master.nodeId) {
            if (st.lastMasterNodeId && st.lastMasterNodeId !== metadata.master.nodeId) {
                masterChanged = true;
                st.masterChanges++;
            }
            st.lastMasterNodeId = metadata.master.nodeId;
        }

        // ── fast path ────────────────────────────────────────────────────────
        const [healthBody, nodeStatsBody, pendingBody] = await Promise.all([
            collected.cluster
                ? tryRequest(client, '/_cluster/health?timeout=15s', errors, 'cluster_health')
                : Promise.resolve(null),
            collected.nodes
                ? tryRequest(client, `/_nodes/stats/${NODE_STATS_METRICS}?timeout=30s`, errors, 'node_stats',
                    { timeoutMs: DEFAULTS.nodeStatsTimeoutMs })
                : Promise.resolve(null),
            collected.pendingTasks
                ? tryRequest(client, '/_cluster/pending_tasks', errors, 'pending_tasks')
                : Promise.resolve(null)
        ]);

        if (!healthBody && !nodeStatsBody) {
            throw new ElasticsearchRequestError('no_data',
                'Neither cluster health nor node stats could be read');
        }

        const health = healthBody ? parsers.parseClusterHealth(healthBody) : null;
        const nodesHeader = nodeStatsBody ? parsers.parseNodesHeader(nodeStatsBody) : null;
        const rawNodes = nodeStatsBody ? parsers.parseNodesStats(nodeStatsBody) : [];
        const pendingTasks = pendingBody ? parsers.parsePendingTasks(pendingBody) : null;

        collected.cluster = !!health;
        collected.nodes = rawNodes.length > 0;
        collected.pendingTasks = !!pendingTasks;

        // ── interval ─────────────────────────────────────────────────────────
        // Derived from the elapsed wall clock between scrapes rather than a
        // configured 60s: a delayed tick would otherwise inflate every rate.
        const intervalSeconds = previous && previous.collectedAt
            ? Math.max(1, (now - previous.collectedAt) / 1000)
            : 0;

        // ── throttled sections ───────────────────────────────────────────────
        const [indexResult, shardResult, recoveryBody, taskBody, clusterStatsBody] = await Promise.all([
            collected.indices ? collectIndices(client, config, errors) : Promise.resolve(null),
            collected.shards ? collectShards(client, config, errors) : Promise.resolve(null),
            collected.recovery
                ? tryRequest(client, '/_recovery?active_only=true&detailed=false', errors, 'recovery',
                    { timeoutMs: DEFAULTS.heavyRequestTimeoutMs })
                : Promise.resolve(null),
            collected.tasks
                ? tryRequest(client, '/_tasks?detailed=true&group_by=none', errors, 'tasks',
                    { timeoutMs: DEFAULTS.heavyRequestTimeoutMs })
                : Promise.resolve(null),
            collected.clusterStats
                ? tryRequest(client, '/_cluster/stats?timeout=30s', errors, 'cluster_stats',
                    { timeoutMs: DEFAULTS.heavyRequestTimeoutMs })
                : Promise.resolve(null)
        ]);

        collected.indices = !!indexResult;
        collected.shards = !!shardResult;
        collected.recovery = !!recoveryBody;
        collected.tasks = !!taskBody;
        collected.clusterStats = !!clusterStatsBody;

        if (collected.indices) st.lastIndexAt = now;
        if (collected.shards) st.lastShardAt = now;
        if (collected.recovery) st.lastRecoveryAt = now;
        if (collected.tasks) st.lastTaskAt = now;
        if (collected.clusterStats) st.lastClusterStatsAt = now;

        const clusterStats = clusterStatsBody ? parsers.parseClusterStats(clusterStatsBody) : null;
        const recovery = recoveryBody
            ? parsers.parseRecovery(recoveryBody).slice(0, DEFAULTS.maxRecovery) : [];
        const tasks = taskBody
            ? parsers.parseTasks(taskBody, { limit: DEFAULTS.maxTasks }) : [];

        if (shardResult) st.shardCountsByNode = shardResult.shardCountsByNode;

        // ── allocation explain, only when something is unassigned ────────────
        let allocationExplanations = st.allocationExplanations;
        const unassigned = shardResult ? shardResult.unassigned : [];

        if (config.allocationExplain && capabilities.allocationExplain && unassigned.length) {
            if (due(st.lastAllocationExplainAt, DEFAULTS.allocationExplainIntervalSeconds)) {
                allocationExplanations = await explainUnassignedShards(client, unassigned, errors);
                st.allocationExplanations = allocationExplanations;
                st.lastAllocationExplainAt = now;
            }
        } else if (shardResult && !unassigned.length) {
            // Nothing unassigned any more — drop stale explanations rather than
            // showing an explanation for a shard that has since been allocated.
            allocationExplanations = [];
            st.allocationExplanations = [];
        }

        // ── derivation ───────────────────────────────────────────────────────
        const previousNodes = previous ? previous.nodesByIdRaw : null;
        const nodes = deriveNodes(
            rawNodes.slice(0, config.maxNodes), previousNodes, intervalSeconds,
            watermarks, st.shardCountsByNode
        );

        // Roles and version come from the topology refresh, which runs on a
        // slower clock than node stats; merging here keeps a node card complete
        // on every tick.
        if (metadata && metadata.nodes.length) {
            const infoById = new Map(metadata.nodes.map((n) => [n.nodeId, n]));
            for (const node of nodes) {
                const info = infoById.get(node.nodeId);
                if (!info) continue;
                node.version = info.version;
                node.buildFlavor = info.buildFlavor;
                node.attributes = info.attributes;
                if (!node.roles.length) node.roles = info.roles;
                if (!node.tiers.length) node.tiers = info.tiers;
            }
        }

        const nodeTotals = summariseNodes(nodes, intervalSeconds);
        const nodeComparison = compareNodes(nodes);

        const previousIndices = previous ? previous.indicesByName : null;
        const catByName = indexResult
            ? Object.fromEntries(indexResult.all.map((i) => [i.index, i]))
            : null;

        const indices = indexResult
            ? deriveIndices(indexResult.detailed, previousIndices, intervalSeconds, catByName)
            : [];

        // Indices with no detailed stats still carry their _cat basics, so the
        // Indices tab lists every index even when only the top N are charted.
        const detailedNames = new Set(indices.map((i) => i.index));
        const basicOnly = indexResult
            ? indexResult.all
                .filter((i) => !detailedNames.has(i.index))
                .slice(0, Math.max(0, config.maxIndices - indices.length))
                .map((i) => ({
                    index: i.index,
                    uuid: i.uuid,
                    health: i.health,
                    healthCode: i.healthCode,
                    status: i.status,
                    system: i.system,
                    primaryShards: i.primaryShards,
                    replicas: i.replicas,
                    docsCount: i.docsCount,
                    docsDeleted: i.docsDeleted,
                    deletedPercentage: i.deletedPercentage,
                    storeSizeBytes: i.storeSizeBytes,
                    primaryStoreSizeBytes: i.primaryStoreSizeBytes,
                    detailed: false
                }))
            : [];

        for (const index of indices) index.detailed = true;
        const allIndices = indices.concat(basicOnly);

        // ── slow operations ──────────────────────────────────────────────────
        const slowResult = collected.slowOperations
            ? slowlog.collectSlowOperations(config.slowlog)
            : { operations: [], files: { search: [], indexing: [] }, truncated: false, errors: [] };

        for (const error of slowResult.errors) errors.push(error);
        collected.slowOperations = collected.slowOperations && slowResult.operations.length > 0;

        // Slow log lines carry the node's own name for the cluster; stamp the
        // cluster identity so the stored event is attributable without it.
        for (const operation of slowResult.operations) {
            if (!operation.cluster) operation.cluster = version.clusterName;
        }

        // ── payload ──────────────────────────────────────────────────────────
        const clusterSection = {
            name: version.clusterName || (health ? health.clusterName : ''),
            uuid: version.clusterUuid,
            version: version.version,
            versionNum: version.versionNum,
            distribution: version.distribution,
            buildFlavor: version.buildFlavor,
            luceneVersion: version.luceneVersion,

            status: health ? health.status : 'unknown',
            statusCode: health ? health.statusCode : 3,
            timedOut: health ? health.timedOut : false,
            nodes: health ? health.numberOfNodes : nodes.length,
            dataNodes: health ? health.numberOfDataNodes : nodes.filter((n) => n.isDataNode).length,
            activePrimaryShards: health ? health.activePrimaryShards : null,
            activeShards: health ? health.activeShards : null,
            relocatingShards: health ? health.relocatingShards : null,
            initializingShards: health ? health.initializingShards : null,
            unassignedShards: health ? health.unassignedShards : null,
            // 8.x reports this directly; on 7.x it is counted from the shard
            // listing instead of being guessed at.
            unassignedPrimaryShards: health && health.unassignedPrimaryShards !== null
                ? health.unassignedPrimaryShards
                : (shardResult ? shardResult.summary.unassignedPrimaries : null),
            delayedUnassignedShards: health ? health.delayedUnassignedShards : null,
            numberOfPendingTasks: health ? health.numberOfPendingTasks : null,
            numberOfInFlightFetch: health ? health.numberOfInFlightFetch : null,
            taskMaxWaitingInQueueMillis: health ? health.taskMaxWaitingInQueueMillis : null,
            activeShardsPercentAsNumber: health ? health.activeShardsPercentAsNumber : null,

            // A single-node cluster cannot allocate a replica anywhere, so it is
            // legitimately yellow forever. Carried explicitly so the health
            // score does not have to re-derive the context.
            singleNode: (health ? health.numberOfNodes : nodes.length) === 1,
            singleDataNode: (health ? health.numberOfDataNodes : nodes.filter((n) => n.isDataNode).length) === 1,

            master: metadata ? metadata.master : null,
            masterChanged,
            masterChanges: st.masterChanges,
            masterEligibleNodes: nodes.filter((n) => n.isMasterEligible).length,

            nodesTotal: nodesHeader ? nodesHeader.total : nodes.length,
            nodesSuccessful: nodesHeader ? nodesHeader.successful : nodes.length,
            nodesFailed: nodesHeader ? nodesHeader.failed : 0
        };

        const advanced = {
            schemaVersion: SCHEMA_VERSION,
            id,
            origin,
            collectedAt: now,
            intervalSeconds,
            // A cluster where some node did not answer in time gives partial
            // totals. Reported, never silently averaged away.
            partial: !!(nodesHeader && nodesHeader.failed > 0),
            partialReasons: nodesHeader ? nodesHeader.failureReasons : [],

            collected,
            capabilities,
            capabilityNotes,

            cluster: clusterSection,
            clusterStats,

            nodes,
            nodeTotals,
            nodeComparison,

            indices: allIndices,
            indexTotals: indexResult ? indexResult.totals : null,
            indexCount: indexResult ? indexResult.totalIndexCount : null,
            indicesTruncated: indexResult ? indexResult.truncated : false,

            shards: shardResult ? {
                summary: shardResult.summary,
                unassigned: shardResult.unassigned,
                rows: shardResult.rows,
                truncated: shardResult.truncated
            } : null,

            allocationExplanations,

            pendingTasks,
            recovery,
            tasks,
            dataStreams: metadata ? metadata.dataStreams : [],
            watermarks,

            slowOperations: slowResult.operations,
            slowOperationsSummary: slowlog.summariseSlowOperations(slowResult.operations),
            slowOperationsTruncated: slowResult.truncated,
            slowlogFiles: slowResult.files,

            thresholds: {
                slowSearchMs: config.slowSearchThresholdMs,
                slowIndexingMs: config.slowIndexingThresholdMs
            }
        };

        if (errors.length) advanced.collectorErrors = errors.slice(0, 25);

        // ── batching ─────────────────────────────────────────────────────────
        // A cluster with thousands of indices produces an index array larger
        // than one payload should carry. The primary payload keeps the first
        // batch; the rest travel as index-only follow-ups that the server
        // handler writes independently.
        const batches = [];
        if (allIndices.length > config.maxIndicesPerPayload) {
            advanced.indices = allIndices.slice(0, config.maxIndicesPerPayload);

            const remaining = allIndices.slice(config.maxIndicesPerPayload);
            const parts = 1 + Math.ceil(remaining.length / config.maxIndicesPerPayload);
            advanced.part = 1;
            advanced.parts = parts;

            for (let i = 0; i < remaining.length; i += config.maxIndicesPerPayload) {
                batches.push({
                    schemaVersion: SCHEMA_VERSION,
                    id,
                    origin,
                    collectedAt: now,
                    part: 2 + Math.floor(i / config.maxIndicesPerPayload),
                    parts,
                    clusterName: clusterSection.name,
                    indices: remaining.slice(i, i + config.maxIndicesPerPayload)
                });
            }
        }

        // ── carry state forward ──────────────────────────────────────────────
        st.previous = {
            collectedAt: now,
            nodesByIdRaw: Object.fromEntries(rawNodes.map((n) => [n.nodeId, n])),
            // Index counters are only refreshed on the index tick, so the
            // previous set is retained between them or every index rate would
            // be computed against nothing.
            indicesByName: indexResult
                ? Object.fromEntries(indexResult.detailed.map((i) => [i.index, i]))
                : (previous ? previous.indicesByName : null)
        };

        callback(null, { advanced, batches });
    } catch (err) {
        const message = err instanceof ElasticsearchRequestError
            ? `${err.kind}: ${err.message}`
            : String(err.message || err);
        callback(new Error(message), null);
    } finally {
        client.destroy();
    }
}

module.exports = {
    collect,
    testConnection,
    captureHotThreads,
    normalizeConfig,
    resetState,

    // Exported for tests so restarts, counter resets and imbalance scenarios
    // can be driven deterministically without a live cluster.
    deriveGc,
    deriveThreadPools,
    deriveBreakers,
    deriveIndicesRates,
    deriveNodes,
    deriveIndices,
    compareNodes,
    summariseNodes,
    probeCapabilities,

    SCHEMA_VERSION,
    DEFAULTS,
    CRITICAL_THREAD_POOLS
};
