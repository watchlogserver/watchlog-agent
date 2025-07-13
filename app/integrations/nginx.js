// NGINX Agent - Optimized for Production (like IIS Agent)
const { Tail } = require('tail');
const fs = require('fs');
const url = require('url');
const { exec } = require('child_process');
const {emitWhenConnected} = require('./../socketServer');
const integrations = require('./../../integration.json');

let logBuffer = [];
const MAX_BUFFER = 5000;
const FLUSH_INTERVAL = 10000;
const STATUS_CHECK_INTERVAL = 5000;
let nginxConfig = integrations.find(i => i.service === 'nginx');
let previousStatus = null;

const logFilePath = nginxConfig?.accessLog || '/var/log/nginx/access.log';

const logRegex = /^(\S+) - \S+ \[([^\]]+)\] "([A-Z]+) ([^ ]+) HTTP\/[^"]+" "([^"]+)" (\d{3}) \d+ "([^"]*)" "([^"]*)" ([\d.]+) ([\d.]+|-) ([\.\-]) (\S+) (\S+)$/;

function normalizeDynamicPath(path) {
    if (!path) return path
  
    return path
      // UUID استاندارد با dash
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
      // ObjectId مونگو (۲۴ کاراکتر هگز)
      .replace(/\b[0-9a-f]{24}\b/gi, ':objectId')
      // شناسه‌های ۳۲ کاراکتری هگز (مثلاً UUID بدون dash یا MD5)
      .replace(/\b[0-9a-f]{32}\b/gi, ':hash')
      // اعداد
      .replace(/\b\d+\b/g, ':id')
      // slugهایی که شامل dash هستند
      .replace(/\/[a-z0-9]*-[a-z0-9\-]*/gi, '/:slug')
  }
  
  
  
  

function processLogLine(line) {
    const match = line.match(logRegex);
    if (!match) return;
  
    const method = match[3];
    const rawUrl = match[4];
    const fullUrl = match[5];
    const status = parseInt(match[6], 10);
    const rawReferer = match[7];
    const userAgent = match[8];
    const requestTime = parseFloat(match[9]);
    const upstreamTime = match[10] !== '-' ? parseFloat(match[10]) : null;
    const sslProtocol = match[12];
    const sslCipher = match[13];
  
    let origin = 'unknown';
    let path = rawUrl;
  
    try {
      const parsedUrl = new URL(fullUrl);
      origin = parsedUrl.hostname;
      path = parsedUrl.pathname;
    } catch (e) {
      // fallback
      origin = 'invalid-url';
      path = rawUrl.split('?')[0];
    }
    const normalizedPath = normalizeDynamicPath(path);

    if (!path) return;
  
    logBuffer.push({
      method,
      path : normalizedPath,
      status,
      origin,
      userAgent,
      requestTime,
      upstreamTime,
      sslProtocol,
      sslCipher,
      raw: line
    });
  
    if (logBuffer.length >= MAX_BUFFER) flushLogBuffer();
  }
  



function flushLogBuffer() {
    if (!logBuffer.length) return;

    const stats = {};
    for (const log of logBuffer) {
        const key = log.origin;
        if (!stats[key]) stats[key] = { total: 0, ok_2xx: 0, redirects_3xx: 0, errors_4xx: 0, errors_5xx: 0 };

        stats[key].total++;
        if (log.status >= 200 && log.status < 300) stats[key].ok_2xx++;
        else if (log.status >= 300 && log.status < 400) stats[key].redirects_3xx++;
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

    emitWhenConnected('integrations/nginx.access.influx', influxPayload);
    emitWhenConnected('integrations/nginx.access.elastic', elasticPayload);
    logBuffer = [];
}

function monitorNginxStatus() {
    if (process.platform === 'linux') {
        exec('which systemctl', (err, stdout) => {
            if (!err && stdout.includes('systemctl')) {
                exec('systemctl is-active nginx', (err, stdout) => {
                    const currentStatus = stdout.trim();
                    if (previousStatus !== currentStatus) {
                        socket('integrations/nginx.status.update', {
                            timestamp: new Date().toISOString(),
                            status: currentStatus,
                            prev: previousStatus
                        });
                        previousStatus = currentStatus;
                    }
                });
            } else {
                console.log('[NGINX Agent] systemctl not available on this system');
                previousStatus = null;
            }
        });
    } else {
        console.log('[NGINX Agent] NGINX status check not supported on this OS');
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
    console.log('[NGINX Agent] Disabled or log file not found');
}
