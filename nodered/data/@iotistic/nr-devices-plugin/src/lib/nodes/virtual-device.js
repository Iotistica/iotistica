const { getMqttManager } = require('../comms/mqtt')

module.exports = function (RED) {
    function VirtualDeviceNode (config) {
        RED.nodes.createNode(this, config)
        const node = this

        node.deviceUuid = config.deviceUuid
        node.subscribeMetrics = config.subscribeMetrics !== false
        node.subscribeSensors = config.subscribeSensors !== false
        node.mqttManager = null
        node.topics = []

        // Get MQTT broker credentials from plugin settings, with env fallbacks
        const mqttBroker = RED.settings.mqttBroker || process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883'
        const mqttUsername = RED.settings.mqttUsername || process.env.MQTT_USERNAME
        const mqttPassword = RED.settings.mqttPassword || process.env.MQTT_PASSWORD

        if (!node.deviceUuid) {
            node.status({ fill: 'red', shape: 'ring', text: 'no device UUID' })
            node.error('Device UUID not configured')
            return
        }

        if (!mqttUsername || !mqttPassword) {
            node.status({ fill: 'yellow', shape: 'ring', text: 'mqtt creds missing' })
            node.warn('MQTT credentials not configured. Set MQTT_USERNAME and MQTT_PASSWORD or login via dashboard to hydrate broker credentials.')
            return
        }

        node.status({ fill: 'yellow', shape: 'ring', text: 'connecting...' })

        try {
            // Get shared MQTT connection manager
            node.mqttManager = getMqttManager(RED, {
                url: mqttBroker,
                username: mqttUsername,
                password: mqttPassword
            })

            // Register this node with the connection pool
            const nodeId = `virtual-device-${node.id}`
            node.mqttManager.register(nodeId, node)

            // Subscribe to device state updates
            if (node.deviceUuid) {
                const stateTopic = `iot/device/${node.deviceUuid}/state/current`
                node.topics.push(stateTopic)
                
                node.mqttManager.subscribe(stateTopic, (topic, message, packet) => {
                    try {
                        node.log(`Received message on topic: ${topic}`)
                        const payload = JSON.parse(message.toString())
                        
                        const outputMsg = {
                            topic: topic,
                            payload: payload,
                            deviceUuid: node.deviceUuid,
                            messageType: 'state'
                        }
                        
                        // Send to state output (first output)
                        node.send([outputMsg, null])
                    } catch (err) {
                        node.error(`Error processing state message: ${err.message}`, { topic, error: err })
                    }
                }, nodeId, { qos: 1 })

                // Subscribe to sensor data if enabled
                if (node.subscribeSensors) {
                    const sensorTopic = `iot/device/${node.deviceUuid}/sensors/#`
                    node.topics.push(sensorTopic)
                    
                    node.mqttManager.subscribe(sensorTopic, (topic, message, packet) => {
                        try {
                            node.log(`Received sensor message on topic: ${topic}`)
                            const payload = JSON.parse(message.toString())
                            
                            // Extract sensor type from topic (e.g., iot/device/uuid/sensors/temperature)
                            const parts = topic.split('/')
                            payload.sensorType = parts[parts.length - 1]
                            
                            const outputMsg = {
                                topic: topic,
                                payload: payload,
                                deviceUuid: node.deviceUuid,
                                messageType: 'sensor'
                            }
                            
                            // Send to sensor output (second output)
                            node.send([null, outputMsg])
                        } catch (err) {
                            node.error(`Error processing sensor message: ${err.message}`, { topic, error: err })
                        }
                    }, nodeId, { qos: 1 })
                }

                node.status({ fill: 'green', shape: 'dot', text: 'subscribed' })
                node.log(`Subscribed to topics for device: ${node.deviceUuid}`)
            }
        } catch (err) {
            node.error(`Failed to initialize virtual device node: ${err.message}`)
            node.status({ fill: 'red', shape: 'ring', text: 'initialization failed' })
        }

        // Clean up on node removal
        node.on('close', (done) => {
            try {
                if (node.mqttManager) {
                    const nodeId = `virtual-device-${node.id}`
                    node.mqttManager.deregister(nodeId)
                    node.log(`Deregistered from MQTT connection pool`)
                }
                node.status({})
                done()
            } catch (err) {
                node.error(`Error during cleanup: ${err.message}`)
                done()
            }
        })
    }

    RED.nodes.registerType('virtual-device', VirtualDeviceNode)
}
