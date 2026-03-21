/**
 * Device Authentication Middleware
 * 
 * Authenticates agents using their API key stored during provisioning.
 * Devices must send their API key in the X-Device-API-Key header.
 * 
 * Usage:
 *   router.get('/device/:uuid/state', deviceAuth, async (req, res) => {
 *     // req.device contains authenticated device info
 *   });
 */

import { Request, Response, NextFunction } from 'express';
import { query } from '../db/connection';
import bcrypt from 'bcrypt';
import logger from '../utils/logger';

interface CachedDeviceAuth {
  id: number;
  uuid: string;
  device_name: string;
  device_type: string;
  is_active: boolean;
  device_api_key_hash: string;
  fleet_uuid?: string;
  cached_at: number;
}

// Cache TTL in seconds (default: 5 minutes = 300 seconds)
const CACHE_TTL = parseInt(process.env.DEVICE_AUTH_CACHE_TTL || '300', 10);

// Lazy-load Redis client
let redisClient: any = null;
async function getRedisClient() {
  if (!redisClient) {
    try {
      const module = await import('../redis/client');
      redisClient = module.redisClient;
    } catch (error) {
      logger.warn('Redis client not available for auth caching');
      return null;
    }
  }
  return redisClient;
}

/**
 * Get device auth from Redis cache
 */
async function getFromCache(deviceUuid: string): Promise<any | null> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return null;
    }

    const cacheKey = `auth:device:${deviceUuid}`;
    const cached = await redis.getClient().get(cacheKey);

    if (!cached) {
      return null;
    }

    const data: CachedDeviceAuth = JSON.parse(cached);
    
    // Validate cache age
    const age = Date.now() / 1000 - data.cached_at;
    if (age > CACHE_TTL) {
      await redis.getClient().del(cacheKey);
      return null;
    }

    logger.debug('Device auth cache hit', { deviceUuid, age: age.toFixed(2) + 's' });
    return data;
  } catch (error: any) {
    logger.debug('Auth cache read failed', { deviceUuid, error: error.message });
    return null;
  }
}

/**
 * Store device auth in Redis cache
 */
async function storeInCache(device: any): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return;
    }

    const cacheKey = `auth:device:${device.uuid}`;
    const cacheData: CachedDeviceAuth = {
      id: device.id,
      uuid: device.uuid,
      device_name: device.device_name,
      device_type: device.device_type,
      is_active: device.is_active,
      device_api_key_hash: device.device_api_key_hash,
      fleet_uuid: device.fleet_uuid,
      cached_at: Date.now() / 1000,
    };

    await redis.getClient().setex(cacheKey, CACHE_TTL, JSON.stringify(cacheData));
    logger.info('Device auth cached', { deviceUuid: device.uuid, ttl: CACHE_TTL });
  } catch (error: any) {
    logger.debug('Auth cache write failed', { deviceUuid: device.uuid, error: error.message });
  }
}

/**
 * Invalidate device auth cache (call when credentials change)
 */
export async function invalidateDeviceAuthCache(deviceUuid: string): Promise<void> {
  try {
    const redis = await getRedisClient();
    if (!redis || !redis.isReady()) {
      return;
    }
    await redis.getClient().del(`auth:device:${deviceUuid}`);
    logger.info('Device auth cache invalidated', { deviceUuid });
  } catch (error: any) {
    logger.debug('Auth cache invalidation failed', { deviceUuid, error: error.message });
  }
}

// Extend Express Request to include device info
declare global {
  namespace Express {
    interface Request {
      device?: {
        id: number;
        uuid: string;
        deviceName: string;
        deviceType: string;
        isActive: boolean;
        fleetUuid?: string;
      };
    }
  }
}

/**
 * Device Authentication Middleware
 * 
 * Expects: X-Device-API-Key header or Authorization: Bearer <apiKey>
 * Sets: req.device with authenticated device information
 */
