const si = require('systeminformation');
const os = require('os')
const fs = require('fs')
const axios = require('axios');
const port = 3774
const watchlog_server = process.env.WATCHLOG_SERVER
const apiKey = process.env.WATCHLOG_APIKEY
var ioServer = require('socket.io-client');
const watchlogServerSocket = require("./socketServer");
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
const iisIntegration = require('./integrations/iis-log-monitor')
const postgresIntegration = require('./integrations/postgresql');
const mysqlIntegration = require('./integrations/mysql');
const { collectAndEmitMetrics } = require('./collectAndEmitMetrics');

const logagent = require('./log-agent')
let customMetrics = []

module.exports = class Application {
    constructor() {
        this.startApp()
    }


    async startApp() {

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



        if (!apiKey) {
            return console.log(new Error("Watchlog Server is not found"))
        }
        if (await this.checkApiKey(uuid, systemOsfo.distro, systemOsfo.release)) {
            this.runAgent(uuid)
        } else {
            setTimeout(() => {
                this.startApp()
            }, 10000)
        }
        // send axios request for check api
    }

    runAgent(uuid) {
        app.listen(port, () => console.log(`Watchlog api agent is running on port 3774`))
        app.use(express.json());
        app.use(express.urlencoded({
            extended: true
        }));

        this.getRouter(uuid)

        setInterval(this.collectMetrics, 60000);
        setInterval(() => {
            if(watchlogServerSocket.connected){
                collectAndEmitMetrics(watchlogServerSocket)
            }
        }, 60000);
    }

    getRouter(uuid) {
        app.post("/apm", async (req, res) => {
            try {
                if (req.body.metrics) {
                    if (watchlogServerSocket.connected) {
                        watchlogServerSocket.emit("APM", {
                            data: req.body.metrics,
                            platformName: req.body.platformName ? req.body.platformName : "express"
                        })
                    }
                }
            } catch (error) {
            }
        })
        app.get("/", async (req, res) => {
            res.end()

            try {
                if (watchlogServerSocket.connected) {
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
                                    // watchlogServerSocket.emit('log', { ...body, type: 1 })
                                }
                                break;
                            default:
                                null
                            // code block
                        }

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

                if (watchlogServerSocket.connected) {
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
                                    // watchlogServerSocket.emit('log', { ...body, type: 1 })
                                }
                                break;
                            default:
                                null
                            // code block
                        }

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
                    if (watchlogServerSocket.connected) {
                        watchlogServerSocket.emit("integrations/pm2List", {
                            data: req.body
                        })
                    }
                }
            } catch (error) {

            }

        })
    }

    async checkApiKey(uuid, distro, release) {
        try {
            let response = await axios.get(`${watchlog_server}/checkapikey?apiKey=${apiKey}&uuid=${uuid}`)
            if (response.status == 200) {
                if (response.data.status == "success") {

                    watchlogServerSocket.emit("setApiKey", { apiKey, host: os.hostname(), ip: getSystemIP(), uuid: uuid, distro: distro, release: release, agentVersion : "0.1.1" })
                    return true
                } else {
                    if (response.data.message) {
                        console.log(response.data.message)
                    }
                    return false
                }
            } else {
                return false
            }
        } catch (error) {
            console.log(error.message)
            return false
        }
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
                            watchlogServerSocket.emit("integrations/mongodbservice", {
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
                            watchlogServerSocket.emit("integrations/postgresqlservice", {
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
                            watchlogServerSocket.emit("integrations/mysqlservice", {
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
                            watchlogServerSocket.emit("integrations/redisservice", {
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
                            watchlogServerSocket.emit("dockerInfo", {
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

watchlogServerSocket.on('reconnect', async (attemptNumber) => {
    if (apiKey) {
        const systemOsfo = await si.osInfo();
        const systemInfo = await si.system();

        let uuid = ""
        if (!process.env.UUID) {
            if (systemOsfo.serial && systemOsfo.serial.length > 0) {
                uuid = systemOsfo.serial
            } else if (systemInfo.uuid && systemInfo.uuid.length > 0) {
                uuid = systemInfo.uuid
            } else {
                uuid = systemOsfo.hostname
            }
            // fs.appendFileSync(configFilePath, `\nUUID=${uuid}`, 'utf8');


        } else {
            uuid = process.env.UUID
        }

        watchlogServerSocket.emit("setApiKey", { apiKey, host: os.hostname(), ip: getSystemIP(), uuid: uuid, distro: systemOsfo.distro, release: systemOsfo.release, agentVersion : "0.1.1" })
    }

});



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

        watchlogServerSocket.emit('customMetrics', customMetrics)
        customMetrics = []

    } catch (error) {
        console.log(error)
    }

}, 10000)