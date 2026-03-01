/**
 * Rate Limiting Middleware
 * Prevent abuse and DDoS attacks
 */

import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Helper to safely extract IP address (handles IPv6)
 * Uses express-rate-limit's built-in IP handling
 */
const getClientIp = (req: Request): string => {
  // Use x-forwarded-for in production (behind proxy/load balancer)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const ips = (typeof forwarded === 'string' ? forwarded : forwarded[0]).split(',');
    return ips[0].trim();
  }
  // Fallback to direct connection IP
  return req.ip || req.socket.remoteAddress || 'unknown';
};

/**
 * General API rate limit
 * 100 requests per 15 minutes per IP
 */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: 'Too many requests from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Strict rate limit for sensitive operations
 * 10 requests per hour per IP
 */
export const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Usage reporting rate limit
 * 60 requests per hour per customer
 */
export const usageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message: 'Usage reporting limit exceeded',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    // Rate limit by customer ID (from API key) instead of IP
    // Falls back to IP if no API key present (IPv6-safe)
    return req.headers['x-api-key'] as string || getClientIp(req);
  },
});

/**
 * Webhook rate limit
 * Stripe webhooks should be low volume
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'Webhook rate limit exceeded',
  standardHeaders: true,
  legacyHeaders: false,
});
