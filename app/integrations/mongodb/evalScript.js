// evalScript.js — builds the single mongosh script used by the MongoDB
// collector.
//
// Everything the advanced collector needs is gathered in ONE shell round-trip.
// Running one `mongosh --eval` per metric group would mean 1 + N(databases) +
// N(collections) process spawns per minute; on a server with 30 collections
// that is ~40 spawns/min just for monitoring. So the whole traversal happens
// inside the shell and we get a single JSON document back.
//
// WHY THE SCRIPT IS ASYNC
// mongosh's shell API is Promise-based. It auto-awaits so results *look*
// synchronous, but a rejected command does NOT get caught by a synchronous
// try/catch — it escapes as an unhandled rejection and kills the script. On a
// standalone server `replSetGetStatus` rejects with "not running with
// --replSet", which is a completely normal condition, so every shell call is
// explicitly awaited inside an async IIFE and every failure is contained.
//
// This targets mongosh only. The legacy `mongo` shell is synchronous and does
// not support this style; agents that only have `mongo` fall back to the
// original basic collector in app/integrations/mongo.js.

'use strict';

const SYSTEM_DATABASES = ['admin', 'config', 'local'];

/**
 * @param {object} opts
 * @param {number} opts.maxDatabases          cap on databases inspected
 * @param {number} opts.maxCollectionsPerDb   cap on collections per database
 * @param {number} opts.maxCollections        global cap on collection stats returned
 * @param {number} opts.maxSlowQueries        cap on profiler documents returned
 * @param {boolean} opts.includeStorage       collect db.stats()/collStats
 * @param {boolean} opts.includeIndexes       collect $indexStats
 * @param {boolean} opts.includeReplication   collect replSetGetStatus
 * @param {boolean} opts.includeSlowQueries   read system.profile (never enables the profiler)
 * @param {number} opts.slowQueryThreshold    minimum millis for a profiler doc to count
 * @param {number} opts.slowQuerySinceMs      epoch ms; only profiler docs newer than this
 * @returns {string} script source
 */
