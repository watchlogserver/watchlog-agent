// parsers.js — pure transforms for MySQL status, variables, digests, InnoDB,
// locks and replication.
//
// I/O free so every shape can be unit-tested against captured real output. MySQL
// output varies more by version than Mongo's or Redis's does — SHOW REPLICA
// STATUS versus SHOW SLAVE STATUS, performance_schema.data_locks versus
// information_schema.innodb_lock_waits — and those differences are exactly what
// a live-server-only test can never cover.
//
// Every function is total: missing or malformed input yields an empty/neutral
// result rather than throwing, because one unavailable source must never take
// down the whole MySQL integration.

'use strict';

const { normalizeDigestText, statementType, safeIdentifier } = require('./normalize');

// performance_schema timers are in PICOSECONDS. Every duration this module
// emits is milliseconds, so the divisor is 1e9 — not 1e6, which would be the
// microsecond reading and is the single easiest mistake to make here.
const PICOS_PER_MS = 1e9;

function num(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/** Converts a performance_schema picosecond timer to milliseconds. */
function picosToMs(picos) {
    return num(picos) / PICOS_PER_MS;
}

/**
 * SHOW GLOBAL STATUS / SHOW VARIABLES rows into a flat map.
 *
 * mysql2 returns `[{Variable_name, Value}, ...]`, but the column names differ in
 * case across versions and drivers, so the row is read positionally as a
 * fallback rather than by a hard-coded key.
 */
function parseKeyValueRows(rows) {
    const out = {};
    if (!Array.isArray(rows)) return out;

    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;

        let name = row.Variable_name !== undefined ? row.Variable_name
            : row.VARIABLE_NAME !== undefined ? row.VARIABLE_NAME
                : row.variable_name;
        let value = row.Value !== undefined ? row.Value
            : row.VARIABLE_VALUE !== undefined ? row.VARIABLE_VALUE
                : row.value;

        if (name === undefined) {
            const values = Object.values(row);
            if (values.length < 2) continue;
            name = values[0];
            value = values[1];
        }

        if (name === undefined || name === null) continue;
        out[String(name)] = value === null || value === undefined ? '' : String(value);
    }

    return out;
}

/** Reads a numeric status/variable, tolerating absence across versions. */
function statusNumber(map, key, fallback = 0) {
    if (!map) return fallback;
    if (map[key] !== undefined) return num(map[key]);
    // Status variable casing is not consistent across MySQL/MariaDB.
    const lowered = String(key).toLowerCase();
    for (const actual of Object.keys(map)) {
        if (actual.toLowerCase() === lowered) return num(map[actual]);
    }
    return fallback;
}

function statusString(map, key, fallback = '') {
    if (!map) return fallback;
    if (map[key] !== undefined) return String(map[key]);
    const lowered = String(key).toLowerCase();
    for (const actual of Object.keys(map)) {
        if (actual.toLowerCase() === lowered) return String(map[actual]);
    }
    return fallback;
}

/**
 * Parses a MySQL version string into comparable parts.
 *
 * `8.0.44`, `5.7.24-log`, `10.6.5-MariaDB` all appear in the wild; the flavour
 * matters because MariaDB diverges on replication statements and lock tables.
 */
function parseVersion(versionString) {
    const raw = String(versionString || '');
    const match = raw.match(/^(\d+)\.(\d+)\.(\d+)/);
    const isMariaDb = /mariadb/i.test(raw);

    const major = match ? Number(match[1]) : 0;
    const minor = match ? Number(match[2]) : 0;
    const patch = match ? Number(match[3]) : 0;

    return {
        raw,
        major, minor, patch,
        isMariaDb,
        // `SHOW REPLICA STATUS` and performance_schema.data_locks arrived in
        // MySQL 8.0.22 and 8.0 respectively; MariaDB never adopted either.
        supportsReplicaTerminology: !isMariaDb && (major > 8 || (major === 8 && (minor > 0 || patch >= 22))),
        supportsDataLocks: !isMariaDb && major >= 8,
        atLeast(targetMajor, targetMinor = 0) {
            if (major !== targetMajor) return major > targetMajor;
            return minor >= targetMinor;
        }
    };
}

/**
 * Builds the server section from SHOW VARIABLES + SHOW GLOBAL STATUS.
 *
 * Deliberately excludes anything credential-shaped. MySQL exposes plenty of it
 * in SHOW VARIABLES and none of it belongs in a metrics pipeline.
 */
