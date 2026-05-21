const { fileExists, globFiles } = require('./helpers');
const os = require('os');
const path = require('path');
const fs = require('fs');

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

function detectPm2Logs() {
    const results = [];
    const pm2LogDir = path.join(os.homedir(), '.pm2', 'logs');
    try {
        if (!fs.existsSync(pm2LogDir)) return results;
        const files = fs.readdirSync(pm2LogDir);
        for (const file of files) {
            if (!file.endsWith('.log')) continue;
            const full = path.join(pm2LogDir, file);
            if (!fileExists(full)) continue;
            const appName = file.replace(/-(out|error)\.log$/, '').replace(/\.log$/, '');
            results.push({
                name: `PM2: ${appName}`,
                path: full,
                service: 'pm2',
                format: 'auto',
                enabled: true,
                autoDetected: true,
                recommended: true
            });
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
                results.push({
                    name: `${def.name} (${path.basename(filePath)})`,
                    path: filePath,
                    service: def.service,
                    format: def.format,
                    enabled: true,
                    autoDetected: true,
                    recommended: def.recommended
                });
            }
        } else {
            if (fileExists(def.path)) {
                results.push({
                    name: def.name,
                    path: def.path,
                    service: def.service,
                    format: def.format,
                    enabled: true,
                    autoDetected: true,
                    recommended: def.recommended
                });
            }
        }
    }

    // PM2 logs
    const pm2Logs = detectPm2Logs();
    results.push(...pm2Logs);

    return results;
}

module.exports = { detectLogs };
