const { createClient } = require('redis');

// Function to parse Redis INFO output
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

// Function to collect Redis metrics using native client
exports.getData = async function (host, port, password, callback) {
    // تنظیم گزینه‌های اتصال
    const client = createClient({
        socket: { host, port: Number(port) },
        password: password || undefined,
    });

    client.on('error', err => {
        // در صورت خطا، callback با null
        console.error('Redis Client Error', err);
        callback(null);
    });

    try {
        // اتصال به Redis
        await client.connect();

        // دریافت خروجی INFO
        const infoString = await client.sendCommand(['INFO']);
        const info = parseRedisInfo(infoString);

        // محاسبه‌ی مجموع کلیدها
        let totalKeys = 0;
        for (const db in info.keyspace) {
            totalKeys += info.keyspace[db].keys;
        }

        // ساخت آبجکت متریک‌ها
        const metrics = {
            version: info.redis_version,
            host: host,
            tcp_port: info.tcp_port,
            uptime: info.uptime_in_seconds,
            connectedClients: info.connected_clients,
            memoryUsed: info.used_memory,
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
            totalKeys: totalKeys
        };

        // قطع اتصال و فراخوانی callback
        await client.disconnect();
        callback(metrics);

    } catch (err) {
        console.error('Error fetching Redis INFO:', err);
        try { await client.disconnect(); } catch (_) { }
        callback(null);
    }
};
