// parsers.js — pure parsing functions for Redis INFO and friends.
//
// Deliberately free of I/O so every format can be unit-tested against captured
// real-world output (see test/redis-parsers.test.js). Redis output formats vary
// by version and deployment; a parser that can only be exercised against a live
// server is a parser that never gets tested against a replica, a cluster node,
// or a 5.x instance.
//
// Every function is total: malformed or missing input yields an empty/neutral
// result rather than throwing, because one unavailable INFO section must never
// take down the whole Redis integration.

'use strict';

// redis-cli prints command errors to stdout, so an errored section looks like
// ordinary output. This is how a section is recognised as unavailable.
const ERROR_PREFIXES = ['ERR ', 'NOPERM ', 'WRONGTYPE ', 'DENIED ', 'NOAUTH ', 'EXECABORT '];

function isErrorSection(text) {
    if (!text) return false;
    const trimmed = String(text).trim();
    if (!trimmed) return false;
    return ERROR_PREFIXES.some((p) => trimmed.startsWith(p));
}

function num(value) {
    if (value === null || value === undefined || value === '') return 0;
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Splits the concatenated output of a piped redis-cli session on the ECHO
 * delimiters the collector interleaves between commands.
 *
 * With --json the echoed marker comes back quoted, so both forms are accepted.
 */
function splitSections(stdout, marker) {
    if (!stdout) return [];
    const pattern = new RegExp(`^"?${marker}"?\\s*$`);
    const chunks = [];
    let current = null;

    for (const rawLine of String(stdout).split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (pattern.test(line.trim())) {
            if (current !== null) chunks.push(current.join('\n').trim());
            current = [];
            continue;
        }
        if (current !== null) current.push(line);
    }
    if (current !== null) chunks.push(current.join('\n').trim());

    return chunks;
}

/**
 * Parses an INFO reply into a flat map plus the raw keyspace lines.
 *
 * `db0:keys=1,expires=0,avg_ttl=0` lines are kept separate because they are
 * records, not scalars, and would otherwise collide in the flat map.
 */
function parseInfo(text) {
    const info = {};
    const keyspaceLines = {};
    const replicaLines = [];

    if (!text || isErrorSection(text)) return { info, keyspaceLines, replicaLines };

    for (const rawLine of String(text).split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line || line.startsWith('#')) continue;

        const idx = line.indexOf(':');
        if (idx === -1) continue;

        const key = line.slice(0, idx);
        const value = line.slice(idx + 1);

        if (/^db\d+$/.test(key)) {
            keyspaceLines[key] = value;
            continue;
        }
        // slave0:ip=...,port=...,state=online,offset=...,lag=0
        if (/^slave\d+$/.test(key)) {
            replicaLines.push({ index: Number(key.replace('slave', '')), value });
            continue;
        }
        info[key] = value;
    }

    return { info, keyspaceLines, replicaLines };
}

// Parses `key=value,key=value` pairs used throughout INFO.
function parseFieldPairs(value) {
    const out = {};
    if (!value) return out;
    for (const part of String(value).split(',')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
}

/**
 * `db0:keys=1200,expires=400,avg_ttl=450000` → per-database records.
 * persistentKeys is derived, never read from Redis, because Redis does not
 * report it.
 */
function parseKeyspace(keyspaceLines) {
    const databases = [];
    if (!keyspaceLines) return databases;

    for (const dbName of Object.keys(keyspaceLines)) {
        const fields = parseFieldPairs(keyspaceLines[dbName]);
        const keys = num(fields.keys);
        const expires = num(fields.expires);
        databases.push({
            database: dbName,
            keys,
            expires,
            // A key with no TTL lives until evicted; the split matters when
            // diagnosing why memory only ever grows.
            persistentKeys: Math.max(0, keys - expires),
            avgTTL: num(fields.avg_ttl)
        });
    }

    databases.sort((a, b) => {
        const an = Number(a.database.replace('db', ''));
        const bn = Number(b.database.replace('db', ''));
        return an - bn;
    });
    return databases;
}

/**
 * `cmdstat_get:calls=10,usec=100,usec_per_call=10.00,rejected_calls=0,failed_calls=0`
 *
 * Redis reports cumulative counters; the collector diffs them between scrapes.
 */
function parseCommandstats(text) {
    const commands = [];
    if (!text || isErrorSection(text)) return commands;

    for (const rawLine of String(text).split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line || line.startsWith('#')) continue;
        if (!line.startsWith('cmdstat_')) continue;

        const idx = line.indexOf(':');
        if (idx === -1) continue;

        const command = line.slice('cmdstat_'.length, idx);
        const fields = parseFieldPairs(line.slice(idx + 1));
        if (!command) continue;

        commands.push({
            command,
            calls: num(fields.calls),
            usec: num(fields.usec),
            usecPerCall: num(fields.usec_per_call),
            rejectedCalls: num(fields.rejected_calls),
            failedCalls: num(fields.failed_calls)
        });
    }

    return commands;
}

