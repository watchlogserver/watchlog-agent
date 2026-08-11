// Captured MySQL result-set shapes used by the parser tests.
//
// These mirror what mysql2 actually returns for each statement, including the
// version differences that matter: SHOW REPLICA STATUS versus SHOW SLAVE STATUS,
// and picosecond timers from performance_schema.

'use strict';

// SHOW GLOBAL STATUS — mysql2 returns [{Variable_name, Value}, ...] with values
// as strings, including for numeric counters.
const STATUS_ROWS = [
    { Variable_name: 'Uptime', Value: '4030' },
    { Variable_name: 'Threads_connected', Value: '12' },
    { Variable_name: 'Threads_running', Value: '3' },
    { Variable_name: 'Threads_cached', Value: '5' },
    { Variable_name: 'Threads_created', Value: '40' },
    { Variable_name: 'Connections', Value: '900' },
    { Variable_name: 'Max_used_connections', Value: '30' },
    { Variable_name: 'Aborted_connects', Value: '7' },
    { Variable_name: 'Aborted_clients', Value: '2' },

    { Variable_name: 'Questions', Value: '500000' },
    { Variable_name: 'Queries', Value: '520000' },
    { Variable_name: 'Com_select', Value: '300000' },
    { Variable_name: 'Com_insert', Value: '50000' },
    { Variable_name: 'Com_update', Value: '20000' },
    { Variable_name: 'Com_delete', Value: '5000' },
    { Variable_name: 'Com_replace', Value: '10' },
    { Variable_name: 'Com_commit', Value: '40000' },
    { Variable_name: 'Com_rollback', Value: '120' },
    { Variable_name: 'Slow_queries', Value: '340' },

    { Variable_name: 'Innodb_buffer_pool_pages_total', Value: '8192' },
    { Variable_name: 'Innodb_buffer_pool_pages_data', Value: '6000' },
    { Variable_name: 'Innodb_buffer_pool_pages_free', Value: '2192' },
    { Variable_name: 'Innodb_buffer_pool_pages_dirty', Value: '600' },
    { Variable_name: 'Innodb_buffer_pool_bytes_data', Value: '98304000' },
    { Variable_name: 'Innodb_buffer_pool_bytes_dirty', Value: '9830400' },
    { Variable_name: 'Innodb_buffer_pool_read_requests', Value: '10000000' },
    { Variable_name: 'Innodb_buffer_pool_reads', Value: '25000' },
    { Variable_name: 'Innodb_buffer_pool_wait_free', Value: '0' },
    { Variable_name: 'Innodb_buffer_pool_write_requests', Value: '400000' },

    { Variable_name: 'Innodb_data_reads', Value: '30000' },
    { Variable_name: 'Innodb_data_writes', Value: '80000' },
    { Variable_name: 'Innodb_data_read', Value: '491520000' },
    { Variable_name: 'Innodb_data_written', Value: '1310720000' },
    { Variable_name: 'Innodb_data_fsyncs', Value: '20000' },
    { Variable_name: 'Innodb_os_log_written', Value: '52428800' },
    { Variable_name: 'Innodb_log_waits', Value: '3' },
    { Variable_name: 'Innodb_log_write_requests', Value: '150000' },
    { Variable_name: 'Innodb_log_writes', Value: '90000' },

    { Variable_name: 'Innodb_rows_read', Value: '9000000' },
    { Variable_name: 'Innodb_rows_inserted', Value: '120000' },
    { Variable_name: 'Innodb_rows_updated', Value: '45000' },
    { Variable_name: 'Innodb_rows_deleted', Value: '3000' },

    { Variable_name: 'Innodb_row_lock_current_waits', Value: '2' },
    { Variable_name: 'Innodb_row_lock_time', Value: '45000' },
    { Variable_name: 'Innodb_row_lock_time_avg', Value: '120' },
    { Variable_name: 'Innodb_row_lock_time_max', Value: '5000' },
    { Variable_name: 'Innodb_row_lock_waits', Value: '375' },

    { Variable_name: 'Created_tmp_tables', Value: '8000' },
    { Variable_name: 'Created_tmp_disk_tables', Value: '2000' },
    { Variable_name: 'Created_tmp_files', Value: '15' },
    { Variable_name: 'Sort_merge_passes', Value: '120' },
    { Variable_name: 'Sort_range', Value: '900' },
    { Variable_name: 'Sort_rows', Value: '250000' },
    { Variable_name: 'Sort_scan', Value: '400' },
    { Variable_name: 'Select_full_join', Value: '11' },
    { Variable_name: 'Select_scan', Value: '5000' },

    { Variable_name: 'Open_tables', Value: '180' },
    { Variable_name: 'Opened_tables', Value: '246' },
    { Variable_name: 'Table_open_cache_hits', Value: '90000' },
    { Variable_name: 'Table_open_cache_misses', Value: '10000' },
    { Variable_name: 'Table_open_cache_overflows', Value: '5' }
];

