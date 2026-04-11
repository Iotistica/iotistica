import type Redis from 'ioredis';
import { logger, pinoLogger } from '../utils/logger';
import { getPoolStats } from '../db/connection';
import { DeviceDataEntry, CompressedDeviceEntry, RawDeviceEntry, RedisDeviceEntry } from './types';
import { decompressAndParseDevices } from './decoder';
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
  minWorkers: number;
  maxWorkers: number;
  batchSize: number;
  blockTimeMs: number;
  maxRetries: number;
  maxDlqLength: number;
  maxStreamLength: number;
  dbWaitingHighWatermark: number;
  dbSaturationHighWatermarkPct: number;
  backpressureSleepMs: number;
  lagTargetMs: number;
  lagScaleUpMs: number;
  lagCriticalMs: number;
  lagScaleDownStableChecks: number;
  scaleCooldownMs: number;
  dbScaleUpBlockSaturationPct: number;
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

interface ParsedStreamFields {
  compressed: boolean;
  payloadRaw?: string;
  payloadBase64?: string;
  payloadPointer?: string;
  deviceUuid?: string;
  deviceName?: string;
  batchId?: string;
  encoding?: string;
  contentType?: string;
  data?: string;
}

const RESOLVE_ENTRY_CONCURRENCY = 8;

/**
 * Tracks recently processed Redis Stream message IDs to suppress in-process redeliveries.
 * Uses insertion-order eviction to bound memory at ~maxSize × ~20 bytes.
 */
class RecentMessageTracker {
  private readonly ids = new Set<string>();
  private readonly queue: string[] = [];
  private queueHead = 0;
  private readonly maxSize: number;

  constructor(maxSize = 50_000) {
    this.maxSize = maxSize;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  markAll(ids: string[]): void {
    for (const id of ids) {
      if (this.ids.has(id)) {
        continue;
      }

      this.ids.add(id);
      this.queue.push(id);

      if (this.queue.length - this.queueHead > this.maxSize) {
        const evicted = this.queue[this.queueHead++];
        if (evicted !== undefined) {
          this.ids.delete(evicted);
        }
      }

      // Compact occasionally so the backing array does not retain a large
      // prefix of already-evicted IDs in long-lived workers.
      if (this.queueHead >= 1024 && this.queueHead * 2 >= this.queue.length) {
        this.queue.splice(0, this.queueHead);
        this.queueHead = 0;
      }
    }
  }
}

export class RedisQueueConsumer {
  private isRunning = false;
  private lastBackpressureLogAtMs = 0;
  private lastRedisPressureLogAtMs = 0;
  private lastScaleAtMs = 0;
  private consecutiveBelowTargetLagChecks = 0;
  private consecutiveFullReads = 0;
  private nextWorkerId = 0;
  private desiredWorkerCount = 0;
  private readonly activeWorkerIds = new Set<number>();
  private readonly retiringWorkerIds = new Set<number>();
  private readonly workerConnections = new Map<number, Redis>();
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

  private isDebugEnabled(): boolean {
    return pinoLogger.isLevelEnabled('debug');
  }

  /**
   * Parse the API-side ingestion timestamp from a Redis Stream entry ID.
   * Stream IDs have the form "<unix-ms>-<sequence>", so the ms component is
   * a free ingestion durability hint that requires no extra stream fields.
   */
  private ingestedAtMs(entryId: string): number {
    const dashIndex = entryId.indexOf('-');
    if (dashIndex <= 0) {
      return Date.now();
    }

    const ms = Number(entryId.slice(0, dashIndex));
    return Number.isNaN(ms) ? Date.now() : ms;
  }

  private logEntryError(msg: string, entry: RedisDeviceEntry, err: any): void {
    const data = entry.data as CompressedDeviceEntry | RawDeviceEntry;
    logger.error(msg, {
      messageId: entry.id,
      deviceUuid: this.short(data.deviceUuid),
      deviceName: data.deviceName ?? 'unknown',
      error: err?.message ?? err,
    });
  }

