const port = 3774
const { emitWhenConnected, sendHeartbeat } = require('./socketServer');

const express = require('express')
const app = express()
const exec = require('child_process').exec;
const path = require('path')
const configFilePath = path.join(__dirname, './../.env');
const integrations = require("./../integration.json")
const dockerIntegration = require('./integrations/docker')
const mongoIntegration = require('./integrations/mongo')
const mongodbCollector = require('./integrations/mongodb/index')
const redisIntegration = require('./integrations/redis')
const redisCollector = require('./integrations/redis/index')
const nginxIntegration = require('./integrations/nginx')
const gitlabIntegration = require('./integrations/gitlab/index')
const postgresIntegration = require('./integrations/postgresql');
const postgresCollector = require('./integrations/postgresql/index');
const mysqlIntegration = require('./integrations/mysql');
const mysqlCollector = require('./integrations/mysql/index');
const { collectAndEmitMetrics } = require('./collectAndEmitMetrics');
const { runDiscovery, collectProcessSnapshot } = require('./discovery/index');
const zlib = require('zlib');

const logagent = require('./log-agent')
let customMetrics = []

module.exports = class Application {
    constructor() {
        this.startApp()
    }
    async startApp() {
        this.runAgent()
        this.startDiscovery()
    }

    async startDiscovery() {
        // Run initial full discovery after a short delay so socket can connect first
        setTimeout(async () => {
            try {
                const snapshot = await runDiscovery({ syncConfig: true });
                this.emitDiscoverySnapshot(snapshot);
            } catch (err) {
                console.error('[discovery] Initial scan failed:', err.message);
            }
        }, 10000);

        // Periodic process snapshot every 60 seconds
        setInterval(async () => {
            try {
                const procSnapshot = await collectProcessSnapshot();
                emitWhenConnected('process_snapshot', {
                    apiKey: process.env.WATCHLOG_APIKEY,
                    uuid: process.env.UUID,
                    type: 'process_snapshot',
                    ...procSnapshot
                });
            } catch (err) {
                console.error('[discovery] Process snapshot error:', err.message);
            }
        }, 60000);
    }

    emitDiscoverySnapshot(snapshot) {
        emitWhenConnected('discovery_snapshot', {
            apiKey: process.env.WATCHLOG_APIKEY,
            uuid: process.env.UUID,
            type: 'discovery_snapshot',
            runtime: snapshot.runtime,
            scannedAt: snapshot.scannedAt,
            services: snapshot.services,
            logs: snapshot.logs,
            processes: {
                topCpu: snapshot.processes.topCpu,
                topMemory: snapshot.processes.topMemory,
                restarts: snapshot.processes.restartWarnings || [],
                restartWarnings: snapshot.processes.restartWarnings || [],
                restartEvents: snapshot.processes.restartEvents || [],
                total: snapshot.processes.total
            },
            ports: snapshot.ports,
            docker: snapshot.docker
        });
    }

    runAgent() {
        app.disable('x-powered-by');
      
        // 1) بدنه‌های حجیم و احتمال gzip: اول raw برای مسیرهای APM + AI tracer
        const RAW_LIMIT = '25mb';
        app.use(['/apm', '/apm/', '/apm/:app', '/apm/:app/metrics', '/apm/:app/v1/traces', '/apm/:app/v1/metrics'],
          express.raw({ type: () => true, limit: RAW_LIMIT })
        );
        app.use('/ai-tracer',
          express.raw({ type: () => true, limit: RAW_LIMIT })
        );
      
        // 2) پارسرهای عمومی برای بقیه مسیرها (بعد از raw)
        app.use(express.json({ limit: '5mb' }));
        app.use(express.urlencoded({ extended: true, limit: '5mb' }));
      
        // 3) روترها
        this.getRouter();
      
        // 4) هندلر خطای body-parser (جلوگیری از کرش و لاگ شفاف)
        app.use((err, req, res, next) => {
          if (err && (err.type === 'entity.too.large' || err.status === 413 || err.statusCode === 413)) {
            const limit = req.originalUrl.startsWith('/apm') || req.originalUrl.startsWith('/ai-tracer') ? RAW_LIMIT : '5mb';
            return res.status(413).json({ error: 'Payload too large', limit });
          }
          next(err);
        });
      
        // 5) fallback error handler
        app.use((err, req, res, next) => {
          console.error('Unhandled error:', err);
          res.status(500).json({ error: 'Internal server error' });
        });
      
        // 6) حالا گوش کن (بعد از آماده شدن همه چیز)
        app.listen(port, '0.0.0.0', () => console.log(`Watchlog api agent is running on port ${port}`));
      
        // 7) تایمرها
        setInterval(this.collectMetrics, 60000);
        setInterval(() => collectAndEmitMetrics(), 60000);
        // Heartbeat: keeps lastSeenAt fresh so checkHostStatus never flips this host offline
        // while it is actively connected. Interval is shorter than the 120s offline threshold.
        setInterval(sendHeartbeat, 25000);
      }
      

    getRouter() {

        app.post('/apm/:app/v1/traces', (req, res) => {

            try {
                let payload;
                if (Buffer.isBuffer(req.body)) {
                    let buffer = req.body;
                    if (req.headers['content-encoding'] === 'gzip') {
                        buffer = zlib.gunzipSync(buffer);
                    }
                    const ct = req.headers['content-type'] || '';
                    if (ct.includes('application/json')) {
                        payload = JSON.parse(buffer.toString('utf8'));
                    } else {
                        // Protobuf or other binary
                        payload = buffer;
                    }
                } else {
                    // Already parsed by middleware or fallback
                    payload = req.body;
                }
                  emitWhenConnected('apm:spans', {payload, app: req.params.app});
                res.sendStatus(200);
            } catch (err) {
                console.error('❌ Error processing /apm:', err);
                res.sendStatus(500);
            }
        });

        // 6. Handle incoming metrics
        app.post('/apm/:app/metrics', (req, res) => {
            try {
                console.log("yyy")

                let buffer = req.body;
                if (req.headers['content-encoding'] === 'gzip') {
                    buffer = zlib.gunzipSync(buffer);
                }
                const payload = JSON.parse(buffer.toString('utf8'));
                console.log(payload)
                // Forward metrics under event 'apm:metrics'
                  emitWhenConnected('apm:metrics', payload);
                res.sendStatus(200);
            } catch (err) {
                console.error('Error processing /apm/metrics:', err);
                res.sendStatus(500);
            }
        });
        app.post('/apm/:app/v1/metrics', (req, res) => {
            try {
                let buffer = req.body;
                if (req.headers['content-encoding'] === 'gzip') {
                    buffer = zlib.gunzipSync(buffer);
                }
                const payload = JSON.parse(buffer.toString('utf8'));
                console.log(payload)
                // Forward metrics under event 'apm:metrics'
                  emitWhenConnected('apm:metrics', {payload, app: req.params.app});
                res.sendStatus(200);
            } catch (err) {
                console.error('Error processing /apm/metrics:', err);
                res.sendStatus(500);
            }
        });
        app.get("/", async (req, res) => {
            res.end()

            try {
                let body = req.query
                if (!body.count && body.value) {
                    body.count = body.value
                }

                body.count = Number(body.count)

                if (customMetrics.length < 1000) {

                    switch (body.method) {
                        case 'increment':
                            if (body.metric && body.count) {

                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'increment',
                                        metric_type: 1
                                    })
                                }
                            }
                            break;
                        case 'decrement':
                            if (body.metric && body.count) {
                                body.count = body.count > 0 ? body.count * -1 : body.count

                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'decrement',
                                        metric_type: 1

                                    })
                                }
                            }
                            break;
                        case 'distribution':
                            if (body.metric && body.count) {
                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum = body.count
                                        customMetrics[item].min = body.count
                                        customMetrics[item].max = body.count
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'distribution',
                                        metric_type: 2
                                    })
                                }
                            }
                            break;
                        case 'gauge':
                            if (body.metric && body.count) {
                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'gauge',
                                        metric_type: 3
                                    })
                                }
                            }
                            break;
                        case 'percentage':
                            if (body.metric && body.count && body.count >= 0 && body.count <= 100) {

                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'percentage',
                                        metric_type: 4
                                    })
                                }
                            }
                            break;
                        case 'systembyte':
                            if (body.metric && body.count) {
                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'systembyte',
                                        metric_type: 5
                                    })
                                }

                            }
                            break;
                        case 'log':
                            if (body.service && body.message) {
                            }
                            break;
                        default:
                            null
                        // code block
                    }

                }

            } catch (error) {
                res.end()

                console.log(error.message)
            }
        })
        app.get("/node", async (req, res) => {
            res.end()


            try {

                let body = req.query
                body.count = Number(body.count)
                console.log(body)


                if (customMetrics.length < 1000) {

                    switch (body.method) {
                        case 'increment':
                            if (body.metric && body.count) {

                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'increment',
                                        metric_type: 1
                                    })
                                }
                            }
                            break;
                        case 'decrement':
                            if (body.metric && body.count) {
                                body.count = body.count > 0 ? body.count * -1 : body.count

                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'decrement',
                                        metric_type: 1

                                    })
                                }
                            }
                            break;
                        case 'distribution':
                            if (body.metric && body.count) {
                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum = body.count
                                        customMetrics[item].min = body.count
                                        customMetrics[item].max = body.count
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'distribution',
                                        metric_type: 2
                                    })
                                }
                            }
                            break;
                        case 'gauge':
                            if (body.metric && body.count) {
                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'gauge',
                                        metric_type: 3
                                    })
                                }
                            }
                            break;
                        case 'percentage':
                            if (body.metric && body.count && body.count >= 0 && body.count <= 100) {

                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'percentage',
                                        metric_type: 4
                                    })
                                }
                            }
                            break;
                        case 'systembyte':
                            if (body.metric && body.count) {
                                let isIn = false
                                for (let item in customMetrics) {
                                    if (customMetrics[item].metric === body.metric) {
                                        isIn = true
                                        customMetrics[item].count++
                                        customMetrics[item].sum += body.count
                                        customMetrics[item].min = body.count < customMetrics[item].min ? body.count : customMetrics[item].min
                                        customMetrics[item].max = body.count > customMetrics[item].max ? body.count : customMetrics[item].max
                                        customMetrics[item].last = body.count
                                        customMetrics[item].avg = customMetrics[item].sum / customMetrics[item].count

                                        break
                                    }
                                }
                                if (!isIn) {
                                    customMetrics.push({
                                        metric: body.metric,
                                        count: 1,
                                        sum: body.count,
                                        min: body.count,
                                        max: body.count,
                                        last: body.count,
                                        avg: body.count,
                                        metricType: 'systembyte',
                                        metric_type: 5
                                    })
                                }

                            }
                            break;
                        case 'log':
                            if (body.service && body.message) {
                            }
                            break;
                        default:
                            null
                        // code block
                    }

                }

            } catch (error) {

                console.log(error.message)
            }
        })
        app.post("/pm2list", (req, res) => {
            res.end()

            try {
                if (req.body.username && req.body.apps) {
                    emitWhenConnected("integrations/pm2List", {
                        data: req.body
                    })

                }
            } catch (error) {

            }

        })
        app.post("/ai-tracer", async (req, res) => {
            try {
              let payload;
          
              if (Buffer.isBuffer(req.body)) {
                // چون برای /ai-tracer raw گذاشتیم، اینجا Buffer می‌گیریم
                let buffer = req.body;
                const enc = (req.headers['content-encoding'] || '').toLowerCase();
                if (enc.includes('gzip')) {
                  buffer = zlib.gunzipSync(buffer);
                }
                const ct = (req.headers['content-type'] || '').toLowerCase();
                if (ct.includes('application/json') || ct.includes('text/json') || ct.includes('json') || ct === '') {
                  payload = JSON.parse(buffer.toString('utf8'));
                } else {
                  // اگر کسی فرمت دیگری فرستاد (مثلا پروتوباف) همین خام را بدهیم
                  payload = buffer;
                }
              } else {
                // اگر از مسیر json عمومی عبور کرده بود (بدنه کوچک)
                payload = req.body;
              }
          
              const spans = Array.isArray(payload) ? payload : [payload];
              const validSpans = spans
                .filter(s => s && s.traceId && s.spanId && s.startTime && s.endTime)
                .map(s => {
                  s.duration = new Date(s.endTime).getTime() - new Date(s.startTime).getTime();
                  s.status = this.determineStatus(s);
                  return s;
                });
          
              if (validSpans.length > 0) {
                emitWhenConnected("ai-trace", { spans: validSpans });
              }
          
              res.status(200).send({
                status: "ok",
                received: validSpans.length,
                skipped: spans.length - validSpans.length
              });
          
            } catch (err) {
              console.error("AI tracer error:", err);
              res.status(500).send("Internal error");
            }
          });
          
    }

    determineStatus(span) {
        if (!span.output || span.output.trim() === "") return "Error";
        const duration = new Date(span.endTime) - new Date(span.startTime);
        if (duration > 10000) return "Timeout";
        return "Success";
    }


    // to collect and log metrics
    async collectMetrics() {


        try {
            for (let integrate of integrations) {
                if (integrate.service === 'mongodb' && integrate.monitor === true) {
                    let username = integrate.username || ""
                    let password = integrate.password || ""
                    let mongoPort = integrate.port || "27017"
                    let mongoHost = integrate.host || "localhost"

                    // One shell round-trip produces both payloads. The legacy
                    // event is emitted byte-for-byte as before so existing
                    // dashboards keep working; the advanced event is additive.
                    mongodbCollector.collect(integrate, (err, result) => {
                        if (!err && result) {
                            emitWhenConnected("integrations/mongodbservice", {
                                data: result.basic
                            })
                            if (result.advanced) {
                                emitWhenConnected("integrations/mongodb.advanced", {
                                    data: result.advanced
                                })
                            }
                            return
                        }

                        // Fall back to the original collector so an agent that
                        // cannot run the advanced script still reports health.
                        console.error("MongoDB advanced collector failed, falling back:", err && err.message);
                        mongoIntegration.getData(mongoHost, mongoPort, username, password, (legacy) => {
                            if (legacy) {
                                emitWhenConnected("integrations/mongodbservice", {
                                    data: legacy
                                })
                            }
                        })
                    })
                }
            }
        } catch (error) {
            console.error("MongoDB Integration Error:", error.message);
        }
        try {
            for (let integrate of integrations) {
                if (integrate.service === 'postgresql' && integrate.monitor === true) {
                    let username = integrate.username || "";
                    let password = integrate.password || "";
                    let port = integrate.port || "5432";
                    let host = integrate.host || "localhost";
                    let databases = Array.isArray(integrate.database) ? integrate.database : [integrate.database];

                    // One collection pass produces both payloads. The legacy
                    // event is emitted byte-for-byte as before so existing
                    // dashboards keep working; the advanced event is additive.
                    postgresCollector.collect(integrate, (err, result) => {
                        if (!err && result) {
                            emitWhenConnected("integrations/postgresqlservice", {
                                data: result.basic
                            });
                            if (result.advanced) {
                                emitWhenConnected("integrations/postgresql.advanced", {
                                    data: result.advanced
                                });
                            }
                            return;
                        }

                        // Fall back to the original collector, which requires an
                        // explicit database list the advanced one does not.
                        console.error("PostgreSQL advanced collector failed, falling back:", err && err.message);
                        if (databases.length > 0 && databases[0]) {
                            postgresIntegration.getData(host, port, username, password, databases, (legacy) => {
                                if (legacy) {
                                    emitWhenConnected("integrations/postgresqlservice", {
                                        data: legacy
                                    });
                                }
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.error("PostgreSQL Integration Error:", error.message);
        }

        try {
            for (let integrate of integrations) {
                if (integrate.service === 'mysql' && integrate.monitor === true) {
                    let username = integrate.username || "";
                    let password = integrate.password || "";
                    let port = integrate.port || "3306";
                    let host = integrate.host || "localhost";
                    let databases = Array.isArray(integrate.database) ? integrate.database : [integrate.database];

                    // One connection produces both payloads. The legacy event is
                    // emitted byte-for-byte as before so existing dashboards keep
                    // working; the advanced event is additive.
                    mysqlCollector.collect(integrate, (err, result) => {
                        if (!err && result) {
                            emitWhenConnected("integrations/mysqlservice", {
                                data: result.basic
                            });
                            if (result.advanced) {
                                emitWhenConnected("integrations/mysql.advanced", {
                                    data: result.advanced
                                });
                            }
                            return;
                        }

                        // Fall back to the original collector. It needs an explicit
                        // database list, which the advanced collector does not.
                        console.error("MySQL advanced collector failed, falling back:", err && err.message);
                        if (databases.length > 0 && databases[0]) {
                            mysqlIntegration.getData(host, port, username, password, databases, (legacy) => {
                                if (legacy) {
                                    emitWhenConnected("integrations/mysqlservice", {
                                        data: legacy
                                    });
                                }
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.error("MySQL Integration Error:", error.message);
        }


        try {
            for (let integrate of integrations) {
                if (integrate.service === 'redis' && integrate.monitor === true) {
                    let password = integrate.password || ""
                    let redisPort = integrate.port || 6379
                    let redisHost = integrate.host || "127.0.0.1"

                    // One redis-cli session produces both payloads. The legacy
                    // event is emitted byte-for-byte as before so existing
                    // dashboards keep working; the advanced event is additive.
                    redisCollector.collect(integrate, (err, result) => {
                        if (!err && result) {
                            emitWhenConnected("integrations/redisservice", {
                                data: result.basic
                            })
                            if (result.advanced) {
                                emitWhenConnected("integrations/redis.advanced", {
                                    data: result.advanced
                                })
                            }
                            return
                        }

                        // Fall back to the original collector so an agent whose
                        // redis-cli predates --json still reports health.
                        console.error("Redis advanced collector failed, falling back:", err && err.message);
                        redisIntegration.getData(redisHost, redisPort, password, (legacy) => {
                            if (legacy) {
                                emitWhenConnected("integrations/redisservice", {
                                    data: legacy
                                })
                            }
                        })
                    })
                }
            }
        } catch (error) {
            console.error("Redis Integration Error:", error.message);
        }

        try {
            for (let integrate in integrations) {
                if (integrations[integrate].service == 'docker' && integrations[integrate].monitor == true) {
                    dockerIntegration.getData((result, err) => {
                        if (result) {
                            emitWhenConnected("dockerInfo", {
                                data: result
                            })
                        }
                    })
                    break
                }
            }
        } catch (error) {

        }

    }

}


setInterval(() => {

    try {

        emitWhenConnected('customMetrics', customMetrics)
        customMetrics = []

    } catch (error) {
        console.log(error)
    }

}, 10000)