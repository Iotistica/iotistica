/**
 * Fastify application factory.
 *
 * Creates and fully configures the Fastify instance:
 *   security → middleware → routes → proxies → error handlers.
 *
 * Does NOT start listening — that is handled by server/lifecycle.ts.
 */

import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { applySecurity } from './security';
import { applyMiddleware } from './middleware';
import { mountRoutes } from './routes';
import { mountProxies } from './proxies';
import logger from '../utils/logger';

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
  const fastify = Fastify({
    // Request ID: honour X-Request-ID header, fall back to random UUID
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),
    trustProxy: getTrustProxy(),
    // Disable built-in pino logger — we use Winston via hooks
    logger: false,
    // Relax content-type check so clients can send application/json without charset
    ajv: {
      customOptions: {
        allowUnionTypes: true,
      },
    },
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
