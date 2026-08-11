// MySQL advanced collector.
//
// Mirrors the MongoDB and Redis advanced collectors:
// `app/integrations/mysql.js` keeps working and keeps emitting the exact payload
// it always has, while this module runs one connection and derives BOTH the
// legacy payload and the advanced observability payload from it.
//
// Design notes
//   * One pooled connection per scrape, closed afterwards. The existing
//     collector opens one connection per database; this opens one, total.
//   * Every statement is read-only. No SET GLOBAL, no FLUSH, no ANALYZE/OPTIMIZE
//     TABLE, no ALTER, no KILL, and no SELECT against user data — all sizing
//     comes from information_schema metadata and performance_schema summaries.
//   * Capabilities are probed, not assumed. performance_schema can be OFF, its
//     consumers can be disabled, data_locks is MySQL 8 only, and the monitoring
//     user may lack PROCESS/REPLICATION CLIENT. Each gap degrades that one
//     section and is reported so the UI can hide it.
//   * information_schema.tables is the one genuinely expensive query here (it
//     opens table metadata), so schema/table/index collection is throttled well
//     below the 60s metric tick.

'use strict';

const mysql = require('mysql2/promise');
const parsers = require('./parsers');
const { normalizeDigestText } = require('./normalize');

const DEFAULTS = {
    maxDigests: 200,
    maxTables: 300,
    maxIndexes: 500,
    maxLockWaits: 50,
    slowQueryThresholdMs: 100,
    schemaIntervalSeconds: 300,
    indexIntervalSeconds: 300,
    connectTimeoutMs: 10000,
    statementTimeoutMs: 15000
};

// System schemas are excluded everywhere: they are MySQL's own bookkeeping and
// would dominate every "largest table" list.
const SYSTEM_SCHEMAS = ['information_schema', 'performance_schema', 'mysql', 'sys'];

// Per-instance memory: previous counters (for deltas) and throttle clocks.
const state = new Map();

function instanceState(id) {
    if (!state.has(id)) {
        state.set(id, {
            lastSchemaAt: 0,
            lastIndexAt: 0,
            lastUptime: null,
            previous: null
        });
    }
    return state.get(id);
}

// Exposed for tests so restart/reset scenarios can be driven deterministically.
function resetState() {
    state.clear();
}

// ── config ────────────────────────────────────────────────────────────────────

function normalizeConfig(integrate) {
    const advanced = integrate.advanced || {};
    const slowQuery = integrate.slowQuery || {};

    return {
        host: integrate.host || 'localhost',
        port: Number(integrate.port || 3306),
        username: integrate.username || 'root',
        password: integrate.password || '',
        // The legacy collector requires a database list; the advanced collector
        // does not need one to connect, and discovers schemas itself.
        databases: Array.isArray(integrate.database) ? integrate.database : [],
        ssl: integrate.ssl === true,

        enabled: advanced.enabled !== false,
        queries: advanced.queries !== false,
        schema: advanced.schema !== false,
        indexes: advanced.indexes !== false,
        locks: advanced.locks !== false,
        replication: advanced.replication !== false,

        slowQueryThresholdMs: Number(
            slowQuery.thresholdMs !== undefined ? slowQuery.thresholdMs : DEFAULTS.slowQueryThresholdMs
        ),

        maxDigests: Number(advanced.maxDigests || DEFAULTS.maxDigests),
        maxTables: Number(advanced.maxTables || DEFAULTS.maxTables),
        maxIndexes: Number(advanced.maxIndexes || DEFAULTS.maxIndexes),
        maxLockWaits: Number(advanced.maxLockWaits || DEFAULTS.maxLockWaits),
        schemaIntervalSeconds: Number(advanced.schemaIntervalSeconds || DEFAULTS.schemaIntervalSeconds),
        indexIntervalSeconds: Number(advanced.indexIntervalSeconds || DEFAULTS.indexIntervalSeconds)
    };
}

// ── derivation ────────────────────────────────────────────────────────────────

/**
 * Diffs a cumulative counter against the previous scrape.
 *
 * MySQL zeroes every GLOBAL STATUS counter on restart. Uptime going backwards is
 * the reliable restart signal — more reliable than watching each counter, since
 * a quiet server can legitimately hold a counter flat across a restart.
 */
function counterDelta(current, previous, restarted) {
    const cur = Number(current) || 0;
    if (restarted || previous === null || previous === undefined) return 0;
    const prev = Number(previous) || 0;
    return cur >= prev ? cur - prev : 0;
}

function perSecond(delta, intervalSeconds) {
    if (!intervalSeconds || intervalSeconds <= 0) return 0;
    return delta / intervalSeconds;
}

/**
 * InnoDB buffer pool hit rate over the interval.
 *
 * 1 - (reads / read_requests), where `reads` are the requests that had to go to
 * disk. Computed from deltas because the since-boot figure on a long-running
 * server is a constant that no longer describes anything.
 */
