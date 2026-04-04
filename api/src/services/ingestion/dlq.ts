import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { RedisDeviceEntry } from './types';

export const FAILURE_TRACKING_KEY = 'device:failed:attempts';

const maxlenArgs = (len: number): ['MAXLEN', '~', number] => ['MAXLEN', '~', len];

export async function incrementFailureCount(redis: Redis, messageId: string): Promise<number> {
  const count = await redis.hincrby(FAILURE_TRACKING_KEY, messageId, 1);
  // Refresh a 24h TTL each time so the hash expires naturally even if the pruner crashes
  await redis.expire(FAILURE_TRACKING_KEY, 24 * 60 * 60);
  return count;
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
  entry: RedisDeviceEntry,
  error: string,
  attempts: number,
): Promise<void> {
  // Step 1: Write to DLQ first. If this fails, bail without ACKing so the message stays
  // in the PEL and can be retried on the next redelivery cycle.
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
  } catch (err: any) {
    logger.error('Failed to write message to DLQ — message stays in PEL for retry', {
      messageId: entry.id,
      error: err.message,
    });
    return; // Do not ACK — message is NOT in DLQ yet
  }

  // Step 2: XADD succeeded — message IS in the DLQ. XACK must happen unconditionally;
  // a failure here would leave the PEL entry alive causing infinite redelivery.
  try {
    await redis.xack(streamKey, consumerGroup, entry.id);
  } catch (err: any) {
    logger.error('CRITICAL: DLQ write succeeded but XACK failed — PEL entry may cause redelivery', {
      messageId: entry.id,
      error: err.message,
    });
    // Do not rethrow — the message is in the DLQ; proceed to cleanup.
  }

  // Step 3: Remove from failure-tracking hash. Non-critical — swallow errors.
  try {
    await redis.hdel(FAILURE_TRACKING_KEY, entry.id);
  } catch { /* non-critical */ }

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
