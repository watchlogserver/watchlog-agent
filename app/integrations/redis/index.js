// Redis advanced collector.
//
// Mirrors the MongoDB advanced collector: `app/integrations/redis.js` keeps
// working and keeps emitting the exact payload it always has, while this module
// runs one redis-cli session and derives BOTH the legacy payload and the
// advanced observability payload from it.
//
// Design notes
//   * One spawn per scrape. redis-cli executes commands piped on stdin, so all
//     sections are fetched in a single session with `ECHO` markers between them.
//   * `--json` is required: SLOWLOG's plain-text form flattens the nested
//     argument array with no delimiter, making the boundary between the last
//     command argument and the client address ambiguous.
//   * The password goes through the REDISCLI_AUTH environment variable, never
//     argv — `-a <password>` is visible to every user on the box via `ps`.
//   * Only read-only commands are issued. Nothing here mutates configuration or
//     data: no CONFIG SET, no SLOWLOG RESET, no KEYS, no FLUSH*, no MONITOR.
//   * A section the Redis user cannot run comes back as an `ERR`/`NOPERM` line
//     on stdout; that section degrades to empty and the rest still ships.

'use strict';

const { execFile } = require('child_process');
const parsers = require('./parsers');
const { sanitizeCommand } = require('./sanitize');

const DEFAULTS = {
    slowlogLimit: 128,
    maxCommands: 200,
    maxSlowlogPerScrape: 100,
    commandsIntervalSeconds: 60,
    execTimeoutMs: 20000,
    maxBuffer: 16 * 1024 * 1024
};

const MARKER = '__WL_REDIS_SEP__';

// Section order must match SECTION_NAMES exactly — the two are read positionally.
const SECTION_NAMES = ['info', 'commandstats', 'slowlog', 'config', 'clusterInfo', 'clusterNodes'];

// Per-instance memory: previous counters (for deltas), the slowlog high-water
// mark (for deduplication), and throttle clocks. Keyed by `host:port`.
const state = new Map();

function instanceState(id) {
    if (!state.has(id)) {
        state.set(id, {
            lastSlowlogId: -1,
            lastRunId: null,
            lastCommandsAt: 0,
            previous: null
        });
    }
    return state.get(id);
}

// Exposed for tests: lets a suite drive restart/reset scenarios deterministically.
function resetState() {
    state.clear();
}

// ── redis-cli discovery ───────────────────────────────────────────────────────

let cliCache = { available: null, checkedAt: 0 };
const CLI_CACHE_MS = 10 * 60 * 1000;

function detectCli(callback) {
    const now = Date.now();
    if (cliCache.available !== null && now - cliCache.checkedAt < CLI_CACHE_MS) {
        return callback(cliCache.available);
    }
    // `--json` landed in redis-cli 6.2. Probing it directly is more honest than
    // parsing --version, since a customer may have a new server behind an old CLI.
    execFile('redis-cli', ['--json', '--version'], { timeout: 10000 }, (err) => {
        cliCache = { available: !err, checkedAt: now };
        callback(!err);
    });
}

// ── config ────────────────────────────────────────────────────────────────────

function normalizeConfig(integrate) {
    const advanced = integrate.advanced || {};
    const slowlog = integrate.slowlog || {};

    return {
        host: integrate.host || '127.0.0.1',
        port: String(integrate.port || '6379'),
        password: integrate.password || '',
        username: integrate.username || '',
        db: integrate.db !== undefined ? String(integrate.db) : '',
        tls: integrate.tls === true,

        enabled: advanced.enabled !== false,
        commands: advanced.commands !== false,
        keyspace: advanced.keyspace !== false,
        replication: advanced.replication !== false,
        cluster: advanced.cluster !== false,

        slowlogEnabled: slowlog.enabled !== false,
        slowlogLimit: Number(slowlog.limit || DEFAULTS.slowlogLimit),
        maxSlowlogPerScrape: Number(slowlog.maxPerScrape || DEFAULTS.maxSlowlogPerScrape),

        maxCommands: Number(advanced.maxCommands || DEFAULTS.maxCommands),
        commandsIntervalSeconds: Number(advanced.commandsIntervalSeconds || DEFAULTS.commandsIntervalSeconds)
    };
}

