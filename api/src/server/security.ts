/**
 * Security plugins: Helmet headers + CORS.
 * Applied first before any other middleware.
 * Trust proxy is configured in app.ts via Fastify factory options.
 */

import type { FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';
import fastifyCors from '@fastify/cors';
import logger from '../utils/logger';
import { createCorsOptions } from './cors';

const RUNNING_IN_K8S = process.env.KUBERNETES_SERVICE_HOST !== undefined;

export async function applySecurity(fastify: FastifyInstance): Promise<void> {
  if (RUNNING_IN_K8S || process.env.TRUST_PROXY) {
    logger.info('[OK] Trust proxy enabled (configured in Fastify factory options)');
  }

  // SECURITY: Helmet - sets secure HTTP headers
  await fastify.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Allow inline scripts for Swagger UI
        styleSrc: ["'self'", "'unsafe-inline'"],  // Allow inline styles for Swagger UI
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],    // Allow WebSocket connections
        frameSrc: ["'none'"],                      // Prevent clickjacking
        objectSrc: ["'none'"],                     // Prevent Flash/Java
        mediaSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        upgradeInsecureRequests: [],               // Handled by ingress in K8s
        blockAllMixedContent: [],
      },
    },
    frameguard: { action: 'deny' },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    hsts: {
      maxAge: 31536000, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    crossOriginEmbedderPolicy: false, // Disabled for WebSocket compatibility
    dnsPrefetchControl: { allow: false },
    hidePoweredBy: true,
    xssFilter: true,
  });

  // CORS - see server/cors.ts
  await fastify.register(fastifyCors, createCorsOptions());
}
