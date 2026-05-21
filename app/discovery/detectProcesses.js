const si = require('systeminformation');
const os = require('os');
const { execCmd, detectRuntime } = require('./helpers');
const path = require('path');
const fs = require('fs');

const STATE_DIR = path.join(__dirname, '../../state');
const PROCESS_HISTORY_FILE = path.join(STATE_DIR, 'process-history.json');

function loadProcessHistory() {
    try {
        if (fs.existsSync(PROCESS_HISTORY_FILE)) {
            return JSON.parse(fs.readFileSync(PROCESS_HISTORY_FILE, 'utf8'));
        }
    } catch {}
    return {};
}

function saveProcessHistory(history) {
    try {
        if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(PROCESS_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
    } catch {}
}

// Detect process restarts: same command but different PID
function detectRestarts(current, history) {
    const restarts = [];
    const now = Date.now();

    for (const proc of current) {
        const key = proc.command;
        if (!key) continue;
        const prev = history[key];
        if (prev && prev.pid !== proc.pid) {
            restarts.push({
                name: proc.name,
                command: proc.command,
                previousPid: prev.pid,
                currentPid: proc.pid,
                detectedAt: new Date().toISOString()
            });
        }
        history[key] = { pid: proc.pid, seenAt: now };
    }

    // Prune history entries older than 10 minutes
    const cutoff = now - 10 * 60 * 1000;
    for (const key of Object.keys(history)) {
        if (history[key].seenAt < cutoff) delete history[key];
    }

    return restarts;
}

async function getProcessUptime(pid) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const parts = stat.split(' ');
        const startTimeTicks = parseInt(parts[21], 10);
        const uptimeRaw = fs.readFileSync('/proc/uptime', 'utf8');
        const systemUptimeSec = parseFloat(uptimeRaw.split(' ')[0]);
        const clkTck = 100; // standard Hz
        const startTimeSec = startTimeTicks / clkTck;
        return Math.floor(systemUptimeSec - startTimeSec);
    } catch {
        return 0;
    }
}

async function detectProcesses() {
    try {
        const [procs, cpuLoad] = await Promise.all([
            si.processes(),
            si.currentLoad()
        ]);

        const processList = [];

        const totalMemBytes = os.totalmem();

        for (const p of (procs.list || [])) {
            if (!p.pid || p.pid === 0) continue;

            const runtime = detectRuntime(p.name, p.command || p.params || '');
            // systeminformation v5: memRss is in KB on macOS/Linux (from ps output)
            const memRssKB = typeof p.memRss === 'number' ? p.memRss : 0;
            const memoryBytes = memRssKB * 1024;
            const memoryMB = memRssKB ? Math.round(memRssKB / 1024) : 0;
            const memoryPercent = memoryBytes && totalMemBytes
                ? Math.round((memoryBytes / totalMemBytes) * 10000) / 100
                : 0;

            processList.push({
                pid: p.pid,
                ppid: p.parentPid || 0,
                name: p.name || '',
                command: p.command || p.params || p.name || '',
                user: p.user || '',
                cpu: typeof p.cpu === 'number' ? Math.round(p.cpu * 100) / 100 : 0,
                memoryBytes,
                memory: memoryMB,     // kept for backward compat (MB value)
                memoryPercent,
                uptime: 0,
                runtime
            });
        }

        // Sort by CPU to get top consumers
        const topCpu = [...processList]
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 10);

        const topMemory = [...processList]
            .sort((a, b) => b.memory - a.memory)
            .slice(0, 10);

        // Detect restarts
        const history = loadProcessHistory();
        const restarts = detectRestarts(processList, history);
        saveProcessHistory(history);

        return {
            all: processList,
            topCpu,
            topMemory,
            restarts,
            total: processList.length
        };
    } catch (err) {
        console.error('[discovery] detectProcesses error:', err.message);
        return { all: [], topCpu: [], topMemory: [], restarts: [], total: 0 };
    }
}

module.exports = { detectProcesses };
