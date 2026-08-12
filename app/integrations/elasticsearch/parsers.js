// Pure parsers for every Elasticsearch API the collector reads.
//
// Every function here is total: a missing key, a null, a string where a number
// was expected, or a whole response shape from a version that predates a field
// returns a neutral value rather than throwing. That is not defensive
// programming for its own sake — Elasticsearch genuinely moves these fields
// between majors (segment memory accounting disappeared in 8.x, `total_hits`
// changed shape in 7.0, thread pool names differ per version and per node role,
// circuit breaker names are extended by plugins), and one absent field must
// never cost the whole scrape.
//
// The other rule, inherited from the rest of Watchlog: an unknown value is
// `null`, never `0`. A cache with no lookups this interval has no hit rate; a
// node whose filesystem stats were not returned has no disk usage. Writing zero
// for either draws a cliff that never happened.

'use strict';

// ── numeric helpers ───────────────────────────────────────────────────────────

/** Number, or 0 when absent/unparseable. Use for counters. */
function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Number, or null when absent/unparseable. Use for gauges and ratios. */
function nullableNum(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function bool(value) {
    return value === true || value === 'true';
}

function str(value, max = 512) {
    if (value === null || value === undefined) return '';
    return String(value).slice(0, max);
}

/**
 * Diffs a cumulative counter against the previous scrape.
 *
 * Elasticsearch counters reset when a node restarts, and a shard relocating
 * away from a node takes its contribution to that node's index/search counters
 * with it — which looks exactly like a partial reset. Both show up as the
 * counter moving backwards, and both are handled the same way: report no delta
 * rather than a negative one or a bogus spike.
 */
function counterDelta(current, previous, reset) {
    const cur = Number(current);
    if (!Number.isFinite(cur)) return 0;
    if (reset || previous === null || previous === undefined) return 0;
    const prev = Number(previous);
    if (!Number.isFinite(prev)) return 0;
    return cur >= prev ? cur - prev : 0;
}

function perSecond(delta, intervalSeconds) {
    if (!intervalSeconds || intervalSeconds <= 0) return null;
    return delta / intervalSeconds;
}

/**
 * Mean latency over the interval.
 *
 * With no operations in the interval there is no latency to report. Returning 0
 * would claim the cluster answered instantly; returning the lifetime mean would
 * claim a number that has not moved in months. Null is the only honest answer.
 */
function meanLatency(timeDeltaMs, countDelta) {
    if (!countDelta || countDelta <= 0) return null;
    return timeDeltaMs / countDelta;
}

/** part/total as a percentage, or null when the denominator is unknown/zero. */
function percentage(part, total) {
    const p = Number(part);
    const t = Number(total);
    if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return null;
    return (p / t) * 100;
}

/** Hit-rate over interval deltas — never over lifetime counters. */
function hitRate(hitDelta, missDelta) {
    const total = num(hitDelta) + num(missDelta);
    return total > 0 ? (num(hitDelta) / total) * 100 : null;
}

// ── version ───────────────────────────────────────────────────────────────────

/**
 * Parses `GET /` into a comparable version descriptor.
 *
 * `distribution` matters: an OpenSearch fork answers on the same endpoint and
 * reports version 1.x/2.x, which would otherwise be read as an ancient
 * Elasticsearch and have every modern capability disabled.
 */
function parseRootInfo(body) {
    const info = body || {};
    const version = info.version || {};
    const raw = str(version.number, 32);
    const parts = raw.split('.');

    const major = num(parts[0]);
    const minor = num(parts[1]);
    const patch = num(parts[2]);

    return {
        clusterName: str(info.cluster_name, 255),
        clusterUuid: str(info.cluster_uuid, 64),
        nodeName: str(info.name, 255),
        version: raw,
        versionMajor: major,
        versionMinor: minor,
        versionPatch: patch,
        // 8.17.3 → 80017. Comparable as one integer without ranking 8.9 above 8.17.
        versionNum: major * 10000 + minor * 100 + Math.min(patch, 99),
        // OpenSearch answers on the same endpoint and reports its own 1.x/2.x
        // version, which would otherwise read as an ancient Elasticsearch with
        // every modern capability disabled.
        distribution: str(version.distribution || (String(info.tagline || '').includes('OpenSearch')
            ? 'opensearch'
            : 'elasticsearch'), 32),
        buildFlavor: str(version.build_flavor, 32),
        buildType: str(version.build_type, 32),
        luceneVersion: str(version.lucene_version, 32),
        minimumWireCompatibility: str(version.minimum_wire_compatibility_version, 32)
    };
}

/** True when the cluster is at least the given major.minor. */
function atLeast(versionInfo, major, minor = 0) {
    if (!versionInfo) return false;
    if (versionInfo.versionMajor > major) return true;
    return versionInfo.versionMajor === major && versionInfo.versionMinor >= minor;
}

// ── cluster health ────────────────────────────────────────────────────────────

const HEALTH_STATUS_CODE = { green: 0, yellow: 1, red: 2 };

/** Numeric encoding of cluster/index health so it can live in an Influx field. */
function healthStatusCode(status) {
    const code = HEALTH_STATUS_CODE[String(status || '').toLowerCase()];
    return code === undefined ? 3 : code;
}

function normalizeHealthStatus(status) {
    const s = String(status || '').toLowerCase();
    return s === 'green' || s === 'yellow' || s === 'red' ? s : 'unknown';
}

/**
 * `GET /_cluster/health`.
 *
 * `unassigned_primary_shards` only exists from 8.x; before that the count has
 * to come from the shard listing, so it stays null here rather than being
 * guessed at.
 */
function parseClusterHealth(body) {
    const h = body || {};
    const active = num(h.active_shards);
    const unassigned = num(h.unassigned_shards);

    return {
        clusterName: str(h.cluster_name, 255),
        status: normalizeHealthStatus(h.status),
        statusCode: healthStatusCode(h.status),
        timedOut: bool(h.timed_out),
        numberOfNodes: num(h.number_of_nodes),
        numberOfDataNodes: num(h.number_of_data_nodes),
        activePrimaryShards: num(h.active_primary_shards),
        activeShards: active,
        relocatingShards: num(h.relocating_shards),
        initializingShards: num(h.initializing_shards),
        unassignedShards: unassigned,
        // 8.x only. Null on 7.x — the shard listing fills the gap there.
        unassignedPrimaryShards: nullableNum(h.unassigned_primary_shards),
        delayedUnassignedShards: num(h.delayed_unassigned_shards),
        numberOfPendingTasks: num(h.number_of_pending_tasks),
        numberOfInFlightFetch: num(h.number_of_in_flight_fetch),
        taskMaxWaitingInQueueMillis: num(h.task_max_waiting_in_queue_millis),
        activeShardsPercentAsNumber: nullableNum(h.active_shards_percent_as_number)
    };
}

// ── cluster stats ─────────────────────────────────────────────────────────────

/**
 * `GET /_cluster/stats`.
 *
 * Node role counts moved from a flat `count.data`/`count.master` map in 6.x to
 * per-role keys (`data_hot`, `data_content`, …) in 7.9+. Both shapes are read
 * so a 7.x cluster does not report zero data nodes.
 */
function parseClusterStats(body) {
    const stats = body || {};
    const nodes = stats.nodes || {};
    const indices = stats.indices || {};
    const counts = nodes.count || {};

    const roleCounts = {};
    for (const [key, value] of Object.entries(counts)) {
        if (key === 'total') continue;
        const n = nullableNum(value);
        if (n !== null) roleCounts[key] = n;
    }

    const jvm = nodes.jvm || {};
    const jvmMem = jvm.mem || {};
    const os = nodes.os || {};
    const osMem = os.mem || {};
    const fs = nodes.fs || {};
    const process = nodes.process || {};
    const shards = indices.shards || {};

    const docs = indices.docs || {};
    const store = indices.store || {};

    return {
        clusterName: str(stats.cluster_name, 255),
        clusterUuid: str(stats.cluster_uuid, 64),
        status: normalizeHealthStatus(stats.status),

        nodes: {
            total: num(counts.total),
            // Deliberately NOT summed across data tiers: from 7.9 a single node
            // holding both data_content and data_hot appears under both keys, so
            // adding them counts it twice. Cluster health's number_of_data_nodes
            // is the authoritative figure and the collector prefers it; these
            // per-role counts describe the topology, not the node total.
            data: num(counts.data),
            master: num(counts.master),
            ingest: num(counts.ingest),
            coordinatingOnly: num(counts.coordinating_only),
            ml: num(counts.ml),
            transform: num(counts.transform),
            votingOnly: num(counts.voting_only),
            roleCounts
        },

        versions: Array.isArray(nodes.versions) ? nodes.versions.map((v) => str(v, 32)) : [],

        jvm: {
            maxUptimeMillis: num(jvm.max_uptime_in_millis),
            threads: num(jvm.threads),
            heapUsedBytes: num(jvmMem.heap_used_in_bytes),
            heapMaxBytes: num(jvmMem.heap_max_in_bytes),
            heapUsedPercentage: percentage(jvmMem.heap_used_in_bytes, jvmMem.heap_max_in_bytes)
        },

        os: {
            availableProcessors: num(os.available_processors),
            allocatedProcessors: num(os.allocated_processors),
            memTotalBytes: num(osMem.total_in_bytes),
            memFreeBytes: num(osMem.free_in_bytes),
            memUsedBytes: num(osMem.used_in_bytes),
            memUsedPercentage: nullableNum(osMem.used_percent),
            // 7.16+ only.
            cpuPercent: nullableNum(os.cpu && os.cpu.percent)
        },

        process: {
            cpuPercent: nullableNum(process.cpu && process.cpu.percent),
            openFileDescriptorsMax: nullableNum(process.open_file_descriptors && process.open_file_descriptors.max),
            openFileDescriptorsAvg: nullableNum(process.open_file_descriptors && process.open_file_descriptors.avg)
        },

        fs: {
            totalBytes: num(fs.total_in_bytes),
            freeBytes: num(fs.free_in_bytes),
            availableBytes: num(fs.available_in_bytes),
            usedBytes: num(fs.total_in_bytes) - num(fs.available_in_bytes),
            usagePercentage: percentage(
                num(fs.total_in_bytes) - num(fs.available_in_bytes),
                fs.total_in_bytes
            )
        },

        indices: {
            count: num(indices.count),
            docsCount: num(docs.count),
            docsDeleted: num(docs.deleted),
            storeSizeBytes: num(store.size_in_bytes),
            // 7.13+ — the size a searchable snapshot occupies on the tier.
            totalDataSetSizeBytes: nullableNum(store.total_data_set_size_in_bytes),
            shardsTotal: num(shards.total),
            shardsPrimaries: num(shards.primaries),
            shardsReplication: nullableNum(shards.replication),
            segmentsCount: num(indices.segments && indices.segments.count),
            fielddataMemoryBytes: num(indices.fielddata && indices.fielddata.memory_size_in_bytes),
            queryCacheMemoryBytes: num(indices.query_cache && indices.query_cache.memory_size_in_bytes),
            completionSizeBytes: num(indices.completion && indices.completion.size_in_bytes)
        }
    };
}

// ── node identity / topology ──────────────────────────────────────────────────

// Roles that make a node a data node in any Elasticsearch version.
const DATA_ROLES = new Set(['data', 'data_content', 'data_hot', 'data_warm', 'data_cold', 'data_frozen']);
const TIER_ROLES = ['data_content', 'data_hot', 'data_warm', 'data_cold', 'data_frozen'];

/**
 * `GET /_nodes?filter_path=…` — identity and roles for every node.
 *
 * Node id is the only stable identifier: names can be reused, transport
 * addresses change on restart in a container, and IPs are reassigned. It is
 * therefore the tag; everything else travels as a field.
 */
function parseNodesInfo(body) {
    const nodes = (body && body.nodes) || {};
    const out = [];

    for (const [nodeId, node] of Object.entries(nodes)) {
        if (!node || typeof node !== 'object') continue;
        const roles = Array.isArray(node.roles) ? node.roles.map((r) => str(r, 32)) : [];

        out.push({
            nodeId: str(nodeId, 64),
            name: str(node.name, 255),
            roles,
            version: str(node.version, 32),
            buildFlavor: str(node.build_flavor, 32),
            transportAddress: str(node.transport_address, 128),
            host: str(node.host, 255),
            ip: str(node.ip, 64),
            isMasterEligible: roles.includes('master'),
            isDataNode: roles.some((r) => DATA_ROLES.has(r)),
            isIngest: roles.includes('ingest'),
            isMl: roles.includes('ml'),
            isCoordinatingOnly: roles.length === 0 || (roles.length === 1 && roles[0] === 'remote_cluster_client'),
            // 7.9+ data tiers. Empty on a cluster that does not use them, which
            // is a normal configuration and not a gap.
            tiers: roles.filter((r) => TIER_ROLES.includes(r)),
            attributes: node.attributes && typeof node.attributes === 'object'
                ? Object.fromEntries(
                    Object.entries(node.attributes)
                        .slice(0, 20)
                        .map(([k, v]) => [str(k, 64), str(v, 128)])
                )
                : {}
        });
    }

    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** `GET /_cat/master?format=json` — which node currently holds the master role. */
function parseCatMaster(rows) {
    if (!Array.isArray(rows) || !rows.length) return null;
    const row = rows[0] || {};
    return {
        nodeId: str(row.id, 64),
        host: str(row.host, 255),
        ip: str(row.ip, 64),
        name: str(row.node, 255)
    };
}

// ── node stats ────────────────────────────────────────────────────────────────

/** JVM garbage collectors, keyed by collector name. Names differ per JVM. */
function parseGcCollectors(gc) {
    const collectors = (gc && gc.collectors) || {};
    const out = {};
    for (const [name, entry] of Object.entries(collectors)) {
        if (!entry || typeof entry !== 'object') continue;
        out[str(name, 32)] = {
            collectionCount: num(entry.collection_count),
            collectionTimeMillis: num(entry.collection_time_in_millis)
        };
    }
    return out;
}

function parseThreadPools(threadPool) {
    const pools = threadPool || {};
    const out = {};
    for (const [name, entry] of Object.entries(pools)) {
        if (!entry || typeof entry !== 'object') continue;
        out[str(name, 64)] = {
            threads: num(entry.threads),
            queue: num(entry.queue),
            active: num(entry.active),
            rejected: num(entry.rejected),
            largest: num(entry.largest),
            completed: num(entry.completed)
        };
    }
    return out;
}

function parseBreakers(breakers) {
    const entries = breakers || {};
    const out = {};
    for (const [name, entry] of Object.entries(entries)) {
        if (!entry || typeof entry !== 'object') continue;
        const limit = num(entry.limit_size_in_bytes);
        const estimated = num(entry.estimated_size_in_bytes);
        out[str(name, 64)] = {
            limitBytes: limit,
            estimatedBytes: estimated,
            overhead: nullableNum(entry.overhead),
            tripped: num(entry.tripped),
            // Null rather than 0 when the breaker reports no limit, which the
            // parent breaker does on some configurations.
            usagePercentage: percentage(estimated, limit)
        };
    }
    return out;
}

function parseFilesystem(fs) {
    const total = (fs && fs.total) || {};
    const data = Array.isArray(fs && fs.data) ? fs.data : [];

    const paths = data.slice(0, 32).map((entry) => {
        const totalBytes = num(entry.total_in_bytes);
        const availableBytes = num(entry.available_in_bytes);
        return {
            path: str(entry.path, 255),
            mount: str(entry.mount, 255),
            type: str(entry.type, 64),
            totalBytes,
            freeBytes: num(entry.free_in_bytes),
            availableBytes,
            usedBytes: totalBytes > 0 ? totalBytes - availableBytes : 0,
            usagePercentage: percentage(totalBytes - availableBytes, totalBytes)
        };
    });

    const totalBytes = num(total.total_in_bytes);
    const availableBytes = num(total.available_in_bytes);

    const ioStats = (fs && fs.io_stats && fs.io_stats.total) || null;

    return {
        totalBytes,
        freeBytes: num(total.free_in_bytes),
        availableBytes,
        usedBytes: totalBytes > 0 ? totalBytes - availableBytes : 0,
        // Null on a node that reported no filesystem section — a coordinating
        // node legitimately has no data path.
        usagePercentage: totalBytes > 0 ? percentage(totalBytes - availableBytes, totalBytes) : null,
        paths,
        // Linux only; absent everywhere else rather than zero.
        io: ioStats ? {
            operations: nullableNum(ioStats.operations),
            readOperations: nullableNum(ioStats.read_operations),
            writeOperations: nullableNum(ioStats.write_operations),
            readKilobytes: nullableNum(ioStats.read_kilobytes),
            writeKilobytes: nullableNum(ioStats.write_kilobytes)
        } : null
    };
}

/** The `indices` block of a node-stats or index-stats entry. */
function parseIndicesSection(indices) {
    const idx = indices || {};
    const docs = idx.docs || {};
    const store = idx.store || {};
    const indexing = idx.indexing || {};
    const search = idx.search || {};
    const get = idx.get || {};
    const merges = idx.merges || {};
    const refresh = idx.refresh || {};
    const flush = idx.flush || {};
    const translog = idx.translog || {};
    const segments = idx.segments || {};
    const queryCache = idx.query_cache || {};
    const requestCache = idx.request_cache || {};
    const fielddata = idx.fielddata || {};
    const warmer = idx.warmer || {};
    const bulk = idx.bulk || null;
    const recovery = idx.recovery || {};

    return {
        docs: {
            count: num(docs.count),
            deleted: num(docs.deleted),
            // Null on an empty index: 0/0 is not "no deleted documents", it is
            // "no documents at all".
            deletedPercentage: percentage(docs.deleted, num(docs.count) + num(docs.deleted))
        },

        store: {
            sizeBytes: num(store.size_in_bytes),
            totalDataSetSizeBytes: nullableNum(store.total_data_set_size_in_bytes),
            reservedBytes: nullableNum(store.reserved_in_bytes)
        },

        indexing: {
            indexTotal: num(indexing.index_total),
            indexTimeMillis: num(indexing.index_time_in_millis),
            indexCurrent: num(indexing.index_current),
            indexFailed: num(indexing.index_failed),
            deleteTotal: num(indexing.delete_total),
            deleteTimeMillis: num(indexing.delete_time_in_millis),
            deleteCurrent: num(indexing.delete_current),
            noopUpdateTotal: num(indexing.noop_update_total),
            throttleTimeMillis: num(indexing.throttle_time_in_millis),
            isThrottled: bool(indexing.is_throttled)
        },

        search: {
            openContexts: num(search.open_contexts),
            queryTotal: num(search.query_total),
            queryTimeMillis: num(search.query_time_in_millis),
            queryCurrent: num(search.query_current),
            fetchTotal: num(search.fetch_total),
            fetchTimeMillis: num(search.fetch_time_in_millis),
            fetchCurrent: num(search.fetch_current),
            scrollTotal: num(search.scroll_total),
            scrollTimeMillis: num(search.scroll_time_in_millis),
            scrollCurrent: num(search.scroll_current),
            suggestTotal: num(search.suggest_total),
            suggestTimeMillis: num(search.suggest_time_in_millis),
            suggestCurrent: num(search.suggest_current)
        },

        get: {
            total: num(get.total),
            timeMillis: num(get.time_in_millis),
            current: num(get.current),
            existsTotal: num(get.exists_total),
            existsTimeMillis: num(get.exists_time_in_millis),
            missingTotal: num(get.missing_total),
            missingTimeMillis: num(get.missing_time_in_millis)
        },

        merges: {
            current: num(merges.current),
            currentDocs: num(merges.current_docs),
            currentSizeBytes: num(merges.current_size_in_bytes),
            total: num(merges.total),
            totalTimeMillis: num(merges.total_time_in_millis),
            totalDocs: num(merges.total_docs),
            totalSizeBytes: num(merges.total_size_in_bytes),
            totalStoppedTimeMillis: num(merges.total_stopped_time_in_millis),
            totalThrottledTimeMillis: num(merges.total_throttled_time_in_millis),
            totalAutoThrottleBytes: num(merges.total_auto_throttle_in_bytes)
        },

        refresh: {
            total: num(refresh.total),
            totalTimeMillis: num(refresh.total_time_in_millis),
            // 7.x+ only.
            externalTotal: nullableNum(refresh.external_total),
            externalTotalTimeMillis: nullableNum(refresh.external_total_time_in_millis),
            listeners: num(refresh.listeners)
        },

        flush: {
            total: num(flush.total),
            periodic: num(flush.periodic),
            totalTimeMillis: num(flush.total_time_in_millis)
        },

        translog: {
            operations: num(translog.operations),
            sizeBytes: num(translog.size_in_bytes),
            uncommittedOperations: num(translog.uncommitted_operations),
            uncommittedSizeBytes: num(translog.uncommitted_size_in_bytes),
            earliestLastModifiedAge: num(translog.earliest_last_modified_age)
        },

        segments: {
            count: num(segments.count),
            // Per-segment memory accounting was removed when Lucene moved these
            // structures off-heap, so 8.x reports 0 and 9.x omits the fields.
            // Null keeps "not reported" distinguishable from "nothing on heap".
            memoryBytes: nullableNum(segments.memory_in_bytes),
            termsMemoryBytes: nullableNum(segments.terms_memory_in_bytes),
            storedFieldsMemoryBytes: nullableNum(segments.stored_fields_memory_in_bytes),
            termVectorsMemoryBytes: nullableNum(segments.term_vectors_memory_in_bytes),
            normsMemoryBytes: nullableNum(segments.norms_memory_in_bytes),
            pointsMemoryBytes: nullableNum(segments.points_memory_in_bytes),
            docValuesMemoryBytes: nullableNum(segments.doc_values_memory_in_bytes),
            indexWriterMemoryBytes: num(segments.index_writer_memory_in_bytes),
            versionMapMemoryBytes: num(segments.version_map_memory_in_bytes),
            fixedBitSetMemoryBytes: num(segments.fixed_bit_set_memory_in_bytes)
        },

        queryCache: {
            memoryBytes: num(queryCache.memory_size_in_bytes),
            totalCount: num(queryCache.total_count),
            hitCount: num(queryCache.hit_count),
            missCount: num(queryCache.miss_count),
            cacheSize: num(queryCache.cache_size),
            cacheCount: num(queryCache.cache_count),
            evictions: num(queryCache.evictions)
        },

        requestCache: {
            memoryBytes: num(requestCache.memory_size_in_bytes),
            evictions: num(requestCache.evictions),
            hitCount: num(requestCache.hit_count),
            missCount: num(requestCache.miss_count)
        },

        fielddata: {
            memoryBytes: num(fielddata.memory_size_in_bytes),
            evictions: num(fielddata.evictions)
        },

        warmer: {
            current: num(warmer.current),
            total: num(warmer.total),
            totalTimeMillis: num(warmer.total_time_in_millis)
        },

        // Node-level bulk stats arrived in 8.0. Absent, not zero, before that.
        bulk: bulk ? {
            totalOperations: num(bulk.total_operations),
            totalTimeMillis: num(bulk.total_time_in_millis),
            totalSizeBytes: num(bulk.total_size_in_bytes),
            avgTimeMillis: nullableNum(bulk.avg_time_in_millis),
            avgSizeBytes: nullableNum(bulk.avg_size_in_bytes)
        } : null,

        recovery: {
            currentAsSource: num(recovery.current_as_source),
            currentAsTarget: num(recovery.current_as_target),
            throttleTimeMillis: num(recovery.throttle_time_in_millis)
        }
    };
}

/**
 * `GET /_nodes/stats/…` — one entry per node that answered.
 *
 * A node that timed out is simply absent from the response. That is reported as
 * partial data by the caller rather than being invented as a zeroed node.
 */
function parseNodesStats(body) {
    const nodes = (body && body.nodes) || {};
    const out = [];

    for (const [nodeId, node] of Object.entries(nodes)) {
        if (!node || typeof node !== 'object') continue;

        const jvm = node.jvm || {};
        const jvmMem = jvm.mem || {};
        const jvmThreads = jvm.threads || {};
        const os = node.os || {};
        const osCpu = os.cpu || {};
        const load = osCpu.load_average || {};
        const osMem = os.mem || {};
        const osSwap = os.swap || {};
        const process = node.process || {};
        const processCpu = process.cpu || {};
        const transport = node.transport || {};
        const http = node.http || {};
        const roles = Array.isArray(node.roles) ? node.roles.map((r) => str(r, 32)) : [];

        out.push({
            nodeId: str(nodeId, 64),
            name: str(node.name, 255),
            host: str(node.host, 255),
            ip: str(node.ip, 64),
            transportAddress: str(node.transport_address, 128),
            roles,
            isDataNode: roles.some((r) => DATA_ROLES.has(r)),
            isMasterEligible: roles.includes('master'),
            tiers: roles.filter((r) => TIER_ROLES.includes(r)),
            timestamp: num(node.timestamp),

            jvm: {
                uptimeMillis: num(jvm.uptime_in_millis),
                heapUsedBytes: num(jvmMem.heap_used_in_bytes),
                heapUsedPercent: nullableNum(jvmMem.heap_used_percent),
                heapCommittedBytes: num(jvmMem.heap_committed_in_bytes),
                heapMaxBytes: num(jvmMem.heap_max_in_bytes),
                nonHeapUsedBytes: num(jvmMem.non_heap_used_in_bytes),
                nonHeapCommittedBytes: num(jvmMem.non_heap_committed_in_bytes),
                threadCount: num(jvmThreads.count),
                threadPeakCount: num(jvmThreads.peak_count),
                gc: parseGcCollectors(jvm.gc)
            },

            os: {
                // `os.cpu.percent` is the host CPU. Null on a platform that does
                // not expose it rather than a fabricated idle reading.
                cpuPercent: nullableNum(osCpu.percent),
                load1m: nullableNum(load['1m']),
                load5m: nullableNum(load['5m']),
                load15m: nullableNum(load['15m']),
                memTotalBytes: num(osMem.total_in_bytes),
                memFreeBytes: num(osMem.free_in_bytes),
                memUsedBytes: num(osMem.used_in_bytes),
                memFreePercent: nullableNum(osMem.free_percent),
                memUsedPercent: nullableNum(osMem.used_percent),
                swapTotalBytes: num(osSwap.total_in_bytes),
                swapFreeBytes: num(osSwap.free_in_bytes),
                swapUsedBytes: num(osSwap.used_in_bytes),
                // Elasticsearch is exceptionally sensitive to being swapped, so
                // the ratio is derived here rather than left to the UI.
                swapUsedPercentage: percentage(osSwap.used_in_bytes, osSwap.total_in_bytes)
            },

            process: {
                cpuPercent: nullableNum(processCpu.percent),
                cpuTotalMillis: num(processCpu.total_in_millis),
                openFileDescriptors: num(process.open_file_descriptors),
                maxFileDescriptors: num(process.max_file_descriptors),
                fileDescriptorUsagePercentage:
                    percentage(process.open_file_descriptors, process.max_file_descriptors),
                memVirtualBytes: num(process.mem && process.mem.total_virtual_in_bytes)
            },

            fs: parseFilesystem(node.fs),
            indices: parseIndicesSection(node.indices),
            threadPools: parseThreadPools(node.thread_pool),
            breakers: parseBreakers(node.breakers),

            transport: {
                serverOpen: num(transport.server_open),
                rxCount: num(transport.rx_count),
                rxSizeBytes: num(transport.rx_size_in_bytes),
                txCount: num(transport.tx_count),
                txSizeBytes: num(transport.tx_size_in_bytes)
            },

            http: {
                currentOpen: num(http.current_open),
                totalOpened: num(http.total_opened)
            }
        });
    }

    return out;
}

/**
 * `_nodes` header from any nodes response.
 *
 * `failed > 0` is how a large cluster reports that some node did not answer in
 * time; the collector surfaces it as partial data rather than pretending the
 * cluster shrank.
 */
function parseNodesHeader(body) {
    const meta = (body && body._nodes) || {};
    const failures = Array.isArray(meta.failures) ? meta.failures : [];
    return {
        total: num(meta.total),
        successful: num(meta.successful),
        failed: num(meta.failed),
        // Reasons are truncated hard: a node failure reason can embed a stack trace.
        failureReasons: failures.slice(0, 5).map((f) => str(f && (f.reason || f.type), 200))
    };
}

// ── indices ───────────────────────────────────────────────────────────────────

const CAT_INDEX_SIZE_KEYS = ['store.size', 'store_size', 'storeSize'];

/**
 * `GET /_cat/indices?format=json&bytes=b`.
 *
 * The cheap full inventory: one small row per index, used to rank which indices
 * are worth pulling detailed `_stats` for. Hidden and system indices are kept
 * but flagged, because a system index consuming the disk is still the operator's
 * problem.
 */
function parseCatIndices(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => {
        const r = row || {};
        const name = str(r.index, 255);
        const storeSize = CAT_INDEX_SIZE_KEYS.reduce(
            (acc, key) => (acc !== null ? acc : nullableNum(r[key])), null
        );
        const docs = num(r['docs.count']);
        const deleted = num(r['docs.deleted']);

        return {
            index: name,
            uuid: str(r.uuid, 64),
            health: normalizeHealthStatus(r.health),
            healthCode: healthStatusCode(r.health),
            status: str(r.status, 32),
            primaryShards: num(r.pri),
            replicas: num(r.rep),
            docsCount: docs,
            docsDeleted: deleted,
            deletedPercentage: percentage(deleted, docs + deleted),
            storeSizeBytes: storeSize === null ? 0 : storeSize,
            primaryStoreSizeBytes: num(r['pri.store.size']),
            // `.`-prefixed names are Elasticsearch's own indices; the UI dims
            // them rather than hiding them.
            system: name.startsWith('.')
        };
    }).filter((row) => row.index);
}

/**
 * `GET /{indices}/_stats` — detailed per-index metrics.
 *
 * `primaries` is what indexing/store numbers should be read from: `total`
 * counts every replica, so a 1-replica index reports double the documents it
 * actually holds. Search is read from `total` because a search really does run
 * on replicas.
 */
function parseIndexStats(body) {
    const indices = (body && body.indices) || {};
    const out = [];

    for (const [name, entry] of Object.entries(indices)) {
        if (!entry || typeof entry !== 'object') continue;

        const primaries = parseIndicesSection(entry.primaries);
        const total = parseIndicesSection(entry.total);
        const health = entry.health !== undefined ? normalizeHealthStatus(entry.health) : null;

        out.push({
            index: str(name, 255),
            uuid: str(entry.uuid, 64),
            // 7.16+ returns health/status inline; older versions get it from _cat.
            health,
            healthCode: health ? healthStatusCode(health) : null,
            status: entry.status !== undefined ? str(entry.status, 32) : null,
            primaries,
            total
        });
    }

    return out;
}

/** Cluster-wide `_all` totals from `GET /_stats?level=cluster`. */
function parseAllIndicesStats(body) {
    const all = (body && body._all) || {};
    return {
        primaries: parseIndicesSection(all.primaries),
        total: parseIndicesSection(all.total)
    };
}

// ── shards ────────────────────────────────────────────────────────────────────

const SHARD_STATES = ['STARTED', 'INITIALIZING', 'RELOCATING', 'UNASSIGNED'];

/**
 * `GET /_cat/shards?format=json&bytes=b`.
 *
 * The unassigned reason is what turns "3 shards are unassigned" into something
 * an operator can act on, so it is requested explicitly and kept verbatim —
 * `NODE_LEFT`, `ALLOCATION_FAILED`, `INDEX_CREATED` mean very different things.
 */
function parseCatShards(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => {
        const r = row || {};
        const state = String(r.state || '').toUpperCase();

        // _cat/shards has no relocation column. While a shard relocates the
        // `node` value becomes "source -> ip nodeId target", so source and
        // target are split back out here rather than shown as one string.
        const rawNode = str(r.node, 512);
        const relocation = rawNode.includes(' -> ') ? rawNode.split(' -> ') : null;
        const sourceNode = relocation ? relocation[0].trim() : rawNode;
        const relocatingNode = relocation
            // "192.168.1.2 abcdefghij node-2" — the target name is the last token.
            ? relocation[1].trim().split(/\s+/).slice(2).join(' ')
            : '';

        return {
            index: str(r.index, 255),
            shard: num(r.shard),
            primary: String(r.prirep || '').toLowerCase() === 'p',
            state: SHARD_STATES.includes(state) ? state : (state || 'UNKNOWN'),
            docs: nullableNum(r.docs),
            storeBytes: nullableNum(r.store),
            node: sourceNode,
            nodeId: str(r.id, 64),
            ip: str(r.ip, 64),
            relocatingNode,
            unassignedReason: str(r['unassigned.reason'], 64),
            unassignedAt: str(r['unassigned.at'], 64),
            unassignedDetails: str(r['unassigned.details'], 512),
            unassignedFor: str(r['unassigned.for'], 32)
        };
    }).filter((row) => row.index);
}

