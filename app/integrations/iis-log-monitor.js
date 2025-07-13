const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { exec } = require('child_process');
const integrations = require("./../../integration.json");
const {emitWhenConnected} = require('./../socketServer');

const tailBuffers = {};
const statusIndexes = {};
let iisConfig = {};
const previousStates = {}; // وضعیت قبلی هر سایت برای بررسی تغییرات

const MAX_BUFFER_SIZE = 5000;
const FLUSH_INTERVAL = 10000;
const STATE_CHECK_INTERVAL = 5000;

function normalizeDynamicPath(path) {
    if (!path) return path;
    return path
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ':uuid')
        .replace(/\b[0-9a-f]{24}\b/gi, ':objectId')
        .replace(/\b[0-9a-f]{32}\b/gi, ':hash')
        .replace(/\b\d+\b/g, ':id')
        .replace(/\/[a-z0-9]*-[a-z0-9\-]*/gi, '/:slug');
}

function handleLogLine(line, filePath, siteName) {
    if (line.startsWith('#Fields:')) {
        const fields = line.substring(8).trim().split(/\s+/);
        statusIndexes[filePath] = {
            scStatus: fields.indexOf('sc-status'),
            timeTaken: fields.indexOf('time-taken'),
            method: fields.indexOf('cs-method'),
            url: fields.indexOf('cs-uri-stem')
        };
        return;
    }

    if (line.startsWith('#')) return;

    if (!statusIndexes[filePath]) {
        if (iisConfig.fieldIndexes) {
            statusIndexes[filePath] = {
                scStatus: iisConfig.fieldIndexes['sc-status'],
                timeTaken: iisConfig.fieldIndexes['time-taken'],
                method: iisConfig.fieldIndexes['cs-method'],
                url: iisConfig.fieldIndexes['cs-uri-stem']
            };
        } else {
            console.warn(`[IIS Agent] No #Fields found and no config for ${filePath}. Skipping line.`);
            return;
        }
    }

    const { scStatus, timeTaken, method, url } = statusIndexes[filePath];
    const parts = line.trim().split(/\s+/);

    if (parts.length <= Math.max(scStatus, method, url)) return;

    const statusCode = parseInt(parts[scStatus]);
    const duration = timeTaken !== -1 ? parseInt(parts[timeTaken]) : 0;
    const methodVal = (method !== -1 && method < parts.length) ? parts[method] : 'UNKNOWN';
    const urlVal = (url !== -1 && url < parts.length) ? parts[url] : '/';

    if (!isNaN(statusCode)) {
        if (!tailBuffers[siteName]) tailBuffers[siteName] = [];
        tailBuffers[siteName].push({
            statusCode,
            duration,
            method: methodVal,
            url: urlVal,
            rawLine: line.trim()
        });

        if (tailBuffers[siteName].length >= MAX_BUFFER_SIZE) {
            flushTailBufferForSite(siteName);
        }
    }
}

function tailFile(filePath, siteName) {
    const fileSize = fs.statSync(filePath).size;
    const rl = readline.createInterface({
        input: fs.createReadStream(filePath, { encoding: 'utf8', start: fileSize })
    });

    rl.on('line', (line) => handleLogLine(line, filePath, siteName));

    fs.watchFile(filePath, { interval: 1000 }, (curr, prev) => {
        if (curr.size > prev.size) {
            const stream = fs.createReadStream(filePath, {
                encoding: 'utf8',
                start: prev.size,
                end: curr.size
            });
            const newRl = readline.createInterface({ input: stream });
            newRl.on('line', (line) => handleLogLine(line, filePath, siteName));
        }
    });
}

