const mqtt = require('mqtt')

/**
 * MQTT Connection Pool Manager - Following Node-RED's official MQTT broker pattern
 * Provides a single shared MQTT connection for all plugin nodes
 */
class MqttConnectionManager {
    constructor (RED, broker) {
        this.RED = RED
        this.users = {}  // Track registered nodes by ID
        this.subscriptions = {}  // Track subscriptions by topic: { topic: { nodeId: handler } }
        this.client = null
        this.connected = false
        this.connecting = false
        this.closing = false
        
        // Broker configuration
        this.brokerUrl = broker.url || 'mqtt://mosquitto:1883'
        this.brokerUsername = broker.username
        this.brokerPassword = broker.password
        this.clientId = `nodered-plugin-${this.brokerUsername || 'default'}`
        
        // Connection options
        this.autoConnect = true
        this.reconnectPeriod = 5000
    }

    /**
     * Register a node to use this MQTT connection
     * First node triggers connection
     */
    register (nodeId, node) {
        this.users[nodeId] = node
        console.log(`[MqttConnectionManager] Registered node ${nodeId}, total users: ${Object.keys(this.users).length}`)

        // If this is the first node, connect to broker
        if (Object.keys(this.users).length === 1) {
            if (this.autoConnect) {
                this.connect()
            }
        }
    }

    /**
     * Deregister a node from this MQTT connection
     * Last node triggers disconnect
     */
    deregister (nodeId, autoDisconnect = true) {
        // Remove node's subscriptions
        for (const topic in this.subscriptions) {
            if (this.subscriptions[topic][nodeId]) {
                delete this.subscriptions[topic][nodeId]
                
                // If no more handlers for this topic, unsubscribe from broker
                if (Object.keys(this.subscriptions[topic]).length === 0) {
                    if (this.client && this.connected) {
                        this.client.unsubscribe(topic)
                        console.log(`[MqttConnectionManager] Unsubscribed from topic: ${topic}`)
                    }
                    delete this.subscriptions[topic]
                }
            }
        }
        
        // Remove node from users
        delete this.users[nodeId]
        console.log(`[MqttConnectionManager] Deregistered node ${nodeId}, remaining users: ${Object.keys(this.users).length}`)

        // If no more users and autoDisconnect, disconnect from broker
        if (autoDisconnect && !this.closing && this.connected && Object.keys(this.users).length === 0) {
            this.disconnect()
        }
    }

    /**
     * Subscribe to a topic with a handler
     * Multiple nodes can subscribe to the same topic
     */
    subscribe (topic, handler, nodeId, options = {}) {
        const qos = options.qos !== undefined ? options.qos : 1
        
        // Initialize topic subscriptions object if needed
        if (!this.subscriptions[topic]) {
            this.subscriptions[topic] = {}
        }
        
        // Store handler for this node
        this.subscriptions[topic][nodeId] = handler
        console.log(`[MqttConnectionManager] Node ${nodeId} subscribed to topic: ${topic}`)

        // If connected and this is the first subscription to this topic, subscribe to broker
        if (this.connected && Object.keys(this.subscriptions[topic]).length === 1) {
            this.client.subscribe(topic, { qos }, (err) => {
                if (err) {
                    console.error(`[MqttConnectionManager] Failed to subscribe to ${topic}:`, err)
                } else {
                    console.log(`[MqttConnectionManager] Subscribed to broker topic: ${topic}`)
                }
            })
        }
    }

    /**
     * Unsubscribe a node from a topic
     */
    unsubscribe (topic, nodeId) {
        if (this.subscriptions[topic] && this.subscriptions[topic][nodeId]) {
            delete this.subscriptions[topic][nodeId]
            console.log(`[MqttConnectionManager] Node ${nodeId} unsubscribed from topic: ${topic}`)

            // If no more handlers for this topic, unsubscribe from broker
            if (Object.keys(this.subscriptions[topic]).length === 0) {
                if (this.client && this.connected) {
                    this.client.unsubscribe(topic)
                    console.log(`[MqttConnectionManager] Unsubscribed from broker topic: ${topic}`)
                }
                delete this.subscriptions[topic]
            }
        }
    }

    /**
     * Connect to MQTT broker
     */
    connect () {
        if (this.connected || this.connecting) {
            console.log('[MqttConnectionManager] Already connected or connecting')
            return
        }

        this.closing = false
        this.connecting = true
        console.log(`[MqttConnectionManager] Connecting to broker: ${this.brokerUrl}`)

        const options = {
            clientId: this.clientId,
            clean: true,
            reconnectPeriod: this.reconnectPeriod,
            username: this.brokerUsername,
            password: this.brokerPassword
        }

        this.client = mqtt.connect(this.brokerUrl, options)
        this.client.setMaxListeners(0)

        this.client.on('connect', () => {
            this.closing = false
            this.connecting = false
            this.connected = true
            console.log(`[MqttConnectionManager] Connected to broker: ${this.brokerUrl}`)
            
            // Re-subscribe to all topics
            this.reSubscribeAll()
        })

        this.client.on('reconnect', () => {
            console.log('[MqttConnectionManager] Reconnecting to broker...')
        })

        this.client.on('close', () => {
            if (this.connected) {
                this.connected = false
                console.log('[MqttConnectionManager] Disconnected from broker')
            }
        })

        this.client.on('error', (err) => {
            this.connected = false
            console.error('[MqttConnectionManager] Connection error:', err.message)
        })

        this.client.on('message', (topic, message, packet) => {
            // Dispatch message to all registered handlers for this topic
            this.dispatchMessage(topic, message, packet)
        })
    }