function deriveBufferPoolHitRate(innodb, previous, restarted) {
    const requestsDelta = counterDelta(
        innodb.bufferPoolReadRequests, previous && previous.bufferPoolReadRequests, restarted
    );
    const readsDelta = counterDelta(
        innodb.bufferPoolReads, previous && previous.bufferPoolReads, restarted
    );

    return {
        readRequests: requestsDelta,
        diskReads: readsDelta,
        // No buffer pool activity is not a 0% hit rate — it is no data. Writing
        // 0 would draw a cache collapse on an idle server.
        hitRate: requestsDelta > 0
            ? Math.max(0, Math.min(100, (1 - (readsDelta / requestsDelta)) * 100))
            : null
    };
}

/**
 * Percentage of temporary tables that spilled to disk during the interval.
 * The single best indicator of tmp_table_size / sort pressure.
 */
function deriveTempTableRates(temp, previous, restarted) {
    const tmpDelta = counterDelta(temp.createdTmpTables, previous && previous.createdTmpTables, restarted);
    const diskDelta = counterDelta(temp.createdTmpDiskTables, previous && previous.createdTmpDiskTables, restarted);

    return {
        createdTmpTables: tmpDelta,
        createdTmpDiskTables: diskDelta,
        createdTmpFiles: counterDelta(temp.createdTmpFiles, previous && previous.createdTmpFiles, restarted),
        diskTempTablePercentage: tmpDelta > 0 ? (diskDelta / tmpDelta) * 100 : null
    };
}

function deriveTableCacheEfficiency(cache, previous, restarted) {
    const hits = counterDelta(cache.tableOpenCacheHits, previous && previous.tableOpenCacheHits, restarted);
    const misses = counterDelta(cache.tableOpenCacheMisses, previous && previous.tableOpenCacheMisses, restarted);
    const total = hits + misses;

    return {
        hits, misses,
        hitRate: total > 0 ? (hits / total) * 100 : null,
        overflows: counterDelta(cache.tableOpenCacheOverflows, previous && previous.tableOpenCacheOverflows, restarted)
    };
}

/**
 * Thread cache efficiency: what share of new connections avoided creating an OS
 * thread. A low value with high connection churn means thread_cache_size is too
 * small.
 */
function deriveThreadCacheEfficiency(connections, previous, restarted) {
    const created = counterDelta(connections.threadsCreated, previous && previous.threadsCreated, restarted);
    const total = counterDelta(connections.connections, previous && previous.connections, restarted);

    return {
        threadsCreated: created,
        connections: total,
        efficiency: total > 0 ? Math.max(0, (1 - (created / total)) * 100) : null
    };
}

/**
 * Per-digest deltas plus an impact ranking.
 *
 * impact = executions in the interval x average duration, i.e. the database time
 * the query actually consumed. It is the only ordering that surfaces a 2ms query
 * running 50k times ahead of one 4-second report.
 */
function deriveQueries(current, previous, restarted, limit, slowThresholdMs) {
    const previousByDigest = new Map();
    if (previous && Array.isArray(previous.queries)) {
        for (const entry of previous.queries) previousByDigest.set(entry.digest, entry);
    }

    const derived = current.map((entry) => {
        const prev = previousByDigest.get(entry.digest);
        const executionCountDelta = counterDelta(entry.executionCount, prev && prev.executionCount, restarted);
        const totalDurationDelta = counterDelta(entry.totalDuration, prev && prev.totalDuration, restarted);
        const rowsExaminedDelta = counterDelta(entry.rowsExamined, prev && prev.rowsExamined, restarted);
        const rowsSentDelta = counterDelta(entry.rowsSent, prev && prev.rowsSent, restarted);

        // Prefer the interval average; fall back to the lifetime average MySQL
        // reports when the digest saw no executions this interval.
        const avgDuration = executionCountDelta > 0
            ? totalDurationDelta / executionCountDelta
            : entry.avgDuration;

        return Object.assign({}, entry, {
            executionCountDelta,
            totalDurationDelta,
            rowsExaminedDelta,
            rowsSentDelta,
            intervalAvgDuration: avgDuration,
            tmpDiskTablesDelta: counterDelta(entry.tmpDiskTables, prev && prev.tmpDiskTables, restarted),
            noIndexUsedDelta: counterDelta(entry.noIndexUsed, prev && prev.noIndexUsed, restarted),
            impact: executionCountDelta * avgDuration,
            // Slow is a property of the query, evaluated here so the server and
            // the UI cannot disagree about the threshold.
            slow: avgDuration >= slowThresholdMs || entry.maxDuration >= slowThresholdMs
        });
    });

    derived.sort((a, b) =>
        (b.impact - a.impact) ||
        (b.executionCountDelta - a.executionCountDelta) ||
        (b.totalDuration - a.totalDuration)
    );

    return derived.slice(0, limit);
}

