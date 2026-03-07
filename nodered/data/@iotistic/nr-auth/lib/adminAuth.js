const fetch = require('undici').fetch
const axios = require('axios')
const jwt = require('jsonwebtoken')
const crypto = require('crypto')

const TOKEN_LOGIN_SENTINELS = new Set([
    '__token__',
    '__access_token__',
    'token',
    'access-token'
])

// In-memory JWKS cache (simple for Node-RED context)
let jwksCache = null
let jwksCacheTimestamp = 0
const JWKS_CACHE_TTL_MS = 3600000 // 1 hour

/**
 * Fetch Auth0 JWKS (JSON Web Key Set) with caching
 */
async function getAuth0JWKS(auth0Issuer) {
    const now = Date.now()
    if (jwksCache && (now - jwksCacheTimestamp < JWKS_CACHE_TTL_MS)) {
        return jwksCache
    }

    try {
        const response = await axios.get(`${auth0Issuer}.well-known/jwks.json`, {
            timeout: 5000
        })

        if (!response.data?.keys) {
            throw new Error('Invalid JWKS response: missing keys array')
        }

        jwksCache = response.data
        jwksCacheTimestamp = now
        console.log('[adminAuth] JWKS fetched and cached from Auth0')
        return jwksCache
    } catch (error) {
        console.error('[adminAuth] Failed to fetch JWKS from Auth0:', error.message)
        throw new Error(`Cannot fetch Auth0 JWKS: ${error.message}`)
    }
}

/**
 * Get Public Key from JWKS by Key ID (kid)
 */
function getPublicKeyFromJWKS(jwks, kid) {
    const key = jwks.keys.find((k) => k.kid === kid)

    if (!key) {
        throw new Error(`Key ID ${kid} not found in Auth0 JWKS`)
    }

    // Convert JWK to PEM format
    const publicKey = crypto.createPublicKey({ key, format: 'jwk' })
    return publicKey.export({ format: 'pem', type: 'spki' })
}

/**
 * Validate Auth0 JWT token (RS256)
 */
async function validateAuth0JWT(token, auth0Domain, auth0Audience, auth0Issuer) {
    if (!auth0Domain || !auth0Audience || !auth0Issuer) {
        throw new Error('Auth0 configuration missing (domain/audience/issuer required)')
    }

    // Decode without verification first to get kid
    const decoded = jwt.decode(token, { complete: true })

    if (!decoded) {
        throw new Error('Invalid JWT format')
    }

    // Validate algorithm is RS256 (reject HS256)
    if (decoded.header?.alg !== 'RS256') {
        throw new Error(`Invalid algorithm: ${decoded.header?.alg} (must be RS256)`)
    }

    // Get Key ID
    const kid = decoded.header?.kid
    if (!kid) {
        throw new Error('Missing Key ID (kid) in JWT header')
    }

    // Fetch JWKS and get public key
    const jwks = await getAuth0JWKS(auth0Issuer)
    const publicKey = getPublicKeyFromJWKS(jwks, kid)

    // Verify JWT signature and claims
    const payload = jwt.verify(token, publicKey, {
        algorithms: ['RS256'],
        issuer: auth0Issuer,
        audience: auth0Audience
    })

    // Additional validation
    if (!payload.sub || !payload.email) {
        throw new Error('Missing required claims: sub or email')
    }

    return {
        sub: payload.sub,
        email: payload.email,
        exp: payload.exp,
        username: payload.email
    }
}

