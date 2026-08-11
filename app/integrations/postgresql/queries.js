// queries.js — the SQL the PostgreSQL collector runs, gated by server version.
//
// PostgreSQL moves statistics columns between releases more than any other
// engine Watchlog monitors, so the statement text itself is version-dependent
// and lives here rather than being inlined at the call site. Every function
// takes the parsed version and returns SQL valid for that release.
//
// Everything here is read-only. Nothing in this file creates an extension,
// changes a setting, terminates a backend, or runs VACUUM/ANALYZE.
//
// Version boundaries that matter:
//   9.6  pg_stat_activity.wait_event_type / wait_event
//   10   pg_blocking_pids(), pg_stat_activity.backend_type
//   13   pg_stat_statements total_time -> total_exec_time (+ plan columns)
//   14   pg_stat_wal; pg_stat_database session/active/idle time columns
//   15   pg_stat_statements temp_blk_read_time / temp_blk_write_time
//   16   pg_stat_statements blk_read_time -> shared_blk_read_time
//   17   pg_stat_checkpointer; checkpoint columns leave pg_stat_bgwriter

'use strict';

const SYSTEM_SCHEMAS = "('pg_catalog', 'information_schema', 'pg_toast')";

/** Server identity and the settings the dashboard reports. */
const SERVER_INFO = `
    SELECT
        version()                                    AS version_full,
        current_setting('server_version')            AS server_version,
        current_setting('server_version_num')::int   AS server_version_num,
        current_database()                           AS current_database,
        pg_is_in_recovery()                          AS in_recovery,
        EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::bigint AS uptime_seconds,
        current_setting('max_connections')::int      AS max_connections,
        current_setting('shared_buffers')            AS shared_buffers,
        current_setting('effective_cache_size')      AS effective_cache_size,
        current_setting('work_mem')                  AS work_mem,
        current_setting('maintenance_work_mem')      AS maintenance_work_mem,
        current_setting('autovacuum')                AS autovacuum,
        current_setting('track_io_timing')           AS track_io_timing,
        -- Read from pg_settings rather than current_setting: the latter applies
        -- units and returns '1kB', which is not a number.
        (SELECT setting::int FROM pg_settings WHERE name = 'track_activity_query_size')
                                                     AS track_activity_query_size,
        current_setting('default_transaction_isolation') AS default_transaction_isolation
`;

/**
 * Connection counts grouped by state and database.
 *
 * Excludes the agent's own backend so Watchlog never counts itself, and skips
 * non-client backends (autovacuum workers, walsender) which are not
 * connections in the max_connections sense.
 */
function connectionSummary(version) {
    const backendTypeFilter = version.atLeast(10)
        ? "AND backend_type = 'client backend'"
        : '';
    return `
        SELECT
            datname                                       AS database,
            COALESCE(state, 'unknown')                    AS state,
            count(*)::int                                 AS count,
            count(*) FILTER (WHERE wait_event_type IS NOT NULL)::int AS waiting,
            COALESCE(MAX(EXTRACT(EPOCH FROM now() - xact_start)), 0)::bigint  AS max_xact_seconds,
            COALESCE(MAX(EXTRACT(EPOCH FROM now() - query_start)), 0)::bigint AS max_query_seconds,
            COALESCE(MAX(EXTRACT(EPOCH FROM now() - state_change)), 0)::bigint AS max_state_seconds
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
        ${backendTypeFilter}
        GROUP BY datname, COALESCE(state, 'unknown')
    `;
}

/**
 * Per-database counters. The session/time columns arrived in PostgreSQL 14, so
 * they are selected as NULL on older servers to keep one row shape.
 */
function databaseStats(version) {
    const sessionColumns = version.atLeast(14)
        ? `d.session_time, d.active_time, d.idle_in_transaction_time,
           d.sessions, d.sessions_abandoned, d.sessions_fatal, d.sessions_killed`
        : `NULL::double precision AS session_time, NULL::double precision AS active_time,
           NULL::double precision AS idle_in_transaction_time,
           NULL::bigint AS sessions, NULL::bigint AS sessions_abandoned,
           NULL::bigint AS sessions_fatal, NULL::bigint AS sessions_killed`;

    return `
        SELECT
            d.datname AS database,
            d.numbackends, d.xact_commit, d.xact_rollback,
            d.blks_read, d.blks_hit,
            d.tup_returned, d.tup_fetched, d.tup_inserted, d.tup_updated, d.tup_deleted,
            d.conflicts, d.temp_files, d.temp_bytes, d.deadlocks,
            d.blk_read_time, d.blk_write_time,
            ${sessionColumns},
            -- pg_database_size() raises for a database the role cannot CONNECT
            -- to, which would fail the whole statement and lose every readable
            -- database along with it. Guarding yields a null size for that one
            -- row instead, so one revoked grant costs one column.
            CASE WHEN has_database_privilege(d.datname, 'CONNECT')
                 THEN pg_database_size(d.datname) END AS database_size
        FROM pg_stat_database d
        WHERE d.datname IS NOT NULL
          AND d.datname NOT IN ('template0', 'template1')
    `;
}