const VARIABLE_ROWS = [
    { Variable_name: 'version', Value: '8.0.44' },
    { Variable_name: 'version_comment', Value: 'MySQL Community Server - GPL' },
    { Variable_name: 'hostname', Value: 'db-primary-1' },
    { Variable_name: 'port', Value: '3306' },
    { Variable_name: 'server_uuid', Value: 'aaaa-bbbb-cccc-dddd' },
    { Variable_name: 'server_id', Value: '1' },
    { Variable_name: 'max_connections', Value: '151' },
    { Variable_name: 'read_only', Value: 'OFF' },
    { Variable_name: 'super_read_only', Value: 'OFF' },
    { Variable_name: 'default_storage_engine', Value: 'InnoDB' },
    { Variable_name: 'table_open_cache', Value: '4000' },
    { Variable_name: 'thread_cache_size', Value: '9' },
    { Variable_name: 'innodb_buffer_pool_size', Value: '134217728' },
    { Variable_name: 'long_query_time', Value: '10.000000' },
    { Variable_name: 'slow_query_log', Value: 'OFF' },
    { Variable_name: 'performance_schema', Value: 'ON' },
    { Variable_name: 'log_bin', Value: 'ON' },
    { Variable_name: 'binlog_format', Value: 'ROW' },
    { Variable_name: 'binlog_row_image', Value: 'FULL' },
    // Deliberately present to prove it is never collected.
    { Variable_name: 'ssl_key', Value: '/etc/mysql/private-key.pem' }
];

// MariaDB / older drivers use uppercase column names.
const STATUS_ROWS_UPPERCASE = [
    { VARIABLE_NAME: 'Uptime', VARIABLE_VALUE: '900' },
    { VARIABLE_NAME: 'Threads_connected', VARIABLE_VALUE: '4' }
];

