// Elasticsearch API fixtures.
//
// These exist for what a live cluster cannot conveniently show you: a 7.x
// response shape on an 8.x-only lab machine, a node whose counters just reset,
// a permission-denied path, a cluster with an unassigned primary, a JVM whose
// garbage collectors are named differently, and a version that removed a field
// the parser used to read.

'use strict';

// ── version identity ──────────────────────────────────────────────────────────

const ROOT_INFO_8 = {
    name: 'es-node-1',
    cluster_name: 'production',
    cluster_uuid: 'AErlpT99Q_qZpfd65JLhzg',
    version: {
        number: '8.17.3',
        build_flavor: 'default',
        build_type: 'docker',
        build_hash: 'a091390de485bd4b127884f7e565c0cad59b10d2',
        build_date: '2025-02-28T10:07:26.089129809Z',
        build_snapshot: false,
        lucene_version: '9.12.0',
        minimum_wire_compatibility_version: '7.17.0',
        minimum_index_compatibility_version: '7.0.0'
    },
    tagline: 'You Know, for Search'
};

const ROOT_INFO_7 = {
    name: 'es7-node-1',
    cluster_name: 'legacy',
    cluster_uuid: 'B7rlpT99Q_qZpfd65JLhza',
    version: {
        number: '7.17.9',
        build_flavor: 'default',
        build_type: 'tar',
        lucene_version: '8.11.1',
        minimum_wire_compatibility_version: '6.8.0'
    },
    tagline: 'You Know, for Search'
};

const ROOT_INFO_9 = {
    name: 'es9-node-1',
    cluster_name: 'next',
    cluster_uuid: 'C9rlpT99Q_qZpfd65JLhzb',
    version: { number: '9.0.1', build_flavor: 'default', lucene_version: '10.0.0' },
    tagline: 'You Know, for Search'
};

// An OpenSearch fork answering on the same endpoint. Its 2.x version number
// would otherwise be read as an ancient Elasticsearch.
const ROOT_INFO_OPENSEARCH = {
    name: 'os-node-1',
    cluster_name: 'opensearch-cluster',
    cluster_uuid: 'D0rlpT99Q_qZpfd65JLhzc',
    version: { number: '2.11.0', distribution: 'opensearch', lucene_version: '9.7.0' },
    tagline: 'The OpenSearch Project: https://opensearch.org/'
};

// ── cluster health ────────────────────────────────────────────────────────────

// 8.x: reports unassigned_primary_shards directly.
const CLUSTER_HEALTH_RED = {
    cluster_name: 'production',
    status: 'red',
    timed_out: false,
    number_of_nodes: 3,
    number_of_data_nodes: 3,
    active_primary_shards: 40,
    active_shards: 78,
    relocating_shards: 2,
    initializing_shards: 1,
    unassigned_shards: 6,
    unassigned_primary_shards: 2,
    delayed_unassigned_shards: 0,
    number_of_pending_tasks: 4,
    number_of_in_flight_fetch: 0,
    task_max_waiting_in_queue_millis: 12000,
    active_shards_percent_as_number: 91.76
};

// 7.x: no unassigned_primary_shards field at all.
const CLUSTER_HEALTH_YELLOW_7X = {
    cluster_name: 'legacy',
    status: 'yellow',
    timed_out: false,
    number_of_nodes: 1,
    number_of_data_nodes: 1,
    active_primary_shards: 12,
    active_shards: 12,
    relocating_shards: 0,
    initializing_shards: 0,
    unassigned_shards: 12,
    delayed_unassigned_shards: 0,
    number_of_pending_tasks: 0,
    number_of_in_flight_fetch: 0,
    task_max_waiting_in_queue_millis: 0,
    active_shards_percent_as_number: 50
};

// ── cluster stats ─────────────────────────────────────────────────────────────

const CLUSTER_STATS_8 = {
    cluster_name: 'production',
    cluster_uuid: 'AErlpT99Q_qZpfd65JLhzg',
    status: 'green',
    nodes: {
        count: {
            total: 3, coordinating_only: 0, data: 0, data_cold: 0, data_content: 3,
            data_frozen: 0, data_hot: 3, data_warm: 0, ingest: 3, master: 3,
            ml: 3, remote_cluster_client: 3, transform: 3, voting_only: 0
        },
        versions: ['8.17.3'],
        os: {
            available_processors: 24, allocated_processors: 24,
            mem: { total_in_bytes: 51539607552, free_in_bytes: 8589934592, used_in_bytes: 42949672960, free_percent: 17, used_percent: 83 },
            cpu: { percent: 34 }
        },
        process: {
            cpu: { percent: 22 },
            open_file_descriptors: { min: 500, max: 900, avg: 700 }
        },
        jvm: {
            max_uptime_in_millis: 864000000,
            threads: 300,
            mem: { heap_used_in_bytes: 12884901888, heap_max_in_bytes: 25769803776 }
        },
        fs: { total_in_bytes: 1099511627776, free_in_bytes: 549755813888, available_in_bytes: 500000000000 }
    },
    indices: {
        count: 240,
        shards: { total: 480, primaries: 240, replication: 1.0 },
        docs: { count: 1500000000, deleted: 42000000 },
        store: { size_in_bytes: 549755813888, total_data_set_size_in_bytes: 549755813888 },
        segments: { count: 3200 },
        fielddata: { memory_size_in_bytes: 1073741824 },
        query_cache: { memory_size_in_bytes: 268435456 },
        completion: { size_in_bytes: 0 }
    }
};

