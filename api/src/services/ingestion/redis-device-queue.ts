import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { getRedisIngestion, getRedisConsumer } from '../../redis/client-factory';
import {
  agentDevicesIngestionStreamKey,
  agentDevicesReadyStreamKey,
  agentDevicesDlqStreamKey,
  getTenantId,
  consumerGroupName,
  consumerName as makeConsumerName,
} from '../../redis/tenant-keys';
import { DeviceDataEntry, CompressedDeviceEntry, AddOutcome } from './types';

/**
 * Stable, globally unique identity for this process/pod.
 *
 * Priority:
 *   1. HOSTNAME env var — Kubernetes sets this to the pod name (e.g. "api-7d9f8b-xk2pq"),
 *      which is unique across the entire cluster for the lifetime of the pod.
 *   2. Fallback: crypto UUID — guarantees uniqueness when running outside K8s
 *      (local dev, Docker Compose, bare-metal) where HOSTNAME may equal the
 *      machine hostname shared by multiple processes.
 *
 * Computed once at module load so all RedisDeviceQueue instances (and the
 * initialize() re-entry path) always use the same value, preventing orphaned
 * consumer entries in the Redis consumer group.
 */
const POD_IDENTITY: string = (() => {
  const hostname = process.env.HOSTNAME?.trim();
  // Reject generic single-word hostnames (e.g. bare "api" or "localhost") that
  // Docker Compose or local dev might produce — they are NOT unique per instance.
  const isUniqueHostname = hostname && hostname.length > 0 && /[-_.]/.test(hostname);
  const identity = isUniqueHostname ? hostname : randomUUID();
  logger.debug('Redis consumer identity established', {
    identity,
    source: isUniqueHostname ? 'HOSTNAME' : 'uuid-fallback',
  });
  return identity;
})();
import { metrics } from './metrics';
import { circuitBreaker, CircuitState } from './circuit-breaker';
import { DiskSpool } from './disk-spool';
import { FAILURE_TRACKING_KEY } from './dlq';
import { RedisPipeline } from './pipeline';
import { RedisQueueConsumer } from './worker';
import { RedisQueueProducer } from './producer';
import { ReadingInserter } from './reading-inserter';

const DEVICE_WRITER_GROUP_SUFFIX =
  process.env.REDIS_DEVICE_CONSUMER_GROUP_SUFFIX
  || 'device-writers';

function readIntEnv(key: string, fallback: string): number {
  return parseInt(process.env[key] || fallback, 10);
}

function readFloatEnv(key: string, fallback: string): number {
  return parseFloat(process.env[key] || fallback);
}

export class RedisDeviceQueue {
  private redisIngestion: Redis;
  private redisConsumer: Redis;

  private tenantId: string;
  private consumerGroup: string;
  private consumerName: string;

  private get streamKey(): string { return agentDevicesIngestionStreamKey(this.resolveTenantId()); }
  private get processingStreamKey(): string { return agentDevicesReadyStreamKey(this.resolveTenantId()); }
  private get dlqStreamKey(): string { return agentDevicesDlqStreamKey(this.resolveTenantId()); }

  private readonly maxRetries: number;
  private readonly workerCount: number;
  private readonly batchSize: number;
  private readonly blockTimeMs: number;
  private readonly maxStreamLength: number;
  private readonly maxDlqLength: number;
  private readonly dbWaitingHighWatermark: number;
  private readonly dbSaturationHighWatermarkPct: number;
  private readonly backpressureSleepMs: number;
  private readonly minWorkers: number;
  private readonly maxWorkers: number;
  private readonly lagTargetMs: number;
  private readonly lagScaleUpMs: number;
  private readonly lagCriticalMs: number;
  private readonly lagScaleDownStableChecks: number;
  private readonly scaleCooldownMs: number;
  private readonly dbScaleUpBlockSaturationPct: number;
  private readonly idleTrimStreamLength: number;
  private readonly redisStreamHighWatermarkPct: number;
  private readonly redisMemoryHighWatermarkPct: number;