function buildScript(opts) {
    const cfg = {
        maxDatabases: opts.maxDatabases,
        maxCollectionsPerDb: opts.maxCollectionsPerDb,
        maxCollections: opts.maxCollections,
        maxSlowQueries: opts.maxSlowQueries,
        includeStorage: opts.includeStorage,
        includeIndexes: opts.includeIndexes,
        includeReplication: opts.includeReplication,
        includeSlowQueries: opts.includeSlowQueries,
        slowQueryThreshold: opts.slowQueryThreshold,
        slowQuerySinceMs: opts.slowQuerySinceMs,
        systemDatabases: SYSTEM_DATABASES
    };

    // JSON.stringify of the config is safe to inline: it contains only numbers,
    // booleans and our own literal database names.
    return `
(async function () {
  var CFG = ${JSON.stringify(cfg)};
  var OUT = { ok: true, errors: [] };

  // ── helpers ────────────────────────────────────────────────────────────────

  // Normalises every numeric shape the shell can emit into a JS number.
  function num(v) {
    if (v === null || v === undefined) return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object') {
      try { if (typeof v.toNumber === 'function') return v.toNumber(); } catch (e) {}
      if (v.$numberLong !== undefined) return parseInt(v.$numberLong, 10) || 0;
      if (v.$numberInt !== undefined) return parseInt(v.$numberInt, 10) || 0;
      if (v.$numberDouble !== undefined) return parseFloat(v.$numberDouble) || 0;
      if (v.$numberDecimal !== undefined) return parseFloat(v.$numberDecimal) || 0;
      if (v.low !== undefined && v.high !== undefined) {
        return v.high * 4294967296 + (v.low >>> 0);
      }
    }
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  function ms(v) {
    if (!v) return 0;
    try { if (v instanceof Date) return v.getTime(); } catch (e) {}
    if (typeof v === 'object') {
      if (v.$date !== undefined) {
        return typeof v.$date === 'object' ? num(v.$date.$numberLong) : new Date(v.$date).getTime();
      }
      if (typeof v.getTime === 'function') return v.getTime();
    }
    var t = new Date(v).getTime();
    return isFinite(t) ? t : 0;
  }

  function note(scope, err) {
    if (OUT.errors.length < 20) {
      OUT.errors.push({ scope: scope, message: String((err && err.message) || err) });
    }
  }

  // Every shell call goes through here. Awaiting inside the try is the whole
  // point — without it a rejected command escapes and kills the script.
  async function safe(scope, fn, fallback) {
    try { return await fn(); } catch (e) { note(scope, e); return fallback; }
  }

  function isSystemDb(name) {
    for (var i = 0; i < CFG.systemDatabases.length; i++) {
      if (CFG.systemDatabases[i] === name) return true;
    }
    return false;
  }

  function isSystemCollection(name) {
    return !name || name.indexOf('system.') === 0 || name.indexOf('__') === 0;
  }

  function emit() {
    print('__WLMONGO__' + JSON.stringify(OUT));
  }

  var admin = db.getSiblingDB('admin');

  // ── A) serverStatus ────────────────────────────────────────────────────────

  var ss = await safe('serverStatus', async function () {
    return await admin.runCommand({
      serverStatus: 1,
      // Ask only for the sections we read. Skipping the very large ones keeps
      // the response small on busy servers. Histograms are requested because
      // they are the only source MongoDB offers for a latency maximum.
      opLatencies: { histograms: true },
      tcmalloc: 0, sharding: 0, transactions: 0, oplogTruncation: 0
    });
  }, null);

  if (!ss || !ss.ok) {
    OUT.ok = false;
    emit();
    return;
  }

  var conn = ss.connections || {};
  var opc = ss.opcounters || {};
  var opcRepl = ss.opcountersRepl || {};
  var net = ss.network || {};
  var mem = ss.mem || {};
  var gl = ss.globalLock || {};
  var glQueue = gl.currentQueue || {};
  var glActive = gl.activeClients || {};
  var metrics = ss.metrics || {};
  var qe = metrics.queryExecutor || {};
  var docMetrics = metrics.document || {};
  var opMetrics = metrics.operation || {};
  var asserts = ss.asserts || {};

  OUT.server = {
    host: String(ss.host || ''),
    version: String(ss.version || ''),
    process: String(ss.process || ''),
    pid: num(ss.pid),
    uptime: num(ss.uptime),
    localTime: ms(ss.localTime) || Date.now(),

    connectionsCurrent: num(conn.current),
    connectionsAvailable: num(conn.available),
    connectionsTotalCreated: num(conn.totalCreated),
    connectionsActive: num(conn.active),

    memResident: num(mem.resident),
    memVirtual: num(mem.virtual),

    opInsert: num(opc.insert),
    opQuery: num(opc.query),
    opUpdate: num(opc.update),
    opDelete: num(opc['delete']),
    opGetmore: num(opc.getmore),
    opCommand: num(opc.command),

    replInsert: num(opcRepl.insert),
    replQuery: num(opcRepl.query),
    replUpdate: num(opcRepl.update),
    replDelete: num(opcRepl['delete']),

    networkBytesIn: num(net.bytesIn),
    networkBytesOut: num(net.bytesOut),
    networkNumRequests: num(net.numRequests),

    // Lock contention: how many operations are parked waiting for the global lock.
    queuedReaders: num(glQueue.readers),
    queuedWriters: num(glQueue.writers),
    queuedTotal: num(glQueue.total),
    activeReaders: num(glActive.readers),
    activeWriters: num(glActive.writers),
    activeTotal: num(glActive.total),

    // Index efficiency: scanned / scannedObjects vs documents returned.
    scannedKeys: num(qe.scanned),
    scannedObjects: num(qe.scannedObjects),
    docsReturned: num(docMetrics.returned),
    docsInserted: num(docMetrics.inserted),
    docsUpdated: num(docMetrics.updated),
    docsDeleted: num(docMetrics.deleted),
    scanAndOrder: num(opMetrics.scanAndOrder),

    assertsRegular: num(asserts.regular),
    assertsWarning: num(asserts.warning),
    assertsMsg: num(asserts.msg),
    assertsUser: num(asserts.user)
  };

  // ── B) operation latency ───────────────────────────────────────────────────

  var lat = ss.opLatencies || {};
  function latencyOf(section) {
    var s = lat[section] || {};
    var out = {
      latency: num(s.latency),   // microseconds, cumulative since boot
      ops: num(s.ops)            // cumulative op count since boot
    };
    // Histogram buckets are cumulative too. The agent diffs consecutive samples
    // to find the worst bucket touched during the interval.
    var hist = s.histogram;
    if (hist && hist.length) {
      var buckets = [];
      for (var h = 0; h < hist.length; h++) {
        buckets.push({ micros: num(hist[h].micros), count: num(hist[h].count) });
      }
      out.histogram = buckets;
    }
    return out;
  }

  OUT.latency = {
    reads: latencyOf('reads'),
    writes: latencyOf('writes'),
    commands: latencyOf('commands'),
    transactions: latencyOf('transactions')
  };

  // ── C) WiredTiger cache ────────────────────────────────────────────────────

  var wt = ss.wiredTiger || {};
  var wtCache = wt.cache || {};
  var wtTxn = wt.transaction || {};
  var wtConcurrent = wt.concurrentTransactions || ss.queues || {};
  var wtRead = wtConcurrent.read || {};
  var wtWrite = wtConcurrent.write || {};

  OUT.wiredTiger = {
    available: !!ss.wiredTiger,
    cacheMaxBytes: num(wtCache['maximum bytes configured']),
    cacheUsedBytes: num(wtCache['bytes currently in the cache']),
    cacheDirtyBytes: num(wtCache['tracked dirty bytes in the cache']),
    cacheReadIntoBytes: num(wtCache['bytes read into cache']),
    cacheWrittenFromBytes: num(wtCache['bytes written from cache']),
    pagesEvicted: num(wtCache['unmodified pages evicted']) + num(wtCache['modified pages evicted']),
    pagesEvictedModified: num(wtCache['modified pages evicted']),
    pagesEvictedUnmodified: num(wtCache['unmodified pages evicted']),
    pagesReadIntoCache: num(wtCache['pages read into cache']),
    pagesWrittenFromCache: num(wtCache['pages written from cache']),
    checkpointCount: num(wtTxn['transaction checkpoints']),
    // Ticket exhaustion is the clearest signal of WiredTiger-level saturation.
    readTicketsAvailable: num(wtRead.available),
    readTicketsOut: num(wtRead.out),
    writeTicketsAvailable: num(wtWrite.available),
    writeTicketsOut: num(wtWrite.out)
  };

  // ── database discovery ─────────────────────────────────────────────────────

  var dbNames = await safe('listDatabases', async function () {
    var res = await admin.runCommand({ listDatabases: 1, nameOnly: true });
    var names = [];
    var list = res.databases || [];
    for (var i = 0; i < list.length; i++) {
      if (!isSystemDb(list[i].name)) names.push(list[i].name);
    }
    return names;
  }, []);

  if (dbNames.length > CFG.maxDatabases) {
    OUT.truncatedDatabases = dbNames.length;
    dbNames = dbNames.slice(0, CFG.maxDatabases);
  }

  // ── D) database stats + E) collection stats + F) index stats ───────────────

  OUT.databases = [];
  OUT.collections = [];
  OUT.indexes = [];

  async function collStatsOf(dbHandle, collName) {
    // collStats is deprecated from 6.2 but still present; $collStats is the
    // forward-compatible path. Try the cheap command first, then the pipeline.
    var s = null;
    try {
      s = await dbHandle.runCommand({ collStats: collName, scale: 1 });
      if (!s || !s.ok) s = null;
    } catch (e) { s = null; }

    if (!s) {
      try {
        var agg = await dbHandle.getCollection(collName)
          .aggregate([{ $collStats: { storageStats: { scale: 1 } } }]).toArray();
        if (agg && agg.length && agg[0].storageStats) s = agg[0].storageStats;
      } catch (e2) { return null; }
    }
    return s;
  }

  if (CFG.includeStorage || CFG.includeIndexes) {
    for (var di = 0; di < dbNames.length; di++) {
      var dbName = dbNames[di];
      var d = db.getSiblingDB(dbName);

      if (CFG.includeStorage) {
        var st = await safe('dbStats:' + dbName, async function () { return await d.stats(); }, null);
        if (st) {
          OUT.databases.push({
            database: dbName,
            dataSize: num(st.dataSize),
            storageSize: num(st.storageSize),
            indexSize: num(st.indexSize),
            totalSize: num(st.totalSize) || (num(st.storageSize) + num(st.indexSize)),
            documents: num(st.objects),
            collections: num(st.collections),
            indexes: num(st.indexes),
            avgObjSize: num(st.avgObjSize),
            views: num(st.views)
          });
        }
      }

      // getCollectionInfos' nameOnly argument is not available on every build,
      // so fall back to getCollectionNames rather than silently reporting a
      // database as having no collections.
      var collNames = await safe('listCollections:' + dbName, async function () {
        var names = [];
        try {
          var infos = await d.getCollectionInfos({ type: 'collection' }, true);
          for (var k = 0; k < infos.length; k++) names.push(infos[k].name);
        } catch (inner) {
          names = await d.getCollectionNames();
        }
        var out = [];
        for (var n = 0; n < names.length; n++) {
          if (!isSystemCollection(names[n])) out.push(names[n]);
        }
        return out;
      }, []);

      if (collNames.length > CFG.maxCollectionsPerDb) {
        collNames = collNames.slice(0, CFG.maxCollectionsPerDb);
      }

      for (var ci = 0; ci < collNames.length; ci++) {
        var collName = collNames[ci];

        if (CFG.includeStorage) {
          var cs = await collStatsOf(d, collName);
          if (cs) {
            OUT.collections.push({
              database: dbName,
              collection: collName,
              documents: num(cs.count),
              storageSize: num(cs.storageSize),
              dataSize: num(cs.size),
              indexSize: num(cs.totalIndexSize),
              avgObjSize: num(cs.avgObjSize),
              indexCount: num(cs.nindexes),
              capped: !!cs.capped
            });
          }
        }

        if (CFG.includeIndexes) {
          // $indexStats is cheap: it reads in-memory access counters only.
          var idx = await safe('indexStats:' + dbName + '.' + collName, async function () {
            return await d.getCollection(collName).aggregate([{ $indexStats: {} }]).toArray();
          }, []);
          for (var ii = 0; ii < idx.length; ii++) {
            var entry = idx[ii];
            var acc = entry.accesses || {};
            var keyJson = '{}';
            try { keyJson = JSON.stringify(entry.key || {}); } catch (ke) {}
            OUT.indexes.push({
              database: dbName,
              collection: collName,
              index: String(entry.name || ''),
              usageCount: num(acc.ops),
              since: ms(acc.since),
              key: keyJson,
              // A non-_id index with zero ops since the last restart is a
              // deletion candidate; the dashboard needs both facts to say so.
              isId: String(entry.name || '') === '_id_'
            });
          }
        }
      }
    }

    if (OUT.collections.length > CFG.maxCollections) {
      OUT.collections.sort(function (a, b) { return b.storageSize - a.storageSize; });
      OUT.truncatedCollections = OUT.collections.length;
      OUT.collections = OUT.collections.slice(0, CFG.maxCollections);
    }
  }

  // ── G) slow queries (profiler) ─────────────────────────────────────────────
  // The profiler is NEVER enabled here. We only read what the operator has
  // already turned on; profiling status is reported so the UI can offer it.

  OUT.profiling = { enabled: false, databases: [] };
  OUT.slowQueries = [];

  if (CFG.includeSlowQueries) {
    var since = new Date(CFG.slowQuerySinceMs);

    for (var pi = 0; pi < dbNames.length; pi++) {
      var pdbName = dbNames[pi];
      var pd = db.getSiblingDB(pdbName);

      var status = await safe('profilingStatus:' + pdbName, async function () {
        return await pd.runCommand({ profile: -1 });
      }, null);

      if (!status || !status.ok) continue;

      var level = num(status.was);
      OUT.profiling.databases.push({
        database: pdbName,
        level: level,
        slowms: num(status.slowms),
        sampleRate: num(status.sampleRate)
      });
      if (level <= 0) continue;
      OUT.profiling.enabled = true;

      var docs = await safe('profileRead:' + pdbName, async function () {
        return await pd.getCollection('system.profile')
          .find({
            ts: { $gt: since },
            millis: { $gte: CFG.slowQueryThreshold }
          })
          .sort({ ts: -1 })
          .limit(CFG.maxSlowQueries)
          .toArray();
      }, []);

      for (var qi = 0; qi < docs.length; qi++) {
        var doc = docs[qi];
        var ns = String(doc.ns || '');
        var collection = ns.indexOf('.') >= 0 ? ns.slice(ns.indexOf('.') + 1) : '';
        if (isSystemCollection(collection)) continue;

        var shape = doc.command || doc.query || {};
        var shapeJson = '{}';
        // Truncated in the shell so a pathological $in never reaches the wire.
        try { shapeJson = JSON.stringify(shape).slice(0, 4000); } catch (se) {}

        OUT.slowQueries.push({
          database: pdbName,
          collection: collection,
          ns: ns,
          operation: String(doc.op || ''),
          duration: num(doc.millis),
          timestamp: ms(doc.ts),
          planSummary: String(doc.planSummary || ''),
          docsExamined: num(doc.docsExamined),
          keysExamined: num(doc.keysExamined),
          nreturned: num(doc.nreturned),
          responseLength: num(doc.responseLength),
          client: String(doc.client || ''),
          appName: String(doc.appName || ''),
          user: String(doc.user || ''),
          query: shapeJson
        });
      }
    }

    if (OUT.slowQueries.length > CFG.maxSlowQueries) {
      OUT.slowQueries.sort(function (a, b) { return b.duration - a.duration; });
      OUT.slowQueries = OUT.slowQueries.slice(0, CFG.maxSlowQueries);
    }
  }

  // ── H) replica set ─────────────────────────────────────────────────────────

  OUT.replication = { isReplicaSet: false, members: [] };

  if (CFG.includeReplication) {
    // On a standalone server this rejects with "not running with --replSet".
    // That is a normal deployment, not a fault, so it is caught directly rather
    // than through safe() — recording it as a collector error every minute
    // would bury real problems in noise.
    var rs = null;
    try {
      rs = await admin.runCommand({ replSetGetStatus: 1 });
    } catch (e) {
      var replMessage = String((e && e.message) || e);
      if (replMessage.indexOf('not running with --replSet') === -1) {
        note('replSetGetStatus', e);
      }
    }

    if (rs && rs.ok && rs.members) {
      var primaryOptime = 0;
      for (var mi = 0; mi < rs.members.length; mi++) {
        if (num(rs.members[mi].state) === 1) {
          primaryOptime = ms(rs.members[mi].optimeDate);
          break;
        }
      }

      OUT.replication.isReplicaSet = true;
      OUT.replication.setName = String(rs.set || '');
      OUT.replication.myState = num(rs.myState);

      for (var mj = 0; mj < rs.members.length; mj++) {
        var m = rs.members[mj];
        var optime = ms(m.optimeDate);
        var state = num(m.state);
        // Lag is only meaningful for data-bearing secondaries measured against
        // the primary's last applied optime.
        var lag = (primaryOptime && optime && state === 2)
          ? Math.max(0, Math.round((primaryOptime - optime) / 1000))
          : 0;

        OUT.replication.members.push({
          member: String(m.name || ''),
          memberId: num(m._id),
          state: state,
          stateStr: String(m.stateStr || ''),
          health: num(m.health),
          uptime: num(m.uptime),
          lag: lag,
          optimeDate: optime,
          electionDate: ms(m.electionDate),
          pingMs: num(m.pingMs),
          self: !!m.self,
          syncSourceHost: String(m.syncSourceHost || '')
        });
      }

      // Oplog window tells the operator how long a secondary may stay down.
      var oplog = await safe('oplogWindow', async function () {
        var local = db.getSiblingDB('local');
        var oplogColl = local.getCollection('oplog.rs');
        var first = await oplogColl.find({}, { ts: 1 }).sort({ $natural: 1 }).limit(1).toArray();
        var last = await oplogColl.find({}, { ts: 1 }).sort({ $natural: -1 }).limit(1).toArray();
        if (!first.length || !last.length) return null;
        // Timestamp BSON values expose seconds as .t (or .getTime() in ms).
        var f = first[0].ts && first[0].ts.t !== undefined ? num(first[0].ts.t) : 0;
        var l = last[0].ts && last[0].ts.t !== undefined ? num(last[0].ts.t) : 0;
        return l > f ? l - f : 0;
      }, null);
      if (oplog !== null) OUT.replication.oplogWindowSeconds = oplog;
    }
  }

  emit();
})();
`;
}

module.exports = { buildScript, SYSTEM_DATABASES };
