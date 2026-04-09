import type Redis from 'ioredis';
import { logger } from '../utils/logger';
import { RedisDeviceEntry } from './types';
import { hIncrByAndExpire, moveToDlqAtomic } from './redis-scripts';

export const FAILURE_TRACKING_KEY = 'device:failed:attempts';

/**
 * Atomically increment the failure counter for a message and refresh the 24h TTL.
 * Uses a single EVALSHA round trip instead of the previous HINCRBY + EXPIRE two-step.
 */
export async function incrementFailureCount(redis: Redis, messageId: string): Promise<number> {
  return hIncrByAndExpire(redis, FAILURE_TRACKING_KEY, messageId, 24 * 60 * 60);
}

export async function getFailureCount(redis: Redis, messageId: string): Promise<number> {
  const attempts = await redis.hget(FAILURE_TRACKING_KEY, messageId);
  return attempts ? parseInt(attempts, 10) : 0;
}

/**
 * Atomically move a message to the DLQ in a single EVALSHA round trip:
 *   XADD → DLQ stream, XACK → source stream, HDEL → failure-tracking hash.
 *
 * If XADD fails (e.g. OOM) the script aborts before XACK/HDEL run, so the
 * original message remains in the PEL for retry and is never silently lost.
 * This eliminates the previous window where XADD could succeed but XACK could
 * fail, causing infinite PEL redelivery with duplicate DLQ entries.
 */
export async function moveToDLQ(
  redis: Redis,
  streamKey: string,
  consumerGroup: string,
  dlqStreamKey: string,
  maxDlqLength: number,
  entry: RedisDeviceEntry,
  error: string,
  attempts: number,
): Promise<void> {
  try {
    await moveToDlqAtomic(
      redis,
      streamKey, dlqStreamKey, FAILURE_TRACKING_KEY,
      consumerGroup, entry.id,
      JSON.stringify(entry.data),
      maxDlqLength,
      error, attempts,
      new Date().toISOString(),
    );
  } catch (err: unknown) {
    logger.error('Failed to move message to DLQ — message stays in PEL for retry', {
      messageId: entry.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  logger.warn('Message moved to DLQ after max retries', {
    messageId: entry.id,
    attempts,
    error,
    deviceUuid: entry.data.deviceUuid,
    deviceName: entry.data.deviceName,
  });
}

/**
 * Start a background interval that prunes stale entries from the failure tracking hash.
 * Returns the interval handle so the caller can clear it on shutdown.
 */
export function startFailureTrackingPruner(redis: Redis): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const allEntries = await redis.hgetall(FAILURE_TRACKING_KEY);
      if (!allEntries || Object.keys(allEntries).length === 0) return;

      const now = Date.now();
      const maxAgeMs = 24 * 60 * 60 * 1000;
      let prunedCount = 0;

      for (const messageId of Object.keys(allEntries)) {
        try {
          const timestamp = parseInt(messageId.split('-')[0], 10);
          if (now - timestamp > maxAgeMs) {
            await redis.hdel(FAILURE_TRACKING_KEY, messageId);
            prunedCount++;
          }
        } catch {
          await redis.hdel(FAILURE_TRACKING_KEY, messageId);
          prunedCount++;
        }
      }

      if (prunedCount > 0) {
        logger.debug('Pruned old failure tracking entries', {
          pruned: prunedCount,
          remaining: Object.keys(allEntries).length - prunedCount,
        });
      }
    } catch (err: any) {
      logger.error('Failed to prune failure tracking hash', { error: err.message });
    }
  }, 60 * 60 * 1000);
}
