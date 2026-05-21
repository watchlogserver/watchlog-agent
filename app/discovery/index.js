const { detectProcesses } = require('./detectProcesses');
const { detectPorts } = require('./detectPorts');
const { detectLogs } = require('./detectLogs');
const { detectDocker } = require('./detectDocker');
const { detectServices } = require('./detectServices');
const { syncConfigs } = require('./autoConfig');
const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, '../../state');
const CACHE_FILE = path.join(STATE_DIR, 'discovery-cache.json');

function saveCache(snapshot) {
    try {
        if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch {}
}

function loadCache() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        }
    } catch {}
    return null;
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
            restarts: processes.restarts,
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
        restarts: processes.restarts,
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