/**
 * pg_stat_statements. Column names changed in 13, 15 and 16, so the projection
 * is assembled per version and always aliased to one stable shape.
 *
 * Ordered by total execution time so the LIMIT keeps the queries that matter.
 */
function statementStats(version, limit) {
    const execTotal = version.atLeast(13) ? 'total_exec_time' : 'total_time';
    const execMean = version.atLeast(13) ? 'mean_exec_time' : 'mean_time';
    const execMin = version.atLeast(13) ? 'min_exec_time' : 'min_time';
    const execMax = version.atLeast(13) ? 'max_exec_time' : 'max_time';
    const execStddev = version.atLeast(13) ? 'stddev_exec_time' : 'stddev_time';

    // Planning statistics arrived with 13.
    const planColumns = version.atLeast(13)
        ? `s.plans, s.total_plan_time, s.min_plan_time, s.max_plan_time, s.mean_plan_time`
        : `0::bigint AS plans, 0::double precision AS total_plan_time,
           0::double precision AS min_plan_time, 0::double precision AS max_plan_time,
           0::double precision AS mean_plan_time`;

    // Block IO timing columns were renamed with a `shared_` prefix in 16.
    const blkReadTime = version.atLeast(16) ? 's.shared_blk_read_time' : 's.blk_read_time';
    const blkWriteTime = version.atLeast(16) ? 's.shared_blk_write_time' : 's.blk_write_time';

    // Temp block IO timing arrived in 15.
    const tempTimeColumns = version.atLeast(15)
        ? `s.temp_blk_read_time, s.temp_blk_write_time`
        : `0::double precision AS temp_blk_read_time, 0::double precision AS temp_blk_write_time`;

    // WAL statistics arrived with 13.
    const walColumns = version.atLeast(13)
        ? `s.wal_records, s.wal_fpi, s.wal_bytes`
        : `0::bigint AS wal_records, 0::bigint AS wal_fpi, 0::numeric AS wal_bytes`;

    return `
        SELECT
            s.queryid::text                AS queryid,
            d.datname                      AS database,
            s.query                        AS query,
            s.calls,
            s.${execTotal}                 AS total_exec_time,
            s.${execMean}                  AS mean_exec_time,
            s.${execMin}                   AS min_exec_time,
            s.${execMax}                   AS max_exec_time,
            s.${execStddev}                AS stddev_exec_time,
            s.rows,
            s.shared_blks_hit, s.shared_blks_read, s.shared_blks_dirtied, s.shared_blks_written,
            s.local_blks_hit, s.local_blks_read, s.local_blks_dirtied, s.local_blks_written,
            s.temp_blks_read, s.temp_blks_written,
            ${blkReadTime}                 AS blk_read_time,
            ${blkWriteTime}                AS blk_write_time,
            ${tempTimeColumns},
            ${walColumns},
            ${planColumns}
        FROM pg_stat_statements s
        LEFT JOIN pg_database d ON d.oid = s.dbid
        WHERE s.queryid IS NOT NULL
          AND (d.datname IS NULL OR d.datname NOT IN ('template0', 'template1'))
        ORDER BY s.${execTotal} DESC
        LIMIT ${limit}
    `;
}

/**
 * Current activity: running statements, waits and transaction ages.
 *
 * This is current-state data for the Activity tab, never a time series — one
 * row per backend would be unbounded cardinality in InfluxDB.
 */
function activitySnapshot(version, limit) {
    const backendType = version.atLeast(10) ? 'backend_type' : `'client backend'::text AS backend_type`;
    const waitColumns = version.atLeast(96)
        ? 'wait_event_type, wait_event'
        : `NULL::text AS wait_event_type, NULL::text AS wait_event`;

    return `
        SELECT
            pid,
            datname                AS database,
            usename                AS username,
            state,
            ${waitColumns},
            ${backendType},
            EXTRACT(EPOCH FROM now() - query_start)::bigint   AS query_seconds,
            EXTRACT(EPOCH FROM now() - xact_start)::bigint    AS xact_seconds,
            EXTRACT(EPOCH FROM now() - state_change)::bigint  AS state_seconds,
            query
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND state IS NOT NULL
          AND state <> 'idle'
        ORDER BY COALESCE(EXTRACT(EPOCH FROM now() - xact_start), 0) DESC
        LIMIT ${limit}
    `;
}

