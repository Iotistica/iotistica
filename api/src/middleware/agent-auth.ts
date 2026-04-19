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

import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/connection';
import { AgentModel } from '../services/agent/agents';
import logger from '../utils/logger';
import { verifyMachineSecret } from '../utils/secret-hashing';

type DeviceUuidParams = {
  uuid: string;
};

type DeviceAuthBody = {
  uuid?: string;
  deviceUuid?: string;
  [key: string]: unknown;
};

type UuidBody = {
  uuid?: string;
};

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

export async function checkUuidImmutability(
  request: FastifyRequest<{ Body: UuidBody }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const { uuid } = request.body ?? {};
    if (!uuid) {
      return;
    }

    const existingDevice = await AgentModel.getByUuid(uuid);
    if (existingDevice && existingDevice.provisioning_state === 'registered') {
      logger.warn(`Re-provisioning attempt for registered device: ${uuid.substring(0, 8)}...`);
      return reply.status(409).send({
        error: 'Device already registered',
        message: 'Device already registered with this UUID. Factory reset to re-provision.',
        details: {
          uuid,
          provisioning_state: existingDevice.provisioning_state,
          provisioned_at: existingDevice.provisioned_at,
        },
      });
    }
  } catch (error: unknown) {
    logger.error('Error checking UUID immutability', {
      error: error instanceof Error ? error.message : String(error),
    });
    // Soft fail - let service layer handle it
  }
}

export async function optionalUuidImmutabilityCheck(
  request: FastifyRequest<{ Body: UuidBody }>,
  _reply: FastifyReply
): Promise<void> {
  try {
    const { uuid } = request.body ?? {};
    if (!uuid) {
      return;
    }

    const existingDevice = await AgentModel.getByUuid(uuid);
    if (existingDevice?.provisioning_state === 'registered') {
      logger.debug('Optional UUID check: device already registered', { uuid: uuid.substring(0, 8) });
    }
  } catch {
    // Soft fail
  }
}

// Type augmentations are in src/types/fastify.d.ts

/**
 * Device Authentication preHandler
 *
 * Expects: X-Device-API-Key header or Authorization: Bearer <apiKey>
 * Sets: request.device with authenticated device information
 */
export async function deviceAuth(
  request: FastifyRequest<{ Params: DeviceUuidParams }>,
  reply: FastifyReply
): Promise<void> {
  const startTime = Date.now();
  let cacheHit = false;

  try {
    const apiKey =
      request.headers['x-device-api-key'] as string ||
      request.headers.authorization?.replace('Bearer ', '');

    if (!apiKey) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Device API key required. Send in X-Device-API-Key header or Authorization: Bearer header.'
      });
    }

    const { uuid: deviceUuid } = request.params;

    if (!deviceUuid) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Device UUID required in URL path'
      });
    }

    // Try cache first
    let device = await getFromCache(deviceUuid);
    cacheHit = !!device;

    // Cache miss - fetch from database
    if (!device) {
      const result = await query(
        `SELECT id, uuid, name AS device_name, type AS device_type, is_active, device_api_key_hash, fleet_uuid
         FROM agents
         WHERE uuid = $1`,
        [deviceUuid]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: 'Not Found',
          message: 'Device not found'
        });
      }

      device = result.rows[0];

      await storeInCache(device);
    }

    if (!device.is_active) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Device is inactive. Contact administrator.'
      });
    }

    if (!device.device_api_key_hash) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Device registration incomplete. Please complete device registration first.'
      });
    }

    const keyVerification = await verifyMachineSecret(apiKey, device.device_api_key_hash, 'device-api-key');

    if (!keyVerification.valid) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid device API key'
      });
    }

    if (keyVerification.upgradedHash) {
      await query(
        'UPDATE agents SET device_api_key_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE uuid = $2',
        [keyVerification.upgradedHash, deviceUuid],
      );
      device.device_api_key_hash = keyVerification.upgradedHash;
      await storeInCache(device);
    }

    // Update last_seen timestamp (optional - can impact performance)
    // Uncomment if you want to track device activity on every request
    // await query(
    //   'UPDATE agents SET last_seen = CURRENT_TIMESTAMP WHERE uuid = $1',
    //   [deviceUuid]
    // );

    request.device = {
      id: device.id,
      uuid: device.uuid,
      deviceName: device.device_name,
      deviceType: device.device_type,
      isActive: device.is_active,
      fleetUuid: device.fleet_uuid
    };

    const duration = Date.now() - startTime;

    if (duration > 100 || !cacheHit) {
      logger.debug('Device authenticated', {
        deviceUuid,
        duration: duration + 'ms',
        cacheHit,
      });
    }
    // Fastify proceeds to route handler automatically

  } catch (error: any) {
    const duration = Date.now() - startTime;

    logger.error('Device authentication error', {
      deviceUuid: request.params.uuid,
      duration: duration + 'ms',
      error: error.message,
      stack: error.stack
    });

    if (!reply.sent) {
      reply.status(500).send({
        error: 'Internal Server Error',
        message: 'Authentication failed'
      });
    }
  }
}

