// Captured PostgreSQL statistics rows, shaped exactly as the `pg` driver hands
// them back: bigint and numeric columns arrive as strings, intervals as numbers
// of seconds (the queries already EXTRACT(EPOCH ...)), booleans as booleans.
//
// The version-specific rows here are the point of the file: a live server can
// only demonstrate its own release, so 9.6, 13, 14 and 17 shapes have to come
// from fixtures.

'use strict';

// ── server identity ───────────────────────────────────────────────────────────

const SERVER_INFO_15 = {
    server_version: '15.4',
    server_version_num: '150004',
    version_full: 'PostgreSQL 15.4 on aarch64-unknown-linux-musl, compiled by gcc',
    current_database: 'postgres',
    in_recovery: false,
    uptime_seconds: '86400',
    max_connections: '100',
    shared_buffers: '128MB',
    effective_cache_size: '4GB',
    work_mem: '4MB',
    maintenance_work_mem: '64MB',
    autovacuum: 'on',
    track_io_timing: 'off',
    track_activity_query_size: '1024',
    default_transaction_isolation: 'read committed'
};

const SERVER_INFO_96 = Object.assign({}, SERVER_INFO_15, {
    server_version: '9.6.24',
    server_version_num: '90624',
    version_full: 'PostgreSQL 9.6.24 on x86_64-pc-linux-gnu',
    autovacuum: 'off'
});

const SERVER_INFO_REPLICA = Object.assign({}, SERVER_INFO_15, { in_recovery: true });

// ── connections (pg_stat_activity, grouped) ───────────────────────────────────

const CONNECTION_ROWS = [
    { database: 'shop', state: 'active', count: '6', waiting: '2', max_xact_seconds: '12.5', max_query_seconds: '11.2', max_state_seconds: '11.2' },
    { database: 'shop', state: 'idle', count: '18', waiting: '0', max_xact_seconds: '0', max_query_seconds: '0', max_state_seconds: '340' },
    { database: 'shop', state: 'idle in transaction', count: '3', waiting: '0', max_xact_seconds: '620.4', max_query_seconds: '0.4', max_state_seconds: '600.1' },
    { database: 'shop', state: 'idle in transaction (aborted)', count: '1', waiting: '0', max_xact_seconds: '95', max_query_seconds: '0.1', max_state_seconds: '90' },
    { database: 'analytics', state: 'active', count: '2', waiting: '0', max_xact_seconds: '300.9', max_query_seconds: '300.9', max_state_seconds: '300.9' },
    { database: 'analytics', state: 'fastpath function call', count: '1', waiting: '0', max_xact_seconds: '0', max_query_seconds: '0', max_state_seconds: '0' }
];

// ── pg_stat_database ──────────────────────────────────────────────────────────

const DATABASE_ROWS_T1 = [
    {
        database: 'shop', numbackends: '28',
        xact_commit: '1000000', xact_rollback: '5000',
        blks_read: '400000', blks_hit: '39600000',
        tup_returned: '90000000', tup_fetched: '20000000',
        tup_inserted: '1500000', tup_updated: '800000', tup_deleted: '120000',
        conflicts: '0', temp_files: '20', temp_bytes: '104857600', deadlocks: '2',
        blk_read_time: '1200.5', blk_write_time: '300.25',
        session_time: '900000', active_time: '400000', idle_in_transaction_time: '50000',
        sessions: '1200', sessions_abandoned: '3', sessions_fatal: '0', sessions_killed: '1',
        database_size: '5368709120'
    },
    {
        database: 'analytics', numbackends: '3',
        xact_commit: '20000', xact_rollback: '10',
        blks_read: '2000000', blks_hit: '2000000',
        tup_returned: '500000000', tup_fetched: '400000000',
        tup_inserted: '10', tup_updated: '0', tup_deleted: '0',
        conflicts: '0', temp_files: '400', temp_bytes: '10737418240', deadlocks: '0',
        blk_read_time: '90000', blk_write_time: '10',
        session_time: null, active_time: null, idle_in_transaction_time: null,
        sessions: null, sessions_abandoned: null, sessions_fatal: null, sessions_killed: null,
        database_size: '107374182400'
    }
];

