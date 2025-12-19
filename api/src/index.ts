/**
 * Unified Iotistic API Server
 */

import express from 'express';
import cors from 'cors';
import https from 'https';
import { createProxyMiddleware } from 'http-proxy-middleware';
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
import vendorRoutes from './routes/vendors';

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

// CORS Configuration
const allowedOrigins = process.env.CORS_ORIGINS 
  ? process.env.CORS_ORIGINS.split(',') 
  : ['http://localhost:5173', 'http://localhost:3001', 'http://localhost:3000', 'http://localhost:4002'];

// Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or Postman)
    if (!origin) return callback(null, true);
    
    // Check if origin matches allowed patterns
    const isAllowed = allowedOrigins.some(allowed => {
      // Support wildcard patterns like http://*.example.com:30000
      if (allowed.includes('*')) {
        const pattern = allowed.replace(/\*/g, '.*');
        return new RegExp(`^${pattern}$`).test(origin);
      }
      return allowed === origin;
    });
    
    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-API-Key']
}));

app.options('*', cors());

// Support compressed (gzip) request bodies
app.use(express.json({ 
  limit: '50mb',  // Increased for high agent count (100+ agents sending logs)
  inflate: true  // Automatically decompress gzip/deflate
}));
app.use(express.urlencoded({ 
  limit: '50mb',  // Increased for high agent count
  extended: true,
  inflate: true  // Automatically decompress gzip/deflate
}));

app.use(trafficLogger);

// Request logging with Winston
app.use((req, res, next) => {
  const startTime = Date.now();
  
  // Log incoming request at debug level (less noisy)
  logger.debug(`${req.method} ${req.path}`, {
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip
  });
  
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logLevel = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    
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

// Mount route modules - All routes now use centralized versioning via API_BASE
app.use(`${API_BASE}/endpoints`, endpointsDataRoutes);  // Generic endpoints data API
app.use(`${API_BASE}/auth`, authRoutes);
app.use(`${API_BASE}/users`, usersRoutes);
app.use(API_BASE, licenseRoutes);

// Mosquitto HTTP Auth Backend (no versioning, called directly by mosquitto-go-auth)
app.use('/mosquitto-auth', mosquittoAuthRoutes);
app.use(`${API_BASE}/billing`, billingRoutes);
app.use(API_BASE, provisioningRoutes);
app.use(API_BASE, devicesRoutes);
app.use(API_BASE, adminRoutes);
app.use(API_BASE, appsRoutes);
app.use(API_BASE, deviceStateRoutes);
app.use(API_BASE, deviceLogsRoutes);
app.use(API_BASE, deviceMetricsRoutes);
app.use(API_BASE, imageRegistryRoutes);
app.use(API_BASE, deviceJobsRoutes);
app.use(API_BASE, rotationRoutes);
app.use(`${API_BASE}/vendors`, vendorRoutes);
app.use(`${API_BASE}/digital-twin/graph`, digitalTwinGraphRoutes);
app.use(`${API_BASE}/mqtt`, mqttMetricsRoutes);

// API Gateway Proxy: Route mqtt-monitor requests to mqtt-monitor service
// Protected by JWT authentication
const MQTT_MONITOR_URL = process.env.MQTT_MONITOR_URL || 'http://mqtt-monitor:3500';
app.use(`${API_BASE}/mqtt-monitor`, jwtAuth, createProxyMiddleware({
  target: `${MQTT_MONITOR_URL}/api/v1`,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      logger.error('MQTT Monitor proxy error', { error: err.message });
      if ('headersSent' in res && res.headersSent) return;
      if ('writeHead' in res) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'MQTT Monitor service unavailable' }));
      }
    }
  },
  logger: logger
}));

// API Gateway Proxy: Route postoffice (email) requests to postoffice service
const POSTOFFICE_URL = process.env.POSTOFFICE_URL || 'http://postoffice:3300';
app.use(`${API_BASE}/postoffice`, createProxyMiddleware({
  target: `${POSTOFFICE_URL}/api/v1`,
  changeOrigin: true,
  on: {
    error: (err, req, res) => {
      logger.error('Postoffice proxy error', { error: err.message });
      if ('headersSent' in res && res.headersSent) return;
      if ('writeHead' in res) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Postoffice service unavailable' }));
      }
    }
  },
  logger: logger
}));