// performance_schema.events_statements_summary_by_digest.
// Timers are PICOSECONDS: 1_500_000_000 picos = 1.5 ms.
const DIGEST_ROWS = [
    {
        DIGEST: 'a1b2c3',
        DIGEST_TEXT: 'SELECT * FROM `users` WHERE `email` = ?',
        SCHEMA_NAME: 'shop',
        COUNT_STAR: 1000,
        SUM_TIMER_WAIT: 1500000000000,   // 1500 ms total
        AVG_TIMER_WAIT: 1500000000,      // 1.5 ms
        MAX_TIMER_WAIT: 45000000000,     // 45 ms
        MIN_TIMER_WAIT: 800000000,       // 0.8 ms
        SUM_ROWS_EXAMINED: 1000,
        SUM_ROWS_SENT: 1000,
        SUM_CREATED_TMP_TABLES: 0,
        SUM_CREATED_TMP_DISK_TABLES: 0,
        SUM_SORT_ROWS: 0,
        SUM_NO_INDEX_USED: 0,
        SUM_NO_GOOD_INDEX_USED: 0,
        SUM_ERRORS: 0,
        SUM_WARNINGS: 0,
        FIRST_SEEN: '2026-08-11T09:00:00.000Z',
        LAST_SEEN: '2026-08-11T10:00:00.000Z'
    },
    {
        DIGEST: 'd4e5f6',
        DIGEST_TEXT: 'SELECT COUNT ( * ) FROM `users` WHERE NAME LIKE ?',
        SCHEMA_NAME: 'shop',
        COUNT_STAR: 50,
        SUM_TIMER_WAIT: 25000000000000,  // 25 000 ms
        AVG_TIMER_WAIT: 500000000000,    // 500 ms
        MAX_TIMER_WAIT: 900000000000,    // 900 ms
        MIN_TIMER_WAIT: 300000000000,
        SUM_ROWS_EXAMINED: 250000,
        SUM_ROWS_SENT: 50,
        SUM_CREATED_TMP_TABLES: 50,
        SUM_CREATED_TMP_DISK_TABLES: 12,
        SUM_SORT_ROWS: 0,
        SUM_NO_INDEX_USED: 50,
        SUM_NO_GOOD_INDEX_USED: 0,
        SUM_ERRORS: 0,
        SUM_WARNINGS: 0,
        FIRST_SEEN: '2026-08-11T09:30:00.000Z',
        LAST_SEEN: '2026-08-11T10:00:00.000Z'
    },
    // The agent's own monitoring query — must be filtered out.
    {
        DIGEST: 'agent1',
        DIGEST_TEXT: 'SELECT `DIGEST` , `DIGEST_TEXT` FROM `performance_schema` . `events_statements_summary_by_digest`',
        SCHEMA_NAME: null,
        COUNT_STAR: 60,
        SUM_TIMER_WAIT: 600000000000,
        AVG_TIMER_WAIT: 10000000000,
        MAX_TIMER_WAIT: 20000000000,
        MIN_TIMER_WAIT: 5000000000,
        SUM_ROWS_EXAMINED: 6000, SUM_ROWS_SENT: 6000,
        SUM_CREATED_TMP_TABLES: 0, SUM_CREATED_TMP_DISK_TABLES: 0, SUM_SORT_ROWS: 0,
        SUM_NO_INDEX_USED: 0, SUM_NO_GOOD_INDEX_USED: 0, SUM_ERRORS: 0, SUM_WARNINGS: 0,
        FIRST_SEEN: '2026-08-11T09:00:00.000Z', LAST_SEEN: '2026-08-11T10:00:00.000Z'
    },
    // performance_schema overflow row: NULL digest text.
    {
        DIGEST: null, DIGEST_TEXT: null, SCHEMA_NAME: 'shop',
        COUNT_STAR: 5, SUM_TIMER_WAIT: 5000000000, AVG_TIMER_WAIT: 1000000000,
        MAX_TIMER_WAIT: 2000000000, MIN_TIMER_WAIT: 500000000,
        SUM_ROWS_EXAMINED: 5, SUM_ROWS_SENT: 5,
        SUM_CREATED_TMP_TABLES: 0, SUM_CREATED_TMP_DISK_TABLES: 0, SUM_SORT_ROWS: 0,
        SUM_NO_INDEX_USED: 0, SUM_NO_GOOD_INDEX_USED: 0, SUM_ERRORS: 0, SUM_WARNINGS: 0,
        FIRST_SEEN: null, LAST_SEEN: null
    }
];

