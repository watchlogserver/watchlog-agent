const si = require('systeminformation');
const os = require('os');
const { emitWhenConnected } = require("./socketServer");

// Collect system metrics from the host
async function collectAndEmitSystemMetrics() {
  try {
    const [
      disks,
      cpuData,
      memData,
      networkStats,
      networkConnections,
      ping
    ] = await Promise.all([
      si.fsSize(),
      si.currentLoad(),
      si.mem(),
      si.networkStats(),
      si.networkConnections(),
      si.inetLatency()
    ]);

    // Disk metrics
    let used = 0;
    let total = 0;
    const disksMetrics = disks.reduce((arr, item) => {
      if (!isNaN(Number(item.used))) {
        arr.push({ metric: `system.disk.${item.fs}.used`, count: item.used, tag: 'disk' });
        arr.push({ metric: `system.disk.${item.fs}.size`, count: item.size, tag: 'disk' });
        used += item.used;
        total = Math.max(total, item.size);
      }
      return arr;
    }, []);
    disksMetrics.push({ metric: 'system.disk.total', count: total, tag: 'disk' });
    disksMetrics.push({ metric: 'system.disk.use', count: used, tag: 'disk' });
    disksMetrics.push({ metric: 'system.disk.usagePercent', count: Math.round((used / total) * 100), tag: 'disk' });

    // Uptime & CPU
    const uptimeMetric = { metric: 'system.uptime', count: os.uptime(), tag: 'uptime' };
    const cpuMetric = { metric: 'system.cpu.used', count: parseFloat(cpuData.currentLoad.toFixed(2)), tag: 'cpu' };

    // Memory metrics
    const memUsage = {
      total: memData.total,
      free: memData.free + memData.cached,
      used: memData.used - memData.cached,
      cached: memData.cached,
      buffcache: memData.buffcache
    };
    const memoryMetrics = [
      { metric: 'system.memory.used', count: memUsage.used, tag: 'memory' },
      { metric: 'system.memory.free', count: memUsage.free, tag: 'memory' },
      { metric: 'system.memory.usagePercent', count: Math.round((memUsage.used / memUsage.total) * 100), tag: 'memory' },
      { metric: 'system.memory.cache', count: memUsage.cached, tag: 'memory' },
      { metric: 'system.memory.buffcache', count: memUsage.buffcache, tag: 'memory' }
    ];

    // Network metrics
    const networkMetrics = networkStats.flatMap(net => [
      { metric: `network.${net.iface}.rx`, count: net.rx_bytes, tag: 'network' },
      { metric: `network.${net.iface}.tx`, count: net.tx_bytes, tag: 'network' }
    ]);
    const activeConnections = networkConnections.filter(c => c.state === 'ESTABLISHED').length;
    const connectionMetric = { metric: 'network.activeConnections', count: activeConnections, tag: 'network' };
    const latencyMetric = { metric: 'network.latency', count: ping, tag: 'network' };

    const allMetrics = [
      ...disksMetrics,
      uptimeMetric,
      cpuMetric,
      ...memoryMetrics,
      ...networkMetrics,
      connectionMetric,
      latencyMetric
    ];

    console.log(`📊 Sending system metrics: ${allMetrics.length} entries`);
    emitWhenConnected('serverMetricsArray', { data: allMetrics });
  } catch (err) {
    console.error('❌ Error collecting system metrics:', err);
  }
}




module.exports = {
  collectAndEmitSystemMetrics
};