// ── node stats ────────────────────────────────────────────────────────────────

/**
 * One healthy 8.x data node.
 *
 * `uptimeMillis` and the counters are the two things the collector tests move:
 * bumping the counters simulates traffic, dropping uptime simulates a restart.
 */
function nodeStats8({
    nodeId = 'node-a',
    name = 'es-data-01',
    uptimeMillis = 864000000,
    heapUsedPercent = 62,
    queryTotal = 100000,
    queryTimeMillis = 500000,
    indexTotal = 2000000,
    indexTimeMillis = 400000,
    gcYoungCount = 5000,
    gcYoungTime = 60000,
    gcOldCount = 12,
    gcOldTime = 9000,
    searchRejected = 0,
    parentTripped = 0,
    queryCacheHit = 900,
    queryCacheMiss = 100,
    availableBytes = 300000000000
} = {}) {
    return {
        _nodes: { total: 1, successful: 1, failed: 0 },
        cluster_name: 'production',
        nodes: {
            [nodeId]: {
                timestamp: 1786500000000,
                name,
                transport_address: '10.0.0.1:9300',
                host: '10.0.0.1',
                ip: '10.0.0.1:9300',
                roles: ['data_content', 'data_hot', 'ingest', 'master'],
                indices: {
                    docs: { count: 500000000, deleted: 12000000 },
                    store: { size_in_bytes: 180000000000, total_data_set_size_in_bytes: 180000000000, reserved_in_bytes: -1 },
                    indexing: {
                        index_total: indexTotal, index_time_in_millis: indexTimeMillis,
                        index_current: 3, index_failed: 4,
                        delete_total: 5000, delete_time_in_millis: 1200, delete_current: 0,
                        noop_update_total: 12, is_throttled: false, throttle_time_in_millis: 0
                    },
                    get: {
                        total: 90000, time_in_millis: 4500, exists_total: 88000,
                        exists_time_in_millis: 4400, missing_total: 2000,
                        missing_time_in_millis: 100, current: 0
                    },
                    search: {
                        open_contexts: 4,
                        query_total: queryTotal, query_time_in_millis: queryTimeMillis, query_current: 2,
                        fetch_total: 90000, fetch_time_in_millis: 45000, fetch_current: 1,
                        scroll_total: 120, scroll_time_in_millis: 60000, scroll_current: 0,
                        suggest_total: 0, suggest_time_in_millis: 0, suggest_current: 0
                    },
                    merges: {
                        current: 1, current_docs: 4000, current_size_in_bytes: 12000000,
                        total: 8000, total_time_in_millis: 900000, total_docs: 40000000,
                        total_size_in_bytes: 90000000000, total_stopped_time_in_millis: 0,
                        total_throttled_time_in_millis: 120000, total_auto_throttle_in_bytes: 20971520
                    },
                    refresh: {
                        total: 300000, total_time_in_millis: 600000,
                        external_total: 290000, external_total_time_in_millis: 620000, listeners: 0
                    },
                    flush: { total: 4000, periodic: 3800, total_time_in_millis: 300000 },
                    warmer: { current: 0, total: 300000, total_time_in_millis: 12000 },
                    query_cache: {
                        memory_size_in_bytes: 134217728, total_count: 1000,
                        hit_count: queryCacheHit, miss_count: queryCacheMiss,
                        cache_size: 500, cache_count: 900, evictions: 400
                    },
                    fielddata: { memory_size_in_bytes: 536870912, evictions: 0 },
                    completion: { size_in_bytes: 0 },
                    segments: {
                        count: 900, memory_in_bytes: 0, terms_memory_in_bytes: 0,
                        stored_fields_memory_in_bytes: 0, term_vectors_memory_in_bytes: 0,
                        norms_memory_in_bytes: 0, points_memory_in_bytes: 0,
                        doc_values_memory_in_bytes: 0, index_writer_memory_in_bytes: 25165824,
                        version_map_memory_in_bytes: 1048576, fixed_bit_set_memory_in_bytes: 4096
                    },
                    translog: {
                        operations: 40000, size_in_bytes: 120000000,
                        uncommitted_operations: 2000, uncommitted_size_in_bytes: 8000000,
                        earliest_last_modified_age: 4000
                    },
                    request_cache: {
                        memory_size_in_bytes: 67108864, evictions: 12,
                        hit_count: 8000, miss_count: 2000
                    },
                    recovery: { current_as_source: 0, current_as_target: 0, throttle_time_in_millis: 0 },
                    bulk: {
                        total_operations: 12000, total_time_in_millis: 60000,
                        total_size_in_bytes: 4000000000, avg_time_in_millis: 5, avg_size_in_bytes: 333333
                    }
                },
                os: {
                    cpu: { percent: 41, load_average: { '1m': 3.5, '5m': 3.1, '15m': 2.8 } },
                    mem: {
                        total_in_bytes: 17179869184, free_in_bytes: 2147483648,
                        used_in_bytes: 15032385536, free_percent: 12, used_percent: 88
                    },
                    swap: { total_in_bytes: 2147483648, free_in_bytes: 2147483648, used_in_bytes: 0 }
                },
                process: {
                    open_file_descriptors: 1200, max_file_descriptors: 65535,
                    cpu: { percent: 38, total_in_millis: 900000 },
                    mem: { total_virtual_in_bytes: 12000000000 }
                },
                jvm: {
                    timestamp: 1786500000000,
                    uptime_in_millis: uptimeMillis,
                    mem: {
                        heap_used_in_bytes: 10737418240,
                        heap_used_percent: heapUsedPercent,
                        heap_committed_in_bytes: 17179869184,
                        heap_max_in_bytes: 17179869184,
                        non_heap_used_in_bytes: 268435456,
                        non_heap_committed_in_bytes: 300000000
                    },
                    threads: { count: 120, peak_count: 150 },
                    gc: {
                        collectors: {
                            young: { collection_count: gcYoungCount, collection_time_in_millis: gcYoungTime },
                            old: { collection_count: gcOldCount, collection_time_in_millis: gcOldTime }
                        }
                    }
                },
                thread_pool: {
                    search: { threads: 13, queue: 0, active: 1, rejected: searchRejected, largest: 13, completed: 500000 },
                    write: { threads: 8, queue: 0, active: 0, rejected: 0, largest: 8, completed: 2000000 },
                    get: { threads: 8, queue: 0, active: 0, rejected: 0, largest: 8, completed: 90000 },
                    management: { threads: 5, queue: 0, active: 1, rejected: 0, largest: 5, completed: 40000 },
                    // A pool that exists but has never been used: kept only
                    // because it is on the critical list, dropped otherwise.
                    azure_event_loop: { threads: 0, queue: 0, active: 0, rejected: 0, largest: 0, completed: 0 }
                },
                fs: {
                    total: {
                        total_in_bytes: 1000000000000,
                        free_in_bytes: availableBytes + 10000000000,
                        available_in_bytes: availableBytes
                    },
                    data: [
                        {
                            path: '/var/lib/elasticsearch/nodes/0', mount: '/ (overlay)', type: 'overlay',
                            total_in_bytes: 1000000000000,
                            free_in_bytes: availableBytes + 10000000000,
                            available_in_bytes: availableBytes
                        }
                    ],
                    io_stats: {
                        total: {
                            operations: 900000, read_operations: 400000, write_operations: 500000,
                            read_kilobytes: 12000000, write_kilobytes: 24000000
                        }
                    }
                },
                transport: {
                    server_open: 26, rx_count: 900000, rx_size_in_bytes: 12000000000,
                    tx_count: 890000, tx_size_in_bytes: 11000000000
                },
                http: { current_open: 40, total_opened: 900000 },
                breakers: {
                    parent: { limit_size_in_bytes: 16333661798, estimated_size_in_bytes: 10737418240, overhead: 1.0, tripped: parentTripped },
                    fielddata: { limit_size_in_bytes: 6871947673, estimated_size_in_bytes: 536870912, overhead: 1.03, tripped: 0 },
                    request: { limit_size_in_bytes: 10307921510, estimated_size_in_bytes: 0, overhead: 1.0, tripped: 0 },
                    in_flight_requests: { limit_size_in_bytes: 17179869184, estimated_size_in_bytes: 1024, overhead: 2.0, tripped: 0 }
                }
            }
        }
    };
}

