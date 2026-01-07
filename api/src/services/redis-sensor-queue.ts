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

/**
 * Prometheus metrics for observability
 * Tracks: stream length, pending count, latencies, drops, reconnects
 */
class SensorQueueMetrics {
  // Gauges (current state)
  streamLength = 0;
  pendingMessages = 0;
  dlqLength = 0;
  failureTrackingCount = 0;
  redisConnected = 1;
  
  // Counters (cumulative)
  messagesProcessed = 0;
  messagesFailed = 0;
  messagesDropped = 0;
  readingsInserted = 0;
  redisReconnects = 0;
  
  // Histograms (timing, keep last 100 samples)
  batchLatencies: number[] = [];
  insertLatencies: number[] = [];
  private maxSamples = 100;
  
  recordBatchLatency(ms: number) {
    this.batchLatencies.push(ms);
    if (this.batchLatencies.length > this.maxSamples) {
      this.batchLatencies.shift();
    }
  }
  
  recordInsertLatency(ms: number) {
    this.insertLatencies.push(ms);
    if (this.insertLatencies.length > this.maxSamples) {
      this.insertLatencies.shift();
    }
  }
  
  getBatchLatencyP95(): number {
    if (this.batchLatencies.length === 0) return 0;
    const sorted = [...this.batchLatencies].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] || 0;
  }
  
  getInsertLatencyP95(): number {
    if (this.insertLatencies.length === 0) return 0;
    const sorted = [...this.insertLatencies].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[idx] || 0;
  }
}

