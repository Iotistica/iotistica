module.exports = {
    uiPort: process.env.PORT || 1880,

    mqttReconnectTime: 15000,
    serialReconnectTime: 15000,
    debugMaxLength: 1000,

    flowFile: 'flows.json',
    credentialSecret: process.env.NR_CREDENTIAL_SECRET || false,

    // Keep UI auth optional. Storage auth r5555emains enabled via IOTISTIC_NR_TOKEN.
    adminAuth: (process.env.NODE_RED_ENABLE_UI_AUTH === 'true' && process.env.IOTISTIC_BASE_URL)
        ? require('@iotistic/nr-auth')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            provisioningURL: process.env.IOTISTIC_PROVISIONING_URL,
            uiPort: process.env.PORT || 1880
        })
        : null,

    storageModule: (() => {
        const hasBaseUrl = process.env.IOTISTIC_BASE_URL;
        const hasToken = process.env.IOTISTIC_NR_TOKEN;
        
        if (!hasBaseUrl) {
            console.warn('[Settings] Storage: IOTISTIC_BASE_URL not set, using filesystem storage');
            return undefined;
        }
        if (!hasToken) {
            console.warn('[Settings] Storage: IOTISTIC_NR_TOKEN not set, using filesystem storage');
            return undefined;
        }
        
        console.log('[Settings] Storage: Initializing nr-storage plugin', {
            baseUrl: hasBaseUrl,
            hasToken: !!hasToken
        });
        
        return require('@iotistic/nr-storage')({
            iotisticURL: process.env.IOTISTIC_BASE_URL,
            token: process.env.IOTISTIC_NR_TOKEN
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

    // Custom HTTP middleware to set CSP headers
    // CSP can be customized via environment variables
    httpAdminMiddleware: (req, res, next) => {
        // Frame ancestors can be set via ENV, defaults to localhost + production domains
        const frameAncestors = process.env.NODE_RED_FRAME_ANCESTORS || 
            "'self' https://*.iotistica.com https://*.iotistic.ca http://localhost:* http://*:30*"
        
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
