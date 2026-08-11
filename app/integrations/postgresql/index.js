// PostgreSQL advanced collector.
//
// Mirrors the MongoDB, Redis and MySQL advanced collectors:
// `app/integrations/postgresql.js` keeps working and keeps emitting the exact
// payload it always has, while this module derives BOTH the legacy payload and
// the advanced observability payload from its own connections.
//
// Design notes
//   * One primary connection carries every cluster-wide view (pg_stat_database,
//     pg_stat_activity, pg_stat_statements, pg_locks, replication, WAL,
//     checkpoints). Per-database views — pg_stat_user_tables,
//     pg_stat_user_indexes, pg_statio_* — only ever describe the database you
//     are connected to, so those need one extra connection per database and are
//     throttled well below the 60s tick.
//   * Every statement is read-only. No CREATE EXTENSION, no ALTER SYSTEM, no
//     VACUUM/ANALYZE/REINDEX, no pg_stat_statements_reset(), and no
//     pg_cancel_backend()/pg_terminate_backend(). Watchlog recommends; it never
//     acts on the customer's database.
//   * Capabilities are probed, not assumed. pg_stat_statements may not be
//     installed, pg_stat_wal does not exist before 14, pg_stat_checkpointer
//     does not exist before 17, and the monitoring role may lack
//     pg_read_all_stats. Each gap degrades one section and is reported so the
//     UI can hide it rather than showing a fabricated zero.

'use strict';

const { Client } = require('pg');
const parsers = require('./parsers');
const q = require('./queries');

const DEFAULTS = {
    maxStatements: 200,
    maxTables: 300,
    maxIndexes: 500,
    maxActivity: 100,
    maxBlocking: 50,
    slowQueryThresholdMs: 100,
    longQuerySeconds: 30,
    longTransactionSeconds: 60,
    idleTransactionSeconds: 300,
    storageIntervalSeconds: 300,
    connectTimeoutMs: 10000,
    statementTimeoutMs: 15000
};

// Per-instance memory: previous counters (for deltas) and throttle clocks.
const state = new Map();