export async function deviceAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const startTime = Date.now();
  let cacheHit = false;
  
  try {
    // Extract API key from header (support both formats)
    const apiKey = 
      req.headers['x-device-api-key'] as string ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!apiKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Device API key required. Send in X-Device-API-Key header or Authorization: Bearer header.'
      });
      return;
    }

    // Extract device UUID from URL params (most endpoints have :uuid)
    const deviceUuid = req.params.uuid;

    if (!deviceUuid) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Device UUID required in URL path'
      });
      return;
    }

    // Try cache first
    let device = await getFromCache(deviceUuid);
    let cacheHit = !!device;

    // Cache miss - fetch from database
    if (!device) {
      const result = await query(
        `SELECT id, uuid, device_name, device_type, is_active, device_api_key_hash, fleet_uuid
         FROM agents
         WHERE uuid = $1`,
        [deviceUuid]
      );

      if (result.rows.length === 0) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Device not found'
        });
        return;
      }

      device = result.rows[0];
      
      // Store in cache for future requests
      await storeInCache(device);
    }

    // Check if device is active
    if (!device.is_active) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Device is inactive. Contact administrator.'
      });
      return;
    }

    // Check if device has completed registration (has API key hash)
    if (!device.device_api_key_hash) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Device registration incomplete. Please complete device registration first.'
      });
      return;
    }

    const isValidKey = await bcrypt.compare(apiKey, device.device_api_key_hash);
    

    if (!isValidKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid device API key'
      });
      return;
    }

    // Update last_seen timestamp (optional - can impact performance)
    // Uncomment if you want to track device activity on every request
    // await query(
    //   'UPDATE agents SET last_seen = CURRENT_TIMESTAMP WHERE uuid = $1',
    //   [deviceUuid]
    // );

    // Attach device info to request
    req.device = {
      id: device.id,
      uuid: device.uuid,
      deviceName: device.device_name,
      deviceType: device.device_type,
      isActive: device.is_active,
      fleetUuid: device.fleet_uuid
    };

    const duration = Date.now() - startTime;
    
    // Log slow auth (cache should be <5ms, DB fallback ~50-200ms)
    if (duration > 100 || !cacheHit) {
      logger.debug('Device authenticated', {
        deviceUuid,
        duration: duration + 'ms',
        cacheHit,
      });
    }

    // Proceed to route handler
    next();

  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    logger.error('Device authentication error', { 
      deviceUuid: req.params.uuid,
      duration: duration + 'ms',
      error: error.message, 
      stack: error.stack 
    });
    
    // Only send error response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication failed'
      });
    }
    // Don't re-throw - let the request fail gracefully without crashing
  }
}

/**
 * Optional: Device authentication for endpoints without :uuid in path
 * Extracts UUID from request body instead
 */
export async function deviceAuthFromBody(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const apiKey = 
      req.headers['x-device-api-key'] as string ||
      req.headers.authorization?.replace('Bearer ', '');

    if (!apiKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Device API key required'
      });
      return;
    }

    // Extract device UUID from body
    // Support multiple formats:
    // 1. Direct field: { uuid: "..." } or { deviceUuid: "..." }
    // 2. State report format: { "[uuid]": { apps, config, ... } }
    let deviceUuid = req.body.uuid || req.body.deviceUuid;
    
    if (!deviceUuid) {
      // Try to extract from state report format (keys are UUIDs)
      const keys = Object.keys(req.body);
      
      if (keys.length === 1) {
        const key = keys[0];
        // Match UUID format: 8-4-4-4-12 hex characters
        if (key.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          deviceUuid = key;
          logger.info('Extracted UUID from state report key', { deviceUuid });
        }
      }
    }

    if (!deviceUuid) {
      logger.error(' Failed to extract UUID from body:', JSON.stringify(req.body, null, 2));
      res.status(400).json({
        error: 'Bad Request',
        message: 'Device UUID required in request body (as uuid/deviceUuid field or as state report key)'
      });
      return;
    }

    // Rest of logic is same as deviceAuth
    const result = await query(
      `SELECT id, uuid, device_name, device_type, is_active, device_api_key_hash, fleet_uuid
       FROM agents
       WHERE uuid = $1`,
      [deviceUuid]
    );

    if (result.rows.length === 0) {
      res.status(404).json({
        error: 'Not Found',
        message: 'Device not found'
      });
      return;
    }

    const device = result.rows[0];

    if (!device.is_active) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Device is inactive'
      });
      return;
    }

    // Check if device has completed registration (has API key hash)
    if (!device.device_api_key_hash) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Device registration incomplete. Please complete device registration first.'
      });
      return;
    }

    const isValidKey = await bcrypt.compare(apiKey, device.device_api_key_hash);

    if (!isValidKey) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid device API key'
      });
      return;
    }

    req.device = {
      id: device.id,
      uuid: device.uuid,
      deviceName: device.device_name,
      deviceType: device.device_type,
      isActive: device.is_active,
      fleetUuid: device.fleet_uuid
    };

    next();

  } catch (error: any) {
    logger.error('Device authentication error:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Optional: Rate limiting by device
 * Can be combined with deviceAuth middleware
 */
export function deviceRateLimit(maxRequests: number, windowMs: number) {
  const requestCounts = new Map<string, { count: number; resetTime: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.device) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'deviceAuth middleware must be applied before deviceRateLimit'
      });
      return;
    }

    const deviceUuid = req.device.uuid;
    const now = Date.now();

    const record = requestCounts.get(deviceUuid);

    if (!record || now > record.resetTime) {
      // New window
      requestCounts.set(deviceUuid, {
        count: 1,
        resetTime: now + windowMs
      });
      next();
      return;
    }

    if (record.count >= maxRequests) {
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s`,
        retryAfter: Math.ceil((record.resetTime - now) / 1000)
      });
      return;
    }

    record.count++;
    next();
  };
}

export default deviceAuth;
