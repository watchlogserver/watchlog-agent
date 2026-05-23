const { globFiles } = require('./helpers');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const STALE_DAYS = 30;
const ROTATED_PAT = /\.\d+$|\.(gz|bz2|zip|old|archive)$/i;
const MAX_RECOMMENDED_PM2_LOGS = 10;

const LOG_DEFINITIONS = [
    {
        name: 'Nginx Access Log',
        path: '/var/log/nginx/access.log',
        service: 'nginx',
        format: 'nginx',
        recommended: true
    },
    {
        name: 'Nginx Error Log',
        path: '/var/log/nginx/error.log',
        service: 'nginx',
        format: 'auto',
        recommended: true
    },
    {
        name: 'Redis Log',
        path: '/var/log/redis/redis.log',
        service: 'redis',
        format: 'auto',
        recommended: true
    },
    {
        name: 'Redis Server Log',
        path: '/var/log/redis/redis-server.log',
        service: 'redis',
        format: 'auto',
        recommended: true
    },
    {
        name: 'MySQL Error Log',
        path: '/var/log/mysql/error.log',
        service: 'mysql',
        format: 'auto',
        recommended: true
    },
    {
        name: 'PostgreSQL Log',
        path: '/var/log/postgresql/*.log',
        service: 'postgresql',
        format: 'auto',
        recommended: true,
        glob: true
    },
    {
        name: 'Syslog',
        path: '/var/log/syslog',
        service: 'system',
        format: 'auto',
        recommended: true
    },
    {
        name: 'Auth Log',
        path: '/var/log/auth.log',
        service: 'system',
        format: 'auto',
        recommended: true
    },
    {
        name: 'System Messages',
        path: '/var/log/messages',
        service: 'system',
        format: 'auto',
        recommended: false
    },
    {
        name: 'Kernel Log',
        path: '/var/log/kern.log',
        service: 'system',
        format: 'auto',
        recommended: false
    },
    {
        name: 'MongoDB Log',
        path: '/var/log/mongodb/mongod.log',
        service: 'mongodb',
        format: 'auto',
        recommended: true
    }
];

// Stable per-path ID derived from the file path.
// Use hash(uuid + path) if uuid is injected at call time — for now path-only is fine.
function createSourceId(filePath) {
    return crypto.createHash('sha1').update(filePath).digest('hex');
}

// Returns rich metadata for a log file path.
// Never throws. Distinguishes missing vs. permission_denied vs. readable.
function getLogMeta(filePath) {
    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        if (err.code === 'ENOENT') {
            return {
                sizeBytes: 0, modifiedAt: null, ageDays: null,
                isEmpty: true, isStale: false, isRotated: false,
                readable: false,
                status: 'missing',
                reason: 'file does not exist'
            };
        }
        const isPerm = err.code === 'EACCES' || err.code === 'EPERM';
        return {
            sizeBytes: 0, modifiedAt: null, ageDays: null,
            isEmpty: true, isStale: false, isRotated: false,
            readable: false,
            status: isPerm ? 'permission_denied' : 'unknown',
            reason: isPerm
                ? 'agent does not have permission to read this file'
                : 'could not read file metadata'
        };
    }

    // File exists; verify read access separately
    let readable = false;
    try {
        fs.accessSync(filePath, fs.constants.R_OK);
        readable = true;
    } catch {
        const ageDays = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
        return {
            sizeBytes: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            ageDays,
            isEmpty: stat.size === 0,
            isStale: ageDays > STALE_DAYS,
            isRotated: ROTATED_PAT.test(filePath),
            readable: false,
            status: 'permission_denied',
            reason: 'agent does not have permission to read this file'
        };
    }

    const sizeBytes = stat.size;
    const modifiedAt = stat.mtime.toISOString();
    const ageDays = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
    const isEmpty = sizeBytes === 0;
    const isStale = ageDays > STALE_DAYS;
    const isRotated = ROTATED_PAT.test(filePath);

    let status, reason;
    if (isRotated) {
        status = 'rotated';
        reason = 'rotated or archived log file';
    } else if (isEmpty) {
        status = 'empty';
        reason = 'file is empty';
    } else if (isStale) {
        status = 'stale';
        reason = `file has not been modified in more than ${STALE_DAYS} days`;
    } else {
        status = 'detected';
        reason = 'log file detected';
    }

    return { sizeBytes, modifiedAt, ageDays, isEmpty, isStale, isRotated, readable, status, reason };
}