// One minute later: shop took 6000 commits, 200 rollbacks, 40k block accesses.
const DATABASE_ROWS_T2 = [
    Object.assign({}, DATABASE_ROWS_T1[0], {
        xact_commit: '1006000', xact_rollback: '5200',
        blks_read: '404000', blks_hit: '39636000',
        tup_inserted: '1503000', tup_updated: '801000', tup_deleted: '120500',
        temp_files: '22', temp_bytes: '115343360', deadlocks: '3',
        database_size: '5379194880'
    }),
    Object.assign({}, DATABASE_ROWS_T1[1])
];

// A statistics reset: every counter is lower than the previous sample.
const DATABASE_ROWS_AFTER_RESET = [
    Object.assign({}, DATABASE_ROWS_T1[0], {
        xact_commit: '120', xact_rollback: '0',
        blks_read: '400', blks_hit: '9600',
        tup_inserted: '10', tup_updated: '5', tup_deleted: '0',
        temp_files: '0', temp_bytes: '0', deadlocks: '0'
    })
];

// An idle database: no block was touched at all between samples.
const DATABASE_ROWS_IDLE = [
    Object.assign({}, DATABASE_ROWS_T1[0])
];

// ── pg_stat_statements ────────────────────────────────────────────────────────

const STATEMENT_ROWS_T1 = [
    {
        queryid: '-4207345678901234567', database: 'shop',
        query: 'SELECT id, total FROM orders WHERE customer_id = $1 AND status = $2',
        calls: '50000', total_exec_time: '100000', mean_exec_time: '2', min_exec_time: '0.4',
        max_exec_time: '85', stddev_exec_time: '3.1', rows: '150000',
        shared_blks_hit: '2000000', shared_blks_read: '1000', shared_blks_dirtied: '0', shared_blks_written: '0',
        local_blks_hit: '0', local_blks_read: '0', local_blks_dirtied: '0', local_blks_written: '0',
        temp_blks_read: '0', temp_blks_written: '0',
        blk_read_time: '10', blk_write_time: '0', temp_blk_read_time: '0', temp_blk_write_time: '0',
        wal_records: '0', wal_fpi: '0', wal_bytes: '0',
        plans: '0', total_plan_time: '0', mean_plan_time: '0', max_plan_time: '0'
    },
    {
        queryid: '881234567890123456', database: 'analytics',
        query: 'SELECT date_trunc($1, created_at), count(*) FROM events GROUP BY $2',
        calls: '400', total_exec_time: '1600000', mean_exec_time: '4000', min_exec_time: '2500',
        max_exec_time: '9800', stddev_exec_time: '900', rows: '4000',
        shared_blks_hit: '100000', shared_blks_read: '3000000', shared_blks_dirtied: '0', shared_blks_written: '0',
        local_blks_hit: '0', local_blks_read: '0', local_blks_dirtied: '0', local_blks_written: '0',
        temp_blks_read: '900000', temp_blks_written: '900000',
        blk_read_time: '400000', blk_write_time: '20', temp_blk_read_time: '1000', temp_blk_write_time: '2000',
        wal_records: '0', wal_fpi: '0', wal_bytes: '0',
        plans: '400', total_plan_time: '800', mean_plan_time: '2', max_plan_time: '9'
    },
    {
        // The agent reading the statistics views. Must be filtered out.
        queryid: '111111111111111111', database: 'postgres',
        query: 'SELECT * FROM pg_stat_database WHERE datname IS NOT NULL',
        calls: '1440', total_exec_time: '2880', mean_exec_time: '2', min_exec_time: '1',
        max_exec_time: '9', stddev_exec_time: '1', rows: '14400',
        shared_blks_hit: '1000', shared_blks_read: '0', shared_blks_dirtied: '0', shared_blks_written: '0',
        local_blks_hit: '0', local_blks_read: '0', local_blks_dirtied: '0', local_blks_written: '0',
        temp_blks_read: '0', temp_blks_written: '0',
        blk_read_time: '0', blk_write_time: '0', temp_blk_read_time: '0', temp_blk_write_time: '0',
        wal_records: '0', wal_fpi: '0', wal_bytes: '0',
        plans: '0', total_plan_time: '0', mean_plan_time: '0', max_plan_time: '0'
    },
    {
        // The capability probe. Also filtered.
        queryid: '222222222222222222', database: 'postgres',
        query: 'SELECT to_regclass($1) IS NOT NULL AS present',
        calls: '1440', total_exec_time: '720', mean_exec_time: '0.5', min_exec_time: '0.2',
        max_exec_time: '3', stddev_exec_time: '0.3', rows: '1440',
        shared_blks_hit: '0', shared_blks_read: '0', shared_blks_dirtied: '0', shared_blks_written: '0',
        local_blks_hit: '0', local_blks_read: '0', local_blks_dirtied: '0', local_blks_written: '0',
        temp_blks_read: '0', temp_blks_written: '0',
        blk_read_time: '0', blk_write_time: '0', temp_blk_read_time: '0', temp_blk_write_time: '0',
        wal_records: '0', wal_fpi: '0', wal_bytes: '0',
        plans: '0', total_plan_time: '0', mean_plan_time: '0', max_plan_time: '0'
    },
    {
        // pg_stat_statements hides text the role may not read.
        queryid: '333333333333333333', database: 'shop',
        query: '<insufficient privilege>',
        calls: '10', total_exec_time: '50', mean_exec_time: '5', min_exec_time: '1',
        max_exec_time: '20', stddev_exec_time: '4', rows: '10',
        shared_blks_hit: '10', shared_blks_read: '0', shared_blks_dirtied: '0', shared_blks_written: '0',
        local_blks_hit: '0', local_blks_read: '0', local_blks_dirtied: '0', local_blks_written: '0',
        temp_blks_read: '0', temp_blks_written: '0',
        blk_read_time: '0', blk_write_time: '0', temp_blk_read_time: '0', temp_blk_write_time: '0',
        wal_records: '0', wal_fpi: '0', wal_bytes: '0',
        plans: '0', total_plan_time: '0', mean_plan_time: '0', max_plan_time: '0'
    }
];

