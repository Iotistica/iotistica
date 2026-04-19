/**
 * Bootstrap orchestrator.
 *
 * Runs all startup initializations in dependency order:
 *   database → config → license → workers → redis → mqtt (non-blocking)
 *
 * Fatal failures (database, config, license) call process.exit(1).
 * Non-fatal failures (workers, redis degradation) are logged and skipped.
 * MQTT is fire-and-forget - never blocks startup.
 */

import logger from '../utils/logger';
import { bootstrapDatabase } from './database';
import { bootstrapConfig } from './config';
import { bootstrapLicense } from './license';
import { bootstrapWorkers } from './workers';
import { bootstrapApiRedis } from './redis';
import { bootstrapMqtt } from './mqtt';
import { bootstrapBrokerMonitor } from './broker-monitor';

export async function bootstrap(): Promise<void> {
  logger.info('Initializing Iotistica API service...');

  await fatal('Database', bootstrapDatabase);
  await fatal('System configuration', bootstrapConfig);
  await fatal('License validator', bootstrapLicense);

  await bootstrapWorkers();
  await bootstrapApiRedis();
  bootstrapMqtt();
  bootstrapBrokerMonitor();
}

async function fatal(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    logger.error(`${name} initialization failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
