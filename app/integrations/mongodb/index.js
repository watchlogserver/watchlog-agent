// MongoDB advanced collector.
//
// Replaces nothing: `app/integrations/mongo.js` keeps working and keeps
// emitting the exact payload it always has. This module runs the same shell
// once and derives BOTH the legacy payload and the advanced observability
// payload from that single round-trip, so upgrading costs no extra spawns.
//
// Design notes
//   * execFile (not exec) — arguments never touch a shell, so a password
//     containing quotes or `;` cannot break out into the command line.
//   * Storage and index traversal are throttled independently of the 60s
//     server-status tick; walking every collection every minute is the main
//     way a monitoring agent becomes the problem it was installed to detect.
//   * Cumulative counters are shipped raw. Rates that only the agent can
//     compute correctly (per-interval latency average / maximum) are derived
//     here from the previous sample.

'use strict';

const { execFile } = require('child_process');
const { buildScript } = require('./evalScript');

const DEFAULTS = {
    maxDatabases: 50,
    maxCollectionsPerDb: 100,
    maxCollections: 300,
    maxSlowQueries: 100,
    slowQueryThreshold: 100,
    storageIntervalSeconds: 300,
    indexIntervalSeconds: 300,
    execTimeoutMs: 45000,
    maxBuffer: 32 * 1024 * 1024
};

const SENTINEL = '__WLMONGO__';

// Per-instance memory: previous sample (for interval derivation), throttle
// clocks, and the profiler high-water mark so slow queries are never shipped
// twice. Keyed by `host:port`.
const state = new Map();

function instanceState(id) {
    if (!state.has(id)) {
        state.set(id, {
            lastStorageAt: 0,
            lastIndexAt: 0,
            lastSlowQueryTs: Date.now() - 60000,
            previous: null
        });
    }
    return state.get(id);
}

// ── shell discovery ───────────────────────────────────────────────────────────

// Advanced collection requires mongosh: the script relies on async/await over
// the Promise-based shell API, which the legacy `mongo` shell does not provide.
// When only `mongo` exists the caller falls back to the original basic
// collector, so those agents keep reporting health as before.
let shellCache = { available: null, checkedAt: 0 };
const SHELL_CACHE_MS = 10 * 60 * 1000;

function detectShell(callback) {
    const now = Date.now();
    if (shellCache.available !== null && now - shellCache.checkedAt < SHELL_CACHE_MS) {
        return callback(shellCache.available ? 'mongosh' : null);
    }

    execFile('mongosh', ['--version'], { timeout: 10000 }, (err) => {
        shellCache = { available: !err, checkedAt: now };
        callback(err ? null : 'mongosh');
    });
}

function buildArgs(config, script) {
    const args = [
        '--host', String(config.host),
        '--port', String(config.port),
        '--quiet',
        '--norc'
    ];

    if (config.username) {
        args.push('--username', String(config.username));
        args.push('--password', String(config.password || ''));
        args.push('--authenticationDatabase', String(config.authDatabase || 'admin'));
    }

    if (config.tls) args.push('--tls');

    args.push('--eval', script);
    return args;
}

/**
 * execFile's error message embeds the entire command line, which for an
 * authenticated instance contains --password. Logging it verbatim would write
 * the database credentials into the agent log, so failures are always reported
 * through this instead.
 */
function describeFailure(error, stderr) {
    const detail = String(stderr || '').trim().split('\n').filter(Boolean).pop();
    if (detail) return detail.slice(0, 300);
    if (error && error.killed) return 'mongosh timed out';
    if (error && error.code) return `mongosh exited with code ${error.code}`;
    return 'no parsable output from mongosh';
}

