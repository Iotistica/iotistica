/**
 * Fastify application factory.
 *
 * Creates and fully configures the Fastify instance:
 *   security → middleware → routes → proxies → error handlers.
 *
 * Does NOT start listening — that is handled by server/lifecycle.ts.
 */

import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'crypto';
import { applySecurity } from './security';
import { applyMiddleware } from './middleware';
import { mountRoutes } from './routes';
import { mountProxies } from './proxies';
import logger, { pinoLogger } from '../utils/logger';

const requestStartTimes = new WeakMap<FastifyRequest, bigint>();

function getRequestLogLevel(statusCode: number, error?: Error): 'debug' | 'warn' | 'error' {
  if (error || statusCode >= 500) {
    return 'error';
  }

  if (statusCode >= 400) {
    return 'warn';
  }

  return 'debug';
}

// Trust proxy: K8s deployments always run behind a load balancer
function getTrustProxy(): boolean | number | string {
  const val = process.env.TRUST_PROXY;
  if (!val) {
    // Auto-enable inside Kubernetes
    return !!(process.env.KUBERNETES_SERVICE_HOST);
  }
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if (val === 'true') return true;
  if (val === 'false') return false;
  return val; // string (IP or CIDR)
}

export async function createApp(): Promise<FastifyInstance> {
  const fastifyOptions = {
    // Request ID: honour X-Request-ID header, fall back to random UUID
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: getTrustProxy(),
    loggerInstance: pinoLogger,
    disableRequestLogging: true,
    // Relax content-type check so clients can send application/json without charset
    ajv: {
      customOptions: {
        allowUnionTypes: true,
      },
    },
  } as const;

  const fastify = Fastify(fastifyOptions as Parameters<typeof Fastify>[0]) as unknown as FastifyInstance;

  fastify.addHook('onRequest', async (request) => {
    requestStartTimes.set(request, process.hrtime.bigint());
    request.log.debug({ req: request.raw }, 'incoming request');
  });

  fastify.addHook('onResponse', async (request, reply) => {
    const start = requestStartTimes.get(request);
    const responseTime = start ? Number(process.hrtime.bigint() - start) / 1_000_000 : undefined;
    requestStartTimes.delete(request);

    const level = getRequestLogLevel(reply.statusCode);
    request.log[level]({ res: reply, responseTime }, 'request completed');
  });

  // Decorate request properties so Fastify's strict type system is satisfied
  fastify.decorateRequest('user', null);
  fastify.decorateRequest('device', null);
  fastify.decorateRequest('apiKey', null);
  fastify.decorateRequest('_auth0Payload', null);
  fastify.decorateRequest('_legacyPayload', null);
  fastify.decorateRequest('_roleData', null);
  fastify.decorateRequest('_dbUser', null);

  await applySecurity(fastify);
  await applyMiddleware(fastify);
  await mountRoutes(fastify);
  await mountProxies(fastify);

  // 404 handler
  fastify.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: 'Not found',
      message: `Route ${request.method} ${request.url} not found`,
      hint: 'See /api/docs for available endpoints',
    });
  });

  // Global error handler
  fastify.setErrorHandler<FastifyError>((error, request, reply) => {
    logger.error('Server error', {
      error: error.message,
      stack: error.stack,
      method: request.method,
      url: request.url,
    });
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: statusCode === 500 ? 'Internal server error' : error.message,
      message: error.message,
    });
  });

  return fastify;
}
