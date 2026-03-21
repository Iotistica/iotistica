const auth = require('./auth')
const settings = require('./settings')
const { ffGet, ffPost } = require('./client')
const comms = require('./comms')
const { getMqttManager, getMqttClient, MqttNode } = require('./comms/mqtt')

let mqttInitialized = false

function setupRoutes (RED) {
    // Public agent list — must be registered BEFORE auth.setupRoutes() adds the
    // catch-all RED.httpAdmin.use('/nr-tools/*', needsPermission) middleware.
    // The NR process calls the API over the internal Docker network using the storage token.
    RED.httpAdmin.get('/nr-tools/agents', async (request, response) => {
        try {
            const storageToken = process.env.IOTISTIC_STORAGE_TOKEN || ''
            const data = await ffGet('/api/v1/nr/devices', storageToken)
            response.send(data)
        } catch (err) {
            console.error('[nr-tools][agents] Failed to list agents:', err.message || err)
            response.send({ devices: [] })
        }
    })

    // Public endpoint device list for a specific agent — must be before auth.setupRoutes()
    RED.httpAdmin.get('/nr-tools/endpoints', async (request, response) => {
        const agentUuid = (request.query.agentUuid || '').trim()
        if (!agentUuid) {
            return response.status(400).send({ error: 'agentUuid query param is required' })
        }
        try {
            const storageToken = process.env.IOTISTIC_STORAGE_TOKEN || ''
            const data = await ffGet('/api/v1/nr/endpoints?agentUuid=' + encodeURIComponent(agentUuid), storageToken)
            response.send(data)
        } catch (err) {
            console.error('[nr-tools][endpoints] Failed to list endpoints:', err.message || err)
            response.send({ endpoints: [] })
        }
    })

    auth.setupRoutes(RED)
    comms.setupRoutes(RED)

    RED.httpAdmin.get('/nr-tools/auth/token', async (request, response) => {
        const user = request.user || {}
        const sess = request.session || {}

        // 1. Try RED.settings._auth.currentToken (set by httpAdminMiddleware from session)
        const settingsToken = RED.settings && RED.settings._auth && RED.settings._auth.currentToken
            ? RED.settings._auth.currentToken : null

        // 2. Try all request.user fields
        const userToken = user.idToken || user.id_token || user.accessToken || null

        // 3. Try session fields
        const sessToken = sess.auth0IdToken
            || (sess.user && (sess.user.idToken || sess.user.id_token))
            || sess.auth0Token
            || (sess.user && sess.user.accessToken)
            || (sess.passport && sess.passport.user && sess.passport.user.accessToken)
            || null

        const isJwtLike = (value) => typeof value === 'string' && value.split('.').length === 3
        const candidates = [settingsToken, user.idToken, user.id_token, userToken, sessToken]
        const jwtCandidate = candidates.find(isJwtLike) || null
        const token = jwtCandidate || settingsToken || userToken || sessToken || null

        console.log('[nr-tools][auth-token] token probe', {
            userKeys: Object.keys(user),
            sessKeys: Object.keys(sess).filter(k => k !== 'cookie'),
            settingsToken: settingsToken ? `${settingsToken.split('.').length}seg` : 'null',
            selectedToken: token ? `${token.split('.').length}seg` : 'null',
            userToken: userToken ? `${userToken.split('.').length}seg` : 'null',
            sessToken: sessToken ? `${sessToken.split('.').length}seg` : 'null',
            passportUser: sess.passport ? JSON.stringify(sess.passport.user).substring(0, 120) : 'none'
        })

        if (!token || typeof token !== 'string' || token.length === 0) {
            return response.status(401).send({ error: 'unauthorized', message: 'No access token found in session' })
        }

        return response.send({ accessToken: token })
    })

    RED.httpAdmin.get('/nr-tools/settings', async (request, response) => {
        const body = settings.exportPublicSettings()
        
        // Bearer-only mode: no fallback
        const authHeader = request.headers.authorization
        const bearerToken = (authHeader && authHeader.startsWith('Bearer '))
            ? authHeader.split(' ')[1]
            : null

        console.log('[nr-tools][settings] Evaluating connection state', {
            hasAuthorizationHeader: !!authHeader,
            hasBearerToken: !!bearerToken,
            bearerSegments: bearerToken ? bearerToken.split('.').length : 0,
            iotisticURL: body.iotisticURL || null
        })
        
        if (!bearerToken || typeof bearerToken !== 'string' || bearerToken.length === 0) {
            return response.status(401).send({ error: 'unauthorized', message: 'Bearer token required' })
        }

        let meResponse
        try {
            console.log('[nr-tools][settings] Using bearer token for /api/v1/auth/me')
            meResponse = await ffGet('/api/v1/auth/me', bearerToken)
            if (meResponse.code === 'unauthorized') {
                console.warn('[nr-tools][settings] auth/me returned unauthorized')
                body.connected = false
                body.authSource = 'bearer'
                body.authError = 'unauthorized'
                return response.send(body)
            }
        } catch (err) {
            console.warn('[nr-tools][settings] auth/me request failed', {
                message: err?.message || String(err)
            })
            body.connected = false
            body.authSource = 'bearer'
            body.authError = err?.message || String(err)
            return response.send(body)
        }

        // API returns { data: { user: {...} } }
        const userProfile = meResponse.data?.user || meResponse
        body.connected = true
        body.authSource = 'bearer'
        body.user = {
            id: userProfile.id,
            username: userProfile.username,
            email: userProfile.email,
            role: userProfile.role,
            fullName: userProfile.fullName || userProfile.full_name,
            name: userProfile.name || userProfile.fullName || userProfile.full_name,
            avatar: userProfile.avatar || ''
        }
        if (userProfile.brokerClient && !mqttInitialized) {
            // Setup shared MQTT connection pool
            console.log('[nr-devices-plugin] Initializing MQTT connection pool')
            const mqttManager = getMqttManager(RED, userProfile.brokerClient)
            
            // Register this plugin instance
            const nodeId = 'nr-devices-plugin-main'
            mqttManager.register(nodeId, { id: nodeId })
            
            // Subscribe to device state updates
            const deviceStateTopic = 'iot/device/+/state/current'
            mqttManager.subscribe(deviceStateTopic, (topic, message, packet) => {
                const payload = JSON.parse(message.toString())
                console.log(`[nr-devices-plugin] Device state update on ${topic}:`, payload)
                
                // Publish to Node-RED comms for UI updates
                const deviceId = topic.split('/')[2]
                RED.comms.publish('notification/device-state-update', {
                    device: deviceId,
                    payload: payload
                })
            }, nodeId, { qos: 1 })

            mqttInitialized = true
            console.log('[nr-devices-plugin] MQTT connection pool initialized')
        }
        console.log('[nr-tools][settings] Connected: user profile resolved', {
            username: body.user?.username || null,
            role: body.user?.role || null
        })

        response.send(body)
    })

    RED.httpAdmin.post('/nr-tools/settings/iotisticURL', async (request, response) => {
        try {
            const { iotisticURL } = request.body
            if (iotisticURL) {
                settings.set('iotisticURL', iotisticURL.replace(/\/$/, ''))
                response.send({ success: true })
            } else {
                response.status(400).send({ error: 'iotisticURL required' })
            }
        } catch (err) {
            console.error('Failed to save iotisticURL:', err)
            response.status(500).send({ error: err.message })
        }
    })

    // ** All routes after this point must have a valid  Token associated with the session **
    RED.httpAdmin.use('/nr-tools/*', auth.needsIotToken)

    RED.httpAdmin.get('/nr-tools/user', async (request, response) => {
        try {
            const user = await ffGet('/api/v1/auth/me', request.iotToken)
            response.send(user)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/teams', async (request, response) => {
        try {
            const teams = await ffGet('/api/v1/user/teams', request.iotToken)
            response.send(teams)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/teams/:teamId/projects', async (request, response) => {
        try {
            const projects = await ffGet(`/api/v1/teams/${request.params.teamId}/projects`, request.iotToken)
            response.send(projects)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/projects/:projectId', async (request, response) => {
        try {
            const project = await ffGet(`/api/v1/projects/${request.params.projectId}`, request.iotToken)
            response.send(project)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/projects/:projectId/snapshots', async (request, response) => {
        try {
            const project = await ffGet(`/api/v1/projects/${request.params.projectId}/snapshots`, request.iotToken)
            response.send(project)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/devices', async (request, response) => {
        try {
            const page = request.query.page || 1
            const limit = request.query.limit || 10
            const filter = request.query.filter || 'all'
            const url = `/api/v1/devices?page=${page}&limit=${limit}&filter=${filter}`

            const token = request.iotToken
            const tokenSegments = typeof token === 'string' ? token.split('.').length : 0
            const tokenLength = typeof token === 'string' ? token.length : 0

            console.log('[nr-tools][devices] Forwarding request', {
                method: request.method,
                path: request.originalUrl || request.url,
                page,
                limit,
                filter,
                upstreamUrl: url,
                hasIotToken: !!token,
                tokenSegments,
                tokenLength
            })

            const devices = await ffGet(url, request.iotToken)

            const rows = Array.isArray(devices?.devices)
                ? devices.devices.length
                : (Array.isArray(devices?.data) ? devices.data.length : null)

            console.log('[nr-tools][devices] Upstream response received', {
                hasCode: !!devices?.code,
                code: devices?.code || null,
                rows
            })
            response.send(devices)
        } catch (err) {
            console.error('[nr-tools][devices] Upstream request failed', {
                message: err?.message || String(err)
            })
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/devices/:deviceId/logs', async (request, response) => {
        try {
            const url = `/api/v1/devices/${request.params.deviceId}/logs`
            const creds = await ffGet(url, request.iotToken)
            response.send(creds)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/account/:account', async (request, response) => {
        try {
            // Extract page and limit from query parameters
            const page = request.query.page || 1
            const limit = request.query.limit || 10
            const filter = request.query.filter || 'all'
            const url = `/api/v1/devices?page=${page}&limit=${limit}&filter=${filter}`
            const devices = await ffGet(url, request.iotToken)
            response.send(devices)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.post('/nr-tools/devices', async (request, response) => {
        try {
            const device = {
                id: request.body.id,
                userId: request.body.userId,
                name: request.body.name,
                description: request.body.description,
                type: request.body.type
            }
            const data = await ffPost('/api/v1/devices', request.iotToken, device)
            response.send(data)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/devices/:deviceId/otc', async (request, response) => {
        try {
            console.log(request)
            const otc = await ffGet(`/api/v1/devices/${request.params.deviceId}/otc`, request.iotToken)
            response.send(otc)
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.post('/nr-tools/device-publish-command', async (request, response) => {
        try {
            console.log(request.body)
            // publishDeviceCommand(request.body)
            response.send({})
        } catch (err) {
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    // MQTT Monitor proxy routes
    RED.httpAdmin.get('/nr-tools/mqtt-monitor/dashboard', async (request, response) => {
        try {
            const data = await ffGet('/api/v1/mqtt-monitor/dashboard', request.iotToken)
            response.send(data)
        } catch (err) {
            console.error('MQTT Monitor dashboard error:', err)
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/mqtt-monitor/topic-tree', async (request, response) => {
        try {
            const data = await ffGet('/api/v1/mqtt-monitor/topic-tree', request.iotToken)
            response.send(data)
        } catch (err) {
            console.error('MQTT Monitor topic-tree error:', err)
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    RED.httpAdmin.get('/nr-tools/mqtt-monitor/topics/:topic(*)/recent-activity', async (request, response) => {
        try {
            const topic = request.params.topic
            const window = request.query.window || 15
            const url = `/api/v1/mqtt-monitor/topics/${encodeURIComponent(topic)}/recent-activity?window=${window}`
            const data = await ffGet(url, request.iotToken)
            response.send(data)
        } catch (err) {
            console.error('MQTT Monitor recent-activity error:', err)
            response.send({ error: err.toString(), code: 'request_failed' })
        }
    })

    // RED.httpAdmin.post('/nr-tools/snapshots', async (request, response) => {
    //     try {
    //         const snapshot = {
    //             sublowId: request.body.sublowId,
    //             deviceId: request.body.deviceId,
    //             data: request.body.data
    //         }
    //         await ffPost('/api/v1/snapshots', request.iotToken, snapshot)
    //         response.send({})
    //     } catch (err) {
    //         response.send({ error: err.toString(), code: 'request_failed' })
    //     }
    // })

    // RED.httpAdmin.get('/nr-tools/mqtt/status', (req, res) => {
    //     res.json({ connected: connectionManager.connected })
    // })
    // // Publish a test message
    // RED.httpAdmin.post('/nr-tools/mqtt/publish',  (req, res) => {
    //     const { topic, payload } = req.body;
    //     connectionManager.publish(topic, payload)
    //     res.json({ success: true })
    // })
}

module.exports = {
    setupRoutes
}