/**
 * Idle-in-transaction sessions, collected separately because they are excluded
 * from the activity query above (state <> 'idle' keeps that list to running
 * work) yet matter enormously: an idle transaction holds its snapshot and
 * blocks vacuum from reclaiming dead tuples cluster-wide.
 */
function idleInTransaction(limit) {
    return `
        SELECT
            pid, datname AS database, usename AS username, state,
            EXTRACT(EPOCH FROM now() - xact_start)::bigint   AS xact_seconds,
            EXTRACT(EPOCH FROM now() - state_change)::bigint AS state_seconds,
            query
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND state IN ('idle in transaction', 'idle in transaction (aborted)')
        ORDER BY xact_start ASC NULLS LAST
        LIMIT ${limit}
    `;
}

/**
 * Blocking / blocked pairs.
 *
 * pg_blocking_pids() (PostgreSQL 10+) is dramatically simpler and more accurate
 * than self-joining pg_locks, which cannot see all the wait edges. On 9.x the
 * pg_locks join is the only option.
 */
function blockingQueries(version, limit) {
    if (version.atLeast(10)) {
        return `
            SELECT
                blocked.pid                AS blocked_pid,
                blocked.datname            AS database,
                blocked.usename            AS blocked_user,
                blocked.query              AS blocked_query,
                EXTRACT(EPOCH FROM now() - blocked.query_start)::bigint AS blocked_seconds,
                EXTRACT(EPOCH FROM now() - blocked.xact_start)::bigint  AS blocked_xact_seconds,
                blocked.wait_event_type, blocked.wait_event,
                blocking.pid               AS blocking_pid,
                blocking.usename           AS blocking_user,
                blocking.state             AS blocking_state,
                blocking.query             AS blocking_query,
                EXTRACT(EPOCH FROM now() - blocking.xact_start)::bigint AS blocking_xact_seconds,
                l.locktype                 AS lock_type,
                l.mode                     AS lock_mode,
                COALESCE(c.relname, '')    AS relation
            FROM pg_stat_activity blocked
            JOIN LATERAL unnest(pg_blocking_pids(blocked.pid)) AS blocking_pid_val ON true
            JOIN pg_stat_activity blocking ON blocking.pid = blocking_pid_val
            LEFT JOIN pg_locks l ON l.pid = blocked.pid AND NOT l.granted
            LEFT JOIN pg_class c ON c.oid = l.relation
            WHERE cardinality(pg_blocking_pids(blocked.pid)) > 0
            LIMIT ${limit}
        `;
    }

    return `
        SELECT
            blocked.pid             AS blocked_pid,
            blocked.datname         AS database,
            blocked.usename         AS blocked_user,
            blocked.query           AS blocked_query,
            EXTRACT(EPOCH FROM now() - blocked.query_start)::bigint AS blocked_seconds,
            EXTRACT(EPOCH FROM now() - blocked.xact_start)::bigint  AS blocked_xact_seconds,
            NULL::text AS wait_event_type, NULL::text AS wait_event,
            blocking.pid            AS blocking_pid,
            blocking.usename        AS blocking_user,
            blocking.state          AS blocking_state,
            blocking.query          AS blocking_query,
            EXTRACT(EPOCH FROM now() - blocking.xact_start)::bigint AS blocking_xact_seconds,
            bl.locktype             AS lock_type,
            bl.mode                 AS lock_mode,
            COALESCE(c.relname, '') AS relation
        FROM pg_locks bl
        JOIN pg_stat_activity blocked  ON blocked.pid = bl.pid
        JOIN pg_locks kl ON kl.locktype = bl.locktype AND kl.granted
             AND kl.pid <> bl.pid
             AND COALESCE(kl.relation, 0) = COALESCE(bl.relation, 0)
             AND COALESCE(kl.transactionid::text, '') = COALESCE(bl.transactionid::text, '')
        JOIN pg_stat_activity blocking ON blocking.pid = kl.pid
        LEFT JOIN pg_class c ON c.oid = bl.relation
        WHERE NOT bl.granted
        LIMIT ${limit}
    `;
}

/** Aggregate lock counts — cheap, and safe as a time series. */
const LOCK_SUMMARY = `
    SELECT
        mode,
        granted,
        count(*)::int AS count
    FROM pg_locks
    GROUP BY mode, granted
`;

