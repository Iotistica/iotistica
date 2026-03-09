"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const http_proxy_middleware_1 = require("http-proxy-middleware");
const brotli_decompression_1 = require("./middleware/brotli-decompression");
const request_id_1 = require("./middleware/request-id");
const logger_1 = __importDefault(require("./utils/logger"));
const auth_1 = __importDefault(require("./routes/auth"));
const users_1 = __importDefault(require("./routes/users"));
const agent_state_1 = __importDefault(require("./routes/agent-state"));
const agent_logs_1 = __importDefault(require("./routes/agent-logs"));
const agent_metrics_1 = __importDefault(require("./routes/agent-metrics"));
const provisioning_1 = __importDefault(require("./routes/provisioning"));
const agents_1 = __importDefault(require("./routes/agents"));
const admin_1 = __importDefault(require("./routes/admin"));
const apps_1 = __importDefault(require("./routes/apps"));
const image_registry_1 = __importDefault(require("./routes/image-registry"));
const agent_jobs_1 = __importDefault(require("./routes/agent-jobs"));
const rotation_1 = __importDefault(require("./routes/rotation"));
const digital_twin_graph_1 = __importDefault(require("./routes/digital-twin-graph"));
const events_1 = __importDefault(require("./routes/events"));
const mqtt_broker_1 = __importDefault(require("./mqtt/mqtt-broker"));
const mqtt_metrics_1 = __importDefault(require("./mqtt/mqtt-metrics"));
const agent_devices_1 = require("./routes/agent-devices");
const traffic_1 = require("./routes/traffic");
const agent_tags_1 = require("./routes/agent-tags");
const dashboard_layouts_1 = __importDefault(require("./routes/dashboard-layouts"));
const mqtt_auth_1 = __importDefault(require("./mqtt/mqtt-auth"));
const nodered_storage_1 = require("./routes/nodered-storage");
const metrics_catalog_1 = require("./routes/metrics-catalog");
const traffic_logger_1 = require("./middleware/traffic-logger");
const traffic_flush_service_1 = require("./services/traffic-flush.service");
const prometheus_1 = __importDefault(require("./routes/prometheus"));
const endpoints_data_1 = __importDefault(require("./routes/endpoints-data"));
const anomaly_1 = __importDefault(require("./routes/anomaly"));
const anomaly_incidents_1 = __importDefault(require("./routes/anomaly-incidents"));
const anomaly_alerts_1 = __importDefault(require("./routes/anomaly-alerts"));
const profiles_1 = __importDefault(require("./routes/profiles"));
const ai_chat_1 = __importDefault(require("./routes/ai-chat"));
const rate_limit_1 = require("./middleware/rate-limit");
const job_scheduler_1 = require("./services/job-scheduler");
const connection_1 = require("./db/connection");
const mqtt_1 = require("./mqtt");
const license_validator_1 = require("./services/license-validator");
const license_1 = __importDefault(require("./routes/license"));
const jwt_auth_1 = __importDefault(require("./middleware/jwt-auth"));
const billing_1 = __importDefault(require("./routes/billing"));
const fleets_1 = __importDefault(require("./routes/fleets"));
const websocket_manager_1 = require("./services/websocket-manager");
const https_server_1 = require("./https-server");
const API_VERSION = process.env.API_VERSION || 'v1';
const API_BASE = `/api/${API_VERSION}`;
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3002;
const RUNNING_IN_K8S = process.env.KUBERNETES_SERVICE_HOST !== undefined;
const EXPLICIT_TRUST_PROXY = process.env.TRUST_PROXY;
const AUTO_TRUST_PROXY = RUNNING_IN_K8S ? 1 : false;
const TRUST_PROXY = EXPLICIT_TRUST_PROXY !== undefined ? EXPLICIT_TRUST_PROXY : (AUTO_TRUST_PROXY ? 'true' : 'false');
if (TRUST_PROXY !== 'false') {
    const trustProxyValue = TRUST_PROXY === 'true' ? 1 : parseInt(TRUST_PROXY, 10);
    app.set('trust proxy', trustProxyValue);
    logger_1.default.info(`[OK] Trust proxy enabled: ${trustProxyValue} hop(s) (automatically enabled in K8s, behind Envoy Gateway)`);
}
else {
    logger_1.default.info('Trust proxy disabled (direct deployment, not behind reverse proxy)');
}
app.use((0, helmet_1.default)({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'", "ws:", "wss:"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            fontSrc: ["'self'", "data:"],
            formAction: ["'self'"],
            upgradeInsecureRequests: [],
            blockAllMixedContent: [],
        },
    },
    frameguard: {
        action: 'deny',
    },
    noSniff: true,
    referrerPolicy: {
        policy: 'no-referrer',
    },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
    },
    crossOriginEmbedderPolicy: false,
    dnsPrefetchControl: {
        allow: false,
    },
    hidePoweredBy: true,
    xssFilter: true,
}));
const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : [
        'http://localhost:5173',
        'http://localhost:3001',
        'http://localhost:3000',
        'http://localhost:8080',
        'http://localhost:4002',
        'https://api1.iotistica.com',
        'http://api1.iotistica.com',
        'https://tsdbdash.iotistica.com'
    ];