/** Aggregates a shard listing into the counts the Overview and Shards tabs need. */
function summariseShards(shards) {
    const list = Array.isArray(shards) ? shards : [];

    const byNode = new Map();
    const byIndexUnassigned = new Map();

    let primaries = 0;
    let replicas = 0;
    let started = 0;
    let initializing = 0;
    let relocating = 0;
    let unassigned = 0;
    let unassignedPrimaries = 0;
    let totalStoreBytes = 0;

    for (const shard of list) {
        if (shard.primary) primaries++; else replicas++;

        switch (shard.state) {
            case 'STARTED': started++; break;
            case 'INITIALIZING': initializing++; break;
            case 'RELOCATING': relocating++; break;
            case 'UNASSIGNED':
                unassigned++;
                if (shard.primary) unassignedPrimaries++;
                byIndexUnassigned.set(shard.index, (byIndexUnassigned.get(shard.index) || 0) + 1);
                break;
            default: break;
        }

        totalStoreBytes += num(shard.storeBytes);

        if (shard.node) {
            const current = byNode.get(shard.node) || {
                node: shard.node, nodeId: shard.nodeId, total: 0, primaries: 0, replicas: 0, storeBytes: 0
            };
            current.total++;
            if (shard.primary) current.primaries++; else current.replicas++;
            current.storeBytes += num(shard.storeBytes);
            byNode.set(shard.node, current);
        }
    }

    const perNode = [...byNode.values()].sort((a, b) => b.total - a.total);
    const counts = perNode.map((n) => n.total);

    // A true median, averaging the two middle values on an even count. Taking
    // the upper middle instead would make the median equal the maximum on a
    // two-node cluster, reporting zero imbalance however lopsided it is — and
    // two-node clusters are exactly where imbalance is most visible.
    let median = 0;
    if (counts.length) {
        const sorted = counts.slice().sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    return {
        total: list.length,
        primaries,
        replicas,
        started,
        initializing,
        relocating,
        unassigned,
        unassignedPrimaries,
        unassignedReplicas: unassigned - unassignedPrimaries,
        totalStoreBytes,
        perNode,
        // Imbalance is only meaningful once there is more than one data node
        // holding shards; on a single node it is always zero by definition.
        maxShardsOnNode: counts.length ? Math.max(...counts) : 0,
        minShardsOnNode: counts.length ? Math.min(...counts) : 0,
        medianShardsOnNode: median,
        imbalancePercentage: median > 0 && counts.length > 1
            ? ((Math.max(...counts) - median) / median) * 100
            : null,
        indicesWithUnassigned: [...byIndexUnassigned.entries()]
            .map(([index, count]) => ({ index, count }))
            .sort((a, b) => b.count - a.count)
    };
}

// ── pending tasks ─────────────────────────────────────────────────────────────

const TASK_PRIORITY_RANK = {
    IMMEDIATE: 0, URGENT: 1, HIGH: 2, NORMAL: 3, LOW: 4, LANGUID: 5
};

/** `GET /_cluster/pending_tasks`. */
function parsePendingTasks(body) {
    const tasks = Array.isArray(body && body.tasks) ? body.tasks : [];

    const parsed = tasks.slice(0, 200).map((task) => {
        const t = task || {};
        return {
            insertOrder: num(t.insert_order),
            priority: str(t.priority, 32).toUpperCase() || 'NORMAL',
            source: str(t.source, 512),
            executing: bool(t.executing),
            timeInQueueMillis: num(t.time_in_queue_millis)
        };
    });

    const highPriority = parsed.filter(
        (t) => (TASK_PRIORITY_RANK[t.priority] ?? 9) <= TASK_PRIORITY_RANK.HIGH
    ).length;

    return {
        count: tasks.length,
        tasks: parsed,
        oldestTimeInQueueMillis: parsed.reduce((m, t) => Math.max(m, t.timeInQueueMillis), 0),
        highPriorityCount: highPriority,
        executingCount: parsed.filter((t) => t.executing).length
    };
}

// ── recovery ──────────────────────────────────────────────────────────────────

/**
 * `GET /_recovery?active_only=true&detailed=false`.
 *
 * `active_only` matters: without it Elasticsearch returns every recovery the
 * cluster has ever completed, which on a large cluster is a response measured in
 * hundreds of megabytes.
 */
function parseRecovery(body) {
    const indices = (body && typeof body === 'object') ? body : {};
    const out = [];

    for (const [indexName, entry] of Object.entries(indices)) {
        const shards = Array.isArray(entry && entry.shards) ? entry.shards : [];
        for (const shard of shards) {
            const s = shard || {};
            const index = s.index || {};
            const size = index.size || {};
            const files = index.files || {};
            const translog = s.translog || {};

            const totalBytes = num(size.total_in_bytes);
            const recoveredBytes = num(size.recovered_in_bytes);

            out.push({
                index: str(indexName, 255),
                shard: num(s.id),
                type: str(s.type, 32),
                stage: str(s.stage, 32),
                primary: bool(s.primary),
                startTimeMillis: num(s.start_time_in_millis),
                totalTimeMillis: num(s.total_time_in_millis),
                sourceNode: str((s.source && (s.source.name || s.source.host)) || s.source_node, 255),
                targetNode: str((s.target && (s.target.name || s.target.host)) || s.target_node, 255),
                filesTotal: num(files.total),
                filesRecovered: num(files.recovered),
                filesPercent: nullableNum(String(files.percent || '').replace('%', '')),
                bytesTotal: totalBytes,
                bytesRecovered: recoveredBytes,
                bytesPercent: percentage(recoveredBytes, totalBytes),
                translogOperations: num(translog.total),
                translogRecovered: num(translog.recovered),
                translogPercent: nullableNum(String(translog.percent || '').replace('%', '')),
                // Overall progress prefers the byte figure; on a translog-only
                // recovery there are no files to count.
                progressPercentage: totalBytes > 0
                    ? percentage(recoveredBytes, totalBytes)
                    : nullableNum(String(translog.percent || '').replace('%', ''))
            });
        }
    }

    return out.sort((a, b) => (a.progressPercentage || 0) - (b.progressPercentage || 0));
}

// ── tasks ─────────────────────────────────────────────────────────────────────

// Long-running work an operator cares about. Deliberately narrow: the task API
// also reports every in-flight search and bulk, which as a stored event stream
// would be noise measured in gigabytes.
const INTERESTING_TASK_ACTIONS = [
    'indices:data/write/reindex',
    'indices:data/write/update/byquery',
    'indices:data/write/delete/byquery',
    'cluster:admin/snapshot',
    'cluster:admin/repository',
    'indices:data/write/bulk',
    'indices:admin/forcemerge',
    'indices:data/read/search'
];

/** `GET /_tasks?detailed=true&group_by=none`. */
function parseTasks(body, { minRunningMillis = 5000, limit = 100 } = {}) {
    const raw = body || {};
    const tasks = [];

    // group_by=none returns a flat array; the default groups by parent node.
    if (Array.isArray(raw.tasks)) {
        for (const task of raw.tasks) tasks.push(task);
    } else if (raw.nodes && typeof raw.nodes === 'object') {
        for (const node of Object.values(raw.nodes)) {
            const nodeTasks = (node && node.tasks) || {};
            for (const task of Object.values(nodeTasks)) tasks.push(task);
        }
    }

    return tasks
        .map((task) => {
            const t = task || {};
            return {
                taskId: str(t.id !== undefined && t.node ? `${t.node}:${t.id}` : t.id, 128),
                node: str(t.node, 64),
                action: str(t.action, 128),
                type: str(t.type, 64),
                // `description` can embed a query. It is bounded here and
                // scrubbed by the caller before it is stored.
                description: str(t.description, 1000),
                startTimeMillis: num(t.start_time_in_millis),
                runningTimeNanos: num(t.running_time_in_nanos),
                runningTimeMillis: Math.round(num(t.running_time_in_nanos) / 1e6),
                cancellable: bool(t.cancellable),
                cancelled: bool(t.cancelled),
                parentTaskId: str(t.parent_task_id, 128),
                status: t.status && typeof t.status === 'object' ? {
                    total: nullableNum(t.status.total),
                    created: nullableNum(t.status.created),
                    updated: nullableNum(t.status.updated),
                    deleted: nullableNum(t.status.deleted),
                    batches: nullableNum(t.status.batches)
                } : null
            };
        })
        .filter((t) => {
            if (!t.action) return false;
            if (t.runningTimeMillis < minRunningMillis) return false;
            return INTERESTING_TASK_ACTIONS.some((prefix) => t.action.startsWith(prefix));
        })
        .sort((a, b) => b.runningTimeMillis - a.runningTimeMillis)
        .slice(0, limit);
}

// ── disk watermarks ───────────────────────────────────────────────────────────

/**
 * Parses one watermark setting, which Elasticsearch accepts in three forms:
 * a percentage ("85%"), a ratio ("0.85") or an absolute free-space size
 * ("100gb"). All three have to be understood, because comparing a node's disk
 * usage against the *configured* threshold is the whole point — a hardcoded 85%
 * is wrong on a cluster that set flood stage at 97%.
 */
function parseWatermarkValue(value) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim().toLowerCase();
    if (!raw) return null;

    if (raw.endsWith('%')) {
        const pct = Number(raw.slice(0, -1));
        return Number.isFinite(pct) ? { type: 'percentage', percentage: pct, raw } : null;
    }

    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0 && asNumber <= 1) {
        return { type: 'percentage', percentage: asNumber * 100, raw };
    }

    const sizeMatch = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb|pb)$/);
    if (sizeMatch) {
        const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };
        return {
            type: 'bytes',
            // The setting names the free space that must remain available.
            freeBytes: Number(sizeMatch[1]) * units[sizeMatch[2]],
            raw
        };
    }

    return null;
}