  private createUnknownUncompressedEntry(id: string): RedisDeviceEntry {
    return {
      id,
      data: {
        rawData: '',
        deviceUuid: 'unknown',
        deviceName: 'unknown',
      },
      isCompressed: false,
    };
  }

  private parseStreamFields(fields: string[]): ParsedStreamFields {
    let compressed = false;
    let payloadRaw: string | undefined;
    let payloadBase64: string | undefined;
    let payloadPointer: string | undefined;
    let deviceUuid: string | undefined;
    let deviceName: string | undefined;
    let batchId: string | undefined;
    let encoding: string | undefined;
    let contentType: string | undefined;
    let data: string | undefined;

    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i];
      const value = fields[i + 1];

      switch (key) {
        case 'compressed':
          compressed = value === '1';
          break;
        case 'payload':
          payloadRaw = value;
          break;
        case 'payload_b64':
          payloadBase64 = value;
          break;
        case 'payloadPointer':
          payloadPointer = value;
          break;
        case 'deviceUuid':
          deviceUuid = value;
          break;
        case 'deviceName':
          deviceName = value;
          break;
        case 'batchId':
          batchId = value;
          break;
        case 'encoding':
          encoding = value;
          break;
        case 'contentType':
          contentType = value;
          break;
        case 'data':
          data = value;
          break;
      }
    }