function buildArgs(config) {
    // --json only. Passing --no-raw alongside it makes redis-cli fall back to
    // the human-readable `1) 1) (integer) 0` format, which the SLOWLOG and
    // CONFIG parsers cannot read.
    const args = ['-h', String(config.host), '-p', String(config.port), '--json'];
    if (config.username) args.push('--user', String(config.username));
    if (config.db) args.push('-n', String(config.db));
    if (config.tls) args.push('--tls');
    return args;
}

// Commands are newline-delimited on stdin with ECHO markers between them so the
// concatenated output can be split back into sections.
function buildCommandScript(config, collected) {
    const lines = [];
    const push = (command) => {
        lines.push(`ECHO ${MARKER}`);
        lines.push(command);
    };

    push('INFO');
    // INFO commandstats is not part of the default INFO reply.
    push(collected.commands ? 'INFO commandstats' : 'ECHO ');
    push(collected.slowlog ? `SLOWLOG GET ${config.slowlogLimit}` : 'ECHO ');
    // Read-only. Used to tell the user whether their slowlog threshold makes
    // sense; the agent never writes configuration.
    push(collected.slowlog ? 'CONFIG GET slowlog-*' : 'ECHO ');
    push(collected.cluster ? 'CLUSTER INFO' : 'ECHO ');
    push(collected.cluster ? 'CLUSTER NODES' : 'ECHO ');

    return `${lines.join('\n')}\n`;
}

// ── derivation ────────────────────────────────────────────────────────────────

/**
 * Diffs a cumulative counter against the previous scrape.
 *
 * Redis resets every counter on restart, and `run_id` changes with it. Both are
 * checked: a counter that went backwards is treated as a fresh start rather
 * than emitting a negative rate.
 */
function counterDelta(current, previous, restarted) {
    const cur = Number(current) || 0;
    if (restarted || previous === null || previous === undefined) return 0;
    const prev = Number(previous) || 0;
    return cur >= prev ? cur - prev : 0;
}

/**
 * Cache hit rate over the interval, not since boot.
 *
 * A server up for a month reports a lifetime hit rate that cannot move; the
 * interval rate is what actually reveals a cache going cold.
 */
function deriveHitRate(hits, misses, previous, restarted) {
    const hitsDelta = counterDelta(hits, previous && previous.keyspaceHits, restarted);
    const missesDelta = counterDelta(misses, previous && previous.keyspaceMisses, restarted);
    const total = hitsDelta + missesDelta;

    return {
        hits: hitsDelta,
        misses: missesDelta,
        // No requests in the window is not a 0% hit rate — it is "no data".
        // Reporting 0 would draw an alarming cliff on an idle instance.
        rate: total > 0 ? (hitsDelta / total) * 100 : null,
        lifetimeRate: (Number(hits) + Number(misses)) > 0
            ? (Number(hits) / (Number(hits) + Number(misses))) * 100
            : null
    };
}

function deriveCpu(info, previous, restarted) {
    const sys = parsers.num(info.used_cpu_sys);
    const user = parsers.num(info.used_cpu_user);

    return {
        usedCpuSys: sys,
        usedCpuUser: user,
        usedCpuSysChildren: parsers.num(info.used_cpu_sys_children),
        usedCpuUserChildren: parsers.num(info.used_cpu_user_children),
        usedCpuSysMainThread: parsers.num(info.used_cpu_sys_main_thread),
        usedCpuUserMainThread: parsers.num(info.used_cpu_user_main_thread),
        sysDelta: counterDelta(sys, previous && previous.usedCpuSys, restarted),
        userDelta: counterDelta(user, previous && previous.usedCpuUser, restarted)
    };
}

/**
 * Per-command deltas plus an "impact" ranking.
 *
 * impact = calls in the interval x average microseconds per call, i.e. the
 * total CPU time the command actually consumed. It is the only ordering that
 * surfaces a 0.2ms command running 100k times ahead of one 900ms outlier.
 */