/**
 * `GET /_cluster/settings?include_defaults=true&flat_settings=true`.
 *
 * Precedence is transient → persistent → defaults, matching how Elasticsearch
 * itself resolves a setting.
 */
function parseDiskWatermarks(body) {
    const settings = body || {};
    const layers = [settings.transient, settings.persistent, settings.defaults]
        .filter((l) => l && typeof l === 'object');

    const read = (key) => {
        for (const layer of layers) {
            if (layer[key] !== undefined && layer[key] !== null && layer[key] !== '') return layer[key];
        }
        return null;
    };

    const prefix = 'cluster.routing.allocation.disk.watermark';
    const low = parseWatermarkValue(read(`${prefix}.low`));
    const high = parseWatermarkValue(read(`${prefix}.high`));
    const flood = parseWatermarkValue(read(`${prefix}.flood_stage`));

    const thresholdEnabled = read('cluster.routing.allocation.disk.threshold_enabled');

    return {
        // Null means the setting could not be read (usually a permission gap),
        // which the health score treats as "fall back to generic advice"
        // rather than "no watermark configured".
        low,
        high,
        floodStage: flood,
        available: !!(low || high || flood),
        thresholdEnabled: thresholdEnabled === null ? null : bool(thresholdEnabled)
    };
}

/**
 * Where a node's disk usage sits relative to the configured watermarks.
 *
 * Returns null when neither the usage nor the watermarks are known, so the
 * caller can say "not evaluated" rather than "fine".
 */
