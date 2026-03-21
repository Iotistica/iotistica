const isUiAuthEnabled = process.env.NODE_RED_ENABLE_UI_AUTH === 'true'
const authProvider = (process.env.NODE_RED_AUTH_PROVIDER || '').toLowerCase()

function requireEnv(name) {
    const value = process.env[name]
    if (!value) {
        throw new Error(`[settings.js] Missing required environment variable: ${name}`)
    }
    return value
}

function buildAdminAuth() {
    if (!isUiAuthEnabled) {
        return null
    }

    if (authProvider === 'auth0-strategy') {
        const BaseAuth0Strategy = require('passport-auth0').Strategy

        const callbackURL = requireEnv('NODE_RED_AUTH0_CALLBACK_URL')
        const audience = process.env.AUTH0_AUDIENCE

        const auth0TokenCache = new Map()

        const strategyOptions = {
            domain: requireEnv('AUTH0_DOMAIN'),
            clientID: requireEnv('AUTH0_CLIENT_ID'),
            clientSecret: requireEnv('AUTH0_CLIENT_SECRET'),
            callbackURL,
            issuer: process.env.AUTH0_ISSUER || `https://${requireEnv('AUTH0_DOMAIN')}/`,
            state: false,
            passReqToCallback: true,
            scope: 'openid profile email'
        }

        if (audience) {
            strategyOptions.audience = audience
        }

        strategyOptions.verify = function (req, accessToken, refreshToken, extraParams, profile, done) {
            const idToken = extraParams && extraParams.id_token ? extraParams.id_token : null
            const decodedIdToken = (() => {
                if (!idToken || typeof idToken !== 'string') {
                    return null
                }
                try {
                    const payload = idToken.split('.')[1]
                    if (!payload) {
                        return null
                    }
                    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
                } catch (_err) {
                    return null
                }
            })()

            const emailFromClaims = decodedIdToken && (decodedIdToken.email || decodedIdToken['https://iotistica.com/email'])
            const subFromClaims = decodedIdToken && decodedIdToken.sub
            const fallbackUsername = subFromClaims || 'auth0-user'

            const email = (profile && profile.emails && profile.emails[0] && profile.emails[0].value) || emailFromClaims || null
            const username = email || (profile && profile.id) || fallbackUsername

            const resolvedUser = {
                username,
                email,
                idToken,
                accessToken,
                refreshToken,
                profile: profile || decodedIdToken || null
            }

            // Node-RED may later resolve users by username string only. Cache token data so
            // users() can rehydrate accessToken/refreshToken for subsequent httpAdmin requests.
            auth0TokenCache.set(username, {
                idToken: idToken || null,
                accessToken: accessToken || null,
                refreshToken: refreshToken || null,
                email: email || null,
                profile: profile || decodedIdToken || null
            })

            // Persist tokens into session explicitly so downstream middleware/routes can read them.
            if (req && req.session) {
                req.session.auth0IdToken = idToken || null
                req.session.auth0Token = accessToken || null
                req.session.auth0RefreshToken = refreshToken || null
            }

            done(null, resolvedUser)
        }

        return {
            type: 'strategy',
            strategy: {
                name: 'auth0',
                label: 'Login with Auth0',
                icon: 'fa-lock',
                strategy: BaseAuth0Strategy,
                options: strategyOptions
            },
            users: function (user) {
                if (!user) {
                    return Promise.resolve(null)
                }

                const username = typeof user === 'string' ? user : (user.username || user.email || user.id || 'auth0-user')
                const cached = auth0TokenCache.get(username) || null

                const accessToken = typeof user === 'object'
                    ? (user.accessToken || user.__accessToken || (cached && cached.accessToken) || null)
                    : ((cached && cached.accessToken) || null)

                const idToken = typeof user === 'object'
                    ? (user.idToken || user.id_token || user.__idToken || (cached && cached.idToken) || null)
                    : ((cached && cached.idToken) || null)

                const refreshToken = typeof user === 'object'
                    ? (user.refreshToken || user.__refreshToken || (cached && cached.refreshToken) || null)
                    : ((cached && cached.refreshToken) || null)

                if (!cached && accessToken) {
                    auth0TokenCache.set(username, {
                        idToken,
                        accessToken,
                        refreshToken,
                        email: (typeof user === 'object' && user.email) ? user.email : null,
                        profile: (typeof user === 'object' && user.profile) ? user.profile : null
                    })
                }

                return Promise.resolve({
                    username,
                    permissions: '*',
                    idToken,
                    accessToken,
                    refreshToken
                })
            }
        }
    }

    if (authProvider === 'none') {
        return null
    }

    throw new Error(
        `[settings.js] Unsupported NODE_RED_AUTH_PROVIDER='${authProvider}'. Supported values: 'auth0-strategy', 'none'`
    )
}

