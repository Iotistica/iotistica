import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { getPoolStats } from '../../db/connection';
import { DeviceDataEntry, CompressedDeviceEntry, RedisDeviceEntry } from './types';
import { decompressAndParseSensors } from './decoder';
import { incrementFailureCount, moveToDLQ, startFailureTrackingPruner } from './dlq';
import { ReadingInserter } from './reading-inserter';
import { metrics } from './metrics';

export interface WorkerConfig {
  streamKey: string;
  processingStreamKey: string;
  dlqStreamKey: string;
  consumerGroup: string;
  consumerName: string;
  workerCount: number;
  batchSize: number;
  blockTimeMs: number;
  maxRetries: number;
  maxDlqLength: number;
  maxStreamLength: number;
  dbWaitingHighWatermark: number;
  dbSaturationHighWatermarkPct: number;
  backpressureSleepMs: number;
  /**
   * Stream length (XLEN) as a fraction of maxStreamLength above which the worker emits
   * an autoscale warning and increases its effective batch size to drain faster.
   * Range 0–1. Default: 0.8 (80% of MAXLEN).
   */
  redisStreamHighWatermarkPct: number;
  /**
   * Redis used_memory / maxmemory percentage above which the worker emits an autoscale warning.
   * 0 disables memory pressure checks. Default: 75.
   */
  redisMemoryHighWatermarkPct: number;
}

/**
 * Tracks recently processed Redis Stream message IDs to suppress in-process redeliveries.
 * Uses insertion-order eviction to bound memory at ~maxSize × ~20 bytes.
 */
class RecentMessageTracker {
  private readonly ids = new Set<string>();
  private readonly maxSize: number;

  constructor(maxSize = 50_000) {
    this.maxSize = maxSize;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  markAll(ids: string[]): void {
    for (const id of ids) {
      if (this.ids.size >= this.maxSize) {
        // Evict oldest ~20% (Set preserves insertion order)
        const toEvict = Math.floor(this.maxSize * 0.2);
        const iter = this.ids.values();
        for (let i = 0; i < toEvict; i++) {
          const { value, done } = iter.next();
          if (done) break;
          this.ids.delete(value);
        }
      }
      this.ids.add(id);
    }
  }
}

export class RedisQueueConsumer {
  private isRunning = false;
  private lastBackpressureLogAtMs = 0;
  private lastRedisPressureLogAtMs = 0;
  private readonly messageTracker = new RecentMessageTracker();

  constructor(
    private readonly redis: Redis,
    private readonly config: WorkerConfig,
    private readonly inserter: ReadingInserter,
    private readonly onReinitialize: () => Promise<void>,
  ) {}

  private short(id?: string): string | undefined {
    return id?.substring(0, 8);
  }

  /**
   * Parse the API-side ingestion timestamp from a Redis Stream entry ID.
   * Stream IDs have the form "<unix-ms>-<sequence>", so the ms component is
   * a free ingestion durability hint that requires no extra stream fields.
   */
  private ingestedAtMs(entryId: string): number {
    const ms = parseInt(entryId.split('-')[0], 10);
    return isNaN(ms) ? Date.now() : ms;
  }

  private logEntryError(msg: string, entry: RedisDeviceEntry, err: any): void {
    const data = entry.data as CompressedDeviceEntry;
    logger.error(msg, {
      messageId: entry.id,
      deviceUuid: this.short(data.deviceUuid),
      sensorName: data.sensorName,
      error: err?.message ?? err,
    });
  }

  /**
   * Route a structurally unrecoverable message to the DLQ instead of silently ACKing it.
   * Uses attempts=0 to distinguish decode failures from DB-retry exhaustion.
   * Strips raw payload bytes before writing to the DLQ stream to avoid bloat.
   */
  private async sendDecodeFailureToDlq(entry: RedisDeviceEntry, reason: string): Promise<void> {
    logger.warn('Moving structurally invalid message to DLQ (decode failure, not a transient error)', {
      messageId: entry.id,
      reason,
      deviceUuid: this.short((entry.data as CompressedDeviceEntry).deviceUuid),
      sensorName: (entry.data as CompressedDeviceEntry).sensorName,
    });
    // Strip binary payloads — they are unrecoverable by definition and can be large.
    // Metadata + error reason is sufficient for operator investigation.
    const dlqEntry: RedisDeviceEntry = entry.isCompressed
      ? { ...entry, data: { ...(entry.data as CompressedDeviceEntry), compressedPayload: Buffer.alloc(0) } }
      : entry;
    await moveToDLQ(
      this.redis,
      this.config.streamKey, this.config.consumerGroup, this.config.dlqStreamKey,
      this.config.maxDlqLength,
      dlqEntry, reason, 0,
    );
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Sensor worker already running');
      return;
    }