function buildServer(variables, status, versionInfo) {
    return {
        version: versionInfo.raw,
        versionComment: statusString(variables, 'version_comment'),
        versionMajor: versionInfo.major,
        versionMinor: versionInfo.minor,
        flavour: versionInfo.isMariaDb ? 'mariadb' : 'mysql',
        hostname: statusString(variables, 'hostname'),
        port: statusNumber(variables, 'port'),
        serverUuid: statusString(variables, 'server_uuid'),
        serverId: statusNumber(variables, 'server_id'),
        uptimeSeconds: statusNumber(status, 'Uptime'),
        readOnly: statusString(variables, 'read_only') === 'ON',
        superReadOnly: statusString(variables, 'super_read_only') === 'ON',
        defaultStorageEngine: statusString(variables, 'default_storage_engine'),
        maxConnections: statusNumber(variables, 'max_connections'),
        tableOpenCache: statusNumber(variables, 'table_open_cache'),
        threadCacheSize: statusNumber(variables, 'thread_cache_size'),
        innodbBufferPoolSize: statusNumber(variables, 'innodb_buffer_pool_size'),
        longQueryTime: Number(statusString(variables, 'long_query_time', '0')) || 0,
        slowQueryLogEnabled: statusString(variables, 'slow_query_log') === 'ON',
        performanceSchemaEnabled: statusString(variables, 'performance_schema') === 'ON',
        binlogEnabled: statusString(variables, 'log_bin') === 'ON',
        binlogFormat: statusString(variables, 'binlog_format'),
        binlogRowImage: statusString(variables, 'binlog_row_image')
    };
}

function buildConnections(variables, status) {
    const connected = statusNumber(status, 'Threads_connected');
    const maxConnections = statusNumber(variables, 'max_connections');

    return {
        threadsConnected: connected,
        threadsRunning: statusNumber(status, 'Threads_running'),
        threadsCached: statusNumber(status, 'Threads_cached'),
        threadsCreated: statusNumber(status, 'Threads_created'),
        connections: statusNumber(status, 'Connections'),
        maxUsedConnections: statusNumber(status, 'Max_used_connections'),
        abortedConnects: statusNumber(status, 'Aborted_connects'),
        abortedClients: statusNumber(status, 'Aborted_clients'),
        maxConnections,
        // Without max_connections there is no denominator; null keeps the UI
        // from drawing a gauge against a made-up limit.
        connectionUsagePercentage: maxConnections > 0 ? (connected / maxConnections) * 100 : null
    };
}

function buildQueryCounters(status) {
    return {
        questions: statusNumber(status, 'Questions'),
        queries: statusNumber(status, 'Queries'),
        comSelect: statusNumber(status, 'Com_select'),
        comInsert: statusNumber(status, 'Com_insert'),
        comUpdate: statusNumber(status, 'Com_update'),
        comDelete: statusNumber(status, 'Com_delete'),
        comReplace: statusNumber(status, 'Com_replace'),
        comCommit: statusNumber(status, 'Com_commit'),
        comRollback: statusNumber(status, 'Com_rollback'),
        slowQueries: statusNumber(status, 'Slow_queries')
    };
}

