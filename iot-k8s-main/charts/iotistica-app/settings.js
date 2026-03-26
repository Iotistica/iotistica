module.exports = {
    uiPort: process.env.PORT || 1880,

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    flowFile: 'flows.json',
    credentialSecret: process.env.NR_CREDENTIAL_SECRET || false,

    // Auth disabled - flows accessible without login
    adminAuth: null,

    // Storage: uses TOKEN env var to authenticate with API for flow persistence
    storageModule: process.env.TOKEN
        ? require('@iotistic/nr-storage')({
            iotisticURL: process.env.IOTISTIC_BASE_URL || 'http://localhost:3002',
            token: process.env.TOKEN
        })
        : undefined,

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

    // Custom HTTP middleware to set CSP headers
    httpAdminMiddleware: (req, res, next) => {
        const frameAncestors = process.env.NODE_RED_FRAME_ANCESTORS ||
            "'self' https://*.iotistica.com https://*.iotistica.com http://localhost:* http://*:30*"
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

        if (process.env.NODE_RED_CSP_HEADER) {
            res.setHeader('Content-Security-Policy', process.env.NODE_RED_CSP_HEADER)
        }

        next();
    }
};