/**
 * A 7.x node stats response, where the JVM names its collectors differently and
 * `indices.bulk` does not exist at all.
 */
const NODE_STATS_7X = {
    _nodes: { total: 2, successful: 1, failed: 1, failures: [{ type: 'failed_node_exception', reason: 'node did not respond within [30s]' }] },
    cluster_name: 'legacy',
    nodes: {
        'node-legacy': {
            timestamp: 1786500000000,
            name: 'es7-data-01',
            transport_address: '10.0.1.1:9300',
            host: '10.0.1.1',
            ip: '10.0.1.1',
            roles: ['data', 'master', 'ingest'],
            indices: {
                docs: { count: 1000, deleted: 0 },
                store: { size_in_bytes: 1048576 },
                indexing: { index_total: 100, index_time_in_millis: 500, index_current: 0, index_failed: 0 },
                search: { query_total: 50, query_time_in_millis: 1000, query_current: 0, open_contexts: 0 },
                segments: {
                    count: 10, memory_in_bytes: 52428800, terms_memory_in_bytes: 41943040,
                    stored_fields_memory_in_bytes: 4194304, doc_values_memory_in_bytes: 2097152,
                    index_writer_memory_in_bytes: 0, version_map_memory_in_bytes: 0,
                    fixed_bit_set_memory_in_bytes: 0
                },
                query_cache: { memory_size_in_bytes: 0, total_count: 0, hit_count: 0, miss_count: 0, evictions: 0 },
                request_cache: { memory_size_in_bytes: 0, evictions: 0, hit_count: 0, miss_count: 0 },
                fielddata: { memory_size_in_bytes: 0, evictions: 0 },
                translog: { operations: 0, size_in_bytes: 55, uncommitted_operations: 0, uncommitted_size_in_bytes: 55 }
            },
            os: {
                // No load_average at all on this platform.
                cpu: { percent: 9 },
                mem: { total_in_bytes: 8589934592, free_in_bytes: 4294967296, used_in_bytes: 4294967296, free_percent: 50, used_percent: 50 },
                swap: { total_in_bytes: 0, free_in_bytes: 0, used_in_bytes: 0 }
            },
            process: {
                open_file_descriptors: 300, max_file_descriptors: 4096,
                cpu: { percent: 5, total_in_millis: 60000 }
            },
            jvm: {
                uptime_in_millis: 3600000,
                mem: {
                    heap_used_in_bytes: 536870912, heap_used_percent: 25,
                    heap_committed_in_bytes: 2147483648, heap_max_in_bytes: 2147483648,
                    non_heap_used_in_bytes: 134217728, non_heap_committed_in_bytes: 150000000
                },
                threads: { count: 60, peak_count: 70 },
                gc: {
                    collectors: {
                        // CMS-era names — the "old" detection has to match these.
                        ParNew: { collection_count: 400, collection_time_in_millis: 4000 },
                        ConcurrentMarkSweep: { collection_count: 8, collection_time_in_millis: 3200 }
                    }
                }
            },
            thread_pool: {
                search: { threads: 4, queue: 900, active: 4, rejected: 120, largest: 4, completed: 90000 },
                bulk: { threads: 4, queue: 0, active: 0, rejected: 6, largest: 4, completed: 40000 }
            },
            fs: {
                total: { total_in_bytes: 100000000000, free_in_bytes: 12000000000, available_in_bytes: 9000000000 },
                data: [{ path: '/data1', total_in_bytes: 50000000000, free_in_bytes: 6000000000, available_in_bytes: 4500000000 },
                       { path: '/data2', total_in_bytes: 50000000000, free_in_bytes: 6000000000, available_in_bytes: 4500000000 }]
            },
            transport: { server_open: 10, rx_count: 100, rx_size_in_bytes: 1000, tx_count: 100, tx_size_in_bytes: 1000 },
            http: { current_open: 2, total_opened: 100 },
            breakers: {
                parent: { limit_size_in_bytes: 1503238553, estimated_size_in_bytes: 536870912, overhead: 1.0, tripped: 3 },
                fielddata: { limit_size_in_bytes: 858993459, estimated_size_in_bytes: 0, overhead: 1.03, tripped: 0 }
            }
        }
    }
};

