/**
 * Security middleware: trust proxy + Helmet headers + CORS.
 * Applied first before any other middleware.
 */

import express from 'express';
import helmet from 'helmet';
import logger from '../utils/logger';
import { createCors } from './cors';

const RUNNING_IN_K8S = process.env.KUBERNETES_SERVICE_HOST !== undefined;

export function applySecurity(app: express.Application): void {
  // SECURITY: Trust proxy for deployments behind reverse proxy (Envoy, NGINX, ALB, etc.)
  // Must be enabled when behind reverse proxy, otherwise:
  //   - req.ip shows proxy IP, not client IP
  //   - Rate limiting fails (all traffic appears from single proxy)
  const EXPLICIT_TRUST_PROXY = process.env.TRUST_PROXY;
  const AUTO_TRUST_PROXY = RUNNING_IN_K8S ? 1 : false;
  const TRUST_PROXY =
    EXPLICIT_TRUST_PROXY !== undefined
      ? EXPLICIT_TRUST_PROXY
      : AUTO_TRUST_PROXY
        ? 'true'
        : 'false';

  if (TRUST_PROXY !== 'false') {
    const trustProxyValue = TRUST_PROXY === 'true' ? 1 : parseInt(TRUST_PROXY, 10);
    app.set('trust proxy', trustProxyValue);
    logger.info(
      `[OK] Trust proxy enabled: ${trustProxyValue} hop(s) (automatically enabled in K8s, behind Envoy Gateway)`,
    );
  } else {
    logger.info('Trust proxy disabled (direct deployment, not behind reverse proxy)');
  }

  // SECURITY: Helmet - sets secure HTTP headers
  app.use(
    helmet({
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
    }),
  );

  // CORS - see server/cors.ts
  const corsMiddleware = createCors();
  app.use(corsMiddleware);
  app.options('*', corsMiddleware);
}