    return {
      compressed,
      payloadRaw,
      payloadBase64,
      payloadPointer,
      deviceUuid,
      deviceName,
      batchId,
      encoding,
      contentType,
      data,
    };
  }

  private decodeCompressedPayload(parsedFields: ParsedStreamFields): Buffer | null {
    if (parsedFields.payloadBase64) {
      return Buffer.from(parsedFields.payloadBase64, 'base64');
    }

    if (!parsedFields.payloadRaw) {
      return null;
    }

    return Buffer.from(parsedFields.payloadRaw, 'hex');
  }

  /**
   * Route a structurally unrecoverable message to the DLQ instead of silently ACKing it.
   * Uses attempts=0 to distinguish decode failures from DB-retry exhaustion.
   * Strips raw payload bytes before writing to the DLQ stream to avoid bloat.
   */
  private async sendDecodeFailureToDlq(entry: RedisDeviceEntry, reason: string): Promise<void> {
    const data = entry.data as CompressedDeviceEntry | RawDeviceEntry;
    logger.warn('Moving structurally invalid message to DLQ (decode failure, not a transient error)', {
      messageId: entry.id,
      reason,
      deviceUuid: this.short(data.deviceUuid),
      deviceName: data.deviceName ?? 'unknown',
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
      if (this.isDebugEnabled()) {
        logger.debug('Device worker already running');
      }
      return;
    }

    this.isRunning = true;
    this.desiredWorkerCount = this.clampWorkerCount(this.config.workerCount);

    logger.info('Starting Redis device workers', {
      consumer: this.config.consumerName,
      workerCount: this.desiredWorkerCount,
      batchSize: this.config.batchSize,
      blockTimeMs: this.config.blockTimeMs,
    });

    startFailureTrackingPruner(this.redis);

    for (let i = 0; i < this.desiredWorkerCount; i++) {
      this.spawnWorkerLoop();
    }
  }

  stop(): void {
    this.isRunning = false;
    this.retiringWorkerIds.clear();
    this.activeWorkerIds.clear();
    for (const redis of this.workerConnections.values()) {
      redis.disconnect(false);
    }
    this.workerConnections.clear();
    metrics.setWorkerCount(0);
  }

  getCurrentWorkerCount(): number {
    return this.activeWorkerIds.size;
  }

  getRetiringWorkerCount(): number {
    return this.retiringWorkerIds.size;
  }

  private getEffectiveWorkerCount(): number {
    return this.activeWorkerIds.size - this.retiringWorkerIds.size;
  }

  getDesiredWorkerCount(): number {
    return this.desiredWorkerCount;
  }

  private clampWorkerCount(count: number): number {
    return Math.max(this.config.minWorkers, Math.min(this.config.maxWorkers, count));
  }

  private spawnWorkerLoop(): void {
    const workerId = this.nextWorkerId++;
    const workerRedis = this.redis.duplicate();

    this.activeWorkerIds.add(workerId);
    this.workerConnections.set(workerId, workerRedis);
    metrics.setWorkerCount(this.activeWorkerIds.size);
    this.workerLoop(workerId, workerRedis).catch(err => {
      logger.error('Device worker loop crashed', {
        workerId,
        error: err.message,
        stack: err.stack,
      });
    }).finally(() => {
      this.workerConnections.delete(workerId);
      workerRedis.disconnect(false);
      this.activeWorkerIds.delete(workerId);
      this.retiringWorkerIds.delete(workerId);
      metrics.setWorkerCount(this.activeWorkerIds.size);
    });
  }

  private retireOneWorker(): void {
    const workerId = [...this.activeWorkerIds].sort((a, b) => b - a)[0];
    if (workerId !== undefined) {
      this.retiringWorkerIds.add(workerId);
    }
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
      logger.error('Error in device worker loop', {
        workerId,
        error: err.message,
        command: err.command?.name,
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async workerLoop(workerId: number, workerRedis: Redis): Promise<void> {
    while (
      this.isRunning &&
      this.activeWorkerIds.has(workerId) &&
      !this.retiringWorkerIds.has(workerId)
    ) {
      try {
        if (this.shouldBackoffForDbPressure()) {
          metrics.dbBackpressureEvents++;
          await new Promise(resolve => setTimeout(resolve, this.config.backpressureSleepMs));
          continue;
        }

        // Check Redis pressure AFTER DB backpressure — if the DB is already the bottleneck
        // there is no point reading more entries. When DB is healthy, use the uplifted batch
        // size to drain Redis faster under stream or memory pressure.
        const effectiveBatchSize = this.checkRedisPressure();

        const staleEntries = await this.claimStaleMessages(workerRedis);
        if (staleEntries.length > 0) {
          await this.processBatch(staleEntries, workerRedis);
          continue;
        }

        const results = await workerRedis.xreadgroup(
          'GROUP', this.config.consumerGroup, this.config.consumerName,
          'COUNT', effectiveBatchSize,
          'BLOCK', this.config.blockTimeMs,
          'STREAMS', this.config.streamKey, '>',
        );

        if (!results || results.length === 0) {
          this.consecutiveFullReads = 0;
          continue;
        }

        if (this.retiringWorkerIds.has(workerId)) {
          continue;
        }

        const [, messages] = results[0] as [string, Array<[string, string[]]>];
        const now = Date.now();
        const lagEstimateMs = messages[0]?.[0]
          ? Math.max(0, now - this.ingestedAtMs(messages[0][0]))
          : 0;
        if (lagEstimateMs > 0) {
          this.maybeAutoscale(lagEstimateMs);
        }
        this.noteReadPressure(messages.length, effectiveBatchSize);
        const { entries, parseErrors } = this.parseStreamMessages(messages);
        for (const pe of parseErrors) await this.sendDecodeFailureToDlq(pe.entry, pe.reason);
        if (entries.length === 0) continue;

        await this.processBatch(entries, workerRedis);
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
  * Reads from the shared `metrics` object which is refreshed by the 30s health collector.
  * To react faster than that refresh interval, it also uses the worker's own recent
  * XREADGROUP behavior: repeated full reads imply backlog pressure even before metrics catch up.
   *
   * @returns effective batch size to use for this iteration (uplifted under pressure)
   */
  private checkRedisPressure(): number {
    const streamWatermark = Math.floor(
      this.config.maxStreamLength * this.config.redisStreamHighWatermarkPct,
    );
    // Use real consumer-group lag (undelivered entries) rather than XLEN so that
    // a stream full of already-processed entries (e.g. after a direct-Redis load
    // test that bypassed the producer's MAXLEN) doesn't trigger false alarms.
    const streamLen = metrics.streamLength; // physical XLEN, kept for log reporting
    const effectiveBacklog = metrics.workerLag + metrics.pendingMessages;
    const memUsed = metrics.redisMemoryUsedBytes;
    const memMax = metrics.redisMemoryMaxBytes;

    const streamPressure = streamWatermark > 0 && effectiveBacklog >= streamWatermark;
    const memUsedPct = memMax > 0 ? (memUsed / memMax) * 100 : 0;
    const memPressure =
      this.config.redisMemoryHighWatermarkPct > 0 &&
      memMax > 0 &&
      memUsedPct >= this.config.redisMemoryHighWatermarkPct;
    const implicitReadPressure = this.consecutiveFullReads >= 3;

    if (!streamPressure && !memPressure && !implicitReadPressure) {
      return this.config.batchSize;
    }

    const now = Date.now();
    if (now - this.lastRedisPressureLogAtMs > 10_000) {
      this.lastRedisPressureLogAtMs = now;
      const pressureReasons = [
        streamPressure ? 'stream backlog' : null,
        memPressure ? 'memory pressure' : null,
        implicitReadPressure ? 'full-read saturation' : null,
      ].filter((reason): reason is string => reason !== null);
      const hasExplicitRedisPressure = streamPressure || memPressure;
      if (hasExplicitRedisPressure || this.isDebugEnabled()) {
        const logMessage = hasExplicitRedisPressure
          ? `Redis pressure high (${pressureReasons.join(', ')}) — temporarily increasing batch size`
          : `Queue read saturation detected (${pressureReasons.join(', ')}) — temporarily increasing batch size`;
        const logContext = {
          action: 'autoscale_signal',
          streamLength: streamLen,
          effectiveBacklog,
          streamHighWatermark: streamWatermark,
          streamUtilizationPct: streamWatermark > 0 ? Math.round((effectiveBacklog / streamWatermark) * 100) : null,
          memoryUsedMb: Math.round(memUsed / 1024 / 1024),
          memoryMaxMb: memMax > 0 ? Math.round(memMax / 1024 / 1024) : 'unlimited',
          memoryUtilizationPct: memMax > 0 ? Math.round(memUsedPct) : null,
          streamPressure,
          memPressure,
          implicitReadPressure,
          consecutiveFullReads: this.consecutiveFullReads,
          response: 'increasing batch size to drain stream faster',
        };

        if (hasExplicitRedisPressure) {
          logger.warn(logMessage, logContext);
        } else {
          logger.debug(logMessage, logContext);
        }
      }
    }

    // Under pressure, double the batch size (hard cap at 5000) so each XREADGROUP
    // iteration drains more entries without risking decompression memory spikes or
    // DB overload when batchSize is configured large (e.g. 1000 → cap prevents 10,000).
    return Math.min(this.config.batchSize * 2, 5000);
  }

  private noteReadPressure(messageCount: number, requestedCount: number): void {
    if (requestedCount <= 0) {
      this.consecutiveFullReads = 0;
      return;
    }

    if (messageCount >= requestedCount) {
      this.consecutiveFullReads = Math.min(this.consecutiveFullReads + 1, 10);
      return;
    }

    this.consecutiveFullReads = 0;
  }

  private maybeAutoscale(lagMs: number): void {
    const now = Date.now();
    if (now - this.lastScaleAtMs < this.config.scaleCooldownMs) {
      return;
    }

    const currentWorkers = this.getEffectiveWorkerCount();
    if (currentWorkers === 0) {
      return;
    }

    const db = getPoolStats();
    let desiredWorkers = currentWorkers;

    if (lagMs < this.config.lagTargetMs) {
      this.consecutiveBelowTargetLagChecks += 1;
      if (this.consecutiveBelowTargetLagChecks >= this.config.lagScaleDownStableChecks) {
        desiredWorkers = Math.max(this.config.minWorkers, currentWorkers - 1);
      }
    } else if (lagMs > this.config.lagCriticalMs) {
      this.consecutiveBelowTargetLagChecks = 0;
      const scaleFactor = this.config.lagTargetMs > 0 ? lagMs / this.config.lagTargetMs : 1;
      const increment = Math.min(3, Math.max(1, Math.ceil(scaleFactor)));
      desiredWorkers = Math.min(this.config.maxWorkers, currentWorkers + increment);
    } else if (lagMs > this.config.lagScaleUpMs) {
      this.consecutiveBelowTargetLagChecks = 0;
      desiredWorkers = Math.min(this.config.maxWorkers, currentWorkers + 1);
    } else {
      this.consecutiveBelowTargetLagChecks = 0;
    }

    if (
      desiredWorkers > currentWorkers &&
      db.saturationPct >= this.config.dbScaleUpBlockSaturationPct
    ) {
      if (this.isDebugEnabled()) {
        logger.debug('Skipping worker scale-up because DB saturation is already high', {
          lagMs,
          currentWorkers,
          requestedWorkers: desiredWorkers,
          dbSaturationPct: db.saturationPct,
          dbScaleUpBlockSaturationPct: this.config.dbScaleUpBlockSaturationPct,
        });
      }
      return;
    }

    if (desiredWorkers === currentWorkers) {
      return;
    }

    this.lastScaleAtMs = now;
    this.desiredWorkerCount = desiredWorkers;
    this.consecutiveBelowTargetLagChecks = 0;

    if (desiredWorkers > currentWorkers) {
      for (let i = currentWorkers; i < desiredWorkers; i++) {
        this.spawnWorkerLoop();
      }
    } else {
      for (let i = currentWorkers; i > desiredWorkers; i--) {
        this.retireOneWorker();
      }
    }

    if (this.isDebugEnabled()) {
      logger.debug('Adjusted Redis device worker concurrency based on queue dwell lag', {
        lagMs,
        currentWorkers,
        desiredWorkers,
        consecutiveBelowTargetLagChecks: this.consecutiveBelowTargetLagChecks,
        lagScaleDownStableChecks: this.config.lagScaleDownStableChecks,
        dbSaturationPct: db.saturationPct,
        cooldownMs: this.config.scaleCooldownMs,
        targetMs: this.config.lagTargetMs,
        scaleUpMs: this.config.lagScaleUpMs,
        criticalMs: this.config.lagCriticalMs,
      });
    }
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

  private parseStreamMessages(messages: Array<[string, string[]]>): {
    entries: RedisDeviceEntry[];
    parseErrors: Array<{ entry: RedisDeviceEntry; reason: string }>;
  } {
    const entries: RedisDeviceEntry[] = [];
    const parseErrors: Array<{ entry: RedisDeviceEntry; reason: string }> = [];

    for (const [id, fields] of messages) {
      const parsedFields = this.parseStreamFields(fields);

      if (parsedFields.compressed) {
        const payloadBuffer = this.decodeCompressedPayload(parsedFields);
        if (!payloadBuffer || payloadBuffer.length === 0) {
          const reason = parsedFields.payloadPointer
            ? `Compressed payload pointer is not resolvable by this worker: ${parsedFields.payloadPointer}`
            : 'Missing compressed payload field';
          parseErrors.push({
            entry: {
              id,
              data: {
                deviceUuid: parsedFields.deviceUuid ?? 'unknown',
                deviceName: parsedFields.deviceName ?? 'unknown',
                batchId: parsedFields.batchId ?? '',
                compressedPayload: Buffer.alloc(0),
                contentEncoding: parsedFields.encoding ?? '',
                contentType: parsedFields.contentType ?? '',
              } as CompressedDeviceEntry,
              isCompressed: true,
            },
            reason,
          });
          continue;
        }
        entries.push({
          id,
          data: {
            deviceUuid: parsedFields.deviceUuid,
            deviceName: parsedFields.deviceName,
            batchId: parsedFields.batchId,
            compressedPayload: payloadBuffer,
            contentEncoding: parsedFields.encoding,
            contentType: parsedFields.contentType,
          } as CompressedDeviceEntry,
          isCompressed: true,
        });
        continue;
      }

      // Uncompressed path — guard both missing field and malformed JSON so a single
      // corrupt message cannot throw inside .map() and kill the whole batch.
      if (!parsedFields.data) {
        parseErrors.push({
          entry: this.createUnknownUncompressedEntry(id),
          reason: 'Missing data field in uncompressed stream entry',
        });
        continue;
      }

      entries.push({
        id,
        data: {
          rawData: parsedFields.data,
          deviceUuid: 'unknown',
          deviceName: 'unknown',
        },
        isCompressed: false,
      });
    }

    return { entries, parseErrors };
  }

  /**
   * Claim messages that have been sitting in PENDING for >60s (worker crashed mid-batch).
   * Uses XAUTOCLAIM (Redis >=6.2).
   */
  private async claimStaleMessages(workerRedis: Redis): Promise<RedisDeviceEntry[]> {
    try {
      const minIdleMs = 60000;
      const result = await workerRedis.xautoclaim(
        this.config.streamKey, this.config.consumerGroup, this.config.consumerName,
        minIdleMs, '0-0', 'COUNT', this.config.batchSize,
      );

      const messages = result[1] as Array<[string, string[]]>;
      if (messages.length > 0 && this.isDebugEnabled()) {
        logger.debug('Claimed stale pending messages', { count: messages.length, minIdleMs });
      }

      const parsed: RedisDeviceEntry[] = [];

      for (const [id, fields] of messages) {
        const parsedFields = this.parseStreamFields(fields);

        if (parsedFields.compressed) {
          const payloadBuffer = this.decodeCompressedPayload(parsedFields);
          if (!payloadBuffer || payloadBuffer.length === 0) {
            const reason = parsedFields.payloadPointer
              ? `Compressed payload pointer is not resolvable by this worker: ${parsedFields.payloadPointer}`
              : 'Missing compressed payload field (stale PEL claim)';
            await this.sendDecodeFailureToDlq(
              {
                id,
                data: {
                  deviceUuid: parsedFields.deviceUuid ?? 'unknown',
                  deviceName: parsedFields.deviceName ?? 'unknown',
                  batchId: parsedFields.batchId ?? '',
                  compressedPayload: Buffer.alloc(0),
                  contentEncoding: parsedFields.encoding ?? '',
                  contentType: parsedFields.contentType ?? '',
                } as CompressedDeviceEntry,
                isCompressed: true,
              },
              reason,
            );
            continue;
          }

          parsed.push({
            id,
            data: {
              deviceUuid: parsedFields.deviceUuid,
              deviceName: parsedFields.deviceName,
              batchId: parsedFields.batchId,
              compressedPayload: payloadBuffer,
              contentEncoding: parsedFields.encoding,
              contentType: parsedFields.contentType,
            } as CompressedDeviceEntry,
            isCompressed: true,
          });
          continue;
        }

        if (!parsedFields.data) {
          await this.sendDecodeFailureToDlq(
            this.createUnknownUncompressedEntry(id),
            'Missing data field in uncompressed stream entry (stale PEL claim)',
          );
          continue;
        }

        parsed.push({
          id,
          data: {
            rawData: parsedFields.data,
            deviceUuid: 'unknown',
            deviceName: 'unknown',
          },
          isCompressed: false,
        });
      }

      return parsed;
    } catch (err: any) {
      if (err.message?.includes('unknown command')) {
        if (this.isDebugEnabled()) {
          logger.debug('XAUTOCLAIM not supported (Redis <6.2), skipping stale message recovery');
        }
        return [];
      }
      logger.error('Failed to claim stale messages', { error: err.message });
      return [];
    }
  }

  private async resolveEntryData(entry: RedisDeviceEntry): Promise<DeviceDataEntry[] | null> {
    if (!entry.isCompressed) {
      const data = entry.data as DeviceDataEntry | DeviceDataEntry[] | RawDeviceEntry;
      if ('rawData' in data) {
        try {
          const parsed = JSON.parse(data.rawData) as DeviceDataEntry | DeviceDataEntry[];
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch (err: any) {
          await this.sendDecodeFailureToDlq(
            entry,
            `JSON parse failed: ${err?.message ?? 'unknown'} (raw prefix: ${data.rawData.substring(0, 200)})`,
          );
          return null;
        }
      }
      return Array.isArray(data) ? data : [data];
    }

    const compressed = entry.data as CompressedDeviceEntry;
    if (!compressed.compressedPayload || compressed.compressedPayload.length === 0) {
      this.logEntryError('Compressed entry has empty payload, moving to DLQ', entry, null);
      await this.sendDecodeFailureToDlq(entry, 'Empty or missing compressed payload');
      return null;
    }

    try {
      return await decompressAndParseDevices(
        compressed.compressedPayload,
        compressed.contentEncoding,
        compressed.deviceUuid,
        compressed.deviceName,
      );
    } catch (err: any) {
      this.logEntryError('Failed to decompress device entry, moving to DLQ', entry, err);
      await this.sendDecodeFailureToDlq(entry, `Decompression failed: ${err.message}`);
      return null;
    }
  }

  private async resolveFreshEntries(fresh: RedisDeviceEntry[]): Promise<{
    pendingAck: RedisDeviceEntry[];
    allData: DeviceDataEntry[];
  }> {
    const pendingAck: RedisDeviceEntry[] = [];
    const allData: DeviceDataEntry[] = [];

    for (let i = 0; i < fresh.length; i += RESOLVE_ENTRY_CONCURRENCY) {
      const chunk = fresh.slice(i, i + RESOLVE_ENTRY_CONCURRENCY);
      const resolvedChunk = await Promise.all(
        chunk.map(async (entry) => ({
          entry,
          data: await this.resolveEntryData(entry),
        })),
      );

      for (const resolved of resolvedChunk) {
        if (resolved.data !== null) {
          pendingAck.push(resolved.entry);
          for (let j = 0; j < resolved.data.length; j++) {
            allData.push(resolved.data[j]);
          }
        }
      }
    }

    return { pendingAck, allData };
  }

  private logBatchSuccess(
    entries: RedisDeviceEntry[],
    allData: DeviceDataEntry[],
    startTime: number,
    completedAtMs: number,
    phases?: { resolveMs: number; ackMs: number },
  ): void {
    // Compute queue dwell time from the Redis Stream entry IDs (<unix-ms>-<sequence>).
    // maxDwellMs is the most operationally significant value: it shows whether the
    // worker is falling behind on the oldest messages in the batch.
    const dwellTimes = entries.map(e => completedAtMs - this.ingestedAtMs(e.id));
    const maxDwellMs = Math.max(...dwellTimes);
    const avgDwellMs = Math.round(dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length);
    metrics.recordDwellLatency(maxDwellMs);

    const duration = completedAtMs - startTime;

    logger.info('Inserted batch to DB', {
      messages: entries.length,
      readings: allData.length,
      agents: new Set(allData.map(d => d.deviceUuid)).size,
      durationMs: duration,
      maxDwellMs,
    });

    if (!pinoLogger.isLevelEnabled('debug')) {
      return;
    }

    const compressedCount = entries.filter(e => e.isCompressed).length;
    logger.debug('Processed device data batch from Redis', {
      totalReadings: entries.length,
      compressedEntries: compressedCount,
      legacyEntries: entries.length - compressedCount,
      agents: new Set(allData.map(d => d.deviceUuid)).size,
      devices: new Set(allData.map(d => `${d.deviceUuid}/${d.deviceName}`)).size,
      durationMs: duration,
      resolveMs: phases?.resolveMs,
      ackMs: phases?.ackMs,
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
  private async xackBatch(ids: string[], workerRedis: Redis): Promise<void> {
    if (ids.length === 0) return;
    const pl = workerRedis.pipeline();
    pl.xack(this.config.streamKey, this.config.consumerGroup, ...ids);
    await pl.exec();
  }

  private async processBatch(entries: RedisDeviceEntry[], workerRedis: Redis): Promise<void> {
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
      if (this.isDebugEnabled()) {
        logger.debug('Skipping already-processed message IDs (in-process redelivery)', { count: alreadySeenIds.length });
      }
    }
    if (fresh.length === 0) {
      // Nothing new to process — ACK the duplicates and exit.
      await this.xackBatch(alreadySeenIds, workerRedis);
      return;
    }

    // pendingAck tracks only entries whose data was successfully decoded and need DB write.
    // Entries where resolveEntryData returns null were decode failures already moved to the
    // DLQ (which performs XACK internally) — must NOT be passed to handleBatchFailures or re-XACK'd.
    const resolveStart = Date.now();
    const { pendingAck, allData } = await this.resolveFreshEntries(fresh);
    const resolveMs = Date.now() - resolveStart;
    metrics.recordResolveLatency(resolveMs);

    if (allData.length === 0) {
      // All entries were either decode-failures (moved to DLQ) or produced empty payloads.
      // Merge alreadySeen + empty-payload pendingAck into one pipeline flush — one RTT covers both.
      const toAck = [...alreadySeenIds, ...pendingAck.map(e => e.id)];
      await this.xackBatch(toAck, workerRedis);
      if (pendingAck.length > 0) {
        this.messageTracker.markAll(pendingAck.map(e => e.id));
        if (this.isDebugEnabled()) {
          logger.debug('ACK\'d entries that decoded to empty data payloads', { count: pendingAck.length });
        }
      }
      return;
    }

    try {
      await this.inserter.insertBatch(allData);
      // XACK only after successful DB write — the core at-least-once guarantee.
      // Merge alreadySeen + pendingAck into one pipeline flush — one RTT covers both.
      const toAck = [...alreadySeenIds, ...pendingAck.map(e => e.id)];
      const ackStart = Date.now();
      await this.xackBatch(toAck, workerRedis);
      const ackMs = Date.now() - ackStart;
      const completedAtMs = Date.now();
      metrics.recordAckLatency(ackMs);
      metrics.recordProcessingLatency(completedAtMs - startTime);
      this.messageTracker.markAll(pendingAck.map(e => e.id));
      this.logBatchSuccess(pendingAck, allData, startTime, completedAtMs, { resolveMs, ackMs });
    } catch (err: any) {
      // ACK alreadySeen independently — those entries are definitively done regardless of
      // whether this batch's DB insert failed. pendingAck remains in the PEL for retry.
      await this.xackBatch(alreadySeenIds, workerRedis);
      logger.error('Failed to process device data batch', { count: pendingAck.length, error: err.message });
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
          if (this.isDebugEnabled()) {
            logger.debug('Message retry scheduled', {
              messageId: entry.id,
              attempts,
              maxRetries: this.config.maxRetries,
            });
          }
        }
      } catch (dlqErr: any) {
        logger.error('Failed to handle message failure', { messageId: entry.id, error: dlqErr.message });
      }
    }
  }

}

