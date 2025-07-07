const { MongoClient } = require('mongodb');

// Helper to unwrap Long values
function unwrapLong(val) {
  // اگر از MongoDB driver اعداد Long برمی‌گردند:
  if (val && typeof val === 'object' && typeof val.toNumber === 'function') {
    return val.toNumber();
  }
  return val;
}

exports.getData = async function(host, port, username, password, callback) {
  // ساخت URI (شامل auth در صورت وجود)
  let authPart = '';
  if (username && password) {
    authPart = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  }
  const uri = `mongodb://${authPart}${host}:${port}/?authSource=admin`;

  const client = new MongoClient(uri, {
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 5000,
  });

  try {
    // اتصال به سرور
    await client.connect();

    // اجرای serverStatus command
    const adminDb = client.db().admin();
    const status = await adminDb.serverStatus();

    // استخراج متریک‌ها
    const metrics = {
      version: status.version,
      uptime: unwrapLong(status.uptime) || status.uptime,
      connections: unwrapLong(status.connections.current),
      availableConnections: unwrapLong(status.connections.available),
      usageMemory: unwrapLong(status.mem.resident),
      virtualMemory: unwrapLong(status.mem.virtual),
      insert: unwrapLong(status.opcounters.insert),
      query: unwrapLong(status.opcounters.query),
      update: unwrapLong(status.opcounters.update),
      delete: unwrapLong(status.opcounters.delete),
      command: unwrapLong(status.opcounters.command),
      networkIn: unwrapLong(status.network.bytesIn),
      networkOut: unwrapLong(status.network.bytesOut),
      networkRequests: unwrapLong(status.network.numRequests),
      latencyCommands: unwrapLong(status.opLatencies.commands.latency),
      latencyReads: unwrapLong(status.opLatencies.reads.latency),
      latencyWrites: unwrapLong(status.opLatencies.writes.latency),
    };

    await client.close();
    callback(metrics);

  } catch (err) {
    console.error('MongoDB monitoring error:', err);
    try { await client.close(); } catch (_) {}
    callback(null);
  }
};