/** Per-table statistics, including vacuum bookkeeping. Current database only. */
function tableStats(limit) {
    return `
        SELECT
            t.schemaname                AS schema,
            t.relname                   AS table,
            t.seq_scan, t.seq_tup_read, t.idx_scan, t.idx_tup_fetch,
            t.n_tup_ins, t.n_tup_upd, t.n_tup_del, t.n_tup_hot_upd,
            t.n_live_tup, t.n_dead_tup, t.n_mod_since_analyze,
            t.last_vacuum, t.last_autovacuum, t.last_analyze, t.last_autoanalyze,
            t.vacuum_count, t.autovacuum_count, t.analyze_count, t.autoanalyze_count,
            io.heap_blks_read, io.heap_blks_hit,
            io.idx_blks_read, io.idx_blks_hit,
            io.toast_blks_read, io.toast_blks_hit,
            io.tidx_blks_read, io.tidx_blks_hit,
            pg_total_relation_size(t.relid)  AS total_size,
            pg_relation_size(t.relid)        AS data_size,
            pg_indexes_size(t.relid)         AS index_size
        FROM pg_stat_user_tables t
        LEFT JOIN pg_statio_user_tables io ON io.relid = t.relid
        WHERE t.schemaname NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY pg_total_relation_size(t.relid) DESC
        LIMIT ${limit}
    `;
}

/**
 * n_ins_since_vacuum drives the insert-only autovacuum threshold added in
 * PostgreSQL 13; before that the column does not exist.
 */
function tableInsertsSinceVacuum(version) {
    if (!version.atLeast(13)) return null;
    return `
        SELECT schemaname AS schema, relname AS table, n_ins_since_vacuum
        FROM pg_stat_user_tables
        WHERE schemaname NOT IN ${SYSTEM_SCHEMAS}
    `;
}

/** Per-index statistics with size. Current database only. */
function indexStats(limit) {
    return `
        SELECT
            i.schemaname            AS schema,
            i.relname               AS table,
            i.indexrelname          AS index,
            i.idx_scan, i.idx_tup_read, i.idx_tup_fetch,
            io.idx_blks_read, io.idx_blks_hit,
            pg_relation_size(i.indexrelid) AS index_size,
            idx.indisunique         AS is_unique,
            idx.indisprimary        AS is_primary,
            (con.conname IS NOT NULL) AS is_constraint
        FROM pg_stat_user_indexes i
        LEFT JOIN pg_statio_user_indexes io ON io.indexrelid = i.indexrelid
        LEFT JOIN pg_index idx ON idx.indexrelid = i.indexrelid
        LEFT JOIN pg_constraint con ON con.conindid = i.indexrelid
        WHERE i.schemaname NOT IN ${SYSTEM_SCHEMAS}
        ORDER BY pg_relation_size(i.indexrelid) DESC
        LIMIT ${limit}
    `;
}

/** WAL generation. pg_stat_wal is PostgreSQL 14+. */
function walStats(version) {
    if (!version.atLeast(14)) return null;
    // wal_write/wal_sync/wal_write_time/wal_sync_time were removed in 18 in
    // favour of pg_stat_io; selected defensively so 18+ still returns a row.
    return `
        SELECT
            wal_records, wal_fpi, wal_bytes, wal_buffers_full
            ${version.atLeast(18) ? '' : ', wal_write, wal_sync, wal_write_time, wal_sync_time'}
        FROM pg_stat_wal
    `;
}

/**
 * Checkpoint and background-writer activity.
 *
 * PostgreSQL 17 split pg_stat_bgwriter: checkpoint columns moved to
 * pg_stat_checkpointer and were renamed (checkpoints_timed -> num_timed).
 */
function checkpointStats(version) {
    if (version.atLeast(17)) {
        return `
            SELECT
                c.num_timed            AS checkpoints_timed,
                c.num_requested        AS checkpoints_requested,
                c.write_time           AS checkpoint_write_time,
                c.sync_time            AS checkpoint_sync_time,
                c.buffers_written      AS buffers_checkpoint,
                b.buffers_clean,
                b.maxwritten_clean,
                0::bigint              AS buffers_backend,
                0::bigint              AS buffers_backend_fsync,
                b.buffers_alloc
            FROM pg_stat_checkpointer c, pg_stat_bgwriter b
        `;
    }

    return `
        SELECT
            checkpoints_timed, checkpoints_req AS checkpoints_requested,
            checkpoint_write_time, checkpoint_sync_time,
            buffers_checkpoint, buffers_clean, maxwritten_clean,
            buffers_backend, buffers_backend_fsync, buffers_alloc
        FROM pg_stat_bgwriter
    `;
}

