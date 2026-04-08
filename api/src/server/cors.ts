/**
 * CORS configuration for the Iotistic API.
 *
 * SECURITY: Never use '*' with credentials enabled (exposes session cookies).
 * Wildcard patterns (https://*.example.com) are supported but use sparingly.
 */

import type { FastifyCorsOptions } from '@fastify/cors';
import logger from '../utils/logger';

const allowedOrigins: string[] = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:5173',
      'http://localhost:3001',
      'http://localhost:3000',
      'http://localhost:8080',
      'http://localhost:4002',
      // Allow K8s fleet cluster to call provisioning API
      'https://api1.iotistica.com',
      'http://api1.iotistica.com',
      // Production dashboard
      'https://tsdbdash.iotistica.com',
    ];

// SECURITY: Validate CORS configuration on startup
if (allowedOrigins.includes('*')) {
  logger.error('CRITICAL: CORS_ORIGINS contains "*" which is insecure with credentials enabled');
  throw new Error('CORS misconfiguration: Cannot use "*" origin with credentials');
}

const hasWildcards = allowedOrigins.some(o => o.includes('*'));
if (hasWildcards) {
  logger.warn('CORS wildcard patterns detected - ensure these are intentional:', {
    origins: allowedOrigins.filter(o => o.includes('*')),
  });
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regexPattern = escaped.replace(/\\\*/g, '.*');
  return new RegExp(`^${regexPattern}$`);
}

const corsOptions: FastifyCorsOptions = {
  origin: (origin, callback) => {
    // No origin header: server-to-server, mobile apps, curl, Postman
    if (!origin) {
      return callback(null, true);
    }

    const isAllowed = allowedOrigins.some(allowed => {
      if (allowed.includes('*')) {
        return wildcardToRegExp(allowed).test(origin);
      }
      return allowed === origin;
    });

    if (isAllowed) {
      callback(null, true);
    } else {
      logger.warn('CORS: Rejected request from unauthorized origin', {
        origin,
        allowedOrigins: allowedOrigins.slice(0, 5),
      });
      callback(null, false);
    }
  },

  // SECURITY: credentials: true requires explicit origin (never '*')
  credentials: true,

  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],

  // Explicit header allowlist
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-API-Key', 'X-Tenant-ID'],

  exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],

  // Preflight cache duration (24 hours)
  maxAge: 86400,
};

/** Returns @fastify/cors option object. */
export function createCorsOptions(): FastifyCorsOptions {
  return corsOptions;
}
