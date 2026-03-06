module.exports = {
    uiPort: process.env.PORT || 1880,

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    flowFile: 'flows.json',
    credentialSecret: process.env.NR_CREDENTIAL_SECRET || false,

    adminAuth: process.env.IOTISTIC_BASE_URL
        ? require('@iotistic/nr-auth')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            uiPort: process.env.PORT || 1880
        })
        : null,

    storageModule: (process.env.IOTISTIC_BASE_URL && process.env.IOTISTIC_NR_TOKEN)
        ? require('@iotistic/nr-storage')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            token: process.env.IOTISTIC_NR_TOKEN
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
        // Allow embedding from dashboard origins
        // Patterns: https://dash*.iotistica.com, https://client-*.iotistic.ca
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
            "style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data: https:; " +
            "font-src 'self' data:; " +
            "connect-src 'self' wss: ws: https: http:; " +
            "frame-ancestors 'self' https://*.iotistica.com https://*.iotistic.ca"
        );
        next();
    }
}
