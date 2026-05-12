/**
 * MQTT Message Deduplication Utility
 * 
 * Provides Redis-based deduplication for MQTT messages in HA bridge configurations.
 * Prevents duplicate processing when multiple brokers deliver the same message.
 * 
 * Pattern:
 * - Uses Redis SETNX (set if not exists) for atomic duplicate detection
 * - Key format: mqtt:dedup:{msgId}
 * - 24-hour TTL to prevent unbounded growth
 * - Graceful degradation if Redis unavailable
 * 
 * Usage:
 * ```typescript
 * const isDuplicate = await isDuplicateMessage(msgId);
 * if (isDuplicate) {
 *   logger.debug('Skipping duplicate message', { msgId });
 *   return;
 * }
 * // Process message...
 * ```
 */

import type Redis from 'ioredis';
import { redisClient } from '../redis/client';
import logger from '../utils/logger';

/**
 * Message deduplication configuration
 */
export interface DedupConfig {
  /** TTL for dedup keys in seconds (default: 24 hours) */
  ttlSeconds?: number;
  /** Key prefix for dedup entries (default: mqtt:dedup) */
  keyPrefix?: string;
  /** Whether to fail gracefully if Redis unavailable (default: true) */
  gracefulFallback?: boolean;
  /** Use Bloom filter for probabilistic dedup (memory-efficient for high volume) */
  useBloomFilter?: boolean;
  /** Bloom filter false positive rate (default: 0.01 = 1%) */
  bloomFalsePositiveRate?: number;
  /** Expected number of unique messages (used for Bloom filter sizing) */
  expectedUniqueMessages?: number;
}

const DEFAULT_CONFIG: Required<DedupConfig> = {
  ttlSeconds: 24 * 60 * 60, // 24 hours
  keyPrefix: 'mqtt:dedup',
  gracefulFallback: true,
  useBloomFilter: false,
  bloomFalsePositiveRate: 0.01,
  expectedUniqueMessages: 1000000 // 1M messages
};

/**
 * Deduplication statistics
 */
interface DedupStats {
  totalChecks: number;
  duplicatesFound: number;
  redisErrors: number;
  lastReset: number;
}

const stats: DedupStats = {
  totalChecks: 0,
  duplicatesFound: 0,
  redisErrors: 0,
  lastReset: Date.now()
};

let lastDedupOomLogAt = 0;

function isRedisOomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OOM command not allowed');
}

function logRedisOom(context: string, meta: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastDedupOomLogAt < 10_000) return;
  lastDedupOomLogAt = now;
  logger.warn(`Redis OOM during ${context} - deduplication temporarily bypassed`, meta);
}

/**
 * Check if message is duplicate and mark as seen
 * 
 * @param msgId - Unique message identifier (e.g., "device123-1705334400000-abc")
 * @param config - Deduplication configuration
 * @returns true if duplicate (already seen), false if first time
 * 
 * @example
 * ```typescript
 * const isDupe = await isDuplicateMessage('device123-1705334400000-abc');
 * if (isDupe) {
 *   logger.debug('Duplicate message, skipping');
 *   return;
 * }
 * // Process message...
 * ```
 */