function instanceState(id) {
    if (!state.has(id)) {
        state.set(id, { lastStorageAt: 0, lastUptime: null, previous: null });
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
    const activity = integrate.activity || {};

    const databases = Array.isArray(integrate.database)
        ? integrate.database.filter(Boolean)
        : (integrate.database ? [integrate.database] : []);

    return {
        host: integrate.host || 'localhost',
        port: Number(integrate.port || 5432),
        username: integrate.username || 'postgres',
        password: integrate.password || '',
        databases,
        // The advanced collector needs a connection target even when no
        // database list is configured; `postgres` always exists.
        primaryDatabase: databases[0] || integrate.primaryDatabase || 'postgres',
        ssl: integrate.ssl === true,

        enabled: advanced.enabled !== false,
        queries: advanced.queries !== false,
        activityEnabled: advanced.activity !== false,
        locks: advanced.locks !== false,
        storage: advanced.storage !== false,
        indexes: advanced.indexes !== false,
        vacuum: advanced.vacuum !== false,
        wal: advanced.wal !== false,
        replication: advanced.replication !== false,

        slowQueryThresholdMs: Number(
            slowQuery.thresholdMs !== undefined ? slowQuery.thresholdMs : DEFAULTS.slowQueryThresholdMs
        ),
        longQuerySeconds: Number(activity.longQuerySeconds || DEFAULTS.longQuerySeconds),
        longTransactionSeconds: Number(activity.longTransactionSeconds || DEFAULTS.longTransactionSeconds),
        idleTransactionSeconds: Number(activity.idleTransactionSeconds || DEFAULTS.idleTransactionSeconds),

        maxStatements: Number(advanced.maxStatements || DEFAULTS.maxStatements),
        maxTables: Number(advanced.maxTables || DEFAULTS.maxTables),
        maxIndexes: Number(advanced.maxIndexes || DEFAULTS.maxIndexes),
        maxActivity: Number(advanced.maxActivity || DEFAULTS.maxActivity),
        maxBlocking: Number(advanced.maxBlocking || DEFAULTS.maxBlocking),
        storageIntervalSeconds: Number(advanced.storageIntervalSeconds || DEFAULTS.storageIntervalSeconds)
    };
}

// ── connection helpers ────────────────────────────────────────────────────────

async function connect(config, database) {
    const client = new Client({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database,
        connectionTimeoutMillis: DEFAULTS.connectTimeoutMs,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        // A monitoring query must never be the thing that holds a lock or runs
        // away on a busy server.
        statement_timeout: DEFAULTS.statementTimeoutMs,
        application_name: 'watchlog-agent'
    });
    await client.connect();
    return client;
}

/**
 * Runs a query and returns rows, or null when the view/permission is missing.
 *
 * Section-level failures are expected on PostgreSQL — a monitoring role without
 * pg_read_all_stats, a server without pg_stat_statements — so they are captured
 * as capability gaps rather than propagated as errors.
 */
async function tryQuery(client, sql, params, errors, scope) {
    if (!sql) return null;
    try {
        const result = await client.query(sql, params);
        return result.rows;
    } catch (err) {
        if (errors) {
            errors.push({
                scope,
                // Query text is deliberately not logged: pg errors can echo the
                // failing statement, and statements can carry literals.
                code: err.code || 'ERROR',
                message: String(err.message || '').slice(0, 200)
            });
        }
        return null;
    }
}

// ── derivation ────────────────────────────────────────────────────────────────

/**
 * Diffs a cumulative counter against the previous scrape.
 *
 * PostgreSQL counters reset in two ways the collector must survive: a server
 * restart (uptime goes backwards) and an explicit pg_stat_reset() or
 * pg_stat_statements_reset(), which the agent never issues but an operator can.
 * Both show up as a counter moving backwards.
 */
function counterDelta(current, previous, reset) {
    const cur = Number(current) || 0;
    if (reset || previous === null || previous === undefined) return 0;
    const prev = Number(previous) || 0;
    return cur >= prev ? cur - prev : 0;
}

function perSecond(delta, intervalSeconds) {
    if (!intervalSeconds || intervalSeconds <= 0) return 0;
    return delta / intervalSeconds;
}

/**
 * Cache hit ratio over the interval rather than since the last stats reset.
 *
 * A database up for months reports a lifetime ratio that cannot move; the
 * interval ratio is what reveals a working set falling out of shared_buffers.
 */
function deriveCacheHitRatio(blksHit, blksRead, previous, reset) {
    const hitDelta = counterDelta(blksHit, previous && previous.blksHit, reset);
    const readDelta = counterDelta(blksRead, previous && previous.blksRead, reset);
    const total = hitDelta + readDelta;

    return {
        blocksHit: hitDelta,
        blocksRead: readDelta,
        // No block access at all is not a 0% (or 100%) hit ratio — it is no
        // data, and writing a number here would draw a cliff that never
        // happened on an idle database.
        ratio: total > 0 ? (hitDelta / total) * 100 : null
    };
}

/** Per-database interval rates. */
function deriveDatabaseRates(current, previousByName, reset, intervalSeconds) {
    return current.map((db) => {
        const prev = previousByName.get(db.database);
        const d = (field) => counterDelta(db[field], prev && prev[field], reset);

        const commitDelta = d('xactCommit');
        const rollbackDelta = d('xactRollback');
        const transactionDelta = commitDelta + rollbackDelta;
        const cache = deriveCacheHitRatio(db.blksHit, db.blksRead, prev, reset);

        return Object.assign({}, db, {
            commitDelta,
            rollbackDelta,
            transactionDelta,
            transactionsPerSecond: perSecond(transactionDelta, intervalSeconds),
            commitsPerSecond: perSecond(commitDelta, intervalSeconds),
            rollbacksPerSecond: perSecond(rollbackDelta, intervalSeconds),
            // Share of transactions that rolled back. Null with no transactions.
            rollbackRatio: transactionDelta > 0 ? (rollbackDelta / transactionDelta) * 100 : null,

            blksReadDelta: cache.blocksRead,
            blksHitDelta: cache.blocksHit,
            intervalCacheHitRatio: cache.ratio,

            tupReturnedDelta: d('tupReturned'),
            tupFetchedDelta: d('tupFetched'),
            tupInsertedDelta: d('tupInserted'),
            tupUpdatedDelta: d('tupUpdated'),
            tupDeletedDelta: d('tupDeleted'),
            rowsReturnedPerSecond: perSecond(d('tupReturned'), intervalSeconds),
            rowsInsertedPerSecond: perSecond(d('tupInserted'), intervalSeconds),
            rowsUpdatedPerSecond: perSecond(d('tupUpdated'), intervalSeconds),
            rowsDeletedPerSecond: perSecond(d('tupDeleted'), intervalSeconds),

            tempFilesDelta: d('tempFiles'),
            tempBytesDelta: d('tempBytes'),
            tempBytesPerSecond: perSecond(d('tempBytes'), intervalSeconds),
            deadlocksDelta: d('deadlocks'),
            conflictsDelta: d('conflicts'),
            blkReadTimeDelta: d('blkReadTime'),
            blkWriteTimeDelta: d('blkWriteTime')
        });
    });
}

/**
 * Per-statement deltas plus an impact ranking.
 *
 * impact = calls in the interval x interval mean execution time, i.e. the
 * database time the statement actually consumed. It is the only ordering that
 * surfaces a 2ms query running 50k times ahead of one 4-second report.
 */
function deriveStatements(current, previous, reset, limit, slowThresholdMs) {
    const previousByKey = new Map();
    if (previous && Array.isArray(previous.statements)) {
        for (const entry of previous.statements) {
            previousByKey.set(`${entry.database}:${entry.queryId}`, entry);
        }
    }

    const derived = current.map((entry) => {
        const prev = previousByKey.get(`${entry.database}:${entry.queryId}`);
        // pg_stat_statements_reset() makes a specific entry's counters drop
        // without the server restarting, so the reset check is per-entry too.
        const entryReset = reset || (prev && entry.calls < prev.calls);

        const d = (field) => counterDelta(entry[field], prev && prev[field], entryReset);

        const callsDelta = d('calls');
        const totalExecDelta = d('totalExecTime');
        // Prefer the interval mean; fall back to the lifetime mean PostgreSQL
        // reports when the statement saw no calls this interval.
        const intervalMean = callsDelta > 0 ? totalExecDelta / callsDelta : entry.meanExecTime;

        return Object.assign({}, entry, {
            callsDelta,
            totalExecTimeDelta: totalExecDelta,
            intervalMeanExecTime: intervalMean,
            rowsDelta: d('rows'),
            sharedBlksReadDelta: d('sharedBlksRead'),
            sharedBlksHitDelta: d('sharedBlksHit'),
            tempBlksReadDelta: d('tempBlksRead'),
            tempBlksWrittenDelta: d('tempBlksWritten'),
            blkReadTimeDelta: d('blkReadTime'),
            blkWriteTimeDelta: d('blkWriteTime'),
            walBytesDelta: d('walBytes'),
            impact: callsDelta * intervalMean,
            // Slow is decided here so the agent, the API and the UI cannot
            // disagree about the threshold.
            slow: intervalMean >= slowThresholdMs || entry.maxExecTime >= slowThresholdMs
        });
    });

    derived.sort((a, b) =>
        (b.impact - a.impact) ||
        (b.callsDelta - a.callsDelta) ||
        (b.totalExecTime - a.totalExecTime)
    );

    return derived.slice(0, limit);
}

/** Classifies current activity against the configured thresholds. */
function summariseActivity(activity, idleInTransaction, config) {
    const longQueries = activity.filter(
        (a) => a.state === 'active' && a.querySeconds >= config.longQuerySeconds
    );
    const longTransactions = activity.filter(
        (a) => a.xactSeconds >= config.longTransactionSeconds
    );
    const waiting = activity.filter((a) => a.waiting);
    const staleIdle = idleInTransaction.filter(
        (s) => s.stateSeconds >= config.idleTransactionSeconds
    );

    return {
        activeQueries: activity.filter((a) => a.state === 'active').length,
        waitingQueries: waiting.length,
        longRunningQueries: longQueries.length,
        longRunningTransactions: longTransactions.length,
        idleInTransactionCount: idleInTransaction.length,
        staleIdleInTransactionCount: staleIdle.length,
        longestQuerySeconds: activity.reduce((m, a) => Math.max(m, a.querySeconds), 0),
        longestTransactionSeconds: activity.reduce((m, a) => Math.max(m, a.xactSeconds), 0),
        longestIdleInTransactionSeconds: idleInTransaction.reduce((m, s) => Math.max(m, s.stateSeconds), 0),
        thresholds: {
            longQuerySeconds: config.longQuerySeconds,
            longTransactionSeconds: config.longTransactionSeconds,
            idleTransactionSeconds: config.idleTransactionSeconds
        }
    };
}

// ── legacy payload ────────────────────────────────────────────────────────────

/**
 * Reproduces app/integrations/postgresql.js so the existing socket event, the
 * `postgresql` Influx measurement and every current dashboard keep working.
 *
 * The legacy shape is per-configured-database with a fixed key set, and it is
 * rebuilt from data the advanced collector already gathered rather than by
 * reconnecting and re-querying.
 */
function toLegacyPayload(config, serverInfo, databaseStats, connections, lockSummary, statements) {
    const byName = new Map(databaseStats.map((d) => [d.database, d]));

    const databases = config.databases.map((name) => {
        const db = byName.get(name);
        if (!db) return null;
        const totalBlocks = db.blksHit + db.blksRead;

        return {
            db: name,
            active_connections: connections.byDatabaseState
                ? (connections.byDatabaseState[`${name}:active`] || 0) : 0,
            idle_connections: connections.byDatabaseState
                ? (connections.byDatabaseState[`${name}:idle`] || 0) : 0,
            blocked_queries: lockSummary ? lockSummary.waiting : 0,
            xact_commit: db.xactCommit,
            xact_rollback: db.xactRollback,
            cache_hit_ratio: totalBlocks > 0
                ? Math.round((db.blksHit / totalBlocks) * 10000) / 100 : 0,
            deadlocks: db.deadlocks,
            temp_files: db.tempFiles,
            temp_bytes: db.tempBytes,
            blks_read: db.blksRead,
            blks_hit: db.blksHit,
            tup_returned: db.tupReturned,
            tup_fetched: db.tupFetched,
            tup_inserted: db.tupInserted,
            tup_updated: db.tupUpdated,
            tup_deleted: db.tupDeleted,
            // The legacy field has always been numeric and the existing chart
            // reads it directly, so an unknown size stays 0 here. The advanced
            // payload keeps the honest null.
            db_size: db.databaseSize === null ? 0 : db.databaseSize,
            table_count: 0,
            index_count: 0,
            locks: lockSummary ? lockSummary.total : 0,
            waiting_locks: lockSummary ? lockSummary.waiting : 0
        };
    }).filter(Boolean);

    // The legacy payload carries the top statements under `queryStats` with
    // pg_stat_statements' own column names.
    const queryStats = (statements || []).slice(0, 10).map((s) => ({
        query: s.query,
        calls: s.calls,
        total_time_ms: Math.round(s.totalExecTime * 100) / 100,
        avg_time_ms: Math.round(s.meanExecTime * 100) / 100,
        rows: s.rows
    }));

    return {
        id: `${config.host}:${config.port}`,
        host: config.host,
        port: config.port,
        globalMetrics: {
            version: serverInfo ? serverInfo.version : '',
            uptime: serverInfo ? serverInfo.uptimeSeconds : 0,
            max_connections: serverInfo ? serverInfo.maxConnections : 0
        },
        databases,
        queryStats
    };
}

// ── capability probing ────────────────────────────────────────────────────────

/**
 * Establishes what this server and this role can actually provide.
 *
 * pg_stat_statements is the one that matters most: it is an extension, not a
 * core view, and Watchlog must never install it. Everything else is a version
 * or privilege question.
 */
async function probeCapabilities(client, version, config, errors) {
    const capabilities = {
        pgStatStatements: false,
        queryPerformance: false,
        locks: false,
        blockingQueries: false,
        vacuumProgress: false,
        walStats: false,
        checkpointStats: false,
        replication: false,
        ioTiming: false,
        tableStats: false,
        indexStats: false
    };

    // to_regclass returns NULL rather than raising when the relation is absent,
    // so this is a safe existence check even without the extension installed.
    const extensionRows = await tryQuery(
        client,
        `SELECT to_regclass('public.pg_stat_statements') IS NOT NULL
                OR EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS installed`,
        [], errors, 'capability:pg_stat_statements'
    );
    const looksInstalled = extensionRows && extensionRows[0] && extensionRows[0].installed === true;

    if (looksInstalled) {
        // Installed is not the same as readable: the role still needs SELECT,
        // and without pg_read_all_stats it sees `<insufficient privilege>`.
        const probe = await tryQuery(
            client, 'SELECT queryid FROM pg_stat_statements LIMIT 1', [], errors, 'pg_stat_statements'
        );
        capabilities.pgStatStatements = probe !== null;
        capabilities.queryPerformance = probe !== null;
    }

    const lockProbe = await tryQuery(client, 'SELECT 1 FROM pg_locks LIMIT 1', [], errors, 'pg_locks');
    capabilities.locks = lockProbe !== null;
    // pg_blocking_pids() arrived in PostgreSQL 10; before that the pg_locks
    // self-join is used, which is less accurate but still works.
    capabilities.blockingQueries = capabilities.locks;

    capabilities.vacuumProgress = version.atLeast(96);
    capabilities.walStats = version.atLeast(14);
    capabilities.checkpointStats = true;   // pg_stat_bgwriter exists everywhere
    capabilities.ioTiming = false;         // set from server settings below

    if (config.replication) {
        const replProbe = await tryQuery(
            client, 'SELECT 1 FROM pg_stat_replication LIMIT 1', [], errors, 'pg_stat_replication'
        );
        // Readable is what matters; whether any replica is attached is decided
        // by the actual collection.
        capabilities.replication = replProbe !== null;
    }

    const tableProbe = await tryQuery(
        client, 'SELECT 1 FROM pg_stat_user_tables LIMIT 1', [], errors, 'pg_stat_user_tables'
    );
    capabilities.tableStats = tableProbe !== null;
    capabilities.indexStats = tableProbe !== null;

    return capabilities;
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Collects PostgreSQL metrics.
 *
 * @param {object} integrate  the postgresql entry from integration.json
 * @param {function} callback (err, { basic, advanced })
 */
async function collect(integrate, callback) {
    const config = normalizeConfig(integrate);
    const id = `${config.host}:${config.port}`;
    const st = instanceState(id);
    const now = Date.now();

    let client;
    try {
        client = await connect(config, config.primaryDatabase);
    } catch (err) {
        return callback(new Error(`connection failed: ${err.code || err.message}`), null);
    }

    const errors = [];

    try {
        const infoRows = await client.query(q.SERVER_INFO);
        const infoRow = infoRows.rows[0];
        if (!infoRow) throw new Error('server info query returned no rows');

        const version = parsers.parseVersion(infoRow.server_version_num, infoRow.server_version);
        const serverInfo = parsers.parseServerInfo(infoRow, version);
        const uptime = serverInfo.uptimeSeconds;

        // Uptime going backwards is the restart signal; every cumulative
        // counter reset to zero along with it.
        const restarted = st.lastUptime !== null && uptime < st.lastUptime;
        const previous = restarted ? null : st.previous;
        const intervalSeconds = (previous && previous.uptime && uptime > previous.uptime)
            ? uptime - previous.uptime
            : 0;

        const collected = {
            server: true,
            queries: false,
            activity: false,
            locks: false,
            storage: config.enabled && config.storage &&
                now - st.lastStorageAt >= config.storageIntervalSeconds * 1000,
            indexes: false,
            wal: false,
            checkpoint: false,
            replication: false,
            vacuum: false
        };

        const capabilities = config.enabled
            ? await probeCapabilities(client, version, config, errors)
            : {};
        capabilities.ioTiming = serverInfo.trackIoTiming;

        collected.queries = config.enabled && config.queries && capabilities.queryPerformance === true;
        collected.activity = config.enabled && config.activityEnabled;
        collected.locks = config.enabled && config.locks && capabilities.locks === true;
        collected.indexes = collected.storage && config.indexes && capabilities.indexStats === true;
        collected.wal = config.enabled && config.wal && capabilities.walStats === true;
        collected.checkpoint = config.enabled && config.wal;
        collected.replication = config.enabled && config.replication;
        collected.vacuum = config.enabled && config.vacuum && capabilities.vacuumProgress === true;

        // ── cluster-wide sections ────────────────────────────────────────────
        const connectionRows = await tryQuery(
            client, q.connectionSummary(version), [], errors, 'connections'
        );
        const connections = parsers.parseConnections(connectionRows, serverInfo.maxConnections);
        // The legacy payload needs per-(database,state) counts.
        connections.byDatabaseState = {};
        for (const row of connectionRows || []) {
            connections.byDatabaseState[`${row.database}:${row.state}`] = parsers.num(row.count);
        }

        const databaseRows = await tryQuery(client, q.databaseStats(version), [], errors, 'pg_stat_database');
        const databaseStats = parsers.parseDatabaseStats(databaseRows);

        let statements = [];
        if (collected.queries) {
            const rows = await tryQuery(
                client, q.statementStats(version, config.maxStatements), [], errors, 'pg_stat_statements'
            );
            if (rows === null) { collected.queries = false; capabilities.queryPerformance = false; }
            else statements = parsers.parseStatements(rows);
        }

        let activity = [];
        let idleInTransaction = [];
        if (collected.activity) {
            const rows = await tryQuery(
                client, q.activitySnapshot(version, config.maxActivity), [], errors, 'pg_stat_activity'
            );
            if (rows === null) collected.activity = false;
            else activity = parsers.parseActivity(rows);

            const idleRows = await tryQuery(
                client, q.idleInTransaction(config.maxActivity), [], errors, 'idle_in_transaction'
            );
            if (idleRows) idleInTransaction = parsers.parseIdleInTransaction(idleRows);
        }

        let lockSummary = null;
        let blockingQueries = [];
        if (collected.locks) {
            const rows = await tryQuery(client, q.LOCK_SUMMARY, [], errors, 'pg_locks');
            if (rows === null) collected.locks = false;
            else lockSummary = parsers.parseLockSummary(rows);

            const blockingRows = await tryQuery(
                client, q.blockingQueries(version, config.maxBlocking), [], errors, 'blocking_queries'
            );
            if (blockingRows) blockingQueries = parsers.parseBlockingQueries(blockingRows);
        }

        let walStats = null;
        if (collected.wal) {
            const rows = await tryQuery(client, q.walStats(version), [], errors, 'pg_stat_wal');
            if (rows === null || !rows.length) { collected.wal = false; capabilities.walStats = false; }
            else walStats = parsers.parseWalStats(rows[0]);
        }

        let checkpointStats = null;
        if (collected.checkpoint) {
            const rows = await tryQuery(client, q.checkpointStats(version), [], errors, 'checkpoint_stats');
            if (rows === null || !rows.length) { collected.checkpoint = false; capabilities.checkpointStats = false; }
            else checkpointStats = parsers.parseCheckpointStats(rows[0]);
        }

        let replication = { enabled: false, replicas: [] };
        let replicaStatus = null;
        if (collected.replication) {
            if (serverInfo.inRecovery) {
                // A replica has no pg_stat_replication rows of its own; its own
                // replay position is the interesting figure.
                const rows = await tryQuery(client, q.replicaStatus(version), [], errors, 'replica_status');
                if (rows && rows.length) replicaStatus = parsers.parseReplicaStatus(rows[0]);
                replication = { enabled: true, role: 'replica', replicas: [] };
            } else {
                const rows = await tryQuery(client, q.replicationStats(version), [], errors, 'pg_stat_replication');
                if (rows === null) { collected.replication = false; capabilities.replication = false; }
                else replication = Object.assign(parsers.parseReplication(rows), { role: 'primary' });
            }
        }

        let vacuumProgress = [];
        if (collected.vacuum) {
            const rows = await tryQuery(client, q.vacuumProgress(version), [], errors, 'pg_stat_progress_vacuum');
            if (rows === null) { collected.vacuum = false; capabilities.vacuumProgress = false; }
            else vacuumProgress = parsers.parseVacuumProgress(rows);
        }

        // ── per-database sections ────────────────────────────────────────────
        // pg_stat_user_tables and friends only describe the connected database,
        // so each configured database needs its own connection. This is the
        // expensive part, hence the storage throttle.
        let tables = [];
        let indexes = [];
        if (collected.storage && capabilities.tableStats) {
            const targets = config.databases.length ? config.databases : [config.primaryDatabase];

            for (const database of targets) {
                let dbClient;
                try {
                    dbClient = database === config.primaryDatabase
                        ? client
                        : await connect(config, database);
                } catch (err) {
                    errors.push({ scope: `connect:${database}`, code: err.code || 'ERROR', message: 'connection failed' });
                    continue;
                }

                try {
                    const tableRows = await tryQuery(
                        dbClient, q.tableStats(config.maxTables), [], errors, `tables:${database}`
                    );
                    if (tableRows) tables = tables.concat(parsers.parseTableStats(tableRows, database));

                    if (collected.indexes) {
                        const indexRows = await tryQuery(
                            dbClient, q.indexStats(config.maxIndexes), [], errors, `indexes:${database}`
                        );
                        if (indexRows) indexes = indexes.concat(parsers.parseIndexStats(indexRows, database));
                    }
                } finally {
                    if (dbClient !== client) {
                        try { await dbClient.end(); } catch (e) { /* already gone */ }
                    }
                }
            }
        }

        // ── derived values ───────────────────────────────────────────────────
        const previousDatabases = new Map();
        if (previous && Array.isArray(previous.databases)) {
            for (const db of previous.databases) previousDatabases.set(db.database, db);
        }
        const databases = deriveDatabaseRates(databaseStats, previousDatabases, restarted, intervalSeconds);

        // Cluster totals, summed across databases.
        const clusterTotals = databases.reduce((acc, db) => {
            acc.transactionDelta += db.transactionDelta;
            acc.commitDelta += db.commitDelta;
            acc.rollbackDelta += db.rollbackDelta;
            acc.blksHitDelta += db.blksHitDelta;
            acc.blksReadDelta += db.blksReadDelta;
            acc.tempBytesDelta += db.tempBytesDelta;
            acc.tempFilesDelta += db.tempFilesDelta;
            acc.deadlocksDelta += db.deadlocksDelta;
            acc.rowsReturnedDelta += db.tupReturnedDelta;
            acc.rowsInsertedDelta += db.tupInsertedDelta;
            acc.rowsUpdatedDelta += db.tupUpdatedDelta;
            acc.rowsDeletedDelta += db.tupDeletedDelta;
            // A database whose size could not be read contributes nothing to
            // the cluster total rather than turning it into NaN.
            acc.totalSize += db.databaseSize === null ? 0 : db.databaseSize;
            return acc;
        }, {
            transactionDelta: 0, commitDelta: 0, rollbackDelta: 0,
            blksHitDelta: 0, blksReadDelta: 0, tempBytesDelta: 0, tempFilesDelta: 0,
            deadlocksDelta: 0, rowsReturnedDelta: 0, rowsInsertedDelta: 0,
            rowsUpdatedDelta: 0, rowsDeletedDelta: 0, totalSize: 0
        });

        const clusterBlocks = clusterTotals.blksHitDelta + clusterTotals.blksReadDelta;
        clusterTotals.cacheHitRatio = clusterBlocks > 0
            ? (clusterTotals.blksHitDelta / clusterBlocks) * 100 : null;
        clusterTotals.transactionsPerSecond = perSecond(clusterTotals.transactionDelta, intervalSeconds);
        clusterTotals.tempBytesPerSecond = perSecond(clusterTotals.tempBytesDelta, intervalSeconds);

        const derivedStatements = collected.queries
            ? deriveStatements(statements, previous, restarted, config.maxStatements, config.slowQueryThresholdMs)
            : [];

        const activitySummary = collected.activity
            ? summariseActivity(activity, idleInTransaction, config)
            : null;

        const walDerived = walStats ? {
            walRecordsDelta: counterDelta(walStats.walRecords, previous && previous.walRecords, restarted),
            walBytesDelta: counterDelta(walStats.walBytes, previous && previous.walBytes, restarted),
            walFpiDelta: counterDelta(walStats.walFpi, previous && previous.walFpi, restarted),
            walBuffersFullDelta: counterDelta(walStats.walBuffersFull, previous && previous.walBuffersFull, restarted)
        } : null;
        if (walDerived) {
            walDerived.walBytesPerSecond = perSecond(walDerived.walBytesDelta, intervalSeconds);
            walDerived.walRecordsPerSecond = perSecond(walDerived.walRecordsDelta, intervalSeconds);
        }

        const checkpointDerived = checkpointStats ? {
            checkpointsTimedDelta: counterDelta(checkpointStats.checkpointsTimed, previous && previous.checkpointsTimed, restarted),
            checkpointsRequestedDelta: counterDelta(checkpointStats.checkpointsRequested, previous && previous.checkpointsRequested, restarted),
            checkpointWriteTimeDelta: counterDelta(checkpointStats.checkpointWriteTime, previous && previous.checkpointWriteTime, restarted),
            checkpointSyncTimeDelta: counterDelta(checkpointStats.checkpointSyncTime, previous && previous.checkpointSyncTime, restarted),
            buffersCheckpointDelta: counterDelta(checkpointStats.buffersCheckpoint, previous && previous.buffersCheckpoint, restarted),
            buffersBackendDelta: counterDelta(checkpointStats.buffersBackend, previous && previous.buffersBackend, restarted),
            buffersAllocDelta: counterDelta(checkpointStats.buffersAlloc, previous && previous.buffersAlloc, restarted)
        } : null;

        // ── payloads ─────────────────────────────────────────────────────────
        const basic = toLegacyPayload(config, serverInfo, databaseStats, connections, lockSummary, statements);

        let advanced = null;
        if (config.enabled) {
            // A primary with no attached replicas is standalone, not "primary".
            const role = serverInfo.inRecovery ? 'replica'
                : (replication.enabled && replication.replicas && replication.replicas.length ? 'primary' : 'standalone');

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
                server: Object.assign({}, serverInfo, { role }),

                connections,
                databases,
                clusterTotals,
                slowQueryThresholdMs: config.slowQueryThresholdMs
            };

            if (collected.queries) advanced.statements = derivedStatements;
            if (collected.activity) {
                advanced.activity = activity;
                advanced.idleInTransaction = idleInTransaction;
                advanced.activitySummary = activitySummary;
            }
            if (collected.locks) {
                advanced.lockSummary = lockSummary;
                advanced.blockingQueries = blockingQueries;
            }
            if (collected.storage) advanced.tables = tables;
            if (collected.indexes) advanced.indexes = indexes;
            if (collected.wal && walStats) advanced.wal = Object.assign({}, walStats, walDerived);
            if (collected.checkpoint && checkpointStats) {
                advanced.checkpoint = Object.assign({}, checkpointStats, checkpointDerived);
            }
            if (collected.replication) {
                advanced.replication = replication;
                if (replicaStatus) advanced.replicaStatus = replicaStatus;
            }
            if (collected.vacuum) advanced.vacuumProgress = vacuumProgress;
            if (errors.length) advanced.collectorErrors = errors.slice(0, 20);
        }

        // Only advance the throttle clock on a scrape that actually collected.
        if (collected.storage) st.lastStorageAt = now;

        st.lastUptime = uptime;
        st.previous = {
            uptime,
            databases: databaseStats,
            statements: collected.queries ? statements : (previous && previous.statements) || [],
            walRecords: walStats ? walStats.walRecords : 0,
            walBytes: walStats ? walStats.walBytes : 0,
            walFpi: walStats ? walStats.walFpi : 0,
            walBuffersFull: walStats ? walStats.walBuffersFull : 0,
            checkpointsTimed: checkpointStats ? checkpointStats.checkpointsTimed : 0,
            checkpointsRequested: checkpointStats ? checkpointStats.checkpointsRequested : 0,
            checkpointWriteTime: checkpointStats ? checkpointStats.checkpointWriteTime : 0,
            checkpointSyncTime: checkpointStats ? checkpointStats.checkpointSyncTime : 0,
            buffersCheckpoint: checkpointStats ? checkpointStats.buffersCheckpoint : 0,
            buffersBackend: checkpointStats ? checkpointStats.buffersBackend : 0,
            buffersAlloc: checkpointStats ? checkpointStats.buffersAlloc : 0
        };

        callback(null, { basic, advanced });
    } catch (err) {
        callback(new Error(err.code ? `${err.code}: ${err.message}` : err.message), null);
    } finally {
        try { await client.end(); } catch (e) { /* connection already gone */ }
    }
}

module.exports = {
    collect,
    normalizeConfig,
    resetState,
    // Exported for tests.
    counterDelta,
    perSecond,
    deriveCacheHitRatio,
    deriveDatabaseRates,
    deriveStatements,
    summariseActivity,
    toLegacyPayload,
    DEFAULTS
};
