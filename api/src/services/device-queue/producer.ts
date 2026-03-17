import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { SensorDataEntry, CompressedSensorEntry } from './types';
import { metrics } from './metrics';
import { circuitBreaker } from './circuit-breaker';
import { DiskSpool } from './disk-spool';
import { RedisPipeline } from './pipeline';

export class RedisQueueProducer {
  constructor(
    private readonly redis: Redis,
    private readonly pipeline: RedisPipeline,
    private readonly diskSpool: DiskSpool,
    private readonly getStreamKey: () => string,
    private readonly maxStreamLength: number,
  ) {}

  private short(id?: string): string | undefined {
    return id?.substring(0, 8);
  }

  private isRedisReady(): boolean {
    return this.redis.status === 'ready' || this.redis.status === 'connect';
  }

  private maxlenArgs(len: number): ['MAXLEN', '~', number] {
    return ['MAXLEN', '~', len];
  }

  private async fallbackToDiskOrDrop(sensorData: SensorDataEntry[], reason: string): Promise<void> {
    if (this.diskSpool.isEnabled()) {
      await this.diskSpool.spoolToDisk(sensorData);
      logger.warn(`${reason} - spooled to disk`, { count: sensorData.length });
    } else {
      metrics.messagesDropped += sensorData.length;
      logger.error(`${reason} and disk spool disabled - data dropped`, {
        count: sensorData.length, totalDropped: metrics.messagesDropped,
      });
    }
  }

  private logAddResult(count: number, payloadBytes: number, duration: number): void {
    if (duration > 100) {
      logger.warn('Slow Redis write (sensor batch)', { count, payloadBytes, durationMs: duration });
    } else {
      logger.debug('Added device data to Redis stream', {
        count, payloadBytes, durationMs: duration,
        batchLatencyP95Ms: metrics.getBatchLatencyP95(),
      });
    }
  }

  async addCompressed(entry: CompressedSensorEntry): Promise<void> {
    try {
      if (!this.isRedisReady()) {
        logger.error('Redis ingestion not ready, dropping compressed device batch', {
          status: this.redis.status,
          deviceUuid: this.short(entry.deviceUuid),
          sensorName: entry.sensorName,
          batchId: entry.batchId,
          compressedBytes: entry.compressedPayload.length,
        });
        metrics.messagesDropped++;
        return;
      }

      const streamKey = this.getStreamKey();
      const payloadPointer = `${entry.deviceUuid}/${entry.batchId}`;
      const payloadSize = entry.compressedPayload.length;

      void this.pipeline.add(p => {
        p.xadd(
          streamKey, ...this.maxlenArgs(this.maxStreamLength), '*',
          'compressed', '1',
          'deviceUuid', entry.deviceUuid,
          'sensorName', entry.sensorName,
          'batchId', entry.batchId,
          'encoding', entry.contentEncoding,
          'contentType', entry.contentType,
          'payloadPointer', payloadPointer,
          'payloadSize', payloadSize.toString(),
        );
      });

      logger.debug('Queued compressed sensor metadata (pointer-based)', {
        deviceUuid: this.short(entry.deviceUuid),
        sensorName: entry.sensorName,
        batchId: entry.batchId,
        payloadBytes: payloadSize,
        encoding: entry.contentEncoding,
      });
    } catch (err: any) {
      logger.error('Failed to queue compressed sensor metadata to Redis', {
        deviceUuid: this.short(entry.deviceUuid),
        sensorName: entry.sensorName,
        batchId: entry.batchId,
        error: err.message,
      });
    }
  }

  async add(sensorData: SensorDataEntry[]): Promise<void> {
    return this.addInternal(sensorData, false);
  }

  async addInternal(sensorData: SensorDataEntry[], bypassCircuit = false): Promise<void> {
    if (sensorData.length === 0) return;

    try {
      const startTime = Date.now();

      if (!bypassCircuit && !circuitBreaker.shouldAllowRequest()) {
        await this.fallbackToDiskOrDrop(sensorData, 'Redis circuit OPEN');
        return;
      }

      if (!this.isRedisReady()) {
        if (!bypassCircuit) circuitBreaker.recordFailure();
        await this.fallbackToDiskOrDrop(sensorData, 'Redis not ready');
        return;
      }

      const streamKey = this.getStreamKey();
      const payload = JSON.stringify(sensorData);
      void this.pipeline.add(p => {
        p.xadd(streamKey, ...this.maxlenArgs(this.maxStreamLength), '*', 'data', payload);
      });

      const duration = Date.now() - startTime;
      metrics.recordBatchLatency(duration);
      if (!bypassCircuit) circuitBreaker.recordSuccess();
      this.logAddResult(sensorData.length, payload.length, duration);
    } catch (err: any) {
      if (!bypassCircuit) circuitBreaker.recordFailure();
      logger.error('Failed to add device data to Redis stream', {
        count: sensorData.length, error: err.message,
      });
    }
  }
}
