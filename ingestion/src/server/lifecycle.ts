import type { Server } from 'http';
import logger from '../utils/logger';
import { createGracefulShutdown } from './shutdown';

type NetworkError = NodeJS.ErrnoException & {
  address?: string;
  port?: number;
};

export async function startIngestionServer(server: Server): Promise<void> {
  const port = parseInt(process.env.PORT || '3003', 10);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    if (error instanceof Error) {
      const networkError = error as NetworkError;
      logger.error('Failed to bind ingestion HTTP server', {
        port,
        error: error.message,
        stack: error.stack,
        code: networkError.code,
        errno: networkError.errno,
        syscall: networkError.syscall,
        address: networkError.address,
      });
    } else {
      logger.error('Failed to bind ingestion HTTP server', { port, error: String(error) });
    }

    throw error;
  }

  logger.info('='.repeat(80));
  logger.info('Iotistica ingestion worker service');
  logger.info('='.repeat(80));
  logger.info(`Server running on http://localhost:${port}`);
  logger.info('='.repeat(80));

  const gracefulShutdown = createGracefulShutdown({ server });
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('disconnect', () => gracefulShutdown('Debugger disconnect', 3000));
}