function evaluateWatermark(nodeFs, watermarks) {
    if (!nodeFs || !watermarks || !watermarks.available) return null;
    const totalBytes = num(nodeFs.totalBytes);
    if (totalBytes <= 0) return null;

    const usedPercentage = nodeFs.usagePercentage;
    const availableBytes = num(nodeFs.availableBytes);

    const crossed = (mark) => {
        if (!mark) return false;
        if (mark.type === 'percentage') {
            return usedPercentage !== null && usedPercentage >= mark.percentage;
        }
        return availableBytes <= mark.freeBytes;
    };

    // Distance to the next threshold, expressed in percentage points so the UI
    // can say "4 points below the high watermark".
    const marginTo = (mark) => {
        if (!mark || usedPercentage === null) return null;
        if (mark.type === 'percentage') return mark.percentage - usedPercentage;
        const thresholdPercentage = percentage(totalBytes - mark.freeBytes, totalBytes);
        return thresholdPercentage === null ? null : thresholdPercentage - usedPercentage;
    };

    const atFlood = crossed(watermarks.floodStage);
    const atHigh = crossed(watermarks.high);
    const atLow = crossed(watermarks.low);

    return {
        level: atFlood ? 'flood_stage' : atHigh ? 'high' : atLow ? 'low' : 'ok',
        usedPercentage,
        availableBytes,
        marginToLow: marginTo(watermarks.low),
        marginToHigh: marginTo(watermarks.high),
        marginToFlood: marginTo(watermarks.floodStage),
        lowRaw: watermarks.low ? watermarks.low.raw : null,
        highRaw: watermarks.high ? watermarks.high.raw : null,
        floodRaw: watermarks.floodStage ? watermarks.floodStage.raw : null
    };
}

