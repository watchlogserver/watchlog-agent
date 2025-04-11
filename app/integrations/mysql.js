const mysql = require('mysql2/promise');

exports.getData = async function (host, port, username, password, databases, callback) {
    const result = {
        globalMetrics: {},
        databases: []
    };

    // متریک‌های کلی (global)
    const globalQueries = {
        version: `SELECT VERSION() as version;`,
        uptime: `SHOW GLOBAL STATUS WHERE Variable_name = 'Uptime';`,
        threads_connected: `SHOW STATUS WHERE Variable_name = 'Threads_connected';`,
        max_connections: `SHOW VARIABLES WHERE Variable_name = 'max_connections';`,
        insert_queries: `SHOW GLOBAL STATUS WHERE Variable_name = 'Com_insert';`,
        update_queries: `SHOW GLOBAL STATUS WHERE Variable_name = 'Com_update';`,
        delete_queries: `SHOW GLOBAL STATUS WHERE Variable_name = 'Com_delete';`,
        select_queries: `SHOW GLOBAL STATUS WHERE Variable_name = 'Com_select';`,
        slow_queries: `SHOW GLOBAL STATUS WHERE Variable_name = 'Slow_queries';`,
        connections: `SHOW GLOBAL STATUS WHERE Variable_name = 'Connections';`,
        aborted_clients: `SHOW GLOBAL STATUS WHERE Variable_name = 'Aborted_clients';`,
        opened_tables: `SHOW GLOBAL STATUS WHERE Variable_name = 'Opened_tables';`
    };

    // فقط متریک‌های مربوط به هر دیتابیس خاص
    const dbQueries = {
        table_count: `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?;`,
        index_count: `SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = ?;`,
        db_size: `
            SELECT SUM(data_length + index_length) AS size_mb
            FROM information_schema.tables WHERE table_schema = ?;
        `
    };

    const runQuery = async (conn, query, params = []) => {
        try {
            const [rows] = await conn.execute(query, params);
            if (!rows || rows.length === 0) return null;
            const val = Object.values(rows[0])[1] || Object.values(rows[0])[0];
            return isNaN(val) ? val : parseFloat(val);
        } catch (e) {
            return null;
        }
    };

    // اجرای global metrics فقط یک‌بار
    try {
        const conn = await mysql.createConnection({
            host, port, user: username, password, database: databases[0]
        });

        for (const [key, query] of Object.entries(globalQueries)) {
            const value = await runQuery(conn, query);
            result.globalMetrics[key] = value;
        }

        await conn.end();
    } catch (e) {
        console.error("❌ Error collecting global MySQL metrics:", e.message);
    }

    // اجرای متریک‌های دیتابیس به ازای هر دیتابیس
    for (const db of databases) {
        let dbMetrics = { db };
        let hasError = false;

        try {
            const conn = await mysql.createConnection({
                host, port, user: username, password, database: db
            });

            for (const [key, query] of Object.entries(dbQueries)) {
                const value = await runQuery(conn, query, [db]);
                if (value === null) {
                    hasError = true;
                    break;
                }
                dbMetrics[key] = value;
            }

            await conn.end();
        } catch (e) {
            hasError = true;
        }

        if (!hasError) {
            result.databases.push(dbMetrics);
        }
    }

    callback(result);
};
