module.exports = {
    uiPort: process.env.PORT || 1880,

    // Disable built-in CORS - handled by custom auth middleware
    httpAdminCors: false,

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    flowFile: 'flows.json',
    credentialSecret: process.env.NR_CREDENTIAL_SECRET || false,

    // Shared auth token storage (set by httpAdminMiddleware, read by storage plugin)
    // This is populated from the session by middleware below
    _auth: {
        currentToken: null
    },

    // Keep UI auth optional. Storage auth remains enabled via Auth0 tokens.
    // For local dev, set NODE_RED_ENABLE_UI_AUTH=false to disable iframe auth complications
    adminAuth: (process.env.NODE_RED_ENABLE_UI_AUTH === 'true' && process.env.IOTISTIC_BASE_URL)
        ? require('@iotistic/nr-auth')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            provisioningURL: process.env.IOTISTIC_PROVISIONING_URL,
            uiPort: process.env.PORT || 1880,
            auth0Domain: process.env.AUTH0_DOMAIN,
            auth0Audience: process.env.AUTH0_AUDIENCE,
            auth0Issuer: process.env.AUTH0_ISSUER
        })
        : null,

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
        theme: 'dracula'
    },

    functionExternalModules: true,

    // Custom HTTP middleware to extract Auth0 token from session and set CSP headers
    // CSP can be customized via environment variables
    httpAdminMiddleware: (req, res, next) => {
        // Extract Auth0 token from session for storage module
        if (req.session && req.session.auth0Token) {
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
