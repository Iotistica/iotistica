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
import { RedisPipeline } from './pipeline';

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
  private readonly streamHighWatermarkPct: number;
  private tenantId: string;
  private readonly diskSpool: DiskSpool;
  private readonly pipeline: RedisPipeline;

  // Stream high-watermark state — updated by background poller, checked on hot path.
  private streamOverHighWatermark = false;
  private streamWatermarkPoller: NodeJS.Timeout | null = null;
  private spoolRerouteCount = 0;  // writes redirected to disk spool due to watermark

  constructor(tenantId?: string) {
    this.redis = getRedisIngestion();
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
    this.streamHighWatermarkPct = parseFloat(process.env.REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT || '0.85');
    this.tenantId = tenantId || '';

    const spoolPath = process.env.DISK_SPOOL_PATH || '/tmp/iotistic-spool';
    const maxSizeMb = parseInt(process.env.DISK_SPOOL_MAX_SIZE_MB || '500', 10);
    this.diskSpool = new DiskSpool(spoolPath, maxSizeMb);

    this.pipeline = new RedisPipeline(this.redis, {
      onPersistentOomFailure: (dropped) => {
        // Force the circuit open so subsequent writes route to disk spool
        // instead of retrying Redis while it remains at maxmemory.
        for (let i = 0; i < 5; i++) circuitBreaker.recordFailure();
        logger.error('Redis OOM: pipeline retries exhausted, circuit forced OPEN', { dropped });
      },
    });

    if (process.env.DISK_SPOOL_ENABLED === 'true') {
      this.diskSpool.initialize()
        .then(() => this.diskSpool.startReplayer(
          (data, source) => this.addInternal(data, true, source),
          // Only replay when Redis is connected AND the stream has room — injecting
          // into a full stream just causes MAXLEN trimming while depth stays at max.
          () => this.redis.status === 'ready' && !this.streamOverHighWatermark,
        ))
        .catch(err => logger.error('Failed to initialize disk spool', { error: err.message }));
    }

    // Poll stream depth every 3s. When depth >= maxLen × watermarkPct we stop
    // writing to Redis and spool to disk instead, preventing silent MAXLEN trim.
    // The disk spool replayer re-queues data once the stream drains.
    const pollIntervalMs = parseInt(process.env.STREAM_WATERMARK_POLL_INTERVAL_MS || '3000', 10);
    this.streamWatermarkPoller = setInterval(() => {
      this.checkStreamWatermark().catch(() => { /* ignore transient redis errors */ });
    }, pollIntervalMs);
    // Allow Node.js to exit even if this timer is still running
    if (this.streamWatermarkPoller.unref) this.streamWatermarkPoller.unref();
  }

  private async checkStreamWatermark(): Promise<void> {
    if (!this.isRedisReady()) return;
    try {
      const depth = await this.redis.xlen(this.streamKey);
      const threshold = Math.floor(this.maxStreamLength * this.streamHighWatermarkPct);
      const wasOver = this.streamOverHighWatermark;
      this.streamOverHighWatermark = depth >= threshold;

      if (!wasOver && this.streamOverHighWatermark) {
        logger.warn('Redis ingestion stream above high-watermark — routing new writes to disk spool', {
          streamDepth: depth,
          threshold,
          maxStreamLength: this.maxStreamLength,
          watermarkPct: this.streamHighWatermarkPct,
        });
      } else if (wasOver && !this.streamOverHighWatermark) {
        const rerouted = this.spoolRerouteCount;
        this.spoolRerouteCount = 0;
        logger.info('Redis ingestion stream drained below high-watermark — resuming Redis writes', {
          streamDepth: depth,
          threshold,
          writesReroutedToDisk: rerouted,
        });
      } else if (this.streamOverHighWatermark && this.spoolRerouteCount > 0) {
        logger.info('Redis ingestion stream still above high-watermark — disk spool active', {
          streamDepth: depth,
          threshold,
          writesReroutedToDiskThisPeriod: this.spoolRerouteCount,
        });
        this.spoolRerouteCount = 0;
      }
    } catch {
      // Transient Redis error — leave watermark flag unchanged
    }
  }

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  private get streamKey(): string {
    return agentDevicesIngestionStreamKey(this.resolveTenantId());
  }

  private isRedisReady(): boolean {
    return this.redis.status === 'ready' || this.redis.status === 'connect';
  }

  async add(deviceData: DeviceDataEntry[], source?: string): Promise<AddOutcome> {
    return this.addInternal(deviceData, false, source);
  }

  async addInternal(deviceData: DeviceDataEntry[], bypassCircuit: boolean, source?: string): Promise<AddOutcome> {
    if (deviceData.length === 0) {
      return 'redis';
    }

    // Circuit open — Redis is known to be failing, skip attempt and spool directly.
    // bypassCircuit=true is used by the disk spool replayer so recovered data is
    // re-queued even while the circuit probes recovery (HALF_OPEN or just re-opened).
    if (!bypassCircuit && !circuitBreaker.shouldAllowRequest()) {
      return this.fallbackToDiskOrDrop(deviceData, source);
    }

    // Stream high-watermark — ingestion is falling behind. Route to disk spool so
    // XADD MAXLEN trimming cannot silently discard entries. The disk spool replayer
    // re-queues data automatically once the stream drains below the watermark.
    if (!bypassCircuit && this.streamOverHighWatermark) {
      this.spoolRerouteCount++;
      return this.fallbackToDiskOrDrop(deviceData, source);
    }

    // Proactive readiness check: avoid queuing into a reconnecting pipeline and
    // immediately fall back to disk rather than waiting for a pipeline error.
    if (!this.isRedisReady()) {
      if (!bypassCircuit) circuitBreaker.recordFailure();
      logger.debug('Redis not ready, routing to disk spool', {
        redisStatus: this.redis.status,
        count: deviceData.length,
      });
      return this.fallbackToDiskOrDrop(deviceData, source);
    }

    try {
      const streamKey = this.streamKey;
      const payload = JSON.stringify(deviceData);
      await this.pipeline.add(p => {
        p.xadd(
          streamKey,
          'MAXLEN', '~', this.maxStreamLength,
          '*',
          'data', payload,
          'source', source ?? '',
        );
      });

      circuitBreaker.recordSuccess();
      logger.debug('Queued device readings for ingestion', {
        count: deviceData.length,
        streamKey,
      });
      return 'redis';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // OOM after all retries exhausted rejects the pipeline.add() promise;
      // onPersistentOomFailure has already forced the circuit open.
      if (!bypassCircuit && !message.includes('OOM')) {
        circuitBreaker.recordFailure();
      }
      logger.error('Failed to queue device readings for ingestion', {
        count: deviceData.length,
        streamKey: this.streamKey,
        error: message,
      });
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

  async destroy(): Promise<void> {
    if (this.streamWatermarkPoller) {
      clearInterval(this.streamWatermarkPoller);
      this.streamWatermarkPoller = null;
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
