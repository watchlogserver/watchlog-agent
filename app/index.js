const port = 3774
const { emitWhenConnected } = require('./socketServer');

const express = require('express')
const app = express()
const exec = require('child_process').exec;
const path = require('path')
const configFilePath = path.join(__dirname, './../.env');
const integrations = require("./../integration.json")
const dockerIntegration = require('./integrations/docker')
const mongoIntegration = require('./integrations/mongo')
const redisIntegration = require('./integrations/redis')
const nginxIntegration = require('./integrations/nginx')
const postgresIntegration = require('./integrations/postgresql');
const mysqlIntegration = require('./integrations/mysql');
const { collectAndEmitMetrics } = require('./collectAndEmitMetrics');
const zlib = require('zlib');

const logagent = require('./log-agent')
let customMetrics = []

module.exports = class Application {
    constructor() {
        this.startApp()
    }
    async startApp() {
        this.runAgent()
    }

    runAgent() {
        app.listen(port, '0.0.0.0', () => console.log(`Watchlog api agent is running on port 3774`))
        app.use(express.json());
        app.use(express.urlencoded({
            extended: true
        }));
        app.use(express.json({ limit: '50mb' }));
        app.use(['/apm','/apm/metrics','/apm/v1/traces','/apm/v1/metrics'], express.raw({ type: () => true, limit: '50mb' }));({ type: () => true, limit: '50mb' });

        this.getRouter()

        setInterval(this.collectMetrics, 60000);
        setInterval(() => {
            collectAndEmitMetrics()
        }, 60000);
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
                const data = req.body;
                const spans = Array.isArray(data) ? data : [data];

                const validSpans = spans.filter(span =>
                    span && span.traceId && span.spanId && span.startTime && span.endTime
                );

                for (const span of validSpans) {
                    span.duration = new Date(span.endTime).getTime() - new Date(span.startTime).getTime();
                    span.status = this.determineStatus(span);
                }

                if (validSpans.length > 0) {
                    emitWhenConnected("ai-trace", {
                        spans: validSpans
                    });
                }

                res.status(200).send({
                    status: "ok",
                    received: validSpans.length,
                    skipped: spans.length - validSpans.length
                });

            } catch (err) {
                console.error("AI tracer error:", err.message);
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
            for (let integrate in integrations) {
                if (integrations[integrate].service == 'mongodb' && integrations[integrate].monitor == true) {
                    let username = integrations[integrate].username || ""
                    let password = integrations[integrate].password || ""
                    let mongoPort = integrations[integrate].port || "27017"
                    let mongoHost = integrations[integrate].host || "localhost"
                    mongoIntegration.getData(mongoHost, mongoPort, username, password, (result, err) => {
                        if (result) {
                            emitWhenConnected("integrations/mongodbservice", {
                                data: result
                            })
                        }
                    })
                    break
                }
            }
        } catch (error) {

        }
        try {
            for (let integrate of integrations) {
                if (integrate.service === 'postgresql' && integrate.monitor === true && integrate.database.length > 0) {
                    let username = integrate.username || "";
                    let password = integrate.password || "";
                    let port = integrate.port || "5432";
                    let host = integrate.host || "localhost";
                    let databases = Array.isArray(integrate.database) ? integrate.database : [integrate.database];

                    postgresIntegration.getData(host, port, username, password, databases, (result) => {
                        if (result) {
                            emitWhenConnected("integrations/postgresqlservice", {
                                data: result
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
                if (integrate.service === 'mysql' && integrate.monitor === true && integrate.database.length > 0) {
                    let username = integrate.username || "";
                    let password = integrate.password || "";
                    let port = integrate.port || "3306";
                    let host = integrate.host || "localhost";
                    let databases = Array.isArray(integrate.database) ? integrate.database : [integrate.database];

                    mysqlIntegration.getData(host, port, username, password, databases, (result) => {
                        if (result) {
                            emitWhenConnected("integrations/mysqlservice", {
                                data: result
                            });
                        }
                    });
                }
            }
        } catch (error) {
            console.error("MySQL Integration Error:", error.message);
        }


        try {
            for (let integrate in integrations) {
                if (integrations[integrate].service == 'redis' && integrations[integrate].monitor == true) {
                    let password = integrations[integrate].password || ""
                    let redisPort = integrations[integrate].port || 6379
                    let redisHost = integrations[integrate].host || "127.0.0.1"
                    redisIntegration.getData(redisHost, redisPort, password, (result, err) => {
                        if (result) {
                            emitWhenConnected("integrations/redisservice", {
                                data: result
                            })
                        }
                    })
                    break
                }
            }
        } catch (error) {
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