// A minute later. The cheap query ran 10k more times at ~2ms (20s of database
// time); the report ran 2 more times at ~5s each (10s). Impact must rank the
// cheap query first even though the report is 2500x slower per call.
const STATEMENT_ROWS_T2 = [
    Object.assign({}, STATEMENT_ROWS_T1[0], {
        calls: '60000', total_exec_time: '120000', rows: '180000',
        shared_blks_hit: '2400000', shared_blks_read: '1100'
    }),
    Object.assign({}, STATEMENT_ROWS_T1[1], {
        calls: '402', total_exec_time: '1610000', rows: '4020',
        shared_blks_read: '3010000', temp_blks_written: '905000'
    }),
    STATEMENT_ROWS_T1[2], STATEMENT_ROWS_T1[3], STATEMENT_ROWS_T1[4]
];

// pg_stat_statements_reset() was called for one entry only: its counters fall
// while the other entry keeps climbing.
const STATEMENT_ROWS_PARTIAL_RESET = [
    Object.assign({}, STATEMENT_ROWS_T1[0], {
        calls: '500', total_exec_time: '1000', rows: '1500'
    }),
    Object.assign({}, STATEMENT_ROWS_T1[1], {
        calls: '402', total_exec_time: '1610000', rows: '4020'
    })
];

// ── pg_stat_activity ──────────────────────────────────────────────────────────

