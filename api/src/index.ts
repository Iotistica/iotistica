/**
 * Unified Iotistic API Server
 *
 * Entry point - deliberately thin. All setup is delegated to:
 *   server/   -> Express app wiring (security, middleware, routes, proxies, lifecycle)
 *   bootstrap/ -> Async service initialization (DB, config, license, Redis, MQTT)
 */

import { createApp } from './server/app';
import { bootstrap } from './bootstrap';
import { startServer } from './server/lifecycle';
import logger from './utils/logger';

const app = createApp();

bootstrap()
  .then(() => startServer(app))
  .catch((error) => {
    logger.error('Failed to start server', { error });
    process.exit(1);
  });

export default app;
