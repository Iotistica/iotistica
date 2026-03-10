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
 * 
 * Now uses centralized RedisClientFactory for consistent configuration.
 */

import Redis from 'ioredis';
import { DeviceLogsModel } from '../db/models';
import { logger } from '../utils/logger';
import { query } from '../db/connection';
import { getRedisIngestion, getRedisConsumer } from '../redis/client-factory';
import {
  deviceLogsStreamKey,
  getCustomerId,
  consumerGroupName,
  consumerName as makeConsumerName,
} from '../redis/tenant-keys';

interface LogEntry {
  deviceUuid: string;
  serviceName?: string;
  timestamp?: Date;
  message: string;
  level?: string;
  isSystem?: boolean;
  isStderr?: boolean;
}

interface CompressedLogEntry {
  deviceUuid: string;
  batchId: string;
  compressedPayload: Buffer; // Raw compressed data
  contentEncoding: string; // 'br', 'gzip', 'deflate', or 'identity'
  contentType: string; // 'application/x-ndjson' or 'application/json'
}

interface RedisLogEntry {
  id: string; // Redis stream message ID
  data: LogEntry | CompressedLogEntry;
  isCompressed?: boolean; // Flag to distinguish entry types
}

class RedisLogQueue {
  private redisIngestion: Redis; // Write-only: XADD
  private redisConsumer: Redis;  // Read-only: XREADGROUP, XACK, XINFO
  private tenantId: string;
  private consumerGroup: string;
  private consumerName: string;
  private get streamKey(): string { return deviceLogsStreamKey(this.resolveTenantId()); }
  private isRunning = false;
  private batchSize: number;
  private blockTimeMs: number;
  private maxStreamLength: number;
  
  // Pipeline batching for multiple rapid XADDs
  private pendingPipeline: ReturnType<typeof this.redisIngestion.pipeline> | null = null;
  private pipelineCount = 0;
  private readonly pipelineBatchSize = 10; // Flush after 10 XADDs
  private pipelineFlushTimer: NodeJS.Timeout | null = null;

  private resolveTenantId(): string {
    return this.tenantId || getCustomerId();
  }

  constructor(tenantId?: string) {
    // Get clients from factory (handles all cluster/auth/TLS configuration)
    this.redisIngestion = getRedisIngestion(); // Fail-fast for writes
    this.redisConsumer = getRedisConsumer(); // Resilient for reads

    this.tenantId = tenantId || '';
    const baseWorkerName = `worker-${process.pid}-${Date.now()}`;
    if (this.tenantId) {
      this.consumerGroup = consumerGroupName(this.tenantId, 'log-writers');
      this.consumerName = makeConsumerName(this.tenantId, baseWorkerName);
    } else {
      // Defer tenant resolution until first runtime access after license initialization.
      this.consumerGroup = 'log-writers';
      this.consumerName = baseWorkerName;
    }
    this.batchSize = parseInt(process.env.LOG_BATCH_SIZE || '50', 10);
    this.blockTimeMs = parseInt(process.env.LOG_FLUSH_INTERVAL_MS || '5000', 10);
    // Stream retention: ~500K messages = ~2-4h of logs at high volume
    // Prevents unbounded growth while providing buffer for worker outages
    this.maxStreamLength = parseInt(process.env.LOG_STREAM_MAXLEN || '500000', 10);

    this.redisIngestion.on('error', (err) => {
      logger.error('Redis log ingestion connection error', { error: err.message });
    });

    this.redisIngestion.on('connect', () => {
      logger.info('Redis log ingestion connected');
    });

    this.redisConsumer.on('error', (err) => {
      logger.error('Redis log consumer connection error', { error: err.message });
    });

    this.redisConsumer.on('connect', () => {
      logger.info('Redis log consumer connected');
    });
  }

