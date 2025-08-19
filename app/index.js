const os = require('os')
const port = 3774
const { emitWhenConnected } = require("./socketServer");
const express = require('express')
const app = express()
const path = require('path')
const dockerIntegration = require('./integrations/docker')
const mongoIntegration = require('./integrations/mongo')
const redisIntegration = require('./integrations/redis')
const nginxIntegration = require('./integrations/nginx')
const postgresIntegration = require('./integrations/postgresql');
const mysqlIntegration = require('./integrations/mysql');
const { collectAndEmitSystemMetrics } = require('./watchlog-k8s-metrics');

const logagent = require('./log-agent')
let customMetrics = []

module.exports = class Application {
    constructor() {
        this.startApp()
    }


    async startApp() {
        this.runAgent()
        // send axios request for check api
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
        setInterval(() => collectAndEmitSystemMetrics(), 60000);
    }
    inferSeverity(message = '') {
        const p = String(message).match(/^\s*([IWE])\d{4}/);
        if (p) return p[1] === 'I' ? 'INFO' : p[1] === 'W' ? 'WARNING' : 'ERROR';
        const m = String(message).match(/\b(ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i);
        if (m) {
          const lvl = m[1].toUpperCase();
          return lvl === 'WARN' ? 'WARNING' : lvl;
        }
        return 'UNKNOWN';
    }
      
    getRouter() {
        app.get('/healthz', (req, res) => res.send('OK'));
        app.get('/readyz', (req, res) => res.send('READY'));
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
        // دریافت لاگ‌ها از Vector (سایدکار)
        app.post('/ingest/logs', (req, res) => {
            try {
            // 1) بادی خام + gzip
            let buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
            const enc = (req.headers['content-encoding'] || '').toLowerCase();
            if (enc.includes('gzip')) {
                buf = zlib.gunzipSync(buf);
            }
        
            // 2) تشخیص JSON vs NDJSON
            const ct = (req.headers['content-type'] || '').toLowerCase();
            const txt = buf.toString('utf8');
            let events = [];
            if (ct.includes('ndjson') || txt.includes('\n{')) {
                events = txt.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
            } else if (txt.length) {
                const parsed = JSON.parse(txt);
                events = Array.isArray(parsed) ? parsed : [parsed];
            }
        
            // 3) نرمال‌سازی برای Watchlog
            const clusterName = process.env.WATCHLOG_CLUSTER_NAME || 'default-cluster';
            const normalized = events.map(e => {
                const k = e.kubernetes || {};
                const timestamp =
                e.timestamp || e.time || e['@timestamp'] || new Date().toISOString();
        
                const msg = e.message ?? e.log ?? e.msg ?? '';
        
                const obj = {
                namespace: e.namespace ?? k.pod_namespace,
                podName:  e.pod ?? k.pod_name,
                containerName: e.container ?? k.container_name,
                nodeName: e.node ?? k.node_name,
                node: e.node ?? k.node_name,
                timestamp,
                message: msg,
                severity: this.inferSeverity(msg),
                cluster: e.cluster ?? clusterName,
                };
        
                // هر فیلد اضافی‌ای که داری، نگه می‌داریم:
                if (e.level && !obj.severity) obj.severity = String(e.level).toUpperCase();
                return obj;
            });
        
            // 4) ارسال به سرور از طریق ساکت، در بچ‌های کوچک
            const BATCH = 500;
            for (let i = 0; i < normalized.length; i += BATCH) {
                emitWhenConnected('podLogLines', normalized.slice(i, i + BATCH));
            }
        
            res.status(200).json({ received: normalized.length });
            } catch (err) {
            console.error('ingest/logs error:', err);
            res.status(400).json({ error: 'bad payload', detail: err.message });
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


        // --- MongoDB ---
        if (process.env.MONITOR_MONGODB === 'true') {
            const host = process.env.MONGODB_HOST || 'localhost';
            const port = process.env.MONGODB_PORT || '27017';
            const username = process.env.MONGODB_USERNAME || '';
            const password = process.env.MONGODB_PASSWORD || '';

            mongoIntegration.getData(host, port, username, password, (result) => {
                if (result) {
                    emitWhenConnected('integrations/mongodbservice', { data: result });
                }
            });
        }

        // --- Redis ---
        if (process.env.MONITOR_REDIS === 'true') {
            const host = process.env.REDIS_HOST || '127.0.0.1';
            const port = process.env.REDIS_PORT || '6379';
            const password = process.env.REDIS_PASSWORD || '';

            redisIntegration.getData(host, port, password, (result) => {
                if (result) {
                    emitWhenConnected('integrations/redisservice', { data: result });
                }
            });
        }

        // --- PostgreSQL ---
        if (process.env.MONITOR_POSTGRESQL === 'true' && process.env.POSTGRESQL_DATABASES) {
            const host = process.env.POSTGRESQL_HOST || 'localhost';
            const port = process.env.POSTGRESQL_PORT || '5432';
            const username = process.env.POSTGRESQL_USERNAME || '';
            const password = process.env.POSTGRESQL_PASSWORD || '';
            const dbs = process.env.POSTGRESQL_DATABASES.split(',').map(d => d.trim());

            postgresIntegration.getData(host, port, username, password, dbs, (result) => {
                if (result) {
                    emitWhenConnected('integrations/postgresqlservice', { data: result });
                }
            });
        }

        // --- MySQL ---
        if (process.env.MONITOR_MYSQL === 'true' && process.env.MYSQL_DATABASES) {
            const host = process.env.MYSQL_HOST || 'localhost';
            const port = process.env.MYSQL_PORT || '3306';
            const username = process.env.MYSQL_USERNAME || '';
            const password = process.env.MYSQL_PASSWORD || '';
            const dbs = process.env.MYSQL_DATABASES.split(',').map(d => d.trim());

            mysqlIntegration.getData(host, port, username, password, dbs, (result) => {
                if (result) {
                    emitWhenConnected('integrations/mysqlservice', { data: result });
                }
            });
        }

        // --- Docker ---
        if (process.env.MONITOR_DOCKER === 'true') {
            dockerIntegration.getData((result) => {
                if (result) {
                    emitWhenConnected('dockerInfo', { data: result });
                }
            });
        }


    }

}



function getSystemIP() {
    const networkInterfaces = os.networkInterfaces();
    for (let interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];

        for (let iface of interfaces) {
            // Check if it's an IPv4 address and not internal (i.e., not a localhost address)
            if (iface.family === 'IPv4' && !iface.internal && !isPrivateIP(iface.address)) {
                return iface.address;
            }
        }
    }

    return null; // No valid external IP found
}



// Function to check if an IP is private
function isPrivateIP(ip) {
    // Convert IP to an integer for easier comparison
    const parts = ip.split('.').map(Number);
    const ipNum = (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];

    // Check against private IP ranges
    return (
        (ipNum >= (10 << 24) && ipNum <= ((10 << 24) + 0xFFFFFF)) ||            // 10.0.0.0 - 10.255.255.255
        (ipNum >= (172 << 24 | 16 << 16) && ipNum <= (172 << 24 | 31 << 16 | 0xFFFF)) || // 172.16.0.0 - 172.31.255.255
        (ipNum >= (192 << 24 | 168 << 16) && ipNum <= (192 << 24 | 168 << 16 | 0xFFFF)) || // 192.168.0.0 - 192.168.255.255
        (ipNum >= (127 << 24) && ipNum <= (127 << 24 | 0xFFFFFF))               // 127.0.0.0 - 127.255.255.255 (loopback)
    );
}



setInterval(() => {

    try {

        emitWhenConnected('customMetrics', customMetrics)
        customMetrics = []

    } catch (error) {
        console.log(error)
    }

}, 10000)