// A node that answered with no `fs` section at all — a coordinating-only node.
const NODE_STATS_COORDINATING = {
    _nodes: { total: 1, successful: 1, failed: 0 },
    nodes: {
        'node-coord': {
            name: 'es-coord-01',
            roles: [],
            indices: {},
            jvm: { uptime_in_millis: 1000, mem: { heap_used_percent: 10 }, threads: {}, gc: { collectors: {} } },
            os: { cpu: {}, mem: {}, swap: {} },
            process: { cpu: {} },
            thread_pool: {},
            breakers: {}
        }
    }
};

// ── nodes info (topology) ─────────────────────────────────────────────────────

const NODES_INFO = {
    cluster_name: 'production',
    nodes: {
        'node-a': {
            name: 'es-data-01', version: '8.17.3', build_flavor: 'default',
            roles: ['data_content', 'data_hot', 'ingest', 'master'],
            host: '10.0.0.1', ip: '10.0.0.1', transport_address: '10.0.0.1:9300',
            attributes: { zone: 'eu-west-1a' }
        },
        'node-b': {
            name: 'es-warm-01', version: '8.17.3', build_flavor: 'default',
            roles: ['data_warm'], host: '10.0.0.2', ip: '10.0.0.2',
            transport_address: '10.0.0.2:9300', attributes: { zone: 'eu-west-1b' }
        },
        'node-c': {
            name: 'es-coord-01', version: '8.17.3', build_flavor: 'default',
            roles: [], host: '10.0.0.3', ip: '10.0.0.3', transport_address: '10.0.0.3:9300'
        }
    }
};