// The shell prints connection banners and deprecation warnings on stdout even
// under --quiet, so the payload is located by its sentinel rather than by
// assuming stdout is pure JSON.
function extractPayload(stdout) {
    if (!stdout) return null;
    const idx = stdout.lastIndexOf(SENTINEL);
    if (idx === -1) return null;
    const raw = stdout.slice(idx + SENTINEL.length).trim();
    try {
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

// ── config normalisation ──────────────────────────────────────────────────────

/**
 * Reads the mongodb entry from integration.json and fills in defaults.
 * Supports both the nested form (`advanced: {...}`, `slowQuery: {...}`) and
 * the flat `slowQueryEnabled` / `slowQueryThreshold` keys.
 */
function normalizeConfig(integrate) {
    const advanced = integrate.advanced || {};
    const slowQuery = integrate.slowQuery || {};

    return {
        host: integrate.host || 'localhost',
        port: String(integrate.port || '27017'),
        username: integrate.username || '',
        password: integrate.password || '',
        authDatabase: integrate.authDatabase || 'admin',
        tls: integrate.tls === true,

        enabled: advanced.enabled !== false,
        storage: advanced.storage !== false,
        indexes: advanced.indexes !== false,
        replication: advanced.replication !== false,

        slowQueryEnabled: slowQuery.enabled === true || integrate.slowQueryEnabled === true,
        slowQueryThreshold: Number(
            slowQuery.threshold !== undefined ? slowQuery.threshold
                : integrate.slowQueryThreshold !== undefined ? integrate.slowQueryThreshold
                    : DEFAULTS.slowQueryThreshold
        ),

        maxDatabases: Number(advanced.maxDatabases || DEFAULTS.maxDatabases),
        maxCollectionsPerDb: Number(advanced.maxCollectionsPerDatabase || DEFAULTS.maxCollectionsPerDb),
        maxCollections: Number(advanced.maxCollections || DEFAULTS.maxCollections),
        maxSlowQueries: Number(advanced.maxSlowQueries || DEFAULTS.maxSlowQueries),
        storageIntervalSeconds: Number(advanced.storageIntervalSeconds || DEFAULTS.storageIntervalSeconds),
        indexIntervalSeconds: Number(advanced.indexIntervalSeconds || DEFAULTS.indexIntervalSeconds)
    };
}

// ── derivation helpers ────────────────────────────────────────────────────────

// Cumulative latency counters only become meaningful as a delta. A server that
// has been up for a month reports a since-boot average that no longer reflects
// anything happening now.
function deriveLatency(current, previous) {
    const out = {};
    const sections = ['reads', 'writes', 'commands', 'transactions'];

    for (const section of sections) {
        const cur = (current && current[section]) || { latency: 0, ops: 0 };
        const prev = previous && previous[section];

        let deltaLatency = 0;
        let deltaOps = 0;

        // A counter that went backwards means the server restarted; treat the
        // sample as the first one rather than emitting a negative rate.
        if (prev && cur.latency >= prev.latency && cur.ops >= prev.ops) {
            deltaLatency = cur.latency - prev.latency;
            deltaOps = cur.ops - prev.ops;
        }

        out[section] = {
            // Microseconds → milliseconds, matching how the dashboard labels latency.
            avg: deltaOps > 0 ? (deltaLatency / deltaOps) / 1000 : 0,
            max: deriveHistogramMax(cur.histogram, prev && prev.histogram) / 1000,
            count: deltaOps,
            totalLatency: cur.latency,
            totalOps: cur.ops
        };
    }

    return out;
}

// Highest histogram bucket that gained a sample since the previous scrape.
// Buckets are upper bounds, so this is an upper bound on interval max latency.
function deriveHistogramMax(current, previous) {
    if (!current || !current.length) return 0;

    const prevByBucket = new Map();
    if (previous) {
        for (const bucket of previous) prevByBucket.set(bucket.micros, bucket.count);
    }

    let max = 0;
    for (const bucket of current) {
        const before = prevByBucket.get(bucket.micros) || 0;
        // Without a previous sample every non-empty bucket counts, which yields
        // the since-boot maximum — the best available answer on first scrape.
        if (bucket.count > before && bucket.micros > max) max = bucket.micros;
    }
    return max;
}

// ── legacy payload ────────────────────────────────────────────────────────────

// Reproduces app/integrations/mongo.js exactly so the existing socket event,
// the server-agent handler, the `mongodb` Influx measurement and every current
// dashboard keep working untouched.
function toLegacyPayload(config, payload) {
    const s = payload.server;
    return {
        id: `${config.host}:${config.port}`,
        host: config.host,
        port: config.port,
        version: s.version,
        uptime: s.uptime,
        connections: s.connectionsCurrent,
        availableConnections: s.connectionsAvailable,
        usageMemory: s.memResident,
        virtualMemory: s.memVirtual,
        insert: s.opInsert,
        query: s.opQuery,
        update: s.opUpdate,
        delete: s.opDelete,
        command: s.opCommand,
        networkIn: s.networkBytesIn,
        networkOut: s.networkBytesOut,
        networkRequests: s.networkNumRequests,
        latencyCommands: payload.latency.commands.totalLatency,
        latencyReads: payload.latency.reads.totalLatency,
        latencyWrites: payload.latency.writes.totalLatency
    };
}

// ── advanced payload ──────────────────────────────────────────────────────────

function toAdvancedPayload(config, payload, latency, collected) {
    const s = payload.server;
    const id = `${config.host}:${config.port}`;

    const advanced = {
        id,
        host: config.host,
        port: config.port,
        instance: id,
        version: s.version,
        uptime: s.uptime,
        collectedAt: Date.now(),
        // Tells the server which sections are authoritative in this payload;
        // a throttled section is absent, not empty.
        collected,

        server: {
            connectionsCurrent: s.connectionsCurrent,
            connectionsAvailable: s.connectionsAvailable,
            connectionsTotalCreated: s.connectionsTotalCreated,
            connectionsActive: s.connectionsActive,
            memResident: s.memResident,
            memVirtual: s.memVirtual,
            opInsert: s.opInsert,
            opQuery: s.opQuery,
            opUpdate: s.opUpdate,
            opDelete: s.opDelete,
            opGetmore: s.opGetmore,
            opCommand: s.opCommand,
            networkBytesIn: s.networkBytesIn,
            networkBytesOut: s.networkBytesOut,
            networkNumRequests: s.networkNumRequests,
            queuedReaders: s.queuedReaders,
            queuedWriters: s.queuedWriters,
            queuedTotal: s.queuedTotal,
            activeReaders: s.activeReaders,
            activeWriters: s.activeWriters,
            activeTotal: s.activeTotal,
            scannedKeys: s.scannedKeys,
            scannedObjects: s.scannedObjects,
            docsReturned: s.docsReturned,
            docsInserted: s.docsInserted,
            docsUpdated: s.docsUpdated,
            docsDeleted: s.docsDeleted,
            scanAndOrder: s.scanAndOrder,
            assertsRegular: s.assertsRegular,
            assertsWarning: s.assertsWarning,
            assertsMsg: s.assertsMsg,
            assertsUser: s.assertsUser
        },

        latency: {
            readAvg: latency.reads.avg,
            readMax: latency.reads.max,
            readCount: latency.reads.count,
            writeAvg: latency.writes.avg,
            writeMax: latency.writes.max,
            writeCount: latency.writes.count,
            commandAvg: latency.commands.avg,
            commandMax: latency.commands.max,
            commandCount: latency.commands.count
        },

        wiredTiger: payload.wiredTiger || { available: false },
        profiling: payload.profiling || { enabled: false, databases: [] }
    };

    if (collected.storage) {
        advanced.databases = payload.databases || [];
        advanced.collections = payload.collections || [];
    }
    if (collected.indexes) {
        advanced.indexes = payload.indexes || [];
    }
    if (collected.replication) {
        advanced.replication = payload.replication || { isReplicaSet: false, members: [] };
    }
    if (collected.slowQueries) {
        advanced.slowQueries = payload.slowQueries || [];
    }
    if (payload.errors && payload.errors.length) {
        advanced.collectorErrors = payload.errors;
    }

    return advanced;
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Collects MongoDB metrics in a single shell round-trip.
 *
 * @param {object} integrate   the mongodb entry from integration.json
 * @param {function} callback  (err, { basic, advanced }) — `advanced` is null
 *                             when advanced collection is disabled
 */
function collect(integrate, callback) {
    const config = normalizeConfig(integrate);
    const id = `${config.host}:${config.port}`;
    const st = instanceState(id);
    const now = Date.now();

    const collected = {
        server: true,
        storage: config.enabled && config.storage &&
            now - st.lastStorageAt >= config.storageIntervalSeconds * 1000,
        indexes: config.enabled && config.indexes &&
            now - st.lastIndexAt >= config.indexIntervalSeconds * 1000,
        replication: config.enabled && config.replication,
        slowQueries: config.enabled && config.slowQueryEnabled
    };

    detectShell((bin) => {
        if (!bin) {
            return callback(new Error('mongosh is not on PATH'), null);
        }

        const script = buildScript({
            maxDatabases: config.maxDatabases,
            maxCollectionsPerDb: config.maxCollectionsPerDb,
            maxCollections: config.maxCollections,
            maxSlowQueries: config.maxSlowQueries,
            includeStorage: collected.storage,
            includeIndexes: collected.indexes,
            includeReplication: collected.replication,
            includeSlowQueries: collected.slowQueries,
            slowQueryThreshold: config.slowQueryThreshold,
            slowQuerySinceMs: st.lastSlowQueryTs
        });

        const args = buildArgs(config, script);

        execFile(bin, args, {
            timeout: DEFAULTS.execTimeoutMs,
            maxBuffer: DEFAULTS.maxBuffer,
            windowsHide: true
        }, (error, stdout, stderr) => {
            const payload = extractPayload(stdout);

            if (!payload || !payload.ok || !payload.server) {
                // A failed shell must not advance the throttle clocks, otherwise
                // a transient outage silently skips a whole storage cycle.
                const reason = payload
                    ? 'serverStatus unavailable'
                    : describeFailure(error, stderr);
                return callback(new Error(reason), null);
            }

            const latency = deriveLatency(payload.latency, st.previous && st.previous.latency);

            const basic = toLegacyPayload(config, payload);
            const advanced = config.enabled
                ? toAdvancedPayload(config, payload, latency, collected)
                : null;

            if (collected.storage) st.lastStorageAt = now;
            if (collected.indexes) st.lastIndexAt = now;

            // Advance the profiler cursor past the newest document we shipped so
            // the next scrape cannot re-send the same slow queries.
            if (collected.slowQueries && payload.slowQueries && payload.slowQueries.length) {
                const newest = payload.slowQueries.reduce(
                    (max, q) => (q.timestamp > max ? q.timestamp : max), st.lastSlowQueryTs
                );
                st.lastSlowQueryTs = newest;
            } else if (collected.slowQueries) {
                // Nothing matched: move the window forward so it never grows unbounded.
                st.lastSlowQueryTs = Math.max(st.lastSlowQueryTs, now - 60000);
            }

            st.previous = { latency: payload.latency };

            callback(null, { basic, advanced });
        });
    });
}

module.exports = { collect, normalizeConfig, DEFAULTS };
