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
import { logger } from '../utils/logger';
import { ReadingsService, ReadingInsert } from './readings.service';

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
  private readingsService: ReadingsService;

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
    this.readingsService = new ReadingsService();

    this.redis.on('error', (err) => {
      logger.error('Redis sensor queue connection error', { error: err.message });
    });

    this.redis.on('connect', () => {
      logger.info('Redis sensor queue connected');
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
        logger.info('Created Redis consumer group for sensors', {
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
          logger.error('Error in sensor worker loop', { error: err.message });
          // Don't crash, wait and retry
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
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
      await this.insertReadingsBatch(allData);

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
   * Transform sensor data entries to readings format and insert in batches
   * Chunks data into groups of 500 to avoid PostgreSQL parameter limits
   */
  private async insertReadingsBatch(data: SensorDataEntry[]): Promise<void> {
    const chunkSize = 500;
    
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      
      // Transform sensor data to readings format (with batch expansion)
      const readings: ReadingInsert[] = [];
      
      chunk.forEach(entry => {
        // Detect protocol from metadata or sensor name
        let protocol = 'mqtt'; // Default to MQTT
        
        // Check metadata first (most reliable)
        if (entry.metadata?.protocol) {
          protocol = entry.metadata.protocol;
        }
        // Check for exact match or prefix pattern
        else if (entry.sensorName === 'modbus' || entry.sensorName.startsWith('modbus_')) {
          protocol = 'modbus';
        }
        else if (entry.sensorName === 'opcua' || entry.sensorName.startsWith('opcua_')) {
          protocol = 'opcua';
        }
        else if (entry.sensorName === 'snmp' || entry.sensorName.startsWith('snmp_')) {
          protocol = 'snmp';
        }
        else if (entry.sensorName === 'can' || entry.sensorName.startsWith('can_')) {
          protocol = 'can';
        }

        // Check if this is a batch message (Modbus/OPC UA can send multiple readings)
        if (entry.data && Array.isArray(entry.data.readings)) {
          // Expand batch into individual readings
          entry.data.readings.forEach((reading: any) => {
            const extra: Record<string, any> = {
              sensor_name: entry.sensorName,
            };
            
            // Add device name if present
            if (reading.deviceName) {
              extra.deviceName = reading.deviceName;
            }
            
            // Extract anomaly fields (if present from edge AI)
            const anomaly_score = typeof reading.anomaly_score === 'number' ? reading.anomaly_score : undefined;
            const anomaly_threshold = typeof reading.anomaly_threshold === 'number' ? reading.anomaly_threshold : undefined;
            const baseline_samples = typeof reading.baseline_samples === 'number' ? reading.baseline_samples : undefined;
            const detection_methods = reading.detection_methods || undefined;
            
            // Add any additional fields to extra (excluding anomaly fields now in dedicated columns)
            Object.entries(reading).forEach(([key, val]) => {
              if (!['value', 'quality', 'unit', 'timestamp', 'registerName', 'deviceName', 
                    'anomaly_score', 'anomaly_threshold', 'baseline_samples', 'detection_methods'].includes(key)) {
                extra[key] = val;
              }
            });
            
            readings.push({
              device_uuid: entry.deviceUuid,
              metric_name: reading.registerName || reading.nodeName || entry.sensorName,
              value: typeof reading.value === 'number' ? reading.value : null,
              quality: reading.quality?.toLowerCase() || 'good',
              unit: reading.unit || null,
              protocol,
              extra,
              time: new Date(reading.timestamp || entry.timestamp),
              // Add anomaly fields
              ...(anomaly_score !== undefined && { anomaly_score }),
              ...(anomaly_threshold !== undefined && { anomaly_threshold }),
              ...(baseline_samples !== undefined && { baseline_samples }),
              ...(detection_methods !== undefined && { detection_methods })
            });
          });
        } else {
          // Single reading (legacy format)
          const value = typeof entry.data === 'object' 
            ? (entry.data.value ?? entry.data.rawValue ?? null)
            : entry.data;

          const quality = entry.data?.quality?.toLowerCase() || 'good';
          const unit = entry.data?.unit || null;

          // Store protocol-specific metadata in extra
          const extra: Record<string, any> = {};
          if (entry.data && typeof entry.data === 'object') {
            // Copy all fields except value, quality, unit (already in dedicated columns)
            Object.entries(entry.data).forEach(([key, val]) => {
              if (!['value', 'rawValue', 'quality', 'unit', 'timestamp', 'readings'].includes(key)) {
                extra[key] = val;
              }
            });
          }
          // Add original sensor name for backward compatibility
          extra.sensor_name = entry.sensorName;
          
          // Add metadata if present
          if (entry.metadata && Object.keys(entry.metadata).length > 0) {
            extra.metadata = entry.metadata;
          }

          readings.push({
            device_uuid: entry.deviceUuid,
            metric_name: entry.sensorName,
            value: typeof value === 'number' ? value : null,
            quality,
            unit,
            protocol,
            extra,
            time: new Date(entry.timestamp)
          });
        }
      });

      // Use ReadingsService for optimized bulk insert
      const insertedCount = await this.readingsService.bulkInsert(readings);
      
      logger.debug(`Inserted ${insertedCount} readings to database (chunk ${Math.floor(i / chunkSize) + 1})`);
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
