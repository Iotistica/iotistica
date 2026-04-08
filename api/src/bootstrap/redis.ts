/**
 * Redis bootstrap: connect client and start all Redis-dependent workers.
 *
 * Redis client failure is non-fatal (graceful degradation to PostgreSQL).
 * Log queue and device queue workers are critical - startup exits if they fail.
 */

import Redis from 'ioredis';
import logger from '../utils/logger';
import { redisClient } from '../redis/client';
import { redisFactory } from '../redis/client-factory';
import { startMetricsBatchWorker } from '../services/agent/metrics-worker';
import { redisLogQueue } from '../services/ingestion/redis-log-queue';
import { redisDeviceQueue } from '../services/ingestion';

/**
 * Flush the Mosquitto go-auth Redis cache (DB 1) on startup.
 *
 * go-auth caches both ALLOW and DENY results with a 300 s TTL. When the API
 * container restarts, any MQTT connection attempt during the brief downtime
 * causes go-auth to cache a DENY (backend unreachable → denied). That cached
 * denial persists for 5 minutes, preventing re-connection even after the API
 * is healthy again. Flushing DB 1 at startup ensures a clean slate so the
 * first post-restart MQTT connection always hits a live auth check.
 */
async function flushMqttAuthCache(): Promise<void> {
  const { host, port, username, password, useTls, tlsServerName } = redisFactory.getConfig();

  const authCacheDb = new Redis({
    host,
    port,
    username,
    password,
    tls: useTls
      ? {
          servername: tlsServerName,
          rejectUnauthorized: true,
        }
      : undefined,
    db: 1, // go-auth cache database
    lazyConnect: true,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
  });

  try {
    await authCacheDb.connect();
    const count = await authCacheDb.dbsize();
    await authCacheDb.flushdb();
    logger.info(`Flushed Mosquitto auth cache (Redis DB 1) — cleared ${count} entries`);
  } catch (error) {
    logger.warn('Failed to flush Mosquitto auth cache — MQTT may take up to 5 min to reconnect after restart', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await authCacheDb.quit().catch(() => { /* ignore */ });
  }
}

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

  // Flush go-auth MQTT auth cache so stale DENY entries from the previous
  // container lifecycle do not block MQTT reconnection.
  await flushMqttAuthCache();

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

  // Device queue worker - CRITICAL: device data won't be persisted without it
  try {
    await redisDeviceQueue.startWorker();
    logger.info('Redis device queue worker started');
  } catch (error) {
    logger.error('Failed to start Redis device queue worker', { error });
    process.exit(1);
  }
}