  /**
   * Initialize consumer group (idempotent)
   * Retries on failure to handle Redis not being ready
   */
  async initialize(): Promise<void> {
    if (!this.tenantId) {
      const resolvedTenantId = this.resolveTenantId();
      this.tenantId = resolvedTenantId;
      this.consumerGroup = consumerGroupName(resolvedTenantId, 'log-writers');
      this.consumerName = makeConsumerName(resolvedTenantId, `worker-${process.pid}-${Date.now()}`);
    }

    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Create consumer group (fails if already exists, that's ok)
        await this.redisConsumer.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
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
   * Add compressed log payload to Redis Stream (FAST - no parsing!)
   * This is the new primary method for log ingestion.
   * Worker handles decompression + parsing to avoid event loop blocking.
   */
  async addCompressed(entry: CompressedLogEntry): Promise<void> {
    try {
      if (this.redisIngestion.status !== 'ready' && this.redisIngestion.status !== 'connect') {
        logger.error('Redis ingestion not ready, dropping compressed log batch', {
          status: this.redisIngestion.status,
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          compressedBytes: entry.compressedPayload.length
        });
        return;
      }

      // Add to pipeline for batching (reduces network round trips)
      this.addToPipeline(() => {
        const pipeline = this.pendingPipeline || this.redisIngestion.pipeline();
        pipeline.xadd(
          this.streamKey,
          'MAXLEN',
          '~', // Approximate trimming (more efficient than exact)
          this.maxStreamLength,
          '*',
          'compressed', '1',
          'deviceUuid', entry.deviceUuid,
          'batchId', entry.batchId,
          'encoding', entry.contentEncoding,
          'contentType', entry.contentType,
          'payload', entry.compressedPayload // Raw buffer (no encoding!)
        );
        return pipeline;
      }).catch(err => {
        logger.error('Failed to queue compressed logs to Redis (async)', {
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          error: err.message,
          redisStatus: this.redisIngestion.status
        });
      });

      logger.info('Queued compressed log payload (pipelined, binary)', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        batchId: entry.batchId,
        payloadBytes: entry.compressedPayload.length,
        encoding: entry.contentEncoding,
        pipelineDepth: this.pipelineCount
      });
    } catch (err: any) {
      logger.error('Failed to queue compressed logs to Redis', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        batchId: entry.batchId,
        error: err.message,
        redisStatus: this.redisIngestion.status
      });
    }
  }

  /**
   * REMOVED: Legacy add() method that caused slow Redis writes (12 XADDs = 4000ms)
   * All log ingestion now uses addCompressed() for single XADD per batch (<50ms)
   * 
   * If you see compilation errors, update callers to use addCompressed() instead:
   * 
   * OLD: await redisLogQueue.add(parsedLogs);
   * NEW: await redisLogQueue.addCompressed({
   *   deviceUuid, batchId, compressedPayload: req.body,
   *   contentEncoding: 'br', contentType: 'application/x-ndjson'
   * });
   */

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

        // Parse messages - results is [streamName, messages[]]
        const streamData = results[0] as [string, Array<[string, string[]]>];
        const [streamName, messages] = streamData;
        const invalidMessageIds: string[] = [];

        const entries: RedisLogEntry[] = messages
          .map(([id, fields]: [string, string[]]) => {
            const fieldMap: Record<string, any> = {};
            for (let i = 0; i < fields.length; i += 2) {
              fieldMap[fields[i]] = fields[i + 1];
            }
            
            const compressedFlag = fieldMap.compressed;
            if (compressedFlag === '1') {
              // Compressed payload stored as raw binary string in Redis
              // We need to convert it back to Buffer
              const payloadRaw = fieldMap.payload;
              if (!payloadRaw) {
                logger.warn('Skipping log message with missing payload', { messageId: id });
                invalidMessageIds.push(id);
                return null;
              }
              
              // Payload comes back as binary string - convert to Buffer
              const compressedPayload = Buffer.from(payloadRaw, 'binary');
              
              return {
                id,
                isCompressed: true,
                data: {
                  deviceUuid: fieldMap.deviceUuid,
                  batchId: fieldMap.batchId,
                  compressedPayload,
                  contentEncoding: fieldMap.encoding,
                  contentType: fieldMap.contentType
                } as CompressedLogEntry
              };
            }

            if (!fieldMap.data) {
              logger.warn('Skipping log message with missing data field', { messageId: id });
              invalidMessageIds.push(id);
              return null;
            }

            try {
              return {
                id,
                isCompressed: false,
                data: JSON.parse(fieldMap.data) as LogEntry
              };
            } catch (parseErr: any) {
              logger.warn('Skipping log message with invalid JSON', {
                messageId: id,
                error: parseErr.message
              });
              invalidMessageIds.push(id);
              return null;
            }
          })
          .filter((entry): entry is Exclude<typeof entry, null> => entry !== null);

