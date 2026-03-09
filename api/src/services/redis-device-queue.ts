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
 * 
 * Now uses centralized RedisClientFactory for consistent configuration.
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger';
import { ReadingsService, ReadingInsert } from './readings.service';
import { promisify } from 'util';
import { brotliDecompress, gunzip, inflate } from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { getRedisIngestion, getRedisConsumer } from '../redis/client-factory';
import {
  deviceSensorsIngestionStreamKey,
  deviceSensorsReadyStreamKey,
  deviceSensorsDlqStreamKey,
} from '../redis/tenant-keys';

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

/**
 * Circuit breaker states for Redis connection
 */
enum CircuitState {
  CLOSED = 'CLOSED',     // Normal operation
  OPEN = 'OPEN',         // Redis unhealthy, using fallback
  HALF_OPEN = 'HALF_OPEN' // Probing recovery
}

class RedisCircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold = 5;      // Open circuit after 5 consecutive failures
  private readonly successThreshold = 3;      // Close circuit after 3 consecutive successes
  private readonly timeoutMs = 30000;         // Try recovery after 30s
  
  recordSuccess(): void {
    this.failureCount = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        logger.info('Redis circuit breaker CLOSED - connection recovered', {
          previousState: this.state,
          successCount: this.successCount
        });
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
      }
    }
  }
  
  recordFailure(): void {
    this.successCount = 0;
    this.failureCount++;
    this.lastFailureTime = Date.now();
    
    if (this.state === CircuitState.CLOSED && this.failureCount >= this.failureThreshold) {
      logger.error('Redis circuit breaker OPEN - switching to disk spool fallback', {
        failureCount: this.failureCount,
        threshold: this.failureThreshold
      });
      this.state = CircuitState.OPEN;
    } else if (this.state === CircuitState.HALF_OPEN) {
      logger.warn('Redis circuit breaker OPEN again - recovery failed', {
        previousState: this.state
      });
      this.state = CircuitState.OPEN;
    }
  }
  
  shouldAllowRequest(): boolean {
    if (this.state === CircuitState.CLOSED) {
      return true;
    }
    
    if (this.state === CircuitState.OPEN) {
      // Check if timeout elapsed - try recovery
      if (Date.now() - this.lastFailureTime >= this.timeoutMs) {
        logger.info('Redis circuit breaker HALF_OPEN - probing recovery');
        this.state = CircuitState.HALF_OPEN;
        this.failureCount = 0;
        return true;
      }
      return false; // Stay open
    }
    
    // HALF_OPEN: allow requests to probe recovery
    return true;
  }
  
  getState(): CircuitState {
    return this.state;
  }
  
  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
  }
}

const circuitBreaker = new RedisCircuitBreaker();

interface SensorDataEntry {
  deviceUuid: string;
  sensorName: string;
  timestamp: string;
  data: any;
  metadata?: Record<string, any>;
}

interface CompressedSensorEntry {
  deviceUuid: string;
  sensorName: string;
  batchId: string;
  compressedPayload: Buffer; // Raw compressed MQTT payload
  contentEncoding: string; // 'br', 'gzip', 'deflate', or 'identity'
  contentType: string; // 'application/json'
}

interface RedisSensorEntry {
  id: string; // Redis stream message ID
  data: SensorDataEntry | CompressedSensorEntry;
  isCompressed?: boolean; // Flag to distinguish entry types
}

class RedisDeviceQueue {
  private redisIngestion: Redis; // Write-only: XADD
  private redisConsumer: Redis;  // Read-only: XREADGROUP, XACK, XAUTOCLAIM, XINFO
  private consumerGroup = 'sensor-writers';
  private consumerName: string;
  private get streamKey(): string { return deviceSensorsIngestionStreamKey(); }
  private get processingStreamKey(): string { return deviceSensorsReadyStreamKey(); }
  private get dlqStreamKey(): string { return deviceSensorsDlqStreamKey(); }
  private maxRetries: number;
  private isRunning = false;
  private workerCount: number;
  private batchSize: number;
  private blockTimeMs: number;
  private maxStreamLength: number;
  private maxDlqLength: number;
  private maxProcessingStreamLength: number;
  private readingsService: ReadingsService;
  
  // Pipeline batching for multiple rapid XADDs
  private pendingPipeline: ReturnType<typeof this.redisIngestion.pipeline> | null = null;
  private pipelineCount = 0;
  private readonly pipelineBatchSize = 10; // Flush after 10 XADDs
  private pipelineFlushTimer: NodeJS.Timeout | null = null;
  