module.exports = (options) => {
    if (!options.iotisticURL) {
        throw new Error('Missing configuration option iotisticURL')
    }

    const iotisticURL = options.iotisticURL
    const loginURL = `${iotisticURL}/api/v1/auth/login`
    const refreshURL = `${iotisticURL}/api/v1/auth/refresh`
    const userInfoURL = `${iotisticURL}/api/v1/auth/me`
    const activeUsers = {}

    function decodeJwtPayload (token) {
        try {
            const parts = token.split('.')
            if (parts.length !== 3) {
                return null
            }
            return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'))
        } catch (err) {
            return null
        }
    }

    function getRefreshDelayMs (accessToken) {
        const payload = decodeJwtPayload(accessToken)
        if (!payload || !payload.exp) {
            return 10 * 60 * 1000
        }

        const nowSeconds = Math.floor(Date.now() / 1000)
        const secondsUntilExpiry = payload.exp - nowSeconds
        const refreshLeadSeconds = 60
        const refreshInSeconds = Math.max(30, secondsUntilExpiry - refreshLeadSeconds)
        return refreshInSeconds * 1000
    }

    function buildPermissions (user) {
        if (user && user.role === 'admin') {
            return ['*']
        }
        return ['read']
    }

    function normalizeProfileFromApiUser (user, accessToken, refreshToken) {
        const username = user.username || user.email || user.auth0Sub || user.id
        return {
            username,
            image: user.avatar || '',
            name: user.fullName || user.name || username,
            email: user.email,
            role: user.role || 'user',
            customerId: user.customerId,
            permissions: buildPermissions(user),
            accessToken,
            refreshToken: refreshToken || null
        }
    }

    async function fetchProfileFromAccessToken (accessToken, refreshToken) {
        try {
            const response = await fetch(userInfoURL, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            })

            if (!response.ok) {
                return null
            }

            const data = await response.json()
            const user = data && data.data && data.data.user
            if (!user) {
                return null
            }

            return normalizeProfileFromApiUser(user, accessToken, refreshToken)
        } catch (err) {
            console.error('Failed to validate access token with /auth/me:', err)
            return null
        }
    }

    function clearUser (username) {
        const existing = activeUsers[username]
        if (existing && existing.refreshTimeout) {
            clearTimeout(existing.refreshTimeout)
        }
        delete activeUsers[username]
    }

    async function refreshUserToken (username) {
        const user = activeUsers[username]
        if (!user || !user.refreshToken) {
            clearUser(username)
            return
        }

        try {
            const response = await fetch(refreshURL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken: user.refreshToken })
            })

            if (!response.ok) {
                console.error('Token refresh failed for user', username)
                clearUser(username)
                return
            }

            const data = await response.json()
            const refreshedAccessToken = data && data.data && data.data.accessToken
            const refreshedRefreshToken = (data && data.data && data.data.refreshToken) || user.refreshToken
            if (!refreshedAccessToken) {
                console.error('Refresh response did not include accessToken for user', username)
                clearUser(username)
                return
            }

            const refreshedProfile = await fetchProfileFromAccessToken(refreshedAccessToken, refreshedRefreshToken)
            if (!refreshedProfile) {
                console.error('Token refresh validation failed for user', username)
                clearUser(username)
                return
            }

            addUser(refreshedProfile.username, refreshedProfile, refreshedAccessToken, refreshedRefreshToken)
            console.log('Refreshed JWT token for user', refreshedProfile.username)
        } catch (err) {
            console.error('Token refresh error:', err)
            clearUser(username)
        }
    }

    function addUser (username, profile, accessToken, refreshToken) {
        clearUser(username)

        activeUsers[username] = {
            profile,
            accessToken,
            refreshToken: refreshToken || null
        }

        if (refreshToken) {
            const refreshDelayMs = getRefreshDelayMs(accessToken)
            activeUsers[username].refreshTimeout = setTimeout(function () {
                refreshUserToken(username)
            }, refreshDelayMs)
        }
    }

    function findActiveUserByToken (token) {
        const entries = Object.keys(activeUsers)
        for (const key of entries) {
            const user = activeUsers[key]
            if (user && user.accessToken === token) {
                return user.profile
            }
        }
        return null
    }

    async function authenticateWithPassword (username, password) {
        const response = await fetch(loginURL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        })

        if (!response.ok) {
            console.error('Login failed:', response.status)
            return null
        }

        const data = await response.json()
        const accessToken = data && data.data && data.data.accessToken
        const refreshToken = data && data.data && data.data.refreshToken
        if (!accessToken) {
            return null
        }

        const profile = await fetchProfileFromAccessToken(accessToken, refreshToken)
        if (!profile) {
            return null
        }

        addUser(profile.username, profile, accessToken, refreshToken)
        console.log('JWT authenticated user:', profile.username)
        return profile
    }

    async function authenticateWithAccessToken (accessToken) {
        const profile = await fetchProfileFromAccessToken(accessToken)
        if (!profile) {
            return null
        }

        addUser(profile.username, profile, accessToken, null)
        console.log('SSO token authenticated user:', profile.username)
        return profile
    }

    async function exchangeBridgeToken (bridgeToken) {
        const provisioning_url = options.provisioning_url || iotisticURL
        const exchangeURL = `${provisioning_url}/api/auth/exchange-bridge-token`
        
        try {
            const response = await fetch(exchangeURL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${bridgeToken}`
                }
            })
            
            if (!response.ok) {
                console.error('[adminAuth] Bridge token exchange failed:', response.status)
                return null
            }
            
            const data = await response.json()
            const accessToken = data.accessToken
            const refreshToken = data.refreshToken
            
            if (!accessToken) {
                console.error('[adminAuth] No accessToken in bridge exchange response')
                return null
            }
            
            const profile = await fetchProfileFromAccessToken(accessToken, refreshToken)
            if (!profile) {
                console.error('[adminAuth] Profile validation failed after bridge exchange')
                return null
            }

            addUser(profile.username, profile, accessToken, refreshToken)
            console.log('[adminAuth] Bridge token exchanged successfully for user:', profile.username)
            return profile
        } catch (err) {
            console.error('[adminAuth] Bridge token exchange error:', err)
            return null
        }
    }

    function looksLikeJwt (value) {
        return typeof value === 'string' && value.split('.').length === 3
    }

    return {
        type: 'credentials',
        users: async function (username) {
            const user = activeUsers[username]
            if (user) {
                user.profile.accessToken = user.accessToken
                return user.profile
            }
            return null
        },
        tokens: async function (token) {
            if (!token) {
                return null
            }

            const active = findActiveUserByToken(token)
            if (active) {
                return active
            }

            return authenticateWithAccessToken(token)
        },
        authenticate: async function (username, password) {
            try {
                // Check for Auth0 token (RS256) - prioritize Auth0 before legacy
                const candidateToken = looksLikeJwt(password) ? password : (looksLikeJwt(username) ? username : null)
                if (candidateToken) {
                    const decoded = jwt.decode(candidateToken, { complete: true })
                    
                    // If RS256 algorithm, it's an Auth0 token
                    if (decoded?.header?.alg === 'RS256') {
                        console.log('[adminAuth] Auth0 token detected, validating...')
                        try {
                            const payload = await validateAuth0JWT(
                                candidateToken,
                                options.auth0Domain,
                                options.auth0Audience,
                                options.auth0Issuer
                            )
                            
                            const profile = {
                                username: payload.email,
                                email: payload.email,
                                name: payload.email,
                                image: '',
                                permissions: ['*'],
                                accessToken: candidateToken,
                                refreshToken: null
                            }
                            
                            addUser(profile.username, profile, candidateToken, null)
                            console.log('[adminAuth] Auth0 token validated for user:', profile.username)
                            return profile
                        } catch (error) {
                            console.error('[adminAuth] Auth0 token validation failed:', error.message)
                            return null
                        }
                    }
                }
                
                // Check for bridge token in request object (passed from httpAuthMiddleware)
                if (username && username.startsWith('__bridgeToken__:')) {
                    const bridgeToken = username.substring('__bridgeToken__:'.length)
                    console.log('[adminAuth] Bridge token detected, exchanging for access token...')
                    const profile = await exchangeBridgeToken(bridgeToken)
                    if (profile) {
                        console.log('[adminAuth] Bridge token exchanged successfully for user:', profile.username)
                        return profile
                    }
                    return null
                }

                const tokenMode = TOKEN_LOGIN_SENTINELS.has((username || '').toLowerCase()) || looksLikeJwt(password)
                if (tokenMode) {
                    const candidateToken = looksLikeJwt(password) ? password : username
                    if (!looksLikeJwt(candidateToken)) {
                        return null
                    }
                    return authenticateWithAccessToken(candidateToken)
                }

                return authenticateWithPassword(username, password)
            } catch (err) {
                console.error('Authentication error:', err)
                return null
            }
        },
        default: function () {
            return Promise.resolve(null)
        }
    }
}
