const si = require('systeminformation');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { detectRuntime } = require('./helpers');
const { readJsonSafe, writeJsonAtomic, truncateStr,
        RETENTION_MS, MAX_PROCESS_ENTRIES, MAX_COMMAND_LENGTH } = require('../state/stateUtils');

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
const RESTART_WINDOW_MS = RETENTION_MS; // within 15 minutes (shared with state retention)

// ===== Command sanitization =====

const SECRET_INLINE_RE = /(\b(?:password|passwd|token|secret|api[-_]?key|auth(?:orization)?|credential|private[-_]?key|access[-_]?key|database[-_]?url|mongo(?:db)?[-_]?uri|redis[-_]?url|postgres(?:ql)?[-_]?(?:url|password)|mysql[-_]?password|connection[-_]?string))\s*[=:]\s*\S+/gi;
const SECRET_CONNSTR_RE = /\/\/[^:@\s/]+:[^@\s/]+@/g;

function sanitizeCommand(cmd) {
    if (!cmd || typeof cmd !== 'string') return '';
    let s = cmd;
    s = s.replace(SECRET_INLINE_RE, (m, key) => `${key}=[REDACTED]`);
    s = s.replace(SECRET_CONNSTR_RE, '//[REDACTED]@');
    return s.slice(0, MAX_COMMAND_LENGTH);
}

// ===== /proc filesystem helpers (Linux only) =====

function readProcLink(pid, link) {
    try {
        return fs.readlinkSync(`/proc/${pid}/${link}`);
    } catch {
        return null;
    }
}

// ===== Service guessing =====

const RUNTIME_SERVICE_MAP = {
    nginx: 'nginx',
    redis: 'redis',
    postgresql: 'postgresql',
    mysql: 'mysql',
    mongodb: 'mongodb',
    docker: 'docker',
};

function guessService(name, cmd, cwd, runtime, parentRuntime) {
    if (RUNTIME_SERVICE_MAP[runtime]) return RUNTIME_SERVICE_MAP[runtime];

    const n = (name || '').toLowerCase();
    const c = (cmd || '').toLowerCase();

    // PM2-managed: extract app name from --name flag or entry file
    if (runtime === 'pm2' || parentRuntime === 'pm2' || c.includes('pm2')) {
        const nameFlag = c.match(/--name\s+(\S+)/);
        if (nameFlag) return nameFlag[1];
        const entryFile = c.match(/node\s+(\S+\.js)/);
        if (entryFile) return path.basename(entryFile[1], '.js');
    }

    // Node.js: use cwd directory name
    if (runtime === 'nodejs' && cwd) {
        const dir = path.basename(cwd);
        if (dir && dir !== '/' && dir !== '.' && !/^\d+$/.test(dir)) return `node-${dir}`;
    }

    // Python: use cwd directory name
    if (runtime === 'python' && cwd) {
        const dir = path.basename(cwd);
        if (dir && dir !== '/' && dir !== '.') return `python-${dir}`;
    }

    // Java: extract jar name from command
    if (runtime === 'java') {
        const jar = c.match(/(\S+\.jar)/);
        if (jar) return path.basename(jar[1], '.jar');
    }

    // PHP: use cwd directory name
    if (runtime === 'php' && cwd) {
        const dir = path.basename(cwd);
        if (dir && dir !== '/' && dir !== '.') return `php-${dir}`;
    }

    return null;
}

// ===== Enrich a single top process with cwd, exe, parent, serviceGuess =====

function enrichProcess(p, pidMap) {
    // Parent info
    const parentProc = p.ppid ? pidMap.get(p.ppid) : null;
    const parent = parentProc
        ? { pid: parentProc.pid, name: parentProc.name, runtime: parentProc.runtime || null }
        : null;

    // Linux-only: cwd and executablePath via /proc
    let cwd = null;
    let executablePath = null;
    if (process.platform === 'linux' && p.pid) {
        cwd = readProcLink(p.pid, 'cwd');
        executablePath = readProcLink(p.pid, 'exe');
    }

    const commandSanitized = sanitizeCommand(p.command);
    const serviceGuess = guessService(p.name, p.command, cwd, p.runtime, parent?.runtime);

    return {
        ...p,
        commandSanitized,
        cwd,
        executablePath,
        parent,
        serviceGuess,
    };
}

function loadProcessHistory() {
    return readJsonSafe(PROCESS_HISTORY_FILE, {});
}

function saveProcessHistory(history) {
    // Enforce max entries by evicting oldest-seenAt entries
    const keys = Object.keys(history);
    if (keys.length > MAX_PROCESS_ENTRIES) {
        keys.sort((a, b) => (history[a].seenAt || 0) - (history[b].seenAt || 0));
        for (const k of keys.slice(0, keys.length - MAX_PROCESS_ENTRIES)) {
            delete history[k];
        }
    }
    writeJsonAtomic(PROCESS_HISTORY_FILE, history);
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
        const key = truncateStr(proc.command, MAX_COMMAND_LENGTH);
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
                commandSanitized: proc.commandSanitized || sanitizeCommand(proc.command),
                serviceGuess: proc.serviceGuess || null,
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

        // Build pid→process map for parent resolution
        const pidMap = new Map(processList.map(p => [p.pid, p]));

        // Sort by CPU to get top consumers
        const topCpuRaw = [...processList]
            .sort((a, b) => b.cpu - a.cpu)
            .slice(0, 10);

        const topMemoryRaw = [...processList]
            .sort((a, b) => b.memory - a.memory)
            .slice(0, 10);

        // Enrich top processes with cwd, exe, parent, serviceGuess, commandSanitized
        const topCpu = topCpuRaw.map(p => enrichProcess(p, pidMap));
        const topMemory = topMemoryRaw.map(p => enrichProcess(p, pidMap));

        // Detect restarts with noise filtering and threshold logic
        // Pass enriched list so restart events include commandSanitized/serviceGuess
        const enrichedAll = processList.map(p => ({
            ...p,
            commandSanitized: sanitizeCommand(p.command),
        }));
        const history = loadProcessHistory();
        const { events: restartEvents, warnings: restartWarnings } = detectRestarts(enrichedAll, history);
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

module.exports = { detectProcesses, sanitizeCommand };
