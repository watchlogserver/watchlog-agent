const si = require('systeminformation');
const os = require('os');
const { emitWhenConnected } = require('./socketServer');

// function to collect all metrics and emit as one payload
async function collectAndEmitMetrics() {
  try {
    // Parallel metric collection
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
        arr.push({ metric: `system.disk.${item.fs}.used`, count: item.used, tag: "disk" });
        arr.push({ metric: `system.disk.${item.fs}.size`, count: item.size, tag: "disk" });
        used += item.used;
        total = Math.max(total, item.size);
      }
      return arr;
    }, []);

    // aggregate totals
    disksMetrics.push({ metric: `system.disk.total`, count: total, tag: "disk" });
    disksMetrics.push({ metric: `system.disk.use`, count: used, tag: "disk" });
    disksMetrics.push({ metric: `system.disk.usagePercent`, count: Math.round((used / total) * 100), tag: "disk" });

    // Uptime metric
    const uptimeMetric = { metric: 'uptime', count: os.uptime(), tag: 'uptime' };

    // CPU metric
    const cpuMetric = { metric: `system.cpu.used`, count: cpuData.currentLoad.toFixed(2), tag: 'cpu' };

    // Memory metrics
    const memUsage = {
      total: memData.total,
      free: memData.free + memData.cached,
      used: memData.used - memData.cached,
      cached: memData.cached,
      buffcache: memData.buffcache
    };
    const memoryMetrics = [
      { metric: `system.memory.used`, count: memUsage.used, tag: 'memory' },
      { metric: `system.memory.free`, count: memUsage.free, tag: 'memory' },
      { metric: `system.memory.usagePercent`, count: Math.round((memUsage.used / memUsage.total) * 100), tag: 'memory' },
      { metric: `system.memory.cache`, count: memUsage.cached, tag: 'memory' },
      { metric: `system.memory.buffcache`, count: memUsage.buffcache, tag: 'memory' }
    ];

    // Network stats metrics
    const networkMetrics = networkStats.flatMap(network => [
      { metric: `network.${network.iface}.rx`, count: network.rx_bytes, tag: 'networks' },
      { metric: `network.${network.iface}.tx`, count: network.tx_bytes, tag: 'networks' }
    ]);

    // Active connections metric
    const activeConnections = networkConnections.filter(conn => conn.state === 'ESTABLISHED').length;
    const connectionMetric = { metric: 'network.activeConnections', count: activeConnections, tag: 'activeconnection' };

    // Latency metric
    const latencyMetric = { metric: 'network.latency', count: ping, tag: 'latency' };

    // Combine all metrics
    const allMetrics = [
      ...disksMetrics,
      uptimeMetric,
      cpuMetric,
      ...memoryMetrics,
      ...networkMetrics,
      connectionMetric,
      latencyMetric
    ];

    // Emit single payload
    emitWhenConnected('serverMetricsArray', { data: allMetrics });
  } catch (err) {
    console.error('Error collecting metrics:', err);
  }
}


module.exports = { collectAndEmitMetrics };