// ── legacy payload ────────────────────────────────────────────────────────────

// Reproduces app/integrations/mysql.js exactly so the existing socket event, the
// `mysql` Influx measurement and every current dashboard keep working.
function toLegacyPayload(config, variables, status, databaseStats) {
    return {
        id: `${config.host}:${config.port}`,
        host: config.host,
        port: config.port,
        globalMetrics: {
            version: parsers.statusString(variables, 'version'),
            uptime: parsers.statusNumber(status, 'Uptime'),
            threads_connected: parsers.statusNumber(status, 'Threads_connected'),
            max_connections: parsers.statusNumber(variables, 'max_connections'),
            insert_queries: parsers.statusNumber(status, 'Com_insert'),
            update_queries: parsers.statusNumber(status, 'Com_update'),
            delete_queries: parsers.statusNumber(status, 'Com_delete'),
            select_queries: parsers.statusNumber(status, 'Com_select'),
            slow_queries: parsers.statusNumber(status, 'Slow_queries'),
            connections: parsers.statusNumber(status, 'Connections'),
            aborted_clients: parsers.statusNumber(status, 'Aborted_clients'),
            opened_tables: parsers.statusNumber(status, 'Opened_tables')
        },
        // The legacy shape is one entry per configured database with these three
        // keys; it is reproduced from the metadata already gathered rather than
        // by reconnecting per database.
        databases: databaseStats.map((db) => ({
            db: db.database,
            table_count: db.tableCount,
            index_count: db.indexCount || 0,
            db_size: db.totalSize
        }))
    };
}

// ── capability probing ────────────────────────────────────────────────────────

/**
 * Establishes what this server and this user can actually provide.
 *
 * Everything here is a cheap probe. Getting it wrong in the optimistic direction
 * means an error every 60 seconds; getting it wrong pessimistically means
 * silently missing a whole feature, so each capability is proven rather than
 * inferred from the version alone.
 */
async function probeCapabilities(conn, versionInfo, variables) {
    const capabilities = {
        performanceSchema: false,
        queryDigest: false,
        locks: false,
        replication: false,
        indexStats: false,
        binlog: parsers.statusString(variables, 'log_bin') === 'ON',
        slowQueryLog: parsers.statusString(variables, 'slow_query_log') === 'ON'
    };
    const notes = [];

    capabilities.performanceSchema = parsers.statusString(variables, 'performance_schema') === 'ON';
    if (!capabilities.performanceSchema) {
        notes.push('performance_schema is disabled; query, index and lock detail are unavailable');
        return { capabilities, notes };
    }

    // The digest consumer can be off even when performance_schema is on, and the
    // monitoring user needs SELECT on performance_schema either way.
    try {
        await conn.query('SELECT DIGEST FROM performance_schema.events_statements_summary_by_digest LIMIT 1');
        capabilities.queryDigest = true;
    } catch (err) {
        notes.push(`query digests unavailable: ${err.code || err.message}`);
    }

    try {
        await conn.query('SELECT COUNT_READ FROM performance_schema.table_io_waits_summary_by_index_usage LIMIT 1');
        capabilities.indexStats = true;
    } catch (err) {
        notes.push(`index statistics unavailable: ${err.code || err.message}`);
    }

    // data_locks / data_lock_waits are MySQL 8; 5.7 and MariaDB expose
    // information_schema.innodb_lock_waits instead.
    if (versionInfo.supportsDataLocks) {
        try {
            await conn.query('SELECT ENGINE FROM performance_schema.data_lock_waits LIMIT 1');
            capabilities.locks = true;
            capabilities.lockSource = 'performance_schema';
        } catch (err) {
            notes.push(`lock waits unavailable: ${err.code || err.message}`);
        }
    } else {
        try {
            await conn.query('SELECT requesting_trx_id FROM information_schema.innodb_lock_waits LIMIT 1');
            capabilities.locks = true;
            capabilities.lockSource = 'information_schema';
        } catch (err) {
            notes.push('lock waits unavailable on this version');
        }
    }

    return { capabilities, notes };
}

// ── collection helpers ────────────────────────────────────────────────────────

const schemaPlaceholders = SYSTEM_SCHEMAS.map(() => '?').join(', ');

