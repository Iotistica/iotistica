/**
 * Server lifecycle: starts HTTP + HTTPS listeners, WebSocket, and
 * registers graceful shutdown signal handlers.
 */

import express from 'express';
import logger from '../utils/logger';
import { websocketManager } from '../services/websocket/manager';
import { startHttpsServer } from './https';
import { createGracefulShutdown } from './shutdown';

export async function startServer(app: express.Application): Promise<void> {
  const PORT = process.env.PORT || 3002;

  const server = app.listen(PORT, () => {
    logger.info('='.repeat(80));
    logger.info('[CLOUD] Iotistica API Server');
    logger.info('='.repeat(80));
    logger.info(`Server running on http://localhost:${PORT}`);
    logger.info('='.repeat(80));
  });

  const httpsServer = await startHttpsServer(app);

  try {
    websocketManager.initialize(server);
    logger.info(`WebSocket Server initialized (ws://localhost:${PORT}/ws)`);
    await websocketManager.initializeRedis();
  } catch (error) {
    logger.warn('Failed to initialize WebSocket server', { error });
  }

  const gracefulShutdown = createGracefulShutdown({ server, httpsServer });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('disconnect', () => gracefulShutdown('Debugger disconnect', 3000));
}
