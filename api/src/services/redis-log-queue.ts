/**
 * Redis Streams Log Queue
 * 
 * Uses Redis Streams for persistent, distributed log batching.
 * Solves connection pool exhaustion by decoupling log ingestion from DB writes.
 * 
 * Benefits:
 * - Persistent: Survives API restarts
 * - Scalable: Multiple workers can consume
 * - Backpressure: Queue absorbs traffic spikes
 * - Atomic batching: XREAD returns exact batch size
 */

import Redis from 'ioredis';
import { DeviceLogsModel } from '../db/models';
import { logger } from '../utils/logger';
import { query } from '../db/connection';

interface LogEntry {
  deviceUuid: string;
  serviceName?: string;
  timestamp?: Date;
  message: string;
  level?: string;
  isSystem?: boolean;
  isStderr?: boolean;
}

interface RedisLogEntry {
  id: string; // Redis stream message ID
  data: LogEntry;
}

class RedisLogQueue {
  private redis: Redis;
  private consumerGroup = 'log-writers';
  private consumerName: string;
  private streamKey = 'device:logs';
  private isRunning = false;
  private batchSize: number;
  private blockTimeMs: number;

  constructor() {
    // Separate Redis connection for log queue (doesn't compete with other operations)
    this.redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: 20, // Increased for high load scenarios
      enableOfflineQueue: true, // Queue commands during reconnection
      retryStrategy: (times) => {
        if (times > 50) return null; // Stop after 50 attempts
        return Math.min(times * 100, 5000); // Exponential backoff, max 5s
      },
      reconnectOnError: (err) => {
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
    });

    this.consumerName = `worker-${process.pid}-${Date.now()}`;
    this.batchSize = parseInt(process.env.LOG_BATCH_SIZE || '50', 10);
    this.blockTimeMs = parseInt(process.env.LOG_FLUSH_INTERVAL_MS || '5000', 10);

    this.redis.on('error', (err) => {
      logger.error('Redis log queue connection error', { error: err.message });
    });

