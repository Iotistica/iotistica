/**
 * Rate Limiting Middleware
 * 
 * Implements multi-tier rate limiting strategy optimized for IoT backends:
 * 1. IP-based rate limiting (unauthenticated routes)
 * 2. Token-based rate limiting (device API keys, JWT tokens)
 * 3. Per-device rate limiting (prevents one misbehaving device from blocking others)
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import logger from '../utils/logger';

/**
 * Rate limit key generator for token-based limiting
 * Uses device API key or JWT user ID instead of IP address
 * This prevents one misbehaving device from blocking others on the same IP/NAT
 */
function tokenBasedKeyGenerator(req: Request): string {
  // Priority 1: Device API key (X-Device-API-Key header)
  const deviceApiKey = req.headers['x-device-api-key'] as string;
  if (deviceApiKey) {
    return `device:${deviceApiKey}`;
  }
  
  // Priority 2: JWT user ID (from JWT middleware)
  const userId = (req as any).user?.id;
  if (userId) {
    return `user:${userId}`;
  }
  
  // Fallback: IP address (for unauthenticated requests)
  return `ip:${req.ip}`;
}

/**
 * Rate limit handler - logs violations for security monitoring
 */
function rateLimitHandler(req: Request, res: Response) {
  const key = tokenBasedKeyGenerator(req);
  
  logger.warn('Rate limit exceeded', {
    key,
    ip: req.ip,
    path: req.path,
    method: req.method,
    userAgent: req.headers['user-agent']
  });
  
  res.status(429).json({
    error: 'Too many requests',
    message: 'Rate limit exceeded. Please try again later.',
    retryAfter: res.getHeader('Retry-After')
  });
}

/**
 * Global API rate limiter (token-based)
 * Applied to all /api/* routes
 * 
 * Limits: 300 requests per minute per device/user
 * For IoT: One misbehaving device doesn't block others
 */
export const globalApiRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 300, // 300 requests per minute
  standardHeaders: true, // Return rate limit info in `RateLimit-*` headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
  keyGenerator: tokenBasedKeyGenerator,
  handler: rateLimitHandler,
  skip: (req) => {
    // Skip rate limiting for health checks and metrics
    return req.path === '/health' || req.path === '/metrics';
  }
});

/**
 * Strict rate limiter for authentication endpoints
 * Prevents brute-force attacks on login/signup
 * 
 * Limits: 10 requests per minute per IP
 */
export const authRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `auth:${req.ip}`, // Always use IP for auth endpoints
  handler: rateLimitHandler,
  skipSuccessfulRequests: true // Only count failed auth attempts
});

/**
 * Device data ingestion rate limiter
 * Higher limits for high-frequency sensor data
 * 
 * Limits: 1000 requests per minute per device
 */
export const deviceDataRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 requests per minute (supports 16 Hz sensor data)
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenBasedKeyGenerator,
  handler: rateLimitHandler
});

/**
 * Admin/control plane rate limiter
 * Moderate limits for management operations
 * 
 * Limits: 100 requests per minute per user
 */
export const adminRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: tokenBasedKeyGenerator,
  handler: rateLimitHandler
});

/**
 * Public/unauthenticated rate limiter
 * Strictest limits for public endpoints
 * 
 * Limits: 50 requests per minute per IP
 */
export const publicRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 50, // 50 requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `public:${req.ip}`, // IP-based for public routes
  handler: rateLimitHandler
});
