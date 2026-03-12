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
  msg_id?: string;
  is_critical?: number;
  status?: 'queued' | 'sending';
  lock_id?: string;
  locked_at?: Date;
  payload_bytes: number;
  retry_count: number;
  last_retry_at?: Date;
  next_retry_at?: Date;
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
  private static readonly TTL_CACHE_MS = 60_000;
  private static readonly QUOTA_CHECK_EVERY_INSERTS = 25;
  private static readonly DEFAULT_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
  private static ttlCacheHours?: number;
  private static ttlCacheAt?: number;
  private static insertsSinceQuotaCheck = 0;

  /**
   * Add message to buffer queue
   */
  static async enqueue(
    record: Omit<MessageBufferRecord, 'id' | 'created_at' | 'retry_count' | 'expires_at'>
  ): Promise<number> {
    const knex = getKnex();
    const ttlHours = await this.getTtlHours();
    const payloadBytes = Math.max(0, Math.min(Buffer.byteLength(record.payload, 'utf-8'), 1_000_000));
    
    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ttlHours);
    
    // Insert record
    const [id] = await knex(this.TABLE).insert({
      ...record,
      is_critical: record.is_critical ?? 0,
      status: 'queued',
      lock_id: null,
      locked_at: null,
      payload_bytes: payloadBytes,
      retry_count: 0,
      next_retry_at: null,
      created_at: knex.fn.now(),
      expires_at: expiresAt
    });
    
    // Increment total buffered counter
    await this.incrementMetric('total_buffered');
    
    // Check quotas and prune if needed
    this.insertsSinceQuotaCheck += 1;
    if (this.insertsSinceQuotaCheck >= this.QUOTA_CHECK_EVERY_INSERTS) {
      await this.enforceQuotas();
      this.insertsSinceQuotaCheck = 0;
    }
    
    return id;
  }

  /**
   * Get oldest N records for flushing (FIFO)
   */
  static async dequeueReady(
    limit: number = 100,
    now: Date = new Date(),
    lockTimeoutMs: number = this.DEFAULT_LOCK_TIMEOUT_MS
  ): Promise<MessageBufferRecord[]> {
    const knex = getKnex();
    const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = now.toISOString();
    const lockCutoffIso = new Date(now.getTime() - lockTimeoutMs).toISOString();

    return await knex.transaction(async (trx) => {
      const candidates = await trx(this.TABLE)
        .where((qb) => {
          qb.where((q1) => {
            q1.where('status', 'queued').andWhere('lock_id', null);
          }).orWhere((q2) => {
            q2.where('status', 'sending').andWhere('locked_at', '<', lockCutoffIso);
          });
        })
        .andWhereRaw('(next_retry_at IS NULL OR next_retry_at <= ?)', [nowIso])
        .orderBy('created_at', 'asc')
        .limit(limit)
        .select('id');

      const ids: number[] = [];
      for (const row of candidates as Array<{ id: number }>) {
        ids.push(row.id);
      }
      if (ids.length === 0) {
        return [];
      }

      await trx(this.TABLE)
        .whereIn('id', ids)
          .andWhereRaw(
            "((status = 'queued' AND lock_id IS NULL) OR (status = 'sending' AND locked_at < ?))",
            [lockCutoffIso]
          )
          .update({
          status: 'sending',
          lock_id: lockId,
          locked_at: nowIso
        });

      return trx(this.TABLE)
        .where('lock_id', lockId)
        .orderBy('created_at', 'asc')
        .select('*');
    });
  }

  /**
   * Backward-compatible alias for callers still expecting dequeueOldest().
   */
  static async dequeueOldest(limit: number = 100): Promise<MessageBufferRecord[]> {
    return this.dequeueReady(limit);
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
  static async markRetryFailed(id: number, error: string, nextRetryAt?: Date): Promise<void> {
    const knex = getKnex();

    const update: Record<string, unknown> = {
      retry_count: knex.raw('retry_count + 1'),
      last_retry_at: knex.fn.now(),
      last_error: error.substring(0, 500), // Truncate long errors
      next_retry_at: nextRetryAt ? nextRetryAt.toISOString() : null,
      status: 'queued',
      lock_id: null,
      locked_at: null
    };
    
    await knex(this.TABLE)
      .where('id', id)
      .update(update);
  }

  /**
   * Delete oldest records and count them as dropped (backpressure policy)
   */
  static async deleteOldest(limit: number, preserveCriticalTopics: boolean = false): Promise<number> {
    if (limit <= 0) {
      return 0;
    }

    const knex = getKnex();

    const oldest = await knex(this.TABLE)
      .where('status', 'queued')
      .andWhere('lock_id', null)
      .orderBy('created_at', 'asc')
      .limit(Math.max(limit * 3, limit))
      .select('id', 'topic', 'is_critical');

    if (oldest.length === 0) {
      return 0;
    }

    const idsToDelete: number[] = [];
    if (preserveCriticalTopics) {
      for (const record of oldest as Array<{ id: number; topic?: string; is_critical?: number }>) {
        if (idsToDelete.length >= limit) break;
        if (this.isCriticalRecord(record)) continue;
        idsToDelete.push(record.id);
      }
    } else {
      for (const record of oldest as Array<{ id: number }>) {
        if (idsToDelete.length >= limit) break;
        idsToDelete.push(record.id);
      }
    }

    if (idsToDelete.length === 0) {
      return 0;
    }

    const deleted = await knex(this.TABLE)
      .whereIn('id', idsToDelete)
      .delete();

    if (deleted > 0) {
      await this.incrementMetric('total_dropped', deleted);
    }

    return deleted;
  }

  /**
   * Delete records by IDs and count as dropped instead of flushed.
   */
  static async dropByIds(ids: number[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }

    const knex = getKnex();
    const deleted = await knex(this.TABLE)
      .whereIn('id', ids)
      .delete();

    if (deleted > 0) {
      await this.incrementMetric('total_dropped', deleted);
    }

    return deleted;
  }

  /**
   * Increment dropped counter when a new message is rejected by policy.
   */
  static async incrementDropped(amount: number = 1): Promise<void> {
    if (amount <= 0) {
      return;
    }

    await this.incrementMetric('total_dropped', amount);
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
  static async cleanupExpired(maxRetries?: number, lockTimeoutMs: number = 15 * 60 * 1000): Promise<number> {
    const knex = getKnex();
    const lockedCutoff = new Date(Date.now() - lockTimeoutMs).toISOString();
    const retryFutureCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // Recover orphaned lock rows first so they can retry instead of being stuck forever.
    await knex(this.TABLE)
      .where('status', 'sending')
      .andWhere('locked_at', '<', lockedCutoff)
      .update({
        status: 'queued',
        lock_id: null,
        locked_at: null
      });

    // Sanitize bad state where retry scheduling is pushed unreasonably far ahead.
    await knex(this.TABLE)
      .where('status', 'queued')
      .andWhere('next_retry_at', '>', retryFutureCutoff)
      .update({
        next_retry_at: null,
        last_error: knex.raw("COALESCE(last_error, '') || ' | retry_at_sanitized'")
      });

    const deleted = await knex(this.TABLE)
      .where((qb) => {
        qb.where('expires_at', '<', knex.fn.now());

        if (typeof maxRetries === 'number') {
          qb.orWhere('retry_count', '>', maxRetries);
        }
      })
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
    let currentBytes = parseInt(stats?.bytes || '0', 10);
    
    let dropped = 0;
    
    // Enforce record limit
    if (currentCount > maxRecords) {
      const excess = currentCount - maxRecords;
      const oldestRecords = await knex(this.TABLE)
        .where('status', 'queued')
        .andWhere('lock_id', null)
        .orderBy('created_at', 'asc')
        .limit(Math.max(excess * 3, excess))
        .select('id', 'topic', 'is_critical');

      const oldestIds: number[] = [];
      for (const record of oldestRecords as Array<{ id: number; topic?: string; is_critical?: number }>) {
        if (oldestIds.length >= excess) break;
        if (this.isCriticalRecord(record)) continue;
        oldestIds.push(record.id);
      }
      
      if (oldestIds.length > 0) {
        dropped += await knex(this.TABLE)
          .whereIn('id', oldestIds)
          .delete();
      }

      // Recompute bytes after record-limit pruning to avoid over-dropping in byte pass.
      const postRecordStats = await knex(this.TABLE)
        .count('* as count')
        .sum('payload_bytes as bytes')
        .first();
      currentBytes = parseInt(postRecordStats?.bytes || '0', 10);
    }
    
    // Enforce byte limit (if still exceeded)
    if (currentBytes > maxBytes) {
      // Drop oldest until under limit
      let bytesRemoved = 0;
      const oldestRecords = await knex(this.TABLE)
        .where('status', 'queued')
        .andWhere('lock_id', null)
        .orderBy('created_at', 'asc')
        .select('id', 'payload_bytes', 'topic', 'is_critical');
      
      const idsToDelete: number[] = [];
      for (const record of oldestRecords) {
        if (currentBytes - bytesRemoved <= maxBytes) break;
        if (this.isCriticalRecord(record)) continue;
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

  private static async getTtlHours(): Promise<number> {
    const now = Date.now();
    if (
      typeof this.ttlCacheHours === 'number' &&
      typeof this.ttlCacheAt === 'number' &&
      now - this.ttlCacheAt < this.TTL_CACHE_MS
    ) {
      return this.ttlCacheHours;
    }

    const knex = getKnex();
    const ttlResult = await knex(this.META_TABLE)
      .where('key', 'ttl_hours')
      .first();

    const ttlHours = parseInt(ttlResult?.value || '72', 10);
    this.ttlCacheHours = ttlHours;
    this.ttlCacheAt = now;
    return ttlHours;
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
        value: knex.raw('CAST(value AS INTEGER) + ?', [amount]),
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

  private static isCriticalRecord(record: { topic?: string; is_critical?: number }): boolean {
    if (record.is_critical === 1) {
      return true;
    }

    const topic = record.topic || '';
    return topic.startsWith('alerts/') || topic.startsWith('events/');
  }
}
