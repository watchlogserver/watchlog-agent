// socketServer.js
const si = require('systeminformation');
const ioServer = require('socket.io-client');
const os = require('os');
const fs = require('fs');
const path = require('path');

const watchlog_server = process.env.WATCHLOG_SERVER;
const apiKey = process.env.WATCHLOG_APIKEY;
const configFilePath = path.resolve(process.cwd(), 'watchlog.env');

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

// 2) در یک IIFE اطلاعات را async بگیرید، auth را ست کنید و وصل شوید:
; (async function initSocket() {
    try {
        const systemInfo = await si.system();
        const systemOsfo = await si.osInfo();

        let uuid;
        if (process.env.UUID) {
            uuid = process.env.UUID;
        } else {
            if (systemOsfo.serial && systemOsfo.serial.length > 0) {
                uuid = systemOsfo.serial;
            } else if (systemInfo.uuid && systemInfo.uuid.length > 0) {
                uuid = systemInfo.uuid;
            } else {
                uuid = systemOsfo.hostname;
            }
            fs.appendFileSync(configFilePath, '\nUUID=' + uuid, 'utf8');
        }

        watchlogServerSocket.auth = {
            apiKey: apiKey,
            host: os.hostname(),
            ip: getSystemIP(),
            uuid: uuid,
            distro: systemOsfo.distro,
            release: systemOsfo.release,
            agentVersion: "0.1.1"
        };

        watchlogServerSocket.connect();
    } catch (err) {
        console.error('Failed to init socket auth:', err);
    }
})();

// ۳) لاگ خطاها
watchlogServerSocket.on('error', err => console.error('client error:', err));
watchlogServerSocket.on('connect_error', err => console.error('connect failed:', err.message));

// ۴) helper برای emit ایمن
function emitWhenConnected(event, payload) {
    if (watchlogServerSocket.connected) {
        watchlogServerSocket.emit(event, payload);
    } else {
        watchlogServerSocket.once('connect', () => {
            watchlogServerSocket.emit(event, payload);
        });
    }
}

module.exports = {
    socket: watchlogServerSocket,
    emitWhenConnected
};