// ── _cat responses ────────────────────────────────────────────────────────────

const CAT_INDICES = [
    {
        health: 'green', status: 'open', index: 'orders-2026.08.12',
        uuid: 'abcdefghijklmnopqrstuv', pri: '3', rep: '1',
        'docs.count': '4000000', 'docs.deleted': '1500000',
        'store.size': '80000000000', 'pri.store.size': '40000000000'
    },
    {
        health: 'yellow', status: 'open', index: 'logs-2026.08.12',
        uuid: 'bbcdefghijklmnopqrstuv', pri: '1', rep: '1',
        'docs.count': '900000', 'docs.deleted': '0',
        'store.size': '2000000000', 'pri.store.size': '2000000000'
    },
    {
        health: 'green', status: 'open', index: '.kibana_8.17.3_001',
        uuid: 'cbcdefghijklmnopqrstuv', pri: '1', rep: '0',
        'docs.count': '120', 'docs.deleted': '4',
        'store.size': '400000', 'pri.store.size': '400000'
    }
];

const CAT_SHARDS = [
    {
        index: 'orders-2026.08.12', shard: '0', prirep: 'p', state: 'STARTED',
        docs: '1300000', store: '13000000000', id: 'node-a', ip: '10.0.0.1', node: 'es-data-01'
    },
    {
        index: 'orders-2026.08.12', shard: '0', prirep: 'r', state: 'STARTED',
        docs: '1300000', store: '13000000000', id: 'node-b', ip: '10.0.0.2', node: 'es-warm-01'
    },
    {
        // Relocating: _cat has no relocation column, the arrow lives in `node`.
        index: 'orders-2026.08.12', shard: '1', prirep: 'p', state: 'RELOCATING',
        docs: '1300000', store: '13000000000', id: 'node-a', ip: '10.0.0.1',
        node: 'es-data-01 -> 10.0.0.2 xYzAbCdEfGhIjKlMnOpQ es-warm-01'
    },
    {
        index: 'orders-2026.08.12', shard: '2', prirep: 'p', state: 'UNASSIGNED',
        docs: null, store: null, id: null, ip: null, node: null,
        'unassigned.reason': 'ALLOCATION_FAILED',
        'unassigned.at': '2026-08-12T09:00:00.000Z',
        'unassigned.for': '2.4h',
        'unassigned.details': 'failed shard on node [node-c]'
    },
    {
        index: 'logs-2026.08.12', shard: '0', prirep: 'r', state: 'UNASSIGNED',
        docs: null, store: null, id: null, ip: null, node: null,
        'unassigned.reason': 'CLUSTER_RECOVERED',
        'unassigned.at': '2026-08-12T08:00:00.000Z',
        'unassigned.for': '3.4h'
    },
    {
        index: 'logs-2026.08.12', shard: '0', prirep: 'p', state: 'INITIALIZING',
        docs: '0', store: '0', id: 'node-a', ip: '10.0.0.1', node: 'es-data-01'
    }
];

const CAT_MASTER = [
    { id: 'node-a', host: '10.0.0.1', ip: '10.0.0.1', node: 'es-data-01' }
];

// ── index stats ───────────────────────────────────────────────────────────────

function indexStats({ name = 'orders-2026.08.12', queryTotal = 40000, indexTotal = 900000 } = {}) {
    const section = (multiplier) => ({
        docs: { count: 4000000 * multiplier, deleted: 1500000 * multiplier },
        store: { size_in_bytes: 40000000000 * multiplier },
        indexing: {
            index_total: indexTotal * multiplier, index_time_in_millis: 180000 * multiplier,
            index_current: 0, index_failed: 2, delete_total: 100, delete_time_in_millis: 40,
            delete_current: 0, noop_update_total: 0, throttle_time_in_millis: 0, is_throttled: false
        },
        search: {
            open_contexts: 0, query_total: queryTotal * multiplier,
            query_time_in_millis: 60000 * multiplier, query_current: 0,
            fetch_total: 30000 * multiplier, fetch_time_in_millis: 6000 * multiplier, fetch_current: 0,
            scroll_total: 0, scroll_time_in_millis: 0, scroll_current: 0,
            suggest_total: 0, suggest_time_in_millis: 0, suggest_current: 0
        },
        get: { total: 0, time_in_millis: 0, current: 0, exists_total: 0, exists_time_in_millis: 0, missing_total: 0, missing_time_in_millis: 0 },
        merges: {
            current: 0, current_docs: 0, current_size_in_bytes: 0, total: 400, total_time_in_millis: 90000,
            total_docs: 4000000, total_size_in_bytes: 9000000000,
            total_stopped_time_in_millis: 0, total_throttled_time_in_millis: 12000, total_auto_throttle_in_bytes: 20971520
        },
        refresh: { total: 12000, total_time_in_millis: 24000, external_total: 11000, external_total_time_in_millis: 25000, listeners: 0 },
        flush: { total: 400, periodic: 380, total_time_in_millis: 12000 },
        warmer: { current: 0, total: 12000, total_time_in_millis: 1200 },
        query_cache: { memory_size_in_bytes: 4194304, total_count: 900, hit_count: 800, miss_count: 100, cache_size: 40, cache_count: 90, evictions: 4 },
        fielddata: { memory_size_in_bytes: 0, evictions: 0 },
        completion: { size_in_bytes: 0 },
        segments: { count: 120, memory_in_bytes: 0, index_writer_memory_in_bytes: 4194304, version_map_memory_in_bytes: 0, fixed_bit_set_memory_in_bytes: 0 },
        translog: { operations: 4000, size_in_bytes: 12000000, uncommitted_operations: 100, uncommitted_size_in_bytes: 400000, earliest_last_modified_age: 900 },
        request_cache: { memory_size_in_bytes: 1048576, evictions: 0, hit_count: 400, miss_count: 100 },
        recovery: { current_as_source: 0, current_as_target: 0, throttle_time_in_millis: 0 }
    });

    return {
        _shards: { total: 6, successful: 6, failed: 0 },
        _all: { primaries: section(1), total: section(2) },
        indices: {
            [name]: {
                uuid: 'abcdefghijklmnopqrstuv',
                health: 'green',
                status: 'open',
                primaries: section(1),
                total: section(2)
            }
        }
    };
}

