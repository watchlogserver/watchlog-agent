const si = require('systeminformation');
const os = require('os');
const fs = require('fs');
const axios = require('axios');
const https = require('https');

// Collect system metrics from the host
async function collectAndEmitSystemMetrics(watchlogServerSocket) {
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
    watchlogServerSocket.emit('serverMetricsArray', { data: allMetrics });
  } catch (err) {
    console.error('❌ Error collecting system metrics:', err);
  }
}

async function collectKubernetesMetrics(watchlogServerSocket) {
  try {
    const token = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    const ca = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
    const namespace = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'utf8');

    const httpsAgent = new https.Agent({ ca });
    const baseURL = 'https://kubernetes.default.svc';

    const headers = {
      Authorization: `Bearer ${token}`,
    };

    const [nodesRes, podsRes, nodeMetricsRes, podMetricsRes] = await Promise.all([
      axios.get(`${baseURL}/api/v1/nodes`, { httpsAgent, headers }),
      axios.get(`${baseURL}/api/v1/pods`, { httpsAgent, headers }),
      axios.get(`${baseURL}/apis/metrics.k8s.io/v1beta1/nodes`, { httpsAgent, headers }),
      axios.get(`${baseURL}/apis/metrics.k8s.io/v1beta1/pods`, { httpsAgent, headers }),
    ]);

    const nodes = nodesRes.data.items || [];
    const pods = podsRes.data.items || [];
    const nodeMetrics = nodeMetricsRes.data.items || [];
    const podMetrics = podMetricsRes.data.items || [];

    // Create a map for pod metrics for faster lookup
    const podMetricsMap = {};
    podMetrics.forEach(pod => {
      podMetricsMap[`${pod.metadata.namespace}/${pod.metadata.name}`] = pod;
    });

    // Process pods and create comprehensive pod objects
    const podObjects = pods.map(pod => {
      const podKey = `${pod.metadata.namespace}/${pod.metadata.name}`;
      const metrics = podMetricsMap[podKey] || {};
      const containers = {};

      // Process container metrics
      (metrics.containers || []).forEach(container => {
        containers[container.name] = {
          cpu: {
            usageNanoCores: parseCpu(container.usage?.cpu),
            requests: parseCpu(pod.spec.containers.find(c => c.name === container.name)?.resources?.requests?.cpu),
            limits: parseCpu(pod.spec.containers.find(c => c.name === container.name)?.resources?.limits?.cpu),
          },
          memory: {
            usageBytes: parseMemory(container.usage?.memory),
            requests: parseMemory(pod.spec.containers.find(c => c.name === container.name)?.resources?.requests?.memory),
            limits: parseMemory(pod.spec.containers.find(c => c.name === container.name)?.resources?.limits?.memory),
          }
        };
      });

      // Calculate total pod resource usage
      const totalCpu = Object.values(containers).reduce((sum, c) => sum + (c.cpu.usageNanoCores || 0), 0);
      const totalMemory = Object.values(containers).reduce((sum, c) => sum + (c.memory.usageBytes || 0), 0);

      return {
        metadata: {
          name: pod.metadata.name,
          namespace: pod.metadata.namespace,
          nodeName: pod.spec.nodeName,
          creationTimestamp: pod.metadata.creationTimestamp,
          labels: pod.metadata.labels || {},
          annotations: pod.metadata.annotations || {},
        },
        status: {
          phase: pod.status.phase,
          conditions: pod.status.conditions || [],
          startTime: pod.status.startTime,
          podIP: pod.status.podIP,
          hostIP: pod.status.hostIP,
          qosClass: pod.status.qosClass,
        },
        containers: containers,
        resources: {
          cpu: {
            totalUsageNanoCores: totalCpu,
            requests: Object.values(containers).reduce((sum, c) => sum + (c.cpu.requests || 0), 0),
            limits: Object.values(containers).reduce((sum, c) => sum + (c.cpu.limits || 0), 0),
          },
          memory: {
            totalUsageBytes: totalMemory,
            requests: Object.values(containers).reduce((sum, c) => sum + (c.memory.requests || 0), 0),
            limits: Object.values(containers).reduce((sum, c) => sum + (c.memory.limits || 0), 0),
          }
        },
        readyContainers: pod.status.containerStatuses?.filter(c => c.ready).length || 0,
        totalContainers: pod.status.containerStatuses?.length || 0,
        restarts: pod.status.containerStatuses?.reduce((sum, c) => sum + (c.restartCount || 0), 0) || 0,
        age: calculateAge(pod.metadata.creationTimestamp),
      };
    });

    // Process node metrics
    const nodeObjects = nodes.map(node => {
      const metrics = nodeMetrics.find(n => n.metadata.name === node.metadata.name) || {};
      const nodeConditions = {};

      (node.status.conditions || []).forEach(condition => {
        nodeConditions[condition.type] = {
          status: condition.status,
          lastHeartbeatTime: condition.lastHeartbeatTime,
          lastTransitionTime: condition.lastTransitionTime,
          reason: condition.reason,
          message: condition.message,
        };
      });

      return {
        metadata: {
          name: node.metadata.name,
          labels: node.metadata.labels || {},
          annotations: node.metadata.annotations || {},
          creationTimestamp: node.metadata.creationTimestamp,
        },
        status: {
          capacity: {
            cpu: parseCpu(node.status.capacity?.cpu),
            memory: parseMemory(node.status.capacity?.memory),
            pods: parseInt(node.status.capacity?.pods) || 0,
          },
          allocatable: {
            cpu: parseCpu(node.status.allocatable?.cpu),
            memory: parseMemory(node.status.allocatable?.memory),
            pods: parseInt(node.status.allocatable?.pods) || 0,
          },
          conditions: nodeConditions,
          nodeInfo: node.status.nodeInfo,
        },
        resources: {
          cpu: {
            usageNanoCores: parseCpu(metrics.usage?.cpu),
            capacity: parseCpu(node.status.capacity?.cpu),
          },
          memory: {
            usageBytes: parseMemory(metrics.usage?.memory),
            capacity: parseMemory(node.status.capacity?.memory),
          },
        },
        pods: {
          running: podObjects.filter(p => p.metadata.nodeName === node.metadata.name && p.status.phase === 'Running').length,
          total: podObjects.filter(p => p.metadata.nodeName === node.metadata.name).length,
        },
        age: calculateAge(node.metadata.creationTimestamp),
      };
    });

    const result = {
      timestamp: new Date().toISOString(),
      nodes: nodeObjects,
      pods: podObjects,
    };

    watchlogServerSocket.emit('kubernetesMetrics', result);
    console.log(`✅ Sent Kubernetes metrics: ${nodeObjects.length} nodes, ${podObjects.length} pods`);
  } catch (err) {
    console.error('❌ Error collecting Kubernetes metrics:', err.message);
  }
}

// Helper functions
function parseCpu(cpu) {
  if (!cpu) return null;
  if (cpu.endsWith('n')) return parseInt(cpu.replace('n', ''));
  if (cpu.endsWith('m')) return parseFloat(cpu.replace('m', '')) * 1000000;
  return parseFloat(cpu) * 1000000000;
}

function parseMemory(mem) {
  if (!mem) return null;
  if (mem.endsWith('Ki')) return parseInt(mem.replace('Ki', '')) * 1024;
  if (mem.endsWith('Mi')) return parseInt(mem.replace('Mi', '')) * 1024 * 1024;
  if (mem.endsWith('Gi')) return parseInt(mem.replace('Gi', '')) * 1024 * 1024 * 1024;
  return parseInt(mem);
}

function calculateAge(creationTimestamp) {
  if (!creationTimestamp) return null;
  const created = new Date(creationTimestamp);
  const now = new Date();
  const diff = now - created;
  return {
    seconds: Math.floor(diff / 1000),
    humanReadable: formatDuration(diff),
  };
}

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}



module.exports = {
  collectAndEmitSystemMetrics,
  collectKubernetesMetrics
};