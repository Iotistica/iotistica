import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { DeviceDataEntry, CompressedDeviceEntry, AddOutcome } from './types';
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

  isClientReady(): boolean {
    return this.isRedisReady();
  }

  private maxlenArgs(len: number): ['MAXLEN', '~', number] {
    return ['MAXLEN', '~', len];
  }

  private async fallbackToDiskOrDrop(sensorData: DeviceDataEntry[], reason: string): Promise<AddOutcome> {
    if (this.diskSpool.isEnabled()) {
      try {
        await this.diskSpool.spoolToDisk(sensorData);
        logger.warn(`${reason} - spooled to disk`, { count: sensorData.length });
        return 'disk';
      } catch (err: any) {
        // Spool write failed (e.g. EACCES, ENOSPC). Count as dropped so metrics reflect reality.
        metrics.messagesDropped += sensorData.length;
        logger.error(`${reason} - disk spool write failed, data dropped`, {
          count: sensorData.length,
          totalDropped: metrics.messagesDropped,
          error: err.message,
        });
        return 'dropped';
      }
    } else {
      metrics.messagesDropped += sensorData.length;
      logger.error(`${reason} and disk spool disabled - data dropped`, {
        count: sensorData.length, totalDropped: metrics.messagesDropped,
      });
      return 'dropped';
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

  async addCompressed(entry: CompressedDeviceEntry): Promise<void> {
    try {
      if (!circuitBreaker.shouldAllowRequest()) {
        logger.warn('Redis circuit OPEN, spooling compressed batch to disk', {
          deviceUuid: this.short(entry.deviceUuid),
          sensorName: entry.sensorName,
          batchId: entry.batchId,
        });
        // Wrap into a SensorDataEntry so the disk spool can replay it through addInternal()
        await this.fallbackToDiskOrDrop([{
          deviceUuid: entry.deviceUuid,
          sensorName: entry.sensorName,
          data: { _compressedBatchId: entry.batchId },
          timestamp: new Date().toISOString(),
          metadata: {},
        }], 'Redis circuit OPEN (compressed entry)');
        return;
      }

      if (!this.isRedisReady()) {
        circuitBreaker.recordFailure();
        await this.fallbackToDiskOrDrop([{
          deviceUuid: entry.deviceUuid,
          sensorName: entry.sensorName,
          data: { _compressedBatchId: entry.batchId },
          timestamp: new Date().toISOString(),
          metadata: {},
        }], 'Redis not ready (compressed entry)');
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
      circuitBreaker.recordSuccess();
    } catch (err: any) {
      circuitBreaker.recordFailure();
      logger.error('Failed to queue compressed sensor metadata to Redis', {
        deviceUuid: this.short(entry.deviceUuid),
        sensorName: entry.sensorName,
        batchId: entry.batchId,
        error: err.message,
      });
      if (err.message?.includes('OOM')) {
        metrics.messagesDropped++;
      }
    }
  }

  async add(deviceData: DeviceDataEntry[]): Promise<AddOutcome> {
    return this.addInternal(deviceData, false);
  }

  async addInternal(deviceData: DeviceDataEntry[], bypassCircuit = false): Promise<AddOutcome> {
    if (deviceData.length === 0) return 'redis';

    try {
      const startTime = Date.now();

      if (!bypassCircuit && !circuitBreaker.shouldAllowRequest()) {
        return this.fallbackToDiskOrDrop(deviceData, 'Redis circuit OPEN');
      }

      if (!this.isRedisReady()) {
        if (!bypassCircuit) circuitBreaker.recordFailure();
        logger.info('Redis not ready, routing to disk spool', {
          redisStatus: this.redis.status,
          count: deviceData.length,
          circuitState: circuitBreaker.getState?.() ?? 'unknown',
        });
        return this.fallbackToDiskOrDrop(deviceData, 'Redis not ready');
      }

      const streamKey = this.getStreamKey();
      const payload = JSON.stringify(deviceData);
      void this.pipeline.add(p => {
        p.xadd(streamKey, ...this.maxlenArgs(this.maxStreamLength), '*', 'data', payload);
      });

      const duration = Date.now() - startTime;
      metrics.recordBatchLatency(duration);
      if (!bypassCircuit) circuitBreaker.recordSuccess();
      this.logAddResult(deviceData.length, payload.length, duration);
      return 'redis';
    } catch (err: any) {
      if (!bypassCircuit) circuitBreaker.recordFailure();
      if (err.message?.includes('OOM')) {
        logger.error('Redis OOM, routing to fallback', { count: deviceData.length, error: err.message });
        return this.fallbackToDiskOrDrop(deviceData, 'Redis OOM');
      } else {
        logger.error('Failed to add device data to Redis stream', {
          count: deviceData.length, error: err.message,
        });
        return 'dropped';
      }
    }
  }
}