  private readonly pipeline: RedisPipeline;
  private readonly diskSpool: DiskSpool;
  private readonly producer: RedisQueueProducer;
  private readonly inserter: ReadingInserter;
  private worker: RedisQueueConsumer | null = null;
  private isRunning = false;
  private healthCollector: NodeJS.Timeout | null = null;

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  constructor(tenantId?: string) {
    this.redisIngestion = getRedisIngestion();
    this.redisConsumer = getRedisConsumer();

    this.tenantId = tenantId || '';
    if (this.tenantId) {
      this.consumerGroup = consumerGroupName(this.tenantId, DEVICE_WRITER_GROUP_SUFFIX);
      this.consumerName = makeConsumerName(this.tenantId, POD_IDENTITY);
    } else {
      this.consumerGroup = DEVICE_WRITER_GROUP_SUFFIX;
      this.consumerName = POD_IDENTITY;
    }

    this.workerCount = readIntEnv('DEVICE_WORKER_COUNT', '2');
    this.maxRetries = readIntEnv('DEVICE_MAX_RETRIES', '3');
    this.batchSize = readIntEnv('DEVICE_BATCH_SIZE', '100');
    this.blockTimeMs = readIntEnv('DEVICE_FLUSH_INTERVAL_MS', '2000');
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
    this.idleTrimStreamLength = Math.max(
      0,
      Math.min(
        this.maxStreamLength,
        parseInt(process.env.REDIS_IDLE_INGESTION_STREAM_MAXLEN || String(this.maxStreamLength), 10),
      ),
    );
    this.maxDlqLength = parseInt(process.env.REDIS_DLQ_MAXLEN || '1000', 10);
    this.minWorkers = readIntEnv('DEVICE_AUTOSCALE_MIN_WORKERS', '1');
    this.maxWorkers = readIntEnv('DEVICE_AUTOSCALE_MAX_WORKERS', '20');
    this.lagTargetMs = readIntEnv('DEVICE_AUTOSCALE_LAG_TARGET_MS', '10000');
    this.lagScaleUpMs = readIntEnv('DEVICE_AUTOSCALE_LAG_SCALE_UP_MS', '30000');
    this.lagCriticalMs = readIntEnv('DEVICE_AUTOSCALE_LAG_CRITICAL_MS', '60000');
    this.lagScaleDownStableChecks = readIntEnv('DEVICE_AUTOSCALE_SCALE_DOWN_STABLE_CHECKS', '3');
    this.scaleCooldownMs = readIntEnv('DEVICE_AUTOSCALE_COOLDOWN_MS', '30000');
    this.dbScaleUpBlockSaturationPct = readIntEnv('DEVICE_AUTOSCALE_DB_BLOCK_PCT', '80');
    this.dbWaitingHighWatermark = readIntEnv('DEVICE_DB_WAITING_HIGH_WATERMARK', '10');
    this.dbSaturationHighWatermarkPct = readIntEnv('DEVICE_DB_SATURATION_HIGH_WATERMARK_PCT', '85');
    this.backpressureSleepMs = readIntEnv('DEVICE_DB_BACKPRESSURE_SLEEP_MS', '250');
    // Redis pressure thresholds: fraction of MAXLEN and % of maxmemory that trigger autoscale warning
    this.redisStreamHighWatermarkPct = readFloatEnv('REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT', '0.8');
    this.redisMemoryHighWatermarkPct = parseInt(process.env.REDIS_MEMORY_HIGH_WATERMARK_PCT || '75', 10);

    this.pipeline = new RedisPipeline(this.redisIngestion, {
      onPersistentOomFailure: (dropped) => {
        // Force the circuit open so producers route subsequent writes to disk spool
        // instead of retrying Redis while it remains at maxmemory
        for (let i = 0; i < 5; i++) circuitBreaker.recordFailure();
        metrics.messagesDropped += dropped;
        logger.error('Redis OOM: pipeline retries exhausted, circuit forced OPEN', {
          dropped, totalDropped: metrics.messagesDropped,
        });
      },
    });

    const spoolPath = process.env.DISK_SPOOL_PATH || '/tmp/iotistic-spool';
    const spoolMaxSizeMb = parseInt(process.env.DISK_SPOOL_MAX_SIZE_MB || '1000', 10);
    this.diskSpool = new DiskSpool(spoolPath, spoolMaxSizeMb);

    this.producer = new RedisQueueProducer(
      this.redisIngestion,
      this.pipeline,
      this.diskSpool,
      () => this.streamKey,
      this.maxStreamLength,
    );
    this.inserter = new ReadingInserter();

    if (process.env.DISK_SPOOL_ENABLED === 'true') {
      this.diskSpool.initialize()
        .then(() => this.diskSpool.startReplayer(
          data => this.producer.addInternal(data, true),
          () => this.producer.isClientReady(),
        ))
        .catch(err => logger.error('Failed to initialize disk spool', { error: err.message }));
    }

    this.redisIngestion.on('error', (err) => {
      logger.error('Redis device ingestion connection error', { error: err.message });
      metrics.redisConnected = 0;
    });
    this.redisIngestion.on('connect', () => {
      logger.debug('Redis device ingestion connected');
      metrics.redisConnected = 1;
      metrics.redisReconnects++;
    });
    this.redisConsumer.on('error', (err) => {
      logger.error('Redis device consumer connection error', { error: err.message });
    });
    this.redisConsumer.on('connect', () => {
      logger.debug('Redis device consumer connected');
    });
  }

