const settings = require('../settings')
const { ffPost } = require('../client')

function getUserForRequest (request) {
    let sessionUsername = '_'
    if (request.user) {
        console.log('User:', request.user)
        // adminAuth is configured
        sessionUsername = request.user.username || '_'
    }
    return sessionUsername
}

function deleteUserTokenForRequest (request) {
    // Legacy plugin-token cache removed (Auth0-only mode).
    // Keep exported function as no-op for compatibility with existing callers.
    return request
}

function needsIotToken (request, response, next) {
    // Bearer-only mode: no fallback to session token.
    const authHeader = request.headers.authorization
    const authHeaderPresent = !!authHeader
    const path = request.originalUrl || request.url
    const method = request.method || 'UNKNOWN'

    console.log('[nr-tools][auth] Incoming request', {
        method,
        path,
        hasAuthorizationHeader: authHeaderPresent
    })

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1]
        console.log('[nr-tools][auth] Bearer token received', {
            method,
            path,
            tokenSegments: typeof token === 'string' ? token.split('.').length : 0,
            tokenLength: typeof token === 'string' ? token.length : 0
        })

        if (typeof token === 'string' && token.length > 0) {
            request.iotToken = token
            console.log('[nr-tools][auth] Accepted bearer token', { method, path })
            return next()
        }

        console.warn('[nr-tools][auth] Rejected bearer token: empty token', { method, path })
    }
    
    // No valid token found
    console.warn('[nr-tools][auth] Request rejected: missing bearer token', {
        method,
        path,
        hasAuthorizationHeader: authHeaderPresent
    })
    return response.status(401).end()
}

function setupRoutes (RED) {
    // ** All routes after this point must have a valid Node-RED session user **
    RED.httpAdmin.use('/nr-tools/*', RED.auth.needsPermission('flowfuse.write'))

    RED.httpAdmin.post('/nr-tools/auth/login', async (request, response) => {
        return response.status(410).send({
            error: 'Legacy plugin login removed. Use dashboard Auth0 flow.',
            code: 'legacy_login_removed'
        })
    })
    RED.httpAdmin.post('/nr-tools/auth/logout', async (request, response) => {
        try {
            const token = request.user && request.user.accessToken
                ? { accessToken: request.user.accessToken }
                : null
            if (token && token.accessToken) {
                await ffPost('/api/v1/auth/logout', token.accessToken)
            }
            deleteUserTokenForRequest(request)
            response.send({ success: true })
        } catch (err) {
            RED.log.error(`[nr-tools] Failed to logout: ${err.toString()}`)
            // Still delete local token even if server logout fails
            deleteUserTokenForRequest(request)
            response.send({ success: true })
        }
    })
}

module.exports = {
    setupRoutes,
    deleteUserTokenForRequest,
    needsIotToken
}
