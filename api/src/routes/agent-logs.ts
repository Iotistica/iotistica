/**
 * Device State Management Routes
 * Handles device target state, current state, and state reporting
 *
 * Device-Side Endpoints (used by agents themselves):
 * - GET  /api/v1/device/:uuid/state - Device polls for target state (ETag cached)
 * - POST /api/v1/device/:uuid/logs - Device uploads logs
 * - PATCH /api/v1/device/state - Device reports current state + metrics
 *
 * Management API Endpoints (used by dashboard/admin):
 * - GET /api/v1/agents/:uuid/target-state - Get device target state
 * - POST /api/v1/agents/:uuid/target-state - Set device target state
 * - PUT /api/v1/agents/:uuid/target-state - Update device target state
 * - GET /api/v1/agents/:uuid/current-state - Get device current state
 * - DELETE /api/v1/agents/:uuid/target-state - Clear device target state
 * - GET /api/v1/agents/:uuid/logs - Get device logs
 * - GET /api/v1/agents/:uuid/metrics - Get device metrics
 */

import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/connection';
import {
  AgentModel,
  DeviceLogsModel,
} from '../db/models';
import { logger } from '../utils/logger';
import deviceAuth from '../middleware/agent-auth';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { redisLogQueue } from '../services/telemetry/publisher';
import { ingestion } from '../services/telemetry';

type AgentUuidParams = {
  uuid: string;
};

type LogsQuerystring = {
  service?: string;
  limit?: string | number;
  offset?: string | number;
  from?: string;
  to?: string;
};

type DroppedLogSummary = {
  totalCount?: number;
  [key: string]: unknown;
};

type DroppedSummariesBody = {
  summaries?: DroppedLogSummary[];
  reportedAt?: string;
};

type RawLogBody = Buffer | string | Record<string, unknown> | unknown[] | null;

let lastIdempotencyOomLogAt = 0;

function isRedisOomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OOM command not allowed');
}

function logIdempotencyOom(context: string, meta: Record<string, unknown>): void {
  const now = Date.now();
  if (now - lastIdempotencyOomLogAt < 10_000) return;
  lastIdempotencyOomLogAt = now;
  logger.warn(`Redis OOM during ${context} - log batch idempotency degraded`, meta);
}

function parsePaginationValue(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function getSingleHeaderValue(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) {
    return header[0];
  }

  return header;
}

function normalizeRawBody(body: RawLogBody): Buffer {
  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (typeof body === 'string') {
    return Buffer.from(body);
  }

  if (body == null) {
    return Buffer.alloc(0);
  }

  return Buffer.from(JSON.stringify(body));
}

function hasGzipHeader(buffer: Buffer): boolean {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
}

function hasZlibHeader(buffer: Buffer): boolean {
  if (buffer.length < 2) {
    return false;
  }

  const cmf = buffer[0];
  const flg = buffer[1];
  return (cmf & 0x0f) === 0x08 && ((cmf << 8) + flg) % 31 === 0;
}

function resolveContentEncoding(body: Buffer, headerValue: string | undefined): string {
  if (!headerValue) {
    return 'identity';
  }

  const normalizedHeader = headerValue.toLowerCase();

  if (normalizedHeader === 'gzip') {
    return hasGzipHeader(body) ? 'gzip' : 'identity';
  }

  if (normalizedHeader === 'deflate') {
    return hasZlibHeader(body) ? 'deflate' : 'identity';
  }

  // Fastify hands route handlers decompressed Brotli payloads in the current setup.
  if (normalizedHeader === 'br') {
    return 'identity';
  }

  return normalizedHeader;
}

async function checkBatchIdempotency(deviceUuid: string, batchId: string): Promise<boolean> {
  try {
    const { redisClient } = await import('../redis/client');
    const client = redisClient.getClient();
    if (!client) {
      logger.warn('Redis client not available for idempotency check');
      return false;
    }
    const key = `batch:${deviceUuid}:${batchId}`;
    const exists = await client.exists(key);
    return exists === 1;
  } catch (error) {
    if (isRedisOomError(error)) {
      logIdempotencyOom('batch idempotency check', { deviceUuid: deviceUuid.substring(0, 8), batchId });
    } else {
      logger.warn('Failed to check batch idempotency (Redis unavailable)', { error });
    }
    return false;
  }
}