function deriveCommands(current, previous, restarted, limit) {
    const previousByName = new Map();
    if (previous && Array.isArray(previous.commands)) {
        for (const entry of previous.commands) previousByName.set(entry.command, entry);
    }

    const derived = current.map((entry) => {
        const prev = previousByName.get(entry.command);
        const callsDelta = counterDelta(entry.calls, prev && prev.calls, restarted);
        const usecDelta = counterDelta(entry.usec, prev && prev.usec, restarted);
        const avgUsec = callsDelta > 0 ? usecDelta / callsDelta : entry.usecPerCall;

        return {
            command: entry.command,
            calls: entry.calls,
            callsDelta,
            usec: entry.usec,
            usecDelta,
            avgUsec,
            usecPerCall: entry.usecPerCall,
            rejectedCalls: entry.rejectedCalls,
            rejectedCallsDelta: counterDelta(entry.rejectedCalls, prev && prev.rejectedCalls, restarted),
            failedCalls: entry.failedCalls,
            failedCallsDelta: counterDelta(entry.failedCalls, prev && prev.failedCalls, restarted),
            impact: callsDelta * avgUsec
        };
    });

    // Rank by interval activity so the cap keeps what is busy now, not what was
    // busy at some point since boot.
    derived.sort((a, b) => (b.impact - a.impact) || (b.callsDelta - a.callsDelta) || (b.calls - a.calls));
    return derived.slice(0, limit);
}

// ── payload assembly ──────────────────────────────────────────────────────────

// Reproduces app/integrations/redis.js exactly so the existing socket event,
// the `redis` Influx measurement and every current dashboard keep working.
function toLegacyPayload(config, info, keyspace) {
    let totalKeys = 0;
    for (const db of keyspace) totalKeys += db.keys;

    return {
        id: `${config.host}:${config.port}`,
        version: info.redis_version,
        host: config.host,
        port: config.port,
        tcp_port: parsers.num(info.tcp_port),
        uptime: parsers.num(info.uptime_in_seconds),
        connectedClients: parsers.num(info.connected_clients),
        memoryUsed: parsers.num(info.used_memory),
        memoryPeak: parsers.num(info.used_memory_peak),
        maxmemory: parsers.num(info.maxmemory),
        totalConnectionsReceived: parsers.num(info.total_connections_received),
        totalCommandsProcessed: parsers.num(info.total_commands_processed),
        keyspaceHits: parsers.num(info.keyspace_hits),
        keyspaceMisses: parsers.num(info.keyspace_misses),
        expiredKeys: parsers.num(info.expired_keys),
        pubsubChannels: parsers.num(info.pubsub_channels),
        pubsubPatterns: parsers.num(info.pubsub_patterns),
        role: info.role,
        totalNetInputBytes: parsers.num(info.total_net_input_bytes),
        totalNetOutputBytes: parsers.num(info.total_net_output_bytes),
        totalKeys
    };
}

function buildMemory(info) {
    const maxMemory = parsers.num(info.maxmemory);
    const usedMemory = parsers.num(info.used_memory);

    return {
        usedMemory,
        usedMemoryRss: parsers.num(info.used_memory_rss),
        usedMemoryPeak: parsers.num(info.used_memory_peak),
        usedMemoryOverhead: parsers.num(info.used_memory_overhead),
        usedMemoryDataset: parsers.num(info.used_memory_dataset),
        usedMemoryLua: parsers.num(info.used_memory_lua),
        usedMemoryScripts: parsers.num(info.used_memory_scripts),
        maxMemory,
        maxMemoryPolicy: String(info.maxmemory_policy || ''),
        fragmentationRatio: parsers.num(info.mem_fragmentation_ratio),
        fragmentationBytes: parsers.num(info.mem_fragmentation_bytes),
        allocatorAllocated: parsers.num(info.allocator_allocated),
        allocatorActive: parsers.num(info.allocator_active),
        allocatorResident: parsers.num(info.allocator_resident),
        allocatorFrag: parsers.num(info.allocator_frag_ratio),
        lazyfreePendingObjects: parsers.num(info.lazyfree_pending_objects),
        // maxmemory of 0 means "no limit". Deriving a percentage from it would
        // manufacture a number that means nothing, so the flag is explicit and
        // the percentage is null rather than 0.
        memoryLimitConfigured: maxMemory > 0,
        memoryUsagePercentage: maxMemory > 0 ? (usedMemory / maxMemory) * 100 : null
    };
}

