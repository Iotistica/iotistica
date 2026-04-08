/**
 * Rate Limiting — @fastify/rate-limit configurations.
 *
 * Multi-tier strategy optimised for IoT backends:
 * 1. IP-based limiting (unauthenticated/auth routes)
 * 2. Token-based limiting (device API key or JWT user ID)
 *
 * These option objects are passed to fastify.register(rateLimit, opts) inside
 * scoped Fastify plugins in server/routes.ts.
 */

import crypto from 'crypto';
import type { FastifyRequest } from 'fastify';
import type { RateLimitOptions, RateLimitPluginOptions } from '@fastify/rate-limit';
import logger from '../utils/logger';
import { getRedisClient } from '../redis/client-factory';

const RATE_LIMIT_NAMESPACE = process.env.RATE_LIMIT_NAMESPACE || 'iotistica-rate-limit:';

function hashSecret(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Token-based key generator: device key → user ID → IP fallback */
function tokenKeyGenerator(request: FastifyRequest): string {
  const deviceApiKeyHeader = request.headers['x-device-api-key'];
  const deviceApiKey = typeof deviceApiKeyHeader === 'string' ? deviceApiKeyHeader : undefined;
  if (deviceApiKey) return `device:${hashSecret(deviceApiKey)}`;

  const userId = request.user?.id;
  if (userId) return `user:${userId}`;

  return `ip:${request.ip}`;
}

function ipKeyGenerator(request: FastifyRequest): string {
  return `ip:${request.ip}`;
}

function onRateLimitExceeded(request: FastifyRequest, _key: string): void {
  logger.warn('Rate limit exceeded', {
    ip: request.ip,
    url: request.url,
    method: request.method,
    userAgent: request.headers['user-agent'],
  });
}

export function withRedisRateLimitOptions(
  options: RateLimitOptions,
  namespaceSuffix: string,
): RateLimitPluginOptions {
  return {
    ...options,
    redis: getRedisClient(),
    nameSpace: `${RATE_LIMIT_NAMESPACE}${namespaceSuffix}`,
    skipOnError: true,
  };
}

/**
 * Global API rate limit: 300 req/min per device/user.
 * Applied to all /api/v* routes.
 */
export const globalRateLimitOptions: RateLimitOptions = {
  max: 300,
  timeWindow: 60_000,
  keyGenerator: tokenKeyGenerator,
  onExceeded: onRateLimitExceeded,
  skipOnError: true,
  errorResponseBuilder: (_request, context) => ({
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: context.after,
  }),
};

/**
 * Auth rate limit: 10 req/min per IP (brute-force protection).
 * Only failed attempts count (skipSuccessfulRequests equivalent via hook).
 */
export const authRateLimitOptions: RateLimitOptions = {
  max: 10,
  timeWindow: 60_000,
  keyGenerator: ipKeyGenerator,
  onExceeded: onRateLimitExceeded,
  skipOnError: true,
  errorResponseBuilder: (_request, context) => ({
    error: 'Too many requests',
    message: 'Too many authentication attempts. Please wait before retrying.',
    retryAfter: context.after,
  }),
};

/**
 * Device data rate limit: 1000 req/min (supports 16 Hz sensor data).
 */
export const deviceDataRateLimitOptions: RateLimitOptions = {
  max: 1000,
  timeWindow: 60_000,
  keyGenerator: tokenKeyGenerator,
  onExceeded: onRateLimitExceeded,
  skipOnError: true,
  errorResponseBuilder: (_request, context) => ({
    error: 'Too many requests',
    message: 'Device data rate limit exceeded.',
    retryAfter: context.after,
  }),
};

/**
 * Admin/control-plane rate limit: 100 req/min per user.
 */
export const adminRateLimitOptions: RateLimitOptions = {
  max: 100,
  timeWindow: 60_000,
  keyGenerator: tokenKeyGenerator,
  onExceeded: onRateLimitExceeded,
  skipOnError: true,
  errorResponseBuilder: (_request, context) => ({
    error: 'Too many requests',
    message: 'Admin rate limit exceeded.',
    retryAfter: context.after,
  }),
};
