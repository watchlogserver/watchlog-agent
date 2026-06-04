// socketServer.js
const si = require('systeminformation');
const ioServer = require('socket.io-client');
const os = require('os');
const fs = require('fs');
const path = require('path');

const watchlog_server = process.env.WATCHLOG_SERVER;
const apiKey = process.env.WATCHLOG_APIKEY;
const configFilePath = path.join(__dirname, './../.env');

// Helpers
function isPrivateIP(ip) {
    const parts = ip.split('.').map(Number);
    const v = (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
    return (
        (v >= (10 << 24) && v <= ((10 << 24) | 0xFFFFFF)) ||
        (v >= ((172 << 24) | (16 << 16)) && v <= ((172 << 24) | (31 << 16) | 0xFFFF)) ||
        (v >= ((192 << 24) | (168 << 16)) && v <= ((192 << 24) | (168 << 16) | 0xFFFF)) ||
        (v >= (127 << 24) && v <= ((127 << 24) | 0xFFFFFF))
    );
}

function getSystemIP() {
    const nets = os.networkInterfaces();
    for (const name in nets) {
        const addrs = nets[name];
        for (let i = 0; i < addrs.length; i++) {
            const iface = addrs[i];
            if (iface.family === 'IPv4' && !iface.internal && !isPrivateIP(iface.address)) {
                return iface.address;
            }
        }
    }
    return null;
}

// 1) ابتدا socket را بسازید، امّا نگذارید فوراً وصل شود:
const watchlogServerSocket = ioServer(watchlog_server, {
    autoConnect: false,
    reconnection: true
});

let isSuspended = false;
let suspendedReconnectTimer = null;

// 2) در یک IIFE اطلاعات را async بگیرید، auth را ست کنید و وصل شوید:
; (async function initSocket() {
    try {
        const systemInfo = await si.system();
        const systemOsfo = await si.osInfo();

        let uuid = ""
        if (!process.env.UUID) {
            if (systemOsfo.serial && systemOsfo.serial.length > 0) {
                uuid = systemOsfo.serial
            } else if (systemInfo.uuid && systemInfo.uuid.length > 0) {
                uuid = systemInfo.uuid
            } else {
                uuid = systemOsfo.hostname
            }
            fs.appendFileSync(configFilePath, `\nUUID=${uuid}`, 'utf8');


        } else {
            uuid = process.env.UUID
        }

        watchlogServerSocket.auth = {
            apiKey: apiKey,
            host: os.hostname(),
            ip: getSystemIP(),
            uuid: uuid,
            clusterNode: "standalone",
            distro: systemOsfo.distro,
            release: systemOsfo.release,
            agentVersion: "0.1.1"
        };

        watchlogServerSocket.connect();
    } catch (err) {
        console.error('Failed to init socket auth:', err);
    }
})();

// ۳) لاگ خطاها و مدیریت تعلیق حساب
watchlogServerSocket.on('error', err => console.error('client error:', err));
watchlogServerSocket.on('connect_error', err => console.error('[watchlog] connect failed:', err.message));

watchlogServerSocket.on('connect', () => {
    isSuspended = false;
    if (suspendedReconnectTimer) {
        clearTimeout(suspendedReconnectTimer);
        suspendedReconnectTimer = null;
    }
    console.log(`[watchlog] Connected to server. socketId=${watchlogServerSocket.id}`);
});

watchlogServerSocket.on('disconnect', (reason) => {
    console.log(`[watchlog] Disconnected. reason=${reason} — will reconnect automatically`);
});

watchlogServerSocket.io.on('reconnect_attempt', (attempt) => {
    console.log(`[watchlog] Reconnect attempt #${attempt}`);
});

watchlogServerSocket.io.on('reconnect', (attempt) => {
    console.log(`[watchlog] Reconnected after ${attempt} attempt(s). newSocketId=${watchlogServerSocket.id}`);
});

watchlogServerSocket.io.on('reconnect_failed', () => {
    console.error('[watchlog] All reconnect attempts failed.');
});

watchlogServerSocket.on('account_suspended', () => {
    if (!isSuspended) {
        isSuspended = true;
        console.log('[Watchlog] Account suspended due to unpaid invoices. Data ingestion is paused. Retrying in 15 minutes.');
    }
    watchlogServerSocket.disconnect();
    suspendedReconnectTimer = setTimeout(() => {
        suspendedReconnectTimer = null;
        watchlogServerSocket.connect();
    }, 15 * 60 * 1000);
});

watchlogServerSocket.on('account_active', () => {
    isSuspended = false;
    console.log('[Watchlog] Account reactivated. Data ingestion resumed.');
});

// ۴) helper برای emit ایمن (با بررسی وضعیت تعلیق)
function emitWhenConnected(event, payload) {
    if (isSuspended) return;
    if (watchlogServerSocket.connected) {
        watchlogServerSocket.emit(event, payload);
    } else {
        watchlogServerSocket.once('connect', () => {
            if (!isSuspended) {
                watchlogServerSocket.emit(event, payload);
            }
        });
    }
}

// Heartbeat: proves the host is alive independently of metric batches.
// Called every 25 seconds by the agent; server updates lastSeenAt on receipt.
function sendHeartbeat() {
    if (isSuspended) return;
    if (watchlogServerSocket.connected) {
        watchlogServerSocket.emit('heartbeat');
    }
}

module.exports = {
    socket: watchlogServerSocket,
    emitWhenConnected,
    sendHeartbeat,
};
