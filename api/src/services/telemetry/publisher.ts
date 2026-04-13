/**
 * Redis Streams write-path publishers.
 *
 * Both publishers do one thing: XADD to a Redis stream so the ingestion
 * service can consume and persist the data.  Neither reads from streams.
 *
 * Streams:
 *   deviceReadingsPublisher  – device telemetry (JSON array, one XADD per batch)
 *   deviceLogsPublisher      – compressed log payloads (pipelined XADDs)
 */

import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { getRedisIngestion } from '../../redis/client-factory';
import {
  agentDevicesIngestionStreamKey,
  deviceLogsStreamKey,
  getTenantId,
} from '../../redis/tenant-keys';
import type { AddOutcome, DeviceDataEntry } from './types';
import { circuitBreaker } from './circuit-breaker';
import { DiskSpool } from './disk-spool';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface CompressedLogEntry {
  deviceUuid: string;
  batchId: string;
  compressedPayload: Buffer;
  contentEncoding: string;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Device readings publisher
// ---------------------------------------------------------------------------

export class DeviceReadingsPublisher {
  private readonly redis: Redis;
  private readonly maxStreamLength: number;
  private tenantId: string;
  private readonly diskSpool: DiskSpool;

  constructor(tenantId?: string) {
    this.redis = getRedisIngestion();
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
    this.tenantId = tenantId || '';

    const spoolPath = process.env.DISK_SPOOL_PATH || '/tmp/iotistic-spool';
    const maxSizeMb = parseInt(process.env.DISK_SPOOL_MAX_SIZE_MB || '500', 10);
    this.diskSpool = new DiskSpool(spoolPath, maxSizeMb);

    if (process.env.DISK_SPOOL_ENABLED === 'true') {
      this.diskSpool.initialize()
        .then(() => this.diskSpool.startReplayer(
          (data, source) => this.add(data, source),
          () => this.redis.status === 'ready',
        ))
        .catch(err => logger.error('Failed to initialize disk spool', { error: err.message }));
    }
  }

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  private get streamKey(): string {
    return agentDevicesIngestionStreamKey(this.resolveTenantId());
  }

  async add(deviceData: DeviceDataEntry[], source?: string): Promise<AddOutcome> {
    if (deviceData.length === 0) {
      return 'redis';
    }

    // Circuit open — Redis is known to be failing, skip attempt and spool directly.
    if (!circuitBreaker.shouldAllowRequest()) {
      return this.fallbackToDiskOrDrop(deviceData, source);
    }

    try {
      await this.redis.xadd(
        this.streamKey,
        'MAXLEN',
        '~',
        this.maxStreamLength,
        '*',
        'data',
        JSON.stringify(deviceData),
        'source',
        source ?? '',
      );

      circuitBreaker.recordSuccess();
      logger.debug('Queued device readings for ingestion', {
        count: deviceData.length,
        streamKey: this.streamKey,
      });
      return 'redis';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('Failed to queue device readings for ingestion', {
        count: deviceData.length,
        streamKey: this.streamKey,
        error: message,
      });
      circuitBreaker.recordFailure();
      return this.fallbackToDiskOrDrop(deviceData, source);
    }
  }

  private async fallbackToDiskOrDrop(deviceData: DeviceDataEntry[], source?: string): Promise<AddOutcome> {
    if (!this.diskSpool.isEnabled()) {
      logger.error('Redis unavailable and disk spool disabled — dropping data', {
        count: deviceData.length,
      });
      return 'dropped';
    }
    try {
      await this.diskSpool.spoolToDisk(deviceData, source);
      return 'disk';
    } catch (err: any) {
      logger.error('Disk spool write failed — dropping data', {
        count: deviceData.length,
        error: err.message,
      });
      return 'dropped';
    }
  }
}

// ---------------------------------------------------------------------------
// Device logs publisher  (pipeline-batched for bursty log traffic)
// ---------------------------------------------------------------------------

export class DeviceLogsPublisher {
  private readonly redis: Redis;
  private tenantId: string;
  private readonly maxStreamLength: number;

  private pendingPipeline: ReturnType<typeof this.redis.pipeline> | null = null;
  private pipelineCount = 0;
  private readonly pipelineBatchSize = 10;
  private pipelineFlushTimer: NodeJS.Timeout | null = null;

  constructor(tenantId?: string) {
    this.redis = getRedisIngestion();
    this.tenantId = tenantId || '';
    this.maxStreamLength = parseInt(process.env.LOG_STREAM_MAXLEN || '500000', 10);

    this.redis.on('error', (err) => {
      logger.error('Redis log stream connection error', { error: err.message });
    });
  }

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  private get streamKey(): string {
    return deviceLogsStreamKey(this.resolveTenantId());
  }

  async addCompressed(entry: CompressedLogEntry, source?: string): Promise<void> {
    try {
      if (!circuitBreaker.shouldAllowRequest()) {
        logger.warn('Redis circuit open, dropping compressed log batch', {
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          compressedBytes: entry.compressedPayload.length,
        });
        return;
      }

      if (this.redis.status !== 'ready' && this.redis.status !== 'connect') {
        logger.error('Redis not ready, dropping compressed log batch', {
          status: this.redis.status,
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          compressedBytes: entry.compressedPayload.length,
        });
        return;
      }

      this.addToPipeline(() => {
        const pipeline = this.pendingPipeline ?? this.redis.pipeline();
        pipeline.xadd(
          this.streamKey,
          'MAXLEN',
          '~',
          this.maxStreamLength,
          '*',
          'compressed', '1',
          'deviceUuid', entry.deviceUuid,
          'batchId', entry.batchId,
          'encoding', entry.contentEncoding,
          'contentType', entry.contentType,
          'payload_b64', entry.compressedPayload.toString('base64'),
          'payloadSize', entry.compressedPayload.length.toString(),
          'source', source ?? '',
        );
        return pipeline;
      }).catch(err => {
        logger.error('Failed to queue compressed logs to Redis (async)', {
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          error: (err as Error).message,
        });
      });

      logger.info('Queued compressed log payload (pipelined)', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        batchId: entry.batchId,
        payloadBytes: entry.compressedPayload.length,
        encoding: entry.contentEncoding,
        pipelineDepth: this.pipelineCount,
      });
    } catch (err: unknown) {
      logger.error('Failed to queue compressed logs to Redis', {
        deviceUuid: entry.deviceUuid.substring(0, 8),
        batchId: entry.batchId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async flush(): Promise<void> {
    logger.info('Flushing device logs publisher...');
    if (this.pipelineFlushTimer) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }
    await this.flushPipeline().catch(err =>
      logger.warn('Pipeline flush error during shutdown', { error: (err as Error).message })
    );
    await this.redis.quit();
    logger.info('Device logs publisher stopped');
  }

  async getStats() {
    try {
      const length = await this.redis.xlen(this.streamKey);
      return { streamLength: length, streamKey: this.streamKey };
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async addToPipeline(addFn: () => ReturnType<typeof this.redis.pipeline>): Promise<void> {
    this.pendingPipeline = addFn();
    this.pipelineCount++;

    if (this.pipelineFlushTimer) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }

    if (this.pipelineCount >= this.pipelineBatchSize) {
      return this.flushPipeline();
    }

    this.pipelineFlushTimer = setTimeout(() => {
      this.flushPipeline().catch(err =>
        logger.error('Log pipeline auto-flush failed', { error: (err as Error).message })
      );
    }, 50);
  }

  private async flushPipeline(): Promise<void> {
    if (!this.pendingPipeline || this.pipelineCount === 0) return;

    const count = this.pipelineCount;
    const pipeline = this.pendingPipeline;

    this.pendingPipeline = null;
    this.pipelineCount = 0;
    if (this.pipelineFlushTimer) {
      clearTimeout(this.pipelineFlushTimer);
      this.pipelineFlushTimer = null;
    }

    try {
      const start = Date.now();
      await pipeline.exec();
      const duration = Date.now() - start;
      logger.info('Flushed log pipeline', {
        operations: count,
        totalLatencyMs: duration,
        avgLatencyPerOpMs: count > 0 ? Math.round(duration / count) : 0,
        opsPerSecond: duration > 0 ? Math.round((count / duration) * 1000) : count,
      });
    } catch (err) {
      logger.error('Log pipeline exec failed', {
        error: err instanceof Error ? err.message : String(err),
        count,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Singletons
// ---------------------------------------------------------------------------

export const redisDeviceQueue = new DeviceReadingsPublisher();
export const redisLogQueue = new DeviceLogsPublisher();