function buildInnodb(status) {
    const pagesTotal = statusNumber(status, 'Innodb_buffer_pool_pages_total');
    const pagesData = statusNumber(status, 'Innodb_buffer_pool_pages_data');
    const pagesDirty = statusNumber(status, 'Innodb_buffer_pool_pages_dirty');

    return {
        bufferPoolPagesTotal: pagesTotal,
        bufferPoolPagesData: pagesData,
        bufferPoolPagesFree: statusNumber(status, 'Innodb_buffer_pool_pages_free'),
        bufferPoolPagesDirty: pagesDirty,
        bufferPoolBytesData: statusNumber(status, 'Innodb_buffer_pool_bytes_data'),
        bufferPoolBytesDirty: statusNumber(status, 'Innodb_buffer_pool_bytes_dirty'),
        bufferPoolReadRequests: statusNumber(status, 'Innodb_buffer_pool_read_requests'),
        bufferPoolReads: statusNumber(status, 'Innodb_buffer_pool_reads'),
        bufferPoolWaitFree: statusNumber(status, 'Innodb_buffer_pool_wait_free'),
        bufferPoolWriteRequests: statusNumber(status, 'Innodb_buffer_pool_write_requests'),

        bufferPoolUtilization: pagesTotal > 0 ? (pagesData / pagesTotal) * 100 : null,
        dirtyPagePercentage: pagesData > 0 ? (pagesDirty / pagesData) * 100 : null,

        dataReads: statusNumber(status, 'Innodb_data_reads'),
        dataWrites: statusNumber(status, 'Innodb_data_writes'),
        dataRead: statusNumber(status, 'Innodb_data_read'),
        dataWritten: statusNumber(status, 'Innodb_data_written'),
        dataFsyncs: statusNumber(status, 'Innodb_data_fsyncs'),
        osLogWritten: statusNumber(status, 'Innodb_os_log_written'),
        logWaits: statusNumber(status, 'Innodb_log_waits'),
        logWriteRequests: statusNumber(status, 'Innodb_log_write_requests'),
        logWrites: statusNumber(status, 'Innodb_log_writes'),

        rowsRead: statusNumber(status, 'Innodb_rows_read'),
        rowsInserted: statusNumber(status, 'Innodb_rows_inserted'),
        rowsUpdated: statusNumber(status, 'Innodb_rows_updated'),
        rowsDeleted: statusNumber(status, 'Innodb_rows_deleted'),

        rowLockCurrentWaits: statusNumber(status, 'Innodb_row_lock_current_waits'),
        rowLockTime: statusNumber(status, 'Innodb_row_lock_time'),
        rowLockTimeAvg: statusNumber(status, 'Innodb_row_lock_time_avg'),
        rowLockTimeMax: statusNumber(status, 'Innodb_row_lock_time_max'),
        rowLockWaits: statusNumber(status, 'Innodb_row_lock_waits'),
        // Innodb_deadlocks is a MariaDB status variable; MySQL only exposes the
        // count via SHOW ENGINE INNODB STATUS, so 0 here means "not reported",
        // not "no deadlocks".
        deadlocks: statusNumber(status, 'Innodb_deadlocks')
    };
}

function buildTempAndSort(status) {
    return {
        createdTmpTables: statusNumber(status, 'Created_tmp_tables'),
        createdTmpDiskTables: statusNumber(status, 'Created_tmp_disk_tables'),
        createdTmpFiles: statusNumber(status, 'Created_tmp_files'),
        sortMergePasses: statusNumber(status, 'Sort_merge_passes'),
        sortRange: statusNumber(status, 'Sort_range'),
        sortRows: statusNumber(status, 'Sort_rows'),
        sortScan: statusNumber(status, 'Sort_scan'),
        selectFullJoin: statusNumber(status, 'Select_full_join'),
        selectScan: statusNumber(status, 'Select_scan')
    };
}

function buildTableCache(variables, status) {
    return {
        openTables: statusNumber(status, 'Open_tables'),
        openedTables: statusNumber(status, 'Opened_tables'),
        tableOpenCacheHits: statusNumber(status, 'Table_open_cache_hits'),
        tableOpenCacheMisses: statusNumber(status, 'Table_open_cache_misses'),
        tableOpenCacheOverflows: statusNumber(status, 'Table_open_cache_overflows'),
        tableOpenCache: statusNumber(variables, 'table_open_cache')
    };
}

// Statements the agent itself issues, plus the administrative noise that shares
// their shape. Without this the "top queries" list is dominated by Watchlog's
// own monitoring, which is both useless and alarming to read.
//
// The cost is that a customer query genuinely reading information_schema or
// performance_schema is hidden too. That is the right trade: those are
// introspection queries, not application workload.
const AGENT_QUERY_PATTERNS = [
    /\bperformance_schema\b/i,
    /\binformation_schema\b/i,
    /^\s*SHOW\s+(GLOBAL\s+)?(STATUS|VARIABLES)\b/i,
    /^\s*SHOW\s+(REPLICA|SLAVE|REPLICAS|MASTER|BINARY)\b/i,
    /^\s*SELECT\s+@@/i,
    /^\s*SET\s+(NAMES|autocommit|SESSION)\b/i
];

function isAgentQuery(digestText) {
    if (!digestText) return false;
    return AGENT_QUERY_PATTERNS.some((re) => re.test(digestText));
}