    this.isRunning = true;

    logger.info('Starting Redis sensor workers', {
      consumer: this.config.consumerName,
      workerCount: this.config.workerCount,
      batchSize: this.config.batchSize,
      blockTimeMs: this.config.blockTimeMs,
    });

    startFailureTrackingPruner(this.redis);

    for (let i = 0; i < this.config.workerCount; i++) {
      this.workerLoop(i).catch(err => {
        logger.error('Device worker loop crashed', {
          workerId: i,
          error: err.message,
          stack: err.stack,
        });
      });
    }
  }

  stop(): void {
    this.isRunning = false;
  }

  private async handleWorkerError(workerId: number, err: any): Promise<void> {
    if (err.message?.includes('NOGROUP')) {
      logger.warn('Consumer group missing, reinitializing...', {
        group: this.config.consumerGroup,
        stream: this.config.streamKey,
      });
      try {
        await this.onReinitialize();
      } catch (initErr: any) {
        logger.error('Failed to reinitialize consumer group', { error: initErr.message });
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } else {
      logger.error('Error in device worker loop', { workerId, error: err.message });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async workerLoop(workerId: number): Promise<void> {
    while (this.isRunning) {
      try {
        if (this.shouldBackoffForDbPressure()) {
          await new Promise(resolve => setTimeout(resolve, this.config.backpressureSleepMs));
          continue;
        }

        // Check Redis pressure AFTER DB backpressure — if the DB is already the bottleneck
        // there is no point reading more entries. When DB is healthy, use the uplifted batch
        // size to drain Redis faster under stream or memory pressure.
        const effectiveBatchSize = this.checkRedisPressure();

        const staleEntries = await this.claimStaleMessages();
        if (staleEntries.length > 0) {
          await this.processBatch(staleEntries);
          continue;
        }

        const results = await this.redis.xreadgroup(
          'GROUP', this.config.consumerGroup, this.config.consumerName,
          'COUNT', effectiveBatchSize,
          'BLOCK', this.config.blockTimeMs,
          'STREAMS', this.config.streamKey, '>',
        );

        if (!results || results.length === 0) continue;

        const [, messages] = results[0] as [string, Array<[string, string[]]>];
        const entries = this.parseStreamMessages(messages);
        if (entries.length === 0) continue;

        await this.processBatch(entries);
      } catch (err: any) {
        await this.handleWorkerError(workerId, err);
      }
    }
  }

  /**
   * Checks whether Redis stream length or memory usage has crossed configured high-watermarks.
   * Does NOT pause the worker — high Redis pressure means we should consume FASTER, not slower.
   * Instead this method:
   *   1. Emits a structured warning log with `action: 'autoscale_signal'` for alerting pipelines.
   *   2. Returns an uplifted batch size so each XREADGROUP call drains more entries per iteration.
   *
   * Reads from the shared `metrics` object which is refreshed by the 30s health collector,
   * so there are zero extra Redis calls on the hot worker path.
   *
   * @returns effective batch size to use for this iteration (uplifted under pressure)
   */
  private checkRedisPressure(): number {
    const streamWatermark = Math.floor(
      this.config.maxStreamLength * this.config.redisStreamHighWatermarkPct,
    );
    const streamLen = metrics.streamLength;
    const memUsed = metrics.redisMemoryUsedBytes;
    const memMax = metrics.redisMemoryMaxBytes;

    const streamPressure = streamWatermark > 0 && streamLen >= streamWatermark;
    const memUsedPct = memMax > 0 ? (memUsed / memMax) * 100 : 0;
    const memPressure =
      this.config.redisMemoryHighWatermarkPct > 0 &&
      memMax > 0 &&
      memUsedPct >= this.config.redisMemoryHighWatermarkPct;

    if (!streamPressure && !memPressure) {
      return this.config.batchSize;
    }

    const now = Date.now();
    if (now - this.lastRedisPressureLogAtMs > 10_000) {
      this.lastRedisPressureLogAtMs = now;
      logger.warn('Redis pressure high — increase consumer workers or reduce producer rate', {
        action: 'autoscale_signal',
        streamLength: streamLen,
        streamHighWatermark: streamWatermark,
        streamUtilizationPct: streamWatermark > 0 ? Math.round((streamLen / streamWatermark) * 100) : null,
        memoryUsedMb: Math.round(memUsed / 1024 / 1024),
        memoryMaxMb: memMax > 0 ? Math.round(memMax / 1024 / 1024) : 'unlimited',
        memoryUtilizationPct: memMax > 0 ? Math.round(memUsedPct) : null,
        streamPressure,
        memPressure,
        response: 'increasing batch size to drain stream faster',
      });
    }

    // Under pressure, double the batch size (capped at 10× the configured base) so each
    // XREADGROUP iteration pulls more entries and drains the backlog faster.
    return Math.min(this.config.batchSize * 2, this.config.batchSize * 10);
  }

  private shouldBackoffForDbPressure(): boolean {
    const stats = getPoolStats();
    const waitingTooHigh = stats.waiting >= this.config.dbWaitingHighWatermark;
    const saturationTooHigh = stats.saturationPct >= this.config.dbSaturationHighWatermarkPct;

    if (!waitingTooHigh && !saturationTooHigh) {
      return false;
    }

    const now = Date.now();
    if (now - this.lastBackpressureLogAtMs > 10000) {
      this.lastBackpressureLogAtMs = now;
      logger.warn('Applying ingestion backpressure due to DB pool pressure', {
        waiting: stats.waiting,
        saturationPct: stats.saturationPct,
        configuredMax: stats.configuredMax,
        waitingHighWatermark: this.config.dbWaitingHighWatermark,
        saturationHighWatermarkPct: this.config.dbSaturationHighWatermarkPct,
        sleepMs: this.config.backpressureSleepMs,
      });
    }

    return true;
  }

  private parseStreamMessages(messages: Array<[string, string[]]>): RedisDeviceEntry[] {
    return messages
      .map(([id, fields]) => {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];

        if (fieldMap.compressed === '1') {
          const payloadRaw = fieldMap.payload;
          if (!payloadRaw) {
            logger.warn('Skipping sensor message with missing payload', { messageId: id });
            return null;
          }
          return {
            id,
            data: {
              deviceUuid: fieldMap.deviceUuid,
              sensorName: fieldMap.sensorName,
              batchId: fieldMap.batchId,
              compressedPayload: Buffer.from(payloadRaw, 'binary'),
              contentEncoding: fieldMap.encoding,
              contentType: fieldMap.contentType,
            } as CompressedDeviceEntry,
            isCompressed: true,
          };
        }

        return {
          id,
          data: JSON.parse(fieldMap.data) as DeviceDataEntry,
          isCompressed: false,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null) as RedisDeviceEntry[];
  }

  /**
   * Claim messages that have been sitting in PENDING for >60s (worker crashed mid-batch).
   * Uses XAUTOCLAIM (Redis >=6.2).
   */
  private async claimStaleMessages(): Promise<RedisDeviceEntry[]> {
    try {
      const minIdleMs = 60000;
      const result = await this.redis.xautoclaim(
        this.config.streamKey, this.config.consumerGroup, this.config.consumerName,
        minIdleMs, '0-0', 'COUNT', this.config.batchSize,
      );

      const messages = result[1] as Array<[string, string[]]>;
      if (messages.length > 0) {
        logger.info('Claimed stale pending messages', { count: messages.length, minIdleMs });
      }

      const parsed: RedisDeviceEntry[] = [];

      for (const [id, fields] of messages) {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];

        if (fieldMap.compressed === '1') {
          const payloadRaw = fieldMap.payload;
          if (!payloadRaw) {
            await this.sendDecodeFailureToDlq(
              {
                id,
                data: {
                  deviceUuid: fieldMap.deviceUuid ?? 'unknown',
                  sensorName: fieldMap.sensorName ?? 'unknown',
                  batchId: fieldMap.batchId ?? '',
                  compressedPayload: Buffer.alloc(0),
                  contentEncoding: fieldMap.encoding ?? '',
                  contentType: fieldMap.contentType ?? '',
                } as CompressedDeviceEntry,
                isCompressed: true,
              },
              'Missing compressed payload field (stale PEL claim)',
            );
            continue;
          }

          const payloadBuffer = Buffer.isBuffer(payloadRaw)
            ? payloadRaw
            : fieldMap.payload_b64
              ? Buffer.from(fieldMap.payload_b64, 'base64')
              : Buffer.from(payloadRaw, 'hex');

          if (payloadBuffer.length === 0) {
            await this.sendDecodeFailureToDlq(
              {
                id,
                data: {
                  deviceUuid: fieldMap.deviceUuid ?? 'unknown',
                  sensorName: fieldMap.sensorName ?? 'unknown',
                  batchId: fieldMap.batchId ?? '',
                  compressedPayload: Buffer.alloc(0),
                  contentEncoding: fieldMap.encoding ?? '',
                  contentType: fieldMap.contentType ?? '',
                } as CompressedDeviceEntry,
                isCompressed: true,
              },
              'Empty compressed payload buffer (stale PEL claim)',
            );
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
              contentType: fieldMap.contentType,
            } as CompressedDeviceEntry,
            isCompressed: true,
          });
          continue;
        }

        if (!fieldMap.data) {
          await this.sendDecodeFailureToDlq(
            {
              id,
              data: { deviceUuid: 'unknown', sensorName: 'unknown', timestamp: new Date().toISOString(), data: null, metadata: {} } as DeviceDataEntry,
              isCompressed: false,
            },
            'Missing data field in uncompressed stream entry (stale PEL claim)',
          );
          continue;
        }

        try {
          parsed.push({ id, data: JSON.parse(fieldMap.data) });
        } catch (parseErr: any) {
          await this.sendDecodeFailureToDlq(
            {
              id,
              data: { deviceUuid: 'unknown', sensorName: 'unknown', timestamp: new Date().toISOString(), data: null, metadata: {} } as DeviceDataEntry,
              isCompressed: false,
            },
            `JSON parse failed in uncompressed entry: ${parseErr?.message ?? 'unknown'} (raw prefix: ${fieldMap.data?.substring(0, 200) ?? ''})`,
          );
        }
      }

      return parsed;
    } catch (err: any) {
      if (err.message?.includes('unknown command')) {
        logger.warn('XAUTOCLAIM not supported (Redis <6.2), skipping stale message recovery');
        return [];
      }
      logger.error('Failed to claim stale messages', { error: err.message });
      return [];
    }
  }

  private async resolveEntryData(entry: RedisDeviceEntry): Promise<DeviceDataEntry[] | null> {
    if (!entry.isCompressed) {
      const data = entry.data as DeviceDataEntry | DeviceDataEntry[];
      return Array.isArray(data) ? data : [data];
    }

    const compressed = entry.data as CompressedDeviceEntry;
    if (!compressed.compressedPayload || compressed.compressedPayload.length === 0) {
      this.logEntryError('Compressed entry has empty payload, moving to DLQ', entry, null);
      await this.sendDecodeFailureToDlq(entry, 'Empty or missing compressed payload');
      return null;
    }

    try {
      return await decompressAndParseSensors(
        compressed.compressedPayload,
        compressed.contentEncoding,
        compressed.deviceUuid,
        compressed.sensorName,
      );
    } catch (err: any) {
      this.logEntryError('Failed to decompress sensor entry, moving to DLQ', entry, err);
      await this.sendDecodeFailureToDlq(entry, `Decompression failed: ${err.message}`);
      return null;
    }
  }

  private logBatchSuccess(entries: RedisDeviceEntry[], allData: DeviceDataEntry[], startTime: number): void {
    const duration = Date.now() - startTime;
    const now = Date.now();

    // Compute queue dwell time from the Redis Stream entry IDs (<unix-ms>-<sequence>).
    // maxDwellMs is the most operationally significant value: it shows whether the
    // worker is falling behind on the oldest messages in the batch.
    const dwellTimes = entries.map(e => now - this.ingestedAtMs(e.id));
    const maxDwellMs = Math.max(...dwellTimes);
    const avgDwellMs = Math.round(dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length);
    metrics.recordDwellLatency(maxDwellMs);

    const compressedCount = entries.filter(e => e.isCompressed).length;
    logger.debug('Processed device data batch from Redis', {
      totalReadings: entries.length,
      compressedEntries: compressedCount,
      legacyEntries: entries.length - compressedCount,
      agents: new Set(allData.map(d => d.deviceUuid)).size,
      sensors: new Set(allData.map(d => `${d.deviceUuid}/${d.sensorName}`)).size,
      durationMs: duration,
      readingsPerSecond: Math.round((entries.length / duration) * 1000),
      maxDwellMs,
      avgDwellMs,
    });
  }

  /**
   * ACK a set of stream entry IDs via a pipeline.
   *
   * Using pipeline.exec() instead of direct redis.xack() lets us combine multiple
   * logical ACK groups (e.g. alreadySeen + pendingAck) into a single network round
   * trip. Redis XACK already accepts N IDs in one command, so a single call here is
   * still one RTT — the gain is when two groups are merged into one exec().
   */
  private async xackBatch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const pl = this.redis.pipeline();
    pl.xack(this.config.streamKey, this.config.consumerGroup, ...ids);
    await pl.exec();
  }