if (allowedOrigins.includes('*')) {
    logger_1.default.error('CRITICAL: CORS_ORIGINS contains "*" which is insecure with credentials enabled');
    throw new Error('CORS misconfiguration: Cannot use "*" origin with credentials');
}
const hasWildcards = allowedOrigins.some(o => o.includes('*'));
if (hasWildcards) {
    logger_1.default.warn('CORS wildcard patterns detected - ensure these are intentional:', {
        origins: allowedOrigins.filter(o => o.includes('*'))
    });
}
const wildcardToRegExp = (pattern) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escaped.replace(/\\\*/g, '.*');
    return new RegExp(`^${regexPattern}$`);
};
const corsExemptPaths = [
    '/health',
    '/metrics',
    '/mosquitto-auth',
];
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) {
            return callback(null, true);
        }
        const isAllowed = allowedOrigins.some(allowed => {
            if (allowed.includes('*')) {
                return wildcardToRegExp(allowed).test(origin);
            }
            return allowed === origin;
        });
        if (isAllowed) {
            callback(null, true);
        }
        else {
            logger_1.default.warn('CORS: Rejected request from unauthorized origin', {
                origin,
                allowedOrigins: allowedOrigins.slice(0, 5)
            });
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-API-Key', 'X-Tenant-ID'],
    exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 86400
};
app.use((0, cors_1.default)(corsOptions));
app.options('*', (0, cors_1.default)(corsOptions));
app.use(brotli_decompression_1.brotliDecompressionMiddleware);
app.use(request_id_1.requestIdMiddleware);
app.use(express_1.default.json({
    limit: '16mb',
    inflate: true
}));
app.use(express_1.default.urlencoded({
    limit: '16mb',
    extended: true,
    inflate: true
}));
app.use(traffic_logger_1.trafficLogger);
app.use((req, res, next) => {
    const startTime = Date.now();
    const isMqttAuth = req.path === '/superuser' || req.path === '/acl';
    logger_1.default.debug(`${req.method} ${req.path}`, {
        method: req.method,
        path: req.path,
        query: req.query,
        ip: req.ip
    });
    res.on('finish', () => {
        const duration = Date.now() - startTime;
        if (res.statusCode === 200) {
            return;
        }
        const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : isMqttAuth ? 'debug' : 'info';
        logger_1.default[logLevel](`${res.statusCode} ${req.method} ${req.path} - ${duration}ms`);
    });
    next();
});
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        service: 'Iotistic Unified API',
        version: '2.0.0',
        apiVersion: API_VERSION,
        apiBase: API_BASE,
        documentation: '/api/docs'
    });
});
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});
const docs_1 = require("./docs");
(0, docs_1.setupApiDocs)(app, API_BASE);
app.use(prometheus_1.default);
app.use('/mosquitto-auth', mqtt_auth_1.default);
app.use(API_BASE, rate_limit_1.globalApiRateLimit);
app.use(`${API_BASE}/auth`, rate_limit_1.authRateLimit, auth_1.default);
console.log('[INDEX] Mounting devicesRoutes at', API_BASE);
app.use(API_BASE, agents_1.default);
app.use(`${API_BASE}/users`, jwt_auth_1.default, rate_limit_1.adminRateLimit, users_1.default);
app.use(`${API_BASE}/admin`, jwt_auth_1.default, rate_limit_1.adminRateLimit, admin_1.default);
app.use(API_BASE, rate_limit_1.deviceDataRateLimit, agent_logs_1.default);
app.use(API_BASE, rate_limit_1.deviceDataRateLimit, agent_metrics_1.default);
app.use(API_BASE, rate_limit_1.deviceDataRateLimit, agent_devices_1.router);
app.use(`${API_BASE}/endpoints`, rate_limit_1.deviceDataRateLimit, endpoints_data_1.default);
console.log('[INDEX] Mounting routes...');
app.use(API_BASE, license_1.default);
app.use(API_BASE, billing_1.default);
app.use(API_BASE, provisioning_1.default);
app.use(API_BASE, apps_1.default);
app.use(API_BASE, agent_state_1.default);
app.use(API_BASE, image_registry_1.default);
app.use(API_BASE, agent_jobs_1.default);
app.use(API_BASE, rotation_1.default);
app.use(API_BASE, fleets_1.default);
app.use(API_BASE, anomaly_1.default);
app.use(API_BASE, anomaly_incidents_1.default);
app.use(API_BASE, anomaly_alerts_1.default);
app.use(API_BASE, profiles_1.default);
app.use(API_BASE, digital_twin_graph_1.default);
app.use(API_BASE, mqtt_metrics_1.default);
app.use(API_BASE, events_1.default);
app.use(API_BASE, mqtt_broker_1.default);
app.use(API_BASE, traffic_1.router);
app.use(API_BASE, agent_tags_1.router);
app.use(`${API_BASE}/dashboard-layouts`, dashboard_layouts_1.default);
app.use(API_BASE, nodered_storage_1.router);
app.use(`${API_BASE}/metrics`, metrics_catalog_1.router);
app.use(API_BASE, ai_chat_1.default);
const MQTT_MONITOR_URL = process.env.MQTT_MONITOR_URL || 'http://mqtt-monitor:3500';
app.use(`${API_BASE}/mqtt-monitor`, jwt_auth_1.default, (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: `${MQTT_MONITOR_URL}/api/v1`,
    changeOrigin: true,
    on: {
        error: (err, req, res) => {
            logger_1.default.error('MQTT Monitor proxy error', { error: err.message });
            if ('status' in res && 'headersSent' in res && typeof res.status === 'function' && !res.headersSent) {
                res.status(502).json({ success: false, error: 'MQTT Monitor service unavailable' });
            }
        }
    },
    logger: logger_1.default
}));
const POSTOFFICE_URL = process.env.POSTOFFICE_URL || 'http://postoffice:3300';
app.use(`${API_BASE}/postoffice`, (0, http_proxy_middleware_1.createProxyMiddleware)({
    target: `${POSTOFFICE_URL}/api/v1`,
    changeOrigin: true,
    on: {
        error: (err, req, res) => {
            logger_1.default.error('Postoffice proxy error', { error: err.message });
            if ('status' in res && 'headersSent' in res && typeof res.status === 'function' && !res.headersSent) {
                res.status(502).json({ success: false, error: 'Postoffice service unavailable' });
            }
        }
    },
    logger: logger_1.default
}));
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        message: `Route ${req.method} ${req.path} not found`,
        hint: 'See /api/docs for available endpoints'
    });
});
app.use((err, req, res, next) => {
    logger_1.default.error('Server error', {
        error: err.message,
        stack: err.stack,
        method: req.method,
        path: req.path
    });
    res.status(500).json({
        error: 'Internal server error',
        message: err.message
    });
});
async function startServer() {
    logger_1.default.info('Initializing Iotistic Unified API...');
    try {
        const db = await Promise.resolve().then(() => __importStar(require('./db/connection')));
        logger_1.default.info('Attempting PostgreSQL connection:', {
            host: process.env.DB_HOST || 'localhost',
            port: process.env.DB_PORT || '5432',
            database: process.env.DB_NAME || 'iotistic',
            user: process.env.DB_USER || 'postgres',
        });
        const connected = await db.testConnection();
        if (!connected) {
            logger_1.default.error('Failed to connect to PostgreSQL database - check connection settings above');
            process.exit(1);
        }
        if (process.env.DB_SKIP_MIGRATIONS !== 'true') {
            const { getMigrationStatus, runMigrations } = await Promise.resolve().then(() => __importStar(require('./db/migrations')));
            const migrationStatus = await getMigrationStatus();
            if (migrationStatus.pending.length > 0) {
                logger_1.default.warn('Database schema is outdated - starting migrations in background', {
                    appliedMigrations: migrationStatus.applied.length,
                    pendingMigrations: migrationStatus.pending.length,
                    totalMigrations: migrationStatus.total,
                });
                void (async () => {
                    try {
                        await runMigrations();
                        logger_1.default.info('Background database migrations completed successfully');
                    }
                    catch (migrationError) {
                        logger_1.default.error('Background database migrations failed', {
                            error: migrationError instanceof Error ? migrationError.message : String(migrationError),
                        });
                    }
                })();
            }
            else {
                logger_1.default.info('Database schema is up to date (no pending migrations)');
            }
        }
        else {
            logger_1.default.info('Skipping database migrations (DB_SKIP_MIGRATIONS=true)');
        }
        const { initializeMqttAdmin, initializeNodeRedMqttCredentials } = await Promise.resolve().then(() => __importStar(require('./mqtt/bootstrap')));
        await initializeMqttAdmin();
        const nodeRedCreds = await initializeNodeRedMqttCredentials();
        if (nodeRedCreds) {
            logger_1.default.info('Node-RED MQTT credentials generated (first-time setup)');
        }
    }
    catch (error) {
        logger_1.default.error('Database initialization error:', error);
        if (error instanceof Error) {
            logger_1.default.error('Error details:', {
                message: error.message,
                stack: error.stack,
                code: error.code,
            });
        }
        process.exit(1);
    }
    try {
        const { SystemConfig } = await Promise.resolve().then(() => __importStar(require('./config/system-config')));
        await SystemConfig.load();
        logger_1.default.info('System configuration loaded successfully');
    }
    catch (error) {
        logger_1.default.error('Failed to load system configuration', { error });
        process.exit(1);
    }
    try {
        logger_1.default.info('Initializing license validator...');
        const licenseValidator = license_validator_1.LicenseValidator.getInstance();
        await licenseValidator.init();
    }
    catch (error) {
        logger_1.default.warn('License validator initialization failed', { error });
    }
    try {
        const heartbeatMonitor = await Promise.resolve().then(() => __importStar(require('./services/heartbeat-monitor')));
        heartbeatMonitor.default.start();
        logger_1.default.info('Heartbeat monitor started');
    }
    catch (error) {
        logger_1.default.warn('Failed to start heartbeat monitor', { error });
    }
    try {
        await job_scheduler_1.jobScheduler.start();
        logger_1.default.info('Job scheduler started');
    }
    catch (error) {
        logger_1.default.warn('Failed to start job scheduler', { error });
    }
    try {
        (0, traffic_flush_service_1.startTrafficFlushService)();
        logger_1.default.info('Traffic flush service started');
    }
    catch (error) {
        logger_1.default.warn('Failed to start traffic flush service', { error });
    }
    try {
        const { redisClient } = await Promise.resolve().then(() => __importStar(require('./redis/client')));
        await redisClient.connect();
        logger_1.default.info('[OK] Redis client connected successfully');
    }
    catch (error) {
        logger_1.default.warn('Redis connection failed - continuing without real-time features', {
            error: error instanceof Error ? error.message : String(error),
            note: 'This is non-critical - metrics will use PostgreSQL only'
        });
    }
    try {
        const { startMetricsBatchWorker } = await Promise.resolve().then(() => __importStar(require('./workers/metrics-batch-worker')));
        await startMetricsBatchWorker();
        logger_1.default.info('Metrics batch worker started');
    }
    catch (error) {
        logger_1.default.warn('Failed to start metrics batch worker', { error });
    }
    try {
        const { redisLogQueue } = await Promise.resolve().then(() => __importStar(require('./services/redis-log-queue')));
        await redisLogQueue.startWorker();
        logger_1.default.info('Redis log queue worker started');
    }
    catch (error) {
        logger_1.default.error('Failed to start Redis log queue worker', { error });
        process.exit(1);
    }
    try {
        const { redisSensorQueue } = await Promise.resolve().then(() => __importStar(require('./services/redis-device-queue')));
        await redisSensorQueue.startWorker();
        logger_1.default.info('Redis sensor queue worker started');
    }
    catch (error) {
        logger_1.default.error('Failed to start Redis sensor queue worker', { error });
        process.exit(1);
    }
    (async () => {
        const mqttStartupDelay = parseInt(process.env.MQTT_STARTUP_DELAY_MS || '15000');
        logger_1.default.info(`⏳ Delaying MQTT initialization for ${mqttStartupDelay}ms to allow EMQX webhook to become ready`);
        await new Promise(resolve => setTimeout(resolve, mqttStartupDelay));
        try {
            const mqttManager = await (0, mqtt_1.initializeMqtt)();
            if (mqttManager) {
                const { getMqttManager } = await Promise.resolve().then(() => __importStar(require('./mqtt')));
                const manager = getMqttManager();
                if (manager) {
                    websocket_manager_1.websocketManager.setMqttManager(manager);
                }
            }
        }
        catch (error) {
            logger_1.default.warn('[WARNING] MQTT service initialization failed - will retry in background', {
                error: error instanceof Error ? error.message : String(error),
                note: 'This is non-critical - API will continue without MQTT'
            });
            retryMqttInitialization();
        }
    })();
    const server = app.listen(PORT, () => {
        logger_1.default.info('='.repeat(80));
        logger_1.default.info('[CLOUD] Iotistica API Server');
        logger_1.default.info('='.repeat(80));
        logger_1.default.info(`Server running on http://localhost:${PORT}`);
        logger_1.default.info('='.repeat(80));
    });
    function detectIngressArchitecture() {
        const EXPLICIT_BEHIND_INGRESS = process.env.HTTPS_BEHIND_INGRESS === 'true';
        const EXPLICIT_DIRECT_HTTPS = process.env.HTTPS_ENABLED === 'true';
        let ingressType = 'unknown';
        let behindIngress = false;
        let gatewayAddress;
        if (RUNNING_IN_K8S) {
            const ingressClass = process.env.INGRESS_CLASS_NAME || 'envoy';
            const gatewayAddr = process.env.GATEWAY_ADDRESS;
            if (ingressClass.toLowerCase().includes('envoy')) {
                ingressType = 'Envoy Gateway';
                gatewayAddress = gatewayAddr;
            }
            else if (ingressClass.toLowerCase().includes('nginx')) {
                ingressType = 'NGINX Ingress Controller';
                gatewayAddress = gatewayAddr;
            }
            else if (ingressClass.toLowerCase().includes('alb')) {
                ingressType = 'AWS Application Load Balancer (ALB)';
                gatewayAddress = gatewayAddr;
            }
            else if (ingressClass.toLowerCase().includes('azure')) {
                ingressType = 'Azure Application Gateway';
                gatewayAddress = gatewayAddr;
            }
            else {
                ingressType = `Custom: ${ingressClass}`;
                gatewayAddress = gatewayAddr;
            }
            if (EXPLICIT_BEHIND_INGRESS) {
                behindIngress = true;
            }
            else if (EXPLICIT_DIRECT_HTTPS && !EXPLICIT_BEHIND_INGRESS) {
                behindIngress = false;
            }
            else {
                behindIngress = !EXPLICIT_DIRECT_HTTPS;
            }
        }
        const tlsTermination = behindIngress
            ? `${ingressType}`
            : 'Direct HTTPS (Node.js app layer)';
        return {
            isK8s: RUNNING_IN_K8S,
            ingressType,
            behindIngress,
            tlsTermination,
            gatewayAddress
        };
    }
    let httpsServer = null;
    const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
    const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);
    const IS_PRODUCTION = process.env.NODE_ENV === 'production';
    const ingressArchitecture = detectIngressArchitecture();
    logger_1.default.info('='.repeat(80));
    logger_1.default.info('DEPLOYMENT ARCHITECTURE:');
    if (ingressArchitecture.isK8s) {
        logger_1.default.info(`  Environment: Kubernetes/AKS`);
        logger_1.default.info(`  Gateway Controller: ${ingressArchitecture.ingressType}`);
        if (ingressArchitecture.gatewayAddress) {
            logger_1.default.info(`  Gateway Address: ${ingressArchitecture.gatewayAddress}`);
        }
        logger_1.default.info(`  TLS Termination: ${ingressArchitecture.tlsTermination}`);
    }
    else {
        logger_1.default.info(`  Environment: Local/Direct Deployment`);
        logger_1.default.info(`  TLS Configuration: ${HTTPS_ENABLED ? 'Direct HTTPS via Node.js' : 'No TLS (HTTP only)'}`);
    }
    logger_1.default.info('='.repeat(80));
    const BEHIND_INGRESS = ingressArchitecture.behindIngress;
    if (HTTPS_ENABLED && !BEHIND_INGRESS) {
        try {
            const rejectUnauthorized = process.env.HTTPS_REJECT_UNAUTHORIZED
                ? process.env.HTTPS_REJECT_UNAUTHORIZED === 'true'
                : undefined;
            httpsServer = (0, https_server_1.createHttpsServer)(app, {
                enabled: true,
                port: HTTPS_PORT,
                certPath: process.env.HTTPS_CERT_PATH || './certs/tls.crt',
                keyPath: process.env.HTTPS_KEY_PATH || './certs/tls.key',
                caCertPath: process.env.HTTPS_CA_CERT_PATH || './certs/ca.crt',
                environment: IS_PRODUCTION ? 'prod' : 'dev',
                requestCert: process.env.HTTPS_MTLS_ENABLED === 'true',
                rejectUnauthorized,
            });
        }
        catch (error) {
            logger_1.default.warn('Failed to start HTTPS server', { error });
        }
    }
    else if (BEHIND_INGRESS) {
        logger_1.default.info(`[OK] TLS termination at ${ingressArchitecture.ingressType}`);
        logger_1.default.info(`   App layer receives HTTP only (no redundant TLS)`);
        if (ingressArchitecture.gatewayAddress) {
            logger_1.default.info(`   Gateway reachable at: ${ingressArchitecture.gatewayAddress}`);
        }
    }
    else if (!HTTPS_ENABLED) {
        logger_1.default.info('HTTPS disabled - running HTTP only');
    }
    try {
        websocket_manager_1.websocketManager.initialize(server);
        logger_1.default.info(`WebSocket Server initialized (ws://localhost:${PORT}/ws)`);
        await websocket_manager_1.websocketManager.initializeRedis();
    }
    catch (error) {
        logger_1.default.warn('Failed to initialize WebSocket server', { error });
    }
    async function gracefulShutdown(reason, timeoutMs = 10000) {
        logger_1.default.info(`${reason} received, shutting down gracefully...`);
        const forceCloseTimeout = setTimeout(() => {
            logger_1.default.warn('Forcefully closing server after timeout');
            process.exit(1);
        }, timeoutMs);
        if (httpsServer) {
            try {
                httpsServer.close(() => {
                    logger_1.default.info('HTTPS Server closed');
                });
            }
            catch (error) {
            }
        }
        try {
            websocket_manager_1.websocketManager.shutdown();
            logger_1.default.info('WebSocket Server stopped');
        }
        catch (error) {
        }
        try {
            const { stopMetricsBatchWorker } = await Promise.resolve().then(() => __importStar(require('./workers/metrics-batch-worker')));
            await stopMetricsBatchWorker();
        }
        catch (error) {
        }
        try {
            const { redisClient } = await Promise.resolve().then(() => __importStar(require('./redis/client')));
            await redisClient.disconnect();
        }
        catch (error) {
        }
        try {
            await (0, mqtt_1.shutdownMqtt)();
        }
        catch (error) {
        }
        try {
            const heartbeatMonitor = await Promise.resolve().then(() => __importStar(require('./services/heartbeat-monitor')));
            heartbeatMonitor.default.stop();
        }
        catch (error) {
        }
        try {
            job_scheduler_1.jobScheduler.stop();
        }
        catch (error) {
        }
        try {
            const { getJobsHandler } = await Promise.resolve().then(() => __importStar(require('./mqtt/jobs-handler')));
            const handler = getJobsHandler();
            await handler.stop();
            logger_1.default.info('MQTT Jobs Handler stopped');
        }
        catch (error) {
        }
        try {
            await (0, traffic_flush_service_1.stopTrafficFlushService)();
            logger_1.default.info('Traffic flush service stopped');
        }
        catch (error) {
        }
        try {
            const { redisLogQueue } = await Promise.resolve().then(() => __importStar(require('./services/redis-log-queue')));
            await redisLogQueue.stopWorker();
            logger_1.default.info('Redis log queue worker stopped');
        }
        catch (error) {
            logger_1.default.error('Error stopping Redis log queue worker', { error });
        }
        try {
            const { redisSensorQueue } = await Promise.resolve().then(() => __importStar(require('./services/redis-device-queue')));
            await redisSensorQueue.stopWorker();
            logger_1.default.info('Redis sensor queue worker stopped');
        }
        catch (error) {
            logger_1.default.error('Error stopping Redis sensor queue worker', { error });
        }
        try {
            await (0, connection_1.close)();
            logger_1.default.info('Database connection closed');
        }
        catch (error) {
            logger_1.default.error('Error closing database connection', { error });
        }
        server.close(() => {
            logger_1.default.info('Server closed');
            clearTimeout(forceCloseTimeout);
            process.exit(0);
        });
    }
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('disconnect', () => gracefulShutdown('Debugger disconnect', 3000));
}
async function retryMqttInitialization(intervalMs = 15000) {
    const { initializeMqtt, getMqttManager } = await Promise.resolve().then(() => __importStar(require('./mqtt')));
    const interval = setInterval(async () => {
        try {
            const manager = await initializeMqtt();
            if (manager && manager.isConnected()) {
                logger_1.default.info('MQTT reconnected successfully');
                clearInterval(interval);
            }
            else {
                logger_1.default.debug('MQTT initialization returned but not connected, will retry');
            }
        }
        catch (err) {
            logger_1.default.warn('MQTT still unavailable', { error: err?.message || err });
        }
    }, intervalMs);
}
startServer().catch((error) => {
    logger_1.default.error('Failed to start server', { error });
    process.exit(1);
});
exports.default = app;
//# sourceMappingURL=index.js.map