// ── cluster management ────────────────────────────────────────────────────────

const PENDING_TASKS = {
    tasks: [
        { insert_order: 101, priority: 'URGENT', source: 'shard-failed', executing: true, time_in_queue_millis: 45000, time_in_queue: '45s' },
        { insert_order: 102, priority: 'HIGH', source: 'create-index [orders-2026.08.13]', executing: false, time_in_queue_millis: 12000, time_in_queue: '12s' },
        { insert_order: 103, priority: 'NORMAL', source: 'cluster_reroute(async_shard_fetch)', executing: false, time_in_queue_millis: 400, time_in_queue: '400ms' }
    ]
};

const RECOVERY = {
    'orders-2026.08.12': {
        shards: [
            {
                id: 1, type: 'PEER', stage: 'INDEX', primary: false,
                start_time_in_millis: 1786499000000, total_time_in_millis: 90000,
                source: { id: 'node-a', host: '10.0.0.1', name: 'es-data-01' },
                target: { id: 'node-b', host: '10.0.0.2', name: 'es-warm-01' },
                index: {
                    size: { total_in_bytes: 13000000000, reused_in_bytes: 0, recovered_in_bytes: 6500000000, percent: '50.0%' },
                    files: { total: 120, reused: 0, recovered: 60, percent: '50.0%' }
                },
                translog: { recovered: 0, total: 0, percent: '-1.0%' },
                verify_index: { check_index_time_in_millis: 0, total_time_in_millis: 0 }
            }
        ]
    }
};

const TASKS = {
    tasks: [
        {
            node: 'node-a', id: 4242, type: 'transport',
            action: 'indices:data/write/reindex',
            description: 'reindex from [orders-old] to [orders-2026.08.12]',
            start_time_in_millis: 1786499000000, running_time_in_nanos: 900000000000,
            cancellable: true, cancelled: false,
            status: { total: 4000000, created: 1200000, updated: 0, deleted: 0, batches: 1200 }
        },
        {
            // Below the minimum running time: a normal in-flight search, not
            // long-running work anyone wants stored as an event.
            node: 'node-a', id: 4243, type: 'transport',
            action: 'indices:data/read/search', description: 'shard search',
            start_time_in_millis: 1786499990000, running_time_in_nanos: 12000000,
            cancellable: true, cancelled: false
        },
        {
            // Not an action Watchlog tracks at all.
            node: 'node-b', id: 4244, type: 'transport',
            action: 'cluster:monitor/nodes/stats', description: '',
            start_time_in_millis: 1786499000000, running_time_in_nanos: 900000000000,
            cancellable: false, cancelled: false
        }
    ]
};

// ── cluster settings (disk watermarks) ────────────────────────────────────────

const CLUSTER_SETTINGS_DEFAULT = {
    persistent: {},
    transient: {},
    defaults: {
        'cluster.routing.allocation.disk.threshold_enabled': 'true',
        'cluster.routing.allocation.disk.watermark.low': '85%',
        'cluster.routing.allocation.disk.watermark.high': '90%',
        'cluster.routing.allocation.disk.watermark.flood_stage': '95%',
        'cluster.routing.allocation.disk.watermark.flood_stage.frozen': '95%'
    }
};

// An operator who moved the watermarks and expressed them as absolute sizes.
const CLUSTER_SETTINGS_CUSTOM = {
    persistent: {
        'cluster.routing.allocation.disk.watermark.low': '200gb',
        'cluster.routing.allocation.disk.watermark.high': '100gb',
        'cluster.routing.allocation.disk.watermark.flood_stage': '20gb'
    },
    transient: {},
    defaults: {
        'cluster.routing.allocation.disk.threshold_enabled': 'true',
        'cluster.routing.allocation.disk.watermark.low': '85%',
        'cluster.routing.allocation.disk.watermark.high': '90%',
        'cluster.routing.allocation.disk.watermark.flood_stage': '95%'
    }
};