  // Disk spool fallback (bounded, rotating files)
  private diskSpoolEnabled: boolean;
  private diskSpoolPath: string;
  private diskSpoolMaxSizeMb: number;
  private diskSpoolCurrentFile: string | null = null;
  private diskSpoolCurrentSize = 0;
  private diskSpoolFileIndex = 0;
  private diskSpoolReplayInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Get clients from factory (handles all cluster/auth/TLS configuration)
    this.redisIngestion = getRedisIngestion(); // Fail-fast for writes
    this.redisConsumer = getRedisConsumer(); // Resilient for reads

    this.consumerName = `worker-${process.pid}-${Date.now()}`;
    this.workerCount = parseInt(process.env.SENSOR_WORKER_COUNT || '2', 10);
    this.maxRetries = parseInt(process.env.SENSOR_MAX_RETRIES || '3', 10);
    this.batchSize = parseInt(process.env.SENSOR_BATCH_SIZE || '100', 10);
    this.blockTimeMs = parseInt(process.env.SENSOR_FLUSH_INTERVAL_MS || '2000', 10);
    // Ingestion stream: Short-lived (10k messages = ~5-10 min at high volume)
    // Aggressively trimmed to prevent memory buildup
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
    // Processing stream: Larger buffer for DB outages (100k messages)
    this.maxProcessingStreamLength = parseInt(process.env.REDIS_PROCESSING_STREAM_MAXLEN || '100000', 10);
    // DLQ: Bounded to prevent infinite growth (1k failed messages)
    this.maxDlqLength = parseInt(process.env.REDIS_DLQ_MAXLEN || '1000', 10);
    this.readingsService = new ReadingsService();
    
    // Disk spool configuration (bounded fallback when Redis down)
    this.diskSpoolEnabled = process.env.DISK_SPOOL_ENABLED === 'true';
    this.diskSpoolPath = process.env.DISK_SPOOL_PATH || '/tmp/iotistic-spool';
    this.diskSpoolMaxSizeMb = parseInt(process.env.DISK_SPOOL_MAX_SIZE_MB || '1000', 10); // 1GB default
    
    if (this.diskSpoolEnabled) {
      this.initializeDiskSpool();
    }

    this.redisIngestion.on('error', (err) => {
      logger.error('Redis sensor ingestion connection error', { error: err.message });
      metrics.redisConnected = 0;
    });

    this.redisIngestion.on('connect', () => {
      logger.info('Redis device ingestion connected');
      metrics.redisConnected = 1;
      metrics.redisReconnects++;
    });

    this.redisConsumer.on('error', (err) => {
      logger.error('Redis device consumer connection error', { error: err.message });
    });

