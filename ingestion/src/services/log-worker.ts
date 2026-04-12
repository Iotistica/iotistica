/**
 * Redis log worker: consumes compressed log batches from the device logs stream
 * and persists them to agent_logs via LogInserter.
 *
 * After each DB insert it publishes to Redis pub/sub so the API's WebSocket
 * manager can forward logs to connected browser clients in real time.
 */

import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import logger from '../utils/logger';
import { getRedisIngestion, getRedisConsumer } from '../redis/client-factory';
import {
  deviceLogsStreamKey,
  consumerGroupName,
  consumerName as makeConsumerName,
  normalizeTenantId,
} from '../redis/tenant-keys';
import { LogInserter, type LogEntry } from './log-inserter';

/**
 * Stable per-pod identity.  Mirrors the pattern in redis-device-queue.ts.
 * Kubernetes sets HOSTNAME to the unique pod name; everywhere else a UUID is used.
 */
const POD_IDENTITY: string = (() => {
  const hostname = process.env.HOSTNAME?.trim();
  const isUnique = hostname && hostname.length > 0 && /[-_.]/.test(hostname);
  return isUnique ? hostname : randomUUID();
})();

const LOG_WRITER_GROUP_SUFFIX = 'log-writers';

interface ResolvedLogStream {
  streamKey: string;
  tenantId: string;
  usedFallback: boolean;
}

function resolveLogStreamKey(): ResolvedLogStream {
  const configured = (process.env.REDIS_LOG_STREAM_KEY || '').trim();
  if (configured) {
    const match = configured.match(/^tenant:\{([^}]+)\}:device:logs$/);
    if (match) {
      return { streamKey: configured, tenantId: normalizeTenantId(match[1]), usedFallback: false };
    }
  }

  const fallbackTenantId = (
    process.env.INGESTION_TENANT_ID
    || process.env.DEVELOPMENT_TENANT_ID
    || process.env.NAMESPACE
    || 'demo'
  ).trim();

  return {
    streamKey: deviceLogsStreamKey(fallbackTenantId),
    tenantId: fallbackTenantId,
    usedFallback: true,
  };
}

interface CompressedStreamEntry {
  id: string;
  deviceUuid: string;
  batchId: string;
  compressedPayload: Buffer;
  contentEncoding: string;
  contentType: string;
}

export class RedisLogWorker {
  private readonly redisConsumer: Redis;
  private readonly redisPublish: Redis;
  private readonly streamKey: string;
  private readonly tenantId: string;
  private readonly consumerGroup: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockTimeMs: number;
  private readonly samplingRate: number;
  private readonly inserter = new LogInserter();
  private isRunning = false;

  constructor() {
    this.redisConsumer = getRedisConsumer();
    this.redisPublish = getRedisIngestion();

    const resolved = resolveLogStreamKey();
    this.streamKey = resolved.streamKey;
    this.tenantId = resolved.tenantId;

    if (resolved.usedFallback) {
      logger.warn('REDIS_LOG_STREAM_KEY not configured; using fallback log stream key', {
        tenantId: this.tenantId,
        streamKey: this.streamKey,
      });
    }

    this.consumerGroup = consumerGroupName(this.tenantId, LOG_WRITER_GROUP_SUFFIX);
    this.consumerName = makeConsumerName(this.tenantId, POD_IDENTITY);
    this.batchSize = parseInt(process.env.LOG_BATCH_SIZE || '50', 10);
    this.blockTimeMs = parseInt(process.env.LOG_FLUSH_INTERVAL_MS || '5000', 10);
    this.samplingRate = parseFloat(process.env.LOG_SAMPLING_RATE || '1.0');

    logger.info('RedisLogWorker constructed', {
      streamKey: this.streamKey,
      consumerGroup: this.consumerGroup,
      consumerName: this.consumerName,
      batchSize: this.batchSize,
      blockTimeMs: this.blockTimeMs,
      samplingRate: this.samplingRate,
    });
  }

  async startWorker(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Log worker already running');
      return;
    }

    await this.initialize();
    this.isRunning = true;

    logger.info('Log worker started', {
      consumer: this.consumerName,
      batchSize: this.batchSize,
    });

