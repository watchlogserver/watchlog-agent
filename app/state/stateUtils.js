const fs = require('fs');
const path = require('path');
const os = require('os');

const RETENTION_MS = 15 * 60 * 1000;          // 15 minutes
const MAX_PROCESS_ENTRIES = 1000;
const MAX_RESTART_EVENTS = 500;
const MAX_DISCOVERY_LOGS = 100;
const MAX_COMMAND_LENGTH = 200;
const MAX_PATH_LENGTH = 300;

function truncateStr(str, maxLen) {
    if (typeof str !== 'string') return str;
    return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function readJsonSafe(filePath, defaultValue) {
    try {
        if (!fs.existsSync(filePath)) return defaultValue;
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        // Rename corrupted file so it doesn't block future writes
        try {
            fs.renameSync(filePath, filePath + '.corrupt.' + Date.now());
        } catch {}
        return defaultValue;
    }
}

function writeJsonAtomic(filePath, data) {
    const dir = path.dirname(filePath);
    const tmpPath = path.join(dir, '.' + path.basename(filePath) + '.tmp.' + process.pid);
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        fs.renameSync(tmpPath, filePath);
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch {}
    }
}

module.exports = {
    RETENTION_MS,
    MAX_PROCESS_ENTRIES,
    MAX_RESTART_EVENTS,
    MAX_DISCOVERY_LOGS,
    MAX_COMMAND_LENGTH,
    MAX_PATH_LENGTH,
    truncateStr,
    readJsonSafe,
    writeJsonAtomic,
};
