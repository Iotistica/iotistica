import type { FastifyInstance } from 'fastify';
import logger from '../utils/logger';
import { websocketManager } from '../services/websocket/manager';
import { shutdownMqtt } from '../mqtt';
import { close } from '../db/connection';

export function createGracefulShutdown(fastify: FastifyInstance) {
  return async function gracefulShutdown(
    reason: string,
    timeoutMs = 10000,
  ): Promise<void> {
    logger.info(`${reason} received, shutting down gracefully...`);

    const forceClose = setTimeout(() => {
      logger.warn('Forcefully closing server after timeout');
      process.exit(1);
    }, timeoutMs);

    try {
      websocketManager.shutdown();
      logger.info('WebSocket Server stopped');
    } catch { /* ignore */ }

    try {
      const { stopJobsHandler } = await import('../mqtt/handlers');
      await stopJobsHandler();
      logger.info('MQTT Jobs Handler stopped');
    } catch { /* ignore */ }

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
      const { redisLogQueue, redisDeviceQueue } = await import('../services/telemetry/publisher');
      await redisLogQueue.flush();
      await redisDeviceQueue.destroy();
      logger.info('Redis log queue worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis log queue worker', { error });
    }

    try {
      await close();
      logger.info('Database connection closed');
    } catch (error) {
      logger.error('Error closing database connection', { error });
    }

    await fastify.close();
    logger.info('Server closed');
    clearTimeout(forceClose);
    process.exit(0);
  };
}