    this.redis.on('connect', () => {
      logger.info('Redis log queue connected');
    });
  }

  /**
   * Initialize consumer group (idempotent)
   * Retries on failure to handle Redis not being ready
   */
  async initialize(): Promise<void> {
    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Create consumer group (fails if already exists, that's ok)
        await this.redis.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
        logger.info('Created Redis consumer group for logs', {
          stream: this.streamKey,
          group: this.consumerGroup
        });
        return; // Success
      } catch (err: any) {
        if (err.message.includes('BUSYGROUP')) {
          logger.info('Redis consumer group already exists', { group: this.consumerGroup });
          return; // Already exists, success
        }
        
        lastError = err;
        logger.warn(`Failed to create consumer group (attempt ${attempt}/${maxRetries})`, {
          error: err.message,
          group: this.consumerGroup
        });
        
        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
        }
      }
    }

    // All retries failed
    throw new Error(`Failed to initialize Redis consumer group after ${maxRetries} attempts: ${lastError?.message}`);
  }

  /**
   * Add logs to Redis Stream (fast, non-blocking)
   * Gracefully degrades by dropping logs if Redis is unavailable
   */
  async add(logs: LogEntry[]): Promise<void> {
    if (logs.length === 0) return;

    try {
      const startTime = Date.now();

      // Check Redis connection before attempting write
      if (this.redis.status !== 'ready' && this.redis.status !== 'connect') {
        logger.warn('Redis not ready, dropping logs', {
          status: this.redis.status,
          count: logs.length
        });
        return; // Graceful degradation: drop logs instead of crashing
      }

      // Use pipeline for bulk insert (atomic)
      const pipeline = this.redis.pipeline();
      for (const log of logs) {
        pipeline.xadd(
          this.streamKey,
          '*', // Auto-generate ID
          'data', JSON.stringify(log)
        );
      }

      await pipeline.exec();

      const duration = Date.now() - startTime;
      
      // Only log slow operations to reduce log spam under load
      if (duration > 1000) {
        logger.warn('Slow Redis write operation', {
          count: logs.length,
          durationMs: duration
        });
      } else {
        logger.debug('Added logs to Redis stream', {
          count: logs.length,
          durationMs: duration,
          logsPerSecond: Math.round((logs.length / duration) * 1000)
        });
      }
    } catch (err: any) {
      logger.error('Failed to add logs to Redis stream', {
        count: logs.length,
        error: err.message,
        redisStatus: this.redis.status
      });
      // Don't throw - graceful degradation: drop logs instead of crashing API
    }
  }

  /**
   * Start background worker that consumes and batches logs
   */
  async startWorker(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Log worker already running');
      return;
    }

    await this.initialize();
    this.isRunning = true;

    logger.info('Starting Redis log worker', {
      consumer: this.consumerName,
      batchSize: this.batchSize,
      blockTimeMs: this.blockTimeMs
    });

    // Run worker loop
    this.workerLoop().catch(err => {
      logger.error('Worker loop crashed', { error: err.message, stack: err.stack });
      this.isRunning = false;
    });
  }

  /**
   * Worker loop: Read batch → Write to DB → Acknowledge
   */
  private async workerLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        // Read batch from stream (blocks until batch size reached OR timeout)
        // XREADGROUP GROUP <group> <consumer> COUNT <batch> BLOCK <ms> STREAMS <key> >
        const results = await this.redis.xreadgroup(
          'GROUP',
          this.consumerGroup,
          this.consumerName,
          'COUNT',
          this.batchSize,
          'BLOCK',
          this.blockTimeMs,
          'STREAMS',
          this.streamKey,
          '>' // Only new messages
        );

        if (!results || results.length === 0) {
          // Timeout reached, no messages
          continue;
        }

        // Parse messages - results is [streamName, messages[]]
        const streamData = results[0] as [string, Array<[string, string[]]>];
        const [streamName, messages] = streamData;
        const entries: RedisLogEntry[] = messages.map(([id, fields]: [string, string[]]) => ({
          id,
          data: JSON.parse(fields[1]) // fields[0] = 'data', fields[1] = JSON
        }));

        if (entries.length === 0) continue;

        await this.processBatch(entries);

      } catch (err: any) {
        // Check if consumer group disappeared (Redis restart/flush)
        if (err.message && err.message.includes('NOGROUP')) {
          logger.warn('Consumer group missing, reinitializing...', {
            group: this.consumerGroup,
            stream: this.streamKey
          });
          try {
            await this.initialize();
            logger.info('Consumer group reinitialized successfully');
            continue; // Retry immediately
          } catch (initErr: any) {
            logger.error('Failed to reinitialize consumer group', { error: initErr.message });
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        } else {
          logger.error('Error in worker loop', { error: err.message });
          // Don't crash, wait and retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  /**
   * Process a batch: Group by device → Write to DB → Acknowledge
   */
  private async processBatch(entries: RedisLogEntry[]): Promise<void> {
    const startTime = Date.now();

    try {
      // Collect all logs with deviceUuid embedded
      const allLogs: Array<{
        deviceUuid: string;
        serviceName?: string;
        timestamp?: Date;
        message: string;
        level?: string;
        isSystem?: boolean;
        isStderr?: boolean;
      }> = entries.map(entry => entry.data);

      if (allLogs.length === 0) return;

      // Insert all logs in one batch operation (DeviceLogsModel handles chunking)
      await this.insertLogsBatch(allLogs);

      // Acknowledge messages (atomic)
      const messageIds = entries.map(e => e.id);
      await this.redis.xack(this.streamKey, this.consumerGroup, ...messageIds);

      const duration = Date.now() - startTime;
      
      // Count unique devices for logging
      const uniqueDevices = new Set(allLogs.map(log => log.deviceUuid)).size;
      
      logger.info('Processed log batch from Redis', {
        totalLogs: entries.length,
        devices: uniqueDevices,
        durationMs: duration,
        logsPerSecond: Math.round((entries.length / duration) * 1000)
      });

    } catch (err: any) {
      logger.error('Failed to process log batch', {
        count: entries.length,
        error: err.message
      });
      // Messages will be redelivered to another consumer
    }
  }

  /**
   * Insert all logs in a single batch INSERT (across all devices)
   * Chunks logs into groups of 500 to avoid PostgreSQL parameter limits
   */
  private async insertLogsBatch(
    logs: Array<{
      deviceUuid: string;
      serviceName?: string;
      timestamp?: Date;
      message: string;
      level?: string;
      isSystem?: boolean;
      isStderr?: boolean;
    }>
  ): Promise<void> {
    const batchSize = parseInt(process.env.LOG_INSERT_BATCH_SIZE || '500', 10);
    
    // Split into chunks to avoid PostgreSQL parameter limit (65535)
    // With 7 params per log, max is ~9000, we use 500 for safety
    const chunks: typeof logs[] = [];
    for (let i = 0; i < logs.length; i += batchSize) {
      chunks.push(logs.slice(i, i + batchSize));
    }

    // Insert all chunks in parallel (connection pool handles concurrency)
    await Promise.all(
      chunks.map(async (chunk) => {
        const values: any[] = [];
        const placeholders: string[] = [];

        chunk.forEach((log, index) => {
          const offset = index * 7;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
          );
          values.push(
            log.deviceUuid,
            log.serviceName || null,
            log.timestamp || new Date(),
            log.message,
            log.level || 'info',
            log.isSystem || false,
            log.isStderr || false
          );
        });

        await query(
          `INSERT INTO device_logs (device_uuid, service_name, timestamp, message, level, is_system, is_stderr)
           VALUES ${placeholders.join(', ')}`,
          values
        );
      })
    );
  }

  /**
   * Stop worker gracefully
   */
  async stopWorker(): Promise<void> {
    logger.info('Stopping Redis log worker...');
    this.isRunning = false;
    
    // Wait for current batch to complete (max 10 seconds)
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    await this.redis.quit();
    logger.info('Redis log worker stopped');
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    try {
      const info = await this.redis.xinfo('STREAM', this.streamKey);
      const pending = await this.redis.xpending(this.streamKey, this.consumerGroup);

      // Parse Redis response (array format)
      const length = info[1] as number; // Stream length
      const firstEntry = info[11] as string[]; // First entry ID
      const lastEntry = info[13] as string[]; // Last entry ID

      return {
        streamLength: length,
        firstEntryId: firstEntry ? firstEntry[0] : null,
        lastEntryId: lastEntry ? lastEntry[0] : null,
        pendingMessages: pending[0] as number, // Messages being processed
        consumerGroup: this.consumerGroup,
        consumerName: this.consumerName,
        isRunning: this.isRunning
      };
    } catch (err: any) {
      return {
        error: err.message
      };
    }
  }
}

// Singleton instance
export const redisLogQueue = new RedisLogQueue();