/**
 * Optional: Device authentication for endpoints without :uuid in path.
 * Extracts UUID from request body instead.
 */
export async function deviceAuthFromBody(
  request: FastifyRequest<{ Body: DeviceAuthBody }>,
  reply: FastifyReply
): Promise<void> {
  try {
    const apiKey =
      request.headers['x-device-api-key'] as string ||
      request.headers.authorization?.replace('Bearer ', '');

    if (!apiKey) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Device API key required'
      });
    }

    const body = request.body ?? {};
    let deviceUuid = typeof body.uuid === 'string'
      ? body.uuid
      : typeof body.deviceUuid === 'string'
        ? body.deviceUuid
        : undefined;

    if (!deviceUuid) {
      const keys = Object.keys(body || {});
      if (keys.length === 1) {
        const key = keys[0];
        if (key.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
          deviceUuid = key;
          logger.info('Extracted UUID from state report key', { deviceUuid });
        }
      }
    }

    if (!deviceUuid) {
      logger.error('Failed to extract UUID from body', { body });
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Device UUID required in request body (as uuid/deviceUuid field or as state report key)'
      });
    }

    const result = await query(
      `SELECT id, uuid, name AS device_name, type AS device_type, is_active, device_api_key_hash, fleet_uuid
       FROM agents
       WHERE uuid = $1`,
      [deviceUuid]
    );

    if (result.rows.length === 0) {
      return reply.status(404).send({ error: 'Not Found', message: 'Device not found' });
    }

    const device = result.rows[0];

    if (!device.is_active) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Device is inactive' });
    }

    if (!device.device_api_key_hash) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Device registration incomplete. Please complete device registration first.'
      });
    }

    const keyVerification = await verifyMachineSecret(apiKey, device.device_api_key_hash, 'device-api-key');

    if (!keyVerification.valid) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid device API key' });
    }

    if (keyVerification.upgradedHash) {
      await query(
        'UPDATE agents SET device_api_key_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE uuid = $2',
        [keyVerification.upgradedHash, deviceUuid],
      );
    }

    request.device = {
      id: device.id,
      uuid: device.uuid,
      deviceName: device.device_name,
      deviceType: device.device_type,
      isActive: device.is_active,
      fleetUuid: device.fleet_uuid
    };

  } catch (error: any) {
    logger.error('Device authentication error', {
      error: error.message,
      stack: error.stack,
    });
    if (!reply.sent) {
      reply.status(500).send({ error: 'Internal Server Error', message: 'Authentication failed' });
    }
  }
}

/**
 * Optional: Per-device rate limiting preHandler factory.
 * Use @fastify/rate-limit in most cases — this is for special per-device logic.
 */
export function deviceRateLimit(maxRequests: number, windowMs: number) {
  const requestCounts = new Map<string, { count: number; resetTime: number }>();

  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.device) {
      return reply.status(500).send({
        error: 'Internal Server Error',
        message: 'deviceAuth preHandler must run before deviceRateLimit'
      });
    }

    const deviceUuid = request.device.uuid;
    const now = Date.now();
    const record = requestCounts.get(deviceUuid);

    if (!record || now > record.resetTime) {
      requestCounts.set(deviceUuid, { count: 1, resetTime: now + windowMs });
      return;
    }

    if (record.count >= maxRequests) {
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Max ${maxRequests} requests per ${windowMs / 1000}s`,
        retryAfter: Math.ceil((record.resetTime - now) / 1000)
      });
    }

    record.count++;
  };
}

export default deviceAuth;