function buildClients(info) {
    const connected = parsers.num(info.connected_clients);
    const maxClients = parsers.num(info.maxclients);

    return {
        connectedClients: connected,
        blockedClients: parsers.num(info.blocked_clients),
        trackingClients: parsers.num(info.tracking_clients),
        maxClients,
        clusterConnections: parsers.num(info.cluster_connections),
        connectionUtilization: maxClients > 0 ? (connected / maxClients) * 100 : null
    };
}

function buildPersistence(info) {
    return {
        rdbChangesSinceLastSave: parsers.num(info.rdb_changes_since_last_save),
        rdbBgsaveInProgress: parsers.num(info.rdb_bgsave_in_progress) === 1,
        rdbLastSaveTime: parsers.num(info.rdb_last_save_time) * 1000,
        rdbLastBgsaveStatus: String(info.rdb_last_bgsave_status || ''),
        rdbLastBgsaveTimeSec: parsers.num(info.rdb_last_bgsave_time_sec),
        rdbCurrentBgsaveTimeSec: parsers.num(info.rdb_current_bgsave_time_sec),
        aofEnabled: parsers.num(info.aof_enabled) === 1,
        aofRewriteInProgress: parsers.num(info.aof_rewrite_in_progress) === 1,
        aofLastBgrewriteStatus: String(info.aof_last_bgrewrite_status || ''),
        aofLastWriteStatus: String(info.aof_last_write_status || ''),
        aofCurrentSize: parsers.num(info.aof_current_size),
        aofBaseSize: parsers.num(info.aof_base_size),
        aofPendingBioFsync: parsers.num(info.aof_pending_bio_fsync),
        aofDelayedFsync: parsers.num(info.aof_delayed_fsync),
        loading: parsers.num(info.loading) === 1
    };
}

function buildStats(info, previous, restarted) {
    const totalCommands = parsers.num(info.total_commands_processed);

    return {
        totalConnectionsReceived: parsers.num(info.total_connections_received),
        totalCommandsProcessed: totalCommands,
        commandsProcessedDelta: counterDelta(totalCommands, previous && previous.totalCommandsProcessed, restarted),
        instantaneousOpsPerSec: parsers.num(info.instantaneous_ops_per_sec),
        totalNetInputBytes: parsers.num(info.total_net_input_bytes),
        totalNetOutputBytes: parsers.num(info.total_net_output_bytes),
        instantaneousInputKbps: parsers.num(info.instantaneous_input_kbps),
        instantaneousOutputKbps: parsers.num(info.instantaneous_output_kbps),
        rejectedConnections: parsers.num(info.rejected_connections),
        rejectedConnectionsDelta: counterDelta(parsers.num(info.rejected_connections), previous && previous.rejectedConnections, restarted),
        expiredKeys: parsers.num(info.expired_keys),
        expiredKeysDelta: counterDelta(parsers.num(info.expired_keys), previous && previous.expiredKeys, restarted),
        evictedKeys: parsers.num(info.evicted_keys),
        evictedKeysDelta: counterDelta(parsers.num(info.evicted_keys), previous && previous.evictedKeys, restarted),
        keyspaceHits: parsers.num(info.keyspace_hits),
        keyspaceMisses: parsers.num(info.keyspace_misses),
        pubsubChannels: parsers.num(info.pubsub_channels),
        pubsubPatterns: parsers.num(info.pubsub_patterns),
        totalReads: parsers.num(info.total_reads_processed),
        totalWrites: parsers.num(info.total_writes_processed),
        totalErrorReplies: parsers.num(info.total_error_replies),
        totalErrorRepliesDelta: counterDelta(parsers.num(info.total_error_replies), previous && previous.totalErrorReplies, restarted)
    };
}

/**
 * Filters SLOWLOG entries down to the ones not yet shipped, and redacts them.
 *
 * Redis assigns monotonically increasing slowlog ids, but they restart from 0
 * when the server restarts or the log is trimmed. `run_id` changes on restart,
 * so identity is (run_id, slowlog id) — that pair is what makes the downstream
 * Elasticsearch document id deterministic and therefore duplicate-proof.
 */
