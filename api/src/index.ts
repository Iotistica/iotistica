/**
 * Unified Iotistic API Server
 */

import express from 'express';
import cors from 'cors';
import https from 'https';
import helmet from 'helmet';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createBrotliDecompress } from 'zlib';
import { brotliDecompressionMiddleware } from './middleware/brotli-decompression';
import logger from './utils/logger';

// Import route modules
import authRoutes from './routes/auth';
import usersRoutes from './routes/users';
import deviceStateRoutes from './routes/device-state';
import deviceLogsRoutes from './routes/device-logs';
import deviceMetricsRoutes from './routes/device-metrics';
import provisioningRoutes from './routes/provisioning';
import devicesRoutes from './routes/devices';
import adminRoutes from './routes/admin';
import appsRoutes from './routes/apps';
import imageRegistryRoutes from './routes/image-registry';
import deviceJobsRoutes from './routes/device-jobs';
import rotationRoutes from './routes/rotation';
import digitalTwinGraphRoutes from './routes/digital-twin-graph';
import eventsRoutes from './routes/events';
import mqttBrokerRoutes from './routes/mqtt-broker';
import mqttMetricsRoutes from './routes/mqtt-metrics';
import { router as deviceSensorsRoutes } from './routes/device-sensors';
import { router as trafficRoutes } from './routes/traffic';
import { router as deviceTagsRoutes } from './routes/device-tags';
import dashboardLayoutsRoutes from './routes/dashboard-layouts';
import mosquittoAuthRoutes from './routes/mosquitto-auth';
import { router as noderedStorageRoutes } from './routes/nodered-storage';
import { trafficLogger} from "./middleware/traffic-logger";
import { startTrafficFlushService, stopTrafficFlushService } from './services/traffic-flush.service';
import alertsRoutes from './routes/alerts';
import prometheusRoutes from './routes/prometheus';
import endpointsDataRoutes from './routes/endpoints-data';
import anomalyRoutes from './routes/anomaly';
import profileRoutes, { publicRouter as profilePublicRoutes } from './routes/profiles';
import { 
  globalApiRateLimit, 
  authRateLimit, 
  deviceDataRateLimit, 
  adminRateLimit 
} from './middleware/rate-limit';

// Import jobs

import { jobScheduler } from './services/job-scheduler';
import poolWrapper, { close } from './db/connection';
import { initializeMqtt, shutdownMqtt } from './mqtt';
import { LicenseValidator } from './services/license-validator';
import licenseRoutes from './routes/license';
import jwtAuth from './middleware/jwt-auth';
import billingRoutes from './routes/billing';
import { websocketManager } from './services/websocket-manager';
import { createHttpsServer } from './https-server';

// API Version Configuration - Change here to update all routesggg
const API_VERSION = process.env.API_VERSION || 'v1';
const API_BASE = `/api/${API_VERSION}`;

const app = express();
const PORT = process.env.PORT || 3002;

// SECURITY: Trust proxy for deployments behind reverse proxy (nginx, load balancers, K8s ingress)
// This ensures req.ip, req.protocol, req.hostname reflect the original client request
// Set to false for direct deployments, true/1 for single proxy, or number of hops for multiple proxies
const TRUST_PROXY = process.env.TRUST_PROXY || 'false';
if (TRUST_PROXY !== 'false') {
  app.set('trust proxy', TRUST_PROXY === 'true' ? 1 : parseInt(TRUST_PROXY, 10));
  logger.info(`Trust proxy enabled: ${TRUST_PROXY}`);
}

// SECURITY: Helmet middleware - sets secure HTTP headers
// Protects against common browser-based attacks (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet({
  // Disable COEP for WebSocket compatibility (ws:// connections)
  crossOriginEmbedderPolicy: false,
  
  // Content Security Policy - restrict resource loading
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for Swagger UI
      styleSrc: ["'self'", "'unsafe-inline'"], // Allow inline styles for Swagger UI
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "ws:", "wss:"], // Allow WebSocket connections
      frameSrc: ["'none'"], // Prevent embedding in iframes
    },
  },
  
  // Additional security headers
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true
  },
}));

