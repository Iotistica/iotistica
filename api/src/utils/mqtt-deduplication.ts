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
import logger from './logger';

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
}

const DEFAULT_CONFIG: Required<DedupConfig> = {
  ttlSeconds: 24 * 60 * 60, // 24 hours
  keyPrefix: 'mqtt:dedup',
  gracefulFallback: true
};

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

  try {
    // Check if Redis is available
    if (!redisClient.isReady()) {
      logger.warn('Redis not ready, skipping deduplication check', { msgId });
      return cfg.gracefulFallback ? false : true; // Graceful: allow processing
    }

    const client = redisClient.getClient();

    // SETNX returns 1 if key was set (first time), 0 if already exists (duplicate)
    const result = await client.set(key, '1', 'EX', cfg.ttlSeconds, 'NX');

    if (result === 'OK') {
      // Key was set successfully - first time seeing this message
      logger.debug('Message marked as seen', { msgId, ttl: cfg.ttlSeconds });
      return false;
    } else {
      // Key already exists - duplicate message
      logger.debug('Duplicate message detected', { msgId });
      return true;
    }
  } catch (error) {
    logger.error('Error checking message duplication', { 
      msgId, 
      error: error instanceof Error ? error.message : String(error)
    });
    
    // Graceful degradation: if Redis fails, decide whether to process or skip
    return cfg.gracefulFallback ? false : true;
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
    pipelineResults.forEach(([error, result], index) => {
      const msgId = msgIds[index];
      
      if (error) {
        logger.error('Error in batch dedup check', { msgId, error });
        // Graceful: treat as non-duplicate
        results.set(msgId, cfg.gracefulFallback ? false : true);
      } else {
        // Result is 'OK' if key was set (first time), null if already exists (duplicate)
        const isDuplicate = result !== 'OK';
        results.set(msgId, isDuplicate);
      }
    });

    const duplicateCount = Array.from(results.values()).filter(d => d).length;
    logger.debug('Batch deduplication check complete', {
      total: msgIds.length,
      duplicates: duplicateCount,
      unique: msgIds.length - duplicateCount
    });

    return results;
  } catch (error) {
    logger.error('Error in batch deduplication check', { 
      count: msgIds.length,
      error: error instanceof Error ? error.message : String(error)
    });
    
    // Graceful degradation: mark all as non-duplicates to allow processing
    if (cfg.gracefulFallback) {
      msgIds.forEach(msgId => results.set(msgId, false));
    }
    return results;
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
 * Get deduplication statistics
 * 
 * @param config - Deduplication configuration
 * @returns Stats about dedup entries
 */
export async function getDedupStats(
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
    logger.error('Error getting dedup stats', { 
      error: error instanceof Error ? error.message : String(error)
    });
    return { totalEntries: 0, keyPrefix: cfg.keyPrefix };
  }
}