function selectNewSlowlogEntries(entries, st, runId, limit) {
    const restarted = st.lastRunId !== null && st.lastRunId !== runId;
    // A restart resets ids to 0, so the previous high-water mark would suppress
    // every genuinely new entry.
    const threshold = restarted ? -1 : st.lastSlowlogId;

    const fresh = entries
        .filter((entry) => entry.id > threshold)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);

    let highest = threshold;
    for (const entry of fresh) highest = Math.max(highest, entry.id);

    const sanitized = fresh.map((entry) => {
        const clean = sanitizeCommand(entry.args);
        return {
            id: entry.id,
            runId,
            timestamp: entry.timestamp,
            durationMicroseconds: entry.durationMicroseconds,
            durationMilliseconds: entry.durationMilliseconds,
            commandName: clean.commandName || entry.commandName,
            // Raw arguments never leave this function.
            command: clean.command,
            redactedArguments: clean.redactedCount,
            clientAddress: entry.clientAddress,
            clientName: entry.clientName
        };
    });

    return { entries: sanitized, highestId: highest, restarted };
}

// ── entry point ───────────────────────────────────────────────────────────────

/**
 * Collects Redis metrics in a single redis-cli session.
 *
 * @param {object} integrate  the redis entry from integration.json
 * @param {function} callback (err, { basic, advanced })
 */
