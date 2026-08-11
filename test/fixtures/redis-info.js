// Captured Redis INFO output used by the parser tests.
//
// These are real replies (trimmed to the fields we read) rather than
// hand-written objects, so the tests exercise the actual text format —
// including the \r\n line endings Redis emits, which a hand-rolled fixture
// would quietly omit.

'use strict';

// Redis 7.2 standalone, no maxmemory, AOF on.
const STANDALONE_INFO = [
    '# Server',
    'redis_version:7.2.5',
    'redis_mode:standalone',
    'os:Darwin 25.5.0 arm64',
    'process_id:712',
    'run_id:4fef586d084699b6540a15e21a6ff1488e6bce31',
    'tcp_port:6379',
    'uptime_in_seconds:4030',
    'uptime_in_days:0',
    'hz:10',
    'configured_hz:10',
    'executable:/opt/homebrew/opt/redis/bin/redis-server',
    '',
    '# Clients',
    'connected_clients:4',
    'cluster_connections:0',
    'maxclients:10000',
    'blocked_clients:0',
    'tracking_clients:0',
    '',
    '# Memory',
    'used_memory:1558432',
    'used_memory_rss:24576000',
    'used_memory_peak:43237168',
    'used_memory_overhead:1200000',
    'used_memory_dataset:358432',
    'used_memory_lua:0',
    'used_memory_scripts:0',
    'allocator_allocated:1600000',
    'allocator_active:1700000',
    'allocator_resident:2000000',
    'maxmemory:0',
    'maxmemory_policy:noeviction',
    'mem_fragmentation_ratio:16.19',
    'mem_fragmentation_bytes:23017568',
    'lazyfree_pending_objects:0',
    '',
    '# Persistence',
    'loading:0',
    'rdb_changes_since_last_save:0',
    'rdb_bgsave_in_progress:0',
    'rdb_last_save_time:1786450000',
    'rdb_last_bgsave_status:ok',
    'rdb_last_bgsave_time_sec:0',
    'aof_enabled:1',
    'aof_rewrite_in_progress:0',
    'aof_last_bgrewrite_status:ok',
    'aof_last_write_status:ok',
    'aof_current_size:1024',
    'aof_base_size:512',
    'aof_pending_bio_fsync:0',
    'aof_delayed_fsync:0',
    '',
    '# Stats',
    'total_connections_received:495',
    'total_commands_processed:201039',
    'instantaneous_ops_per_sec:3',
    'total_net_input_bytes:3924836',
    'total_net_output_bytes:4259833',
    'instantaneous_input_kbps:0.15',
    'instantaneous_output_kbps:0.30',
    'rejected_connections:0',
    'expired_keys:1',
    'evicted_keys:0',
    'keyspace_hits:900',
    'keyspace_misses:100',
    'pubsub_channels:0',
    'pubsub_patterns:0',
    'total_reads_processed:2248',
    'total_writes_processed:2247',
    'total_error_replies:3',
    '',
    '# Replication',
    'role:master',
    'connected_slaves:0',
    'master_replid:8a1b2c3d4e5f',
    'master_repl_offset:0',
    'repl_backlog_active:0',
    'repl_backlog_size:1048576',
    'repl_backlog_histlen:0',
    '',
    '# CPU',
    'used_cpu_sys:12.5',
    'used_cpu_user:8.25',
    'used_cpu_sys_children:0.1',
    'used_cpu_user_children:0.2',
    'used_cpu_sys_main_thread:12.0',
    'used_cpu_user_main_thread:8.0',
    '',
    '# Cluster',
    'cluster_enabled:0',
    '',
    '# Keyspace',
    'db0:keys=1200,expires=400,avg_ttl=450000',
    'db1:keys=50,expires=0,avg_ttl=0'
].join('\r\n');

// A primary with two replicas, one of which is still syncing.
const PRIMARY_INFO = [
    '# Server',
    'redis_version:7.2.5',
    'redis_mode:standalone',
    'run_id:primary000000000000000000000000000000',
    'uptime_in_seconds:100000',
    '',
    '# Replication',
    'role:master',
    'connected_slaves:2',
    'slave0:ip=10.0.0.11,port=6379,state=online,offset=889000,lag=0',
    'slave1:ip=10.0.0.12,port=6379,state=send_bulk,offset=0,lag=1',
    'master_replid:aaaa',
    'master_repl_offset:900000',
    'repl_backlog_active:1',
    'repl_backlog_size:1048576',
    'repl_backlog_histlen:900000',
    '',
    '# Keyspace',
    'db0:keys=10,expires=2,avg_ttl=1000'
].join('\r\n');

// A replica whose link to the primary is down.
const REPLICA_INFO = [
    '# Server',
    'redis_version:6.2.14',
    'redis_mode:standalone',
    'run_id:replica00000000000000000000000000000',
    'uptime_in_seconds:5000',
    '',
    '# Replication',
    'role:slave',
    'master_host:10.0.0.1',
    'master_port:6379',
    'master_link_status:down',
    'master_last_io_seconds_ago:42',
    'master_sync_in_progress:0',
    'slave_read_repl_offset:880000',
    'slave_repl_offset:880000',
    'slave_priority:100',
    'slave_read_only:1',
    'connected_slaves:0',
    'master_repl_offset:880000'
].join('\r\n');

