/**
 * API Gateway proxy middleware: MQTT Monitor + Postoffice services.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { fetch } from 'undici';
import logger from '../utils/logger';
import jwtAuth from '../middleware/jwt-auth';
import { API_BASE } from './routes';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

/**
 * Build a lightweight reverse-proxy plugin using undici.
 * Strips the mountPath prefix, forwards all headers except hop-by-hop,
 * and streams the upstream response body back to the client.
 */
function createServiceProxy(
  serviceName: string,
  targetBase: string,
  mountPath: string,
): FastifyPluginAsync {
  return async function serviceProxy(fastify) {
    fastify.all('*', async (request, reply) => {
      // Rewrite path: strip mount prefix, preserve remaining path + query
      const suffix = request.url.startsWith(mountPath)
        ? request.url.slice(mountPath.length) || '/'
        : request.url;
      const upstreamUrl = targetBase.replace(/\/$/, '') + suffix;

      // Forward request headers, excluding hop-by-hop
      const forwardHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.headers)) {
        if (!HOP_BY_HOP.has(key.toLowerCase()) && typeof value === 'string') {
          forwardHeaders[key] = value;
        }
      }

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
      const body: string | undefined = hasBody ? JSON.stringify(request.body) : undefined;

      try {
        const upstream = await fetch(upstreamUrl, {
          method: request.method,
          headers: forwardHeaders,
          body: body as any,
          signal: AbortSignal.timeout(30000),
        } as any);

        // Forward response headers, excluding hop-by-hop
        upstream.headers.forEach((value, key) => {
          if (!HOP_BY_HOP.has(key.toLowerCase())) {
            reply.header(key, value);
          }
        });

        reply.status(upstream.status);
        const buf = Buffer.from(await upstream.arrayBuffer());
        return reply.send(buf);
      } catch (err: any) {
        logger.error(`${serviceName} proxy error`, { error: err.message, url: upstreamUrl });
        return reply.status(502).send({ success: false, error: `${serviceName} service unavailable` });
      }
    });
  };
}

export async function mountProxies(fastify: FastifyInstance): Promise<void> {
  const POSTOFFICE_URL = process.env.POSTOFFICE_URL || 'http://postoffice:3300';
  const postofficeMountPath = `${API_BASE}/postoffice`;
  await fastify.register(
    createServiceProxy('Postoffice', `${POSTOFFICE_URL}/api/v1`, postofficeMountPath),
    { prefix: postofficeMountPath },
  );
}


/**
 * Build a lightweight reverse-proxy handler using undici.
 * Strips the mountPath prefix, forwards all headers except hop-by-hop,
 * and streams the upstream response body back to the client.
 */
