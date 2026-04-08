/**
 * Application request logging — Fastify onRequest + onResponse hooks.
 *
 * - Debug-logs every incoming request (method + url + query + IP)
 * - On response: skips 200s to reduce noise; logs 4xx as warn, 5xx as error
 * - MQTT auth paths (/superuser, /acl) are logged at debug level regardless of status
 */

import type { FastifyInstance } from 'fastify';
import logger from '../utils/logger';

const MQTT_AUTH_PATHS = new Set(['/superuser', '/acl']);

export function registerRequestLogger(fastify: FastifyInstance): void {
  fastify.addHook('onRequest', (request, _reply, done) => {
    logger.debug(`${request.method} ${request.url}`, {
      method: request.method,
      url: request.url,
      query: request.query,
      ip: request.ip,
    });
    done();
  });

  fastify.addHook('onResponse', (request, reply, done) => {
    if (reply.statusCode === 200) return done();

    const duration = reply.elapsedTime?.toFixed(0) ?? '?';
    const path = request.url.split('?')[0];

    const logLevel =
      reply.statusCode >= 500
        ? 'error'
        : reply.statusCode >= 400
          ? 'warn'
          : MQTT_AUTH_PATHS.has(path)
            ? 'debug'
            : 'info';

    logger[logLevel](`${reply.statusCode} ${request.method} ${path} - ${duration}ms`);
    done();
  });
}
