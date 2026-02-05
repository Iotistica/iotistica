import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import { MQTTMonitorService } from './services/monitor';
import { logger } from './utils/logger';
import monitorRoutes from './routes';

dotenv.config();

const app = express();
const PORT = parseInt(process.env.PORT || '3500');
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('user-agent')
  });
  next();
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'mqtt-monitor',
    timestamp: new Date().toISOString()
  });
});

app.get('/ready', (req: Request, res: Response) => {
  res.json({
    status: 'ready',
    service: 'mqtt-monitor',
    timestamp: new Date().toISOString()
  });
});

// Prometheus metrics endpoint
let monitorServiceInstance: MQTTMonitorService | null = null;

app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    if (!monitorServiceInstance) {
      res.status(503).send('Service not ready');
      return;
    }
    
    const metrics = await monitorServiceInstance.getPrometheusMetrics();
    res.setHeader('Content-Type', monitorServiceInstance.getPrometheusContentType());
    res.send(metrics);
  } catch (error: any) {
    logger.error('Error generating Prometheus metrics', { error: error.message });
    res.status(500).send('Error generating metrics');
  }
});

// API routes
app.use('/api/v1', monitorRoutes);

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method
  });
  
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// Initialize database connection
async function initializeDatabase(): Promise<Pool> {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'iotistic',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    max: parseInt(process.env.DB_POOL_SIZE || '10'),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  try {
    await pool.query('SELECT 1');
    logger.info('Database connection established');
    return pool;
  } catch (error: any) {
    logger.error('Failed to connect to database', { error: error.message });
    throw error;
  }
}

// Start server
async function start() {
  try {
    logger.info('Starting MQTT Monitor Service');

    // Initialize database
    const dbPool = await initializeDatabase();

    // Initialize MQTT Monitor
    const { instance: monitor, dbService } = await MQTTMonitorService.initialize(dbPool);
    
    // Store monitor instance for metrics endpoint
    monitorServiceInstance = monitor;

    // Inject monitor instance into routes
    const { setMonitorInstance } = await import('./routes');
    setMonitorInstance(monitor, dbService);

    // Start Express server
    app.listen(PORT, HOST, () => {
      logger.info(`MQTT Monitor Service listening on ${HOST}:${PORT}`);
      logger.info(`Health check: http://${HOST}:${PORT}/health`);
      logger.info(`API documentation: http://${HOST}:${PORT}/api/v1/status`);
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);
      
      if (monitor) {
        await monitor.stop();
      }
      
      await dbPool.end();
      
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error: any) {
    logger.error('Failed to start service', { error: error.message });
    process.exit(1);
  }
}

start();
