const { fileExists } = require('./helpers');

// Known service definitions: how to detect each service and what config to generate
const SERVICE_DEFINITIONS = [
    {
        service: 'nginx',
        processNames: ['nginx'],
        ports: [80, 443],
        logFiles: ['/var/log/nginx/access.log', '/var/log/nginx/error.log'],
        canAutoEnable: true,
        buildConfig: (ports, logs) => ({
            accessLog: logs.find(l => l.includes('access')) || '/var/log/nginx/access.log'
        })
    },
    {
        service: 'docker',
        processNames: ['dockerd', 'docker'],
        ports: [],
        logFiles: [],
        canAutoEnable: true,
        buildConfig: () => ({})
    },
    {
        service: 'redis',
        processNames: ['redis-server'],
        ports: [6379],
        logFiles: ['/var/log/redis/redis.log', '/var/log/redis/redis-server.log'],
        canAutoEnable: true,
        needsCredentials: false,
        buildConfig: (ports) => ({
            host: '127.0.0.1',
            port: ports.find(p => p.port === 6379)?.port || 6379
        })
    },
    {
        service: 'mysql',
        processNames: ['mysqld', 'mysql'],
        ports: [3306],
        logFiles: ['/var/log/mysql/error.log'],
        canAutoEnable: false,
        needsCredentials: true,
        buildConfig: (ports) => ({
            host: 'localhost',
            port: ports.find(p => p.port === 3306)?.port || 3306,
            username: '',
            password: '',
            database: []
        })
    },
    {
        service: 'postgresql',
        processNames: ['postgres', 'postgresql'],
        ports: [5432],
        logFiles: [],
        canAutoEnable: false,
        needsCredentials: true,
        buildConfig: (ports) => ({
            host: 'localhost',
            port: ports.find(p => p.port === 5432)?.port || 5432,
            username: '',
            password: '',
            database: []
        })
    },
    {
        service: 'mongodb',
        processNames: ['mongod'],
        ports: [27017],
        logFiles: ['/var/log/mongodb/mongod.log'],
        canAutoEnable: true,
        needsCredentials: false,
        buildConfig: (ports) => ({
            host: 'localhost',
            port: ports.find(p => p.port === 27017)?.port || 27017,
            username: '',
            password: ''
        })
    },
    {
        service: 'pm2',
        processNames: ['pm2', 'pm2-runtime'],
        ports: [],
        logFiles: [],
        canAutoEnable: true,
        buildConfig: () => ({})
    }
];

function detectServices(processes, ports, logs, docker) {
    const results = [];
    const processNames = processes.all.map(p => (p.name || '').toLowerCase());
    const openPorts = ports.map(p => p.port);
    const logPaths = logs.map(l => l.path);

    // Also include docker container service types
    const dockerServiceTypes = docker.available
        ? docker.containers.map(c => c.serviceType).filter(Boolean)
        : [];

    for (const def of SERVICE_DEFINITIONS) {
        const matchedByProcess = def.processNames.some(pn =>
            processNames.some(n => n.includes(pn))
        );
        const matchedByPort = def.ports.some(p => openPorts.includes(p));
        const matchedByLog = def.logFiles.some(lf => {
            if (lf.includes('*')) return false;
            return fileExists(lf);
        });
        const matchedByDocker = dockerServiceTypes.includes(def.service);

        const detected = matchedByProcess || matchedByPort || matchedByLog || matchedByDocker;

        if (!detected) {
            results.push({
                service: def.service,
                state: 'not_detected',
                confidence: 0,
                recommended: false,
                needsConfig: false,
                reason: 'No process, port, or log evidence found',
                ports: [],
                config: {}
            });
            continue;
        }

        // Calculate confidence score
        let confidence = 0;
        const reasons = [];
        if (matchedByProcess) { confidence += 60; reasons.push('process detected'); }
        if (matchedByPort) { confidence += 20; reasons.push('port open'); }
        if (matchedByLog) { confidence += 15; reasons.push('log files found'); }
        if (matchedByDocker) { confidence += 10; reasons.push('Docker container found'); }
        confidence = Math.min(confidence, 95);

        const servicePorts = [...new Set(
            ports
                .filter(p => def.ports.includes(p.port))
                .map(p => p.port)
        )];

        const serviceLogPaths = def.logFiles.filter(lf => fileExists(lf));
        const builtConfig = def.buildConfig(ports, serviceLogPaths);

        let state;
        let needsConfig = false;
        if (def.canAutoEnable) {
            state = 'enabled';
        } else if (def.needsCredentials) {
            state = 'detected_needs_config';
            needsConfig = true;
        } else {
            // Can be detected without credentials but still suggest detection
            state = 'detected_needs_config';
            needsConfig = false;
        }

        results.push({
            service: def.service,
            state,
            confidence,
            recommended: confidence >= 60,
            needsConfig,
            reason: reasons.join(', '),
            ports: servicePorts,
            config: builtConfig
        });
    }

    return results;
}

module.exports = { detectServices };