const TABLE_ROWS = [
    {
        TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', ENGINE: 'InnoDB',
        TABLE_ROWS: 4902, DATA_LENGTH: 1589248, INDEX_LENGTH: 229376,
        DATA_FREE: 4194304, AUTO_INCREMENT: 5001, ROW_FORMAT: 'Dynamic',
        CREATE_TIME: '2026-08-11T09:00:00.000Z', UPDATE_TIME: '2026-08-11T09:30:00.000Z'
    },
    {
        TABLE_SCHEMA: 'shop', TABLE_NAME: 'users', ENGINE: 'InnoDB',
        TABLE_ROWS: 4970, DATA_LENGTH: 360448, INDEX_LENGTH: 409600,
        DATA_FREE: 0, AUTO_INCREMENT: 5001, ROW_FORMAT: 'Dynamic',
        CREATE_TIME: '2026-08-11T09:00:00.000Z', UPDATE_TIME: null
    },
    {
        TABLE_SCHEMA: 'analytics', TABLE_NAME: 'events', ENGINE: 'InnoDB',
        TABLE_ROWS: 1920, DATA_LENGTH: 540672, INDEX_LENGTH: 0,
        DATA_FREE: 0, AUTO_INCREMENT: null, ROW_FORMAT: 'Dynamic',
        CREATE_TIME: '2026-08-11T09:00:00.000Z', UPDATE_TIME: null
    }
];

const INDEX_ROWS = [
    {
        OBJECT_SCHEMA: 'shop', OBJECT_NAME: 'users', INDEX_NAME: 'idx_status',
        COUNT_READ: 12000, COUNT_WRITE: 0, COUNT_FETCH: 12000,
        COUNT_INSERT: 0, COUNT_UPDATE: 0, COUNT_DELETE: 0,
        SUM_TIMER_WAIT: 78978000000, SUM_TIMER_READ: 78978000000, SUM_TIMER_WRITE: 0
    },
    {
        OBJECT_SCHEMA: 'shop', OBJECT_NAME: 'users', INDEX_NAME: 'PRIMARY',
        COUNT_READ: 5050, COUNT_WRITE: 33, COUNT_FETCH: 5050,
        COUNT_INSERT: 33, COUNT_UPDATE: 0, COUNT_DELETE: 0,
        SUM_TIMER_WAIT: 2930000000, SUM_TIMER_READ: 2900000000, SUM_TIMER_WRITE: 30000000
    },
    {
        OBJECT_SCHEMA: 'shop', OBJECT_NAME: 'users', INDEX_NAME: 'uq_email',
        COUNT_READ: 0, COUNT_WRITE: 0, COUNT_FETCH: 0,
        COUNT_INSERT: 0, COUNT_UPDATE: 0, COUNT_DELETE: 0,
        SUM_TIMER_WAIT: 0, SUM_TIMER_READ: 0, SUM_TIMER_WRITE: 0
    },
    {
        OBJECT_SCHEMA: 'shop', OBJECT_NAME: 'orders', INDEX_NAME: 'idx_never_used',
        COUNT_READ: 0, COUNT_WRITE: 0, COUNT_FETCH: 0,
        COUNT_INSERT: 0, COUNT_UPDATE: 0, COUNT_DELETE: 0,
        SUM_TIMER_WAIT: 0, SUM_TIMER_READ: 0, SUM_TIMER_WRITE: 0
    },
    // NULL INDEX_NAME is the table's non-index (full scan) activity.
    {
        OBJECT_SCHEMA: 'shop', OBJECT_NAME: 'orders', INDEX_NAME: null,
        COUNT_READ: 15001, COUNT_WRITE: 5000, COUNT_FETCH: 15001,
        COUNT_INSERT: 5000, COUNT_UPDATE: 0, COUNT_DELETE: 0,
        SUM_TIMER_WAIT: 50349000000, SUM_TIMER_READ: 40000000000, SUM_TIMER_WRITE: 10349000000
    }
];