/**
 * performance_schema.events_statements_summary_by_digest rows into query
 * records, with every timer converted to milliseconds and text normalised.
 *
 * @param {Array} rows
 * @param {object} [options]
 * @param {boolean} [options.includeAgentQueries=false] keep the agent's own
 *        monitoring statements; used by tests, never in production collection.
 */
function parseDigestRows(rows, options = {}) {
    if (!Array.isArray(rows)) return [];

    const out = [];
    for (const row of rows) {
        if (!row) continue;
        if (!options.includeAgentQueries && isAgentQuery(row.DIGEST_TEXT)) continue;

        const executionCount = num(row.COUNT_STAR);
        const totalDuration = picosToMs(row.SUM_TIMER_WAIT);
        const rowsSent = num(row.SUM_ROWS_SENT);
        const rowsExamined = num(row.SUM_ROWS_EXAMINED);
        const digestText = normalizeDigestText(row.DIGEST_TEXT);

        out.push({
            digest: safeIdentifier(row.DIGEST, 64),
            digestText,
            statementType: statementType(digestText),
            database: safeIdentifier(row.SCHEMA_NAME, 128),

            executionCount,
            totalDuration,
            avgDuration: picosToMs(row.AVG_TIMER_WAIT),
            maxDuration: picosToMs(row.MAX_TIMER_WAIT),
            minDuration: picosToMs(row.MIN_TIMER_WAIT),

            rowsExamined,
            rowsSent,
            // The ratio is the clearest single indicator of a missing index:
            // near 1 means the index found exactly the rows needed.
            rowsExaminedPerRow: rowsSent > 0 ? rowsExamined / rowsSent : rowsExamined,

            tmpTables: num(row.SUM_CREATED_TMP_TABLES),
            tmpDiskTables: num(row.SUM_CREATED_TMP_DISK_TABLES),
            sortRows: num(row.SUM_SORT_ROWS),
            noIndexUsed: num(row.SUM_NO_INDEX_USED),
            noGoodIndexUsed: num(row.SUM_NO_GOOD_INDEX_USED),
            errors: num(row.SUM_ERRORS),
            warnings: num(row.SUM_WARNINGS),

            firstSeen: row.FIRST_SEEN ? new Date(row.FIRST_SEEN).getTime() : 0,
            lastSeen: row.LAST_SEEN ? new Date(row.LAST_SEEN).getTime() : 0
        });
    }

    return out;
}

/** information_schema.tables rows into per-table records. */
function parseTableRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => {
        const dataSize = num(row.DATA_LENGTH);
        const indexSize = num(row.INDEX_LENGTH);
        return {
            database: safeIdentifier(row.TABLE_SCHEMA, 128),
            table: safeIdentifier(row.TABLE_NAME, 128),
            engine: safeIdentifier(row.ENGINE, 32),
            // TABLE_ROWS is an estimate for InnoDB, derived from sampled index
            // statistics. It is fine for ranking and wrong for accounting.
            rows: num(row.TABLE_ROWS),
            dataSize,
            indexSize,
            totalSize: dataSize + indexSize,
            dataFree: num(row.DATA_FREE),
            autoIncrement: num(row.AUTO_INCREMENT),
            rowFormat: safeIdentifier(row.ROW_FORMAT, 32),
            createTime: row.CREATE_TIME ? new Date(row.CREATE_TIME).getTime() : 0,
            updateTime: row.UPDATE_TIME ? new Date(row.UPDATE_TIME).getTime() : 0
        };
    });
}

/** Rolls per-table records up to per-database totals. */
function aggregateDatabases(tables) {
    const byDatabase = new Map();

    for (const table of tables || []) {
        if (!byDatabase.has(table.database)) {
            byDatabase.set(table.database, {
                database: table.database,
                tableCount: 0, rows: 0, dataSize: 0, indexSize: 0, totalSize: 0, dataFree: 0
            });
        }
        const entry = byDatabase.get(table.database);
        entry.tableCount += 1;
        entry.rows += table.rows;
        entry.dataSize += table.dataSize;
        entry.indexSize += table.indexSize;
        entry.totalSize += table.totalSize;
        entry.dataFree += table.dataFree;
    }

    return Array.from(byDatabase.values()).sort((a, b) => b.totalSize - a.totalSize);
}

/**
 * performance_schema.table_io_waits_summary_by_index_usage rows.
 *
 * A NULL INDEX_NAME row is the table's non-index (full scan) activity, which is
 * a genuinely useful signal, so it is kept and labelled rather than dropped.
 */
function parseIndexRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => {
        const indexName = row.INDEX_NAME === null || row.INDEX_NAME === undefined
            ? '' : safeIdentifier(row.INDEX_NAME, 128);
        const reads = num(row.COUNT_READ);
        const writes = num(row.COUNT_WRITE);

        return {
            database: safeIdentifier(row.OBJECT_SCHEMA, 128),
            table: safeIdentifier(row.OBJECT_NAME, 128),
            index: indexName || '(no index)',
            isNoIndex: !indexName,
            // PRIMARY and UNIQUE indexes are structural; the UI must never
            // suggest dropping them however low their read count is.
            isPrimary: indexName === 'PRIMARY',
            reads,
            writes,
            fetches: num(row.COUNT_FETCH),
            inserts: num(row.COUNT_INSERT),
            updates: num(row.COUNT_UPDATE),
            deletes: num(row.COUNT_DELETE),
            totalWait: picosToMs(row.SUM_TIMER_WAIT),
            readWait: picosToMs(row.SUM_TIMER_READ),
            writeWait: picosToMs(row.SUM_TIMER_WRITE),
            // Filled in from information_schema.statistics; performance_schema
            // does not report uniqueness, and a UNIQUE index enforces a
            // constraint whatever its read count.
            isUnique: false,
            cardinality: 0,
            // Zero reads is the unused signal. Writes are the *cost* of an
            // index, not evidence it is earning its keep — and MySQL attributes
            // INSERT writes to the table row rather than each secondary index,
            // so requiring writes === 0 too would be both wrong and redundant.
            unused: reads === 0 && !!indexName && indexName !== 'PRIMARY'
        };
    });
}

/**
 * Merges uniqueness and cardinality from information_schema.statistics into
 * index usage records, so the UI can withhold a drop recommendation for
 * constraint-bearing indexes.
 */
