import type { Server } from 'http';
import logger from '../utils/logger';
import { close } from '../db/connection';
import { closeAllRedisClients } from '../redis/client-factory';

export interface ShutdownContext {
  server: Server;
}

export function createGracefulShutdown(ctx: ShutdownContext) {
  return async function gracefulShutdown(
    reason: string,
    timeoutMs = 10000,
  ): Promise<void> {
    logger.info(`${reason} received, shutting down gracefully...`);

    const forceClose = setTimeout(() => {
      logger.warn('Forcefully closing ingestion server after timeout');
      process.exit(1);
    }, timeoutMs);

    try {
      const { deviceOrchestrator } = await import('../services');
      await deviceOrchestrator.stopWorker();
      logger.info('Device ingestion worker stopped');
    } catch (error) {
      logger.error('Error stopping Redis device queue worker', { error });
    }

    try {
      const { redisLogQueue } = await import('../services');
      await redisLogQueue.stopWorker();
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

    try {
      await closeAllRedisClients();
      logger.info('Redis clients closed');
    } catch (error) {
      logger.error('Error closing Redis clients', { error });
    }

    await new Promise<void>((resolve, reject) => {
      ctx.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    logger.info('HTTP server closed');
    clearTimeout(forceClose);
    process.exit(0);
  };
}