// ============================================================================
// CORS Configuration - Hardened for production security
// SECURITY: Never use '*' with credentials enabled (exposes session cookies)
// ============================================================================
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) 
  : [
      'http://localhost:5173', 
      'http://localhost:3001', 
      'http://localhost:3000', 
      'http://localhost:4002',
      // Allow K8s fleet cluster to call provisioning API
      'https://api1.iotistica.com',
      'http://api1.iotistica.com'
    ];

// SECURITY: Validate CORS configuration on startup
if (allowedOrigins.includes('*')) {
  logger.error('CRITICAL: CORS_ORIGINS contains "*" which is insecure with credentials enabled');
  throw new Error('CORS misconfiguration: Cannot use "*" origin with credentials');
}

// Warn about wildcard patterns (use with caution)
const hasWildcards = allowedOrigins.some(o => o.includes('*'));
if (hasWildcards) {
  logger.warn('CORS wildcard patterns detected - ensure these are intentional:', {
    origins: allowedOrigins.filter(o => o.includes('*'))
  });
}

// Routes that should skip CORS checks (internal service-to-service only)
const corsExemptPaths = [
  '/health',              // Kubernetes health checks
  '/metrics',             // Prometheus scraping
  '/mosquitto-auth',      // Mosquitto broker auth callbacks
];

