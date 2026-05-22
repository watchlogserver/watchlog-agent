const { fileExists, globFiles } = require('./helpers');
const os = require('os');
const path = require('path');
const fs = require('fs');

const STALE_DAYS = 30;
const ROTATED_PAT = /\.\d+$|\.(gz|bz2|zip|old|archive)$/i;

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

// Returns size/staleness metadata for a log file path
function getLogMeta(filePath) {
    try {
        const stat = fs.statSync(filePath);
        const sizeBytes = stat.size;
        const modifiedAt = stat.mtime.toISOString();
        const ageDays = (Date.now() - stat.mtime.getTime()) / (1000 * 60 * 60 * 24);
        const isEmpty = sizeBytes === 0;
        const isStale = ageDays > STALE_DAYS;
        const isRotated = ROTATED_PAT.test(filePath);
        let status = 'detected';
        if (isRotated) status = 'rotated';
        else if (isEmpty) status = 'empty';
        else if (isStale) status = 'stale';
        return { sizeBytes, modifiedAt, isEmpty, isStale, isRotated, status };
    } catch {
        return { sizeBytes: 0, modifiedAt: null, isEmpty: true, isStale: false, isRotated: false, status: 'unknown' };
    }
}

function detectPm2Logs() {
    const results = [];
    const pm2LogDir = path.join(os.homedir(), '.pm2', 'logs');
    try {
        if (!fs.existsSync(pm2LogDir)) return results;
        const files = fs.readdirSync(pm2LogDir);

        // Group files by app name; each app gets at most 2 log files (out + error)
        const byApp = {};
        for (const file of files) {
            if (!file.endsWith('.log')) continue;
            const full = path.join(pm2LogDir, file);
            if (!fileExists(full)) continue;
            if (ROTATED_PAT.test(file)) continue;
            const appName = file.replace(/-(out|error)\.log$/, '').replace(/\.log$/, '');
            if (!byApp[appName]) byApp[appName] = [];
            byApp[appName].push({ full, appName, meta: getLogMeta(full) });
        }

        for (const [appName, logs] of Object.entries(byApp)) {
            // Prefer non-empty, non-stale; take at most 2 per app
            const good = logs.filter(l => !l.meta.isEmpty && !l.meta.isStale);
            const toAdd = (good.length > 0 ? good : logs.slice(0, 1)).slice(0, 2);
            for (const { full, meta } of toAdd) {
                const recommended = !meta.isEmpty && !meta.isStale && !meta.isRotated;
                results.push({
                    name: `PM2: ${appName}`,
                    path: full,
                    service: 'pm2',
                    format: 'auto',
                    enabled: recommended,
                    autoDetected: true,
                    recommended,
                    ...meta
                });
            }
        }
    } catch {}
    return results;
}

async function detectLogs() {
    const results = [];

    for (const def of LOG_DEFINITIONS) {
        if (def.glob) {
            const files = globFiles(def.path);
            for (const filePath of files) {
                if (ROTATED_PAT.test(filePath)) continue;
                const meta = getLogMeta(filePath);
                const recommended = def.recommended && !meta.isEmpty && !meta.isStale && !meta.isRotated;
                results.push({
                    name: `${def.name} (${path.basename(filePath)})`,
                    path: filePath,
                    service: def.service,
                    format: def.format,
                    enabled: recommended,
                    autoDetected: true,
                    recommended,
                    ...meta
                });
            }
        } else {
            if (fileExists(def.path)) {
                const meta = getLogMeta(def.path);
                const recommended = def.recommended && !meta.isEmpty && !meta.isStale && !meta.isRotated;
                results.push({
                    name: def.name,
                    path: def.path,
                    service: def.service,
                    format: def.format,
                    enabled: recommended,
                    autoDetected: true,
                    recommended,
                    ...meta
                });
            }
        }
    }

    // PM2 logs (capped per app, stale/empty filtered)
    results.push(...detectPm2Logs());

    return results;
}

module.exports = { detectLogs };
