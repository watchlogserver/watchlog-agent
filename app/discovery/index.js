const { detectProcesses } = require('./detectProcesses');
const { detectPorts } = require('./detectPorts');
const { detectLogs } = require('./detectLogs');
const { detectDocker } = require('./detectDocker');
const { detectServices } = require('./detectServices');
const { syncConfigs } = require('./autoConfig');
const path = require('path');
const { readJsonSafe, writeJsonAtomic, truncateStr,
        MAX_DISCOVERY_LOGS, MAX_PATH_LENGTH, MAX_COMMAND_LENGTH } = require('../state/stateUtils');

const STATE_DIR = path.join(__dirname, '../../state');
const CACHE_FILE = path.join(STATE_DIR, 'discovery-cache.json');

// ===== Port enrichment =====

function enrichWithPorts(topProcs, ports) {
    const byPid = new Map();
    const byName = new Map();
    for (const p of (ports || [])) {
        if (p.pid) {
            const arr = byPid.get(p.pid) || [];
            if (!arr.includes(p.port)) arr.push(p.port);
            byPid.set(p.pid, arr);
        }
        if (p.processName) {
            const key = p.processName.toLowerCase();
            const arr = byName.get(key) || [];
            if (!arr.includes(p.port)) arr.push(p.port);
            byName.set(key, arr);
        }
    }
    return topProcs.map(p => ({
        ...p,
        ports: byPid.get(p.pid) || byName.get((p.name || '').toLowerCase()) || p.ports || [],
    }));
}

// ===== Related log detection =====

const RUNTIME_LOG_PREFIXES = {
    nginx:      '/var/log/nginx/',
    redis:      '/var/log/redis/',
    postgresql: '/var/log/postgresql/',
    mysql:      '/var/log/mysql/',
    mongodb:    '/var/log/mongodb/',
};

function matchRelatedLogs(proc, logPaths) {
    const runtime = proc.runtime || '';
    const name = (proc.name || '').toLowerCase();
    const sg = (proc.serviceGuess || '').toLowerCase();
    const parentRuntime = proc.parent?.runtime || '';

    // Known runtime → log directory prefix
    const prefix = RUNTIME_LOG_PREFIXES[runtime];
    if (prefix) {
        const found = logPaths.filter(p => p.startsWith(prefix));
        if (found.length > 0) return found.slice(0, 3);
    }

    // PM2-managed: look for ~/.pm2/logs/{appName}-*.log
    if (runtime === 'pm2' || parentRuntime === 'pm2') {
        const appName = sg || name;
        const pm2Logs = logPaths.filter(p => p.includes('.pm2/logs') && (p.includes(appName) || p.includes(name)));
        if (pm2Logs.length > 0) return pm2Logs.slice(0, 3);
        // Also return any pm2 logs if no name match
        const allPm2 = logPaths.filter(p => p.includes('.pm2/logs'));
        if (allPm2.length > 0) return allPm2.slice(0, 3);
    }

    // Generic: logs whose path contains process name or service guess
    const results = logPaths.filter(lp => {
        const lpLower = lp.toLowerCase();
        return (name && name.length > 2 && lpLower.includes(name)) ||
               (sg   && sg.length   > 2 && lpLower.includes(sg));
    });
    return results.slice(0, 3);
}

function enrichWithRelatedLogs(topProcs, logs) {
    const logPaths = (logs || []).map(l => l.path || '').filter(Boolean);
    return topProcs.map(proc => ({
        ...proc,
        relatedLogs: proc.relatedLogs || matchRelatedLogs(proc, logPaths),
    }));
}

function saveCache(snapshot) {
    // Omit processes.all (can be 500+ entries / hundreds of KB)
    // Trim logs list and truncate long strings to keep cache compact
    const trimmedLogs = (snapshot.logs || [])
        .slice(0, MAX_DISCOVERY_LOGS)
        .map(l => ({ ...l, path: truncateStr(l.path, MAX_PATH_LENGTH) }));

    const trimmedProcesses = {
        topCpu: (snapshot.processes?.topCpu || []).map(p => ({
            ...p,
            command: truncateStr(p.command, MAX_COMMAND_LENGTH)
        })),
        topMemory: (snapshot.processes?.topMemory || []).map(p => ({
            ...p,
            command: truncateStr(p.command, MAX_COMMAND_LENGTH)
        })),
        restarts: snapshot.processes?.restarts || [],
        restartWarnings: snapshot.processes?.restartWarnings || [],
        restartEvents: snapshot.processes?.restartEvents || [],
        total: snapshot.processes?.total || 0
        // processes.all intentionally excluded — too large for cache
    };

    const compact = {
        ...snapshot,
        logs: trimmedLogs,
        processes: trimmedProcesses,
    };

    writeJsonAtomic(CACHE_FILE, compact);
}

