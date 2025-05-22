// NGINX Agent - Optimized for Production (like IIS Agent)
const { Tail } = require('tail');
const fs = require('fs');
const url = require('url');
const { exec } = require('child_process');
const socket = require('./../socketServer');
const integrations = require('./../../integration.json');

let logBuffer = [];
const MAX_BUFFER = 5000;
const FLUSH_INTERVAL = 10000;
const STATUS_CHECK_INTERVAL = 5000;
let nginxConfig = integrations.find(i => i.service === 'nginx');
let previousStatus = null;

const logFilePath = nginxConfig?.accessLog || '/var/log/nginx/access.log';
const statusUrl = nginxConfig?.nginx_status_url || 'http://localhost:8080/nginx_status';

const logRegex = /^\S+ - \S+ \[[^\]]+\] "([A-Z]+) ([^ ]+) HTTP\/[^"]+" .* (\d{3}) \d+ ".*" ".*" \S+ \S+ \S+ \S+ \S+$/;

function normalizeApiPath(apiPath) {
    return apiPath.replace(/\/([0-9a-fA-F]{24}|\d+)(?=\/|$)/g, '/:id');
}

function processLogLine(line) {
    const match = line.match(logRegex);
    if (!match) return;

    const method = match[1];
    let path = normalizeApiPath(match[2]);
    const status = parseInt(match[3], 10);
    const origin = 'nginx';

    if (!path) return;

    logBuffer.push({ method, path, status, origin, raw: line });

    if (logBuffer.length >= MAX_BUFFER) flushLogBuffer();
}

function flushLogBuffer() {
    if (!logBuffer.length) return;

    const stats = {};
    for (const log of logBuffer) {
        const key = log.origin;
        if (!stats[key]) stats[key] = { total: 0, ok_2xx: 0, errors_4xx: 0, errors_5xx: 0 };

        stats[key].total++;
        if (log.status >= 200 && log.status < 300) stats[key].ok_2xx++;
        else if (log.status >= 400 && log.status < 500) stats[key].errors_4xx++;
        else if (log.status >= 500) stats[key].errors_5xx++;
    }

    const influxPayload = Object.entries(stats).map(([origin, values]) => ({
        origin,
        ...values
    }));

    const elasticPayload = logBuffer.map(log => ({
        timestamp: new Date().toISOString(),
        origin: log.origin,
        method: log.method,
        url: log.path,
        statusCode: log.status,
        raw: log.raw
    }));

    socket.emit('integrations/nginx.access.influx', influxPayload);
    socket.emit('integrations/nginx.access.elastic', elasticPayload);
    logBuffer = [];
}

function monitorNginxStatus() {
    if (process.platform === 'linux') {
        exec('which systemctl', (err, stdout) => {
            if (!err && stdout.includes('systemctl')) {
                exec('systemctl is-active nginx', (err, stdout) => {
                    const currentStatus = stdout.trim();
                    if (previousStatus !== currentStatus) {
                        socket.emit('integrations/nginx.status.update', {
                            timestamp: new Date().toISOString(),
                            status: currentStatus,
                            prev: previousStatus
                        });
                        previousStatus = currentStatus;
                    }
                });
            } else {
                console.warn('[NGINX Agent] systemctl not available on this system');
                previousStatus = null;
            }
        });
    } else {
        console.warn('[NGINX Agent] NGINX status check not supported on this OS');
        previousStatus = null;
    }
}


if (nginxConfig?.monitor && fs.existsSync(logFilePath)) {
    const tail = new Tail(logFilePath);
    tail.on('line', processLogLine);
    tail.on('error', err => console.error('[NGINX Agent] Tail error:', err.message));

    setInterval(flushLogBuffer, FLUSH_INTERVAL);
    setInterval(monitorNginxStatus, STATUS_CHECK_INTERVAL);
} else {
    console.warn('[NGINX Agent] Disabled or log file not found');
}