// ── allocation explain ────────────────────────────────────────────────────────

// Turns Elasticsearch's decider vocabulary into a sentence an operator can act
// on. Only deciders that actually block allocation in practice are translated;
// anything else falls through to the raw explanation.
const DECIDER_ADVICE = {
    disk_threshold: 'Every eligible node is above the configured disk watermark. Free disk space on the data nodes, or move shards to a node with capacity, before this shard can be allocated.',
    same_shard: 'A copy of this shard already exists on the remaining eligible nodes. Elasticsearch will not place a primary and its replica on the same node — the cluster needs another data node to hold this copy.',
    awareness: 'Shard allocation awareness rules prevent this copy from being placed on any available node. Check cluster.routing.allocation.awareness settings against the attributes the current nodes carry.',
    filter: 'An allocation filter excludes every eligible node. Review index.routing.allocation.* on this index and cluster.routing.allocation.* on the cluster.',
    data_tier: 'No node carries the data tier this index requires. Check the index tier preference against the roles the current nodes hold.',
    node_version: 'The remaining nodes run an older Elasticsearch version than the node this shard came from. A shard cannot move to an older node.',
    max_retry: 'Allocation failed repeatedly and Elasticsearch stopped retrying. Investigate why the earlier attempts failed; a retry has to be triggered manually once the cause is fixed.',
    throttling: 'Allocation is currently throttled because the node is already recovering other shards. This usually resolves on its own as those recoveries complete.',
    enable: 'Shard allocation is disabled by cluster.routing.allocation.enable. Allocation resumes once that setting permits it.',
    shards_limit: 'The per-node shard limit for this index has been reached on every eligible node.',
    restore_in_progress: 'The shard is being restored from a snapshot and cannot be allocated until the restore finishes.'
};