const INDEX_METADATA_ROWS = [
    { TABLE_SCHEMA: 'shop', TABLE_NAME: 'users', INDEX_NAME: 'idx_status', NON_UNIQUE: 1, CARDINALITY: 2 },
    { TABLE_SCHEMA: 'shop', TABLE_NAME: 'users', INDEX_NAME: 'PRIMARY', NON_UNIQUE: 0, CARDINALITY: 4970 },
    { TABLE_SCHEMA: 'shop', TABLE_NAME: 'users', INDEX_NAME: 'uq_email', NON_UNIQUE: 0, CARDINALITY: 4970 },
    { TABLE_SCHEMA: 'shop', TABLE_NAME: 'orders', INDEX_NAME: 'idx_never_used', NON_UNIQUE: 1, CARDINALITY: 2 }
];

// SHOW REPLICA STATUS — MySQL 8.0.22+.
const REPLICA_STATUS_ROWS = [{
    Replica_IO_State: 'Waiting for source to send event',
    Source_Host: '10.0.0.1',
    Source_User: 'repl',            // present, and deliberately never collected
    Source_Port: 3306,
    Source_Log_File: 'binlog.000042',
    Read_Source_Log_Pos: 900000,
    Relay_Log_Space: 1048576,
    Replica_IO_Running: 'Yes',
    Replica_SQL_Running: 'Yes',
    Exec_Source_Log_Pos: 889000,
    Seconds_Behind_Source: 12,
    Last_IO_Errno: 0, Last_IO_Error: '',
    Last_SQL_Errno: 0, Last_SQL_Error: '',
    Auto_Position: '1', Channel_Name: ''
}];

// SHOW SLAVE STATUS — MySQL 5.7 / MariaDB, with a broken IO thread.
const SLAVE_STATUS_ROWS = [{
    Slave_IO_State: '',
    Master_Host: '10.0.0.1',
    Master_User: 'repl',
    Master_Port: 3306,
    Master_Log_File: 'binlog.000042',
    Read_Master_Log_Pos: 900000,
    Relay_Log_Space: 1048576,
    Slave_IO_Running: 'No',
    Slave_SQL_Running: 'Yes',
    Exec_Master_Log_Pos: 880000,
    // NULL means the replica is not connected at all — not "caught up".
    Seconds_Behind_Master: null,
    Last_IO_Errno: 2003,
    Last_IO_Error: "error connecting to master 'repl@10.0.0.1:3306'",
    Last_SQL_Errno: 0, Last_SQL_Error: ''
}];

// SHOW REPLICAS / SHOW SLAVE HOSTS.
const CONNECTED_REPLICA_ROWS = [
    { Server_Id: 2, Host: '10.0.0.11', Port: 3306, Source_Id: 1, Replica_UUID: 'uuid-2' },
    { Server_id: 3, Host: '10.0.0.12', Port: 3306, Master_id: 1, Slave_UUID: 'uuid-3' }
];

const LOCK_WAIT_ROWS = [{
    waiting_thread_id: 55, waiting_pid: 101,
    blocking_thread_id: 60, blocking_pid: 108,
    object_schema: 'shop', object_name: 'orders', index_name: 'PRIMARY',
    lock_type: 'RECORD', lock_mode: 'X,REC_NOT_GAP', lock_status: 'WAITING',
    waiting_query: 'UPDATE `orders` SET `state` = ? WHERE `id` = ?',
    waiting_digest: 'w1', blocking_query: 'UPDATE `orders` SET `total` = ? WHERE `id` = ?',
    blocking_digest: 'b1',
    wait_age_secs: 14, waiting_trx_rows_modified: 0, blocking_trx_rows_modified: 3
}];

module.exports = {
    STATUS_ROWS,
    VARIABLE_ROWS,
    STATUS_ROWS_UPPERCASE,
    DIGEST_ROWS,
    TABLE_ROWS,
    INDEX_ROWS,
    INDEX_METADATA_ROWS,
    REPLICA_STATUS_ROWS,
    SLAVE_STATUS_ROWS,
    CONNECTED_REPLICA_ROWS,
    LOCK_WAIT_ROWS
};
