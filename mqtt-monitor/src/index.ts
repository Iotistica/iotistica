import fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import { Pool } from 'pg';
import { MQTTMonitorService } from './services/monitor';
import { StatsHistoryService } from './services/history';
import { logger } from './utils/logger';
import { loadDefaultEnvFiles } from './utils/env';
import monitorRoutes from './routes';

loadDefaultEnvFiles();

const PORT = parseInt(process.env.PORT || '3500');
const HOST = process.env.HOST || '0.0.0.0';

// Prometheus metrics endpoint
let monitorServiceInstance: MQTTMonitorService | null = null;

async function createApp(): Promise<FastifyInstance> {
  const app = fastify({ logger: false });

  await app.register(fastifyCors);

  app.addHook('onRequest', async (request) => {
    logger.info(`${request.method} ${request.url}`, {
      ip: request.ip,
      userAgent: request.headers['user-agent']
    });
  });

  app.get('/health', async () => ({
    status: 'healthy',
    service: 'mqtt-monitor',
    timestamp: new Date().toISOString()
  }));

  app.get('/ready', async () => ({
    status: 'ready',
    service: 'mqtt-monitor',
    timestamp: new Date().toISOString()
  }));

  app.get('/metrics', async (_request, reply) => {
    try {
      if (!monitorServiceInstance) {
        return reply.status(503).send('Service not ready');
      }

      const metrics = await monitorServiceInstance.getPrometheusMetrics();
      reply.header('Content-Type', monitorServiceInstance.getPrometheusContentType());
      return reply.send(metrics);
    } catch (error: any) {
      logger.error('Error generating Prometheus metrics', { error: error.message });
      return reply.status(500).send('Error generating metrics');
    }
  });

  await app.register(monitorRoutes, { prefix: '/api/v1' });

  app.setErrorHandler((error, request, reply) => {
    const errorDetails = error instanceof Error
      ? { error: error.message, stack: error.stack }
      : { error: String(error), stack: undefined };

    logger.error('Unhandled error', {
      ...errorDetails,
      path: request.url,
      method: request.method
    });

    reply.status(500).send({
      success: false,
      error: 'Internal server error'
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      success: false,
      error: 'Route not found'
    });
  });

  return app;
}

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
    const app = await createApp();

    // Initialize database
    const dbPool = await initializeDatabase();

    // Initialize MQTT Monitor
    const { instance: monitor, dbService } = await MQTTMonitorService.initialize(dbPool);
    
    // Store monitor instance for metrics endpoint
    monitorServiceInstance = monitor;

    // Initialize Stats History Service (keep last 30 points, collect every 10 seconds)
    const historyService = new StatsHistoryService(30);
    historyService.start(() => {
      const metrics = monitor.getMetrics();
      return {
        clients: metrics.clients,
        subscriptions: metrics.subscriptions,
        messageRate: {
          published: metrics.messageRate.current.published,
          received: metrics.messageRate.current.received
        },
        throughput: {
          inbound: metrics.throughput.current.inbound,
          outbound: metrics.throughput.current.outbound
        }
      };
    }, 10000); // Collect every 10 seconds
    
    logger.info('Stats history service initialized');

    // Inject monitor instance and history service into routes
    const { setMonitorInstance } = await import('./routes/index.js');
    setMonitorInstance(monitor, dbService, historyService);

    await app.listen({ port: PORT, host: HOST });
    logger.info(`MQTT Monitor Service listening on ${HOST}:${PORT}`);
    logger.info(`Health check: http://${HOST}:${PORT}/health`);
    logger.info(`API documentation: http://${HOST}:${PORT}/api/v1/status`);

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}, shutting down gracefully`);
      
      // Stop history collection
      historyService.stop();
      
      if (monitor) {
        await monitor.stop();
      }

      await app.close();
      
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
