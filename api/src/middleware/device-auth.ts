/**
 * Device Authentication Middleware
 * 
 * Authenticates devices using their API key stored during provisioning.
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
        fleetId?: string;
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

    // Fetch device from database
    const result = await query(
      `SELECT id, uuid, device_name, device_type, is_active, device_api_key_hash, fleet_id
       FROM devices
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

    // Check if device is active
    if (!device.is_active) {
      res.status(403).json({
        error: 'Forbidden',
        message: 'Device is inactive. Contact administrator.'
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
    //   'UPDATE devices SET last_seen = CURRENT_TIMESTAMP WHERE uuid = $1',
    //   [deviceUuid]
    // );

    // Attach device info to request
    req.device = {
      id: device.id,
      uuid: device.uuid,
      deviceName: device.device_name,
      deviceType: device.device_type,
      isActive: device.is_active,
      fleetId: device.fleet_id
    };

    

    // Proceed to route handler
    next();

  } catch (error: any) {
    console.error('Device authentication error:', error);
    // Only send error response if headers haven't been sent yet
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Authentication failed'
      });
    }
    // Re-throw to let calling code know auth failed
    throw error;
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
          logger.info('Extracted UUID from state report key:', deviceUuid);
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
      `SELECT id, uuid, device_name, device_type, is_active, device_api_key_hash, fleet_id
       FROM devices
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
      fleetId: device.fleet_id
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