app.use(API_BASE, eventsRoutes);
app.use(`${API_BASE}/mqtt`, mqttBrokerRoutes);
app.use(API_BASE, deviceSensorsRoutes);
app.use(API_BASE, trafficRoutes);
app.use(API_BASE, deviceTagsRoutes);
app.use(`${API_BASE}/dashboard-layouts`, dashboardLayoutsRoutes);
app.use(`${API_BASE}/alerts`, alertsRoutes);
app.use(`${API_BASE}/anomaly`, anomalyRoutes);  // Anomaly detection aggregates
app.use(API_BASE, noderedStorageRoutes);


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
    const { initializeMqttAdmin, initializeNodeRedMqttCredentials } = await import('./services/mqtt-bootstrap');
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

  // Initialize MQTT Jobs Subscriber (listens for job status updates from devices)
  try {
    const { getMqttJobsSubscriber } = await import('./services/mqtt-jobs-subscriber');
    const subscriber = getMqttJobsSubscriber();
    await subscriber.initialize();
    logger.info('MQTT Jobs Subscriber started');
  } catch (error) {
    logger.warn('Failed to start MQTT Jobs Subscriber', { error });
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
        certPath: process.env.HTTPS_CERT_PATH || './certs/server.crt',
        keyPath: process.env.HTTPS_KEY_PATH || './certs/server.key',
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

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, shutting down gracefully...');
    
    // Set a timeout to force close if shutdown hangs
    const forceCloseTimeout = setTimeout(() => {
      logger.warn('Forcefully closing server after timeout');
      process.exit(1);
    }, 10000); // 10 second timeout
    
    // Close HTTPS server
    if (httpsServer) {
      httpsServer.close(() => {
        logger.info('HTTPS Server closed');
      });
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
    
    // Stop MQTT Jobs Subscriber
    try {
      const { getMqttJobsSubscriber } = await import('./services/mqtt-jobs-subscriber');
      const subscriber = getMqttJobsSubscriber();
      await subscriber.stop();
      logger.info('MQTT Jobs Subscriber stopped');
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
  });

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, shutting down gracefully...');
    
    // Set a timeout to force close if shutdown hangs
    const forceCloseTimeout = setTimeout(() => {
      logger.warn('Forcefully closing server after timeout');
      process.exit(1);
    }, 10000); // 10 second timeout
    
    // Close HTTPS server
    if (httpsServer) {
      httpsServer.close(() => {
        logger.info('HTTPS Server closed');
      });
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
    
    // Stop MQTT Jobs Subscriber
    try {
      const { getMqttJobsSubscriber } = await import('./services/mqtt-jobs-subscriber');
      const subscriber = getMqttJobsSubscriber();
      await subscriber.stop();
      logger.info('MQTT Jobs Subscriber stopped');
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
    
    // Close database connections
    try {
      await close();
      logger.info('Database connections closed');
    } catch (error) {
      logger.error('Error closing database connections', { error });
    }
    
    server.close(() => {
      logger.info('Server closed');
      clearTimeout(forceCloseTimeout);
      process.exit(0);
    });
  });

  // Handle debugger disconnect/restart (VS Code specific)
  process.on('disconnect', async () => {
    logger.info('Debugger disconnected, shutting down...');
    
    // Set shorter timeout for debugger disconnect
    const forceCloseTimeout = setTimeout(() => {
      logger.warn('Forcefully closing server after debugger disconnect timeout');
      process.exit(1);
    }, 3000); // 3 second timeout for debugger disconnect
    
    // Close HTTPS server
    if (httpsServer) {
      httpsServer.close(() => {
        logger.info('HTTPS Server closed');
      });
    }
    
    server.close(() => {
      clearTimeout(forceCloseTimeout);
      process.exit(0);
    });
  });
}

async function retryMqttInitialization(intervalMs: number = 15000): Promise<void> {
  const { initializeMqtt } = await import('./mqtt');
  const interval = setInterval(async () => {
    try {
      await initializeMqtt();
      logger.info('MQTT reconnected successfully');
      clearInterval(interval);
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
