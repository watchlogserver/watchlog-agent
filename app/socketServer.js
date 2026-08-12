// socketServer.js
const si = require('systeminformation');
const ioServer = require('socket.io-client');
const os = require('os');
const fs = require('fs');
const path = require('path');
const offlineQueue = require('./offlineQueue');

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
let flushTimer = null;

// Load persisted queue at startup; expired items removed before any flush
offlineQueue.loadFromDisk();
offlineQueue.removeExpired();

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
    if (offlineQueue.ENABLED && !offlineQueue.isEmpty()) {
        console.log(`[offline-queue] Connection established. Scheduling flush of ${offlineQueue.size()} queued items`);
        scheduleFlush();
    }
});

watchlogServerSocket.on('disconnect', (reason) => {
    console.log(`[watchlog] Disconnected. reason=${reason} — will reconnect automatically`);
    cancelFlush();
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

// ── on-demand commands from the Watchlog server ───────────────────────────────
//
// Some diagnostics are far too expensive to run on a timer — Elasticsearch hot
// threads samples every thread on every node — so the dashboard asks for them
// when the operator presses the button. The server routes the request to this
// agent's socket, the registered handler runs it, and the answer comes back on
// the normal event channel.
//
// A command may only *read*. Handlers are registered by integration code, and
// nothing in this file can be talked into running a shell or writing a file:
// an unknown command name is answered with an error, never executed.

const commandHandlers = new Map();

function registerCommandHandler(name, handler) {
    commandHandlers.set(String(name), handler);
}

watchlogServerSocket.on('agent:command', async (message) => {
    const request = message || {};
    const requestId = String(request.requestId || '');
    const command = String(request.command || '');

    const respond = (payload) => {
        if (isSuspended || !watchlogServerSocket.connected) return;
        watchlogServerSocket.emit('agent:command.result', Object.assign({
            requestId,
            command,
            completedAt: new Date().toISOString()
        }, payload));
    };

    const handler = commandHandlers.get(command);
    if (!handler) {
        respond({ ok: false, error: `unsupported command: ${command.slice(0, 64)}` });
        return;
    }

    try {
        const result = await handler(request.params || {});
        respond({ ok: true, result });
    } catch (err) {
        // Handler errors are already credential-free by construction; truncated
        // anyway so a stack trace never travels as a "result".
        respond({ ok: false, error: String(err && err.message || err).slice(0, 300) });
    }
});

// ۴) helper برای emit ایمن (با بررسی وضعیت تعلیق)
function emitWhenConnected(event, payload) {
    if (isSuspended) return;
    if (watchlogServerSocket.connected) {
        watchlogServerSocket.emit(event, payload);
    } else if (offlineQueue.ENABLED && offlineQueue.isBufferable(event)) {
        // Persist bufferable data locally; flush loop will send it after reconnect
        offlineQueue.enqueue(event, payload);
    } else {
        // Non-bufferable events: fire once on next reconnect (best-effort, no persistence)
        watchlogServerSocket.once('connect', () => {
            if (!isSuspended) {
                watchlogServerSocket.emit(event, payload);
            }
        });
    }
}

// ── offline queue flush loop ───────────────────────────────────────────────────

async function flushOnce() {
    if (!offlineQueue.ENABLED || offlineQueue.isEmpty() || isSuspended || !watchlogServerSocket.connected) return;

    const batch = offlineQueue.peekBatch();
    if (batch.length === 0) return;

    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    console.log(`[offline-queue] Flushing batch of ${batch.length} items (batchId=${batchId})`);

    await new Promise((resolve) => {
        const timeout = setTimeout(() => {
            console.log(`[offline-queue] Batch ${batchId} timed out — marking failed`);
            offlineQueue.markFailed(batch.map(i => i.id));
            resolve();
        }, 30000);

        watchlogServerSocket.emit('agent:queued_batch', { batchId, items: batch }, (ack) => {
            clearTimeout(timeout);
            if (!ack) {
                offlineQueue.markFailed(batch.map(i => i.id));
            } else {
                if (ack.acknowledgedIds && ack.acknowledgedIds.length > 0) {
                    offlineQueue.acknowledge(ack.acknowledgedIds);
                }
                if (ack.failedIds && ack.failedIds.length > 0) {
                    offlineQueue.markFailed(ack.failedIds);
                }
                if (ack.retryAfterMs) {
                    console.log(`[offline-queue] Server requested retry after ${ack.retryAfterMs}ms`);
                }
            }
            resolve();
        });
    });
}

function scheduleFlush() {
    if (flushTimer || !offlineQueue.ENABLED) return;
    flushTimer = setTimeout(async () => {
        flushTimer = null;
        await flushOnce();
        if (!offlineQueue.isEmpty() && watchlogServerSocket.connected && !isSuspended) {
            scheduleFlush();
        }
    }, offlineQueue.FLUSH_INTERVAL_MS);
}

function cancelFlush() {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
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
    registerCommandHandler,
};
