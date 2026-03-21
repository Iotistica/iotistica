/**
 * Redis bootstrap: connect client and start all Redis-dependent workers.
 *
 * Redis client failure is non-fatal (graceful degradation to PostgreSQL).
 * Log queue and sensor queue workers are critical - startup exits if they fail.
 */

import logger from '../utils/logger';
import { redisClient } from '../redis/client';
import { startMetricsBatchWorker } from '../workers/metrics-batch-worker';
import { redisLogQueue } from '../services/logs-queue/redis-log-queue';
import { redisSensorQueue } from '../services/device-queue';

export async function bootstrapRedis(): Promise<void> {
  // Redis client - non-fatal, degrades to PostgreSQL-only mode
  try {
    await redisClient.connect();
    logger.info('[OK] Redis client connected successfully');
  } catch (error) {
    logger.warn('Redis connection failed - continuing without real-time features', {
      error: error instanceof Error ? error.message : String(error),
      note: 'This is non-critical - metrics will use PostgreSQL only',
    });
  }

  // Metrics batch worker - non-fatal
  try {
    await startMetricsBatchWorker();
    logger.info('Metrics batch worker started');
  } catch (error) {
    logger.warn('Failed to start metrics batch worker', { error });
  }

  // Log queue worker - CRITICAL: logs won't be persisted without it
  try {
    await redisLogQueue.startWorker();
    logger.info('Redis log queue worker started');
  } catch (error) {
    logger.error('Failed to start Redis log queue worker', { error });
    process.exit(1);
  }

  // Sensor queue worker - CRITICAL: sensor data won't be persisted without it
  try {
    await redisSensorQueue.startWorker();
    logger.info('Redis sensor queue worker started');
  } catch (error) {
    logger.error('Failed to start Redis sensor queue worker', { error });
    process.exit(1);
  }
}