// ── allocation explain ────────────────────────────────────────────────────────

const ALLOCATION_EXPLAIN_DISK = {
    index: 'orders-2026.08.12',
    shard: 2,
    primary: true,
    current_state: 'unassigned',
    unassigned_info: {
        reason: 'ALLOCATION_FAILED',
        at: '2026-08-12T09:00:00.000Z',
        failed_allocation_attempts: 5,
        details: 'failed shard on node [node-c]',
        last_allocation_status: 'no'
    },
    can_allocate: 'no',
    allocate_explanation: 'Elasticsearch is not allowed to allocate this shard to any of the nodes in the cluster.',
    node_allocation_decisions: [
        {
            node_id: 'node-a', node_name: 'es-data-01', transport_address: '10.0.0.1:9300',
            node_decision: 'no', weight_ranking: 1,
            deciders: [
                { decider: 'disk_threshold', decision: 'NO', explanation: 'the node is above the high watermark cluster setting [cluster.routing.allocation.disk.watermark.high=90%]' },
                { decider: 'same_shard', decision: 'NO', explanation: 'a copy of this shard is already allocated to this node' }
            ]
        },
        {
            node_id: 'node-b', node_name: 'es-warm-01', transport_address: '10.0.0.2:9300',
            node_decision: 'no', weight_ranking: 2,
            deciders: [
                { decider: 'disk_threshold', decision: 'NO', explanation: 'the node is above the high watermark cluster setting' }
            ]
        }
    ]
};

// ── hot threads ───────────────────────────────────────────────────────────────

const HOT_THREADS_TEXT = `::: {es-data-01}{node-a}{S0mE-EpHeMeRaL}{10.0.0.1}{10.0.0.1:9300}{cdfhilmrstw}
   Hot threads at 2026-08-12T10:00:00.000Z, interval=500ms, busiestThreads=3, ignoreIdleThreads=true:

   61.4% (307ms out of 500ms) cpu usage by thread 'elasticsearch[es-data-01][search][T#3]'
     10/10 snapshots sharing following 24 elements
       org.apache.lucene.search.IndexSearcher.search(IndexSearcher.java:521)
       org.elasticsearch.search.query.QueryPhase.searchWithCollector(QueryPhase.java:302)
       java.base@21.0.1/java.lang.Thread.run(Thread.java:1583)

   12.0% (60ms out of 500ms) cpu usage by thread 'elasticsearch[es-data-01][write][T#1]'
     4/10 snapshots sharing following 12 elements
       org.elasticsearch.index.engine.InternalEngine.index(InternalEngine.java:930)

::: {es-warm-01}{node-b}{An0tHeR-Id}{10.0.0.2}{10.0.0.2:9300}{dw}
   Hot threads at 2026-08-12T10:00:00.000Z, interval=500ms, busiestThreads=3, ignoreIdleThreads=true:

   3.1% (15ms out of 500ms) block usage by thread 'elasticsearch[es-warm-01][management][T#2]'
     2/10 snapshots sharing following 4 elements
       org.elasticsearch.common.util.concurrent.EsThreadPoolExecutor.execute(EsThreadPoolExecutor.java:80)
`;

// ── data streams ──────────────────────────────────────────────────────────────

const DATA_STREAMS = {
    data_streams: [
        {
            name: 'logs-app-default',
            timestamp_field: { name: '@timestamp' },
            indices: [
                { index_name: '.ds-logs-app-default-2026.08.11-000001', index_uuid: 'aaa' },
                { index_name: '.ds-logs-app-default-2026.08.12-000002', index_uuid: 'bbb' }
            ],
            generation: 2,
            status: 'GREEN',
            template: 'logs',
            ilm_policy: 'logs',
            hidden: false,
            system: false
        }
    ]
};

// ── slowlog settings ──────────────────────────────────────────────────────────

const SLOWLOG_SETTINGS = {
    'orders-2026.08.12': {
        settings: {
            'index.search.slowlog.threshold.query.warn': '10s',
            'index.search.slowlog.threshold.fetch.warn': '1s',
            'index.indexing.slowlog.threshold.index.warn': '10s'
        }
    },
    'logs-2026.08.12': {
        settings: {
            // Explicitly disabled: -1 must not count as configured.
            'index.search.slowlog.threshold.query.warn': '-1'
        }
    }
};

// ── slow log lines ────────────────────────────────────────────────────────────

