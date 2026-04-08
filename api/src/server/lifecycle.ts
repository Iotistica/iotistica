/**
 * Server lifecycle: starts HTTP + HTTPS listeners, WebSocket, and
 * registers graceful shutdown signal handlers.
 */

import type { FastifyInstance } from 'fastify';
import logger from '../utils/logger';
import { websocketManager } from '../services/websocket/manager';
import { startHttpsServer } from './https';
import { createGracefulShutdown } from './shutdown';

type NetworkError = NodeJS.ErrnoException & {
  address?: string;
  port?: number;
};

export async function startServer(fastify: FastifyInstance): Promise<void> {
  const PORT = parseInt(process.env.PORT || '3002', 10);

  try {
    await fastify.listen({ port: PORT, host: '0.0.0.0' });
  } catch (error) {
    if (error instanceof Error) {
      const networkError = error as NetworkError;
      logger.error('Failed to bind HTTP server', {
        port: PORT,
        error: error.message,
        stack: error.stack,
        code: networkError.code,
        errno: networkError.errno,
        syscall: networkError.syscall,
        address: networkError.address,
      });
    } else {
      logger.error('Failed to bind HTTP server', { port: PORT, error: String(error) });
    }
    throw error;
  }

  logger.info('='.repeat(80));
  logger.info('[CLOUD] Iotistica API Server');
  logger.info('='.repeat(80));
  logger.info(`Server running on http://localhost:${PORT}`);
  logger.info('='.repeat(80));

  const httpsServer = await startHttpsServer(fastify);

  try {
    websocketManager.initialize(fastify.server);
    logger.info(`WebSocket Server initialized (ws://localhost:${PORT}/ws)`);
    await websocketManager.initializeRedis();
  } catch (error) {
    if (error instanceof Error) {
      logger.warn('Failed to initialize WebSocket server', {
        error: error.message,
        stack: error.stack,
      });
    } else {
      logger.warn('Failed to initialize WebSocket server', { error: String(error) });
    }
  }

  const gracefulShutdown = createGracefulShutdown({ fastify, httpsServer });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('disconnect', () => gracefulShutdown('Debugger disconnect', 3000));
}
