/**
 * Graceful shutdown handler.
 *
 * Stops all services in reverse dependency order:
 *   WebSocket → workers → Redis → MQTT → HTTP servers → DB pool
 */

import https from 'https';
import type { FastifyInstance } from 'fastify';
import logger from '../utils/logger';
import { websocketManager } from '../services/websocket/manager';
import { shutdownMqtt } from '../mqtt';
import { close } from '../db/connection';

export interface ShutdownContext {
  fastify: FastifyInstance;
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

    if (ctx.httpsServer) {
      try {
        ctx.httpsServer.close(() => logger.info('HTTPS Server closed'));
      } catch { /* ignore */ }
    }

    try {
      websocketManager.shutdown();
      logger.info('WebSocket Server stopped');
    } catch { /* ignore */ }

    try {
      const { stopMetricsBatchWorker } = await import('../services/agent/metrics-worker');
      await stopMetricsBatchWorker();
    } catch { /* ignore */ }

    // Redis client
    try {
      const { redisClient } = await import('../redis/client');
      await redisClient.disconnect();
    } catch { /* ignore */ }

    try {
      await shutdownMqtt();
    } catch { /* ignore */ }

    try {
      const heartbeatMonitor = await import('../services/health/heartbeat-monitor');
      heartbeatMonitor.default.stop();
    } catch { /* ignore */ }

    try {
      const { stopJobsHandler } = await import('../mqtt/handlers');
      await stopJobsHandler();
      logger.info('MQTT Jobs Handler stopped');
    } catch { /* ignore */ }

    try {
      const { redisLogQueue } = await import('../services/telemetry/logs-queue');
      await redisLogQueue.stopWorker();
      logger.info('Redis log queue worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis log queue worker', { error });
    }

    // Database pool
    try {
      await close();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database connection', { error });
    }

    await ctx.fastify.close();
    logger.info('Server closed');
    clearTimeout(forceClose);
    process.exit(0);
  };
}