/**
 * `POST /_cluster/allocation/explain`.
 *
 * Elasticsearch's answer is a decision tree per node; what the operator needs is
 * one sentence naming the cause. This picks the deciders that returned NO and
 * translates the most specific one, keeping the raw text alongside.
 */
function parseAllocationExplain(body) {
    const b = body || {};

    const nodeDecisions = Array.isArray(b.node_allocation_decisions) ? b.node_allocation_decisions : [];

    const blockingDeciders = new Map();
    const nodes = nodeDecisions.slice(0, 50).map((entry) => {
        const e = entry || {};
        const deciders = Array.isArray(e.deciders) ? e.deciders : [];
        const no = deciders.filter((d) => String(d && d.decision).toUpperCase() === 'NO');

        for (const decider of no) {
            const name = str(decider.decider, 64);
            if (!blockingDeciders.has(name)) {
                blockingDeciders.set(name, str(decider.explanation, 600));
            }
        }

        return {
            nodeId: str(e.node_id, 64),
            nodeName: str(e.node_name, 255),
            transportAddress: str(e.transport_address, 128),
            decision: str(e.node_decision, 32),
            weightRanking: nullableNum(e.weight_ranking),
            storeAvailable: e.store ? bool(e.store.matching_sync_id) || undefined : undefined,
            deciders: no.slice(0, 6).map((d) => ({
                decider: str(d.decider, 64),
                decision: 'NO',
                explanation: str(d.explanation, 600)
            }))
        };
    });

    // The most specific blocking decider wins: `disk_threshold` explains more
    // than the generic `same_shard` that accompanies it on a small cluster.
    const priority = ['disk_threshold', 'data_tier', 'filter', 'awareness', 'node_version',
        'max_retry', 'enable', 'shards_limit', 'same_shard', 'throttling', 'restore_in_progress'];
    let primaryDecider = null;
    for (const name of priority) {
        if (blockingDeciders.has(name)) { primaryDecider = name; break; }
    }
    if (!primaryDecider && blockingDeciders.size) primaryDecider = [...blockingDeciders.keys()][0];

    const unassignedInfo = b.unassigned_info || {};

    return {
        index: str(b.index, 255),
        shard: num(b.shard),
        primary: bool(b.primary),
        currentState: str(b.current_state, 64),
        currentNode: b.current_node ? str(b.current_node.name, 255) : '',
        canAllocate: str(b.can_allocate, 32),
        allocateExplanation: str(b.allocate_explanation, 1000),
        unassignedReason: str(unassignedInfo.reason, 64),
        unassignedAt: str(unassignedInfo.at, 64),
        unassignedDetails: str(unassignedInfo.details, 512),
        lastAllocationStatus: str(unassignedInfo.last_allocation_status, 64),
        failedAllocationAttempts: num(unassignedInfo.failed_allocation_attempts),
        primaryDecider,
        // The Watchlog sentence. Never an instruction to run a command — the
        // operator decides what to change.
        recommendation: primaryDecider && DECIDER_ADVICE[primaryDecider]
            ? DECIDER_ADVICE[primaryDecider]
            : str(b.allocate_explanation, 1000) ||
            'Elasticsearch did not report a blocking decider. Verify node availability and index settings.',
        blockingDeciders: [...blockingDeciders.entries()].slice(0, 6)
            .map(([decider, explanation]) => ({ decider, explanation })),
        nodes,
        explainedAt: new Date().toISOString()
    };
}

