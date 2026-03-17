import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { SensorDataEntry, CompressedSensorEntry, RedisSensorEntry } from './types';
import { decompressAndParseSensors } from './decoder';
import { incrementFailureCount, moveToDLQ, startFailureTrackingPruner } from './dlq';
import { ReadingInserter } from './reading-inserter';

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
}

export class RedisQueueConsumer {
  private isRunning = false;

  constructor(
    private readonly redis: Redis,
    private readonly config: WorkerConfig,
    private readonly inserter: ReadingInserter,
    private readonly onReinitialize: () => Promise<void>,
  ) {}

  private short(id?: string): string | undefined {
    return id?.substring(0, 8);
  }

  private logEntryError(msg: string, entry: RedisSensorEntry, err: any): void {
    const data = entry.data as CompressedSensorEntry;
    logger.error(msg, {
      messageId: entry.id,
      deviceUuid: this.short(data.deviceUuid),
      sensorName: data.sensorName,
      error: err?.message ?? err,
    });
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
      logger.error('Error in sensor worker loop', { workerId, error: err.message });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async workerLoop(workerId: number): Promise<void> {
    while (this.isRunning) {
      try {
        const staleEntries = await this.claimStaleMessages();
        if (staleEntries.length > 0) {
          await this.processBatch(staleEntries);
          continue;
        }

        const results = await this.redis.xreadgroup(
          'GROUP', this.config.consumerGroup, this.config.consumerName,
          'COUNT', this.config.batchSize,
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

  private parseStreamMessages(messages: Array<[string, string[]]>): RedisSensorEntry[] {
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
            } as CompressedSensorEntry,
            isCompressed: true,
          };
        }

        return {
          id,
          data: JSON.parse(fieldMap.data) as SensorDataEntry,
          isCompressed: false,
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null) as RedisSensorEntry[];
  }

  /**
   * Claim messages that have been sitting in PENDING for >60s (worker crashed mid-batch).
   * Uses XAUTOCLAIM (Redis >=6.2).
   */
  private async claimStaleMessages(): Promise<RedisSensorEntry[]> {
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

      const parsed: RedisSensorEntry[] = [];

      for (const [id, fields] of messages) {
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];

        if (fieldMap.compressed === '1') {
          const payloadRaw = fieldMap.payload;
          if (!payloadRaw) {
            await this.redis.xack(this.config.streamKey, this.config.consumerGroup, id);
            continue;
          }

          const payloadBuffer = Buffer.isBuffer(payloadRaw)
            ? payloadRaw
            : fieldMap.payload_b64
              ? Buffer.from(fieldMap.payload_b64, 'base64')
              : Buffer.from(payloadRaw, 'hex');

          if (payloadBuffer.length === 0) {
            await this.redis.xack(this.config.streamKey, this.config.consumerGroup, id);
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
            } as CompressedSensorEntry,
            isCompressed: true,
          });
          continue;
        }

        if (!fieldMap.data) {
          await this.redis.xack(this.config.streamKey, this.config.consumerGroup, id);
          continue;
        }

        try {
          parsed.push({ id, data: JSON.parse(fieldMap.data) });
        } catch {
          await this.redis.xack(this.config.streamKey, this.config.consumerGroup, id);
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

  private async resolveEntryData(entry: RedisSensorEntry): Promise<SensorDataEntry[] | null> {
    if (!entry.isCompressed) {
      const data = entry.data as SensorDataEntry | SensorDataEntry[];
      return Array.isArray(data) ? data : [data];
    }

    const compressed = entry.data as CompressedSensorEntry;
    if (!compressed.compressedPayload || compressed.compressedPayload.length === 0) {
      this.logEntryError('Skipping compressed entry with empty payload', entry, null);
      await this.redis.xack(this.config.streamKey, this.config.consumerGroup, entry.id);
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
      this.logEntryError('Failed to decompress sensor entry, skipping', entry, err);
      await this.redis.xack(this.config.streamKey, this.config.consumerGroup, entry.id);
      return null;
    }
  }

  private logBatchSuccess(entries: RedisSensorEntry[], allData: SensorDataEntry[], startTime: number): void {
    const duration = Date.now() - startTime;
    const compressedCount = entries.filter(e => e.isCompressed).length;
    logger.debug('Processed device data batch from Redis', {
      totalReadings: entries.length,
      compressedEntries: compressedCount,
      legacyEntries: entries.length - compressedCount,
      devices: new Set(allData.map(d => d.deviceUuid)).size,
      sensors: new Set(allData.map(d => `${d.deviceUuid}/${d.sensorName}`)).size,
      durationMs: duration,
      readingsPerSecond: Math.round((entries.length / duration) * 1000),
    });
  }

  private async processBatch(entries: RedisSensorEntry[]): Promise<void> {
    const startTime = Date.now();
    try {
      const allData: SensorDataEntry[] = [];
      for (const entry of entries) {
        const data = await this.resolveEntryData(entry);
        if (data !== null) allData.push(...data);
      }

      if (allData.length === 0) return;

      await this.inserter.insertBatch(allData);
      await this.redis.xack(this.config.streamKey, this.config.consumerGroup, ...entries.map(e => e.id));
      this.logBatchSuccess(entries, allData, startTime);
    } catch (err: any) {
      logger.error('Failed to process sensor data batch', { count: entries.length, error: err.message });
      await this.handleBatchFailures(entries, err);
    }
  }

  private async handleBatchFailures(entries: RedisSensorEntry[], err: any): Promise<void> {
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