module.exports = {
    uiPort: process.env.PORT || 1880,

    // Ensure admin auth cookies persist in local development (localhost:1880).
    // SameSite Lax works for same-site localhost ports while avoiding Secure requirement.
    httpAdminCookieOptions: {
        sameSite: process.env.NODE_RED_COOKIE_SAMESITE || 'lax',
        secure: process.env.NODE_RED_COOKIE_SECURE === 'true'
    },

    // Disable built-in CORS - handled by custom auth middleware
    httpAdminCors: false,

    // Explicit CORS policy for httpNode routes (includes /admin/auth/token bridge endpoint).
    // Must NOT use wildcard origin when credentials are included.
    httpNodeCors: {
        origin: (origin, callback) => {
            // Allow non-browser/internal requests with no Origin header.
            if (!origin) {
                return callback(null, true)
            }

            const raw = process.env.NODE_RED_ALLOWED_ORIGINS || 'http://localhost:8080,http://127.0.0.1:8080,http://localhost:5173,http://127.0.0.1:5173'
            const allowedOrigins = raw.split(',').map((v) => v.trim()).filter(Boolean)

            if (allowedOrigins.includes(origin)) {
                return callback(null, true)
            }

            return callback(new Error(`CORS origin not allowed: ${origin}`))
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
    },

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    flowFile: 'flows.json',
    credentialSecret: process.env.NR_CREDENTIAL_SECRET || false,

        // Required for passport-auth0 OAuth state validation across redirect/callback.
        // Without this, session cookies are not stable and OAuth state check fails → 401.
        expressSessionSecret: process.env.NR_SESSION_SECRET || 'nr-iotistic-session-secret',

    // Shared auth token storage (set by httpAdminMiddleware, read by storage plugin)
    // This is populated from the session by middleware below
    _auth: {
        currentToken: null
    },

    // Keep UI auth optional. Storage auth remains enabled via Auth0 tokens.
    // For local dev, set NODE_RED_ENABLE_UI_AUTH=false to disable iframe auth complications
    adminAuth: buildAdminAuth(),

    storageModule: (() => {
        const remoteStorageEnabled = process.env.NODE_RED_REMOTE_STORAGE === 'true';
        const hasBaseUrl = process.env.IOTISTIC_BASE_URL;

        if (!remoteStorageEnabled) {
            console.log('[Settings] Storage: Remote storage disabled (NODE_RED_REMOTE_STORAGE != true), using filesystem storage');
            return undefined;
        }

        if (!hasBaseUrl) {
            console.warn('[Settings] Storage: NODE_RED_REMOTE_STORAGE=true but IOTISTIC_BASE_URL not set, using filesystem storage');
            return undefined;
        }

        console.log('[Settings] Storage: Initializing nr-storage plugin with Auth0 token getter');
        const storageAuthMode = (process.env.NODE_RED_STORAGE_AUTH_MODE || 'auto').toLowerCase();
        const isJwtLike = (value) => typeof value === 'string' && value.split('.').length === 3;
        
        return require('@iotistic/nr-storage')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            getAuthToken: () => {
                if (storageAuthMode === 'off' || storageAuthMode === 'none' || storageAuthMode === 'disabled') {
                    // Explicit no-auth mode: do not send Authorization header.
                    return null;
                }

                const token = module.exports._auth.currentToken;
                if (token) {
                    if (storageAuthMode === 'bootstrap' || isJwtLike(token)) {
                        return token;
                    }
                    // Prevent opaque/non-JWT session tokens from triggering 401 "Invalid token format"
                    return null;
                }

                // Bootstrap token for startup/background storage calls before user session exists.
                // In interactive flows, middleware will replace this with per-user Auth0 token.
                const bootstrapToken = process.env.IOTISTIC_STORAGE_TOKEN;
                if (bootstrapToken) {
                    if (storageAuthMode === 'bootstrap') {
                        return bootstrapToken;
                    }
                    // auto mode: only send JWT-like bearer tokens
                    if (isJwtLike(bootstrapToken)) {
                        return bootstrapToken;
                    }
                    return null;
                }

                // In auto mode, allow unauthenticated startup calls.
                // If backend requires auth it will return 401 and logs will indicate missing token.
                return null;
            }
        });
    })(),

    logging: {
        console: {
            level: process.env.LOG_LEVEL || 'info',
            metrics: false,
            audit: false
        }
    },

    editorTheme: {
        page: {
            title: process.env.NODERED_TITLE || 'Iotistic - Node-RED'
        },
        header: {
            title: process.env.NODERED_TITLE || 'Iotistic'
        },
        theme: 'dracula',
        tours: false,
        updateCheck: {
            enabled: false
        }
    },

    functionExternalModules: true,

    // Custom HTTP middleware to extract Auth0 token from session and set CSP headers
    // CSP can be customized via environment variables
    httpAdminMiddleware: (req, res, next) => {
        // Extract Auth0 token from session for storage module
        if (req.user && req.user.idToken) {
            module.exports._auth.currentToken = req.user.idToken;
        } else if (req.session && req.session.auth0IdToken) {
            module.exports._auth.currentToken = req.session.auth0IdToken;
        } else if (req.session && req.session.user && req.session.user.idToken) {
            module.exports._auth.currentToken = req.session.user.idToken;
        } else if (req.user && req.user.accessToken) {
            module.exports._auth.currentToken = req.user.accessToken;
        } else if (req.session && req.session.auth0Token) {
            module.exports._auth.currentToken = req.session.auth0Token;
        } else if (req.session && req.session.user && req.session.user.accessToken) {
            // Fallback: get from user object (legacy auth flow)
            module.exports._auth.currentToken = req.session.user.accessToken;
        }
        
        // Frame ancestors can be set via ENV, defaults to localhost + production domains
        const frameAncestors = process.env.NODE_RED_FRAME_ANCESTORS || 
            "'self' https://*.iotistica.com https://*.iotistic.ca http://localhost:* http://127.0.0.1:*"
        
        // Font sources can be customized via ENV
        const fontSrc = process.env.NODE_RED_FONT_SRC || 
            "'self' data: https: http:"
        
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
            "style-src 'self' 'unsafe-inline' https:; " +
            "img-src 'self' data: https: http:; " +
            `font-src ${fontSrc}; ` +
            "connect-src 'self' wss: ws: https: http:; " +
            `frame-ancestors ${frameAncestors}`
        );
        
        // Allow overriding specific headers via env
        if (process.env.NODE_RED_CSP_HEADER) {
            res.setHeader('Content-Security-Policy', process.env.NODE_RED_CSP_HEADER)
        }
        
        next();
    }
}