// ── hot threads ───────────────────────────────────────────────────────────────

/**
 * `GET /_nodes/hot_threads` — a plain-text report, not JSON.
 *
 * Format, stable across 7.x–9.x:
 *   ::: {node-name}{nodeId}{...}{ip}{roles}
 *      Hot threads at ..., interval=500ms, ...
 *
 *     31.4% (157ms out of 500ms) cpu usage by thread 'elasticsearch[node][search][T#3]'
 *       10/10 snapshots sharing following 24 elements
 *         org.apache...
 */
function parseHotThreads(text) {
    if (typeof text !== 'string' || !text.trim()) return [];

    const nodes = [];
    let current = null;

    const lines = text.split('\n');

    for (const line of lines) {
        const nodeHeader = line.match(/^:::\s*\{([^}]*)\}\{([^}]*)\}/);
        if (nodeHeader) {
            current = {
                nodeName: str(nodeHeader[1], 255),
                nodeId: str(nodeHeader[2], 64),
                threads: []
            };
            nodes.push(current);
            continue;
        }

        if (!current) continue;

        // "31.4% (157ms out of 500ms) cpu usage by thread 'name'"
        const threadHeader = line.match(
            /^\s*(\d+(?:\.\d+)?)%\s*(?:\(([^)]*)\))?\s*(cpu|block|wait|mem)\s+usage by thread\s+'([^']*)'/i
        );
        if (threadHeader) {
            current.threads.push({
                percentage: nullableNum(threadHeader[1]),
                detail: str(threadHeader[2], 128),
                type: String(threadHeader[3] || 'cpu').toUpperCase(),
                thread: str(threadHeader[4], 255),
                snapshots: '',
                stack: []
            });
            continue;
        }

        const thread = current.threads[current.threads.length - 1];
        if (!thread) continue;

        const snapshots = line.match(/^\s*(\d+\/\d+\s+snapshots.*)$/);
        if (snapshots) {
            thread.snapshots = str(snapshots[1], 200);
            continue;
        }

        const frame = line.trim();
        // Stack frames are bounded: a full JVM stack is ~100 frames per thread
        // and the report covers three threads per node.
        if (frame && thread.stack.length < 25 && /^[a-zA-Z_$][\w$.]*[.(]/.test(frame)) {
            thread.stack.push(str(frame, 300));
        }
    }

    return nodes.filter((n) => n.nodeId || n.nodeName);
}