    /**
     * Dispatch incoming message to all subscribed handlers
     */
    dispatchMessage (topic, message, packet) {
        if (this.subscriptions[topic]) {
            for (const nodeId in this.subscriptions[topic]) {
                const handler = this.subscriptions[topic][nodeId]
                if (typeof handler === 'function') {
                    try {
                        handler(topic, message, packet)
                    } catch (err) {
                        console.error(`[MqttConnectionManager] Error in message handler for node ${nodeId}:`, err)
                    }
                }
            }
        }
    }

    /**
     * Re-subscribe to all topics (after reconnection)
     */
    reSubscribeAll () {
        console.log('[MqttConnectionManager] Re-subscribing to all topics...')
        for (const topic in this.subscriptions) {
            if (Object.keys(this.subscriptions[topic]).length > 0) {
                this.client.subscribe(topic, { qos: 1 }, (err) => {
                    if (err) {
                        console.error(`[MqttConnectionManager] Failed to re-subscribe to ${topic}:`, err)
                    } else {
                        console.log(`[MqttConnectionManager] Re-subscribed to topic: ${topic}`)
                    }
                })
            }
        }
    }

    /**
     * Publish a message to a topic
     */
    publish (topic, message, options = {}, callback) {
        if (!this.client || !this.connected) {
            const error = new Error('Not connected to broker')
            if (callback) {
                callback(error)
            } else {
                console.error('[MqttConnectionManager]', error.message)
            }
            return
        }

        const publishOptions = {
            qos: options.qos || 0,
            retain: options.retain || false
        }

        this.client.publish(topic, message, publishOptions, (err) => {
            if (err) {
                console.error(`[MqttConnectionManager] Failed to publish to ${topic}:`, err)
            }
            if (callback) {
                callback(err)
            }
        })
    }

    /**
     * Disconnect from MQTT broker
     */
    disconnect () {
        if (!this.client || this.closing) {
            return
        }

        this.closing = true
        console.log('[MqttConnectionManager] Disconnecting from broker...')
        
        this.client.end(false, () => {
            this.connecting = false
            this.connected = false
            this.closing = false
            console.log('[MqttConnectionManager] Disconnected from broker')
        })
    }

    /**
     * Get the underlying MQTT client (for advanced use)
     */
    getClient () {
        return this.client
    }

    /**
     * Check if connected
     */
    isConnected () {
        return this.connected
    }
}

/**
 * Simple wrapper class for node identification
 */
class MqttNode {
    constructor (id) {
        this.id = id
    }
}

/**
 * Singleton instance of the connection manager
 */
let instance = null

function hasBrokerConfigChanged (manager, brokerConfig = {}) {
    if (!manager || !brokerConfig) {
        return false
    }

    const nextUrl = brokerConfig.url || manager.brokerUrl
    const nextUsername = Object.prototype.hasOwnProperty.call(brokerConfig, 'username')
        ? brokerConfig.username
        : manager.brokerUsername
    const nextPassword = Object.prototype.hasOwnProperty.call(brokerConfig, 'password')
        ? brokerConfig.password
        : manager.brokerPassword

    return nextUrl !== manager.brokerUrl ||
        nextUsername !== manager.brokerUsername ||
        nextPassword !== manager.brokerPassword
}

/**
 * Get or create the shared MQTT connection manager
 * @param {Object} RED - Node-RED runtime
 * @param {Object} brokerConfig - Broker configuration { url, username, password }
 * @returns {MqttConnectionManager}
 */
function getManager (RED, brokerConfig) {
    if (!instance) {
        instance = new MqttConnectionManager(RED, brokerConfig)
        console.log('[MqttConnectionManager] Created new singleton instance')
    } else if (hasBrokerConfigChanged(instance, brokerConfig)) {
        console.log('[MqttConnectionManager] Broker config changed, recreating singleton instance')
        instance.disconnect()
        instance = new MqttConnectionManager(RED, brokerConfig)
    }
    return instance
}

/**
 * Get the underlying MQTT client (if initialized)
 * @returns {Object} MQTT client instance
 * @throws {Error} If manager not initialized
 */
function getClient () {
    if (!instance || !instance.getClient()) {
        throw new Error('MQTT client is not initialized. Call getManager() first.')
    }
    return instance.getClient()
}

/**
 * Reset the singleton instance (useful for testing)
 */
function resetManager () {
    if (instance) {
        instance.disconnect()
        instance = null
        console.log('[MqttConnectionManager] Singleton instance reset')
    }
}

module.exports = {
    MqttNode,
    MqttConnectionManager,
    getMqttManager: getManager,
    getMqttClient: getClient,
    resetManager
}