const ACTIVITY_ROWS = [
    {
        pid: '4210', database: 'shop', username: 'app', state: 'active',
        wait_event_type: null, wait_event: null, backend_type: 'client backend',
        query_seconds: '2.4', xact_seconds: '2.4', state_seconds: '2.4',
        query: "SELECT * FROM users WHERE email = 'alice@example.com'"
    },
    {
        pid: '4211', database: 'shop', username: 'app', state: 'active',
        wait_event_type: 'Lock', wait_event: 'transactionid', backend_type: 'client backend',
        query_seconds: '95', xact_seconds: '95', state_seconds: '95',
        query: 'UPDATE inventory SET qty = qty - 1 WHERE sku = 42'
    },
    {
        pid: '4212', database: 'analytics', username: 'reporting', state: 'active',
        wait_event_type: 'IO', wait_event: 'DataFileRead', backend_type: 'client backend',
        query_seconds: '480', xact_seconds: '480', state_seconds: '480',
        query: 'SELECT count(*) FROM events WHERE created_at > now() - interval \'30 days\''
    },
    {
        pid: '4213', database: 'shop', username: 'app', state: 'idle',
        wait_event_type: 'Client', wait_event: 'ClientRead', backend_type: 'client backend',
        query_seconds: '0', xact_seconds: '0', state_seconds: '600',
        query: 'COMMIT'
    }
];

const IDLE_IN_TRANSACTION_ROWS = [
    {
        pid: '4310', database: 'shop', username: 'app', state: 'idle in transaction',
        xact_seconds: '620.4', state_seconds: '600.1',
        query: "INSERT INTO audit (actor, note) VALUES (7, 'manual fix')"
    },
    {
        pid: '4311', database: 'shop', username: 'app', state: 'idle in transaction (aborted)',
        xact_seconds: '95', state_seconds: '90',
        query: 'SELECT 1'
    }
];

const BLOCKING_ROWS = [
    {
        blocked_pid: '4211', blocking_pid: '4310', database: 'shop',
        blocked_user: 'app', blocking_user: 'app', blocking_state: 'idle in transaction',
        blocked_seconds: '95', blocked_xact_seconds: '95', blocking_xact_seconds: '620.4',
        wait_event_type: 'Lock', wait_event: 'transactionid',
        lock_type: 'transactionid', lock_mode: 'ShareLock', relation: 'inventory',
        blocked_query: 'UPDATE inventory SET qty = qty - 1 WHERE sku = 42',
        blocking_query: "INSERT INTO audit (actor, note) VALUES (7, 'manual fix')"
    },
    {
        // pg_blocking_pids reports the same pair once per ungranted lock.
        blocked_pid: '4211', blocking_pid: '4310', database: 'shop',
        blocked_user: 'app', blocking_user: 'app', blocking_state: 'idle in transaction',
        blocked_seconds: '95', blocked_xact_seconds: '95', blocking_xact_seconds: '620.4',
        wait_event_type: 'Lock', wait_event: 'tuple',
        lock_type: 'tuple', lock_mode: 'ExclusiveLock', relation: 'inventory',
        blocked_query: 'UPDATE inventory SET qty = qty - 1 WHERE sku = 42',
        blocking_query: "INSERT INTO audit (actor, note) VALUES (7, 'manual fix')"
    }
];

const LOCK_ROWS = [
    { mode: 'AccessShareLock', granted: true, count: '120' },
    { mode: 'RowExclusiveLock', granted: true, count: '18' },
    { mode: 'ShareLock', granted: false, count: '2' },
    { mode: 'ExclusiveLock', granted: false, count: '1' }
];

// ── pg_stat_user_tables + pg_statio_user_tables ───────────────────────────────