// ── data streams ──────────────────────────────────────────────────────────────

/** `GET /_data_stream` — 7.9+ only, and absent on a basic-licence 7.x cluster. */
function parseDataStreams(body) {
    const streams = Array.isArray(body && body.data_streams) ? body.data_streams : [];

    return streams.slice(0, 500).map((entry) => {
        const s = entry || {};
        const indices = Array.isArray(s.indices) ? s.indices : [];
        return {
            name: str(s.name, 255),
            timestampField: str(s.timestamp_field && s.timestamp_field.name, 128),
            generation: num(s.generation),
            status: normalizeHealthStatus(s.status),
            statusCode: healthStatusCode(s.status),
            template: str(s.template, 255),
            ilmPolicy: str(s.ilm_policy, 255),
            hidden: bool(s.hidden),
            system: bool(s.system),
            backingIndices: indices.slice(0, 200).map((i) => str(i && i.index_name, 255)).filter(Boolean),
            backingIndexCount: indices.length
        };
    }).filter((s) => s.name);
}

// ── slow log configuration ────────────────────────────────────────────────────

/**
 * `GET /*​/_settings/index.*.slowlog.*?flat_settings=true`.
 *
 * Answers "is slow logging actually turned on anywhere", which is the question
 * the UI needs. Watchlog never changes these settings — an index slow log has a
 * real cost, and enabling it is the operator's decision.
 */
function parseSlowlogSettings(body) {
    const indices = (body && typeof body === 'object') ? body : {};

    const searchIndices = [];
    const indexingIndices = [];

    for (const [name, entry] of Object.entries(indices)) {
        const settings = (entry && entry.settings) || {};
        let hasSearch = false;
        let hasIndexing = false;

        for (const [key, value] of Object.entries(settings)) {
            if (value === null || value === undefined || value === '' || String(value) === '-1') continue;
            if (key.startsWith('index.search.slowlog.threshold')) hasSearch = true;
            if (key.startsWith('index.indexing.slowlog.threshold')) hasIndexing = true;
        }

        if (hasSearch) searchIndices.push(str(name, 255));
        if (hasIndexing) indexingIndices.push(str(name, 255));
    }

    return {
        searchSlowlogConfigured: searchIndices.length > 0,
        indexingSlowlogConfigured: indexingIndices.length > 0,
        searchSlowlogIndices: searchIndices.slice(0, 50),
        indexingSlowlogIndices: indexingIndices.slice(0, 50),
        configuredIndexCount: new Set([...searchIndices, ...indexingIndices]).size
    };
}

module.exports = {
    // numeric helpers
    num,
    nullableNum,
    bool,
    str,
    counterDelta,
    perSecond,
    meanLatency,
    percentage,
    hitRate,

    // version
    parseRootInfo,
    atLeast,

    // cluster
    parseClusterHealth,
    parseClusterStats,
    normalizeHealthStatus,
    healthStatusCode,

    // nodes
    parseNodesInfo,
    parseNodesStats,
    parseNodesHeader,
    parseCatMaster,
    parseGcCollectors,
    parseThreadPools,
    parseBreakers,
    parseFilesystem,
    parseIndicesSection,

    // indices
    parseCatIndices,
    parseIndexStats,
    parseAllIndicesStats,

    // shards
    parseCatShards,
    summariseShards,

    // cluster management
    parsePendingTasks,
    parseRecovery,
    parseTasks,

    // storage pressure
    parseWatermarkValue,
    parseDiskWatermarks,
    evaluateWatermark,

    // diagnostics
    parseAllocationExplain,
    parseHotThreads,

    // optional
    parseDataStreams,
    parseSlowlogSettings,

    // constants worth sharing with tests and the collector
    DATA_ROLES,
    TIER_ROLES,
    SHARD_STATES,
    DECIDER_ADVICE,
    INTERESTING_TASK_ACTIONS
};