const SLOWLOG_LINES = {
    // 7.x plain text, search query phase.
    searchText7: '[2026-08-12T10:00:00,123][WARN ][i.s.s.query              ] [es-data-01] [orders-2026.08.12][0] took[1.2s], took_millis[1200], total_hits[482 hits], types[], stats[], search_type[QUERY_THEN_FETCH], total_shards[3], source[{"query":{"bool":{"must":[{"match":{"customer":"acme"}}]}}}], id[],',

    // 8.x plain text, fetch phase — a different logger, so a different phase.
    fetchText8: '[2026-08-12T10:00:01,500][WARN ][i.s.s.fetch              ] [es-data-01] [orders-2026.08.12][1] took[800ms], took_millis[800], id[], search_type[QUERY_THEN_FETCH], total_shards[3], source[{"query":{"match_all":{}}}]',

    // 7.x plain text, indexing.
    indexingText7: '[2026-08-12T10:00:02,000][WARN ][i.i.s.index              ] [es-data-01] [orders-2026.08.12/abcdefghijklmnopqrstuv][2] took[600ms], took_millis[600], type[_doc], id[order-12345], routing[], source[{"customer":"acme","total":42,"password":"hunter2"}]',

    // 7.x JSON.
    searchJson7: JSON.stringify({
        type: 'index_search_slowlog',
        timestamp: '2026-08-12T10:00:03,700+0000',
        level: 'WARN',
        component: 'i.s.s.query',
        'cluster.name': 'production',
        'node.name': 'es-data-01',
        message: '[orders-2026.08.12][0]',
        took: '2.1s',
        took_millis: '2100',
        total_hits: '1000+ hits',
        search_type: 'QUERY_THEN_FETCH',
        total_shards: '3',
        source: '{"query":{"term":{"status":"open"}}}',
        'cluster.uuid': 'AErlpT99Q_qZpfd65JLhzg',
        'node.id': 'node-a'
    }),

    // 8.x/9.x ECS JSON.
    searchEcs8: JSON.stringify({
        '@timestamp': '2026-08-12T10:00:04.900Z',
        'log.level': 'WARN',
        'elasticsearch.slowlog.id': null,
        'elasticsearch.slowlog.message': '[orders-2026.08.12][2]',
        'elasticsearch.slowlog.search_type': 'QUERY_THEN_FETCH',
        'elasticsearch.slowlog.source': '{"query":{"range":{"@timestamp":{"gte":"now-1d"}}},"api_key":"AAAAB3NzaC1yc2EAAAADAQ"}',
        'elasticsearch.slowlog.took': '3.4s',
        'elasticsearch.slowlog.took_millis': 3400,
        'elasticsearch.slowlog.total_hits': '9000 hits',
        'elasticsearch.slowlog.total_shards': 3,
        'event.dataset': 'elasticsearch.index_search_slowlog',
        'log.logger': 'index.search.slowlog.query',
        'elasticsearch.cluster.name': 'production',
        'elasticsearch.node.id': 'node-a',
        'elasticsearch.node.name': 'es-data-01'
    }),

    // 8.x ECS indexing.
    indexingEcs8: JSON.stringify({
        '@timestamp': '2026-08-12T10:00:05.100Z',
        'log.level': 'WARN',
        'elasticsearch.slowlog.id': 'user@example.com',
        'elasticsearch.slowlog.message': '[orders-2026.08.12][1]',
        'elasticsearch.slowlog.source': '{"customer":"acme","secret_token":"abcdef123456"}',
        'elasticsearch.slowlog.took': '900ms',
        'elasticsearch.slowlog.took_millis': 900,
        'event.dataset': 'elasticsearch.index_indexing_slowlog',
        'log.logger': 'index.indexing.slowlog.index',
        'elasticsearch.node.name': 'es-data-01'
    }),

    // Lines that must be ignored rather than guessed at.
    garbage: 'this is not a slowlog line at all',
    truncatedJson: '{"@timestamp":"2026-08-12T10:00:06.000Z","elasticsearch.slowlog.took_mil',
    // A non-slowlog entry that happens to sit in the same file.
    otherLogger: JSON.stringify({
        '@timestamp': '2026-08-12T10:00:07.000Z',
        'log.level': 'INFO',
        'event.dataset': 'elasticsearch.server',
        message: 'starting up'
    })
};

module.exports = {
    ROOT_INFO_8, ROOT_INFO_7, ROOT_INFO_9, ROOT_INFO_OPENSEARCH,
    CLUSTER_HEALTH_RED, CLUSTER_HEALTH_YELLOW_7X,
    CLUSTER_STATS_8,
    nodeStats8, NODE_STATS_7X, NODE_STATS_COORDINATING,
    NODES_INFO, CAT_INDICES, CAT_SHARDS, CAT_MASTER,
    indexStats,
    PENDING_TASKS, RECOVERY, TASKS,
    CLUSTER_SETTINGS_DEFAULT, CLUSTER_SETTINGS_CUSTOM,
    ALLOCATION_EXPLAIN_DISK, HOT_THREADS_TEXT,
    DATA_STREAMS, SLOWLOG_SETTINGS, SLOWLOG_LINES
};
