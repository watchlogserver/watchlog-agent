const si = require('systeminformation');
const os = require('os');
const { detectRuntime } = require('./helpers');
const path = require('path');
const fs = require('fs');

const STATE_DIR = path.join(__dirname, '../../state');
const PROCESS_HISTORY_FILE = path.join(STATE_DIR, 'process-history.json');

// Patterns that produce noisy false-positive restarts (Electron, macOS internals, etc.)
const NOISY_PATTERNS = [
    /Helper/,
    /Renderer/,
    /^com\.apple\./,
    /^Electron/i,
    /^Crashpad/i,
    /^GPU\s*Process/i,
    /^WindowServer$/,
    /^loginwindow$/,
    /^kernel_task$/,
    /^launchd$/,
    /^cfprefsd$/,
    /^distnoted$/,
    /^configd$/,
    /^coreaudiod$/,
    /^coresymd$/,
];

// Only these runtimes generate user-facing restart warnings
const IMPORTANT_RUNTIMES = new Set([
    'nodejs', 'nginx', 'redis', 'postgresql', 'mysql', 'mongodb',
    'docker', 'python', 'java', 'dotnet', 'pm2'
]);

const RESTART_THRESHOLD = 3;           // restarts needed to trigger a warning
const RESTART_WINDOW_MS = 15 * 60 * 1000; // within 15 minutes

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

function isNoisy(name, command) {
    const n = name || '';
    const c = command || '';
    for (const pat of NOISY_PATTERNS) {
        if (pat.test(n) || pat.test(c)) return true;
    }
    return false;
}

function classifyProcess(name, runtime) {
    const n = name || '';
    if (runtime && IMPORTANT_RUNTIMES.has(runtime)) return 'application';
    for (const pat of NOISY_PATTERNS) {
        if (!pat.test(n)) continue;
        if (/Renderer|GPU/i.test(n)) return 'renderer';
        if (/Helper/i.test(n)) return 'helper';
        if (/^com\.apple\./i.test(n)) return 'os_internal';
        return 'os_internal';
    }
    // Short lowercase names ending in 'd' are typically system daemons
    if (/^[a-z][a-z0-9_-]*d$/.test(n)) return 'system';
    return 'application';
}

// Returns { events, warnings }
// events  — all raw PID changes (for ES/AI correlation)
// warnings — filtered: important runtime + not noisy + threshold reached
function detectRestarts(current, history) {
    const events = [];
    const now = Date.now();
    const windowStart = now - RESTART_WINDOW_MS;

    for (const proc of current) {
        const key = proc.command;
        if (!key) continue;

        const prev = history[key];

        if (prev && prev.pid !== proc.pid) {
            // A PID change: count as a restart event
            const prevTimes = (prev.restartTimes || []).filter(t => t > windowStart);
            const newTimes = [...prevTimes, now];

            history[key] = { pid: proc.pid, seenAt: now, restartTimes: newTimes };

            events.push({
                name: proc.name,
                command: proc.command,
                previousPid: prev.pid,
                currentPid: proc.pid,
                detectedAt: new Date(now).toISOString(),
                classification: classifyProcess(proc.name, proc.runtime),
                runtime: proc.runtime || 'unknown',
                restartCount: newTimes.length,
            });
        } else {
            history[key] = {
                pid: proc.pid,
                seenAt: now,
                restartTimes: (prev?.restartTimes || []).filter(t => t > windowStart),
            };
        }
    }

    // Prune history entries not seen in last 10 minutes
    const cutoff = now - 10 * 60 * 1000;
    for (const key of Object.keys(history)) {
        if (history[key].seenAt < cutoff) delete history[key];
    }

    // User-facing warnings: filter noise, require important runtime, require threshold
    const warnings = events.filter(e =>
        !isNoisy(e.name, e.command) &&
        IMPORTANT_RUNTIMES.has(e.runtime) &&
        e.restartCount >= RESTART_THRESHOLD
    );

    return { events, warnings };
}

async function detectProcesses() {
    try {
        const procs = await si.processes();

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

        // Detect restarts with noise filtering and threshold logic
        const history = loadProcessHistory();
        const { events: restartEvents, warnings: restartWarnings } = detectRestarts(processList, history);
        saveProcessHistory(history);

        return {
            all: processList,
            topCpu,
            topMemory,
            restarts: restartWarnings,  // backward compat: user-facing warnings only
            restartEvents,              // raw PID changes for internal/ES use
            restartWarnings,            // explicit alias for restarts
            total: processList.length
        };
    } catch (err) {
        console.error('[discovery] detectProcesses error:', err.message);
        return { all: [], topCpu: [], topMemory: [], restarts: [], restartEvents: [], restartWarnings: [], total: 0 };
    }
}

module.exports = { detectProcesses };