async function storeBatchId(deviceUuid: string, batchId: string): Promise<void> {
  try {
    const { redisClient } = await import('../redis/client');
    const client = redisClient.getClient();
    if (!client) {
      logger.warn('Redis client not available for batch storage');
      return;
    }
    const key = `batch:${deviceUuid}:${batchId}`;
    const ttlSeconds = 24 * 60 * 60;
    await client.setex(key, ttlSeconds, Date.now().toString());
    logger.debug('Stored batch ID for idempotency', { deviceUuid: deviceUuid.substring(0, 8), batchId });
  } catch (error) {
    if (isRedisOomError(error)) {
      logIdempotencyOom('batch idempotency store', { deviceUuid: deviceUuid.substring(0, 8), batchId });
    } else {
      logger.warn('Failed to store batch ID (Redis unavailable)', { error });
    }
  }
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: AgentUuidParams; Body: RawLogBody }>('/device/:uuid/logs', {
    preHandler: [deviceAuth],
    bodyLimit: 10 * 1024 * 1024,
  }, async (req, reply) => {
    logger.debug('POST /device/:uuid/logs endpoint hit (raw mode)', { uuid: req.params.uuid });

    try {
      const { uuid } = req.params;
      const batchId = getSingleHeaderValue(req.headers['x-batch-id']);
      const batchAttempt = Number.parseInt(getSingleHeaderValue(req.headers['x-batch-attempt']) || '1', 10);

      if (batchId) {
        const isDuplicate = await checkBatchIdempotency(uuid, batchId);
        if (isDuplicate) {
          logger.info('Duplicate batch detected, skipping', {
            uuid: uuid.substring(0, 8),
            batchId,
            attempt: batchAttempt
          });
          return reply.status(200).send({
            batchId,
            accepted: true,
            duplicate: true
          });
        }
      }

      const device = await AgentModel.getOrCreate(uuid);
      if (!device) {
        logger.warn('Log upload from unregistered device - rejecting', {
          deviceUuid: `${uuid.substring(0, 8)}...`,
        });
        return reply.status(404).send({
          error: 'Device not registered',
          message: 'Please complete device registration before uploading logs'
        });
      }

      const contentType = getSingleHeaderValue(req.headers['content-type']) || 'application/x-ndjson';
      const finalPayload = normalizeRawBody(req.body);
      const contentEncodingHeader = getSingleHeaderValue(req.headers['content-encoding']);
      const finalEncoding = resolveContentEncoding(finalPayload, contentEncodingHeader);

      logger.info('Queueing log payload', {
        uuid: uuid.substring(0, 8),
        batchId,
        encoding: finalEncoding,
        compressedBytes: finalPayload.length
      });

      ingestion.add('logs', {
        deviceUuid: uuid,
        batchId: batchId || `auto-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        compressedPayload: finalPayload,
        contentEncoding: finalEncoding,
        contentType
      }).catch((err: Error) => {
        logger.error('Failed to queue logs to Redis (async)', {
          uuid: uuid.substring(0, 8),
          batchId,
          error: err.message
        });
      });

      if (batchId) {
        await storeBatchId(uuid, batchId);
      }

      return reply.status(202).send({
        batchId: batchId || 'auto-generated',
        accepted: true,
        queued: true
      });
    } catch (error: any) {
      logger.error('Error queueing logs', {
        error: error.message,
        stack: error.stack,
        uuid: req.params.uuid?.substring(0, 8),
        bodySize: normalizeRawBody(req.body).length
      });
      return reply.status(500).send({
        error: 'Failed to queue logs',
        message: error.message
      });
    }
  });

  fastify.post<{ Params: AgentUuidParams; Body: DroppedSummariesBody }>('/device/:uuid/logs/dropped-summaries', {
    preHandler: [deviceAuth],
  }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { summaries, reportedAt } = req.body;

      logger.info('Received dropped log summaries', {
        uuid: uuid.substring(0, 8),
        reportedAt,
        summaryCount: summaries?.length || 0,
        totalDropped: summaries?.reduce((sum, summary) => sum + (summary.totalCount || 0), 0) || 0
      });

      return reply.send({
        status: 'ok',
        received: summaries?.length || 0,
        message: 'Summaries received and logged'
      });
    } catch (error: any) {
      logger.error('Error processing dropped log summaries', { error: error.message });
      return reply.status(500).send({
        error: 'Failed to process dropped log summaries',
        message: error.message
      });
    }
  });

  fastify.get<{ Params: AgentUuidParams; Querystring: LogsQuerystring }>('/agents/:uuid/logs', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const serviceName = req.query.service;
      const limit = parsePaginationValue(req.query.limit, 1000);
      const offset = parsePaginationValue(req.query.offset, 0);
      const from = req.query.from;
      const to = req.query.to;

      const filterOptions: {
        serviceName?: string;
        limit: number;
        offset: number;
        since?: Date;
      } = {
        serviceName,
        limit,
        offset,
      };

      if (from) {
        filterOptions.since = new Date(from);
      }

      const logs = await DeviceLogsModel.get(uuid, filterOptions);

      let filteredLogs = logs;
      if (to) {
        const toDate = new Date(to);
        toDate.setHours(23, 59, 59, 999);
        filteredLogs = logs.filter((log) => new Date(log.timestamp) <= toDate);
      }

      return reply.send({
        count: filteredLogs.length,
        logs: filteredLogs,
      });
    } catch (error: any) {
      logger.error('Error getting logs', { error: error.message });
      return reply.status(500).send({
        error: 'Failed to get logs',
        message: error.message
      });
    }
  });

  fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/logs/services', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;

      const result = await query<{ service_name: string }>(
        'SELECT DISTINCT service_name FROM agent_logs WHERE agent_uuid = $1 ORDER BY service_name ASC',
        [uuid]
      );

      const services = result.rows.map((row) => row.service_name);

      return reply.send({
        services,
      });
    } catch (error: any) {
      logger.error('Error getting log services', { error: error.message });
      return reply.status(500).send({
        error: 'Failed to get log services',
        message: error.message
      });
    }
  });

  fastify.get('/admin/log-queue/stats', { preHandler: [jwtAuth, requireRole('admin')] }, async (_req, reply) => {
    try {
      const stats = await redisLogQueue.getStats();
      return reply.send(stats);
    } catch (error: any) {
      logger.error('Error getting log queue stats', { error: error.message });
      return reply.status(500).send({
        error: 'Failed to get log queue stats',
        message: error.message
      });
    }
  });

};

export default plugin;