/**
 * Builds the replication view from INFO replication.
 *
 * A primary reports its replicas as slaveN lines; a replica reports its link to
 * the primary as scalars. Both shapes are normalised into one structure so the
 * dashboard does not branch on role.
 */
function parseReplication(info, replicaLines) {
    const role = String(info.role || 'unknown');
    const out = {
        role,
        // Redis calls it master/slave; the UI uses primary/replica.
        isPrimary: role === 'master',
        isReplica: role === 'slave',
        connectedReplicas: num(info.connected_slaves),
        replicationOffset: num(info.master_repl_offset),
        backlogActive: num(info.repl_backlog_active) === 1,
        backlogSize: num(info.repl_backlog_size),
        backlogHistlen: num(info.repl_backlog_histlen),
        replicas: []
    };

    for (const entry of replicaLines || []) {
        const fields = parseFieldPairs(entry.value);
        const offset = num(fields.offset);
        out.replicas.push({
            index: entry.index,
            host: String(fields.ip || ''),
            port: num(fields.port),
            state: String(fields.state || ''),
            offset,
            // Redis reports `lag` in seconds and only for online replicas; the
            // byte distance from the primary offset is the more actionable
            // number when lag is 0 but the replica is falling behind.
            lag: num(fields.lag),
            offsetBytesBehind: Math.max(0, out.replicationOffset - offset),
            online: String(fields.state || '') === 'online'
        });
    }

    if (out.isReplica) {
        out.masterHost = String(info.master_host || '');
        out.masterPort = num(info.master_port);
        out.masterLinkStatus = String(info.master_link_status || '');
        out.masterLinkUp = String(info.master_link_status || '') === 'up';
        out.masterLastIoSecondsAgo = num(info.master_last_io_seconds_ago);
        out.masterSyncInProgress = num(info.master_sync_in_progress) === 1;
        out.slaveReplOffset = num(info.slave_repl_offset);
        out.slaveReadOnly = num(info.slave_read_only) === 1;
        out.slavePriority = num(info.slave_priority);
        // On a replica, master_repl_offset is its own applied offset, so the
        // byte gap can only be computed on the primary side.
        out.replicationOffset = num(info.slave_repl_offset) || out.replicationOffset;
    }

    return out;
}

/** CLUSTER INFO → flat map of `key:value` lines. */
function parseClusterInfo(text) {
    if (!text || isErrorSection(text)) return { enabled: false };

    const map = {};
    for (const rawLine of String(text).split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line) continue;
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        map[line.slice(0, idx)] = line.slice(idx + 1);
    }

    if (!map.cluster_state) return { enabled: false };

    return {
        enabled: true,
        state: String(map.cluster_state),
        slotsAssigned: num(map.cluster_slots_assigned),
        slotsOk: num(map.cluster_slots_ok),
        slotsPfail: num(map.cluster_slots_pfail),
        slotsFail: num(map.cluster_slots_fail),
        knownNodes: num(map.cluster_known_nodes),
        size: num(map.cluster_size),
        currentEpoch: num(map.cluster_current_epoch),
        myEpoch: num(map.cluster_my_epoch)
    };
}

/**
 * CLUSTER NODES →
 *   <id> <ip:port@cport[,hostname]> <flags> <master> <ping> <pong> <epoch> <link-state> <slot>...
 */
