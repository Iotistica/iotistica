/**
 * Unified Iotistic API Server
 *
 * Entry point - deliberately thin. All setup is delegated to:
 *   server/   -> Fastify app wiring (security, middleware, routes, proxies, lifecycle)
 *   bootstrap/ -> Async service initialization (DB, config, license, Redis, MQTT)
 */

import { createApp } from './server/app';
import { bootstrap } from './bootstrap';
import { startServer } from './server/lifecycle';
import logger from './utils/logger';

type NetworkError = NodeJS.ErrnoException & {
  address?: string;
  port?: number;
};

async function main() {
  const app = await createApp();

  await bootstrap();
  await startServer(app);
}

main().catch((error) => {
  if (error instanceof Error) {
    const networkError = error as NetworkError;
    logger.error('Failed to start server', {
      error: error.message,
      stack: error.stack,
      code: networkError.code,
      errno: networkError.errno,
      syscall: networkError.syscall,
      address: networkError.address,
      port: networkError.port,
    });
  } else {
    logger.error('Failed to start server', { error: String(error) });
  }
  process.exit(1);
});

