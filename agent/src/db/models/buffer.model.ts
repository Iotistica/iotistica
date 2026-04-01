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

import Database from 'better-sqlite3';
import { getDatabase } from '../sqlite';

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

type MessageBufferRow = Omit<MessageBufferRecord, 'created_at' | 'expires_at' | 'locked_at' | 'last_retry_at' | 'next_retry_at'> & {
  created_at: string | Date;
  expires_at: string | Date;
  locked_at?: string | Date | null;
  last_retry_at?: string | Date | null;
  next_retry_at?: string | Date | null;
};

export class MessageBufferModel {
  private static readonly TABLE = 'message_buffer';
  private static readonly META_TABLE = 'message_buffer_metadata';
  private static readonly TTL_CACHE_MS = 60_000;
  private static readonly DEFAULT_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
  private static ttlCacheHours?: number;
  private static ttlCacheAt?: number;

  private static getDb(): Database.Database {
    return getDatabase();
  }

  private static mapRow(row: MessageBufferRow): MessageBufferRecord {
    return {
      ...row,
      created_at: new Date(row.created_at),
      expires_at: new Date(row.expires_at),
      locked_at: row.locked_at ? new Date(row.locked_at) : undefined,
      last_retry_at: row.last_retry_at ? new Date(row.last_retry_at) : undefined,
      next_retry_at: row.next_retry_at ? new Date(row.next_retry_at) : undefined,
    };
  }

  /**
   * Add message to buffer queue
   */
  static enqueue(
    record: Omit<MessageBufferRecord, 'id' | 'created_at' | 'retry_count' | 'expires_at'>
  ): number {
    const db = this.getDb();
    const ttlHours = this.getTtlHoursSync();
    const payloadBytes = Math.max(0, Math.min(Buffer.byteLength(record.payload, 'utf-8'), 1_000_000));
    
    // Calculate expiration
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ttlHours);

    const createdAtIso = new Date().toISOString();
    const enqueueTransaction = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO ${this.TABLE} (
            endpoint_name,
            topic,
            qos,
            payload,
            msg_id,
            is_critical,
            status,
            lock_id,
            locked_at,
            payload_bytes,
            retry_count,
            next_retry_at,
            created_at,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          record.endpoint_name,
          record.topic,
          record.qos,
          record.payload,
          record.msg_id ?? null,
          record.is_critical ?? 0,
          'queued',
          null,
          null,
          payloadBytes,
          0,
          null,
          createdAtIso,
          expiresAt.toISOString(),
        );

      this.incrementMetricSync('total_buffered');
      this.enforceQuotasSync();

