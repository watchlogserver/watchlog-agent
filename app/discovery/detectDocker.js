const { execCmd } = require('./helpers');

const SERVICE_PATTERNS = {
    nginx: /nginx/i,
    redis: /redis/i,
    mysql: /mysql|mariadb/i,
    postgres: /postgres/i,
    mongo: /mongo/i,
    node: /node/i
};

function detectServiceFromImage(image = '', name = '') {
    const str = `${image} ${name}`.toLowerCase();
    for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
        if (pattern.test(str)) return service;
    }
    return null;
}

function parseDockerPsLine(line) {
    // docker ps --format handles the fields
    try {
        return JSON.parse(line);
    } catch {
        return null;
    }
}

async function detectDocker() {
    // Check if docker is available
    const dockerVersion = await execCmd('docker --version');
    if (!dockerVersion) {
        return { available: false, containers: [] };
    }

    try {
        const format = JSON.stringify({
            ID: '{{.ID}}',
            Name: '{{.Names}}',
            Image: '{{.Image}}',
            Status: '{{.Status}}',
            Ports: '{{.Ports}}',
            RunningFor: '{{.RunningFor}}',
            State: '{{.State}}'
        });

        const output = await execCmd(`docker ps --format '${format}'`);
        if (!output) return { available: true, containers: [] };

        const containers = [];
        for (const line of output.split('\n')) {
            if (!line.trim()) continue;
            const raw = parseDockerPsLine(line.trim());
            if (!raw) continue;

            // Parse ports: "0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp"
            const ports = [];
            if (raw.Ports) {
                const portMatches = raw.Ports.matchAll(/(\d+\.\d+\.\d+\.\d+):(\d+)->(\d+)\/(tcp|udp)/g);
                for (const m of portMatches) {
                    ports.push({ hostPort: parseInt(m[2]), containerPort: parseInt(m[3]), protocol: m[4] });
                }
            }

            // Get restart count
            let restartCount = 0;
            const inspectOut = await execCmd(`docker inspect --format '{{.RestartCount}}' ${raw.ID}`);
            if (inspectOut) restartCount = parseInt(inspectOut, 10) || 0;

            // Get health status
            let health = 'none';
            const healthOut = await execCmd(`docker inspect --format '{{.State.Health.Status}}' ${raw.ID}`);
            if (healthOut && healthOut !== '<no value>') health = healthOut;

            containers.push({
                id: raw.ID,
                name: raw.Name,
                image: raw.Image,
                status: raw.Status,
                state: raw.State,
                ports,
                restartCount,
                health,
                serviceType: detectServiceFromImage(raw.Image, raw.Name)
            });
        }

        return { available: true, containers };
    } catch (err) {
        console.error('[discovery] detectDocker error:', err.message);
        return { available: true, containers: [] };
    }
}

module.exports = { detectDocker };