app.use(cors({
  origin: (origin, callback) => {
    // No origin header (server-to-server, mobile apps, curl, Postman)
    if (!origin) {
      // Always allow requests without Origin header
      // These are typically server-to-server calls (Mosquitto, Prometheus, health checks, devices)
      return callback(null, true);
    }
    
    // Check explicit origin allowlist (browser requests)
    const isAllowed = allowedOrigins.some(allowed => {
      // Support wildcard patterns (e.g., https://*.example.com:3000)
      // CAUTION: Use sparingly - prefer explicit origins for security
      if (allowed.includes('*')) {
        const pattern = allowed.replace(/\*/g, '.*').replace(/\./g, '\\.');
        return new RegExp(`^${pattern}$`).test(origin);
      }
      // Exact match (preferred)
      return allowed === origin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn('CORS: Rejected request from unauthorized origin', { 
        origin,
        allowedOrigins: allowedOrigins.slice(0, 5) // Log first 5 for debugging
      });
      callback(new Error('Not allowed by CORS'));
    }
  },
  
  // SECURITY: credentials: true requires explicit origin (never '*')
  credentials: true,
  
  // Allowed HTTP methods
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  
  // Allowed headers (explicit allowlist)
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-API-Key'],
  
  // Expose custom headers to browser (if needed)
  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  
  // Preflight cache duration (24 hours)
  maxAge: 86400
}));

app.options('*', cors());

// Security headers
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Brotli decompression middleware
app.use(brotliDecompressionMiddleware);

// Support compressed (gzip/deflate) request bodies
app.use(express.json({ 
  limit: '100mb',  // Large limit for decompressed logs (10MB compressed → 40-60MB decompressed)
  inflate: true  // Automatically decompress gzip/deflate
}));
app.use(express.urlencoded({ 
  limit: '100mb',  // Large limit for decompressed logs
  extended: true,
  inflate: true  // Automatically decompress gzip/deflate
}));

app.use(trafficLogger);

// Debug: Log ALL requests
// app.use((req, res, next) => {
//   if (req.path.includes('devices') || req.path.includes('device')) {
//     console.log('[DEBUG] Request received:', {
//       method: req.method,
//       path: req.path,
//       url: req.url,
//       originalUrl: req.originalUrl,
//       baseUrl: req.baseUrl,
//       headers: {
//         authorization: req.headers.authorization?.substring(0, 30),
//         'x-device-api-key': req.headers['x-device-api-key']?.toString().substring(0, 30),
//         'content-encoding': req.headers['content-encoding'],
//         'content-type': req.headers['content-type'],
//         'content-length': req.headers['content-length']
//       }
//     });
//   }
  
//   // Intercept response to log 401s
//   const originalJson = res.json.bind(res);
//   res.json = function(body: any) {
//     if (res.statusCode === 401) {
//       console.log('[DEBUG] *** 401 RESPONSE ***', {
//         path: req.path,
//         body,
//         stack: new Error().stack?.split('\n').slice(1, 5)
//       });
//     }
//     return originalJson(body);
//   };
  
//   next();
// });

// Request logging with Winston
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // MQTT auth endpoints logged at debug level only (less noisy)
  const isMqttAuth = req.path === '/superuser' || req.path === '/acl';
  
  // Log incoming request at debug level (less noisy)
  logger.debug(`${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip
  });
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    
    // Skip logging 200 OK responses
    if (res.statusCode === 200) {
      return;
    }
    
    const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : isMqttAuth ? 'debug' : 'info';
    
    // Log only the message without metadata object
    logger[logLevel](`${res.statusCode} ${req.method} ${req.path} - ${duration}ms`);
  });
  
  next();
});


// Root endpoint
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



// Health check endpoint (for Kubernetes probes)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Setup API documentation
import { setupApiDocs } from './docs';
setupApiDocs(app, API_BASE);

// Prometheus metrics endpoint (no auth, no versioning - standard /metrics path)
app.use(prometheusRoutes);

// Mosquitto HTTP Auth Backend (no versioning, called directly by mosquitto-go-auth)
app.use('/mosquitto-auth', mosquittoAuthRoutes);

// ============================================================================
// PUBLIC API Routes - NO AUTHENTICATION REQUIRED
// Mount these BEFORE any auth middleware to ensure they're accessible
// ============================================================================
app.use(`${API_BASE}/profiles`, profilePublicRoutes); // Public profile endpoints (e.g., /datapoints for simulators)

// ============================================================================
// Rate Limiting - Token-based for IoT (prevents one device from blocking others)
// Applied before route mounting for consistent enforcement
// ============================================================================
app.use(API_BASE, globalApiRateLimit);

// ============================================================================
// API Routes - All mounted at API_BASE for centralized versioning
// Route modules define their own paths internally (e.g., router.get('/devices'))
// This keeps versioning logic centralized and prevents mount path inconsistencies
// ============================================================================

// Authentication routes - strict rate limiting (brute-force protection)
app.use(`${API_BASE}/auth`, authRateLimit, authRoutes);

// CRITICAL: Mount devicesRoutes BEFORE usersRoutes to prevent /:id from matching /devices
console.log('[INDEX] Mounting devicesRoutes at', API_BASE);
app.use(API_BASE, devicesRoutes);

// User management and admin - moderate rate limiting
app.use(API_BASE, adminRateLimit, usersRoutes);
app.use(API_BASE, adminRateLimit, adminRoutes);

// Device data ingestion - high rate limits (supports 16Hz sensor data)
app.use(API_BASE, deviceDataRateLimit, deviceLogsRoutes);
app.use(API_BASE, deviceDataRateLimit, deviceMetricsRoutes);
app.use(API_BASE, deviceDataRateLimit, deviceSensorsRoutes);
app.use(API_BASE, deviceDataRateLimit, endpointsDataRoutes);

// Standard API routes - global rate limit applied above
console.log('[INDEX] Mounting routes...');
app.use(API_BASE, licenseRoutes);
app.use(API_BASE, billingRoutes);
app.use(API_BASE, provisioningRoutes);
// devicesRoutes moved earlier to avoid conflict with usersRoutes /:id
app.use(API_BASE, appsRoutes);
app.use(API_BASE, deviceStateRoutes);
app.use(API_BASE, imageRegistryRoutes);
app.use(API_BASE, deviceJobsRoutes);
app.use(API_BASE, rotationRoutes);
app.use(API_BASE, profileRoutes);
app.use(API_BASE, digitalTwinGraphRoutes);
app.use(API_BASE, mqttMetricsRoutes);
app.use(API_BASE, eventsRoutes);
app.use(API_BASE, mqttBrokerRoutes);
app.use(API_BASE, trafficRoutes);
app.use(API_BASE, deviceTagsRoutes);
app.use(API_BASE, dashboardLayoutsRoutes);
app.use(API_BASE, alertsRoutes);
app.use(API_BASE, anomalyRoutes);
app.use(API_BASE, noderedStorageRoutes);

// ============================================================================
// API Gateway Proxies - Route requests to microservices
// ============================================================================

// MQTT Monitor Service Proxy (protected by JWT)
const MQTT_MONITOR_URL = process.env.MQTT_MONITOR_URL || 'http://mqtt-monitor:3500';
app.use(`${API_BASE}/mqtt-monitor`, jwtAuth, createProxyMiddleware({
  target: `${MQTT_MONITOR_URL}/api/v1`,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      logger.error('MQTT Monitor proxy error', { error: err.message });
      // Type guard: check if res is an Express Response
      if ('status' in res && 'headersSent' in res && typeof res.status === 'function' && !res.headersSent) {
        res.status(502).json({ success: false, error: 'MQTT Monitor service unavailable' });
      }
    }
  },
  logger: logger
}));

// Postoffice (Email) Service Proxy
const POSTOFFICE_URL = process.env.POSTOFFICE_URL || 'http://postoffice:3300';
app.use(`${API_BASE}/postoffice`, createProxyMiddleware({
  target: `${POSTOFFICE_URL}/api/v1`,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      logger.error('Postoffice proxy error', { error: err.message });
      // Type guard: check if res is an Express Response
      if ('status' in res && 'headersSent' in res && typeof res.status === 'function' && !res.headersSent) {
        res.status(502).json({ success: false, error: 'Postoffice service unavailable' });
      }
    }
  },
  logger: logger
}));


// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
    hint: 'See /api/docs for available endpoints'
  });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error('Server error', {
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

// Start server
async function startServer() {
  logger.info('Initializing Iotistic Unified API...');

  // Initialize PostgreSQL database
  try {
    const db = await import('./db/connection');
    
    // Log connection details for debugging
    logger.info('Attempting PostgreSQL connection:', {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || '5432',
      database: process.env.DB_NAME || 'iotistic',
      user: process.env.DB_USER || 'postgres',
    });
    
    const connected = await db.testConnection();
    
    if (!connected) {
      logger.error('Failed to connect to PostgreSQL database - check connection settings above');
      process.exit(1);
    }
    
    // Initialize schema
    await db.initializeSchema();
    logger.info('PostgreSQL database initialized successfully');
    
    // Initialize MQTT users (replaces K8s postgres-init-job)
    const { initializeMqttAdmin, initializeNodeRedMqttCredentials } = await import('./mqtt/bootstrap');
    await initializeMqttAdmin();
    
    // Initialize Node-RED instance MQTT credentials (FlowFuse pattern)
    const nodeRedCreds = await initializeNodeRedMqttCredentials();
    if (nodeRedCreds) {
      // New credentials generated - these should be persisted in environment
      logger.info('Node-RED MQTT credentials generated (first-time setup)');
    }
  } catch (error) {
    logger.error('Database initialization error:', error);
    if (error instanceof Error) {
      logger.error('Error details:', {
        message: error.message,
        stack: error.stack,
        code: (error as any).code,
      });
    }
    process.exit(1);
  }

  // Load system configuration (MQTT, VPN, etc.)
  try {
    const { SystemConfig } = await import('./config/system-config');
    await SystemConfig.load();
    logger.info('System configuration loaded successfully');
  } catch (error) {
    logger.error('Failed to load system configuration', { error });
    process.exit(1);
  }

  // Initialize license validator
  try {
    logger.info('Initializing license validator...');
    const licenseValidator = LicenseValidator.getInstance();
    await licenseValidator.init();
  } catch (error) {
    logger.warn('License validator initialization failed', { error });
    // Don't exit - will run in unlicensed mode with limited features
  }

  // Initialize Neo4j database for Digital Twin graph
  try {
    logger.info('Connecting to Neo4j database...');
    const { neo4jService } = await import('./services/neo4j.service');
    await neo4jService.connect();
    logger.info('Neo4j database connected successfully');
  } catch (error) {
    logger.warn('Neo4j connection failed', { error });
    // Don't exit - Digital Twin graph features will be unavailable
  }

  // Start heartbeat monitor for device connectivity
  try {
    const heartbeatMonitor = await import('./services/heartbeat-monitor');
    heartbeatMonitor.default.start();
    logger.info('Heartbeat monitor started');
  } catch (error) {
    logger.warn('Failed to start heartbeat monitor', { error });
    // Don't exit - this is not critical for API operation
  }


  // Start job scheduler for scheduled/recurring jobs
  try {
    await jobScheduler.start();
    logger.info('Job scheduler started');
  } catch (error) {
    logger.warn('Failed to start job scheduler', { error });
    // Don't exit - this is not critical for API operation
  }


  // Start traffic flush service (persists device traffic metrics to database)
  try {
    startTrafficFlushService();
    logger.info('Traffic flush service started');
  } catch (error) {
    logger.warn('Failed to start traffic flush service', { error });
    // Don't exit - this is not critical for API operation
  }

  // Initialize Redis for real-time pub/sub
  try {
    const { redisClient } = await import('./redis/client');
    await redisClient.connect();
    logger.info('✓ Redis client connected successfully');
  } catch (error) {
    logger.warn('Redis connection failed - continuing without real-time features', {
      error: error instanceof Error ? error.message : String(error),
      note: 'This is non-critical - metrics will use PostgreSQL only'
    });
    // Don't exit - graceful degradation (continues with PostgreSQL only)
  }

  // Start Metrics Batch Worker (Phase 2 - Redis Streams)
  try {
    const { startMetricsBatchWorker } = await import('./workers/metrics-batch-worker');
    await startMetricsBatchWorker();
    logger.info('Metrics batch worker started');
  } catch (error) {
    logger.warn('Failed to start metrics batch worker', { error });
    // Don't exit - will fall back to direct writes
  }

  // Start Redis log queue worker for batch processing
  try {
    const { redisLogQueue } = await import('./services/redis-log-queue');
    await redisLogQueue.startWorker();
    logger.info('Redis log queue worker started');
  } catch (error) {
    logger.error('Failed to start Redis log queue worker', { error });
    // This is critical - logs won't be persisted without it
    process.exit(1);
  }

  // Start Redis sensor queue worker for batch processing
  try {
    const { redisSensorQueue } = await import('./services/redis-sensor-queue');
    await redisSensorQueue.startWorker();
    logger.info('Redis sensor queue worker started');
  } catch (error) {
    logger.error('Failed to start Redis sensor queue worker', { error });
    // This is critical - sensor data won't be persisted without it
    process.exit(1);
  }

  // Initialize MQTT manager for device messages
  (async () => {
    try {
      await initializeMqtt();
      // MQTT manager will log its own initialization status
    } catch (error) {
      logger.warn('⚠️  MQTT service initialization failed - will retry in background', {
        error: error instanceof Error ? error.message : String(error),
        note: 'This is non-critical - API will continue without MQTT'
      });
      retryMqttInitialization();
    }
  })();

  // API key rotation is now handled by housekeeper service

  const server = app.listen(PORT, () => {
    logger.info('='.repeat(80));
    logger.info('☁️  Iotistic Unified API Server');
    logger.info('='.repeat(80));
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info('='.repeat(80));
  });

  // HTTPS server (optional - for device-to-API TLS)
  let httpsServer: https.Server | null = null;
  const HTTPS_ENABLED = process.env.HTTPS_ENABLED === 'true';
  const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '3443', 10);

  if (HTTPS_ENABLED) {
    try {
      httpsServer = createHttpsServer(app, {
        enabled: true,
        port: HTTPS_PORT,
        certPath: process.env.HTTPS_CERT_PATH || './certs/tls.crt',
        keyPath: process.env.HTTPS_KEY_PATH || './certs/tls.key',
        caCertPath: process.env.HTTPS_CA_CERT_PATH || './certs/ca.crt',
      });
    } catch (error) {
      logger.warn('Failed to start HTTPS server', { error });
    }
  }

  // Initialize WebSocket server
  try {
    websocketManager.initialize(server);
    logger.info(`WebSocket Server initialized (ws://localhost:${PORT}/ws)`);
    
    // Initialize Redis pub/sub for real-time metrics (Phase 1)
    await websocketManager.initializeRedis();
  } catch (error) {
    logger.warn('Failed to initialize WebSocket server', { error });
    // Don't exit - this is not critical for API operation
  }

  // Graceful shutdown function (consolidated from SIGTERM/SIGINT/disconnect handlers)
  async function gracefulShutdown(reason: string, timeoutMs = 10000): Promise<void> {
    logger.info(`${reason} received, shutting down gracefully...`);
    
    // Set a timeout to force close if shutdown hangs
    const forceCloseTimeout = setTimeout(() => {
      logger.warn('Forcefully closing server after timeout');
      process.exit(1);
    }, timeoutMs);
    
    // Close HTTPS server
    if (httpsServer) {
      try {
        httpsServer.close(() => {
          logger.info('HTTPS Server closed');
        });
      } catch (error) {
        // Ignore errors during shutdown
      }
    }
    
    // Shutdown WebSocket Server
    try {
      websocketManager.shutdown();
      logger.info('WebSocket Server stopped');
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Shutdown Metrics Batch Worker
    try {
      const { stopMetricsBatchWorker } = await import('./workers/metrics-batch-worker');
      await stopMetricsBatchWorker();
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Shutdown Redis
    try {
      const { redisClient } = await import('./redis/client');
      await redisClient.disconnect();
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Shutdown MQTT
    try {
      await shutdownMqtt();
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Rotation schedulers moved to housekeeper service
  
    // Stop heartbeat monitor
    try {
      const heartbeatMonitor = await import('./services/heartbeat-monitor');
      heartbeatMonitor.default.stop();
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Stop job scheduler
    try {
      jobScheduler.stop();
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Stop MQTT Jobs Handler
    try {
      const { getJobsHandler } = await import('./mqtt/jobs-handler');
      const handler = getJobsHandler();
      await handler.stop();
      logger.info('MQTT Jobs Handler stopped');
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Stop traffic flush service (final flush to database)
    try {
      await stopTrafficFlushService();
      logger.info('Traffic flush service stopped');
    } catch (error) {
      // Ignore errors during shutdown
    }
    
    // Stop Redis log queue worker (graceful shutdown with final batch processing)
    try {
      const { redisLogQueue } = await import('./services/redis-log-queue');
      await redisLogQueue.stopWorker();
      logger.info('Redis log queue worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis log queue worker', { error });
    }
    
    // Stop Redis sensor queue worker (graceful shutdown with final batch processing)
    try {
      const { redisSensorQueue } = await import('./services/redis-sensor-queue');
      await redisSensorQueue.stopWorker();
      logger.info('Redis sensor queue worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis sensor queue worker', { error });
    }
    
    // Close database pool
    try {
      await close();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database connection', { error });
    }
    
    server.close(() => {
      logger.info('Server closed');
      clearTimeout(forceCloseTimeout);
      process.exit(0);
    });
  }

  // Graceful shutdown signal handlers
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // Handle debugger disconnect/restart (VS Code specific - shorter timeout)
  process.on('disconnect', () => gracefulShutdown('Debugger disconnect', 3000));
}

async function retryMqttInitialization(intervalMs: number = 15000): Promise<void> {
  const { initializeMqtt, getMqttManager } = await import('./mqtt');
  const interval = setInterval(async () => {
    try {
      const manager = await initializeMqtt();
      if (manager && manager.isConnected()) {
        logger.info('MQTT reconnected successfully');
        clearInterval(interval);
      } else {
        logger.debug('MQTT initialization returned but not connected, will retry');
      }
    } catch (err: any) {
      logger.warn('MQTT still unavailable', { error: err?.message || err });
    }
  }, intervalMs);
}

startServer().catch((error) => {
  logger.error('Failed to start server', { error });
  process.exit(1);
});

export default app;