/**
 * Streaming replicas, as seen from the primary.
 *
 * client_addr is collected because the dashboard needs to distinguish replicas,
 * but no credential or connection string is read.
 */
function replicationStats(version) {
    const lagColumns = version.atLeast(10)
        ? `EXTRACT(EPOCH FROM write_lag)::double precision  AS write_lag,
           EXTRACT(EPOCH FROM flush_lag)::double precision  AS flush_lag,
           EXTRACT(EPOCH FROM replay_lag)::double precision AS replay_lag`
        : `NULL::double precision AS write_lag, NULL::double precision AS flush_lag,
           NULL::double precision AS replay_lag`;

    const lsnDiff = version.atLeast(10) ? 'pg_wal_lsn_diff' : 'pg_xlog_location_diff';
    const currentLsn = version.atLeast(10) ? 'pg_current_wal_lsn()' : 'pg_current_xlog_location()';
    const sentLsn = version.atLeast(10) ? 'sent_lsn' : 'sent_location';
    const writeLsn = version.atLeast(10) ? 'write_lsn' : 'write_location';
    const flushLsn = version.atLeast(10) ? 'flush_lsn' : 'flush_location';
    const replayLsn = version.atLeast(10) ? 'replay_lsn' : 'replay_location';

    return `
        SELECT
            application_name,
            COALESCE(host(client_addr), '') AS client_addr,
            state, sync_state,
            ${sentLsn}::text   AS sent_lsn,
            ${writeLsn}::text  AS write_lsn,
            ${flushLsn}::text  AS flush_lsn,
            ${replayLsn}::text AS replay_lsn,
            ${lagColumns},
            EXTRACT(EPOCH FROM now() - backend_start)::bigint AS connected_seconds,
            EXTRACT(EPOCH FROM now() - reply_time)::bigint    AS reply_age_seconds,
            ${lsnDiff}(${currentLsn}, ${replayLsn})::bigint   AS wal_lag_bytes
        FROM pg_stat_replication
    `;
}

/** A replica's own view of how far it has replayed. */
function replicaStatus(version) {
    const receiveLsn = version.atLeast(10) ? 'pg_last_wal_receive_lsn()' : 'pg_last_xlog_receive_location()';
    const replayLsn = version.atLeast(10) ? 'pg_last_wal_replay_lsn()' : 'pg_last_xlog_replay_location()';
    const lsnDiff = version.atLeast(10) ? 'pg_wal_lsn_diff' : 'pg_xlog_location_diff';

    return `
        SELECT
            ${receiveLsn}::text AS receive_lsn,
            ${replayLsn}::text  AS replay_lsn,
            pg_last_xact_replay_timestamp() AS last_replay_timestamp,
            EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::bigint AS replay_age_seconds,
            ${lsnDiff}(${receiveLsn}, ${replayLsn})::bigint AS replay_lag_bytes
    `;
}

/** In-progress vacuums. pg_stat_progress_vacuum is PostgreSQL 9.6+. */
function vacuumProgress(version) {
    if (!version.atLeast(96)) return null;
    // max_dead_tuples/num_dead_tuples were renamed in 17 to
    // max_dead_tuple_bytes/dead_tuple_bytes with different meaning, so the old
    // names are only selected where they exist.
    const tupleColumns = version.atLeast(17)
        ? `0::bigint AS max_dead_tuples, 0::bigint AS num_dead_tuples`
        : `v.max_dead_tuples, v.num_dead_tuples`;

    return `
        SELECT
            v.pid,
            d.datname                AS database,
            COALESCE(c.relname, '')  AS relation,
            v.phase,
            v.heap_blks_total, v.heap_blks_scanned, v.heap_blks_vacuumed,
            v.index_vacuum_count,
            ${tupleColumns}
        FROM pg_stat_progress_vacuum v
        LEFT JOIN pg_database d ON d.oid = v.datid
        LEFT JOIN pg_class c ON c.oid = v.relid
    `;
}

module.exports = {
    SERVER_INFO,
    LOCK_SUMMARY,
    SYSTEM_SCHEMAS,
    connectionSummary,
    databaseStats,
    statementStats,
    activitySnapshot,
    idleInTransaction,
    blockingQueries,
    tableStats,
    tableInsertsSinceVacuum,
    indexStats,
    walStats,
    checkpointStats,
    replicationStats,
    replicaStatus,
    vacuumProgress
};