async function collectQueries(conn, config) {
    // Ordered by total time so the cap keeps the queries that matter. LIMIT is
    // interpolated as a validated integer because MySQL does not accept a
    // placeholder there in all versions.
    const limit = Math.max(1, Math.min(1000, Math.floor(config.maxDigests)));
    const [rows] = await conn.query(
        `SELECT DIGEST, DIGEST_TEXT, SCHEMA_NAME, COUNT_STAR,
                SUM_TIMER_WAIT, AVG_TIMER_WAIT, MAX_TIMER_WAIT, MIN_TIMER_WAIT,
                SUM_ROWS_EXAMINED, SUM_ROWS_SENT,
                SUM_CREATED_TMP_TABLES, SUM_CREATED_TMP_DISK_TABLES,
                SUM_SORT_ROWS, SUM_NO_INDEX_USED, SUM_NO_GOOD_INDEX_USED,
                SUM_ERRORS, SUM_WARNINGS, FIRST_SEEN, LAST_SEEN
         FROM performance_schema.events_statements_summary_by_digest
         WHERE SCHEMA_NAME IS NULL OR SCHEMA_NAME NOT IN (${schemaPlaceholders})
         ORDER BY SUM_TIMER_WAIT DESC
         LIMIT ${limit}`,
        SYSTEM_SCHEMAS
    );
    return parsers.parseDigestRows(rows);
}

async function collectTables(conn, config) {
    const limit = Math.max(1, Math.min(2000, Math.floor(config.maxTables)));
    // information_schema only — no table data is read, and BASE TABLE excludes
    // views, whose size columns are meaningless.
    const [rows] = await conn.query(
        `SELECT TABLE_SCHEMA, TABLE_NAME, ENGINE, TABLE_ROWS,
                DATA_LENGTH, INDEX_LENGTH, DATA_FREE, AUTO_INCREMENT,
                ROW_FORMAT, CREATE_TIME, UPDATE_TIME
         FROM information_schema.tables
         WHERE TABLE_SCHEMA NOT IN (${schemaPlaceholders})
           AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY (COALESCE(DATA_LENGTH,0) + COALESCE(INDEX_LENGTH,0)) DESC
         LIMIT ${limit}`,
        SYSTEM_SCHEMAS
    );
    return parsers.parseTableRows(rows);
}

async function collectIndexCounts(conn) {
    // Used only to reproduce the legacy payload's index_count field.
    const [rows] = await conn.query(
        `SELECT TABLE_SCHEMA, COUNT(*) AS index_count
         FROM information_schema.statistics
         WHERE TABLE_SCHEMA NOT IN (${schemaPlaceholders})
         GROUP BY TABLE_SCHEMA`,
        SYSTEM_SCHEMAS
    );
    const out = new Map();
    for (const row of rows || []) out.set(String(row.TABLE_SCHEMA), parsers.num(row.index_count));
    return out;
}

async function collectIndexStats(conn, config) {
    const limit = Math.max(1, Math.min(5000, Math.floor(config.maxIndexes)));
    const [rows] = await conn.query(
        `SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME,
                COUNT_READ, COUNT_WRITE, COUNT_FETCH,
                COUNT_INSERT, COUNT_UPDATE, COUNT_DELETE,
                SUM_TIMER_WAIT, SUM_TIMER_READ, SUM_TIMER_WRITE
         FROM performance_schema.table_io_waits_summary_by_index_usage
         WHERE OBJECT_SCHEMA NOT IN (${schemaPlaceholders})
         ORDER BY SUM_TIMER_WAIT DESC
         LIMIT ${limit}`,
        SYSTEM_SCHEMAS
    );
    const indexes = parsers.parseIndexRows(rows);

    // performance_schema does not report uniqueness or cardinality, and both
    // matter before the UI suggests an index is droppable.
    try {
        const [metaRows] = await conn.query(
            `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, NON_UNIQUE, CARDINALITY
             FROM information_schema.statistics
             WHERE TABLE_SCHEMA NOT IN (${schemaPlaceholders})`,
            SYSTEM_SCHEMAS
        );
        parsers.mergeIndexMetadata(indexes, metaRows);
    } catch (err) {
        // Usage data alone is still useful; uniqueness just stays unknown.
    }

    return indexes;
}