  async addCompressed(entry: CompressedDeviceEntry): Promise<void> {
    return this.producer.addCompressed(entry);
  }

  async add(deviceData: DeviceDataEntry[]): Promise<AddOutcome> {
    return this.producer.add(deviceData);
  }

  /**
   * Create consumer groups (idempotent). Retries with backoff on failure.
   */
  async initialize(): Promise<void> {
    if (!this.tenantId) {
      const resolvedTenantId = this.resolveTenantId();
      this.tenantId = resolvedTenantId;
      this.consumerGroup = consumerGroupName(resolvedTenantId, DEVICE_WRITER_GROUP_SUFFIX);
      // Use POD_IDENTITY — must be the same stable value as the constructor used,
      // otherwise a second call creates a new orphaned consumer in the group.
      this.consumerName = makeConsumerName(resolvedTenantId, POD_IDENTITY);
    }

    const maxAttempts = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.redisConsumer.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
        await this.redisConsumer.xgroup('CREATE', this.processingStreamKey, this.consumerGroup, '0', 'MKSTREAM');
        logger.debug('Created Redis consumer groups for devices', {
          ingestionStream: this.streamKey,
          processingStream: this.processingStreamKey,
          group: this.consumerGroup,
        });
        return;
      } catch (err: any) {
        if (err.message.includes('BUSYGROUP')) {
          logger.debug('Redis consumer groups already exist', { group: this.consumerGroup });
          return;
        }
        lastError = err;
        logger.warn(`Failed to create consumer group (attempt ${attempt}/${maxAttempts})`, {
          error: err.message,
          group: this.consumerGroup,
        });
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
        }
      }
    }

    throw new Error(`Failed to initialize Redis consumer group after ${maxAttempts} attempts: ${lastError?.message}`);
  }

  /**
   * Start background workers that consume the Redis stream and write to the database.
   */
  async startWorker(): Promise<void> {
    if (this.isRunning) {
      logger.debug('Device worker already running');
      return;
    }

    await this.initialize();
    this.isRunning = true;

    this.worker = new RedisQueueConsumer(
      this.redisConsumer,
      {
        streamKey: this.streamKey,
        processingStreamKey: this.processingStreamKey,
        dlqStreamKey: this.dlqStreamKey,
        consumerGroup: this.consumerGroup,
        consumerName: this.consumerName,
        workerCount: this.workerCount,
        minWorkers: this.minWorkers,
        maxWorkers: this.maxWorkers,
        batchSize: this.batchSize,
        blockTimeMs: this.blockTimeMs,
        maxRetries: this.maxRetries,
        maxDlqLength: this.maxDlqLength,
        dbWaitingHighWatermark: this.dbWaitingHighWatermark,
        dbSaturationHighWatermarkPct: this.dbSaturationHighWatermarkPct,
        backpressureSleepMs: this.backpressureSleepMs,
        lagTargetMs: this.lagTargetMs,
        lagScaleUpMs: this.lagScaleUpMs,
        lagCriticalMs: this.lagCriticalMs,
        lagScaleDownStableChecks: this.lagScaleDownStableChecks,
        scaleCooldownMs: this.scaleCooldownMs,
        dbScaleUpBlockSaturationPct: this.dbScaleUpBlockSaturationPct,
        maxStreamLength: this.maxStreamLength,
        redisStreamHighWatermarkPct: this.redisStreamHighWatermarkPct,
        redisMemoryHighWatermarkPct: this.redisMemoryHighWatermarkPct,
      },
      this.inserter,
      () => this.initialize(),
    );

    await this.worker.start();
    this.startHealthCollector();
  }

  async stopWorker(): Promise<void> {
    logger.debug('Stopping Redis device worker...');
    this.isRunning = false;
    this.worker?.stop();
    if (this.healthCollector) {
      clearInterval(this.healthCollector);
      this.healthCollector = null;
    }
    await new Promise(resolve => setTimeout(resolve, 10000));
    await Promise.all([this.redisIngestion.quit(), this.redisConsumer.quit()]);
    logger.debug('Redis device worker stopped');
  }

  /**
   * Polls Redis every 30 seconds to update in-memory metric gauges:
   * - Stream length (proxy for worker lag)
   * - Pending message count (PEL size)
   * - DLQ length
   * - Redis memory used / max (from INFO memory)
   */
  private startHealthCollector(): void {
    const collectInterval = 30_000;

    const collect = async () => {
      try {
        // Stream length (physical XLEN — used for memory pressure tracking)
        const streamLen = await this.redisConsumer.xlen(this.streamKey).catch(() => 0);
        metrics.streamLength = streamLen;

        // Pending entries list (messages delivered but not yet ACK'd)
        const pending = await this.redisConsumer
          .xpending(this.streamKey, this.consumerGroup)
          .catch(() => null);
        const pendingCount = pending ? ((pending as any[])[0] as number) : 0;
        if (pending) metrics.pendingMessages = pendingCount;

        // Consumer-group lag: undelivered entries not yet seen by the group.
        // Using XINFO GROUPS is more accurate than XLEN because XLEN counts
        // already-processed entries that haven't been trimmed yet (e.g. after
        // a load test that bypassed the producer's MAXLEN enforcement).
        let consumerGroupLag = streamLen; // pessimistic fallback
        try {
          const rawGroups = await this.redisConsumer.xinfo('GROUPS', this.streamKey) as unknown[];
          for (const groupData of rawGroups) {
            const pairs = groupData as (string | number)[];
            const nameIdx = pairs.indexOf('name');
            if (nameIdx >= 0 && pairs[nameIdx + 1] === this.consumerGroup) {
              const lagIdx = pairs.indexOf('lag');
              if (lagIdx >= 0) consumerGroupLag = pairs[lagIdx + 1] as number;
              break;
            }
          }
        } catch { /* XINFO GROUPS unsupported or stream absent — keep XLEN fallback */ }
        metrics.workerLag = consumerGroupLag;

        // Auto-trim: when the queue is fully drained, keep only a small retained tail
        // in Redis so acknowledged stream history does not pin memory after overload.
        // If the stream grew beyond the producer cap, trim it back to that cap first.
        const streamFullyDrained = consumerGroupLag === 0 && pendingCount === 0;
        const trimTarget = streamFullyDrained
          ? Math.min(this.maxStreamLength, Math.max(0, this.idleTrimStreamLength))
          : this.maxStreamLength;
        if (streamFullyDrained && streamLen > trimTarget) {
          await this.redisConsumer.xtrim(this.streamKey, 'MAXLEN', String(trimTarget)).catch(() => {});
          metrics.streamLength = trimTarget;
          logger.info('Trimmed drained ingestion stream to retention target', {
            from: streamLen,
            to: trimTarget,
            maxStreamLength: this.maxStreamLength,
            idleTrimStreamLength: this.idleTrimStreamLength,
          });
        }

        // DLQ length
        metrics.dlqLength = await this.redisConsumer.xlen(this.dlqStreamKey).catch(() => 0);

        // Failure tracking hash size
        metrics.failureTrackingCount = await this.redisConsumer.hlen(FAILURE_TRACKING_KEY).catch(() => 0);

        // Redis memory (INFO memory section)
        const memInfo = await this.redisConsumer.info('memory').catch(() => '');
        for (const line of memInfo.split('\r\n')) {
          if (line.startsWith('used_memory:')) {
            metrics.redisMemoryUsedBytes = parseInt(line.split(':')[1], 10) || 0;
          } else if (line.startsWith('maxmemory:')) {
            metrics.redisMemoryMaxBytes = parseInt(line.split(':')[1], 10) || 0;
          }
        }

        logger.debug('Redis health metrics collected', {
          streamLength: metrics.streamLength,
          workerLag: metrics.workerLag,
          pendingMessages: metrics.pendingMessages,
          dlqLength: metrics.dlqLength,
          redisMemoryMb: Math.round(metrics.redisMemoryUsedBytes / 1024 / 1024),
          redisMemoryMaxMb: metrics.redisMemoryMaxBytes
            ? Math.round(metrics.redisMemoryMaxBytes / 1024 / 1024)
            : 'unlimited',
        });
      } catch (err: any) {
        logger.debug('Health metrics collection failed', { error: err.message });
      }
    };

    // Run immediately on start, then on interval
    collect();
    this.healthCollector = setInterval(collect, collectInterval);
  }

  async getIngestionHealth(): Promise<{
    lastProcessedTimestamp: number | null;
    lagMs: number;
    maxDwellMs: number;
    workers: number;
    status: 'healthy' | 'delayed' | 'buffering' | 'offline';
    ingestionHealthy: boolean;
    spoolingActive: boolean;
    backlogSize: number;
    workerLag: number;
    pendingMessages: number;
    streamLength: number;
    dlqLength: number;
    workerCount: number;
    messagesProcessed: number;
    readingsInserted: number;
    messagesDropped: number;
    dwellP95Ms: number;
    batchLatP95Ms: number;
  }> {
    const backlogSize = await this.diskSpool.getBacklogCount();
    const state = circuitBreaker.getState();
    const lagMs = metrics.maxDwellMs;
    const status: 'healthy' | 'delayed' | 'buffering' | 'offline' =
      state !== CircuitState.CLOSED || backlogSize > 0
        ? 'buffering'
        : metrics.redisConnected !== 1
          ? 'offline'
          : lagMs >= this.lagScaleUpMs
            ? 'delayed'
            : 'healthy';

    return {
      lastProcessedTimestamp: metrics.lastProcessedTimestamp,
      lagMs,
      maxDwellMs: metrics.maxDwellMs,
      workers: metrics.workerCount,
      status,
      ingestionHealthy: state === CircuitState.CLOSED && metrics.redisConnected === 1,
      spoolingActive: state !== CircuitState.CLOSED || backlogSize > 0,
      backlogSize,
      workerLag: metrics.workerLag,
      pendingMessages: metrics.pendingMessages,
      streamLength: metrics.streamLength,
      dlqLength: metrics.dlqLength,
      workerCount: metrics.workerCount,
      messagesProcessed: metrics.messagesProcessed,
      readingsInserted: metrics.readingsInserted,
      messagesDropped: metrics.messagesDropped,
      dwellP95Ms: metrics.getDwellLatencyP95(),
      batchLatP95Ms: metrics.getBatchLatencyP95(),
    };
  }

  async getStats() {
    try {
      const info = await this.redisConsumer.xinfo('STREAM', this.streamKey);
      const pending = await this.redisConsumer.xpending(this.streamKey, this.consumerGroup);

      const length = info[1] as number;
      const firstEntry = info[11] as string[];
      const lastEntry = info[13] as string[];

      let dlqLength = 0;
      try {
        const dlqInfo = await this.redisConsumer.xinfo('STREAM', this.dlqStreamKey);
        dlqLength = dlqInfo[1] as number;
      } catch { /* DLQ stream not created yet */ }

      const failureTrackingCount = await this.redisConsumer.hlen(FAILURE_TRACKING_KEY);

      // Parse Redis INFO memory inline for the stats response
      let memoryUsedMb = 0;
      let memoryMaxMb: number | 'unlimited' = 'unlimited';
      try {
        const memInfo = await this.redisConsumer.info('memory');
        for (const line of memInfo.split('\r\n')) {
          if (line.startsWith('used_memory:')) {
            memoryUsedMb = Math.round((parseInt(line.split(':')[1], 10) || 0) / 1024 / 1024);
          } else if (line.startsWith('maxmemory:')) {
            const v = parseInt(line.split(':')[1], 10);
            memoryMaxMb = v > 0 ? Math.round(v / 1024 / 1024) : 'unlimited';
          }
        }
      } catch { /* non-fatal */ }

      return {
        // Stream state
        streamLength: length,
        workerLag: length,
        firstEntryId: firstEntry ? firstEntry[0] : null,
        lastEntryId: lastEntry ? lastEntry[0] : null,
        pendingMessages: pending[0] as number,
        dlqLength,
        failureTrackingCount,
        consumerGroup: this.consumerGroup,
        consumerName: this.consumerName,
        isRunning: this.isRunning,
        workers: {
          configured: this.workerCount,
          current: this.worker?.getCurrentWorkerCount() ?? 0,
          desired: this.worker?.getDesiredWorkerCount() ?? this.workerCount,
          min: this.minWorkers,
          max: this.maxWorkers,
        },
        maxRetries: this.maxRetries,
        maxStreamLength: this.maxStreamLength,
        // Memory
        redis: {
          memoryUsedMb,
          memoryMaxMb,
          memoryUtilizationPct: typeof memoryMaxMb === 'number' && memoryMaxMb > 0
            ? Math.round((memoryUsedMb / memoryMaxMb) * 100)
            : null,
        },
        // Counters from in-process metrics
        counters: {
          messagesDropped: metrics.messagesDropped,
          messagesFailed: metrics.messagesFailed,
          readingsInserted: metrics.readingsInserted,
          redisReconnects: metrics.redisReconnects,
          oomErrors: metrics.oomErrors,
          oomRetries: metrics.oomRetries,
        },
        // Latency percentiles
        latencyP95Ms: {
          batch: metrics.getBatchLatencyP95(),
          insert: metrics.getInsertLatencyP95(),
          /** P95 of max-per-batch queue dwell time: how long messages wait in Redis before processing */
          dwell: metrics.getDwellLatencyP95(),
        },
        maxDwellMs: metrics.maxDwellMs,
        // How long the current oldest stream entry has been waiting (live snapshot).
        // Derived from the Redis Stream ID timestamp — no extra field required.
        streamHeadDwellMs: firstEntry && firstEntry[0]
          ? (() => {
            const ms = parseInt((firstEntry[0] as string).split('-')[0], 10);
            return isNaN(ms) ? null : Date.now() - ms;
          })()
          : null,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }
}

export const redisDeviceQueue = new RedisDeviceQueue();
