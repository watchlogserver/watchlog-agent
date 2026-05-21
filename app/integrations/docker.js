const si = require('systeminformation');


exports.getData = function (callback) {
    si.dockerInfo().then(info => {
        if (info && info.id) {
            si.dockerImages().then(images => {
                let imagesMetrics = []
                images.forEach(image => {

                    if (image.repoTags.length > 0) {
                        const lastColonIndex = image.repoTags[0].lastIndexOf(':');



                        const name = image.repoTags[0].slice(0, lastColonIndex); // Get part before the last ':'
                        const tag = image.repoTags[0].slice(lastColonIndex + 1); // Get part after the last ':'
                        imagesMetrics.push({
                            id: image.id,
                            name: name,
                            tag: tag,
                            volumes: image.config.Volumes ? image.config.Volumes : [],
                            size: image.size,
                            created: image.created
                        })
                    } else {
                        imagesMetrics.push({
                            id: image.id,
                            name: "null",
                            tag: "null",
                            volumes: image.config.Volumes ? image.config.Volumes.toString() : [],
                            size: image.size,
                            created: image.created
                        })
                    }

                })

                si.dockerVolumes().then(volumes => {
                    let volumeMetrics = []
                    volumes.forEach(volume => {
                        volumeMetrics.push({
                            id: volume.name,
                            name: volume.name,
                            labels: volume.labels ? volume.labels.toString() : "",
                            mountpoint: volume.mountpoint,
                            scope: volume.scope,
                            created: volume.created
                        })
                    })


                    si.dockerAll().then(containers => {
                        let containerMetrics = []
                        containers.forEach(container => {
                            try {
                                containerMetrics.push({
                                    id: container.id,
                                    name: container.name,
                                    image: container.image,
                                    created: container.created,
                                    started: container.started,
                                    state: container.state,
                                    restartCount: container.restartCount,
                                    ports: Array.isArray(container.ports) && container.ports.length > 0 ? container.ports : [],
                                    mounts: Array.isArray(container.mounts) && container.mounts.length > 0 ? container.mounts : [],
                                    memUsage: container.memUsage || 0,
                                    memLimit: container.memLimit || 0,
                                    memPercent: container.memPercent || 0,
                                    cpuPercent: container.cpuPercent || 0,
                                    netIO_rx: container.netIO ? container.netIO.rx || 0 : 0,
                                    netIO_wx: container.netIO ? container.netIO.wx || 0 : 0,
                                    blockIO_r: container.blockIO ? container.blockIO.r || 0 : 0,
                                    blockIO_w: container.blockIO ? container.blockIO.w || 0 : 0
                                })
                            } catch (error) {
                                // skip malformed container, don't abort entire callback
                            }
                        })
                        callback({
                            id: info.id,
                            name: "dockerInfo",
                            containersCount: info.containers,
                            containersRunning: info.containersRunning,
                            containersPaused: info.containersPaused,
                            containersStopped: info.containersStopped,
                            imagesCount: info.images,
                            memTotal: info.memTotal,
                            serverVersion: info.serverVersion,
                            volumesCount: volumes.length,
                            volumes: volumeMetrics,
                            images: imagesMetrics,
                            containers: containerMetrics
                        })

                    }).catch(err => {
                        console.log(err.message)
                        callback(null)
                    })

                }).catch(err => {
                    console.log(err.message)
                    callback(null)
                })


            }).catch(err => {
                console.log(err.message)
                callback(null)
            })

        } else {
            callback(null)
        }
    }).catch(err => {
        console.log(err.message)
        callback(null)

    })



}

// sudo chmod 666 /var/run/docker.sock


