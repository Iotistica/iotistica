/**
 * Message Buffer Model
 * ====================
 * 
 * Local database queue for sensor/endpoint data when MQTT is unavailable.
 * Implements offline resilience pattern from AWS IoT Greengrass.
 * 
 * Features:
 * - Automatic pruning when quota exceeded
 * - TTL-based expiration
 * - Batch operations for efficiency
 * - Statistics tracking
 */

import { getKnex } from '../connection';

export interface MessageBufferRecord {
  id?: number;
  endpoint_name: string;
  topic: string;
  qos: number;
  payload: string;
  payload_bytes: number;
  retry_count: number;
  last_retry_at?: Date;
  last_error?: string;
  created_at: Date;
  expires_at: Date;
}

export interface BufferStats {
  current_count: number;
  current_bytes: number;
  total_buffered: number;
  total_flushed: number;
  total_dropped: number;
  oldest_record_age_hours?: number;
}

export class MessageBufferModel {
  private static readonly TABLE = 'message_buffer';
  private static readonly META_TABLE = 'message_buffer_metadata';

  /**
   * Add message to buffer queue
   */
  static async enqueue(record: Omit<MessageBufferRecord, 'id' | 'created_at' | 'retry_count' | 'expires_at'>): Promise<number> {
    const knex = getKnex();
    
    // Get TTL from metadata
    const ttlResult = await knex(this.META_TABLE)
      .where('key', 'ttl_hours')
      .first();
    const ttlHours = parseInt(ttlResult?.value || '72', 10);
    
    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ttlHours);
    
    // Insert record
    const [id] = await knex(this.TABLE).insert({
      ...record,
      retry_count: 0,
      created_at: knex.fn.now(),
      expires_at: expiresAt
    });
    
    // Increment total buffered counter
    await this.incrementMetric('total_buffered');
    
    // Check quotas and prune if needed
    await this.enforceQuotas();
    