      return Number(result.lastInsertRowid);
    });

    return enqueueTransaction.immediate();
  }

  /**
   * Get oldest N records for flushing (FIFO)
   */
  static dequeueReady(
    limit: number = 100,
    now: Date = new Date(),
    lockTimeoutMs: number = this.DEFAULT_LOCK_TIMEOUT_MS
  ): MessageBufferRecord[] {
    if (limit <= 0) {
      return [];
    }

    const db = this.getDb();
    const lockId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = now.toISOString();
    const lockCutoffIso = new Date(now.getTime() - lockTimeoutMs).toISOString();

    const dequeueTransaction = db.transaction(() => {
      const candidateRows = db
        .prepare(`
          SELECT id
          FROM ${this.TABLE}
          WHERE (
            (status = 'queued' AND lock_id IS NULL)
            OR (status = 'sending' AND locked_at < ?)
          )
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
          ORDER BY created_at ASC
          LIMIT ?
        `)
        .all(lockCutoffIso, nowIso, limit) as Array<{ id: number }>;

      if (candidateRows.length === 0) {
        return [];
      }

      const ids = candidateRows.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(', ');

      const updated = db.prepare(`
        UPDATE ${this.TABLE}
        SET status = 'sending',
            lock_id = ?,
            locked_at = ?
        WHERE id IN (${placeholders})
          AND (
            (status = 'queued' AND lock_id IS NULL)
            OR (status = 'sending' AND locked_at < ?)
          )
      `).run(lockId, nowIso, ...ids, lockCutoffIso).changes;

      if (updated === 0) {
        return [];
      }

      const lockedRows = db
        .prepare(`
          SELECT *
          FROM ${this.TABLE}
          WHERE lock_id = ?
          ORDER BY created_at ASC
        `)
        .all(lockId) as MessageBufferRow[];

      return lockedRows.map((row) => this.mapRow(row));
    });

    return dequeueTransaction.immediate();
  }

  /**
   * Backward-compatible alias for callers still expecting dequeueOldest().
   */
  static dequeueOldest(limit: number = 100): MessageBufferRecord[] {
    return this.dequeueReady(limit);
  }

  /**
   * Delete records by IDs (after successful publish)
   */
  static deleteByIds(ids: number[]): number {
    if (ids.length === 0) return 0;

    const db = this.getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const deleted = db
      .prepare(`DELETE FROM ${this.TABLE} WHERE id IN (${placeholders})`)
      .run(...ids).changes;

    if (deleted > 0) {
	  this.incrementMetric('total_flushed', deleted);
    }

    return deleted;
  }

  /**
   * Mark record as failed retry
   */
  static markRetryFailed(id: number, error: string, nextRetryAt?: Date): void {
    this.getDb()
      .prepare(`
        UPDATE ${this.TABLE}
        SET retry_count = retry_count + 1,
            last_retry_at = ?,
            last_error = ?,
            next_retry_at = ?,
            status = 'queued',
            lock_id = NULL,
            locked_at = NULL
        WHERE id = ?
      `)
      .run(
        new Date().toISOString(),
        error.substring(0, 500),
        nextRetryAt ? nextRetryAt.toISOString() : null,
        id,
      );
  }

  /**
   * Delete oldest records and count them as dropped (backpressure policy)
   */
  static deleteOldest(limit: number, preserveCriticalTopics: boolean = false): number {
    if (limit <= 0) {
      return 0;
    }

    const db = this.getDb();

    const oldest = db
      .prepare(`
        SELECT id, topic, is_critical
        FROM ${this.TABLE}
        WHERE status = 'queued' AND lock_id IS NULL
        ORDER BY created_at ASC
        LIMIT ?
      `)
      .all(Math.max(limit * 3, limit)) as Array<{ id: number; topic?: string; is_critical?: number }>;

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

    const placeholders = idsToDelete.map(() => '?').join(', ');
    const deleted = db
      .prepare(`DELETE FROM ${this.TABLE} WHERE id IN (${placeholders})`)
      .run(...idsToDelete).changes;

    if (deleted > 0) {
	  this.incrementMetric('total_dropped', deleted);
    }

    return deleted;
  }

  /**
   * Delete records by IDs and count as dropped instead of flushed.
   */
  static dropByIds(ids: number[]): number {
    if (ids.length === 0) {
      return 0;
    }

    const db = this.getDb();
    const placeholders = ids.map(() => '?').join(', ');
    const deleted = db
      .prepare(`DELETE FROM ${this.TABLE} WHERE id IN (${placeholders})`)
      .run(...ids).changes;

    if (deleted > 0) {
	  this.incrementMetric('total_dropped', deleted);
    }

    return deleted;
  }

  /**
   * Increment dropped counter when a new message is rejected by policy.
   */
  static incrementDropped(amount: number = 1): void {
    if (amount <= 0) {
      return;
    }

	this.incrementMetric('total_dropped', amount);
  }

  /**
   * Get current buffer statistics
   */
  static getStats(): BufferStats {
    const db = this.getDb();

    const queueStats = db
      .prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
        FROM ${this.TABLE}
      `)
      .get() as { count?: number | string; bytes?: number | string } | undefined;

    const oldest = db
      .prepare(`
        SELECT created_at
        FROM ${this.TABLE}
        ORDER BY created_at ASC
        LIMIT 1
      `)
      .get() as { created_at?: string | Date } | undefined;
    
    let oldestAgeHours: number | undefined;
    if (oldest?.created_at) {
      const age = Date.now() - new Date(oldest.created_at).getTime();
      oldestAgeHours = Math.floor(age / (1000 * 60 * 60));
    }
    
    // Lifetime counters
  const buffered = this.getMetric('total_buffered');
  const flushed = this.getMetric('total_flushed');
  const dropped = this.getMetric('total_dropped');
    
    return {
      current_count: parseInt(String(queueStats?.count ?? '0'), 10),
      current_bytes: parseInt(String(queueStats?.bytes ?? '0'), 10),
      total_buffered: buffered,
      total_flushed: flushed,
      total_dropped: dropped,
      oldest_record_age_hours: oldestAgeHours
    };
  }

  /**
   * Cleanup expired records (TTL enforcement)
   */
  static cleanupExpired(maxRetries?: number, lockTimeoutMs: number = 15 * 60 * 1000): number {
    const db = this.getDb();
    const lockedCutoff = new Date(Date.now() - lockTimeoutMs).toISOString();
    const retryFutureCutoff = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const deleted = db.transaction(() => {
      // Recover orphaned lock rows first so they can retry instead of being stuck forever.
      db.prepare(`
        UPDATE ${this.TABLE}
        SET status = 'queued',
            lock_id = NULL,
            locked_at = NULL
        WHERE status = 'sending'
          AND locked_at < ?
      `).run(lockedCutoff);

      // Sanitize bad state where retry scheduling is pushed unreasonably far ahead.
      db.prepare(`
        UPDATE ${this.TABLE}
        SET next_retry_at = NULL,
            last_error = COALESCE(last_error, '') || ' | retry_at_sanitized'
        WHERE status = 'queued'
          AND next_retry_at > ?
      `).run(retryFutureCutoff);

      if (typeof maxRetries === 'number') {
        return db.prepare(`
          DELETE FROM ${this.TABLE}
          WHERE expires_at < ? OR retry_count > ?
        `).run(new Date().toISOString(), maxRetries).changes;
      }

      return db.prepare(`
        DELETE FROM ${this.TABLE}
        WHERE expires_at < ?
      `).run(new Date().toISOString()).changes;
    }).immediate();
    
    if (deleted > 0) {
    this.incrementMetric('total_dropped', deleted);
    this.setMetric('last_cleanup_at', new Date().toISOString());
    }
    
    return deleted;
  }

  /**
   * Enforce quota limits (drop oldest if exceeded)
   */
  private static enforceQuotas(): void {
    const dropped = this.getDb().transaction(() => this.enforceQuotasSync()).immediate();

    if (dropped <= 0) {
      return;
    }
  }

  /**
   * Get metadata value
   */
  private static getMetric(key: string): number {
    const result = this.getDb()
      .prepare(`SELECT value FROM ${this.META_TABLE} WHERE key = ? LIMIT 1`)
      .get(key) as { value?: string | number } | undefined;

    return parseInt(String(result?.value ?? '0'), 10);
  }

  private static getTtlHours(): number {
    return this.getTtlHoursSync();
  }

  private static getTtlHoursSync(): number {
    const now = Date.now();
    if (
      typeof this.ttlCacheHours === 'number' &&
      typeof this.ttlCacheAt === 'number' &&
      now - this.ttlCacheAt < this.TTL_CACHE_MS
    ) {
      return this.ttlCacheHours;
    }

    const ttlResult = this.getDb()
      .prepare(`SELECT value FROM ${this.META_TABLE} WHERE key = ? LIMIT 1`)
      .get('ttl_hours') as { value?: string | number } | undefined;

    const ttlHours = parseInt(String(ttlResult?.value ?? '72'), 10);
    this.ttlCacheHours = ttlHours;
    this.ttlCacheAt = now;
    return ttlHours;
  }

  /**
   * Set metadata value
   */
  private static setMetric(key: string, value: string): void {
    this.getDb()
      .prepare(`
        UPDATE ${this.META_TABLE}
        SET value = ?,
            updated_at = ?
        WHERE key = ?
      `)
      .run(value, new Date().toISOString(), key);
  }

  /**
   * Increment metadata counter
   */
  private static incrementMetric(key: string, amount: number = 1): void {
    this.incrementMetricSync(key, amount);
  }

  private static incrementMetricSync(key: string, amount: number = 1): void {
    this.getDb()
      .prepare(`
        INSERT INTO ${this.META_TABLE} (key, value, updated_at)
        VALUES (?, CAST(? AS TEXT), ?)
        ON CONFLICT(key) DO UPDATE SET
          value = CAST(
            COALESCE(CAST(${this.META_TABLE}.value AS INTEGER), 0) +
            COALESCE(CAST(excluded.value AS INTEGER), 0)
            AS TEXT
          ),
          updated_at = excluded.updated_at
      `)
      .run(key, amount, new Date().toISOString());
  }

  private static enforceQuotasSync(): number {
    const db = this.getDb();
    const maxRecords = this.getMetricSync('max_records');
    const maxBytes = this.getMetricSync('max_bytes');

    const stats = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(payload_bytes), 0) AS bytes
      FROM ${this.TABLE}
    `).get() as { count?: number | string; bytes?: number | string } | undefined;

    const getQueuedOldest = db.prepare(`
      SELECT id, topic, is_critical, payload_bytes
      FROM ${this.TABLE}
      WHERE status = 'queued' AND lock_id IS NULL
      ORDER BY created_at ASC
    `);

    let currentCount = parseInt(String(stats?.count ?? '0'), 10);
    let currentBytes = parseInt(String(stats?.bytes ?? '0'), 10);
    let deletedCount = 0;

    if (currentCount > maxRecords) {
      const excess = currentCount - maxRecords;
      const oldestRecords = getQueuedOldest.all() as Array<{ id: number; topic?: string; is_critical?: number; payload_bytes: number }>;

      const oldestIds: number[] = [];
      for (const record of oldestRecords) {
        if (oldestIds.length >= excess) break;
        if (this.isCriticalRecord(record)) continue;
        oldestIds.push(record.id);
      }

      if (oldestIds.length > 0) {
        const placeholders = oldestIds.map(() => '?').join(', ');
        deletedCount += db.prepare(`DELETE FROM ${this.TABLE} WHERE id IN (${placeholders})`).run(...oldestIds).changes;

        const postRecordStats = db.prepare(`
          SELECT COALESCE(SUM(payload_bytes), 0) AS bytes
          FROM ${this.TABLE}
        `).get() as { bytes?: number | string } | undefined;
        currentBytes = parseInt(String(postRecordStats?.bytes ?? '0'), 10);
        currentCount -= oldestIds.length;
      }
    }

    if (currentBytes > maxBytes) {
      let bytesRemoved = 0;
      const oldestRecords = getQueuedOldest.all() as Array<{ id: number; payload_bytes: number; topic?: string; is_critical?: number }>;

      const idsToDelete: number[] = [];
      for (const record of oldestRecords) {
        if (currentBytes - bytesRemoved <= maxBytes) break;
        if (this.isCriticalRecord(record)) continue;
        idsToDelete.push(record.id);
        bytesRemoved += record.payload_bytes;
      }

      if (idsToDelete.length > 0) {
        const placeholders = idsToDelete.map(() => '?').join(', ');
        deletedCount += db.prepare(`DELETE FROM ${this.TABLE} WHERE id IN (${placeholders})`).run(...idsToDelete).changes;
      }
    }

    if (deletedCount > 0) {
      this.incrementMetricSync('total_dropped', deletedCount);
    }

    return deletedCount;
  }

  private static getMetricSync(key: string): number {
    const result = this.getDb()
      .prepare(`SELECT value FROM ${this.META_TABLE} WHERE key = ? LIMIT 1`)
      .get(key) as { value?: string | number } | undefined;

    return parseInt(String(result?.value ?? '0'), 10);
  }

  /**
   * Clear all buffered data (for testing)
   */
  static clear(): void {
    this.getDb()
      .prepare(`DELETE FROM ${this.TABLE}`)
      .run();
  }

  /**
   * Get records by endpoint name
   */
  static getByEndpoint(endpointName: string, limit: number = 100): MessageBufferRecord[] {
    if (limit <= 0) {
      return [];
    }

    const rows = this.getDb()
      .prepare(`
        SELECT *
        FROM ${this.TABLE}
        WHERE endpoint_name = ?
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(endpointName, limit) as MessageBufferRow[];

    return rows.map((row) => this.mapRow(row));
  }

  private static isCriticalRecord(record: { topic?: string; is_critical?: number }): boolean {
    if (record.is_critical === 1) {
      return true;
    }

    const topic = record.topic || '';
    return topic.startsWith('alerts/') || topic.startsWith('events/');
  }
}