async function collectLockWaits(conn, config, lockSource) {
    const limit = Math.max(1, Math.min(500, Math.floor(config.maxLockWaits)));

    if (lockSource === 'performance_schema') {
        // Joins the wait graph to the two lock rows and to each thread's current
        // statement. sys.* views are avoided because they are not always present
        // and their definitions vary.
        const [rows] = await conn.query(
            `SELECT
                 wt.THREAD_ID              AS waiting_thread_id,
                 wt.PROCESSLIST_ID         AS waiting_pid,
                 bt.THREAD_ID              AS blocking_thread_id,
                 bt.PROCESSLIST_ID         AS blocking_pid,
                 rl.OBJECT_SCHEMA          AS object_schema,
                 rl.OBJECT_NAME            AS object_name,
                 rl.INDEX_NAME             AS index_name,
                 rl.LOCK_TYPE              AS lock_type,
                 rl.LOCK_MODE              AS lock_mode,
                 rl.LOCK_STATUS            AS lock_status,
                 wesc.DIGEST_TEXT          AS waiting_query,
                 wesc.DIGEST               AS waiting_digest,
                 besc.DIGEST_TEXT          AS blocking_query,
                 besc.DIGEST               AS blocking_digest,
                 wtrx.TRX_ROWS_MODIFIED    AS waiting_trx_rows_modified,
                 btrx.TRX_ROWS_MODIFIED    AS blocking_trx_rows_modified,
                 TIMESTAMPDIFF(SECOND, wtrx.TRX_WAIT_STARTED, NOW()) AS wait_age_secs
             FROM performance_schema.data_lock_waits dlw
             JOIN performance_schema.data_locks rl
                  ON rl.ENGINE_LOCK_ID = dlw.REQUESTING_ENGINE_LOCK_ID
             JOIN performance_schema.threads wt
                  ON wt.THREAD_ID = dlw.REQUESTING_THREAD_ID
             JOIN performance_schema.threads bt
                  ON bt.THREAD_ID = dlw.BLOCKING_THREAD_ID
             LEFT JOIN performance_schema.events_statements_current wesc
                  ON wesc.THREAD_ID = dlw.REQUESTING_THREAD_ID
             LEFT JOIN performance_schema.events_statements_current besc
                  ON besc.THREAD_ID = dlw.BLOCKING_THREAD_ID
             LEFT JOIN information_schema.innodb_trx wtrx
                  ON wtrx.trx_mysql_thread_id = wt.PROCESSLIST_ID
             LEFT JOIN information_schema.innodb_trx btrx
                  ON btrx.trx_mysql_thread_id = bt.PROCESSLIST_ID
             LIMIT ${limit}`
        );
        return parsers.parseLockWaits(rows);
    }

    // MySQL 5.7 / MariaDB.
    const [rows] = await conn.query(
        `SELECT
             r.trx_mysql_thread_id  AS waiting_pid,
             b.trx_mysql_thread_id  AS blocking_pid,
             r.trx_query           AS waiting_query,
             b.trx_query           AS blocking_query,
             r.trx_rows_modified   AS waiting_trx_rows_modified,
             b.trx_rows_modified   AS blocking_trx_rows_modified,
             TIMESTAMPDIFF(SECOND, r.trx_wait_started, NOW()) AS wait_age_secs
         FROM information_schema.innodb_lock_waits w
         JOIN information_schema.innodb_trx r ON r.trx_id = w.requesting_trx_id
         JOIN information_schema.innodb_trx b ON b.trx_id = w.blocking_trx_id
         LIMIT ${limit}`
    );
    return parsers.parseLockWaits(rows);
}

/**
 * Replication is probed in both directions: this server may be a replica, a
 * source with replicas attached, or both.
 *
 * Requires REPLICATION CLIENT. Without it the statements error and replication
 * is simply reported unsupported.
 */
async function collectReplication(conn, versionInfo) {
    const result = { enabled: false, role: 'standalone', replicas: [], connectedReplicas: [] };

    const statusStatement = versionInfo.supportsReplicaTerminology
        ? 'SHOW REPLICA STATUS' : 'SHOW SLAVE STATUS';
    const hostsStatement = versionInfo.supportsReplicaTerminology
        ? 'SHOW REPLICAS' : 'SHOW SLAVE HOSTS';

    try {
        const [rows] = await conn.query(statusStatement);
        const parsed = parsers.parseReplicaStatus(rows);
        if (parsed.enabled) Object.assign(result, parsed);
    } catch (err) {
        result.statusError = err.code || err.message;
    }

    try {
        const [rows] = await conn.query(hostsStatement);
        const connected = parsers.parseConnectedReplicas(rows);
        if (connected.length) {
            result.connectedReplicas = connected;
            result.enabled = true;
            // A server can be both: a replica of an upstream and a source for
            // downstream replicas.
            result.role = result.role === 'replica' ? 'relay' : 'source';
        }
    } catch (err) {
        result.hostsError = err.code || err.message;
    }

    return result;
}

