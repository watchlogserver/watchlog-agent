const fs = require('fs');
const chokidar = require('chokidar');
const {emitWhenConnected} = require("./socketServer");
const { normalizeLogLines } = require('./normalizer/normalizeLogLines');

let monitorLogs = [];
const CONFIG_FILE = 'log-watchlist.json';

console.log(CONFIG_FILE);
let uniqueNames = new Set();
let logConfig = loadConfig();

const MAX_LINE_LENGTH = 4096;
const MAX_READ_PER_CHANGE = 64 * 1024; // 64KB
const RECENT_LOGS_MAX = 1000;
const RECENT_LOG_TTL_MS = 5000;

// Watcher registry: path → chokidar.FSWatcher
const watcherRegistry = new Map();

// File offset tracking: path → { inode, offset }
// Persists across config reloads so rotation detection keeps working
const fileOffsets = new Map();

// Bounded recent-log deduplication
let recentLogKeys = new Set();

// Normalizer state per file: path → { pendingEvent }
// Cleared on config reload so no stale partial event bleeds across restarts.
const fileNormalizerState = new Map();

function addRecentKey(key) {
    if (recentLogKeys.size >= RECENT_LOGS_MAX) {
        const toRemove = [...recentLogKeys].slice(0, Math.floor(RECENT_LOGS_MAX * 0.2));
        for (const k of toRemove) recentLogKeys.delete(k);
    }
    recentLogKeys.add(key);
    setTimeout(() => recentLogKeys.delete(key), RECENT_LOG_TTL_MS);
}

const autoPatterns = {
    nginx: /^(\S+) - - \[(.*?)\] "(.*?)" (\d+) (\d+) "(.*?)" "(.*?)"/,
    pm2: /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([A-Z]+)\] (.+)$/,
    redis: /^\d{2} \w{3} \d{2}:\d{2}:\d{2} (\w+): (.*)$/,
    mysql: /^\d{6} \s+\d{1,2}:\d{2}:\d{2} \[\w+\] (\w+): (.*)$/,
    docker: /^(\S{24}) (\S+) (\S+) (\[.*?\]) (.*)$/,
    postgresql: /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [A-Z]+) \[(\d+)\]: \[([A-Z]+)\] (.+)$/,
    mongodb: /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d+Z) (\[.*?\]) (\S+) (.*)$/,
    default: /^(.*?)\s+(\w+):\s+(.*)$/,
};

function loadConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error(`Error: ${CONFIG_FILE} not found!`);
        process.exit(1);
    }

    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        let config = JSON.parse(data);
        ensureUniqueNames(config.logs);
        validatePatterns(config.logs);
        return config;
    } catch (error) {
        console.error("Error parsing JSON config:", error);
        process.exit(1);
    }
}

function ensureUniqueNames(logs) {
    uniqueNames.clear();
    logs.forEach(log => {
        let originalName = log.name;
        let newName = originalName;
        let counter = 1;

        while (uniqueNames.has(newName)) {
            newName = `${originalName} (${counter})`;
            counter++;
        }

        log.name = newName;
        uniqueNames.add(newName);
    });
}

function validatePatterns(logs) {
    logs.forEach(log => {
        if (log.format === "custom" && log.pattern) {
            try {
                new RegExp(log.pattern);
            } catch (error) {
                console.error(`❌ Invalid pattern for ${log.name}:`, log.pattern);
                process.exit(1);
            }
        }
    });
}

// ** Detect Level Dynamically **
function detectLogLevel(message, service) {
    // Convert short levels (MongoDB: I, E, W) into readable levels
    const levelMappings = {
        "I": "INFO",
        "E": "ERROR",
        "W": "WARNING",
        "F": "FATAL",
        "D": "DEBUG",
        "C": "CRITICAL",
        "N": "NOTICE"
    };

    // Extract log level from message
    let detectedLevel = message.match(/\b(INFO|WARNING|ERROR|DEBUG|FATAL|CRITICAL|NOTICE|TRACE|VERBOSE|I|E|W|F|D|C|N)\b/i);

    if (detectedLevel) {
        let rawLevel = detectedLevel[1].toUpperCase();
        return levelMappings[rawLevel] || rawLevel; // Convert to mapped level or return as-is
    }

    return "INFO"; // Default level
}

