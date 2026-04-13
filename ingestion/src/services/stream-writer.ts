import type Redis from 'ioredis';
import { logger } from '../utils/logger';
import { DeviceDataEntry, CompressedDeviceEntry, AddOutcome } from './types';
import { metrics } from './metrics';
import { RedisPipeline } from './pipeline';

export class RedisQueueProducer {
  constructor(
    private readonly redis: Redis,
    private readonly pipeline: RedisPipeline,
    private readonly getStreamKey: () => string,
    private readonly maxStreamLength: number,
  ) {}

  private short(id?: string): string | undefined {
    return id?.substring(0, 8);
  }

  private isRedisReady(): boolean {
    return this.redis.status === 'ready' || this.redis.status === 'connect';
  }

  isClientReady(): boolean {
    return this.isRedisReady();
  }

  private maxlenArgs(len: number): ['MAXLEN', '~', number] {
    return ['MAXLEN', '~', len];
  }

  private logAddResult(count: number, payloadBytes: number, duration: number): void {
    if (duration > 100) {
      logger.debug('Slow Redis write (device batch)', { count, payloadBytes, durationMs: duration });
    } else {
      logger.debug('Added device data to Redis stream', {
        count, payloadBytes, durationMs: duration,
        batchLatencyP95Ms: metrics.getBatchLatencyP95(),
      });
    }
  }

  async addCompressed(entry: CompressedDeviceEntry): Promise<void> {
    try {
      if (!this.isRedisReady()) {
        logger.error('Redis not ready, dropping compressed device entry', {
          deviceUuid: this.short(entry.deviceUuid),
          deviceName: entry.deviceName,
          batchId: entry.batchId,
        });
        metrics.messagesDropped++;
        return;
      }

      const streamKey = this.getStreamKey();
      const payloadPointer = `${entry.deviceUuid}/${entry.batchId}`;
      const payloadSize = entry.compressedPayload.length;

      await this.pipeline.add(p => {
        p.xadd(
          streamKey, ...this.maxlenArgs(this.maxStreamLength), '*',
          'compressed', '1',
          'deviceUuid', entry.deviceUuid,
          'deviceName', entry.deviceName,
          'batchId', entry.batchId,
          'encoding', entry.contentEncoding,
          'contentType', entry.contentType,
          'payloadPointer', payloadPointer,
          'payloadSize', payloadSize.toString(),
        );
      });

      logger.debug('Queued compressed device metadata (pointer-based)', {
        deviceUuid: this.short(entry.deviceUuid),
        deviceName: entry.deviceName,
        batchId: entry.batchId,
        payloadBytes: payloadSize,
        encoding: entry.contentEncoding,
      });
    } catch (err: any) {
      logger.error('Failed to queue compressed device metadata to Redis', {
        deviceUuid: this.short(entry.deviceUuid),
        deviceName: entry.deviceName,
        batchId: entry.batchId,
        error: err.message,
      });
      if (err.message?.includes('OOM')) {
        metrics.messagesDropped++;
      }
    }
  }

  async add(deviceData: DeviceDataEntry[]): Promise<AddOutcome> {
    if (deviceData.length === 0) return 'redis';

    try {
      const startTime = Date.now();

      if (!this.isRedisReady()) {
        logger.debug('Redis not ready', { redisStatus: this.redis.status, count: deviceData.length });
        metrics.messagesDropped += deviceData.length;
        return 'dropped';
      }

      const streamKey = this.getStreamKey();
      const payload = JSON.stringify(deviceData);
      await this.pipeline.add(p => {
        p.xadd(streamKey, ...this.maxlenArgs(this.maxStreamLength), '*', 'data', payload);
      });

      const duration = Date.now() - startTime;
      metrics.recordBatchLatency(duration);
      this.logAddResult(deviceData.length, payload.length, duration);
      return 'redis';
    } catch (err: any) {
      logger.error('Failed to add device data to Redis stream', {
        count: deviceData.length, error: err.message,
      });
      metrics.messagesDropped += deviceData.length;
      return 'dropped';
    }
  }
}
