const { execCmd } = require('./helpers');

// Parse `ss -tulpn` output
function parseSsOutput(output) {
    if (!output) return [];
    const results = [];
    const lines = output.split('\n').slice(1); // skip header

    for (const line of lines) {
        if (!line.trim()) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;

        const proto = (cols[0] || '').toLowerCase().replace('udp', 'udp').replace('tcp', 'tcp');
        const localAddr = cols[4] || '';

        let address = '0.0.0.0';
        let port = 0;

        const lastColon = localAddr.lastIndexOf(':');
        if (lastColon !== -1) {
            address = localAddr.substring(0, lastColon) || '0.0.0.0';
            port = parseInt(localAddr.substring(lastColon + 1), 10);
        }

        if (!port || isNaN(port)) continue;

        // Extract PID from users column: users:(("nginx",pid=1234,fd=6))
        let pid = null;
        let processName = '';
        const usersCol = cols.slice(5).join(' ');
        const pidMatch = usersCol.match(/pid=(\d+)/);
        const nameMatch = usersCol.match(/"([^"]+)"/);
        if (pidMatch) pid = parseInt(pidMatch[1], 10);
        if (nameMatch) processName = nameMatch[1];

        results.push({
            pid,
            port,
            protocol: proto.startsWith('udp') ? 'udp' : 'tcp',
            address: address === '*' ? '0.0.0.0' : address,
            processName
        });
    }

    return results;
}

// Parse `lsof -i -P -n` output (fallback)
function parseLsofOutput(output) {
    if (!output) return [];
    const results = [];
    const lines = output.split('\n').slice(1);

    for (const line of lines) {
        if (!line.includes('LISTEN') && !line.includes('UDP')) continue;
        const cols = line.trim().split(/\s+/);
        if (cols.length < 9) continue;

        const processName = cols[0] || '';
        const pid = parseInt(cols[1], 10);
        const proto = (cols[7] || '').toLowerCase();
        const addrPort = cols[8] || '';

        const lastColon = addrPort.lastIndexOf(':');
        if (lastColon === -1) continue;
        const port = parseInt(addrPort.substring(lastColon + 1), 10);
        const address = addrPort.substring(0, lastColon) || '0.0.0.0';

        if (!port || isNaN(port)) continue;

        results.push({
            pid: isNaN(pid) ? null : pid,
            port,
            protocol: proto.includes('udp') ? 'udp' : 'tcp',
            address: address === '*' ? '0.0.0.0' : address,
            processName
        });
    }

    return results;
}

async function detectPorts() {
    try {
        const ssOut = await execCmd('ss -tulpn');
        if (ssOut) {
            return parseSsOutput(ssOut);
        }

        // Fallback to lsof
        const lsofOut = await execCmd('lsof -i -P -n');
        if (lsofOut) {
            return parseLsofOutput(lsofOut);
        }
    } catch (err) {
        console.error('[discovery] detectPorts error:', err.message);
    }
    return [];
}

module.exports = { detectPorts };