export async function isDuplicateMessage(
  msgId: string,
  config: DedupConfig = {}
): Promise<boolean> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const key = `${cfg.keyPrefix}:${msgId}`;

  stats.totalChecks++;

  try {
    // Check if Redis is available
    if (!redisClient.isReady()) {
      logger.warn('Redis not ready, skipping deduplication check', { msgId });
      return cfg.gracefulFallback ? false : true; // Graceful: allow processing
    }

    const client = redisClient.getClient();

    // Use Bloom filter if enabled and Redis Bloom module is available
    if (cfg.useBloomFilter) {
      return await checkWithBloomFilter(client, msgId, cfg);
    }

    // Standard Redis SETNX approach
    // SETNX returns 1 if key was set (first time), 0 if already exists (duplicate)
    const result = await client.set(key, '1', 'EX', cfg.ttlSeconds, 'NX');

    if (result === 'OK') {
      // Key was set successfully - first time seeing this message
      logger.debug('Message marked as seen', { msgId, ttl: cfg.ttlSeconds });
      return false;
    } else {
      // Key already exists - duplicate message
      stats.duplicatesFound++;
      logger.debug('Duplicate message detected', { msgId });
      return true;
    }
  } catch (error) {
    stats.redisErrors++;
    if (isRedisOomError(error)) {
      logRedisOom('single-message deduplication check', { msgId });
    } else {
      logger.error('Error checking message duplication', {
        msgId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    // Graceful degradation: if Redis fails, decide whether to process or skip
    return cfg.gracefulFallback ? false : true;
  }
}

/**
 * Check duplication using Redis Bloom filter (memory-efficient for high volume)
 * Falls back to standard dedup if Bloom module not available
 */
async function checkWithBloomFilter(
  client: Redis,
  msgId: string,
  cfg: Required<DedupConfig>
): Promise<boolean> {
  const bloomKey = `${cfg.keyPrefix}:bloom`;
  
  try {
    // Try to add to Bloom filter (BF.ADD returns 1 if new, 0 if already exists)
    // If Redis Bloom not available, this will throw and we'll fallback
    const result = await client.call('BF.ADD', bloomKey, msgId);
    
    if (result === 1) {
      // New message (first time)
      logger.debug('Message added to Bloom filter', { msgId });
      return false;
    } else {
      // Likely duplicate (Bloom filter says it exists)
      stats.duplicatesFound++;
      logger.debug('Bloom filter detected probable duplicate', { msgId });
      return true;
    }
  } catch (error) {
    if (isRedisOomError(error)) {
      logRedisOom('Bloom-filter deduplication check', { msgId });
      return cfg.gracefulFallback ? false : true;
    }

    // Redis Bloom module not available - fallback to standard dedup
    logger.warn('Bloom filter not available, using standard deduplication', {
      error: error instanceof Error ? error.message : String(error)
    });
    
    const key = `${cfg.keyPrefix}:${msgId}`;
    const result = await client.set(key, '1', 'EX', cfg.ttlSeconds, 'NX');
    return result !== 'OK';
  }
}

/**
 * Check multiple messages for duplicates in batch (pipeline for efficiency)
 * 
 * @param msgIds - Array of message identifiers
 * @param config - Deduplication configuration
 * @returns Map of msgId -> isDuplicate
 * 
 * @example
 * ```typescript
 * const batch = ['msg1', 'msg2', 'msg3'];
 * const results = await checkBatchDuplicates(batch);
 * 
 * for (const msgId of batch) {
 *   if (!results.get(msgId)) {
 *     // Process non-duplicate
 *   }
 * }
 * ```
 */
export async function checkBatchDuplicates(
  msgIds: string[],
  config: DedupConfig = {}
): Promise<Map<string, boolean>> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const results = new Map<string, boolean>();

  if (msgIds.length === 0) {
    return results;
  }

  try {
    // Check if Redis is available
    if (!redisClient.isReady()) {
      logger.warn('Redis not ready, skipping batch deduplication check', { 
        count: msgIds.length 
      });
      // Graceful: mark all as non-duplicates to allow processing
      if (cfg.gracefulFallback) {
        msgIds.forEach(msgId => results.set(msgId, false));
      }
      return results;
    }

    const client = redisClient.getClient();
    const pipeline = client.pipeline();

    // Build pipeline with SET NX for each message
    const keys = msgIds.map(msgId => `${cfg.keyPrefix}:${msgId}`);
    keys.forEach(key => {
      pipeline.set(key, '1', 'EX', cfg.ttlSeconds, 'NX');
    });

    // Execute all commands atomically
    const pipelineResults = await pipeline.exec();

    if (!pipelineResults) {
      throw new Error('Pipeline execution returned null');
    }

    // Parse results
    let oomCount = 0;
    pipelineResults.forEach(([error, result], index) => {
      const msgId = msgIds[index];
      
      if (error) {
        if (isRedisOomError(error)) {
          oomCount++;
        } else {
          logger.error('Error in batch dedup check', { msgId, error });
        }
        // Graceful: treat as non-duplicate
        results.set(msgId, cfg.gracefulFallback ? false : true);
      } else {
        // Result is 'OK' if key was set (first time), null if already exists (duplicate)
        const isDuplicate = result !== 'OK';
        results.set(msgId, isDuplicate);
      }
    });

    if (oomCount > 0) {
      logRedisOom('batch deduplication check', { count: msgIds.length, oomCount });
    }

    const duplicateCount = Array.from(results.values()).filter(d => d).length;
    logger.debug('Batch deduplication check complete', {
      total: msgIds.length,
      duplicates: duplicateCount,
      unique: msgIds.length - duplicateCount
    });

    return results;
  } catch (error) {
    if (isRedisOomError(error)) {
      logRedisOom('batch deduplication check', { count: msgIds.length });
    } else {
      logger.error('Error in batch deduplication check', {
        count: msgIds.length,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    
    // Graceful degradation: mark all as non-duplicates to allow processing
    if (cfg.gracefulFallback) {
      msgIds.forEach(msgId => results.set(msgId, false));
    }
    return results;
  }
}

/**
 * Get deduplication statistics
 * Useful for monitoring and tuning dedup effectiveness
 */
export function getDedupStats(): DedupStats & { duplicationRate: number } {
  const duplicationRate = stats.totalChecks > 0 
    ? (stats.duplicatesFound / stats.totalChecks) * 100 
    : 0;
  
  return {
    ...stats,
    duplicationRate: parseFloat(duplicationRate.toFixed(2))
  };
}

/**
 * Reset deduplication statistics
 */
export function resetDedupStats(): void {
  stats.totalChecks = 0;
  stats.duplicatesFound = 0;
  stats.redisErrors = 0;
  stats.lastReset = Date.now();
  logger.info('Deduplication statistics reset');
}

/**
 * Calculate adaptive TTL based on message frequency
 * Higher frequency = shorter TTL (memory optimization)
 * Lower frequency = longer TTL (better dedup coverage)
 * 
 * @param deviceUuid - Device identifier
 * @param defaultTtl - Default TTL in seconds
 * @returns Recommended TTL in seconds
 */
export async function calculateAdaptiveTtl(
  deviceUuid: string,
  defaultTtl: number = 24 * 60 * 60
): Promise<number> {
  try {
    if (!redisClient.isReady()) {
      return defaultTtl;
    }

    const client = redisClient.getClient();
    const counterKey = `mqtt:freq:${deviceUuid}`;
    
    // Increment message counter with 1-hour sliding window
    await client.incr(counterKey);
    await client.expire(counterKey, 3600);
    
    // Get current frequency (messages per hour)
    const count = parseInt(await client.get(counterKey) || '0', 10);
    
    // Adaptive TTL calculation:
    // High frequency (>1000/hr): 1 hour TTL
    // Medium frequency (100-1000/hr): 6 hours TTL
    // Low frequency (<100/hr): 24 hours TTL
    if (count > 1000) {
      return 3600; // 1 hour
    } else if (count > 100) {
      return 6 * 3600; // 6 hours
    } else {
      return defaultTtl; // 24 hours (default)
    }
  } catch (error) {
    if (isRedisOomError(error)) {
      logRedisOom('adaptive TTL calculation', { deviceUuid });
    } else {
      logger.error('Error calculating adaptive TTL', {
        deviceUuid,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return defaultTtl;
  }
}

/**
 * Clear deduplication entry for a message (for testing/recovery)
 * 
 * @param msgId - Message identifier to clear
 * @param config - Deduplication configuration
 */
export async function clearDedupEntry(
  msgId: string,
  config: DedupConfig = {}
): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const key = `${cfg.keyPrefix}:${msgId}`;

  try {
    if (!redisClient.isReady()) {
      logger.warn('Redis not ready, cannot clear dedup entry', { msgId });
      return;
    }

    const client = redisClient.getClient();
    await client.del(key);
    logger.debug('Cleared deduplication entry', { msgId });
  } catch (error) {
    logger.error('Error clearing dedup entry', { 
      msgId,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

/**
 * Get Redis storage statistics for deduplication entries
 * 
 * @param config - Deduplication configuration
 * @returns Stats about stored dedup entries in Redis
 */
export async function getDedupStorageStats(
  config: DedupConfig = {}
): Promise<{ totalEntries: number; keyPrefix: string }> {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  try {
    if (!redisClient.isReady()) {
      return { totalEntries: 0, keyPrefix: cfg.keyPrefix };
    }

    const client = redisClient.getClient();
    const pattern = `${cfg.keyPrefix}:*`;
    
    // Use SCAN to avoid blocking Redis
    const keys: string[] = [];
    let cursor = '0';
    
    do {
      const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');

    return {
      totalEntries: keys.length,
      keyPrefix: cfg.keyPrefix
    };
  } catch (error) {
    logger.error('Error getting dedup storage stats', { 
      error: error instanceof Error ? error.message : String(error)
    });
    return { totalEntries: 0, keyPrefix: cfg.keyPrefix };
  }
}
