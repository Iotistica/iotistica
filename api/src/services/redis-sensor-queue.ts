/**
 * Redis Streams Sensor Data Queue
 * 
 * Uses Redis Streams for persistent, distributed sensor data batching.
 * Decouples sensor data ingestion from DB writes to prevent connection pool exhaustion.
 * 
 * Benefits:
 * - Persistent: Survives API restarts
 * - Scalable: Multiple workers can consume
 * - Backpressure: Queue absorbs traffic spikes
 * - Atomic batching: XREAD returns exact batch size
 */

import Redis from 'ioredis';
import { query } from '../db/connection';
import { logger } from '../utils/logger';

interface SensorDataEntry {
  deviceUuid: string;
  sensorName: string;
  timestamp: string;
  data: any;
  metadata?: Record<string, any>;
}

interface RedisSensorEntry {
  id: string; // Redis stream message ID
  data: SensorDataEntry;
}

class RedisSensorQueue {
  private redis: Redis;
  private consumerGroup = 'sensor-writers';
  private consumerName: string;
  private streamKey = 'device:sensors';
  private isRunning = false;
  private batchSize: number;
  private blockTimeMs: number;

  constructor() {
    // Separate Redis connection for sensor queue
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
    this.batchSize = parseInt(process.env.SENSOR_BATCH_SIZE || '100', 10);
    this.blockTimeMs = parseInt(process.env.SENSOR_FLUSH_INTERVAL_MS || '2000', 10);

    this.redis.on('error', (err) => {
      logger.error('Redis sensor queue connection error', { error: err.message });
    });

    this.redis.on('connect', () => {
      logger.info('Redis sensor queue connected');
    });
  }

  /**
   * Initialize consumer group (idempotent)
   */
  async initialize(): Promise<void> {
    try {
      // Create consumer group (fails if already exists, that's ok)
      await this.redis.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
      logger.info('Created Redis consumer group for sensors', {
        stream: this.streamKey,
        group: this.consumerGroup
      });
    } catch (err: any) {
      if (err.message.includes('BUSYGROUP')) {
        logger.info('Redis consumer group already exists', { group: this.consumerGroup });
      } else {
        throw err;
      }
    }
  }

  /**
   * Add sensor data to Redis Stream (fast, non-blocking)
   * Gracefully degrades by dropping data if Redis is unavailable
   */
  async add(sensorData: SensorDataEntry[]): Promise<void> {
    if (sensorData.length === 0) return;

    try {
      const startTime = Date.now();

      // Check Redis connection before attempting write
      if (this.redis.status !== 'ready' && this.redis.status !== 'connect') {
        logger.warn('Redis not ready, dropping sensor data', {
          status: this.redis.status,
          count: sensorData.length
        });
        return; // Graceful degradation: drop data instead of crashing
      }

      // Use pipeline for bulk insert (atomic)
      const pipeline = this.redis.pipeline();
      for (const data of sensorData) {
        pipeline.xadd(
          this.streamKey,
          '*', // Auto-generate ID
          'data', JSON.stringify(data)
        );
      }

      await pipeline.exec();

      const duration = Date.now() - startTime;
      
      // Only log slow operations to reduce log spam under load
      if (duration > 1000) {
        logger.warn('Slow Redis write operation', {
          count: sensorData.length,
          durationMs: duration
        });
      } else {
        logger.debug('Added sensor data to Redis stream', {
          count: sensorData.length,
          durationMs: duration,
          dataPerSecond: Math.round((sensorData.length / duration) * 1000)
        });
      }
    } catch (err: any) {
      logger.error('Failed to add sensor data to Redis stream', {
        count: sensorData.length,
        error: err.message,
        redisStatus: this.redis.status
      });
      // Don't throw - graceful degradation: drop data instead of crashing API
    }
  }

  /**
   * Start background worker that consumes and batches sensor data
   */
  async startWorker(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Sensor worker already running');
      return;
    }

    await this.initialize();
    this.isRunning = true;