    this.redisConsumer.on('connect', () => {
      logger.info('Redis device consumer connected');
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
        // Create consumer groups for both streams
        await this.redisConsumer.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
        await this.redisConsumer.xgroup('CREATE', this.processingStreamKey, this.consumerGroup, '0', 'MKSTREAM');
        logger.info('Created Redis consumer groups for sensors', {
          ingestionStream: this.streamKey,
          processingStream: this.processingStreamKey,
          group: this.consumerGroup
        });
        return; // Success
      } catch (err: any) {
        if (err.message.includes('BUSYGROUP')) {
          logger.info('Redis consumer groups already exist', { group: this.consumerGroup });
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
   * Add compressed sensor payload to Redis Stream (FAST - no parsing!)
   * This is the new primary method for sensor data ingestion.
   * Worker handles decompression + parsing to avoid event loop blocking.
   */
  async addCompressed(entry: CompressedSensorEntry): Promise<void> {
    try {
      // Check Redis connection before attempting write
      if (this.redisIngestion.status !== 'ready' && this.redisIngestion.status !== 'connect') {
        logger.error('Redis ingestion not ready, dropping compressed device batch', {
          status: this.redisIngestion.status,
          deviceUuid: entry.deviceUuid.substring(0, 8),
          sensorName: entry.sensorName,
          batchId: entry.batchId,
          compressedBytes: entry.compressedPayload.length
        });
        metrics.messagesDropped++;
        return; // Graceful degradation: drop data instead of crashing
      }

      // TIER-2 OPTIMIZATION: Store payload metadata only, not raw data
      // Payload is already written to disk spool by agent/API before MQTT publish
      // Redis becomes control plane (metadata) not data plane (payloads)
      const payloadPointer = `${entry.deviceUuid}/${entry.batchId}`;
      const payloadSize = entry.compressedPayload.length;

      // Add to pipeline for batching (reduces network round trips)
      this.addToPipeline(() => {
        const pipeline = this.pendingPipeline || this.redisIngestion.pipeline();
        pipeline.xadd(
          this.streamKey,
          'MAXLEN',
          '~', // Approximate trimming (more efficient than exact)
          this.maxStreamLength,
          '*', // Auto-generate ID
          'compressed', '1', // Flag to indicate compressed entry
          'deviceUuid', entry.deviceUuid,
          'sensorName', entry.sensorName,
          'batchId', entry.batchId,
          'encoding', entry.contentEncoding,
          'contentType', entry.contentType,
          'payloadPointer', payloadPointer,  // Pointer instead of raw data
          'payloadSize', payloadSize.toString()
        );
        return pipeline;
      }).catch(err => {
        logger.error('Failed to queue compressed sensor metadata to Redis (async)', {
          deviceUuid: entry.deviceUuid.substring(0, 8),
          sensorName: entry.sensorName,
          batchId: entry.batchId,
          error: err.message,
          redisStatus: this.redisIngestion.status
        });
      });

      logger.info('Queued compressed sensor metadata (pointer-based)', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        sensorName: entry.sensorName,
        batchId: entry.batchId,
        payloadBytes: payloadSize,
        encoding: entry.contentEncoding,
        pipelineDepth: this.pipelineCount,
        pointer: payloadPointer
      });
    } catch (err: any) {
      logger.error('Failed to queue compressed sensor metadata to Redis', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        sensorName: entry.sensorName,
        batchId: entry.batchId,
        error: err.message,
        redisStatus: this.redisIngestion.status
      });
      // Don't throw - graceful degradation
    }
  }

  /**
   * REMOVED: Legacy add() method that caused slow Redis writes (11 XADDs = 3500ms)
   * All sensor ingestion now uses addCompressed() for single XADD per batch (<50ms)
   * 
   * If you see compilation errors, update callers to queue raw MQTT payload:
   * 
   * OLD: await redisSensorQueue.add(parsedReadings);
   * NEW: await redisSensorQueue.addCompressed({
   *   deviceUuid, sensorName, batchId,
   *   compressedPayload: mqttPayloadBuffer,
   *   contentEncoding: 'identity', contentType: 'application/json'
   * });
   */
  async add(sensorData: SensorDataEntry[]): Promise<void> {
    // OPTIMIZED: Batch all sensor data into a single JSON payload + single XADD
    // Previously used per-item pipeline (N readings = N XADDs = 1-3 seconds)
    // Now: 1 JSON array + 1 XADD = <50ms
    
    if (sensorData.length === 0) return;

    try {
      const startTime = Date.now();

      // Circuit breaker: Check if Redis is healthy
      if (!circuitBreaker.shouldAllowRequest()) {
        // Circuit OPEN - use disk spool fallback
        if (this.diskSpoolEnabled) {
          await this.spoolToDisk(sensorData);
          logger.warn('Redis circuit OPEN - spooled to disk', {
            count: sensorData.length,
            circuitState: circuitBreaker.getState()
          });
        } else {
          metrics.messagesDropped += sensorData.length;
          logger.error('Redis circuit OPEN and disk spool disabled - data dropped', {
            count: sensorData.length,
            totalDropped: metrics.messagesDropped,
            hint: 'Set DISK_SPOOL_ENABLED=true to enable fallback'
          });
        }
        return;
      }
      
      // Check Redis connection status
      if (this.redisIngestion.status !== 'ready' && this.redisIngestion.status !== 'connect') {
        circuitBreaker.recordFailure();
        if (this.diskSpoolEnabled) {
          await this.spoolToDisk(sensorData);
          logger.warn('Redis not ready - spooled to disk', {
            status: this.redisIngestion.status,
            count: sensorData.length
          });
        } else {
          metrics.messagesDropped += sensorData.length;
          logger.error('Redis not ready and disk spool disabled - data dropped', {
            status: this.redisIngestion.status,
            count: sensorData.length,
            totalDropped: metrics.messagesDropped
          });
        }
        return;
      }

      // Store all readings as a single JSON array entry (much faster than per-item pipeline)
      const payload = JSON.stringify(sensorData);

      // Add to pipeline for batching (reduces network round trips)
      this.addToPipeline(() => {
        const pipeline = this.pendingPipeline || this.redisIngestion.pipeline();
        pipeline.xadd(
          this.streamKey,
          'MAXLEN',
          '~',
          this.maxStreamLength,
          '*',
          'data', payload
        );
        return pipeline;
      }).catch(err => {
        logger.error('Failed to add sensor data to Redis stream (async)', {
          count: sensorData.length,
          error: err.message,
          redisStatus: this.redisIngestion.status
        });
      });

      const duration = Date.now() - startTime;
      metrics.recordBatchLatency(duration);
      
      // Record success for circuit breaker
      circuitBreaker.recordSuccess();
      
      const logPayload = {
        count: sensorData.length,
        payloadBytes: payload.length,
        durationMs: duration,
        batchLatencyP95Ms: metrics.getBatchLatencyP95(),
        dataPerSecond: duration > 0 ? Math.round((sensorData.length / duration) * 1000) : sensorData.length,
        pipelineDepth: this.pipelineCount
      };

      if (duration > 100) {
        logger.warn('Slow Redis write (sensor batch)', logPayload);
      } else {
        logger.info('Added device data to Redis stream', logPayload);
      }
    } catch (err: any) {
      circuitBreaker.recordFailure();
      logger.error('Failed to add device data to Redis stream', {
        count: sensorData.length,
        error: err.message,
        redisStatus: this.redisIngestion.status
      });
      // Don't throw - graceful degradation: drop data instead of crashing API
    }
  }

  /**Initialize disk spool directory (bounded, rotating files)
   */
  private initializeDiskSpool(): void {
    try {
      if (!fs.existsSync(this.diskSpoolPath)) {
        fs.mkdirSync(this.diskSpoolPath, { recursive: true });
        logger.info('Created disk spool directory', { path: this.diskSpoolPath });
      }
      
      // Start background replayer (drains spool to Redis when healthy)
      this.startSpoolReplayer();
      
      logger.info('Disk spool fallback initialized', {
        enabled: this.diskSpoolEnabled,
        path: this.diskSpoolPath,
        maxSizeMb: this.diskSpoolMaxSizeMb
      });
    } catch (err: any) {
      logger.error('Failed to initialize disk spool', { error: err.message });
      this.diskSpoolEnabled = false;
    }
  }
  
  /**
   * Spool sensor data to disk (bounded, rotating files)
   * Called when Redis circuit is OPEN
   */
  private async spoolToDisk(sensorData: SensorDataEntry[]): Promise<void> {
    try {
      const payload = JSON.stringify(sensorData);
      const payloadSize = Buffer.byteLength(payload, 'utf8');
      
      // Check total spool size (bounded - prevent disk full)
      const totalSpoolSize = this.getSpoolTotalSize();
      if (totalSpoolSize + payloadSize > this.diskSpoolMaxSizeMb * 1024 * 1024) {
        // Delete oldest spool file to make room
        this.deleteOldestSpoolFile();
      }
      
      // Rotate file if current file too large (10MB chunks)
      if (!this.diskSpoolCurrentFile || this.diskSpoolCurrentSize > 10 * 1024 * 1024) {
        this.diskSpoolFileIndex++;
        this.diskSpoolCurrentFile = path.join(this.diskSpoolPath, `spool-${this.diskSpoolFileIndex}.ndjson`);
        this.diskSpoolCurrentSize = 0;
      }
      
      // Append to current spool file (NDJSON format)
      fs.appendFileSync(this.diskSpoolCurrentFile, payload + '\n');
      this.diskSpoolCurrentSize += payloadSize;
      
      logger.debug('Spooled device data to disk', {
        count: sensorData.length,
        file: path.basename(this.diskSpoolCurrentFile),
        sizeBytes: payloadSize,
        totalSpoolMb: Math.round(totalSpoolSize / 1024 / 1024)
      });
    } catch (err: any) {
      logger.error('Failed to spool to disk - data lost', {
        count: sensorData.length,
        error: err.message
      });
      metrics.messagesDropped += sensorData.length;
    }
  }
  
  /**
   * Get total size of spool directory
   */
  private getSpoolTotalSize(): number {
    try {
      const files = fs.readdirSync(this.diskSpoolPath);
      return files.reduce((total, file) => {
        const stats = fs.statSync(path.join(this.diskSpoolPath, file));
        return total + stats.size;
      }, 0);
    } catch {
      return 0;
    }
  }
  
  /**
   * Delete oldest spool file (LRU eviction)
   */
  private deleteOldestSpoolFile(): void {
    try {
      const files = fs.readdirSync(this.diskSpoolPath)
        .filter(f => f.startsWith('spool-'))
        .sort(); // Lexicographic sort works because of numeric index
      
      if (files.length > 0) {
        const oldestFile = path.join(this.diskSpoolPath, files[0]);
        fs.unlinkSync(oldestFile);
        logger.info('Deleted oldest spool file (disk full)', { file: files[0] });
      }
    } catch (err: any) {
      logger.error('Failed to delete oldest spool file', { error: err.message });
    }
  }
  
  /**
   * Background replayer: Drain spool to Redis when circuit closed
   */
  private startSpoolReplayer(): void {
    this.diskSpoolReplayInterval = setInterval(async () => {
      // Only replay when circuit is CLOSED (Redis healthy)
      if (circuitBreaker.getState() !== CircuitState.CLOSED) {
        return;
      }
      
      try {
        const files = fs.readdirSync(this.diskSpoolPath)
          .filter(f => f.startsWith('spool-'))
          .sort();
        
        if (files.length === 0) return;
        
        // Process oldest file first (FIFO)
        const oldestFile = path.join(this.diskSpoolPath, files[0]);
        const content = fs.readFileSync(oldestFile, 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        
        logger.info('Replaying spooled data to Redis', {
          file: files[0],
          batches: lines.length,
          totalSpooledFiles: files.length
        });
        
        // Replay each batch
        for (const line of lines) {
          try {
            const sensorData = JSON.parse(line) as SensorDataEntry[];
            await this.add(sensorData); // Recursive, but with circuit breaker protection
          } catch (err: any) {
            logger.error('Failed to replay spooled batch', { error: err.message });
          }
        }
        
        // Delete file after successful replay
        fs.unlinkSync(oldestFile);
        logger.info('Replayed and deleted spool file', { file: files[0] });
        
      } catch (err: any) {
        logger.error('Spool replay error', { error: err.message });
      }
    }, 10000); // Replay every 10 seconds when Redis healthy
  }

  /**
   * 
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
    
    // TIER-2: Periodic failure tracking hash pruning (prevent unbounded growth)
    this.startFailureTrackingPruner();

    // Start multiple worker loops for parallel processing
    // Each worker competes for messages via consumer group (load balancing)
    for (let i = 0; i < this.workerCount; i++) {
      this.workerLoop(i).catch(err => {
        logger.error('Device worker loop crashed', { 
          workerId: i,
          error: err.message, 
          stack: err.stack 
        });
        // Other workers continue running
      });
    }
  }

  /**
   * TIER-2: Periodically prune old failure tracking entries
   * Prevents unbounded hash growth during Redis crashes
   */
  private startFailureTrackingPruner(): void {
    setInterval(async () => {
      try {
        // Get all message IDs in failure tracking
        const allEntries = await this.redisConsumer.hgetall('sensor:failed:attempts');
        
        if (!allEntries || Object.keys(allEntries).length === 0) return;
        
        const now = Date.now();
        const maxAgeMs = 24 * 60 * 60 * 1000; // 24 hours
        let prunedCount = 0;
        
        // Check each entry against pending list
        for (const messageId of Object.keys(allEntries)) {
          try {
            // Extract timestamp from Redis Stream message ID (format: timestamp-sequence)
            const timestamp = parseInt(messageId.split('-')[0], 10);
            const ageMs = now - timestamp;
            
            // Prune if older than max age (likely already processed or lost)
            if (ageMs > maxAgeMs) {
              await this.redisConsumer.hdel('sensor:failed:attempts', messageId);
              prunedCount++;
            }
          } catch (err) {
            // Invalid message ID format - remove it
            await this.redisConsumer.hdel('sensor:failed:attempts', messageId);
            prunedCount++;
          }
        }
        
        if (prunedCount > 0) {
          logger.info('Pruned old failure tracking entries', {
            pruned: prunedCount,
            remaining: Object.keys(allEntries).length - prunedCount
          });
        }
      } catch (err: any) {
        logger.error('Failed to prune failure tracking hash', { error: err.message });
      }
    }, 60 * 60 * 1000); // Run every hour
  }

  /**
   * Claim stale pending messages from crashed workers
   * Uses XAUTOCLAIM (Redis ≥6.2) to recover messages stuck in PENDING state
   */
  private async claimStaleMessages(): Promise<RedisSensorEntry[]> {
    try {
      const minIdleMs = 60000; // 60s - messages idle longer than this are considered stale
      const result = await this.redisConsumer.xautoclaim(
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

      const parsed: RedisSensorEntry[] = [];
      for (const [id, fields] of messages) {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
          fieldMap[fields[i]] = fields[i + 1];
        }

        const isCompressed = fieldMap.compressed === '1';

        if (isCompressed) {
          const payloadRaw = fieldMap.payload;
          if (!payloadRaw) {
            logger.warn('Skipping stale compressed message with no payload', { messageId: id });
            await this.redisConsumer.xack(this.streamKey, this.consumerGroup, id);
            continue;
          }

          const payloadBuffer = Buffer.isBuffer(payloadRaw)
            ? payloadRaw // Binary (new, zero overhead)
            : fieldMap.payload_b64
              ? Buffer.from(fieldMap.payload_b64, 'base64') // Legacy base64
              : Buffer.from(payloadRaw, 'hex'); // Legacy hex
          
          if (payloadBuffer.length === 0) {
            logger.warn('Skipping stale compressed message with empty payload', {
              messageId: id,
              deviceUuid: fieldMap.deviceUuid?.substring(0, 8),
              sensorName: fieldMap.sensorName
            });
            await this.redisConsumer.xack(this.streamKey, this.consumerGroup, id);
            continue;
          }

          parsed.push({
            id,
            data: {
              deviceUuid: fieldMap.deviceUuid,
              sensorName: fieldMap.sensorName,
              batchId: fieldMap.batchId,
              compressedPayload: payloadBuffer,
              contentEncoding: fieldMap.encoding,
              contentType: fieldMap.contentType
            } as CompressedSensorEntry,
            isCompressed: true
          });
          continue;
        }

        if (!fieldMap.data) {
          logger.warn('Skipping stale message with missing data field', { messageId: id });
          await this.redisConsumer.xack(this.streamKey, this.consumerGroup, id);
          continue;
        }

        try {
          parsed.push({
            id,
            data: JSON.parse(fieldMap.data)
          });
        } catch (parseErr: any) {
          logger.warn('Skipping stale message with invalid JSON', {
            messageId: id,
            error: parseErr.message
          });
          await this.redisConsumer.xack(this.streamKey, this.consumerGroup, id);
        }
      }

      return parsed;
    } catch (err: any) {
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
    const attempts = await this.redisConsumer.hincrby('sensor:failed:attempts', messageId, 1);
    return attempts;
  }

  /**
   * Get message failure count
   */
  private async getFailureCount(messageId: string): Promise<number> {
    const attempts = await this.redisConsumer.hget('sensor:failed:attempts', messageId);
    return attempts ? parseInt(attempts, 10) : 0;
  }

  /**
   * Move message to Dead Letter Queue after max retries exceeded
   */
  private async moveToDLQ(entry: RedisSensorEntry, error: string, attempts: number): Promise<void> {
    try {
      // Add to DLQ stream with error context + MAXLEN to prevent unbounded growth
      await this.redisConsumer.xadd(
        this.dlqStreamKey,
        'MAXLEN',
        '~',  // Approximate trimming
        this.maxDlqLength,  // TIER-2: Bounded DLQ (prevent infinite growth)
        '*',
        'data', JSON.stringify(entry.data),
        'original_id', entry.id,
        'error', error,
        'attempts', attempts.toString(),
        'failed_at', new Date().toISOString()
      );

      // Acknowledge original message (remove from PENDING)
      await this.redisConsumer.xack(this.streamKey, this.consumerGroup, entry.id);

      // Clean up failure counter
      await this.redisConsumer.hdel('sensor:failed:attempts', entry.id);

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
   * Decompress and parse sensor payload (runs in worker, not request thread)
   * Supports Brotli, gzip, deflate, and raw JSON payloads
   */
  private async decompressAndParseSensors(
    compressedPayload: Buffer,
    contentEncoding: string,
    deviceUuid: string,
    sensorName: string
  ): Promise<SensorDataEntry[]> {
    const startTime = Date.now();
    
    try {
      // Decompress payload based on encoding
      let decompressed: Buffer;
      
      switch (contentEncoding) {
        case 'br':
          decompressed = await promisify(brotliDecompress)(compressedPayload);
          break;
        case 'gzip':
          decompressed = await promisify(gunzip)(compressedPayload);
          break;
        case 'deflate':
          decompressed = await promisify(inflate)(compressedPayload);
          break;
        case 'identity':
        default:
          // No compression
          decompressed = compressedPayload;
          break;
      }
      
      const rawJson = decompressed.toString('utf8');
      
      // Parse JSON (array of sensor readings)
      let readings: any[];
      try {
        const parsed = JSON.parse(rawJson);
        readings = Array.isArray(parsed) ? parsed : [parsed];
      } catch (parseErr: any) {
        logger.error('Failed to parse decompressed sensor payload', {
          deviceUuid: deviceUuid.substring(0, 8),
          sensorName,
          encoding: contentEncoding,
          decompressedBytes: decompressed.length,
          error: parseErr.message,
          rawJsonPreview: rawJson.substring(0, 200)
        });
        throw parseErr;
      }
      
      // Convert to SensorDataEntry format
      const entries: SensorDataEntry[] = readings.map((reading: any) => ({
        deviceUuid: reading.deviceUuid || deviceUuid,
        sensorName: reading.sensorName || sensorName,
        timestamp: reading.timestamp || new Date().toISOString(),
        data: reading.data || reading,
        metadata: reading.metadata
      }));
      
      const duration = Date.now() - startTime;
      
      logger.debug('Decompressed sensor payload', {
        deviceUuid: deviceUuid.substring(0, 8),
        sensorName,
        encoding: contentEncoding,
        compressedBytes: compressedPayload.length,
        decompressedBytes: decompressed.length,
        readingCount: entries.length,
        durationMs: duration
      });
      
      return entries;
      
    } catch (err: any) {
      logger.error('Failed to decompress sensor payload', {
        deviceUuid: deviceUuid.substring(0, 8),
        sensorName,
        encoding: contentEncoding,
        compressedBytes: compressedPayload.length,
        error: err.message
      });
      throw err;
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
        const results = await this.redisConsumer.xreadgroup(
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
          
          // Check if this is a compressed entry (new format) or legacy (old format)
          const isCompressed = fieldMap.compressed === '1';
          
          if (isCompressed) {
            // Compressed payload stored as raw binary string in Redis
            const payloadRaw = fieldMap.payload;
            if (!payloadRaw) {
              logger.warn('Skipping sensor message with missing payload', { messageId: id });
              return null;
            }
            
            // Payload comes back as binary string - convert to Buffer
            const compressedPayload = Buffer.from(payloadRaw, 'binary');
            
            return {
              id,
              data: {
                deviceUuid: fieldMap.deviceUuid,
                sensorName: fieldMap.sensorName,
                batchId: fieldMap.batchId,
                compressedPayload,
                contentEncoding: fieldMap.encoding,
                contentType: fieldMap.contentType
              } as CompressedSensorEntry,
              isCompressed: true
            };
          } else {
            // Legacy entry - already parsed JSON
            return {
              id,
              data: JSON.parse(fieldMap.data) as SensorDataEntry,
              isCompressed: false
            };
          }
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
      // Separate compressed from legacy entries and decompress
      let allData: SensorDataEntry[] = [];
      
      for (const entry of entries) {
        if (entry.isCompressed) {
          // Decompress and parse in worker (offloads CPU from main thread)
          const compressed = entry.data as CompressedSensorEntry;
          
          // Skip entries with empty payloads (malformed/corrupted messages)
          if (!compressed.compressedPayload || compressed.compressedPayload.length === 0) {
            logger.warn('Skipping compressed entry with empty payload', {
              messageId: entry.id,
              deviceUuid: compressed.deviceUuid?.substring(0, 8),
              sensorName: compressed.sensorName
            });
            await this.redisConsumer.xack(this.streamKey, this.consumerGroup, entry.id);
            continue;
          }
          
          try {
            const decompressedReadings = await this.decompressAndParseSensors(
              compressed.compressedPayload,
              compressed.contentEncoding,
              compressed.deviceUuid,
              compressed.sensorName
            );
            allData.push(...decompressedReadings);
          } catch (err: any) {
            logger.error('Failed to decompress sensor entry, skipping', {
              messageId: entry.id,
              deviceUuid: compressed.deviceUuid?.substring(0, 8),
              sensorName: compressed.sensorName,
              encoding: compressed.contentEncoding,
              compressedBytes: compressed.compressedPayload.length,
              error: err.message
            });
            // Acknowledge to prevent infinite retries
            await this.redisConsumer.xack(this.streamKey, this.consumerGroup, entry.id);
            continue;
          }
        } else {
          // Legacy format - can be either single item or array (from batched add() method)
          const legacyData = entry.data as SensorDataEntry | SensorDataEntry[];
          if (Array.isArray(legacyData)) {
            allData.push(...legacyData);
          } else {
            allData.push(legacyData);
          }
        }
      }

      if (allData.length === 0) return;

      // Insert all sensor data in one batch operation
      await this.insertReadingsBatch(allData);

      // Acknowledge messages (atomic)
      const messageIds = entries.map(e => e.id);
      await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...messageIds);

      const duration = Date.now() - startTime;
      
      // Count unique devices and sensors for logging
      const uniqueDevices = new Set(allData.map(d => d.deviceUuid)).size;
      const uniqueSensors = new Set(allData.map(d => `${d.deviceUuid}/${d.sensorName}`)).size;
      const compressedCount = entries.filter(e => e.isCompressed).length;
      
      logger.info('Processed device data batch from Redis', {
        totalReadings: entries.length,
        compressedEntries: compressedCount,
        legacyEntries: entries.length - compressedCount,
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
    
    await Promise.all([
      this.redisIngestion.quit(),
      this.redisConsumer.quit()
    ]);
    logger.info('Redis sensor worker stopped');
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    try {
      const info = await this.redisConsumer.xinfo('STREAM', this.streamKey);
      const pending = await this.redisConsumer.xpending(this.streamKey, this.consumerGroup);

      // Parse Redis response (array format)
      const length = info[1] as number;
      const firstEntry = info[11] as string[];
      const lastEntry = info[13] as string[];

      // Get DLQ stats
      let dlqLength = 0;
      try {
        const dlqInfo = await this.redisConsumer.xinfo('STREAM', this.dlqStreamKey);
        dlqLength = dlqInfo[1] as number;
      } catch (err) {
        // DLQ stream doesn't exist yet
      }

      // Get failure tracking count
      const failureTrackingCount = await this.redisConsumer.hlen('sensor:failed:attempts');

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

  /**
   * Add XADD to pipeline, auto-flush when batch size reached
   */
  private async addToPipeline(addFn: () => ReturnType<typeof this.redisIngestion.pipeline>): Promise<void> {
    this.pendingPipeline = addFn();
    this.pipelineCount++;

    // Clear any pending flush timer
    if (this.pipelineFlushTimer) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }

    // Flush immediately if batch size reached
    if (this.pipelineCount >= this.pipelineBatchSize) {
      return this.flushPipeline();
    }

    // Schedule flush after 50ms if no more XADDs arrive
    this.pipelineFlushTimer = setTimeout(() => {
      this.flushPipeline().catch(err =>
        logger.error('Pipeline auto-flush failed', { error: err.message })
      );
    }, 50);
  }

  /**
   * Execute pending pipeline and reset state
   */
  private async flushPipeline(): Promise<void> {
    if (!this.pendingPipeline || this.pipelineCount === 0) return;

    const count = this.pipelineCount;
    const pipeline = this.pendingPipeline;
    
    // Reset state before exec (avoid re-entrance)
    this.pendingPipeline = null;
    this.pipelineCount = 0;
    if (this.pipelineFlushTimer) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }

    try {
      const startTime = Date.now();
      await pipeline.exec();
      const duration = Date.now() - startTime;
      const avgLatency = count > 0 ? Math.round(duration / count) : 0;
      
      logger.info('Flushed sensor pipeline', {
        operations: count,
        totalLatencyMs: duration,
        avgLatencyPerOpMs: avgLatency,
        opsPerSecond: duration > 0 ? Math.round((count / duration) * 1000) : count
      });
    } catch (err) {
      metrics.messagesDropped += count;
      logger.error('Sensor pipeline exec failed', {
        error: err instanceof Error ? err.message : String(err),
        count,
        totalDropped: metrics.messagesDropped
      });
    }
  }
}

// Singleton instance
export const redisSensorQueue = new RedisDeviceQueue();
