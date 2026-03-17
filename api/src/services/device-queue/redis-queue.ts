import Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { getRedisIngestion, getRedisConsumer } from '../../redis/client-factory';
import {
  deviceSensorsIngestionStreamKey,
  deviceSensorsReadyStreamKey,
  deviceSensorsDlqStreamKey,
  getTenantId,
  consumerGroupName,
  consumerName as makeConsumerName,
} from '../../redis/tenant-keys';
import { SensorDataEntry, CompressedSensorEntry } from './types';
import { metrics } from './metrics';
import { DiskSpool } from './disk-spool';
import { FAILURE_TRACKING_KEY } from './dlq';
import { RedisPipeline } from './pipeline';
import { RedisQueueConsumer } from './worker';
import { RedisQueueProducer } from './producer';
import { ReadingInserter } from './reading-inserter';

export class RedisDeviceQueue {
  private redisIngestion: Redis;
  private redisConsumer: Redis;

  private tenantId: string;
  private consumerGroup: string;
  private consumerName: string;

  private get streamKey(): string { return deviceSensorsIngestionStreamKey(this.resolveTenantId()); }
  private get processingStreamKey(): string { return deviceSensorsReadyStreamKey(this.resolveTenantId()); }
  private get dlqStreamKey(): string { return deviceSensorsDlqStreamKey(this.resolveTenantId()); }

  private readonly maxRetries: number;
  private readonly workerCount: number;
  private readonly batchSize: number;
  private readonly blockTimeMs: number;
  private readonly maxStreamLength: number;
  private readonly maxDlqLength: number;

  private readonly pipeline: RedisPipeline;
  private readonly diskSpool: DiskSpool;
  private readonly producer: RedisQueueProducer;
  private readonly inserter: ReadingInserter;
  private worker: RedisQueueConsumer | null = null;
  private isRunning = false;

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  constructor(tenantId?: string) {
    this.redisIngestion = getRedisIngestion();
    this.redisConsumer = getRedisConsumer();

    this.tenantId = tenantId || '';
    const baseWorkerName = `worker-${process.pid}-${Date.now()}`;
    if (this.tenantId) {
      this.consumerGroup = consumerGroupName(this.tenantId, 'sensor-writers');
      this.consumerName = makeConsumerName(this.tenantId, baseWorkerName);
    } else {
      this.consumerGroup = 'sensor-writers';
      this.consumerName = baseWorkerName;
    }

    this.workerCount = parseInt(process.env.SENSOR_WORKER_COUNT || '2', 10);
    this.maxRetries = parseInt(process.env.SENSOR_MAX_RETRIES || '3', 10);
    this.batchSize = parseInt(process.env.SENSOR_BATCH_SIZE || '100', 10);
    this.blockTimeMs = parseInt(process.env.SENSOR_FLUSH_INTERVAL_MS || '2000', 10);
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
    this.maxDlqLength = parseInt(process.env.REDIS_DLQ_MAXLEN || '1000', 10);

    this.pipeline = new RedisPipeline(this.redisIngestion);

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
        .then(() => this.diskSpool.startReplayer(data => this.producer.addInternal(data, true)))
        .catch(err => logger.error('Failed to initialize disk spool', { error: err.message }));
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

  async addCompressed(entry: CompressedSensorEntry): Promise<void> {
    return this.producer.addCompressed(entry);
  }

  async add(sensorData: SensorDataEntry[]): Promise<void> {
    return this.producer.add(sensorData);
  }

  /**
   * Create consumer groups (idempotent). Retries with backoff on failure.
   */
  async initialize(): Promise<void> {
    if (!this.tenantId) {
      const resolvedTenantId = this.resolveTenantId();
      this.tenantId = resolvedTenantId;
      this.consumerGroup = consumerGroupName(resolvedTenantId, 'sensor-writers');
      this.consumerName = makeConsumerName(resolvedTenantId, `worker-${process.pid}-${Date.now()}`);
    }

    const maxAttempts = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.redisConsumer.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
        await this.redisConsumer.xgroup('CREATE', this.processingStreamKey, this.consumerGroup, '0', 'MKSTREAM');
        logger.info('Created Redis consumer groups for sensors', {
          ingestionStream: this.streamKey,
          processingStream: this.processingStreamKey,
          group: this.consumerGroup,
        });
        return;
      } catch (err: any) {
        if (err.message.includes('BUSYGROUP')) {
          logger.info('Redis consumer groups already exist', { group: this.consumerGroup });
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
      logger.warn('Sensor worker already running');
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
        batchSize: this.batchSize,
        blockTimeMs: this.blockTimeMs,
        maxRetries: this.maxRetries,
        maxDlqLength: this.maxDlqLength,
      },
      this.inserter,
      () => this.initialize(),
    );

    await this.worker.start();
  }

  async stopWorker(): Promise<void> {
    logger.info('Stopping Redis sensor worker...');
    this.isRunning = false;
    this.worker?.stop();
    await new Promise(resolve => setTimeout(resolve, 10000));
    await Promise.all([this.redisIngestion.quit(), this.redisConsumer.quit()]);
    logger.info('Redis sensor worker stopped');
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
        maxRetries: this.maxRetries,
      };
    } catch (err: any) {
      return { error: err.message };
    }
  }
}

export const redisSensorQueue = new RedisDeviceQueue();
