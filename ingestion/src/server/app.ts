import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import logger from '../utils/logger';
import { redisDeviceQueue } from '../services';
import { readingsService, type ReadingExtra } from '../services/readings.service';
import { renderIngestionPrometheusMetrics } from '../services/prometheus';

type InternalReadingInsertPayload = {
  agent_uuid: string;
  metric_name: string;
  value: number;
  unit?: string;
  protocol: string;
  quality?: 'good' | 'fair' | 'poor';
  extra?: ReadingExtra | null;
};

function getRequestId(req: IncomingMessage): string {
  const rawHeader = req.headers['x-request-id'];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return headerValue?.trim() || randomUUID();
}

function assertInternalAuth(requestToken: string | undefined): void {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN?.trim();

  if (!expectedToken) {
    throw new Error('INTERNAL_AUTH_TOKEN must be set for the ingestion service');
  }

  if (!requestToken || requestToken !== expectedToken) {
    const error = new Error('Unauthorized internal request');
    (error as Error & { statusCode?: number }).statusCode = 401;
    throw error;
  }
}

function sendJson(reply: ServerResponse, statusCode: number, body: unknown, requestId?: string): void {
  const payload = JSON.stringify(body);
  reply.statusCode = statusCode;
  reply.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (requestId) {
    reply.setHeader('x-request-id', requestId);
  }
  reply.end(payload);
}

function sendText(reply: ServerResponse, statusCode: number, body: string, requestId?: string): void {
  reply.statusCode = statusCode;
  reply.setHeader('Content-Type', 'text/plain; version=0.0.4');
  if (requestId) {
    reply.setHeader('x-request-id', requestId);
  }
  reply.end(body);
}

function getInternalAuthHeader(req: IncomingMessage): string | undefined {
  const rawHeader = req.headers['x-internal-auth-token'];
  return Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    const bufferChunk = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    chunks.push(bufferChunk);

    const totalBytes = chunks.reduce((sum, item) => sum + item.length, 0);
    if (totalBytes > 1024 * 1024) {
      const error = new Error('Request body too large');
      (error as Error & { statusCode?: number }).statusCode = 413;
      throw error;
    }
  }

  const rawBody = Buffer.concat(chunks).toString('utf-8').trim();
  if (!rawBody) {
    const error = new Error('Request body is required');
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    const error = new Error('Invalid JSON body');
    (error as Error & { statusCode?: number }).statusCode = 400;
    throw error;
  }
}

async function routeRequest(req: IncomingMessage, reply: ServerResponse, requestId: string): Promise<void> {
  const method = req.method || 'GET';
  const url = req.url || '/';

  if (method === 'POST' && url === '/api/v1/readings/internal') {
    try {
      assertInternalAuth(getInternalAuthHeader(req));
      const reading = await readJsonBody<InternalReadingInsertPayload>(req);
      await readingsService.insert({
        agent_uuid: reading.agent_uuid,
        metric_name: reading.metric_name,
        value: reading.value,
        unit: reading.unit,
        protocol: reading.protocol,
        quality: reading.quality,
        extra: reading.extra || {},
      });
      sendJson(reply, 201, { message: 'Reading inserted successfully' }, requestId);
    } catch (error) {
      logger.error('Error inserting reading in ingestion service', {
        error: error instanceof Error ? error.message : String(error),
      });
      const statusCode = error instanceof Error && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) || 500 : 500;
      sendJson(reply, statusCode, { error: statusCode === 401 ? 'Unauthorized' : error instanceof Error ? error.message : 'Internal server error' }, requestId);
    }
    return;
  }

  if (method !== 'GET') {
    sendJson(reply, 405, { error: 'Method not allowed' }, requestId);
    return;
  }

  if (url === '/health') {
    sendJson(reply, 200, {
      status: 'healthy',
      service: 'iotistica-ingestion',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    }, requestId);
    return;
  }

  if (url === '/metrics') {
    sendText(reply, 200, renderIngestionPrometheusMetrics(), requestId);
    return;
  }

  if (url === '/api/v1/metrics/ingestion-health') {
    try {
      assertInternalAuth(getInternalAuthHeader(req));
      sendJson(reply, 200, await redisDeviceQueue.getIngestionHealth(), requestId);
    } catch (error) {
      logger.error('Error getting ingestion health from ingestion service', {
        error: error instanceof Error ? error.message : String(error),
      });
      const statusCode = error instanceof Error && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) || 500 : 500;
      sendJson(reply, statusCode, { error: statusCode === 401 ? 'Unauthorized' : 'Internal server error' }, requestId);
    }
    return;
  }

  if (url === '/api/v1/admin/ingestion/stats') {
    try {
      assertInternalAuth(getInternalAuthHeader(req));
      sendJson(reply, 200, await redisDeviceQueue.getStats(), requestId);
    } catch (error) {
      logger.error('Error getting ingestion stats from ingestion service', {
        error: error instanceof Error ? error.message : String(error),
      });
      const statusCode = error instanceof Error && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) || 500 : 500;
      sendJson(reply, statusCode, { error: statusCode === 401 ? 'Unauthorized' : 'Internal server error' }, requestId);
    }
    return;
  }

  sendJson(reply, 404, {
    error: 'Not found',
  }, requestId);
}

export function createIngestionServer(): Server {
  return createServer((req, reply) => {
    const requestId = getRequestId(req);
    const start = process.hrtime.bigint();

    logger.debug('incoming request', {
      reqId: requestId,
      req: {
        method: req.method,
        url: req.url,
        host: req.headers.host,
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
      },
    });

    reply.on('finish', () => {
      const durationNs = process.hrtime.bigint() - start;
      const responseTime = Number(durationNs) / 1_000_000;
      logger.debug('request completed', {
        reqId: requestId,
        res: { statusCode: reply.statusCode },
        responseTime,
      });
    });

    routeRequest(req, reply, requestId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;

      logger.error('Ingestion server error', {
        error: message,
        stack,
      });

      if (!reply.headersSent) {
        sendJson(reply, 500, { error: message }, requestId);
        return;
      }

      reply.destroy();
    });
  });
}