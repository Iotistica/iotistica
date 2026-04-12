/**
 * Redis Streams Log Queue — write path only.
 *
 * Publishes compressed log batches to the device logs stream via XADD.
 * Consumption and DB persistence are handled by the ingestion service
 * (ingestion/src/services/log-worker.ts).
 *
 * Uses pipeline batching (up to pipelineBatchSize XADDs per EXEC) to
 * minimise Redis round trips under bursty traffic.
 */

import Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { getRedisIngestion } from '../../redis/client-factory';
import { deviceLogsStreamKey, getTenantId } from '../../redis/tenant-keys';

export interface CompressedLogEntry {
  deviceUuid: string;
  batchId: string;
  compressedPayload: Buffer;
  contentEncoding: string;
  contentType: string;
}

class RedisLogQueue {
  private redisIngestion: Redis;
  private tenantId: string;
  private get streamKey(): string { return deviceLogsStreamKey(this.resolveTenantId()); }
  private maxStreamLength: number;

  // Pipeline batching for multiple rapid XADDs
  private pendingPipeline: ReturnType<typeof this.redisIngestion.pipeline> | null = null;
  private pipelineCount = 0;
  private readonly pipelineBatchSize = 10;
  private pipelineFlushTimer: NodeJS.Timeout | null = null;

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  constructor(tenantId?: string) {
    this.redisIngestion = getRedisIngestion();
    this.tenantId = tenantId || '';
    this.maxStreamLength = parseInt(process.env.LOG_STREAM_MAXLEN || '500000', 10);

    this.redisIngestion.on('error', (err) => {
      logger.error('Redis log ingestion connection error', { error: err.message });
    });

    this.redisIngestion.on('connect', () => {
      logger.info('Redis log ingestion connected');
    });
  }

  /**
   * Add compressed log payload to Redis Stream (FAST - no parsing!)
   * Worker (ingestion service) handles decompression + parsing.
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
        const payloadBase64 = entry.compressedPayload.toString('base64');
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
          'payload_b64', payloadBase64,
          'payloadSize', entry.compressedPayload.length.toString()
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
   * Stop the write path: flush any pending pipeline and close the Redis client.
   */
  async stopWorker(): Promise<void> {
    logger.info('Stopping Redis log queue writer...');
    if (this.pipelineFlushTimer) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }
    await this.flushPipeline().catch(err =>
      logger.warn('Pipeline flush error during shutdown', { error: (err as Error).message })
    );
    await this.redisIngestion.quit();
    logger.info('Redis log queue writer stopped');
  }

  /**
   * Get stream statistics (stream length only — consumer state is in ingestion).
   */
  async getStats() {
    try {
      const length = await this.redisIngestion.xlen(this.streamKey);
      return { streamLength: length, streamKey: this.streamKey };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
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
        logger.error('Log pipeline auto-flush failed', { error: (err as Error).message })
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
