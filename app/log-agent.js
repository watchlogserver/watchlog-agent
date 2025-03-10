const fs = require('fs');
const chokidar = require('chokidar');
const watchlogServerSocket = require("./socketServer");

let monitorLogs = [];
const CONFIG_FILE = 'log-watchlist.json';

console.log(CONFIG_FILE);
let uniqueNames = new Set();
let logConfig = loadConfig();

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


// ** Process Each Log Line **
function processLogLine(log, config) {
    if (!log.trim()) return; // Ignore empty lines

    let logData = {
        date: new Date().toISOString(),
        message: log,
        level: "INFO",
        service: config.service,
        name: config.name
    };

    if (config.format === "custom" && config.pattern) {
        const regex = new RegExp(config.pattern);
        const match = log.match(regex);

        if (match) {
            const extractedDate = match.groups?.date;
            let parsedDate = extractedDate ? new Date(extractedDate.replace(/\//g, "-")) : new Date();

            if (isNaN(parsedDate.getTime())) {
                parsedDate = new Date(); // Fallback to current date
            }

            logData.date = parsedDate.toISOString();
            logData.level = match.groups?.level || "INFO";
            logData.message = match.groups?.message?.trim() || log; // Ensure message isn't empty

            // Avoid duplicate logs by checking recent logs
            if (recentLogs.has(logData.message)) return;
            recentLogs.add(logData.message);

            // Clean up recent logs cache after a while
            setTimeout(() => recentLogs.delete(logData.message), 5000);
        }
    } else if (config.format === "auto") {
        logData = { ...logData, ...parseAutoLogFormat(log, config.service) };
    }

    watchlogServerSocket.emit("logs/watchlist", logData);
}




let recentLogs = new Set();

function startMonitoring() {
    logConfig.logs.forEach(logEntry => {
        if (!fs.existsSync(logEntry.path)) {
            console.warn(`⚠ Warning: File ${logEntry.path} does not exist! Skipping...`);
            return;
        }

        console.log(`👀 Monitoring: ${logEntry.name} (${logEntry.path})`);
        monitorLogs.push(logEntry);

        chokidar.watch(logEntry.path, { persistent: true, ignoreInitial: true })
            .on('change', filePath => {
                fs.readFile(filePath, 'utf8', (err, data) => {
                    if (err) {
                        console.error(`Error reading file ${filePath}:`, err);
                        return;
                    }

                    const lines = data.split('\n').filter(line => line.trim() !== "");
                    lines.forEach(line => processLogLine(line, logEntry));
                });
            })
            .on('error', error => console.error(`Error watching file ${logEntry.path}:`, error));
    });
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
