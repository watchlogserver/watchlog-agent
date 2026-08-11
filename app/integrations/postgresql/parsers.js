// parsers.js — pure transforms for PostgreSQL statistics rows.
//
// I/O free so every shape can be unit-tested against captured output, including
// the version differences a live server cannot demonstrate on its own: a 9.6
// activity row, a 17 checkpointer row, a replica's replay status.
//
// Every function is total: missing or malformed input yields an empty/neutral
// result rather than throwing, because one unavailable view must never take
// down the whole PostgreSQL integration.

'use strict';

const { normalizeStatement, normalizeActivityQuery, statementType, safeIdentifier } = require('./normalize');

function num(value) {
    if (value === null || value === undefined || value === '') return 0;
    // pg returns bigint and numeric as strings to avoid precision loss.
    const n = typeof value === 'string' ? Number(value) : Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Preserves a genuine null instead of collapsing it to 0. */
function nullableNum(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function ms(value) {
    if (!value) return 0;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : 0;
}

/**
 * Parses a PostgreSQL version into comparable parts.
 *
 * All comparisons run against `server_version_num`, which is monotonic across
 * both numbering eras: 9.6.3 is 90603 and 15.4 is 150004. Deriving a "major"
 * integer and comparing that instead would rank 9.6 above 15, because the
 * pre-10 scheme packs the minor into the same field.
 *
 * `atLeast` takes a release the way people say it — atLeast(14), atLeast(96)
 * for 9.6 — and converts to the numeric form internally.
 */
function parseVersion(versionNum, versionString) {
    const numeric = Number(versionNum) || 0;

    // Pre-10 releases are MMmmpp (90603 = 9.6.3); 10+ are MMpppp (150004 = 15.4).
    const isLegacy = numeric > 0 && numeric < 100000;
    const major = numeric === 0 ? 0 : (isLegacy ? 9 : Math.floor(numeric / 10000));
    const minor = isLegacy ? Math.floor((numeric % 10000) / 100) : 0;

    return {
        raw: String(versionString || ''),
        versionNum: numeric,
        major,
        minor,
        // "9.6" or "15"
        label: numeric === 0 ? '' : (isLegacy ? `${major}.${minor}` : String(major)),
        atLeast(target) {
            if (!numeric) return false;
            // 96 is shorthand for 9.6, whose numeric form is 90600.
            const threshold = target === 96 ? 90600 : target * 10000;
            return numeric >= threshold;
        }
    };
}

/** Server identity plus the settings the dashboard reports. */
function parseServerInfo(row, version) {
    if (!row) return null;
    return {
        version: String(row.server_version || ''),
        versionNum: num(row.server_version_num),
        versionFull: safeIdentifier(row.version_full, 256),
        major: version.major,
        currentDatabase: safeIdentifier(row.current_database, 128),
        inRecovery: row.in_recovery === true,
        // A server in recovery is a replica; otherwise it is a primary only if
        // it actually has replicas, which the caller decides.
        role: row.in_recovery === true ? 'replica' : 'primary',
        uptimeSeconds: num(row.uptime_seconds),
        maxConnections: num(row.max_connections),
        sharedBuffers: safeIdentifier(row.shared_buffers, 32),
        effectiveCacheSize: safeIdentifier(row.effective_cache_size, 32),
        workMem: safeIdentifier(row.work_mem, 32),
        maintenanceWorkMem: safeIdentifier(row.maintenance_work_mem, 32),
        autovacuumEnabled: String(row.autovacuum || '') === 'on',
        trackIoTiming: String(row.track_io_timing || '') === 'on',
        trackActivityQuerySize: num(row.track_activity_query_size),
        defaultTransactionIsolation: safeIdentifier(row.default_transaction_isolation, 32)
    };
}

/**
 * Folds the per-(database, state) connection rows into totals plus a per-state
 * and per-database breakdown.
 *
 * Only aggregate shapes go to InfluxDB; pid, application_name and client_addr
 * are deliberately never used as tags.
 */
function parseConnections(rows, maxConnections) {
    const summary = {
        total: 0, active: 0, idle: 0,
        idleInTransaction: 0, idleInTransactionAborted: 0,
        waiting: 0, other: 0,
        maxConnections: num(maxConnections),
        longestTransactionSeconds: 0,
        longestQuerySeconds: 0,
        longestIdleInTransactionSeconds: 0,
        byState: {},
        byDatabase: {}
    };

    for (const row of rows || []) {
        const state = String(row.state || 'unknown');
        const count = num(row.count);
        const database = String(row.database || 'unknown');

        summary.total += count;
        summary.waiting += num(row.waiting);
        summary.byState[state] = (summary.byState[state] || 0) + count;
        summary.byDatabase[database] = (summary.byDatabase[database] || 0) + count;

        if (state === 'active') summary.active += count;
        else if (state === 'idle') summary.idle += count;
        else if (state === 'idle in transaction') {
            summary.idleInTransaction += count;
            summary.longestIdleInTransactionSeconds = Math.max(
                summary.longestIdleInTransactionSeconds, num(row.max_state_seconds)
            );
        } else if (state === 'idle in transaction (aborted)') {
            summary.idleInTransactionAborted += count;
            summary.longestIdleInTransactionSeconds = Math.max(
                summary.longestIdleInTransactionSeconds, num(row.max_state_seconds)
            );
        } else summary.other += count;

        summary.longestTransactionSeconds = Math.max(summary.longestTransactionSeconds, num(row.max_xact_seconds));
        summary.longestQuerySeconds = Math.max(summary.longestQuerySeconds, num(row.max_query_seconds));
    }

    // Without max_connections there is no denominator; null keeps the UI from
    // drawing a gauge against a made-up limit.
    summary.connectionUsagePercentage = summary.maxConnections > 0
        ? (summary.total / summary.maxConnections) * 100
        : null;

    return summary;
}

/** pg_stat_database rows, with the derived cache hit ratio. */
function parseDatabaseStats(rows) {
    return (rows || []).map((row) => {
        const blksHit = num(row.blks_hit);
        const blksRead = num(row.blks_read);
        const totalBlocks = blksHit + blksRead;

        return {
            database: safeIdentifier(row.database, 128),
            numbackends: num(row.numbackends),
            xactCommit: num(row.xact_commit),
            xactRollback: num(row.xact_rollback),
            blksRead, blksHit,
            tupReturned: num(row.tup_returned),
            tupFetched: num(row.tup_fetched),
            tupInserted: num(row.tup_inserted),
            tupUpdated: num(row.tup_updated),
            tupDeleted: num(row.tup_deleted),
            conflicts: num(row.conflicts),
            tempFiles: num(row.temp_files),
            tempBytes: num(row.temp_bytes),
            deadlocks: num(row.deadlocks),
            blkReadTime: num(row.blk_read_time),
            blkWriteTime: num(row.blk_write_time),
            // PostgreSQL 14+; null on older servers rather than a fabricated 0.
            sessionTime: nullableNum(row.session_time),
            activeTime: nullableNum(row.active_time),
            idleInTransactionTime: nullableNum(row.idle_in_transaction_time),
            sessions: nullableNum(row.sessions),
            sessionsAbandoned: nullableNum(row.sessions_abandoned),
            sessionsFatal: nullableNum(row.sessions_fatal),
            sessionsKilled: nullableNum(row.sessions_killed),
            // Null when the role cannot CONNECT to that database, so its size is
            // genuinely unknown. Zero would read as "an empty database".
            databaseSize: nullableNum(row.database_size),
            // Lifetime ratio. No blocks touched means no ratio, not 100%.
            cacheHitRatio: totalBlocks > 0 ? (blksHit / totalBlocks) * 100 : null
        };
    });
}

/**
 * pg_stat_statements rows.
 *
 * Timings are already milliseconds (double precision) — unlike MySQL's
 * picosecond timers, no unit conversion is needed or wanted here.
 */
function parseStatements(rows, options = {}) {
    const out = [];

    for (const row of rows || []) {
        const query = normalizeStatement(row.query);
        if (!options.includeAgentQueries && isAgentStatement(query)) continue;

        const calls = num(row.calls);
        const rowsReturned = num(row.rows);

        out.push({
            queryId: safeIdentifier(row.queryid, 32),
            database: safeIdentifier(row.database, 128),
            query,
            statementType: statementType(query),

            calls,
            totalExecTime: num(row.total_exec_time),
            meanExecTime: num(row.mean_exec_time),
            minExecTime: num(row.min_exec_time),
            maxExecTime: num(row.max_exec_time),
            stddevExecTime: num(row.stddev_exec_time),

            rows: rowsReturned,
            rowsPerCall: calls > 0 ? rowsReturned / calls : 0,

            sharedBlksHit: num(row.shared_blks_hit),
            sharedBlksRead: num(row.shared_blks_read),
            sharedBlksDirtied: num(row.shared_blks_dirtied),
            sharedBlksWritten: num(row.shared_blks_written),
            localBlksHit: num(row.local_blks_hit),
            localBlksRead: num(row.local_blks_read),
            localBlksDirtied: num(row.local_blks_dirtied),
            localBlksWritten: num(row.local_blks_written),
            tempBlksRead: num(row.temp_blks_read),
            tempBlksWritten: num(row.temp_blks_written),

            blkReadTime: num(row.blk_read_time),
            blkWriteTime: num(row.blk_write_time),
            tempBlkReadTime: num(row.temp_blk_read_time),
            tempBlkWriteTime: num(row.temp_blk_write_time),

            walRecords: num(row.wal_records),
            walFpi: num(row.wal_fpi),
            walBytes: num(row.wal_bytes),

            plans: num(row.plans),
            totalPlanTime: num(row.total_plan_time),
            meanPlanTime: num(row.mean_plan_time),
            maxPlanTime: num(row.max_plan_time)
        });
    }

    return out;
}

// Statements the agent itself issues. Without this the "top queries" list is
// dominated by Watchlog reading the statistics views every minute.
const AGENT_STATEMENT_PATTERNS = [
    /\bpg_stat_(statements|activity|database|user_tables|user_indexes|replication|wal|bgwriter|checkpointer|progress_vacuum|io)\b/i,
    /\bpg_statio_user_(tables|indexes)\b/i,
    /\bpg_locks\b/i,
    /\bpg_blocking_pids\b/i,
    /^\s*SHOW\b/i,
    /\bcurrent_setting\s*\(/i,
    /\bpg_settings\b/i,
    /\bpg_postmaster_start_time\b/i,
    /\bpg_is_in_recovery\b/i,
    // The capability probes themselves, which otherwise show up as top queries.
    /\bto_regclass\s*\(/i,
    /\bpg_extension\b/i,
    /\bpg_views\b/i,
    /\bpg_backend_pid\s*\(/i,
    // Replication position, on both the modern and the pre-10 spelling.
    /\bpg_(last|current)_wal_[a-z_]*\s*\(/i,
    /\bpg_(last|current)_xlog_[a-z_]*\s*\(/i,
    /\bpg_last_xact_replay_timestamp\s*\(/i,
    /\bpg_(wal_lsn|xlog_location)_diff\s*\(/i,
    // Relation sizing, read once per storage scrape. A customer query calling
    // these is monitoring code rather than application workload, so filtering
    // it out costs nothing and keeps the agent from ranking itself.
    /\bpg_(database|relation|total_relation|indexes)_size\s*\(/i
];

function isAgentStatement(query) {
    if (!query) return false;
    return AGENT_STATEMENT_PATTERNS.some((re) => re.test(query));
}

/** pg_stat_activity rows for the Activity tab. Raw query text is scrubbed. */
function parseActivity(rows) {
    return (rows || []).map((row) => ({
        pid: num(row.pid),
        database: safeIdentifier(row.database, 128),
        username: safeIdentifier(row.username, 128),
        state: safeIdentifier(row.state, 48),
        waitEventType: safeIdentifier(row.wait_event_type, 48),
        waitEvent: safeIdentifier(row.wait_event, 64),
        backendType: safeIdentifier(row.backend_type, 48),
        querySeconds: num(row.query_seconds),
        xactSeconds: num(row.xact_seconds),
        stateSeconds: num(row.state_seconds),
        waiting: !!row.wait_event_type,
        // pg_stat_activity holds the executing statement with real literals, so
        // it always gets the full scrub — never the trusting digest path.
        query: normalizeActivityQuery(row.query)
    }));
}

function parseIdleInTransaction(rows) {
    return (rows || []).map((row) => ({
        pid: num(row.pid),
        database: safeIdentifier(row.database, 128),
        username: safeIdentifier(row.username, 128),
        state: safeIdentifier(row.state, 48),
        aborted: String(row.state || '').includes('aborted'),
        xactSeconds: num(row.xact_seconds),
        stateSeconds: num(row.state_seconds),
        query: normalizeActivityQuery(row.query)
    }));
}

/** Blocking / blocked pairs, deduplicated by the pid pair. */
function parseBlockingQueries(rows) {
    const seen = new Set();
    const out = [];

    for (const row of rows || []) {
        const key = `${num(row.blocked_pid)}:${num(row.blocking_pid)}`;
        // pg_blocking_pids can report the same pair once per ungranted lock.
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
            blockedPid: num(row.blocked_pid),
            blockingPid: num(row.blocking_pid),
            database: safeIdentifier(row.database, 128),
            blockedUser: safeIdentifier(row.blocked_user, 128),
            blockingUser: safeIdentifier(row.blocking_user, 128),
            blockingState: safeIdentifier(row.blocking_state, 48),
            blockedSeconds: num(row.blocked_seconds),
            blockedXactSeconds: num(row.blocked_xact_seconds),
            blockingXactSeconds: num(row.blocking_xact_seconds),
            waitEventType: safeIdentifier(row.wait_event_type, 48),
            waitEvent: safeIdentifier(row.wait_event, 64),
            lockType: safeIdentifier(row.lock_type, 32),
            lockMode: safeIdentifier(row.lock_mode, 48),
            relation: safeIdentifier(row.relation, 128),
            blockedQuery: normalizeActivityQuery(row.blocked_query),
            blockingQuery: normalizeActivityQuery(row.blocking_query)
        });
    }

    return out;
}

/** pg_locks aggregate counts — safe as a low-cardinality time series. */
function parseLockSummary(rows) {
    const summary = { total: 0, granted: 0, waiting: 0, byMode: {} };

    for (const row of rows || []) {
        const count = num(row.count);
        const mode = safeIdentifier(row.mode, 48) || 'unknown';
        summary.total += count;
        if (row.granted === true) summary.granted += count;
        else summary.waiting += count;
        summary.byMode[mode] = (summary.byMode[mode] || 0) + count;
    }

    return summary;
}

/** pg_stat_user_tables + pg_statio_user_tables, with derived ratios. */
function parseTableStats(rows, database) {
    return (rows || []).map((row) => {
        const liveTuples = num(row.n_live_tup);
        const deadTuples = num(row.n_dead_tup);
        const totalTuples = liveTuples + deadTuples;

        const heapHit = num(row.heap_blks_hit);
        const heapRead = num(row.heap_blks_read);
        const heapTotal = heapHit + heapRead;

        const idxHit = num(row.idx_blks_hit);
        const idxRead = num(row.idx_blks_read);
        const idxTotal = idxHit + idxRead;

        const seqScan = num(row.seq_scan);
        const idxScan = num(row.idx_scan);

        return {
            database: safeIdentifier(database, 128),
            schema: safeIdentifier(row.schema, 128),
            table: safeIdentifier(row.table, 128),

            seqScan,
            seqTupRead: num(row.seq_tup_read),
            idxScan,
            idxTupFetch: num(row.idx_tup_fetch),
            // Share of scans that used an index. Null with no scans at all —
            // an untouched table has no scan mix to report.
            indexScanRatio: (seqScan + idxScan) > 0 ? (idxScan / (seqScan + idxScan)) * 100 : null,

            nTupIns: num(row.n_tup_ins),
            nTupUpd: num(row.n_tup_upd),
            nTupDel: num(row.n_tup_del),
            nTupHotUpd: num(row.n_tup_hot_upd),
            nModSinceAnalyze: num(row.n_mod_since_analyze),

            liveTuples, deadTuples,
            // Zero denominator means an empty table, which has no ratio.
            deadTupleRatio: totalTuples > 0 ? (deadTuples / totalTuples) * 100 : null,

            lastVacuum: ms(row.last_vacuum),
            lastAutovacuum: ms(row.last_autovacuum),
            lastAnalyze: ms(row.last_analyze),
            lastAutoanalyze: ms(row.last_autoanalyze),
            vacuumCount: num(row.vacuum_count),
            autovacuumCount: num(row.autovacuum_count),
            analyzeCount: num(row.analyze_count),
            autoanalyzeCount: num(row.autoanalyze_count),

            heapBlksRead: heapRead,
            heapBlksHit: heapHit,
            idxBlksRead: idxRead,
            idxBlksHit: idxHit,
            toastBlksRead: num(row.toast_blks_read),
            toastBlksHit: num(row.toast_blks_hit),
            heapCacheHitRatio: heapTotal > 0 ? (heapHit / heapTotal) * 100 : null,
            indexCacheHitRatio: idxTotal > 0 ? (idxHit / idxTotal) * 100 : null,

            totalSize: num(row.total_size),
            dataSize: num(row.data_size),
            indexSize: num(row.index_size)
        };
    });
}

/** pg_stat_user_indexes + size, with an advisory usage classification. */
function parseIndexStats(rows, database) {
    return (rows || []).map((row) => {
        const scans = num(row.idx_scan);
        const isPrimary = row.is_primary === true;
        const isUnique = row.is_unique === true;
        const isConstraint = row.is_constraint === true;

        return {
            database: safeIdentifier(database, 128),
            schema: safeIdentifier(row.schema, 128),
            table: safeIdentifier(row.table, 128),
            index: safeIdentifier(row.index, 128),

            idxScan: scans,
            idxTupRead: num(row.idx_tup_read),
            idxTupFetch: num(row.idx_tup_fetch),
            idxBlksRead: num(row.idx_blks_read),
            idxBlksHit: num(row.idx_blks_hit),
            indexSize: num(row.index_size),

            isUnique, isPrimary, isConstraint,
            // A primary key, unique index or constraint-backed index enforces
            // correctness whatever its scan count, so it is never a removal
            // candidate. The flag is advisory even for the rest.
            unusedCandidate: scans === 0 && !isPrimary && !isUnique && !isConstraint
        };
    });
}

/** pg_stat_wal. Null when the view does not exist (before PostgreSQL 14). */
function parseWalStats(row) {
    if (!row) return null;
    return {
        walRecords: num(row.wal_records),
        walFpi: num(row.wal_fpi),
        walBytes: num(row.wal_bytes),
        walBuffersFull: num(row.wal_buffers_full),
        // Removed in PostgreSQL 18 in favour of pg_stat_io.
        walWrite: nullableNum(row.wal_write),
        walSync: nullableNum(row.wal_sync),
        walWriteTime: nullableNum(row.wal_write_time),
        walSyncTime: nullableNum(row.wal_sync_time)
    };
}

/** pg_stat_bgwriter / pg_stat_checkpointer, normalised to one shape. */
function parseCheckpointStats(row) {
    if (!row) return null;
    return {
        checkpointsTimed: num(row.checkpoints_timed),
        checkpointsRequested: num(row.checkpoints_requested),
        checkpointWriteTime: num(row.checkpoint_write_time),
        checkpointSyncTime: num(row.checkpoint_sync_time),
        buffersCheckpoint: num(row.buffers_checkpoint),
        buffersClean: num(row.buffers_clean),
        maxwrittenClean: num(row.maxwritten_clean),
        buffersBackend: num(row.buffers_backend),
        buffersBackendFsync: num(row.buffers_backend_fsync),
        buffersAlloc: num(row.buffers_alloc)
    };
}

/** pg_stat_replication, as seen from the primary. */
function parseReplication(rows) {
    const replicas = (rows || []).map((row) => ({
        applicationName: safeIdentifier(row.application_name, 128),
        clientAddr: safeIdentifier(row.client_addr, 64),
        state: safeIdentifier(row.state, 32),
        syncState: safeIdentifier(row.sync_state, 32),
        sentLsn: safeIdentifier(row.sent_lsn, 32),
        writeLsn: safeIdentifier(row.write_lsn, 32),
        flushLsn: safeIdentifier(row.flush_lsn, 32),
        replayLsn: safeIdentifier(row.replay_lsn, 32),
        // Lags are intervals in PostgreSQL 10+; null before that rather than 0,
        // which would read as "perfectly caught up".
        writeLag: nullableNum(row.write_lag),
        flushLag: nullableNum(row.flush_lag),
        replayLag: nullableNum(row.replay_lag),
        connectedSeconds: num(row.connected_seconds),
        replyAgeSeconds: num(row.reply_age_seconds),
        walLagBytes: num(row.wal_lag_bytes),
        streaming: String(row.state || '') === 'streaming',
        synchronous: ['sync', 'quorum'].includes(String(row.sync_state || ''))
    }));

    return {
        enabled: replicas.length > 0,
        replicas,
        streamingCount: replicas.filter((r) => r.streaming).length,
        synchronousCount: replicas.filter((r) => r.synchronous).length,
        maxReplayLag: replicas.reduce(
            (max, r) => (r.replayLag === null ? max : Math.max(max, r.replayLag)), 0
        ),
        maxWalLagBytes: replicas.reduce((max, r) => Math.max(max, r.walLagBytes), 0)
    };
}

/**
 * A replica's own replay position.
 *
 * replayAgeSeconds is the age of the last replayed transaction, which is NOT
 * the same as lag: an idle primary produces no transactions, so a large age on
 * a healthy replica is normal. The byte gap is the honest lag signal, and the
 * age is reported alongside it rather than instead of it.
 */
function parseReplicaStatus(row) {
    if (!row) return null;
    const receiveLsn = safeIdentifier(row.receive_lsn, 32);
    const replayLsn = safeIdentifier(row.replay_lsn, 32);

    return {
        receiveLsn,
        replayLsn,
        lastReplayTimestamp: ms(row.last_replay_timestamp),
        replayAgeSeconds: nullableNum(row.replay_age_seconds),
        replayLagBytes: num(row.replay_lag_bytes),
        // Caught up means received and replayed are the same position, which is
        // true regardless of how long ago that happened.
        caughtUp: !!receiveLsn && receiveLsn === replayLsn
    };
}

/** pg_stat_progress_vacuum, with a progress percentage where meaningful. */
function parseVacuumProgress(rows) {
    return (rows || []).map((row) => {
        const total = num(row.heap_blks_total);
        const scanned = num(row.heap_blks_scanned);

        return {
            pid: num(row.pid),
            database: safeIdentifier(row.database, 128),
            relation: safeIdentifier(row.relation, 128),
            phase: safeIdentifier(row.phase, 64),
            heapBlksTotal: total,
            heapBlksScanned: scanned,
            heapBlksVacuumed: num(row.heap_blks_vacuumed),
            indexVacuumCount: num(row.index_vacuum_count),
            maxDeadTuples: num(row.max_dead_tuples),
            numDeadTuples: num(row.num_dead_tuples),
            // Only the scanning phase has a meaningful denominator.
            progressPercentage: total > 0 ? Math.min(100, (scanned / total) * 100) : null
        };
    });
}

module.exports = {
    num,
    nullableNum,
    ms,
    parseVersion,
    parseServerInfo,
    parseConnections,
    parseDatabaseStats,
    parseStatements,
    isAgentStatement,
    AGENT_STATEMENT_PATTERNS,
    parseActivity,
    parseIdleInTransaction,
    parseBlockingQueries,
    parseLockSummary,
    parseTableStats,
    parseIndexStats,
    parseWalStats,
    parseCheckpointStats,
    parseReplication,
    parseReplicaStatus,
    parseVacuumProgress
};