// maxmemory configured with an eviction policy, and evictions happening.
const MAXMEMORY_INFO = [
    '# Server',
    'redis_version:7.0.11',
    'redis_mode:standalone',
    'run_id:capped0000000000000000000000000000000',
    'uptime_in_seconds:900',
    '',
    '# Memory',
    'used_memory:900000000',
    'used_memory_rss:950000000',
    'used_memory_peak:980000000',
    'used_memory_dataset:850000000',
    'used_memory_overhead:50000000',
    'maxmemory:1000000000',
    'maxmemory_policy:allkeys-lru',
    'mem_fragmentation_ratio:1.05',
    '',
    '# Stats',
    'evicted_keys:5000',
    'expired_keys:100',
    'keyspace_hits:8000',
    'keyspace_misses:2000',
    '',
    '# Keyspace',
    'db0:keys=500000,expires=500000,avg_ttl=60000'
].join('\r\n');

const COMMANDSTATS = [
    '# Commandstats',
    'cmdstat_get:calls=100000,usec=120000,usec_per_call=1.20,rejected_calls=0,failed_calls=0',
    'cmdstat_set:calls=50000,usec=95000,usec_per_call=1.90,rejected_calls=2,failed_calls=1',
    'cmdstat_keys:calls=3,usec=900000,usec_per_call=300000.00,rejected_calls=0,failed_calls=0',
    'cmdstat_client|list:calls=5,usec=250,usec_per_call=50.00,rejected_calls=0,failed_calls=0'
].join('\r\n');

const CLUSTER_INFO_OK = [
    'cluster_enabled:1',
    'cluster_state:ok',
    'cluster_slots_assigned:16384',
    'cluster_slots_ok:16384',
    'cluster_slots_pfail:0',
    'cluster_slots_fail:0',
    'cluster_known_nodes:6',
    'cluster_size:3',
    'cluster_current_epoch:6',
    'cluster_my_epoch:1'
].join('\r\n');

const CLUSTER_INFO_DEGRADED = [
    'cluster_enabled:1',
    'cluster_state:fail',
    'cluster_slots_assigned:12000',
    'cluster_slots_ok:11000',
    'cluster_slots_pfail:500',
    'cluster_slots_fail:500',
    'cluster_known_nodes:6',
    'cluster_size:3'
].join('\r\n');

// Real CLUSTER NODES output: 3 primaries, 3 replicas, one flagged fail?.
const CLUSTER_NODES = [
    'a1b2 10.0.0.1:6379@16379 myself,master - 0 1786450000000 1 connected 0-5460',
    'c3d4 10.0.0.2:6379@16379 master - 0 1786450001000 2 connected 5461-10922',
    'e5f6 10.0.0.3:6379@16379 master - 0 1786450002000 3 connected 10923-16383',
    '1122 10.0.0.4:6379@16379 slave a1b2 0 1786450003000 1 connected',
    '3344 10.0.0.5:6379@16379 slave,fail? c3d4 0 1786450004000 2 connected',
    '5566 10.0.0.6:6379@16379 slave,fail e5f6 0 1786450005000 3 disconnected'
].join('\n');

// SLOWLOG GET under `redis-cli --json`.
const SLOWLOG_JSON = JSON.stringify([
    [12, 1786450837, 211861, ['EVAL', 'return 1', '0'], '127.0.0.1:53275', ''],
    [11, 1786450800, 15000, ['SET', 'user:token', 'super-secret-value'], '10.0.0.9:5000', 'worker-1'],
    [10, 1786450700, 9000, ['AUTH', 'hunter2'], '10.0.0.9:5001', ''],
    [9, 1786450600, 8000, ['LRANGE', 'queue:jobs', '0', '-1'], '10.0.0.9:5002', 'reader']
]);

const CONFIG_GET_RESP3 = JSON.stringify({
    'slowlog-log-slower-than': '10000',
    'slowlog-max-len': '128'
});

const CONFIG_GET_RESP2 = JSON.stringify([
    'slowlog-log-slower-than', '10000',
    'slowlog-max-len', '128'
]);

const NOPERM_ERROR = "NOPERM User redis has no permissions to run the 'slowlog' command";
const CLUSTER_DISABLED_ERROR = 'ERR This instance has cluster support disabled';

module.exports = {
    STANDALONE_INFO,
    PRIMARY_INFO,
    REPLICA_INFO,
    MAXMEMORY_INFO,
    COMMANDSTATS,
    CLUSTER_INFO_OK,
    CLUSTER_INFO_DEGRADED,
    CLUSTER_NODES,
    SLOWLOG_JSON,
    CONFIG_GET_RESP3,
    CONFIG_GET_RESP2,
    NOPERM_ERROR,
    CLUSTER_DISABLED_ERROR
};