function collect(integrate, callback) {
    const config = normalizeConfig(integrate);
    const id = `${config.host}:${config.port}`;
    const st = instanceState(id);
    const now = Date.now();

    const collected = {
        info: true,
        commands: config.enabled && config.commands &&
            now - st.lastCommandsAt >= config.commandsIntervalSeconds * 1000,
        slowlog: config.enabled && config.slowlogEnabled,
        cluster: config.enabled && config.cluster,
        keyspace: config.enabled && config.keyspace,
        replication: config.enabled && config.replication
    };

    detectCli((available) => {
        if (!available) {
            return callback(new Error('redis-cli with --json support (6.2+) is not on PATH'), null);
        }

        const args = buildArgs(config);
        const script = buildCommandScript(config, collected);

        const child = execFile('redis-cli', args, {
            timeout: DEFAULTS.execTimeoutMs,
            maxBuffer: DEFAULTS.maxBuffer,
            windowsHide: true,
            // REDISCLI_AUTH keeps the password out of argv, where `ps` would
            // expose it to every user on the machine.
            env: config.password
                ? Object.assign({}, process.env, { REDISCLI_AUTH: config.password })
                : process.env
        }, (error, stdout, stderr) => {
            const sections = parsers.splitSections(stdout, MARKER);

            if (sections.length < SECTION_NAMES.length) {
                const detail = String(stderr || '').trim().split('\n').filter(Boolean).pop();
                return callback(new Error(detail || 'redis-cli returned no parsable output'), null);
            }

            const raw = {};
            SECTION_NAMES.forEach((name, i) => { raw[name] = sections[i]; });

            const { info, keyspaceLines, replicaLines } = parsers.parseInfo(raw.info);

            if (!info.redis_version) {
                return callback(new Error('INFO returned no redis_version — is this a Redis server?'), null);
            }

            const runId = String(info.run_id || '');
            // run_id changing means the server restarted; every cumulative
            // counter reset to zero along with it.
            const restarted = st.previous !== null && st.lastRunId !== null && st.lastRunId !== runId;
            const previous = restarted ? null : st.previous;

            const keyspace = collected.keyspace ? parsers.parseKeyspace(keyspaceLines) : [];
            const basic = toLegacyPayload(config, info, parsers.parseKeyspace(keyspaceLines));

            if (!config.enabled) {
                st.previous = { keyspaceHits: parsers.num(info.keyspace_hits) };
                st.lastRunId = runId;
                return callback(null, { basic, advanced: null });
            }

            const memory = buildMemory(info);
            const clients = buildClients(info);
            const stats = buildStats(info, previous, restarted);
            const cpu = deriveCpu(info, previous, restarted);
            const hitRate = deriveHitRate(
                parsers.num(info.keyspace_hits), parsers.num(info.keyspace_misses), previous, restarted
            );

            const advanced = {
                id,
                host: config.host,
                port: config.port,
                origin: id,
                runId,
                restarted,
                collectedAt: Date.now(),
                collected,

                server: {
                    version: String(info.redis_version || ''),
                    mode: String(info.redis_mode || 'standalone'),
                    role: String(info.role || 'unknown'),
                    uptimeSeconds: parsers.num(info.uptime_in_seconds),
                    uptimeDays: parsers.num(info.uptime_in_days),
                    hz: parsers.num(info.hz),
                    configuredHz: parsers.num(info.configured_hz),
                    processId: parsers.num(info.process_id),
                    executable: String(info.executable || ''),
                    os: String(info.os || ''),
                    tcpPort: parsers.num(info.tcp_port),
                    clusterEnabled: parsers.num(info.cluster_enabled) === 1
                },

                memory,
                clients,
                stats,
                cpu,
                hitRate,
                persistence: buildPersistence(info)
            };

            if (collected.keyspace) advanced.keyspace = keyspace;

            if (collected.commands) {
                const commandStats = parsers.parseCommandstats(raw.commandstats);
                advanced.commands = deriveCommands(commandStats, previous, restarted, config.maxCommands);
                if (parsers.isErrorSection(raw.commandstats)) advanced.commandsUnavailable = true;
            }

            if (collected.replication) {
                advanced.replication = parsers.parseReplication(info, replicaLines);
            }

            if (collected.cluster) {
                const clusterInfo = parsers.parseClusterInfo(raw.clusterInfo);
                advanced.cluster = clusterInfo;
                if (clusterInfo.enabled) {
                    advanced.cluster.nodes = parsers.parseClusterNodes(raw.clusterNodes);
                }
            }

            if (collected.slowlog) {
                const parsed = parsers.parseSlowlog(raw.slowlog);
                const selection = selectNewSlowlogEntries(parsed, st, runId, config.maxSlowlogPerScrape);
                advanced.slowlog = selection.entries;
                st.lastSlowlogId = selection.highestId;

                const slowlogConfig = parsers.parseConfigGet(raw.config);
                advanced.slowlogConfig = {
                    // The agent reports the threshold so the UI can recommend a
                    // change; it never applies one itself.
                    thresholdMicroseconds: slowlogConfig['slowlog-log-slower-than'] !== undefined
                        ? parsers.num(slowlogConfig['slowlog-log-slower-than']) : null,
                    maxLen: slowlogConfig['slowlog-max-len'] !== undefined
                        ? parsers.num(slowlogConfig['slowlog-max-len']) : null,
                    available: !parsers.isErrorSection(raw.slowlog)
                };
                if (parsers.isErrorSection(raw.slowlog)) advanced.slowlogUnavailable = true;
            }

            // Only advance the throttle clock on a scrape that actually collected.
            if (collected.commands) st.lastCommandsAt = now;

            st.lastRunId = runId;
            st.previous = {
                keyspaceHits: parsers.num(info.keyspace_hits),
                keyspaceMisses: parsers.num(info.keyspace_misses),
                totalCommandsProcessed: parsers.num(info.total_commands_processed),
                rejectedConnections: parsers.num(info.rejected_connections),
                expiredKeys: parsers.num(info.expired_keys),
                evictedKeys: parsers.num(info.evicted_keys),
                totalErrorReplies: parsers.num(info.total_error_replies),
                usedCpuSys: parsers.num(info.used_cpu_sys),
                usedCpuUser: parsers.num(info.used_cpu_user),
                commands: collected.commands
                    ? parsers.parseCommandstats(raw.commandstats)
                    : (st.previous && st.previous.commands) || []
            };

            callback(null, { basic, advanced });
        });

        child.stdin.on('error', () => { /* redis-cli exited early; execFile reports it */ });
        child.stdin.end(script);
    });
}

module.exports = {
    collect,
    normalizeConfig,
    resetState,
    // Exported for tests.
    counterDelta,
    deriveHitRate,
    deriveCommands,
    selectNewSlowlogEntries,
    buildMemory,
    buildClients,
    buildPersistence,
    MARKER,
    SECTION_NAMES,
    DEFAULTS
};