function parseClusterNodes(text) {
    const nodes = [];
    if (!text || isErrorSection(text)) return nodes;

    for (const rawLine of String(text).split('\n')) {
        const line = rawLine.replace(/\r$/, '').trim();
        if (!line) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 8) continue;

        const [id, addressField, flagField, masterId, , pongRecv, configEpoch, linkState] = parts;
        const flags = String(flagField).split(',');

        // ip:port@cport[,hostname]
        const addressOnly = String(addressField).split('@')[0];
        const hostname = String(addressField).includes(',')
            ? String(addressField).split(',').slice(1).join(',')
            : '';
        const lastColon = addressOnly.lastIndexOf(':');

        const slots = [];
        let slotCount = 0;
        for (const token of parts.slice(8)) {
            // Importing/migrating slots look like [slot-<-nodeid]; they are
            // transient and not part of steady-state coverage.
            if (token.startsWith('[')) continue;
            const range = token.split('-');
            const start = Number(range[0]);
            const end = range.length > 1 ? Number(range[1]) : start;
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            slots.push(range.length > 1 ? `${start}-${end}` : String(start));
            slotCount += end - start + 1;
        }

        nodes.push({
            id: String(id),
            host: lastColon > -1 ? addressOnly.slice(0, lastColon) : addressOnly,
            port: lastColon > -1 ? num(addressOnly.slice(lastColon + 1)) : 0,
            hostname,
            address: addressOnly,
            role: flags.includes('master') ? 'master' : flags.includes('slave') ? 'replica' : 'unknown',
            self: flags.includes('myself'),
            failed: flags.includes('fail'),
            possiblyFailed: flags.includes('fail?'),
            handshake: flags.includes('handshake'),
            flags: flags.filter((f) => f !== 'myself'),
            masterId: masterId === '-' ? '' : String(masterId),
            pongRecv: num(pongRecv),
            configEpoch: num(configEpoch),
            linkState: String(linkState),
            slots,
            slotCount
        });
    }

    return nodes;
}

/**
 * SLOWLOG GET under `redis-cli --json`:
 *   [[id, unixSeconds, durationMicros, [arg, ...], "client:port", "clientName"]]
 *
 * The plain-text form is deliberately not supported: it flattens the nested
 * argument array with no delimiter, so the boundary between the last command
 * argument and the client address is genuinely ambiguous.
 */
function parseSlowlog(text) {
    if (!text || isErrorSection(text)) return [];

    let rows;
    try {
        rows = JSON.parse(String(text).trim());
    } catch (e) {
        return [];
    }
    if (!Array.isArray(rows)) return [];

    const entries = [];
    for (const row of rows) {
        if (!Array.isArray(row) || row.length < 4) continue;

        const args = Array.isArray(row[3]) ? row[3].map((a) => String(a)) : [];
        const durationMicroseconds = num(row[2]);

        entries.push({
            id: num(row[0]),
            timestamp: num(row[1]) * 1000,
            durationMicroseconds,
            durationMilliseconds: durationMicroseconds / 1000,
            commandName: args.length ? String(args[0]).toUpperCase() : '',
            args,
            clientAddress: row.length > 4 ? String(row[4] || '') : '',
            clientName: row.length > 5 ? String(row[5] || '') : ''
        });
    }

    return entries;
}

/**
 * CONFIG GET replies in two shapes depending on the protocol in use:
 *   RESP3 (Redis 7 + `--json`) → {"slowlog-max-len": "128"}
 *   RESP2                      → ["slowlog-max-len", "128"]
 * Both are accepted so the parser does not depend on which protocol redis-cli
 * negotiated with the server.
 */
function parseConfigGet(text) {
    const out = {};
    if (!text || isErrorSection(text)) return out;

    let parsed;
    try {
        parsed = JSON.parse(String(text).trim());
    } catch (e) {
        return out;
    }

    if (Array.isArray(parsed)) {
        for (let i = 0; i + 1 < parsed.length; i += 2) {
            out[String(parsed[i])] = String(parsed[i + 1]);
        }
        return out;
    }

    if (parsed && typeof parsed === 'object') {
        for (const key of Object.keys(parsed)) out[key] = String(parsed[key]);
    }
    return out;
}

module.exports = {
    isErrorSection,
    splitSections,
    parseInfo,
    parseFieldPairs,
    parseKeyspace,
    parseCommandstats,
    parseReplication,
    parseClusterInfo,
    parseClusterNodes,
    parseSlowlog,
    parseConfigGet,
    num
};