function setupTailForAllLogs() {
    const sites = iisConfig.sites || [];

    for (const site of sites) {
        const { name, logPath } = site;
        if (!fs.existsSync(logPath)) {
            console.warn(`[IIS Agent] Log path not found for ${name}: ${logPath}`);
            continue;
        }

        const logFiles = fs.readdirSync(logPath)
            .filter(f => f.endsWith('.log'))
            .map(f => ({
                file: f,
                time: fs.statSync(path.join(logPath, f)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (!logFiles.length) {
            console.warn(`[IIS Agent] No log files found for ${name} in ${logPath}`);
            continue;
        }

        const latestLogPath = path.join(logPath, logFiles[0].file);
        console.log(`[IIS Agent] Tailing latest log for ${name}: ${latestLogPath}`);
        tailFile(latestLogPath, name);
    }
}

function checkWebsiteStatesManual() {
    return new Promise((resolve) => {
        exec('powershell -Command "Get-Website | Select-Object Name, State | ConvertTo-Json"', (err, stdout) => {
            if (err || !stdout) return resolve([]);
            try {
                const parsed = JSON.parse(stdout.trim());
                const list = Array.isArray(parsed) ? parsed : [parsed];

                const cleaned = list
                    .filter(site => site && (site.name || site.Name))
                    .map(site => ({
                        name: site.name || site.Name,
                        state: site.state || site.State
                    }));

                resolve(cleaned);
            } catch (e) {
                console.warn('[IIS Agent] Failed to parse website states:', e.message);
                resolve([]);
            }
        });
    });
}

async function monitorSiteStates() {
    const iisSites = iisConfig.sites || [];
    const liveStates = await checkWebsiteStatesManual();

    const matchedStates = iisSites.map(cfg => {
        const match = liveStates.find(l => l.name.toLowerCase() === cfg.name.toLowerCase());
        return {
            name: cfg.name,
            state: match?.state || 'unknown'
        };
    });

    for (const site of matchedStates) {
        const lastState = previousStates[site.name];
        const shouldSend = !lastState || lastState !== site.state;

        if (shouldSend) {
            emitWhenConnected('iis/site-status-update', {
                name: site.name,
                oldState: lastState || null,
                newState: site.state,
                timestamp: new Date().toISOString()
            });
        }

        previousStates[site.name] = site.state;
    }

    emitWhenConnected('iis/site-status-snapshot', {
        sites: matchedStates,
        timestamp: new Date().toISOString()
    });
}

function flushTailBufferForSite(siteName) {
    const logs = tailBuffers[siteName];
    if (!logs || !logs.length) return;

    let total = 0, ok_2xx = 0, redirects_3xx = 0, errors_4xx = 0, errors_5xx = 0, totalDuration = 0;
    const influxPayload = [];
    const elasticPayload = [];

    for (const log of logs) {
        total++;
        if (log.statusCode >= 200 && log.statusCode < 300) ok_2xx++;
        else if (log.statusCode >= 300 && log.statusCode < 400) redirects_3xx++;
        else if (log.statusCode >= 400 && log.statusCode < 500) errors_4xx++;
        else if (log.statusCode >= 500) errors_5xx++;
        totalDuration += log.duration || 0;
        const normalizedUrl = normalizeDynamicPath(log.url);

        elasticPayload.push({
            timestamp: new Date().toISOString(),
            origin: siteName,
            statusCode: log.statusCode,
            duration: log.duration,
            method: log.method,
            url: normalizedUrl,
            raw: log.rawLine || ''
        });
    }

    influxPayload.push({
        origin: siteName,
        total,
        ok_2xx,
        redirects_3xx,
        errors_4xx,
        errors_5xx,
        avgResponseTimeMs: total ? Math.round(totalDuration / total) : 0
    });

    emitWhenConnected('integrations/iis.access.influx', influxPayload);
    emitWhenConnected('integrations/iis.access.elastic', elasticPayload);

    tailBuffers[siteName] = [];
}

function flushAllSites() {
    for (const site of Object.keys(tailBuffers)) {
        flushTailBufferForSite(site);
    }
}


try {
    const iisConfigIntegration = integrations.find(item => item.service === 'iis');
    if (iisConfigIntegration && iisConfigIntegration.monitor) {
        iisConfig = iisConfigIntegration;
        setupTailForAllLogs();
        setInterval(flushAllSites, FLUSH_INTERVAL);
        setInterval(monitorSiteStates, STATE_CHECK_INTERVAL);
    }
} catch (err) {
    console.warn('[IIS Agent] integration.json not found or invalid:', err.message);
}
