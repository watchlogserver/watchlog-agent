const fs = require('fs');
const path = require('path');

const INTEGRATION_FILE = path.join(__dirname, '../../integration.json');
const LOG_WATCHLIST_FILE = path.join(__dirname, '../../log-watchlist.json');

function loadJson(filePath, defaultValue) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch {}
    return defaultValue;
}

function saveJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 4), 'utf8');
}

// Merge discovered services into integration.json without overwriting user settings
function syncIntegrations(discoveredServices) {
    let integrations = loadJson(INTEGRATION_FILE, []);
    let changed = false;

    for (const svc of discoveredServices) {
        if (svc.state === 'not_detected') continue;

        const existing = integrations.find(i => i.service === svc.service);

        if (!existing) {
            // Add new auto-detected integration (never enabled by default, just detected)
            const entry = {
                service: svc.service,
                monitor: svc.state === 'enabled' ? true : false,
                autoDetected: true,
                recommended: svc.recommended,
                state: svc.state,
                ...svc.config
            };
            integrations.push(entry);
            changed = true;
            console.log(`[discovery] Added detected service to integration.json: ${svc.service}`);
        } else {
            // Update auto-detected metadata only — never touch user credentials or monitor flag
            let updated = false;
            if (existing.autoDetected === undefined) {
                existing.autoDetected = true;
                updated = true;
            }
            if (existing.state === undefined || existing.state !== svc.state) {
                existing.state = svc.state;
                updated = true;
            }
            if (existing.recommended === undefined) {
                existing.recommended = svc.recommended;
                updated = true;
            }
            // For nginx: update accessLog path only if not set by user
            if (svc.service === 'nginx' && svc.config.accessLog && !existing.accessLog) {
                existing.accessLog = svc.config.accessLog;
                updated = true;
            }
            // Auto-enable monitoring for auto-detected services that need no credentials (state === 'enabled')
            // Only applies when monitor is still false AND the entry was auto-detected (not manually configured)
            if (existing.autoDetected && existing.monitor === false && svc.state === 'enabled') {
                existing.monitor = true;
                updated = true;
            }
            if (updated) changed = true;
        }
    }

    if (changed) {
        saveJson(INTEGRATION_FILE, integrations);
        console.log('[discovery] integration.json updated');
    }

    return integrations;
}

// Merge discovered logs into log-watchlist.json without removing user entries
function syncLogWatchlist(discoveredLogs) {
    let watchlist = loadJson(LOG_WATCHLIST_FILE, { logs: [] });
    if (!watchlist.logs) watchlist.logs = [];

    let changed = false;
    const existingPaths = new Set(watchlist.logs.map(l => l.path));

    for (const log of discoveredLogs) {
        if (!log.recommended) continue;
        if (existingPaths.has(log.path)) continue;

        watchlist.logs.push({
            name: log.name,
            path: log.path,
            service: log.service,
            format: log.format || 'auto',
            enabled: true,
            autoDetected: true,
            recommended: log.recommended
        });
        existingPaths.add(log.path);
        changed = true;
        console.log(`[discovery] Added log to log-watchlist.json: ${log.path}`);
    }

    if (changed) {
        saveJson(LOG_WATCHLIST_FILE, watchlist);
        console.log('[discovery] log-watchlist.json updated');
    }

    return watchlist;
}

function syncConfigs(discoveredServices, discoveredLogs) {
    const integrations = syncIntegrations(discoveredServices);
    const logWatchlist = syncLogWatchlist(discoveredLogs);
    return { integrations, logWatchlist };
}

module.exports = { syncConfigs, syncIntegrations, syncLogWatchlist };