  private async processBatch(entries: RedisDeviceEntry[]): Promise<void> {
    const startTime = Date.now();

    // Suppress in-process redeliveries: collect IDs but do NOT send immediately.
    // Deferring lets us merge this ACK with the pendingAck ACK into a single
    // pipeline flush, saving one RTT on any batch that contains both sets.
    const fresh: RedisDeviceEntry[] = [];
    const alreadySeenIds: string[] = [];
    for (const entry of entries) {
      if (this.messageTracker.has(entry.id)) {
        alreadySeenIds.push(entry.id);
      } else {
        fresh.push(entry);
      }
    }
    if (alreadySeenIds.length > 0) {
      logger.debug('Skipping already-processed message IDs (in-process redelivery)', { count: alreadySeenIds.length });
    }
    if (fresh.length === 0) {
      // Nothing new to process — ACK the duplicates and exit.
      await this.xackBatch(alreadySeenIds);
      return;
    }

    // pendingAck tracks only entries whose data was successfully decoded and need DB write.
    // Entries where resolveEntryData returns null were decode failures already moved to the
    // DLQ (which performs XACK internally) — must NOT be passed to handleBatchFailures or re-XACK'd.
    const pendingAck: RedisDeviceEntry[] = [];
    const allData: DeviceDataEntry[] = [];

    for (const entry of fresh) {
      const data = await this.resolveEntryData(entry);
      if (data !== null) {
        pendingAck.push(entry);
        allData.push(...data);
      }
    }

    if (allData.length === 0) {
      // All entries were either decode-failures (moved to DLQ) or produced empty payloads.
      // Merge alreadySeen + empty-payload pendingAck into one pipeline flush — one RTT covers both.
      const toAck = [...alreadySeenIds, ...pendingAck.map(e => e.id)];
      await this.xackBatch(toAck);
      if (pendingAck.length > 0) {
        this.messageTracker.markAll(pendingAck.map(e => e.id));
        logger.debug('ACK\'d entries that decoded to empty data payloads', { count: pendingAck.length });
      }
      return;
    }

    try {
      await this.inserter.insertBatch(allData);
      // XACK only after successful DB write — the core at-least-once guarantee.
      // Merge alreadySeen + pendingAck into one pipeline flush — one RTT covers both.
      const toAck = [...alreadySeenIds, ...pendingAck.map(e => e.id)];
      await this.xackBatch(toAck);
      this.messageTracker.markAll(pendingAck.map(e => e.id));
      this.logBatchSuccess(pendingAck, allData, startTime);
    } catch (err: any) {
      // ACK alreadySeen independently — those entries are definitively done regardless of
      // whether this batch's DB insert failed. pendingAck remains in the PEL for retry.
      await this.xackBatch(alreadySeenIds);
      logger.error('Failed to process sensor data batch', { count: pendingAck.length, error: err.message });
      // Only retry entries that actually attempted a DB write — not decode-failures already disposed above
      await this.handleBatchFailures(pendingAck, err);
    }
  }

  private async handleBatchFailures(entries: RedisDeviceEntry[], err: any): Promise<void> {
    for (const entry of entries) {
      try {
        const attempts = await incrementFailureCount(this.redis, entry.id);
        if (attempts >= this.config.maxRetries) {
          await moveToDLQ(
            this.redis,
            this.config.streamKey, this.config.consumerGroup, this.config.dlqStreamKey,
            this.config.maxDlqLength,
            entry, err.message, attempts,
          );
        } else {
          logger.debug('Message retry scheduled', {
            messageId: entry.id,
            attempts,
            maxRetries: this.config.maxRetries,
          });
        }
      } catch (dlqErr: any) {
        logger.error('Failed to handle message failure', { messageId: entry.id, error: dlqErr.message });
      }
    }
  }

}