    this.workerLoop().catch(err => {
      logger.error('Log worker loop crashed', { error: (err as Error).message, stack: (err as Error).stack });
      this.isRunning = false;
    });
  }

  async stopWorker(): Promise<void> {
    logger.info('Stopping log worker...');
    this.isRunning = false;

    // Give the current BLOCK call time to return before closing Redis connections.
    await new Promise(resolve => setTimeout(resolve, Math.min(this.blockTimeMs + 1000, 6000)));
    await Promise.allSettled([
      this.redisConsumer.quit(),
      this.redisPublish.quit(),
    ]);
    logger.info('Log worker stopped');
  }

  private async initialize(): Promise<void> {
    const maxRetries = 5;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.redisConsumer.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
        logger.info('Created Redis consumer group for logs', {
          stream: this.streamKey,
          group: this.consumerGroup,
        });
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('BUSYGROUP')) {
          logger.info('Log consumer group already exists', { group: this.consumerGroup });
          return;
        }
        logger.warn(`Log consumer group creation failed (attempt ${attempt}/${maxRetries})`, { error: msg });
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
        } else {
          throw new Error(`Failed to init log consumer group after ${maxRetries} attempts: ${msg}`);
        }
      }
    }
  }

  private async workerLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const results = await (this.redisConsumer.xreadgroup(
          'GROUP', this.consumerGroup, this.consumerName,
          'COUNT', this.batchSize,
          'BLOCK', this.blockTimeMs,
          'STREAMS', this.streamKey,
          '>',
        ) as Promise<[string, [string, string[]][]][] | null>);

        if (!results || results.length === 0) continue;

        const [, messages] = results[0];
        const invalidIds: string[] = [];
        const entries: CompressedStreamEntry[] = [];

        for (const [id, fields] of messages) {
          const fieldMap: Record<string, string> = {};
          for (let i = 0; i < fields.length; i += 2) fieldMap[fields[i]] = fields[i + 1];

          if (fieldMap.compressed !== '1') {
            logger.warn('Skipping non-compressed log message (unexpected format)', { messageId: id });
            invalidIds.push(id);
            continue;
          }

          const payloadBase64 = fieldMap.payload_b64;
          if (!payloadBase64) {
            logger.warn('Skipping log message with missing payload_b64', { messageId: id });
            invalidIds.push(id);
            continue;
          }

          entries.push({
            id,
            deviceUuid: fieldMap.deviceUuid,
            batchId: fieldMap.batchId,
            compressedPayload: Buffer.from(payloadBase64, 'base64'),
            contentEncoding: fieldMap.encoding,
            contentType: fieldMap.contentType,
          });
        }

        if (invalidIds.length > 0) {
          await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...invalidIds);
        }

        if (entries.length > 0) {
          await this.processBatch(entries);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NOGROUP')) {
          logger.warn('Log consumer group missing, reinitializing...', { group: this.consumerGroup });
          try {
            await this.initialize();
            continue;
          } catch (initErr: unknown) {
            logger.error('Failed to reinitialize log consumer group', {
              error: initErr instanceof Error ? initErr.message : String(initErr),
            });
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        } else {
          logger.error('Log worker loop error', { error: msg });
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  private async processBatch(entries: CompressedStreamEntry[]): Promise<void> {
    const startTime = Date.now();
    const allLogs: LogEntry[] = [];
    const preAckedIds: string[] = [];

    for (const entry of entries) {
      try {
        const logs = await this.decompressAndParseLogs(entry);
        allLogs.push(...logs);
      } catch (err: unknown) {
        logger.error('Failed to decompress/parse log batch', {
          deviceUuid: entry.deviceUuid.substring(0, 8),
          batchId: entry.batchId,
          encoding: entry.contentEncoding,
          error: err instanceof Error ? err.message : String(err),
        });
        // ACK immediately to prevent infinite redelivery
        preAckedIds.push(entry.id);
      }
    }

    if (allLogs.length === 0) {
      const remaining = entries.map(e => e.id).filter(id => !preAckedIds.includes(id));
      const toAck = [...preAckedIds, ...remaining];
      if (toAck.length > 0) {
        await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...toAck);
      }
      return;
    }

    await this.inserter.insertBatch(allLogs);

    // Publish to Redis pub/sub for the API WebSocket manager
    const logsByDevice = new Map<string, LogEntry[]>();
    for (const log of allLogs) {
      const list = logsByDevice.get(log.deviceUuid) ?? [];
      list.push(log);
      logsByDevice.set(log.deviceUuid, list);
    }

    for (const [deviceUuid, deviceLogs] of logsByDevice) {
      try {
        await this.redisPublish.publish(
          `device:${deviceUuid}:logs`,
          JSON.stringify({ logs: deviceLogs }),
        );
      } catch (err: unknown) {
        logger.error('Failed to publish logs to WebSocket channel', {
          deviceUuid: deviceUuid.substring(0, 8),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ACK all entries (decompress-failed ones are already ACKed above)
    const allIds = entries.map(e => e.id);
    await this.redisConsumer.xack(this.streamKey, this.consumerGroup, ...allIds);

    logger.info('Inserted log batch to DB', {
      logs: allLogs.length,
      agents: logsByDevice.size,
      durationMs: Date.now() - startTime,
    });
  }

  private async decompressAndParseLogs(entry: CompressedStreamEntry): Promise<LogEntry[]> {
    const { createBrotliDecompress, createGunzip, createInflate } = await import('zlib');
    let decompressed: Buffer;

    if (entry.contentEncoding === 'br') {
      const chunks: Buffer[] = [];
      const dec = createBrotliDecompress();
      dec.on('data', (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        dec.on('end', resolve);
        dec.on('error', reject);
        dec.write(entry.compressedPayload);
        dec.end();
      });
      decompressed = Buffer.concat(chunks);
    } else if (entry.contentEncoding === 'gzip') {
      const chunks: Buffer[] = [];
      const dec = createGunzip();
      dec.on('data', (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        dec.on('end', resolve);
        dec.on('error', reject);
        dec.write(entry.compressedPayload);
        dec.end();
      });
      decompressed = Buffer.concat(chunks);
    } else if (entry.contentEncoding === 'deflate') {
      const chunks: Buffer[] = [];
      const dec = createInflate();
      dec.on('data', (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        dec.on('end', resolve);
        dec.on('error', reject);
        dec.write(entry.compressedPayload);
        dec.end();
      });
      decompressed = Buffer.concat(chunks);
    } else {
      // identity / unknown — treat as raw
      decompressed = entry.compressedPayload;
    }

    const text = decompressed.toString('utf8');
    let rawLogs: Record<string, unknown>[];

    if (
      entry.contentType.includes('application/x-ndjson') ||
      entry.contentType.includes('text/plain')
    ) {
      rawLogs = (
        text
          .split('\n')
          .filter(line => line.trim().length > 0)
          .map(line => {
            try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
          })
          .filter((l): l is Record<string, unknown> => l !== null)
      );
    } else {
      const parsed = JSON.parse(text) as unknown;
      rawLogs = Array.isArray(parsed)
        ? (parsed as Record<string, unknown>[])
        : [parsed as Record<string, unknown>];
    }

    const transformed: LogEntry[] = rawLogs
      .map(log => ({
        deviceUuid: entry.deviceUuid,
        serviceName: (log.serviceName as string | undefined)
          ?? ((log.source as Record<string, unknown> | undefined)?.name as string | undefined),
        timestamp: log.timestamp ? new Date(log.timestamp as string) : new Date(),
        message: log.message as string,
        level: (log.level as string | undefined) ?? 'info',
        isSystem: (log.isSystem as boolean | undefined) ?? false,
        isStderr: ((log.isStderr as boolean | undefined) ?? (log.isStdErr as boolean | undefined)) ?? false,
        meta: this.normalizeMeta(
          log.meta as Record<string, unknown> | undefined,
          log.context as Record<string, unknown> | undefined,
        ),
      }))
      .filter(log => {
        if (!log.message || typeof log.message !== 'string' || log.message.trim() === '') {
          logger.warn('Dropping log entry with empty message', {
            deviceUuid: entry.deviceUuid.substring(0, 8),
            batchId: entry.batchId,
          });
          return false;
        }
        return true;
      });

    if (this.samplingRate >= 1.0) return transformed;

    return transformed.filter(log => {
      if (log.level === 'error' || log.level === 'warn' || log.isStderr) return true;
      return Math.random() < this.samplingRate;
    });
  }

  private normalizeMeta(
    meta: Record<string, unknown> | undefined,
    context: Record<string, unknown> | undefined,
  ): Record<string, unknown> | null {
    const isObj = (v: unknown): v is Record<string, unknown> =>
      !!v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(meta) && isObj(context)) return { ...context, ...meta };
    if (isObj(meta)) return meta;
    if (isObj(context)) return context;
    return null;
  }
}

export const redisLogQueue = new RedisLogWorker();