        if (invalidMessageIds.length > 0) {
          await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...invalidMessageIds);
        }

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
   * Process a batch: Decompress → Parse → Validate → Write to DB → Acknowledge
   * Handles both compressed (new) and parsed (legacy) entries
   */
  private async processBatch(entries: RedisLogEntry[]): Promise<void> {
    const startTime = Date.now();

    try {
      const allLogs: Array<{
        deviceUuid: string;
        serviceName?: string;
        timestamp?: Date;
        message: string;
        level?: string;
        isSystem?: boolean;
        isStderr?: boolean;
      }> = [];

      // Process each entry (decompress if needed, parse, validate)
      for (const entry of entries) {
        if (entry.isCompressed) {
          // NEW: Compressed entry - decompress + parse in worker (offloads CPU from main thread)
          const compressed = entry.data as CompressedLogEntry;
          try {
            const logs = await this.decompressAndParseLogs(compressed);
            allLogs.push(...logs);
          } catch (err: any) {
            logger.error('Failed to decompress/parse log batch', {
              deviceUuid: compressed.deviceUuid.substring(0, 8),
              batchId: compressed.batchId,
              encoding: compressed.contentEncoding,
              compressedBytes: compressed.compressedPayload.length,
              error: err.message
            });
            // Acknowledge anyway to prevent infinite retries
            await this.redisConsumer.xack(this.streamKey, this.consumerGroup, entry.id);
          }
        } else {
          // LEGACY: Already parsed entry
          allLogs.push(entry.data as LogEntry);
        }
      }

      if (allLogs.length === 0) {
        // No valid logs, but still acknowledge messages
        const messageIds = entries.map(e => e.id);
        await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...messageIds);
        return;
      }

      // Insert all logs in one batch operation
      await this.insertLogsBatch(allLogs);

      // Group logs by device for WebSocket broadcasting
      const logsByDevice = new Map<string, typeof allLogs>();
      allLogs.forEach(log => {
        const existing = logsByDevice.get(log.deviceUuid) || [];
        existing.push(log);
        logsByDevice.set(log.deviceUuid, existing);
      });

      // Publish to Redis pub/sub for WebSocket real-time streaming
      // This notifies connected WebSocket clients about new logs
      for (const [deviceUuid, deviceLogs] of logsByDevice.entries()) {
        try {
          const channel = `device:${deviceUuid}:logs`;
          await this.redisIngestion.publish(
            channel,
            JSON.stringify({ logs: deviceLogs })
          );
          logger.debug(`📤 Published ${deviceLogs.length} logs to Redis channel: ${channel}`);
        } catch (err: any) {
          logger.error('Failed to publish logs to WebSocket channel', {
            deviceUuid: deviceUuid.substring(0, 8),
            count: deviceLogs.length,
            error: err.message
          });
        }
      }

      // Acknowledge messages (atomic)
      const messageIds = entries.map(e => e.id);
      await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...messageIds);

      const duration = Date.now() - startTime;
      
      // Count unique devices for logging
      const uniqueDevices = new Set(allLogs.map(log => log.deviceUuid)).size;
      
      logger.info('Processed log batch from Redis', {
        totalLogs: allLogs.length,
        devices: uniqueDevices,
        compressedEntries: entries.filter(e => e.isCompressed).length,
        legacyEntries: entries.filter(e => !e.isCompressed).length,
        durationMs: duration,
        logsPerSecond: Math.round((allLogs.length / duration) * 1000)
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
   * Decompress and parse log payload (CPU-intensive work isolated to worker)
   * Supports Brotli, gzip, deflate, and identity (uncompressed)
   */
  private async decompressAndParseLogs(
    entry: CompressedLogEntry
  ): Promise<Array<{
    deviceUuid: string;
    serviceName?: string;
    timestamp?: Date;
    message: string;
    level?: string;
    isSystem?: boolean;
    isStderr?: boolean;
  }>> {
    const { createBrotliDecompress, createGunzip, createInflate } = await import('zlib');
    const { promisify } = await import('util');
    const { pipeline } = await import('stream');
    const pipelineAsync = promisify(pipeline);

    let decompressed: Buffer;

    // Decompress based on content-encoding
    if (entry.contentEncoding === 'br') {
      // Brotli decompression (CPU-intensive!)
      const chunks: Buffer[] = [];
      const decompressor = createBrotliDecompress();
      decompressor.on('data', (chunk) => chunks.push(chunk));
      
      await new Promise<void>((resolve, reject) => {
        decompressor.on('end', () => resolve());
        decompressor.on('error', reject);
        decompressor.write(entry.compressedPayload);
        decompressor.end();
      });
      
      decompressed = Buffer.concat(chunks);
    } else if (entry.contentEncoding === 'gzip') {
      // Gzip decompression
      const chunks: Buffer[] = [];
      const decompressor = createGunzip();
      decompressor.on('data', (chunk) => chunks.push(chunk));
      
      await new Promise<void>((resolve, reject) => {
        decompressor.on('end', () => resolve());
        decompressor.on('error', reject);
        decompressor.write(entry.compressedPayload);
        decompressor.end();
      });
      
      decompressed = Buffer.concat(chunks);
    } else if (entry.contentEncoding === 'deflate') {
      // Deflate decompression
      const chunks: Buffer[] = [];
      const decompressor = createInflate();
      decompressor.on('data', (chunk) => chunks.push(chunk));
      
      await new Promise<void>((resolve, reject) => {
        decompressor.on('end', () => resolve());
        decompressor.on('error', reject);
        decompressor.write(entry.compressedPayload);
        decompressor.end();
      });
      
      decompressed = Buffer.concat(chunks);
    } else {
      // No compression (identity)
      decompressed = entry.compressedPayload;
    }

    const decompressedText = decompressed.toString('utf8');
    let logs: any[];

    // Parse based on content-type
    if (entry.contentType.includes('application/x-ndjson') || entry.contentType.includes('text/plain')) {
      // NDJSON format (newline-delimited JSON)
      logs = decompressedText
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            logger.warn('Failed to parse NDJSON line', { 
              deviceUuid: entry.deviceUuid.substring(0, 8),
              line: line.substring(0, 100) 
            });
            return null;
          }
        })
        .filter(log => log !== null);
    } else {
      // JSON array format
      try {
        logs = JSON.parse(decompressedText);
        if (!Array.isArray(logs)) {
          logs = [logs]; // Single log object
        }
      } catch (e) {
        logger.error('Failed to parse JSON payload', {
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          error: e instanceof Error ? e.message : String(e)
        });
        throw e;
      }
    }

    // Transform and validate logs
    const transformedLogs = logs
      .map((log: any) => ({
        deviceUuid: entry.deviceUuid,
        serviceName: log.serviceName || log.source?.name || null,
        timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
        message: log.message,
        isSystem: log.isSystem || false,
        isStderr: log.isStderr || log.isStdErr || false,
        level: log.level || 'info'
      }))
      .filter(log => {
        // Validate message field (prevent database constraint violations)
        if (!log.message || typeof log.message !== 'string' || log.message.trim() === '') {
          logger.warn('Dropping log with null/empty message', {
            deviceUuid: entry.deviceUuid.substring(0, 8),
            batchId: entry.batchId,
            serviceName: log.serviceName,
            timestamp: log.timestamp
          });
          return false;
        }
        return true;
      });

    // Apply sampling (configurable via env var)
    const samplingRate = parseFloat(process.env.LOG_SAMPLING_RATE || '1.0');
    const sampledLogs = transformedLogs.filter(log => {
      // Always store errors and warnings
      if (log.level === 'error' || log.level === 'warn' || log.isStderr) {
        return true;
      }
      // Sample info/debug logs
      return Math.random() < samplingRate;
    });

    const droppedCount = transformedLogs.length - sampledLogs.length;
    if (droppedCount > 0) {
      logger.debug('Sampled logs in worker', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        batchId: entry.batchId,
        received: transformedLogs.length,
        stored: sampledLogs.length,
        dropped: droppedCount,
        samplingRate
      });
    }

    return sampledLogs;
  }

  /**
   * Insert all logs in a single batch INSERT (across all devices)
   * Uses PostgreSQL COPY protocol for maximum throughput (20-50× faster than INSERT)
   * Falls back to batch INSERT if COPY fails
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
    const useCopyProtocol = process.env.USE_COPY_PROTOCOL !== 'false'; // Default: enabled

    if (useCopyProtocol) {
      try {
        await this.insertLogsBatchCopy(logs);
        return; // Success - exit early
      } catch (err: any) {
        logger.warn('COPY protocol failed, falling back to INSERT', {
          error: err.message,
          logCount: logs.length
        });
        // Fall through to INSERT fallback
      }
    }

    // Fallback: Batch INSERT (slower but more compatible)
    await this.insertLogsBatchInsert(logs);
  }

  /**
   * PostgreSQL COPY protocol - fastest bulk insert (20-50× faster than INSERT)
   * Uses TEXT format with tab delimiters for simplicity
   */
  private async insertLogsBatchCopy(
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
    const { from: copyFrom } = await import('pg-copy-streams');
    const { Readable } = await import('stream');

    // Get raw connection from pool
    const poolWrapper = await import('../db/connection');
    const pool = poolWrapper.default.pool as any; // Access underlying pg.Pool
    const client = await pool.connect();

    try {
      // Convert logs to CSV format (tab-delimited TEXT)
      // Format: device_uuid\tservice_name\ttimestamp\tmessage\tlevel\tis_system\tis_stderr
      const csvData = logs.map(log => {
        const message = (log.message || '[empty log message]').replace(/\t/g, ' ').replace(/\n/g, '\\n');
        const serviceName = (log.serviceName || '\\N').replace(/\t/g, ' '); // \N = NULL in COPY
        const timestamp = (log.timestamp || new Date()).toISOString();
        const level = log.level || 'info';
        const isSystem = log.isSystem ? 't' : 'f'; // PostgreSQL boolean format
        const isStderr = log.isStderr ? 't' : 'f';

        return `${log.deviceUuid}\t${serviceName}\t${timestamp}\t${message}\t${level}\t${isSystem}\t${isStderr}`;
      }).join('\n');

      // Create readable stream from CSV data
      const stream = Readable.from([csvData]);

      // Execute COPY command
      const copyStream = client.query(
        copyFrom(`COPY device_logs (device_uuid, service_name, timestamp, message, level, is_system, is_stderr) FROM STDIN WITH (FORMAT text, DELIMITER E'\\t', NULL '\\N')`)
      );

      // Pipe data to PostgreSQL
      await new Promise<void>((resolve, reject) => {
        stream.pipe(copyStream)
          .on('finish', () => resolve())
          .on('error', (err) => reject(err));
      });

      logger.debug('Inserted logs using COPY protocol', {
        count: logs.length
      });

    } finally {
      client.release();
    }
  }

  /**
   * Batch INSERT fallback (slower but more compatible)
   * Chunks into 500-row batches to avoid PostgreSQL parameter limits
   */
  private async insertLogsBatchInsert(
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

    // Split into chunks (PostgreSQL param limit: 65535, we use 500 for safety)
    const chunks: typeof logs[] = [];
    for (let i = 0; i < logs.length; i += batchSize) {
      chunks.push(logs.slice(i, i + batchSize));
    }

    // Insert all chunks in parallel
    await Promise.all(
      chunks.map(async (chunk) => {
        const values: any[] = [];
        const placeholders: string[] = [];

        chunk.forEach((log, index) => {
          const message = log.message || '[empty log message]';
          const serviceName = log.serviceName || null; // Use NULL for missing service names

          const offset = index * 7;
          placeholders.push(
            `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7})`
          );
          values.push(
            log.deviceUuid,
            serviceName,
            log.timestamp || new Date(),
            message,
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

    logger.debug('Inserted logs using batch INSERT', {
      count: logs.length,
      chunks: chunks.length
    });
  }

  /**
   * Stop worker gracefully
   */
  async stopWorker(): Promise<void> {
    logger.info('Stopping Redis log worker...');
    this.isRunning = false;

    // Wait for current batch to complete (max 10 seconds)
    await new Promise(resolve => setTimeout(resolve, 10000));

    await Promise.all([
      this.redisIngestion.quit(),
      this.redisConsumer.quit()
    ]);
    logger.info('Redis log worker stopped');
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    try {
      const info = await this.redisConsumer.xinfo('STREAM', this.streamKey);
      const pending = await this.redisConsumer.xpending(this.streamKey, this.consumerGroup);

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
        logger.error('Log pipeline auto-flush failed', { error: err.message })
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
      
      logger.info('Flushed log pipeline', {
        operations: count,
        totalLatencyMs: duration,
        avgLatencyPerOpMs: avgLatency,
        opsPerSecond: duration > 0 ? Math.round((count / duration) * 1000) : count
      });
    } catch (err) {
      logger.error('Log pipeline exec failed', {
        error: err instanceof Error ? err.message : String(err),
        count
      });
    }
  }
}

// Singleton instance
export const redisLogQueue = new RedisLogQueue();
