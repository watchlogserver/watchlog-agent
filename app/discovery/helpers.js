const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

function execCmd(cmd, timeout = 5000) {
    return new Promise((resolve) => {
        exec(cmd, { timeout }, (err, stdout, stderr) => {
            if (err) return resolve(null);
            resolve(stdout.trim());
        });
    });
}

function fileExists(filePath) {
    try {
        fs.accessSync(filePath, fs.constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function globFiles(pattern) {
    // Expand simple glob patterns like /var/log/postgresql/*.log
    if (!pattern.includes('*')) {
        return fileExists(pattern) ? [pattern] : [];
    }
    const dir = path.dirname(pattern);
    const ext = path.extname(pattern);
    try {
        if (!fs.existsSync(dir)) return [];
        const files = fs.readdirSync(dir);
        return files
            .filter(f => !ext || f.endsWith(ext))
            .map(f => path.join(dir, f))
            .filter(f => fileExists(f));
    } catch {
        return [];
    }
}

// Detect runtime type from process name / command
function detectRuntime(name, cmd) {
    const n = (name || '').toLowerCase();
    const c = (cmd || '').toLowerCase();

    if (n === 'node' || n === 'nodejs' || c.includes('node ')) return 'nodejs';
    if (n === 'python' || n === 'python3' || n.startsWith('python')) return 'python';
    if (n === 'php' || n === 'php-fpm' || n.startsWith('php')) return 'php';
    if (n === 'java') return 'java';
    if (n === 'dotnet') return 'dotnet';
    if (n === 'nginx' || n === 'nginx: master process' || n.startsWith('nginx')) return 'nginx';
    if (n === 'redis-server') return 'redis';
    if (n === 'postgres' || n === 'postgresql') return 'postgresql';
    if (n === 'mysqld') return 'mysql';
    if (n === 'mongod') return 'mongodb';
    if (n === 'pm2' || n === 'pm2-runtime' || c.includes('pm2')) return 'pm2';
    if (n === 'dockerd' || n === 'docker' || c.includes('dockerd')) return 'docker';
    return null;
}

module.exports = { execCmd, fileExists, globFiles, detectRuntime };