    return id;
  }

  /**
   * Get oldest N records for flushing (FIFO)
   */
  static async dequeueOldest(limit: number = 100): Promise<MessageBufferRecord[]> {
    const knex = getKnex();
    
    return await knex(this.TABLE)
      .orderBy('created_at', 'asc')
      .limit(limit)
      .select('*');
  }

  /**
   * Delete records by IDs (after successful publish)
   */
  static async deleteByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) return 0;
    
    const knex = getKnex();
    const deleted = await knex(this.TABLE)
      .whereIn('id', ids)
      .delete();
    
    // Increment flushed counter
    if (deleted > 0) {
      await this.incrementMetric('total_flushed', deleted);
    }
    
    return deleted;
  }

  /**
   * Mark record as failed retry
   */
  static async markRetryFailed(id: number, error: string): Promise<void> {
    const knex = getKnex();
    
    await knex(this.TABLE)
      .where('id', id)
      .update({
        retry_count: knex.raw('retry_count + 1'),
        last_retry_at: knex.fn.now(),
        last_error: error.substring(0, 500) // Truncate long errors
      });
  }

  /**
   * Get current buffer statistics
   */
  static async getStats(): Promise<BufferStats> {
    const knex = getKnex();
    
    // Current queue stats
    const queueStats = await knex(this.TABLE)
      .count('* as count')
      .sum('payload_bytes as bytes')
      .first();
    
    // Oldest record age
    const oldest = await knex(this.TABLE)
      .orderBy('created_at', 'asc')
      .first('created_at');
    
    let oldestAgeHours: number | undefined;
    if (oldest?.created_at) {
      const age = Date.now() - new Date(oldest.created_at).getTime();
      oldestAgeHours = Math.floor(age / (1000 * 60 * 60));
    }
    
    // Lifetime counters
    const buffered = await this.getMetric('total_buffered');
    const flushed = await this.getMetric('total_flushed');
    const dropped = await this.getMetric('total_dropped');
    
    return {
      current_count: parseInt(queueStats?.count || '0', 10),
      current_bytes: parseInt(queueStats?.bytes || '0', 10),
      total_buffered: buffered,
      total_flushed: flushed,
      total_dropped: dropped,
      oldest_record_age_hours: oldestAgeHours
    };
  }

  /**
   * Cleanup expired records (TTL enforcement)
   */
  static async cleanupExpired(): Promise<number> {
    const knex = getKnex();
    
    const deleted = await knex(this.TABLE)
      .where('expires_at', '<', knex.fn.now())
      .delete();
    
    if (deleted > 0) {
      await this.incrementMetric('total_dropped', deleted);
      await this.setMetric('last_cleanup_at', new Date().toISOString());
    }
    
    return deleted;
  }

  /**
   * Enforce quota limits (drop oldest if exceeded)
   */
  private static async enforceQuotas(): Promise<void> {
    const knex = getKnex();
    
    // Get quota limits
    const maxRecords = await this.getMetric('max_records');
    const maxBytes = await this.getMetric('max_bytes');
    
    // Check current stats
    const stats = await knex(this.TABLE)
      .count('* as count')
      .sum('payload_bytes as bytes')
      .first();
    
    const currentCount = parseInt(stats?.count || '0', 10);
    const currentBytes = parseInt(stats?.bytes || '0', 10);
    
    let dropped = 0;
    
    // Enforce record limit
    if (currentCount > maxRecords) {
      const excess = currentCount - maxRecords;
      const oldestIds = await knex(this.TABLE)
        .orderBy('created_at', 'asc')
        .limit(excess)
        .pluck('id');
      
      dropped += await knex(this.TABLE)
        .whereIn('id', oldestIds)
        .delete();
    }
    
    // Enforce byte limit (if still exceeded)
    if (currentBytes > maxBytes) {
      // Drop oldest until under limit
      let bytesRemoved = 0;
      const oldestRecords = await knex(this.TABLE)
        .orderBy('created_at', 'asc')
        .select('id', 'payload_bytes');
      
      const idsToDelete: number[] = [];
      for (const record of oldestRecords) {
        if (currentBytes - bytesRemoved <= maxBytes) break;
        idsToDelete.push(record.id);
        bytesRemoved += record.payload_bytes;
      }
      
      if (idsToDelete.length > 0) {
        dropped += await knex(this.TABLE)
          .whereIn('id', idsToDelete)
          .delete();
      }
    }
    
    if (dropped > 0) {
      await this.incrementMetric('total_dropped', dropped);
    }
  }

  /**
   * Get metadata value
   */
  private static async getMetric(key: string): Promise<number> {
    const knex = getKnex();
    const result = await knex(this.META_TABLE)
      .where('key', key)
      .first();
    
    return parseInt(result?.value || '0', 10);
  }

  /**
   * Set metadata value
   */
  private static async setMetric(key: string, value: string): Promise<void> {
    const knex = getKnex();
    
    await knex(this.META_TABLE)
      .where('key', key)
      .update({
        value,
        updated_at: knex.fn.now()
      });
  }

  /**
   * Increment metadata counter
   */
  private static async incrementMetric(key: string, amount: number = 1): Promise<void> {
    const knex = getKnex();
    
    await knex(this.META_TABLE)
      .where('key', key)
      .update({
        value: knex.raw(`CAST(value AS INTEGER) + ${amount}`),
        updated_at: knex.fn.now()
      });
  }

  /**
   * Clear all buffered data (for testing)
   */
  static async clear(): Promise<void> {
    const knex = getKnex();
    await knex(this.TABLE).delete();
  }

  /**
   * Get records by endpoint name
   */
  static async getByEndpoint(endpointName: string, limit: number = 100): Promise<MessageBufferRecord[]> {
    const knex = getKnex();
    
    return await knex(this.TABLE)
      .where('endpoint_name', endpointName)
      .orderBy('created_at', 'desc')
      .limit(limit)
      .select('*');
  }
}
