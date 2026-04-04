/**
 * Graceful shutdown handler.
 *
 * Stops all services in reverse dependency order:
 *   WebSocket → workers → Redis → MQTT → HTTP servers → DB pool
 */

import http from 'http';
import https from 'https';
import logger from '../utils/logger';
import { websocketManager } from '../services/websocket/manager';
import { shutdownMqtt } from '../mqtt';
import { close } from '../db/connection';
import { stopTrafficFlushService } from '../services/traffic-flush.service';

export interface ShutdownContext {
  server: http.Server;
  httpsServer: https.Server | null;
}

export function createGracefulShutdown(ctx: ShutdownContext) {
  return async function gracefulShutdown(
    reason: string,
    timeoutMs = 10000,
  ): Promise<void> {
    logger.info(`${reason} received, shutting down gracefully...`);

    const forceClose = setTimeout(() => {
      logger.warn('Forcefully closing server after timeout');
      process.exit(1);
    }, timeoutMs);

    // HTTPS server
    if (ctx.httpsServer) {
      try {
        ctx.httpsServer.close(() => logger.info('HTTPS Server closed'));
      } catch { /* ignore */ }
    }

    // WebSocket
    try {
      websocketManager.shutdown();
      logger.info('WebSocket Server stopped');
    } catch { /* ignore */ }

    // Metrics batch worker
    try {
      const { stopMetricsBatchWorker } = await import('../workers/metrics-batch-worker');
      await stopMetricsBatchWorker();
    } catch { /* ignore */ }

    // Redis client
    try {
      const { redisClient } = await import('../redis/client');
      await redisClient.disconnect();
    } catch { /* ignore */ }

    // MQTT
    try {
      await shutdownMqtt();
    } catch { /* ignore */ }

    // Heartbeat monitor
    try {
      const heartbeatMonitor = await import('../services/health/heartbeat-monitor');
      heartbeatMonitor.default.stop();
    } catch { /* ignore */ }

    // MQTT jobs handler
    try {
      const { getJobsHandler } = await import('../mqtt/jobs-handler');
      const handler = getJobsHandler();
      await handler.stop();
      logger.info('MQTT Jobs Handler stopped');
    } catch { /* ignore */ }

    // Traffic flush (final DB write)
    try {
      await stopTrafficFlushService();
      logger.info('Traffic flush service stopped');
    } catch { /* ignore */ }

    // Redis log queue (final batch)
    try {
      const { redisLogQueue } = await import('../services/ingestion/redis-log-queue');
      await redisLogQueue.stopWorker();
      logger.info('Redis log queue worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis log queue worker', { error });
    }

    // Redis device queue (final batch)
    try {
      const { redisDeviceQueue } = await import('../services/ingestion');
      await redisDeviceQueue.stopWorker();
      logger.info('Redis device queue worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis device queue worker', { error });
    }

    // Database pool
    try {
      await close();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database connection', { error });
    }

    ctx.server.close(() => {
      logger.info('Server closed');
      clearTimeout(forceClose);
      process.exit(0);
    });
  };
}
