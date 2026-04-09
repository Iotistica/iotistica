import { createIngestionServer } from './server/app';
import { startIngestionServer } from './server/lifecycle';
import logger from './utils/logger';
import { bootstrapConfig } from './bootstrap/config';
import { bootstrapDatabaseConnection } from './bootstrap/database';
import { bootstrapIngestionRedis } from './bootstrap/redis';

type NetworkError = NodeJS.ErrnoException & {
  address?: string;
  port?: number;
};

async function main(): Promise<void> {
  logger.info('Initializing Iotistica ingestion service...');

  await bootstrapDatabaseConnection();
  await bootstrapConfig();

  const server = createIngestionServer();
  await bootstrapIngestionRedis();
  await startIngestionServer(server);
}

main().catch((error) => {
  if (error instanceof Error) {
    const networkError = error as NetworkError;
    logger.error('Failed to start ingestion service', {
      error: error.message,
      stack: error.stack,
      code: networkError.code,
      errno: networkError.errno,
      syscall: networkError.syscall,
      address: networkError.address,
      port: networkError.port,
    });
  } else {
    logger.error('Failed to start ingestion service', { error: String(error) });
  }

  process.exit(1);
});