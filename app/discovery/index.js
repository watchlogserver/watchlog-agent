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

    const snapshot = {
        runtime: 'linux',
        scannedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        services,
        logs,
        processes: {
            topCpu: processes.topCpu,
            topMemory: processes.topMemory,
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
    const processes = await detectProcesses();
    return {
        timestamp: new Date().toISOString(),
        topCpu: processes.topCpu,
        topMemory: processes.topMemory,
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
        console.log(`  - ${p.command || p.name} → ${p.cpu}% CPU`);
    }

    console.log('\nTop Memory Processes:');
    for (const p of snapshot.processes.topMemory.slice(0, 5)) {
        console.log(`  - ${p.command || p.name} → ${p.memory}MB`);
    }

    if (snapshot.docker.available) {
        console.log(`\nDocker: ${snapshot.docker.containers.length} container(s) running`);
    }

    console.log('\nOpen Ports: ' + snapshot.ports.map(p => p.port).slice(0, 10).join(', '));
    console.log('==============================\n');
}

module.exports = { runDiscovery, collectProcessSnapshot, loadCache, printDiscoverySummary };