const TABLE_ROWS = [
    {
        schema: 'public', table: 'orders',
        seq_scan: '40', seq_tup_read: '400000', idx_scan: '2000000', idx_tup_fetch: '5000000',
        n_tup_ins: '1500000', n_tup_upd: '800000', n_tup_del: '120000', n_tup_hot_upd: '400000',
        n_mod_since_analyze: '9000',
        n_live_tup: '1380000', n_dead_tup: '20000',
        last_vacuum: null, last_autovacuum: '2026-08-11T09:00:00.000Z',
        last_analyze: null, last_autoanalyze: '2026-08-11T09:00:00.000Z',
        vacuum_count: '0', autovacuum_count: '412', analyze_count: '0', autoanalyze_count: '400',
        heap_blks_read: '100000', heap_blks_hit: '9900000',
        idx_blks_read: '5000', idx_blks_hit: '3000000',
        toast_blks_read: '0', toast_blks_hit: '0',
        total_size: '2147483648', data_size: '1610612736', index_size: '536870912'
    },
    {
        // A large table where sequential scans dominate — a real signal.
        schema: 'public', table: 'events',
        seq_scan: '90000', seq_tup_read: '9000000000', idx_scan: '120', idx_tup_fetch: '400',
        n_tup_ins: '400000000', n_tup_upd: '0', n_tup_del: '0', n_tup_hot_upd: '0',
        n_mod_since_analyze: '4000000',
        n_live_tup: '400000000', n_dead_tup: '0',
        last_vacuum: null, last_autovacuum: null,
        last_analyze: null, last_autoanalyze: null,
        vacuum_count: '0', autovacuum_count: '0', analyze_count: '0', autoanalyze_count: '0',
        heap_blks_read: '80000000', heap_blks_hit: '20000000',
        idx_blks_read: '10', idx_blks_hit: '90',
        toast_blks_read: '0', toast_blks_hit: '0',
        total_size: '1099511627776', data_size: '1090000000000', index_size: '9511627776'
    },
    {
        // A tiny lookup table at a 60% dead ratio: noise, not bloat.
        schema: 'public', table: 'feature_flags',
        seq_scan: '900000', seq_tup_read: '18000000', idx_scan: '0', idx_tup_fetch: '0',
        n_tup_ins: '20', n_tup_upd: '400', n_tup_del: '0', n_tup_hot_upd: '380',
        n_mod_since_analyze: '12',
        n_live_tup: '20', n_dead_tup: '30',
        last_vacuum: '2026-08-10T12:00:00.000Z', last_autovacuum: null,
        last_analyze: '2026-08-10T12:00:00.000Z', last_autoanalyze: null,
        vacuum_count: '1', autovacuum_count: '0', analyze_count: '1', autoanalyze_count: '0',
        heap_blks_read: '2', heap_blks_hit: '900000',
        idx_blks_read: '0', idx_blks_hit: '0',
        toast_blks_read: '0', toast_blks_hit: '0',
        total_size: '16384', data_size: '8192', index_size: '8192'
    },
    {
        // Genuine bloat: high ratio on a large row count.
        schema: 'public', table: 'sessions',
        seq_scan: '10', seq_tup_read: '5000', idx_scan: '9000000', idx_tup_fetch: '9000000',
        n_tup_ins: '80000000', n_tup_upd: '60000000', n_tup_del: '79000000', n_tup_hot_upd: '10000000',
        n_mod_since_analyze: '900000',
        n_live_tup: '600000', n_dead_tup: '900000',
        last_vacuum: null, last_autovacuum: '2026-08-11T06:00:00.000Z',
        last_analyze: null, last_autoanalyze: '2026-08-11T06:00:00.000Z',
        vacuum_count: '0', autovacuum_count: '9000', analyze_count: '0', autoanalyze_count: '8000',
        heap_blks_read: '4000000', heap_blks_hit: '400000000',
        idx_blks_read: '90000', idx_blks_hit: '900000000',
        toast_blks_read: '0', toast_blks_hit: '0',
        total_size: '10737418240', data_size: '8589934592', index_size: '2147483648'
    },
    {
        // Empty table: no ratio exists to report.
        schema: 'public', table: 'migrations_lock',
        seq_scan: '0', seq_tup_read: '0', idx_scan: '0', idx_tup_fetch: '0',
        n_tup_ins: '0', n_tup_upd: '0', n_tup_del: '0', n_tup_hot_upd: '0',
        n_mod_since_analyze: '0',
        n_live_tup: '0', n_dead_tup: '0',
        last_vacuum: null, last_autovacuum: null, last_analyze: null, last_autoanalyze: null,
        vacuum_count: '0', autovacuum_count: '0', analyze_count: '0', autoanalyze_count: '0',
        heap_blks_read: '0', heap_blks_hit: '0',
        idx_blks_read: '0', idx_blks_hit: '0',
        toast_blks_read: '0', toast_blks_hit: '0',
        total_size: '8192', data_size: '0', index_size: '8192'
    }
];

