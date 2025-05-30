const { exec } = require('child_process');

// Helper function to execute Redis command
function execRedisCommand(command, callback) {
    exec(command, (error, stdout, stderr) => {
        if (error || stderr) {
            callback(null);
        } else {
            callback(stdout);
        }
    });
}

// Function to parse Redis info
function parseRedisInfo(infoString) {
    const lines = infoString.split('\n');
    const info = {};
    const keyspace = {};
    
    lines.forEach(line => {
        if (line && !line.startsWith('#')) {
            const [key, value] = line.split(':');
            
            if (key.startsWith('db')) {
                // parse keyspace like db0:keys=1000,expires=50,...
                const parts = value.split(',').map(p => p.trim());
                const dbMetrics = {};
                parts.forEach(p => {
                    const [k, v] = p.split('=');
                    dbMetrics[k] = parseInt(v, 10);
                });
                keyspace[key] = dbMetrics;
            } else {
                info[key] = isNaN(value) ? value : parseFloat(value);
            }
        }
    });

    info.keyspace = keyspace;
    return info;
}

// Function to collect Redis metrics
exports.getData = function (host, port, password, callback) {
    let command = `redis-cli -h ${host} -p ${port} INFO`;

    // If a password is provided, add the -a option to the command
    if (password) {
        command = `redis-cli -h ${host} -p ${port} -a ${password} INFO`;
    }
    execRedisCommand(command, (stdout) => {
        if (stdout) {
            const info = parseRedisInfo(stdout);
            // Get total key count from all databases
            let totalKeys = 0;
            for (const db in info.keyspace) {
                totalKeys += info.keyspace[db].keys;
            }

            const metrics = {
                version: info.redis_version,
                host: host,
                tcp_port: info.tcp_port,
                uptime: info.uptime_in_seconds,
                connectedClients: info.connected_clients,
                memoryUsed: info.used_memory, // Memory used in bytes
                memoryPeak: info.used_memory_peak,
                maxmemory: info.maxmemory,
                totalConnectionsReceived: info.total_connections_received,
                totalCommandsProcessed: info.total_commands_processed,
                keyspaceHits: info.keyspace_hits,
                keyspaceMisses: info.keyspace_misses,
                expiredKeys: info.expired_keys,
                pubsubChannels: info.pubsub_channels,
                pubsubPatterns: info.pubsub_patterns,
                role: info.role,
                totalNetInputBytes: info.total_net_input_bytes,
                totalNetOutputBytes: info.total_net_output_bytes,
                totalKeys: totalKeys // Total keys across all databases
            };

            callback(metrics);
        } else {
            callback(null);
        }
    });
};


