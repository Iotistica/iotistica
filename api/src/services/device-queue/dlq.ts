import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { RedisSensorEntry } from './types';

export const FAILURE_TRACKING_KEY = 'sensor:failed:attempts';

const maxlenArgs = (len: number): ['MAXLEN', '~', number] => ['MAXLEN', '~', len];

export async function incrementFailureCount(redis: Redis, messageId: string): Promise<number> {
  return redis.hincrby(FAILURE_TRACKING_KEY, messageId, 1);
}

export async function getFailureCount(redis: Redis, messageId: string): Promise<number> {
  const attempts = await redis.hget(FAILURE_TRACKING_KEY, messageId);
  return attempts ? parseInt(attempts, 10) : 0;
}

export async function moveToDLQ(
  redis: Redis,
  streamKey: string,
  consumerGroup: string,
  dlqStreamKey: string,
  maxDlqLength: number,
  entry: RedisSensorEntry,
  error: string,
  attempts: number,
): Promise<void> {
  try {
    await redis.xadd(
      dlqStreamKey,
      ...maxlenArgs(maxDlqLength),
      '*',
      'data', JSON.stringify(entry.data),
      'original_id', entry.id,
      'error', error,
      'attempts', attempts.toString(),
      'failed_at', new Date().toISOString(),
    );
    await redis.xack(streamKey, consumerGroup, entry.id);
    await redis.hdel(FAILURE_TRACKING_KEY, entry.id);

    logger.warn('Message moved to DLQ after max retries', {
      messageId: entry.id,
      attempts,
      error,
      deviceUuid: entry.data.deviceUuid,
      sensorName: entry.data.sensorName,
    });
  } catch (err: any) {
    logger.error('Failed to move message to DLQ', { messageId: entry.id, error: err.message });
  }
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
        logger.info('Pruned old failure tracking entries', {
          pruned: prunedCount,
          remaining: Object.keys(allEntries).length - prunedCount,
        });
      }
    } catch (err: any) {
      logger.error('Failed to prune failure tracking hash', { error: err.message });
    }
  }, 60 * 60 * 1000);
}