    logger.info('Starting Redis sensor worker', {
      consumer: this.consumerName,
      batchSize: this.batchSize,
      blockTimeMs: this.blockTimeMs
    });

    // Run worker loop
    this.workerLoop().catch(err => {
      logger.error('Sensor worker loop crashed', { error: err.message, stack: err.stack });
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

        // Parse messages
        const streamData = results[0] as [string, Array<[string, string[]]>];
        const [streamName, messages] = streamData;
        const entries: RedisSensorEntry[] = messages.map(([id, fields]: [string, string[]]) => ({
          id,
          data: JSON.parse(fields[1]) // fields[0] = 'data', fields[1] = JSON
        }));

        if (entries.length === 0) continue;

        await this.processBatch(entries);

      } catch (err: any) {
        logger.error('Error in sensor worker loop', { error: err.message });
        // Don't crash, wait and retry
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Process a batch: Insert to DB → Acknowledge
   */
  private async processBatch(entries: RedisSensorEntry[]): Promise<void> {
    const startTime = Date.now();

    try {
      const allData: SensorDataEntry[] = entries.map(entry => entry.data);

      if (allData.length === 0) return;

      // Insert all sensor data in one batch operation
      await this.insertSensorDataBatch(allData);

      // Acknowledge messages (atomic)
      const messageIds = entries.map(e => e.id);
      await this.redis.xack(this.streamKey, this.consumerGroup, ...messageIds);

      const duration = Date.now() - startTime;
      
      // Count unique devices and sensors for logging
      const uniqueDevices = new Set(allData.map(d => d.deviceUuid)).size;
      const uniqueSensors = new Set(allData.map(d => `${d.deviceUuid}/${d.sensorName}`)).size;
      
      logger.info('Processed sensor data batch from Redis', {
        totalReadings: entries.length,
        devices: uniqueDevices,
        sensors: uniqueSensors,
        durationMs: duration,
        readingsPerSecond: Math.round((entries.length / duration) * 1000)
      });

    } catch (err: any) {
      logger.error('Failed to process sensor data batch', {
        count: entries.length,
        error: err.message
      });
      // Messages will be redelivered to another consumer
    }
  }

  /**
   * Insert all sensor data in a single batch INSERT
   * Chunks data into groups of 500 to avoid PostgreSQL parameter limits
   */
  private async insertSensorDataBatch(data: SensorDataEntry[]): Promise<void> {
    const chunkSize = 500;
    
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      
      // Build bulk INSERT query
      const values: any[] = [];
      const placeholders: string[] = [];
      
      chunk.forEach((entry, idx) => {
        const offset = idx * 5;
        placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        values.push(
          entry.deviceUuid,
          entry.sensorName,
          JSON.stringify(entry.data),
          entry.timestamp,
          JSON.stringify(entry.metadata || {})
        );
      });
      
      const sql = `
        INSERT INTO sensor_data (device_uuid, sensor_name, data, timestamp, metadata)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT DO NOTHING
      `;
      
      await query(sql, values);
      
      logger.debug(`Inserted ${chunk.length} sensor readings to database`);
    }
  }

  /**
   * Stop worker
   */
  async stopWorker(): Promise<void> {
    logger.info('Stopping Redis sensor worker...');
    this.isRunning = false;
    
    // Wait for current batch to complete (max 10 seconds)
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    await this.redis.quit();
    logger.info('Redis sensor worker stopped');
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    try {
      const info = await this.redis.xinfo('STREAM', this.streamKey);
      const pending = await this.redis.xpending(this.streamKey, this.consumerGroup);

      // Parse Redis response (array format)
      const length = info[1] as number;
      const firstEntry = info[11] as string[];
      const lastEntry = info[13] as string[];

      return {
        streamLength: length,
        firstEntryId: firstEntry ? firstEntry[0] : null,
        lastEntryId: lastEntry ? lastEntry[0] : null,
        pendingMessages: pending[0] as number,
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
export const redisSensorQueue = new RedisSensorQueue();
