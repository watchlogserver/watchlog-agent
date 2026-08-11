// offlineQueue.js — bounded persistent queue for unsent agent data
// Buffers: serverMetricsArray, integrations/*service, integrations/mongodb.advanced,
//          integrations/redis.advanced, dockerInfo, customMetrics
// Does NOT buffer: logs, APM spans, discovery/process snapshots, nginx/gitlab/iis

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENABLED = process.env.OFFLINE_QUEUE_ENABLED !== 'false';
const MAX_MB = Number(process.env.OFFLINE_QUEUE_MAX_MB) || 100;
const MAX_ITEMS = Number(process.env.OFFLINE_QUEUE_MAX_ITEMS) || 50000;
const MAX_AGE_HOURS = Number(process.env.OFFLINE_QUEUE_MAX_AGE_HOURS) || 24;
const BATCH_SIZE = Number(process.env.OFFLINE_QUEUE_BATCH_SIZE) || 100;
const FLUSH_INTERVAL_MS = Number(process.env.OFFLINE_QUEUE_FLUSH_INTERVAL_MS) || 5000;

const MAX_BYTES = MAX_MB * 1024 * 1024;
const MAX_AGE_MS = MAX_AGE_HOURS * 60 * 60 * 1000;

const QUEUE_DIR = path.join(__dirname, '../state/offline-queue');
const QUEUE_FILE = path.join(QUEUE_DIR, 'queue.json');
const QUEUE_TMP = path.join(QUEUE_DIR, 'queue.tmp.json');

// Priority 1 = highest importance (kept longest), 3 = lowest (evicted first)
const PRIORITY = {
    serverMetricsArray: 1,
    'integrations/mongodbservice': 2,
    'integrations/postgresqlservice': 2,
    'integrations/mysqlservice': 2,
    'integrations/redisservice': 2,
    dockerInfo: 2,
    customMetrics: 3,
    // Advanced MongoDB payloads carry per-collection and per-index arrays, so a
    // single item is orders of magnitude larger than a health sample. Priority 3
    // means a long outage evicts these before it touches core host metrics.
    'integrations/mongodb.advanced': 3,
    // Same reasoning: per-command stats and slowlog entries make this payload
    // much larger than the redis health sample it accompanies.
    'integrations/redis.advanced': 3,
};

const BUFFERABLE = new Set(Object.keys(PRIORITY));

let queue = [];
let totalBytes = 0;
let persistTimer = null;

// ── persistence ───────────────────────────────────────────────────────────────

function ensureDir() {
    if (!fs.existsSync(QUEUE_DIR)) {
        fs.mkdirSync(QUEUE_DIR, { recursive: true });
    }
}

function persistNow() {
    if (!ENABLED) return;
    try {
        ensureDir();
        fs.writeFileSync(QUEUE_TMP, JSON.stringify(queue), 'utf8');
        fs.renameSync(QUEUE_TMP, QUEUE_FILE);
    } catch (err) {
        console.error('[offline-queue] persist failed:', err.message);
    }
}

function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        persistNow();
    }, 500);
}

function loadFromDisk() {
    if (!ENABLED) return;
    ensureDir();
    try {
        if (!fs.existsSync(QUEUE_FILE)) return;
        const loaded = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
        if (!Array.isArray(loaded)) return;
        queue = loaded;
        totalBytes = queue.reduce((s, i) => s + (i.sizeBytes || 0), 0);
        console.log(`[offline-queue] Loaded ${queue.length} items (${(totalBytes / 1024).toFixed(1)} KB) from disk`);
    } catch (err) {
        console.error('[offline-queue] load failed:', err.message);
        queue = [];
        totalBytes = 0;
    }
}

function removeExpired() {
    const cutoff = Date.now() - MAX_AGE_MS;
    const before = queue.length;
    queue = queue.filter(i => new Date(i.createdAt).getTime() >= cutoff);
    if (queue.length < before) {
        totalBytes = queue.reduce((s, i) => s + (i.sizeBytes || 0), 0);
        console.log(`[offline-queue] Removed ${before - queue.length} expired items. Remaining: ${queue.length}`);
        schedulePersist();
    }
}

// ── eviction ──────────────────────────────────────────────────────────────────

function evictToFit(neededBytes) {
    let dropped = 0;
    while (queue.length > 0 && (totalBytes + neededBytes > MAX_BYTES || queue.length >= MAX_ITEMS)) {
        // Drop item with highest priority number (lowest importance); tie-break by oldest
        let worstIdx = 0;
        for (let i = 1; i < queue.length; i++) {
            const a = queue[worstIdx];
            const b = queue[i];
            if (b.priority > a.priority ||
                (b.priority === a.priority && new Date(b.createdAt) < new Date(a.createdAt))) {
                worstIdx = i;
            }
        }
        const [removed] = queue.splice(worstIdx, 1);
        totalBytes -= removed.sizeBytes || 0;
        dropped++;
    }
    if (dropped > 0) {
        console.log(`[offline-queue] Evicted ${dropped} items. Queue: ${queue.length} items / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    }
}

// ── public API ────────────────────────────────────────────────────────────────

function enqueue(event, payload) {
    if (!ENABLED) return false;
    const sizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (sizeBytes > MAX_BYTES) {
        console.log(`[offline-queue] Item too large (${(sizeBytes / 1024).toFixed(1)} KB), skipping ${event}`);
        return false;
    }
    evictToFit(sizeBytes);
    const item = {
        id: crypto.randomUUID(),
        type: event,
        payload,
        createdAt: new Date().toISOString(),
        retryCount: 0,
        sizeBytes,
        priority: PRIORITY[event] || 3,
    };
    queue.push(item);
    totalBytes += sizeBytes;
    schedulePersist();
    console.log(`[offline-queue] Queued ${event} (${(sizeBytes / 1024).toFixed(1)} KB). Queue: ${queue.length} items / ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    return true;
}

function peekBatch(size) {
    return queue.slice(0, size || BATCH_SIZE);
}

function acknowledge(ids) {
    if (!ids || ids.length === 0) return;
    const set = new Set(ids);
    const before = queue.length;
    queue = queue.filter(i => !set.has(i.id));
    totalBytes = queue.reduce((s, i) => s + (i.sizeBytes || 0), 0);
    const n = before - queue.length;
    if (n > 0) {
        console.log(`[offline-queue] Acknowledged ${n} items. Remaining: ${queue.length}`);
        schedulePersist();
    }
}

function markFailed(ids) {
    if (!ids || ids.length === 0) return;
    const set = new Set(ids);
    queue.forEach(i => { if (set.has(i.id)) i.retryCount++; });
}

function isBufferable(event) { return BUFFERABLE.has(event); }
function size() { return queue.length; }
function isEmpty() { return queue.length === 0; }

module.exports = {
    ENABLED,
    BATCH_SIZE,
    FLUSH_INTERVAL_MS,
    isBufferable,
    loadFromDisk,
    removeExpired,
    enqueue,
    peekBatch,
    acknowledge,
    markFailed,
    size,
    isEmpty,
};