// ── pg_stat_user_indexes ──────────────────────────────────────────────────────

const INDEX_ROWS = [
    {
        schema: 'public', table: 'orders', index: 'orders_pkey',
        idx_scan: '0', idx_tup_read: '0', idx_tup_fetch: '0',
        idx_blks_read: '0', idx_blks_hit: '0', index_size: '134217728',
        is_unique: true, is_primary: true, is_constraint: true
    },
    {
        schema: 'public', table: 'orders', index: 'orders_email_key',
        idx_scan: '0', idx_tup_read: '0', idx_tup_fetch: '0',
        idx_blks_read: '0', idx_blks_hit: '0', index_size: '67108864',
        is_unique: true, is_primary: false, is_constraint: true
    },
    {
        schema: 'public', table: 'orders', index: 'orders_customer_id_idx',
        idx_scan: '2000000', idx_tup_read: '5000000', idx_tup_fetch: '4800000',
        idx_blks_read: '5000', idx_blks_hit: '3000000', index_size: '268435456',
        is_unique: false, is_primary: false, is_constraint: false
    },
    {
        // Genuinely unused, and safe to name as a candidate.
        schema: 'public', table: 'orders', index: 'orders_legacy_ref_idx',
        idx_scan: '0', idx_tup_read: '0', idx_tup_fetch: '0',
        idx_blks_read: '0', idx_blks_hit: '0', index_size: '805306368',
        is_unique: false, is_primary: false, is_constraint: false
    }
];

// ── pg_stat_wal / checkpoints ─────────────────────────────────────────────────

// PostgreSQL 14–17 shape.
const WAL_ROW_T1 = {
    wal_records: '5000000', wal_fpi: '90000', wal_bytes: '10737418240',
    wal_buffers_full: '120', wal_write: '400000', wal_sync: '400000',
    wal_write_time: '0', wal_sync_time: '0'
};
const WAL_ROW_T2 = {
    wal_records: '5060000', wal_fpi: '90400', wal_bytes: '10800000000',
    wal_buffers_full: '124', wal_write: '404000', wal_sync: '404000',
    wal_write_time: '0', wal_sync_time: '0'
};

// PostgreSQL 18 removed wal_write/wal_sync in favour of pg_stat_io.
const WAL_ROW_18 = {
    wal_records: '5000000', wal_fpi: '90000', wal_bytes: '10737418240',
    wal_buffers_full: '120'
};

// pg_stat_bgwriter shape (before 17).
const CHECKPOINT_ROW_T1 = {
    checkpoints_timed: '2000', checkpoints_requested: '30',
    checkpoint_write_time: '900000', checkpoint_sync_time: '4000',
    buffers_checkpoint: '9000000', buffers_clean: '400000', maxwritten_clean: '12',
    buffers_backend: '80000', buffers_backend_fsync: '0', buffers_alloc: '20000000'
};
const CHECKPOINT_ROW_T2 = {
    checkpoints_timed: '2004', checkpoints_requested: '39',
    checkpoint_write_time: '920000', checkpoint_sync_time: '4100',
    buffers_checkpoint: '9090000', buffers_clean: '404000', maxwritten_clean: '12',
    buffers_backend: '84000', buffers_backend_fsync: '0', buffers_alloc: '20400000'
};