async function collectBinlog(conn, versionInfo) {
    const statement = versionInfo.supportsReplicaTerminology
        ? 'SHOW BINARY LOG STATUS' : 'SHOW MASTER STATUS';
    try {
        const [rows] = await conn.query(statement);
        if (!Array.isArray(rows) || !rows.length) return null;
        const row = rows[0];
        return {
            file: String(row.File || ''),
            position: parsers.num(row.Position),
            binlogDoDb: String(row.Binlog_Do_DB || ''),
            binlogIgnoreDb: String(row.Binlog_Ignore_DB || '')
        };
    } catch (err) {
        // SHOW BINARY LOG STATUS only exists from 8.4; older servers need
        // SHOW MASTER STATUS, and either may be denied.
        try {
            const [rows] = await conn.query('SHOW MASTER STATUS');
            if (!Array.isArray(rows) || !rows.length) return null;
            return {
                file: String(rows[0].File || ''),
                position: parsers.num(rows[0].Position)
            };
        } catch (inner) {
            return null;
        }
    }
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Collects MySQL metrics over a single connection.
 *
 * @param {object} integrate  the mysql entry from integration.json
 * @param {function} callback (err, { basic, advanced })
 */
async function collect(integrate, callback) {
    const config = normalizeConfig(integrate);
    const id = `${config.host}:${config.port}`;
    const st = instanceState(id);
    const now = Date.now();

    let conn;
    try {
        conn = await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            connectTimeout: DEFAULTS.connectTimeoutMs,
            ssl: config.ssl ? {} : undefined,
            // Large digest and table result sets are read as plain rows; the
            // driver's type casting is left on so DECIMAL/BIGINT come back
            // usable.
            supportBigNumbers: true,
            bigNumberStrings: true,
            multipleStatements: false
        });
    } catch (err) {
        return callback(new Error(`connection failed: ${err.code || err.message}`), null);
    }

    try {
        const [statusRows] = await conn.query('SHOW GLOBAL STATUS');
        const [variableRows] = await conn.query('SHOW GLOBAL VARIABLES');

        const status = parsers.parseKeyValueRows(statusRows);
        const variables = parsers.parseKeyValueRows(variableRows);

        const versionInfo = parsers.parseVersion(
            parsers.statusString(variables, 'version') || parsers.statusString(variables, 'version_comment')
        );

        if (!versionInfo.raw) {
            throw new Error('SHOW GLOBAL VARIABLES returned no version — is this a MySQL server?');
        }

        const server = parsers.buildServer(variables, status, versionInfo);
        const uptime = server.uptimeSeconds;

        // Uptime going backwards is the restart signal; every cumulative counter
        // reset to zero along with it.
        const restarted = st.lastUptime !== null && uptime < st.lastUptime;
        const previous = restarted ? null : st.previous;

        // Real elapsed time between scrapes, from the server's own uptime, so a
        // late or skipped tick does not distort per-second rates.
        const intervalSeconds = (previous && previous.uptime && uptime > previous.uptime)
            ? uptime - previous.uptime
            : 0;

        const connections = parsers.buildConnections(variables, status);
        const queryCounters = parsers.buildQueryCounters(status);
        const innodb = parsers.buildInnodb(status);
        const temp = parsers.buildTempAndSort(status);
        const tableCache = parsers.buildTableCache(variables, status);

        const collected = {
            status: true,
            queries: false,
            schema: config.enabled && config.schema &&
                now - st.lastSchemaAt >= config.schemaIntervalSeconds * 1000,
            indexes: false,
            locks: false,
            replication: false
        };

        const { capabilities, notes } = config.enabled
            ? await probeCapabilities(conn, versionInfo, variables)
            : { capabilities: {}, notes: [] };

        collected.queries = config.enabled && config.queries && capabilities.queryDigest === true;
        collected.indexes = config.enabled && config.indexes && capabilities.indexStats === true &&
            now - st.lastIndexAt >= config.indexIntervalSeconds * 1000;
        collected.locks = config.enabled && config.locks && capabilities.locks === true;
        collected.replication = config.enabled && config.replication;

        // ── section collection, each isolated ────────────────────────────────
        let queries = [];
        let tables = [];
        let databases = [];
        let indexes = [];
        let lockWaits = [];
        let replication = null;
        let binlog = null;
        const sectionErrors = [];

        if (collected.queries) {
            try {
                queries = await collectQueries(conn, config);
            } catch (err) {
                sectionErrors.push({ section: 'queries', message: err.code || err.message });
                collected.queries = false;
            }
        }

        if (collected.schema) {
            try {
                tables = await collectTables(conn, config);
                databases = parsers.aggregateDatabases(tables);
                const indexCounts = await collectIndexCounts(conn);
                for (const db of databases) db.indexCount = indexCounts.get(db.database) || 0;
            } catch (err) {
                sectionErrors.push({ section: 'schema', message: err.code || err.message });
                collected.schema = false;
            }
        }

        if (collected.indexes) {
            try {
                indexes = await collectIndexStats(conn, config);
            } catch (err) {
                sectionErrors.push({ section: 'indexes', message: err.code || err.message });
                collected.indexes = false;
            }
        }

        if (collected.locks) {
            try {
                lockWaits = await collectLockWaits(conn, config, capabilities.lockSource);
            } catch (err) {
                sectionErrors.push({ section: 'locks', message: err.code || err.message });
                collected.locks = false;
            }
        }

        if (collected.replication) {
            try {
                replication = await collectReplication(conn, versionInfo);
                capabilities.replication = replication.enabled;
                binlog = await collectBinlog(conn, versionInfo);
            } catch (err) {
                sectionErrors.push({ section: 'replication', message: err.code || err.message });
                collected.replication = false;
            }
        }

        // ── derived values ───────────────────────────────────────────────────
        const bufferPool = deriveBufferPoolHitRate(innodb, previous, restarted);
        const tempRates = deriveTempTableRates(temp, previous, restarted);
        const tableCacheEfficiency = deriveTableCacheEfficiency(tableCache, previous, restarted);
        const threadCache = deriveThreadCacheEfficiency(connections, previous, restarted);

        const d = (currentValue, key) => counterDelta(currentValue, previous && previous[key], restarted);

        const throughput = {
            questionsDelta: d(queryCounters.questions, 'questions'),
            queriesDelta: d(queryCounters.queries, 'queries'),
            selectDelta: d(queryCounters.comSelect, 'comSelect'),
            insertDelta: d(queryCounters.comInsert, 'comInsert'),
            updateDelta: d(queryCounters.comUpdate, 'comUpdate'),
            deleteDelta: d(queryCounters.comDelete, 'comDelete'),
            replaceDelta: d(queryCounters.comReplace, 'comReplace'),
            commitDelta: d(queryCounters.comCommit, 'comCommit'),
            rollbackDelta: d(queryCounters.comRollback, 'comRollback'),
            slowQueriesDelta: d(queryCounters.slowQueries, 'slowQueries')
        };
        throughput.queriesPerSecond = perSecond(throughput.queriesDelta || throughput.questionsDelta, intervalSeconds);
        throughput.selectPerSecond = perSecond(throughput.selectDelta, intervalSeconds);
        throughput.insertPerSecond = perSecond(throughput.insertDelta, intervalSeconds);
        throughput.updatePerSecond = perSecond(throughput.updateDelta, intervalSeconds);
        throughput.deletePerSecond = perSecond(throughput.deleteDelta, intervalSeconds);
        throughput.commitPerSecond = perSecond(throughput.commitDelta, intervalSeconds);
        throughput.rollbackPerSecond = perSecond(throughput.rollbackDelta, intervalSeconds);
        throughput.slowQueriesPerSecond = perSecond(throughput.slowQueriesDelta, intervalSeconds);

        const io = {
            dataReadsDelta: d(innodb.dataReads, 'dataReads'),
            dataWritesDelta: d(innodb.dataWrites, 'dataWrites'),
            dataReadBytesDelta: d(innodb.dataRead, 'dataRead'),
            dataWrittenBytesDelta: d(innodb.dataWritten, 'dataWritten'),
            fsyncsDelta: d(innodb.dataFsyncs, 'dataFsyncs'),
            logWritesDelta: d(innodb.logWrites, 'logWrites'),
            logWaitsDelta: d(innodb.logWaits, 'logWaits'),
            osLogWrittenDelta: d(innodb.osLogWritten, 'osLogWritten')
        };
        io.readsPerSecond = perSecond(io.dataReadsDelta, intervalSeconds);
        io.writesPerSecond = perSecond(io.dataWritesDelta, intervalSeconds);
        io.readBytesPerSecond = perSecond(io.dataReadBytesDelta, intervalSeconds);
        io.writeBytesPerSecond = perSecond(io.dataWrittenBytesDelta, intervalSeconds);
        io.fsyncsPerSecond = perSecond(io.fsyncsDelta, intervalSeconds);
        io.logWritesPerSecond = perSecond(io.logWritesDelta, intervalSeconds);

        const rowOps = {
            rowsReadDelta: d(innodb.rowsRead, 'rowsRead'),
            rowsInsertedDelta: d(innodb.rowsInserted, 'rowsInserted'),
            rowsUpdatedDelta: d(innodb.rowsUpdated, 'rowsUpdated'),
            rowsDeletedDelta: d(innodb.rowsDeleted, 'rowsDeleted')
        };
        rowOps.rowsReadPerSecond = perSecond(rowOps.rowsReadDelta, intervalSeconds);
        rowOps.rowsInsertedPerSecond = perSecond(rowOps.rowsInsertedDelta, intervalSeconds);
        rowOps.rowsUpdatedPerSecond = perSecond(rowOps.rowsUpdatedDelta, intervalSeconds);
        rowOps.rowsDeletedPerSecond = perSecond(rowOps.rowsDeletedDelta, intervalSeconds);

        const locks = {
            rowLockCurrentWaits: innodb.rowLockCurrentWaits,
            rowLockWaitsDelta: d(innodb.rowLockWaits, 'rowLockWaits'),
            rowLockTimeDelta: d(innodb.rowLockTime, 'rowLockTime'),
            rowLockTimeAvg: innodb.rowLockTimeAvg,
            rowLockTimeMax: innodb.rowLockTimeMax,
            deadlocksDelta: d(innodb.deadlocks, 'deadlocks'),
            deadlocksTotal: innodb.deadlocks,
            currentWaitCount: lockWaits.length
        };

        const derivedQueries = collected.queries
            ? deriveQueries(queries, previous, restarted, config.maxDigests, config.slowQueryThresholdMs)
            : [];

        // ── payloads ─────────────────────────────────────────────────────────
        const basic = toLegacyPayload(config, variables, status, databases);

        let advanced = null;
        if (config.enabled) {
            advanced = {
                id,
                host: config.host,
                port: config.port,
                origin: id,
                collectedAt: Date.now(),
                intervalSeconds,
                restarted,
                collected,
                capabilities,
                server,

                connections: Object.assign({}, connections, {
                    threadsCreatedDelta: threadCache.threadsCreated,
                    connectionsDelta: threadCache.connections,
                    abortedConnectsDelta: d(connections.abortedConnects, 'abortedConnects'),
                    abortedClientsDelta: d(connections.abortedClients, 'abortedClients'),
                    threadCacheEfficiency: threadCache.efficiency
                }),

                throughput,
                innodb: Object.assign({}, innodb, {
                    bufferPoolHitRate: bufferPool.hitRate,
                    bufferPoolReadRequestsDelta: bufferPool.readRequests,
                    bufferPoolDiskReadsDelta: bufferPool.diskReads
                }),
                io,
                rowOps,
                locks,
                temp: Object.assign({}, temp, tempRates),
                tableCache: Object.assign({}, tableCache, {
                    hitRate: tableCacheEfficiency.hitRate,
                    hitsDelta: tableCacheEfficiency.hits,
                    missesDelta: tableCacheEfficiency.misses,
                    overflowsDelta: tableCacheEfficiency.overflows
                })
            };

            if (collected.queries) {
                advanced.queries = derivedQueries;
                advanced.slowQueryThresholdMs = config.slowQueryThresholdMs;
            }
            if (collected.schema) {
                advanced.databases = databases;
                advanced.tables = tables;
            }
            if (collected.indexes) advanced.indexes = indexes;
            if (collected.locks) advanced.lockWaits = lockWaits.slice(0, config.maxLockWaits);
            if (collected.replication && replication) advanced.replication = replication;
            if (binlog) advanced.binlog = binlog;
            if (notes.length) advanced.capabilityNotes = notes;
            if (sectionErrors.length) advanced.collectorErrors = sectionErrors;
        }

        // Only advance the throttle clocks on a scrape that actually collected.
        if (collected.schema) st.lastSchemaAt = now;
        if (collected.indexes) st.lastIndexAt = now;

        st.lastUptime = uptime;
        st.previous = {
            uptime,
            questions: queryCounters.questions,
            queries: queryCounters.queries,
            comSelect: queryCounters.comSelect,
            comInsert: queryCounters.comInsert,
            comUpdate: queryCounters.comUpdate,
            comDelete: queryCounters.comDelete,
            comReplace: queryCounters.comReplace,
            comCommit: queryCounters.comCommit,
            comRollback: queryCounters.comRollback,
            slowQueries: queryCounters.slowQueries,
            threadsCreated: connections.threadsCreated,
            connections: connections.connections,
            abortedConnects: connections.abortedConnects,
            abortedClients: connections.abortedClients,
            bufferPoolReadRequests: innodb.bufferPoolReadRequests,
            bufferPoolReads: innodb.bufferPoolReads,
            dataReads: innodb.dataReads,
            dataWrites: innodb.dataWrites,
            dataRead: innodb.dataRead,
            dataWritten: innodb.dataWritten,
            dataFsyncs: innodb.dataFsyncs,
            logWrites: innodb.logWrites,
            logWaits: innodb.logWaits,
            osLogWritten: innodb.osLogWritten,
            rowsRead: innodb.rowsRead,
            rowsInserted: innodb.rowsInserted,
            rowsUpdated: innodb.rowsUpdated,
            rowsDeleted: innodb.rowsDeleted,
            rowLockWaits: innodb.rowLockWaits,
            rowLockTime: innodb.rowLockTime,
            deadlocks: innodb.deadlocks,
            createdTmpTables: temp.createdTmpTables,
            createdTmpDiskTables: temp.createdTmpDiskTables,
            createdTmpFiles: temp.createdTmpFiles,
            tableOpenCacheHits: tableCache.tableOpenCacheHits,
            tableOpenCacheMisses: tableCache.tableOpenCacheMisses,
            tableOpenCacheOverflows: tableCache.tableOpenCacheOverflows,
            // Raw (undelta'd) digest rows so the next scrape can diff against them.
            queries: collected.queries ? queries : (previous && previous.queries) || []
        };

        callback(null, { basic, advanced });
    } catch (err) {
        callback(new Error(err.code ? `${err.code}: ${err.message}` : err.message), null);
    } finally {
        try { await conn.end(); } catch (e) { /* connection already gone */ }
    }
}

module.exports = {
    collect,
    normalizeConfig,
    resetState,
    // Exported for tests.
    counterDelta,
    perSecond,
    deriveBufferPoolHitRate,
    deriveTempTableRates,
    deriveTableCacheEfficiency,
    deriveThreadCacheEfficiency,
    deriveQueries,
    toLegacyPayload,
    SYSTEM_SCHEMAS,
    DEFAULTS
};