// A log is recommended only when it is recent, non-empty, readable, and the
// definition itself is marked recommended.
function shouldRecommend(def, meta) {
    return !!(
        def.recommended &&
        meta.readable &&
        !meta.isEmpty &&
        !meta.isStale &&
        !meta.isRotated &&
        meta.status !== 'missing' &&
        meta.status !== 'permission_denied' &&
        meta.status !== 'unknown'
    );
}

function getRecommendedReason(service) {
    return `recent non-empty ${service} log`;
}

// Central builder — discovery never auto-enables logs.
// `enabled` in overrides is intentionally stripped so callers cannot
// accidentally set it; only the user or explicit config-merge may enable.
function buildLogSource(def, filePath, meta, overrides = {}) {
    const { enabled: _drop, name: overrideName, ...safeOverrides } = overrides;
    const recommended = shouldRecommend(def, meta);

    return {
        sourceId: createSourceId(filePath),
        name: overrideName || def.name,
        path: filePath,
        service: def.service,
        format: def.format,
        detected: true,
        autoDetected: true,
        recommended,
        enabled: false,
        monitored: false,
        ignored: false,
        status: recommended ? 'recommended' : meta.status,
        reason: recommended ? getRecommendedReason(def.service) : meta.reason,
        ...meta,
        ...safeOverrides,
    };
}

function detectPm2Logs() {
    const results = [];
    const pm2LogDir = path.join(os.homedir(), '.pm2', 'logs');
    let recommendedCount = 0;

    try {
        if (!fs.existsSync(pm2LogDir)) return results;
        const files = fs.readdirSync(pm2LogDir);

        // Group files by app name, splitting error and out slots
        const byApp = {};
        for (const file of files) {
            if (!file.endsWith('.log')) continue;
            const full = path.join(pm2LogDir, file);
            const isErrorLog = file.includes('-error');
            const appName = file.replace(/-(out|error)\.log$/, '').replace(/\.log$/, '');

            if (!byApp[appName]) byApp[appName] = [];
            byApp[appName].push({ full, meta: getLogMeta(full), isErrorLog });
        }

        for (const [appName, entries] of Object.entries(byApp)) {
            // Sort: error logs first, then by recency (lower ageDays = more recent)
            entries.sort((a, b) => {
                if (a.isErrorLog !== b.isErrorLog) return a.isErrorLog ? -1 : 1;
                return (a.meta.ageDays ?? 999) - (b.meta.ageDays ?? 999);
            });

            let errorAdded = false;
            let outAdded = false;

            for (const { full, meta, isErrorLog } of entries) {
                // At most one error log and one out log per app
                if (isErrorLog && errorAdded) continue;
                if (!isErrorLog && outAdded) continue;

                const type = isErrorLog ? 'error' : 'out';
                const canRecommend = (
                    meta.readable &&
                    !meta.isEmpty &&
                    !meta.isStale &&
                    !meta.isRotated &&
                    meta.status !== 'missing' &&
                    meta.status !== 'permission_denied' &&
                    meta.status !== 'unknown'
                );

                let recommended = false;
                let reason = meta.reason;

                if (canRecommend) {
                    if (recommendedCount < MAX_RECOMMENDED_PM2_LOGS) {
                        recommended = true;
                        recommendedCount++;
                        reason = `recent non-empty PM2 ${type} log`;
                    } else {
                        reason = 'PM2 recommendation limit reached';
                    }
                }

                results.push({
                    sourceId: createSourceId(full),
                    name: `PM2: ${appName} ${type}`,
                    path: full,
                    service: 'pm2',
                    format: 'auto',
                    detected: true,
                    autoDetected: true,
                    recommended,
                    enabled: false,
                    monitored: false,
                    ignored: false,
                    status: recommended ? 'recommended' : meta.status,
                    reason,
                    ...meta,
                });

                if (isErrorLog) errorAdded = true;
                else outAdded = true;
            }
        }
    } catch {}

    return results;
}

async function detectLogs() {
    const results = [];

    for (const def of LOG_DEFINITIONS) {
        if (def.glob) {
            // globFiles() returns only existing + readable paths via fileExists(R_OK)
            const files = globFiles(def.path);
            for (const filePath of files) {
                const meta = getLogMeta(filePath);
                results.push(buildLogSource(def, filePath, meta, {
                    name: `${def.name} (${path.basename(filePath)})`
                }));
            }
        } else {
            const meta = getLogMeta(def.path);
            // Skip truly absent paths (service not installed).
            // permission_denied is included so the UI can surface it.
            if (meta.status === 'missing') continue;
            results.push(buildLogSource(def, def.path, meta));
        }
    }

    // PM2 logs — capped per app + global recommended cap
    results.push(...detectPm2Logs());

    return results;
}

module.exports = { detectLogs };