const metrics = new SensorQueueMetrics();

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
  private dlqStreamKey = 'device:sensors:dlq';
  private maxRetries: number;
  private isRunning = false;
  private workerCount: number;
  private batchSize: number;
  private blockTimeMs: number;
  private maxStreamLength: number;
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
    this.workerCount = parseInt(process.env.SENSOR_WORKER_COUNT || '2', 10);
    this.maxRetries = parseInt(process.env.SENSOR_MAX_RETRIES || '3', 10);
    this.batchSize = parseInt(process.env.SENSOR_BATCH_SIZE || '100', 10);
    this.blockTimeMs = parseInt(process.env.SENSOR_FLUSH_INTERVAL_MS || '2000', 10);
    // Stream retention: ~1M messages = ~2-4h of data at 100-200 msg/s ingestion rate
    // Provides buffer for DB outages while preventing OOM
    this.maxStreamLength = parseInt(process.env.REDIS_STREAM_MAXLEN || '1000000', 10);
    this.readingsService = new ReadingsService();

    this.redis.on('error', (err) => {
      logger.error('Redis sensor queue connection error', { error: err.message });
      metrics.redisConnected = 0;
    });

    this.redis.on('connect', () => {
      logger.info('Redis sensor queue connected');
      metrics.redisConnected = 1;
      metrics.redisReconnects++;
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
        metrics.messagesDropped += sensorData.length;
        logger.warn('Redis not ready, dropping sensor data', {
          status: this.redis.status,
          count: sensorData.length,
          totalDropped: metrics.messagesDropped
        });
        return; // Graceful degradation: drop data instead of crashing
      }

      // Chunk pipeline operations to prevent huge packets and latency spikes
      const PIPELINE_CHUNK_SIZE = 500;
      for (let i = 0; i < sensorData.length; i += PIPELINE_CHUNK_SIZE) {
        const chunk = sensorData.slice(i, i + PIPELINE_CHUNK_SIZE);
        const pipeline = this.redis.pipeline();
        
        for (const data of chunk) {
          pipeline.xadd(
            this.streamKey,
            'MAXLEN',
            '~', // Approximate trimming (more efficient than exact)
            this.maxStreamLength,
            '*', // Auto-generate ID
            'data', JSON.stringify(data)
          );
        }

        await pipeline.exec();
      }

      const duration = Date.now() - startTime;
      metrics.recordBatchLatency(duration);
      
      // Only log slow operations to reduce log spam under load
      if (duration > 1000) {
        logger.warn('Slow Redis write operation', {
          count: sensorData.length,
          durationMs: duration,
          batchLatencyP95Ms: metrics.getBatchLatencyP95()
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

    logger.info('Starting Redis sensor workers', {
      consumer: this.consumerName,
      workerCount: this.workerCount,
      batchSize: this.batchSize,
      blockTimeMs: this.blockTimeMs
    });

    // Start multiple worker loops for parallel processing
    // Each worker competes for messages via consumer group (load balancing)
    for (let i = 0; i < this.workerCount; i++) {
      this.workerLoop(i).catch(err => {
        logger.error('Sensor worker loop crashed', { 
          workerId: i,
          error: err.message, 
          stack: err.stack 
        });
        // Other workers continue running
      });
    }
  }

  /**
   * Claim stale pending messages from crashed workers
   * Uses XAUTOCLAIM (Redis ≥6.2) to recover messages stuck in PENDING state
   */
  private async claimStaleMessages(): Promise<RedisSensorEntry[]> {
    try {
      const minIdleMs = 60000; // 60s - messages idle longer than this are considered stale
      const result = await this.redis.xautoclaim(
        this.streamKey,
        this.consumerGroup,
        this.consumerName,
        minIdleMs,
        '0-0', // Start from beginning of pending list
        'COUNT',
        this.batchSize
      );

      // result[0] = next ID, result[1] = messages array
      const messages = result[1] as Array<[string, string[]]>;

      if (messages.length > 0) {
        logger.info('Claimed stale pending messages from crashed workers', {
          count: messages.length,
          minIdleMs,
          consumerGroup: this.consumerGroup
        });
      }

      return messages.map(([id, fields]) => {
        // Parse fields as key-value pairs (Redis doesn't guarantee order)
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }
        return {
          id,
          data: JSON.parse(fieldMap.data)
        };
      });
    } catch (err: any) {
      // XAUTOCLAIM requires Redis ≥6.2, gracefully degrade if unavailable
      if (err.message && err.message.includes('unknown command')) {
        logger.warn('XAUTOCLAIM not supported (Redis <6.2), skipping stale message recovery');
        return [];
      }
      logger.error('Failed to claim stale messages', { error: err.message });
      return [];
    }
  }

  /**
   * Track message failure count
   */
  private async incrementFailureCount(messageId: string): Promise<number> {
    const attempts = await this.redis.hincrby('sensor:failed:attempts', messageId, 1);
    return attempts;
  }

  /**
   * Get message failure count
   */
  private async getFailureCount(messageId: string): Promise<number> {
    const attempts = await this.redis.hget('sensor:failed:attempts', messageId);
    return attempts ? parseInt(attempts, 10) : 0;
  }

  /**
   * Move message to Dead Letter Queue after max retries exceeded
   */
  private async moveToDLQ(entry: RedisSensorEntry, error: string, attempts: number): Promise<void> {
    try {
      // Add to DLQ stream with error context
      await this.redis.xadd(
        this.dlqStreamKey,
        '*',
        'data', JSON.stringify(entry.data),
        'original_id', entry.id,
        'error', error,
        'attempts', attempts.toString(),
        'failed_at', new Date().toISOString()
      );

      // Acknowledge original message (remove from PENDING)
      await this.redis.xack(this.streamKey, this.consumerGroup, entry.id);

      // Clean up failure counter
      await this.redis.hdel('sensor:failed:attempts', entry.id);

      logger.warn('Message moved to DLQ after max retries', {
        messageId: entry.id,
        attempts,
        error,
        deviceUuid: entry.data.deviceUuid,
        sensorName: entry.data.sensorName
      });
    } catch (err: any) {
      logger.error('Failed to move message to DLQ', {
        messageId: entry.id,
        error: err.message
      });
    }
  }

  /**
   * Worker loop: Claim stale → Read batch → Write to DB → Acknowledge
   */
  private async workerLoop(workerId: number = 0): Promise<void> {
    while (this.isRunning) {
      try {
        // Priority 1: Claim stale pending messages (prevents message loss from crashes)
        const staleEntries = await this.claimStaleMessages();
        if (staleEntries.length > 0) {
          await this.processBatch(staleEntries);
          continue; // Process claimed messages immediately
        }

        // Priority 2: Read batch from stream (blocks until batch size reached OR timeout)
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
        const entries: RedisSensorEntry[] = messages.map(([id, fields]: [string, string[]]) => {
          // Parse fields as key-value pairs (Redis doesn't guarantee order)
          const fieldMap: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
          }
          return {
            id,
            data: JSON.parse(fieldMap.data)
          };
        });

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
      
      // Implement DLQ pattern: track failures and move to DLQ after max retries
      // This prevents infinite retry loops for persistently failing messages
      for (const entry of entries) {
        try {
          const attempts = await this.incrementFailureCount(entry.id);
          
          if (attempts >= this.maxRetries) {
            // Max retries exceeded - move to DLQ
            await this.moveToDLQ(entry, err.message, attempts);
          } else {
            // Still under retry limit - message will be redelivered
            logger.debug('Message retry scheduled', {
              messageId: entry.id,
              attempts,
              maxRetries: this.maxRetries,
              deviceUuid: entry.data.deviceUuid
            });
          }
        } catch (dlqErr: any) {
          logger.error('Failed to handle message failure', {
            messageId: entry.id,
            error: dlqErr.message
          });
        }
      }
      // Messages not moved to DLQ will be redelivered to another consumer
    }
  }

  /**
   * Detect protocol from entry metadata or sensor name
   */
  private detectProtocol(entry: SensorDataEntry): string {
    // Check metadata first (most reliable)
    if (entry.metadata?.protocol) {
      return entry.metadata.protocol;
    }
    
    // Check for exact match or prefix pattern
    const name = entry.sensorName.toLowerCase();
    if (name === 'modbus' || name.startsWith('modbus_')) return 'modbus';
    if (name === 'opcua' || name.startsWith('opcua_')) return 'opcua';
    if (name === 'snmp' || name.startsWith('snmp_')) return 'snmp';
    if (name === 'can' || name.startsWith('can_')) return 'can';
    
    return 'mqtt'; // Default
  }

  /**
   * Normalize quality field to standard enum: good | bad | uncertain | stale | unknown
   * Handles string values, numeric codes (OPC UA), and boolean-like values
   */
  private normalizeQuality(quality: any): string {
    // Handle string values (most common)
    if (typeof quality === 'string') {
      const q = quality.toLowerCase().trim();
      
      // Direct matches
      if (['good', 'bad', 'uncertain', 'stale', 'unknown'].includes(q)) {
        return q;
      }
      
      // Common aliases
      if (q.includes('good') || q === 'ok' || q === 'valid') return 'good';
      if (q.includes('uncertain') || q === 'questionable') return 'uncertain';
      if (q.includes('stale') || q === 'old' || q === 'timeout') return 'stale';
      if (q.includes('bad') || q === 'error' || q === 'invalid' || q === 'fail') return 'bad';
      
      return 'unknown';
    }
    
    // Handle numeric codes (OPC UA status codes, Modbus flags)
    if (typeof quality === 'number') {
      // OPC UA status code ranges (0x00000000 - 0xFFFFFFFF)
      if (quality === 0 || quality === 1) return 'good'; // 0 = OPC UA Good, 1 = Modbus Good
      if ((quality & 0xC0000000) === 0x00000000) return 'good'; // Good range
      if ((quality & 0xC0000000) === 0x40000000) return 'uncertain'; // Uncertain range
      if ((quality & 0xC0000000) === 0x80000000) return 'bad'; // Bad range
      
      // Specific OPC UA substatus codes
      if (quality === 0x40940000 || quality === 0x409B0000) return 'stale'; // LastKnownValue, LastUsableValue
      
      return quality > 0 ? 'unknown' : 'bad';
    }
    
    // Handle boolean-like values
    if (quality === true) return 'good';
    if (quality === false) return 'bad';
    if (quality === null || quality === undefined) return 'unknown';
    
    return 'unknown';
  }

  /**
   * Normalize a single reading into ReadingInsert format
   * Handles value conversion, quality normalization, anomaly field extraction
   */
  private normalizeReading(
    reading: any,
    entry: SensorDataEntry,
    protocol: string,
    ingestedAt: Date,
    messageTimestamp?: string
  ): ReadingInsert | null {
    // Skip metadata nodes (server info, diagnostics)
    if (reading.nodeType === 'metadata') {
      logger.debug('Skipping metadata node (not stored in readings table)', {
        metric: reading.metric || reading.nodeName || reading.name,
        deviceUuid: entry.deviceUuid.substring(0, 8),
        value: reading.value
      });
      return null;
    }

    const extra: Record<string, any> = {};

    // Add server ingestion timestamp (trust boundary for clock drift detection)
    extra.ingested_at = ingestedAt.toISOString();

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
    const excludedFields = ['value', 'quality', 'unit', 'timestamp', 'metric', 'deviceName', 'nodeName',
      'anomaly_score', 'anomaly_threshold', 'baseline_samples', 'detection_methods'];
    
    Object.entries(reading).forEach(([key, val]) => {
      if (!excludedFields.includes(key)) {
        extra[key] = val;
      }
    });

    // Handle value: numbers go in value column, non-numeric go in extra
    const numericValue = typeof reading.value === 'number' ? reading.value : null;
    if (numericValue === null && reading.value !== undefined && reading.value !== null) {
      extra.non_numeric_value = reading.value;
      logger.debug('Non-numeric reading value stored in extra', {
        metric: reading.registerName || reading.nodeName || reading.name,
        valueType: typeof reading.value,
        value: String(reading.value).substring(0, 50)
      });
    }

    // Normalize quality field to standard enum
    const quality = this.normalizeQuality(reading.quality);

    return {
      device_uuid: entry.deviceUuid,
      metric_name: reading.metric || reading.nodeName || reading.name || entry.sensorName,
      value: numericValue,
      quality,
      unit: reading.unit || null,
      protocol,
      extra,
      time: new Date(reading.timestamp || messageTimestamp || entry.timestamp),
      ...(anomaly_score !== undefined && { anomaly_score }),
      ...(anomaly_threshold !== undefined && { anomaly_threshold }),
      ...(baseline_samples !== undefined && { baseline_samples }),
      ...(detection_methods !== undefined && { detection_methods })
    };
  }

  /**
   * Expand sensor data entry into array of readings
   * Handles different message formats: messages wrapper, readings array, single reading
   */
  private expandMessages(entry: SensorDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[] {
    const readings: ReadingInsert[] = [];

    // Format 1: Batch message with messages wrapper (OPC UA/Modbus compacted format)
    if (entry.data?.messages && Array.isArray(entry.data.messages)) {
      entry.data.messages.forEach((message: any) => {
        if (message.readings && Array.isArray(message.readings)) {
          message.readings.forEach((reading: any) => {
            const normalized = this.normalizeReading(reading, entry, protocol, ingestedAt, message.timestamp);
            if (normalized) readings.push(normalized);
          });
        }
      });
      return readings;
    }

    // Format 2: Batch message (Modbus/OPC UA can send multiple readings directly)
    if (entry.data && Array.isArray(entry.data.readings)) {
      entry.data.readings.forEach((reading: any) => {
        const normalized = this.normalizeReading(reading, entry, protocol, ingestedAt);
        if (normalized) readings.push(normalized);
      });
      return readings;
    }

    // Format 3: Single reading (legacy format)
    const value = typeof entry.data === 'object' 
      ? (entry.data.value ?? entry.data.rawValue ?? null)
      : entry.data;

    const quality = this.normalizeQuality(entry.data?.quality);

    const extra: Record<string, any> = {};
    
    // Add server ingestion timestamp (trust boundary for clock drift detection)
    extra.ingested_at = ingestedAt.toISOString();
    
    if (entry.data && typeof entry.data === 'object') {
      // Copy all fields except value, quality, unit (already in dedicated columns)
      Object.entries(entry.data).forEach(([key, val]) => {
        if (!['value', 'rawValue', 'quality', 'unit', 'timestamp', 'readings'].includes(key)) {
          extra[key] = val;
        }
      });
    }

    // Add metadata if present
    if (entry.metadata && Object.keys(entry.metadata).length > 0) {
      extra.metadata = entry.metadata;
    }

    readings.push({
      device_uuid: entry.deviceUuid,
      metric_name: entry.sensorName,
      value: typeof value === 'number' ? value : null,
      quality,
      unit: entry.data?.unit || null,
      protocol,
      extra,
      time: new Date(entry.timestamp)
    });

    return readings;
  }

  /**
   * Transform sensor data entries to readings format and insert in batches
   * Chunks data into groups of 500 to avoid PostgreSQL parameter limits
   */
  private async insertReadingsBatch(data: SensorDataEntry[]): Promise<void> {
    const chunkSize = 500;
    
    // Capture server ingestion time once for entire batch (trust boundary)
    const ingestedAt = new Date();
    
    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      
      // Transform sensor data to readings format (with batch expansion)
      const readings: ReadingInsert[] = [];
      
      chunk.forEach(entry => {
        const protocol = this.detectProtocol(entry);
        const expanded = this.expandMessages(entry, protocol, ingestedAt);
        readings.push(...expanded);
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

      // Get DLQ stats
      let dlqLength = 0;
      try {
        const dlqInfo = await this.redis.xinfo('STREAM', this.dlqStreamKey);
        dlqLength = dlqInfo[1] as number;
      } catch (err) {
        // DLQ stream doesn't exist yet
      }

      // Get failure tracking count
      const failureTrackingCount = await this.redis.hlen('sensor:failed:attempts');

      return {
        streamLength: length,
        firstEntryId: firstEntry ? firstEntry[0] : null,
        lastEntryId: lastEntry ? lastEntry[0] : null,
        pendingMessages: pending[0] as number,
        dlqLength,
        failureTrackingCount,
        consumerGroup: this.consumerGroup,
        consumerName: this.consumerName,
        isRunning: this.isRunning,
        maxRetries: this.maxRetries
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
