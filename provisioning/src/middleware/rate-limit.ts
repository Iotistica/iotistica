/**
 * Rate Limiting Middleware
 * Prevent abuse and DDoS attacks
 */

import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

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
    // Rate limit by customer ID instead of IP
    return req.headers['x-api-key'] as string || req.ip || 'unknown';
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
