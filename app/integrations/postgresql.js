const { Client } = require('pg');

exports.getData = async function (host, port, username, password, databases, callback) {
    const result = {
        globalMetrics: {},
        databases: []
    };

    // کوئری‌های کلی که یک‌بار از اولین دیتابیس اجرا می‌شن
    const globalQueries = {
        version: `SHOW server_version;`,
        uptime: `
            SELECT EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::INT
            FROM pg_postmaster_start_time();
        `,
        max_connections: `SHOW max_connections;`,
    };

    const dbQueries = {
        active_connections: `SELECT count(*) FROM pg_stat_activity WHERE state = 'active';`,
        idle_connections: `SELECT count(*) FROM pg_stat_activity WHERE state = 'idle';`,
        blocked_queries: `
            SELECT count(*) FROM pg_locks bl
            JOIN pg_stat_activity a ON bl.pid = a.pid
            WHERE NOT bl.granted;
        `,
        xact_commit: `SELECT xact_commit FROM pg_stat_database WHERE datname = current_database();`,
        xact_rollback: `SELECT xact_rollback FROM pg_stat_database WHERE datname = current_database();`,
        cache_hit_ratio: `
            SELECT ROUND(
                100 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2
            )
            FROM pg_stat_database
            WHERE datname = current_database();
        `,
        deadlocks: `SELECT deadlocks FROM pg_stat_database WHERE datname = current_database();`,
        temp_files: `SELECT temp_files FROM pg_stat_database WHERE datname = current_database();`,
        temp_bytes: `SELECT temp_bytes FROM pg_stat_database WHERE datname = current_database();`,
        blks_read: `SELECT blks_read FROM pg_stat_database WHERE datname = current_database();`,
        blks_hit: `SELECT blks_hit FROM pg_stat_database WHERE datname = current_database();`,
        tup_returned: `SELECT tup_returned FROM pg_stat_database WHERE datname = current_database();`,
        tup_fetched: `SELECT tup_fetched FROM pg_stat_database WHERE datname = current_database();`,
        tup_inserted: `SELECT tup_inserted FROM pg_stat_database WHERE datname = current_database();`,
        tup_updated: `SELECT tup_updated FROM pg_stat_database WHERE datname = current_database();`,
        tup_deleted: `SELECT tup_deleted FROM pg_stat_database WHERE datname = current_database();`,
        db_size: (db) => `SELECT pg_database_size('${db}');`,
        table_count: `SELECT count(*) FROM information_schema.tables WHERE table_schema='public';`,
        index_count: `SELECT count(*) FROM pg_indexes WHERE schemaname='public';`,
        locks: `SELECT count(*) FROM pg_locks;`,
        waiting_locks: `SELECT count(*) FROM pg_locks WHERE NOT granted;`
    };
    

    // helper برای اجرای کوئری
    const runQuery = async (client, query) => {
        try {
            const res = await client.query(query);
            const val = res.rows[0] && Object.values(res.rows[0])[0];
            return isNaN(val) ? val : parseFloat(val);
        } catch (err) {
            return null;
        }
    };

    // اجرای global metrics از اولین دیتابیس
    try {
        const firstDb = databases[0];
        const globalClient = new Client({
            user: username,
            host,
            database: firstDb,
            password,
            port
        });
        await globalClient.connect();

        for (const [key, query] of Object.entries(globalQueries)) {
            const value = await runQuery(globalClient, query);
            result.globalMetrics[key] = value;
        }

        await globalClient.end();
    } catch (e) {
        console.error("❌ Error collecting global metrics:", e.message);
    }

    // اجرای متریک‌ها برای هر دیتابیس
    for (const db of databases) {
        const dbMetrics = { db };
        let hasError = false;

        try {
            const client = new Client({
                user: username,
                host,
                database: db,
                password,
                port
            });
            await client.connect();

            for (const [key, query] of Object.entries(dbQueries)) {
                const actualQuery = typeof query === 'function' ? query(db) : query;
                const value = await runQuery(client, actualQuery);

                if (value === null) {
                    hasError = true;
                    break;
                }

                dbMetrics[key] = value;
            }

            await client.end();
        } catch (err) {
            hasError = true;
        }

        if (!hasError) {
            result.databases.push(dbMetrics);
        }
    }

    callback(result);
};