function mergeIndexMetadata(indexes, metadataRows) {
    const meta = new Map();
    for (const row of metadataRows || []) {
        const key = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}.${row.INDEX_NAME}`;
        // statistics has one row per column in a composite index; NON_UNIQUE is
        // identical across them, and the highest cardinality is the useful one.
        const existing = meta.get(key);
        const cardinality = num(row.CARDINALITY);
        if (!existing || cardinality > existing.cardinality) {
            meta.set(key, { isUnique: num(row.NON_UNIQUE) === 0, cardinality });
        }
    }

    for (const index of indexes || []) {
        const found = meta.get(`${index.database}.${index.table}.${index.index}`);
        if (!found) continue;
        index.isUnique = found.isUnique;
        index.cardinality = found.cardinality;
        // A UNIQUE index is a constraint first and an access path second.
        if (found.isUnique) index.unused = false;
    }

    return indexes;
}

/**
 * Normalises SHOW REPLICA STATUS (8.0.22+) and SHOW SLAVE STATUS (older MySQL,
 * all MariaDB) into one shape so nothing downstream branches on version.
 */
function parseReplicaStatus(rows) {
    if (!Array.isArray(rows) || rows.length === 0) {
        return { enabled: false, role: 'source', replicas: [] };
    }

    const replicas = rows.map((row) => {
        const pick = (...names) => {
            for (const name of names) {
                if (row[name] !== undefined && row[name] !== null) return row[name];
            }
            return undefined;
        };

        const ioRunningRaw = String(pick('Replica_IO_Running', 'Slave_IO_Running') || '');
        const sqlRunningRaw = String(pick('Replica_SQL_Running', 'Slave_SQL_Running') || '');
        const secondsBehindRaw = pick('Seconds_Behind_Source', 'Seconds_Behind_Master');

        return {
            sourceHost: safeIdentifier(pick('Source_Host', 'Master_Host'), 255),
            sourcePort: num(pick('Source_Port', 'Master_Port')),
            // Credentials are never read: Source_User exists in this row set and
            // is deliberately not collected.
            ioRunning: ioRunningRaw === 'Yes',
            ioRunningRaw,
            sqlRunning: sqlRunningRaw === 'Yes',
            sqlRunningRaw,
            // NULL Seconds_Behind means the replica is not connected at all —
            // materially different from 0 (caught up), so it stays null.
            secondsBehind: secondsBehindRaw === null || secondsBehindRaw === undefined
                ? null : num(secondsBehindRaw),
            relayLogSpace: num(pick('Relay_Log_Space')),
            readSourceLogPos: num(pick('Read_Source_Log_Pos', 'Read_Master_Log_Pos')),
            execSourceLogPos: num(pick('Exec_Source_Log_Pos', 'Exec_Master_Log_Pos')),
            sourceLogFile: safeIdentifier(pick('Source_Log_File', 'Master_Log_File'), 255),
            lastIoErrno: num(pick('Last_IO_Errno')),
            lastIoError: safeIdentifier(pick('Last_IO_Error'), 512),
            lastSqlErrno: num(pick('Last_SQL_Errno')),
            lastSqlError: safeIdentifier(pick('Last_SQL_Error'), 512),
            replicaIoState: safeIdentifier(pick('Replica_IO_State', 'Slave_IO_State'), 255),
            autoPosition: String(pick('Auto_Position') || '') === '1',
            channelName: safeIdentifier(pick('Channel_Name'), 64)
        };
    });

    const healthy = replicas.every((r) => r.ioRunning && r.sqlRunning);

    return {
        enabled: true,
        role: 'replica',
        replicas,
        healthy,
        maxSecondsBehind: replicas.reduce(
            (max, r) => (r.secondsBehind === null ? max : Math.max(max, r.secondsBehind)), 0
        ),
        hasErrors: replicas.some((r) => r.lastIoErrno > 0 || r.lastSqlErrno > 0),
        anyDisconnected: replicas.some((r) => r.secondsBehind === null)
    };
}

/** SHOW REPLICAS / SHOW SLAVE HOSTS — the primary's view of its replicas. */
function parseConnectedReplicas(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return [];

    return rows.map((row) => ({
        serverId: num(row.Server_Id !== undefined ? row.Server_Id : row.Server_id),
        host: safeIdentifier(row.Host, 255),
        port: num(row.Port),
        sourceId: num(row.Source_Id !== undefined ? row.Source_Id : row.Master_id),
        replicaUuid: safeIdentifier(
            row.Replica_UUID !== undefined ? row.Replica_UUID : row.Slave_UUID, 64
        )
    }));
}

/**
 * performance_schema.data_lock_waits joined with data_locks (MySQL 8), or
 * information_schema.innodb_lock_waits (MySQL 5.7 / MariaDB).
 *
 * Lock waits are transient and high-cardinality, so these become event
 * documents rather than time-series points.
 */
function parseLockWaits(rows) {
    if (!Array.isArray(rows)) return [];

    return rows.map((row) => ({
        waitingThreadId: num(row.waiting_thread_id),
        waitingProcessId: num(row.waiting_pid),
        blockingThreadId: num(row.blocking_thread_id),
        blockingProcessId: num(row.blocking_pid),
        database: safeIdentifier(row.object_schema, 128),
        table: safeIdentifier(row.object_name, 128),
        indexName: safeIdentifier(row.index_name, 128),
        lockType: safeIdentifier(row.lock_type, 32),
        lockMode: safeIdentifier(row.lock_mode, 32),
        lockStatus: safeIdentifier(row.lock_status, 32),
        // Statement text is normalised on the way in; raw SQL is never kept.
        waitingQuery: normalizeDigestText(row.waiting_query),
        blockingQuery: normalizeDigestText(row.blocking_query),
        waitingQueryDigest: safeIdentifier(row.waiting_digest, 64),
        blockingQueryDigest: safeIdentifier(row.blocking_digest, 64),
        waitAgeSeconds: num(row.wait_age_secs),
        waitingTrxRowsModified: num(row.waiting_trx_rows_modified),
        blockingTrxRowsModified: num(row.blocking_trx_rows_modified)
    }));
}

module.exports = {
    num,
    picosToMs,
    parseKeyValueRows,
    statusNumber,
    statusString,
    parseVersion,
    buildServer,
    buildConnections,
    buildQueryCounters,
    buildInnodb,
    buildTempAndSort,
    buildTableCache,
    parseDigestRows,
    isAgentQuery,
    AGENT_QUERY_PATTERNS,
    parseTableRows,
    aggregateDatabases,
    parseIndexRows,
    mergeIndexMetadata,
    parseReplicaStatus,
    parseConnectedReplicas,
    parseLockWaits,
    PICOS_PER_MS
};
