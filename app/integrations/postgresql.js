const { Client } = require('pg');
const agentQueryPatterns = [
    'max_connections',
    'server_version',
    'pg_stat_activity',
    'pg_stat_database',
    'pg_locks',
    'pg_stat_statements',
    'information_schema',
    'pg_database_size',
    'pg_indexes',
    'pg_postmaster_start_time',
    'version()'
];
const agentQueryFilters = agentQueryPatterns.map(p => `query NOT ILIKE '%${p}%'`).join(' AND ');

exports.getData = async function (host, port, username, password, databases, callback) {
    const result = {
        id: `${host}:${port}`, // شناسه منحصر به فرد برای هر integration
        host: host,
        port: port,
        globalMetrics: {},
        databases: [],
        queryStats: []
    };

    const globalQueries = {
        version: `SHOW server_version;`,
        uptime: `
            SELECT EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::INT
            FROM pg_postmaster_start_time();
        `,
        max_connections: `SHOW max_connections;`,
    };

    const dbQueries = {
        active_connections: `
        SELECT count(*) 
        FROM pg_stat_activity 
        WHERE state = 'active' 
          AND datname = current_database();
      `,
        idle_connections: `
      SELECT count(*) 
      FROM pg_stat_activity 
      WHERE state = 'idle' 
        AND datname = current_database();
    `, blocked_queries: `
    SELECT count(*) 
    FROM pg_locks bl
    JOIN pg_stat_activity a ON bl.pid = a.pid
    WHERE NOT bl.granted 
      AND a.datname = current_database();
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
        db_size: `SELECT pg_database_size(current_database());`,
        table_count: `SELECT count(*) FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = 'public' AND table_type = 'BASE TABLE';`,
        index_count: `SELECT count(*) FROM pg_indexes WHERE schemaname='public';`,
        locks: `
        SELECT count(*) 
        FROM pg_locks l
        JOIN pg_stat_activity a ON l.pid = a.pid
        WHERE a.datname = current_database();
      `,
        waiting_locks: `
      SELECT count(*) 
      FROM pg_locks l
      JOIN pg_stat_activity a ON l.pid = a.pid
      WHERE NOT l.granted 
        AND a.datname = current_database();
    `,
    };

    const runQuery = async (client, query) => {
        try {
            const res = await client.query(query);
            const val = res.rows[0] && Object.values(res.rows[0])[0];
            return isNaN(val) ? val : parseFloat(val);
        } catch {
            return null;
        }
    };

    // اجرای global metrics فقط یک بار
    try {
        const firstDb = databases[0];
        const globalClient = new Client({ user: username, host, database: firstDb, password, port });
        await globalClient.connect();

        for (const [key, query] of Object.entries(globalQueries)) {
            const value = await runQuery(globalClient, query);
            result.globalMetrics[key] = value;
        }

        await globalClient.end();
    } catch (e) {
        console.error("❌PostgresError Error collecting global metrics:", e.message);
    }

    // اجرای متریک‌ها و query stats برای هر دیتابیس
    let i = 0
    for (const db of databases) {


        const dbMetrics = { db };
        let hasError = false;

        try {
            const client = new Client({ user: username, host, database: db, password, port });
            await client.connect();

            // متریک‌ها
            for (const [key, query] of Object.entries(dbQueries)) {
                const actualQuery = typeof query === 'function' ? query(db) : query;
                const value = await runQuery(client, actualQuery);
                if (value === null) {
                    hasError = true;
                    break;
                }
                dbMetrics[key] = value;
            }


            try {
                if (i == 0) {
                    const checkColumns = await client.query(`
                        SELECT column_name FROM information_schema.columns
                        WHERE table_name = 'pg_stat_statements';
                    `);
                    const columnNames = checkColumns.rows.map(row => row.column_name);
                    const hasTotalExecTime = columnNames.includes('total_exec_time');
                    const hasMeanExecTime = columnNames.includes('mean_exec_time');
                    const totalTimeCol = hasTotalExecTime ? 'total_exec_time' : 'total_time';
                    const meanTimeCol = hasMeanExecTime ? 'mean_exec_time' : 'mean_time';

                    // گرفتن کوئری‌های فیلترشده
                    const statQuery = `
                        SELECT query, calls,
                               ROUND(${totalTimeCol}::numeric, 2) AS total_time_ms,
                               ROUND(${meanTimeCol}::numeric, 2) AS avg_time_ms,
                               rows
                        FROM pg_stat_statements
                        WHERE ${agentQueryFilters}
                          AND query NOT ILIKE '%watchlog-%'
                        ORDER BY ${totalTimeCol} DESC
                        LIMIT 10;
                    `;

                    const statRes = await client.query(statQuery);
                    result.queryStats = statRes.rows;
                }


                i++
            } catch (err) {
                // console.warn(`⚠️PostgresError Cannot load query stats for ${db}:`, err.message);
                dbMetrics.queryStats = [];
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