function parseAutoLogFormat(log, service) {
    const pattern = autoPatterns[service] || autoPatterns.default;
    const match = log.match(pattern);

    if (match) {
        let extractedDate = match[1] || null;
        let parsedDate = extractedDate ? new Date(extractedDate) : new Date(); // Default to current time

        if (isNaN(parsedDate.getTime())) {
            parsedDate = new Date(); // Fallback if the extracted date is invalid
        }

        return {
            date: parsedDate.toISOString(),
            level: detectLogLevel(match[2] || match[3] || log, service), // Extract level dynamically
            message: match[3] || log
        };
    }

    return {
        date: new Date().toISOString(),
        level: "INFO",
        message: log
    };
}


// Emit a normalized event produced by the normalizer.
// Handles truncation and bounded deduplication.
function emitNormalizedEvent(event) {
    if (!event.message) return;
    const msg = event.message.length > MAX_LINE_LENGTH
        ? event.message.slice(0, MAX_LINE_LENGTH) + '…'
        : event.message;
    const dedupeKey = `${event.name}:${msg.slice(0, 100)}`;
    if (recentLogKeys.has(dedupeKey)) return;
    addRecentKey(dedupeKey);
    emitWhenConnected('logs/watchlist', { ...event, message: msg });
}

// ** Process Each Log Line (custom-format logs only) **
function processLogLine(log, config) {
    if (!log.trim()) return; // Ignore empty lines

    // Truncate lines that exceed the max length
    const truncatedLog = log.length > MAX_LINE_LENGTH ? log.slice(0, MAX_LINE_LENGTH) + '…' : log;

    let logData = {
        date: new Date().toISOString(),
        message: truncatedLog,
        level: "INFO",
        service: config.service,
        name: config.name
    };

    if (config.format === "custom" && config.pattern) {
        const regex = new RegExp(config.pattern);
        const match = truncatedLog.match(regex);

        if (match) {
            const extractedDate = match.groups?.date;
            let parsedDate = extractedDate ? new Date(extractedDate.replace(/\//g, "-")) : new Date();

            if (isNaN(parsedDate.getTime())) {
                parsedDate = new Date(); // Fallback to current date
            }

            logData.date = parsedDate.toISOString();
            logData.level = match.groups?.level || "INFO";
            logData.message = match.groups?.message?.trim() || truncatedLog; // Ensure message isn't empty
        }
    } else if (config.format === "auto") {
        logData = { ...logData, ...parseAutoLogFormat(truncatedLog, config.service) };
    }

    // Deduplicate using bounded recentLogKeys
    const dedupeKey = `${config.name}:${logData.message.slice(0, 100)}`;
    if (recentLogKeys.has(dedupeKey)) return;
    addRecentKey(dedupeKey);

    emitWhenConnected("logs/watchlist", logData);
}


function startMonitoring() {
    // Close all existing watchers before starting new ones
    for (const w of watcherRegistry.values()) {
        try { w.close(); } catch {}
    }
    watcherRegistry.clear();
    fileNormalizerState.clear();
    monitorLogs = [];

    logConfig.logs.forEach(logEntry => {
        // Skip entries explicitly disabled (auto-discovered but not yet enabled by user).
        // Entries without an `enabled` field (manually configured) are always tailed.
        if (logEntry.enabled === false) return;

        if (!fs.existsSync(logEntry.path)) {
            console.warn(`⚠ Warning: File ${logEntry.path} does not exist! Skipping...`);
            return;
        }

        console.log(`👀 Monitoring: ${logEntry.name} (${logEntry.path})`);
        monitorLogs.push(logEntry);

        // Initialize file offset to current file size on startup/reload
        // so we don't replay existing content
        if (!fileOffsets.has(logEntry.path)) {
            try {
                const initStats = fs.statSync(logEntry.path);
                fileOffsets.set(logEntry.path, { inode: initStats.ino, offset: initStats.size });
            } catch (err) {
                fileOffsets.set(logEntry.path, { inode: 0, offset: 0 });
            }
        }

        const watcher = chokidar.watch(logEntry.path, { persistent: true, ignoreInitial: true });

        watcher.on('change', filePath => {
            try {
                const stats = fs.statSync(filePath);
                if (stats.size === 0) return; // Skip empty files

                let state = fileOffsets.get(filePath);
                if (!state) {
                    state = { inode: stats.ino, offset: stats.size };
                    fileOffsets.set(filePath, state);
                    return;
                }

                // Detect file rotation: inode changed or file shrank
                if (state.inode !== stats.ino || stats.size < state.offset) {
                    state.inode = stats.ino;
                    state.offset = 0;
                }

                if (state.offset >= stats.size) return; // No new content

                const readStart = state.offset;
                const readEnd = Math.min(stats.size - 1, readStart + MAX_READ_PER_CHANGE - 1);

                const stream = fs.createReadStream(filePath, {
                    encoding: 'utf8',
                    start: readStart,
                    end: readEnd
                });

                let buffer = "";
                stream.on('data', chunk => {
                    buffer += chunk;
                });

                stream.on('end', () => {
                    // Update offset to one past the last byte we read
                    state.offset = readEnd + 1;
                    fileOffsets.set(filePath, state);

                    const lines = buffer.split('\n');

                    // If the buffer does not end with '\n', the last element is an
                    // incomplete line — skip it; it will be included in the next read
                    const completeLines = buffer.endsWith('\n') ? lines : lines.slice(0, -1);

                    if (logEntry.format === 'custom' && logEntry.pattern) {
                        // Custom regex format: use old per-line path to honour named groups
                        completeLines.forEach(line => {
                            if (line.trim()) processLogLine(line, logEntry);
                        });
                    } else {
                        // All other formats: normalizer groups multiline errors and
                        // detects level/type before emitting
                        const normState = fileNormalizerState.get(filePath) || { pendingEvent: null };
                        const { events, pendingEvent } = normalizeLogLines({
                            lines: completeLines,
                            filePath,
                            logEntry,
                            pendingEvent: normState.pendingEvent,
                        });
                        fileNormalizerState.set(filePath, { pendingEvent });
                        for (const event of events) {
                            emitNormalizedEvent(event);
                        }
                    }
                });

                stream.on('error', err => console.error(`Error reading file ${filePath}:`, err));
            } catch (error) {
                console.error(`❌ Error processing file ${filePath}:`, error);
            }
        });

        watcher.on('error', error => console.error(`❌ Error watching file ${logEntry.path}:`, error));

        // Register the watcher so it can be closed on next reload
        watcherRegistry.set(logEntry.path, watcher);
    });

    // Send monitored logs to the watchlog server after startup
    setTimeout(() => {
        if (monitorLogs.length > 0 && process.env.WATCHLOG_APIKEY && process.env.UUID) {
            emitWhenConnected("watchlist/listfile", {
                monitorLogs,
                apiKey: process.env.WATCHLOG_APIKEY,
                uuid: process.env.UUID
            });
        } else {
            // console.log(`🛑 Missing environment variables: WATCHLOG_APIKEY or UUID.`);
        }
    }, 10000);
}

// ** Start Monitoring Logs **
startMonitoring();

// ** Reload Config if `log-watchlist.json` Changes **
chokidar.watch(CONFIG_FILE, { persistent: true })
    .on('change', () => {
        console.log("🔄 Reloading config...");
        logConfig = loadConfig();
        startMonitoring();
    });