// pg_stat_checkpointer (17+) has no buffers_backend column at all.
const CHECKPOINT_ROW_17 = {
    checkpoints_timed: '2000', checkpoints_requested: '30',
    checkpoint_write_time: '900000', checkpoint_sync_time: '4000',
    buffers_checkpoint: '9000000'
};

// ── replication ───────────────────────────────────────────────────────────────

const REPLICATION_ROWS = [
    {
        application_name: 'replica-1', client_addr: '10.0.1.21', state: 'streaming', sync_state: 'sync',
        sent_lsn: '0/6000140', write_lsn: '0/6000140', flush_lsn: '0/6000140', replay_lsn: '0/6000140',
        write_lag: '0.001', flush_lag: '0.002', replay_lag: '0.004',
        connected_seconds: '86000', reply_age_seconds: '0.4', wal_lag_bytes: '0'
    },
    {
        application_name: 'replica-2', client_addr: '10.0.1.22', state: 'catchup', sync_state: 'async',
        sent_lsn: '0/6000140', write_lsn: '0/5F00000', flush_lsn: '0/5F00000', replay_lsn: '0/5E00000',
        write_lag: null, flush_lag: null, replay_lag: null,
        connected_seconds: '12', reply_age_seconds: '1.1', wal_lag_bytes: '2097152'
    }
];

// A caught-up replica whose primary is idle: the replay timestamp is old but
// the byte gap is zero, so this must not read as lag.
const REPLICA_STATUS_IDLE_PRIMARY = {
    receive_lsn: '0/6000140', replay_lsn: '0/6000140',
    last_replay_timestamp: '2026-08-11T08:00:00.000Z',
    replay_age_seconds: '5400', replay_lag_bytes: '0'
};

const REPLICA_STATUS_LAGGING = {
    receive_lsn: '0/6000140', replay_lsn: '0/5A00000',
    last_replay_timestamp: '2026-08-11T09:59:00.000Z',
    replay_age_seconds: '60', replay_lag_bytes: '104857600'
};

// ── vacuum progress ───────────────────────────────────────────────────────────

const VACUUM_PROGRESS_ROWS = [
    {
        pid: '5150', database: 'shop', relation: 'public.sessions', phase: 'scanning heap',
        heap_blks_total: '1310720', heap_blks_scanned: '327680', heap_blks_vacuumed: '0',
        index_vacuum_count: '0', max_dead_tuples: '11184810', num_dead_tuples: '900000'
    },
    {
        // Index-cleanup phase reports no heap total, so there is no percentage.
        pid: '5151', database: 'shop', relation: 'public.orders', phase: 'vacuuming indexes',
        heap_blks_total: '0', heap_blks_scanned: '0', heap_blks_vacuumed: '0',
        index_vacuum_count: '1', max_dead_tuples: '11184810', num_dead_tuples: '20000'
    }
];

module.exports = {
    SERVER_INFO_15, SERVER_INFO_96, SERVER_INFO_REPLICA,
    CONNECTION_ROWS,
    DATABASE_ROWS_T1, DATABASE_ROWS_T2, DATABASE_ROWS_AFTER_RESET, DATABASE_ROWS_IDLE,
    STATEMENT_ROWS_T1, STATEMENT_ROWS_T2, STATEMENT_ROWS_PARTIAL_RESET,
    ACTIVITY_ROWS, IDLE_IN_TRANSACTION_ROWS, BLOCKING_ROWS, LOCK_ROWS,
    TABLE_ROWS, INDEX_ROWS,
    WAL_ROW_T1, WAL_ROW_T2, WAL_ROW_18,
    CHECKPOINT_ROW_T1, CHECKPOINT_ROW_T2, CHECKPOINT_ROW_17,
    REPLICATION_ROWS, REPLICA_STATUS_IDLE_PRIMARY, REPLICA_STATUS_LAGGING,
    VACUUM_PROGRESS_ROWS
};
