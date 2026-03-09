module.exports = {
    uiPort: process.env.PORT || 1880,

    // CORS for dashboard -> Node-RED admin auth bridge.
    // Credentialed requests cannot use wildcard origin.
    httpAdminCors: {
        origin: (origin, callback) => {
            const allowed = (process.env.NODE_RED_ADMIN_CORS_ORIGIN || 'http://localhost:8080')
                .split(',')
                .map((o) => o.trim())
                .filter(Boolean);

            // Allow non-browser requests (no Origin) and explicit allowlist entries.
            if (!origin || allowed.includes(origin)) {
                callback(null, true);
                return;
            }

            callback(new Error(`CORS origin not allowed: ${origin}`));
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
        
        return require('@iotistic/nr-storage')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            getAuthToken: () => {
                const token = module.exports._auth.currentToken;
                if (token) {
                    return token;
                }

                // Bootstrap token for startup/background storage calls before user session exists.
                // In interactive flows, middleware will replace this with per-user Auth0 token.
                const bootstrapToken = process.env.IOTISTIC_STORAGE_TOKEN;
                if (bootstrapToken) {
                    return bootstrapToken;
                }

                throw new Error('[nr-storage] No Auth0 session token and no IOTISTIC_STORAGE_TOKEN configured');
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

    // Custom HTTP middleware to set CSP headers and extract Auth0 token from session
    // CSP can be customized via environment variables
    httpAdminMiddleware: (req, res, next) => {
        // Local/dev token bridge endpoint (kept in middleware so it always exists)
        if (req.path === '/admin/auth/token') {
            // Let httpAdminCors handle CORS headers - don't set them manually here
            
            if (req.method === 'OPTIONS') {
                res.status(204).end();
                return;
            }

            if (req.method === 'POST') {
                const authHeader = req.headers.authorization || '';
                const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
                const bodyToken = req.body && typeof req.body.token === 'string' ? req.body.token : null;

                const finalize = (resolvedBodyToken) => {
                    const token = resolvedBodyToken || bearer;
                    if (!token) {
                        res.status(400).json({ error: 'Token required' });
                        return;
                    }

                    // Ensure session exists (raw request listener fires before session middleware)
                    if (!req.session) {
                        req.session = {};
                    }

                    req.session.auth0Token = token;
                    req.session.iotSession = true;
                    req.session.user = req.session.user || { accessToken: token };

                    // Save session if save() method exists (express-session middleware)
                    // If session was manually created, just respond (session will be set by express middleware later)
                    if (typeof req.session.save === 'function') {
                        req.session.save((err) => {
                            if (err) {
                                res.status(500).json({ error: 'Failed to save session', details: err.message });
                                return;
                            }
                            res.json({ success: true });
                        });
                    } else {
                        // Session exists but no save() method - just respond
                        // Express will handle session persistence
                        res.json({ success: true });
                    }
                };

                if (bodyToken) {
                    finalize(bodyToken);
                    return;
                }

                // Fallback: parse raw JSON body when body parser has not executed yet.
                let raw = '';
                req.on('data', (chunk) => {
                    raw += chunk;
                });
                req.on('end', () => {
                    try {
                        const parsed = raw ? JSON.parse(raw) : {};
                        const parsedToken = typeof parsed.token === 'string' ? parsed.token : null;
                        finalize(parsedToken);
                    } catch {
                        finalize(null);
                    }
                });
                return;
            }
        }

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
