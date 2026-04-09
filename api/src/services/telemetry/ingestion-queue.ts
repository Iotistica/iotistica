import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { getRedisIngestion } from '../../redis/client-factory';
import { agentDevicesIngestionStreamKey, getTenantId } from '../../redis/tenant-keys';
import type { AddOutcome, DeviceDataEntry } from './types';

export class RedisIngestionQueue {
  private readonly redisIngestion: Redis;
  private readonly maxStreamLength: number;
  private tenantId: string;

  constructor(tenantId?: string) {
    this.redisIngestion = getRedisIngestion();
    this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
    this.tenantId = tenantId || '';
  }

  private resolveTenantId(): string {
    return this.tenantId || getTenantId();
  }

  private get streamKey(): string {
    return agentDevicesIngestionStreamKey(this.resolveTenantId());
  }

  async add(deviceData: DeviceDataEntry[]): Promise<AddOutcome> {
    if (deviceData.length === 0) {
      return 'redis';
    }

    try {
      await this.redisIngestion.xadd(
        this.streamKey,
        'MAXLEN',
        '~',
        this.maxStreamLength,
        '*',
        'data',
        JSON.stringify(deviceData),
      );

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
      return 'dropped';
    }
  }
}

export const redisDeviceQueue = new RedisIngestionQueue();