function loadCache() {
    return readJsonSafe(CACHE_FILE, null);
}

async function runDiscovery({ syncConfig = true } = {}) {
    console.log('[discovery] Starting server scan...');
    const startedAt = Date.now();

    const [processes, ports, logs, docker] = await Promise.all([
        detectProcesses(),
        detectPorts(),
        detectLogs(),
        detectDocker()
    ]);

    const services = detectServices(processes, ports, logs, docker);

    // Enrich top processes with ports and related logs (full scan context available)
    let topCpu = enrichWithPorts(processes.topCpu, ports);
    let topMemory = enrichWithPorts(processes.topMemory, ports);
    topCpu = enrichWithRelatedLogs(topCpu, logs);
    topMemory = enrichWithRelatedLogs(topMemory, logs);

    const snapshot = {
        runtime: 'linux',
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        services,
        logs,
        processes: {
            topCpu,
            topMemory,
            all: processes.all,
            restarts: processes.restartWarnings,
            restartWarnings: processes.restartWarnings,
            restartEvents: processes.restartEvents,
            total: processes.total
        },
        ports,
        docker
    };

    saveCache(snapshot);
    console.log(`[discovery] Scan complete in ${snapshot.durationMs}ms. Found ${services.filter(s => s.state !== 'not_detected').length} services, ${logs.length} logs, ${processes.total} processes.`);

    if (syncConfig) {
        syncConfigs(services, logs);
    }

    return snapshot;
}

// Lightweight process snapshot for periodic 60s collection
async function collectProcessSnapshot() {
    const [processes, ports] = await Promise.all([
        detectProcesses(),
        detectPorts(),
    ]);

    // Enrich with ports (fast, available in periodic snapshot)
    let topCpu = enrichWithPorts(processes.topCpu, ports);
    let topMemory = enrichWithPorts(processes.topMemory, ports);

    // Use cached logs for relatedLogs (avoids re-running full log detection every 60s)
    const cache = loadCache();
    if (cache?.logs) {
        topCpu = enrichWithRelatedLogs(topCpu, cache.logs);
        topMemory = enrichWithRelatedLogs(topMemory, cache.logs);
    }

    return {
        timestamp: new Date().toISOString(),
        topCpu,
        topMemory,
        restarts: processes.restartWarnings,
        restartWarnings: processes.restartWarnings,
        restartEvents: processes.restartEvents,
        total: processes.total
    };
}

function printDiscoverySummary(snapshot) {
    console.log('\n==============================');
    console.log('  Watchlog Discovery Summary');
    console.log('==============================');
    console.log(`Scanned at: ${snapshot.scannedAt}`);
    console.log(`Duration:   ${snapshot.durationMs}ms\n`);

    console.log('Detected Services:');
    for (const svc of snapshot.services) {
        if (svc.state === 'not_detected') continue;
        const icon = svc.state === 'enabled' ? '✓' : svc.state === 'detected_needs_config' ? '⚠' : '✗';
        const extra = svc.needsConfig ? ' (credentials required)' : '';
        console.log(`  ${icon} ${svc.service}${extra} — confidence: ${svc.confidence}%`);
    }

    const notDetected = snapshot.services.filter(s => s.state === 'not_detected');
    if (notDetected.length) {
        console.log('  Not found: ' + notDetected.map(s => s.service).join(', '));
    }

    console.log('\nDetected Logs:');
    for (const log of snapshot.logs) {
        console.log(`  ✓ ${log.path}`);
    }

    console.log('\nTop CPU Processes:');
    for (const p of snapshot.processes.topCpu.slice(0, 5)) {
        const extra = [
            p.cwd ? `cwd:${p.cwd}` : null,
            p.ports?.length ? `ports:${p.ports.join(',')}` : null,
            p.serviceGuess ? `service:${p.serviceGuess}` : null,
        ].filter(Boolean).join(' ');
        console.log(`  - ${p.commandSanitized || p.command || p.name} → ${p.cpu}% CPU${extra ? ' | ' + extra : ''}`);
    }

    console.log('\nTop Memory Processes:');
    for (const p of snapshot.processes.topMemory.slice(0, 5)) {
        console.log(`  - ${p.commandSanitized || p.command || p.name} → ${p.memory}MB`);
    }

    if (snapshot.docker.available) {
        console.log(`\nDocker: ${snapshot.docker.containers.length} container(s) running`);
    }

    console.log('\nOpen Ports: ' + snapshot.ports.map(p => p.port).slice(0, 10).join(', '));
    console.log('==============================\n');
}

module.exports = { runDiscovery, collectProcessSnapshot, loadCache, printDiscoverySummary };
