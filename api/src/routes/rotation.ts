/**
 * API Key Rotation Routes
 * 
 * Endpoints for agents to manage their API keys
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { 
  rotateDeviceApiKey, 
  emergencyRevokeApiKey,
  getDeviceRotationStatus,
  getDeviceRotationHistory
} from '../services/api-key-rotation';
import { deviceAuth } from '../middleware/agent-auth';
import { jwtAuth } from '../middleware/jwt-auth';
import { isAdminOrOwner } from '../middleware/permissions';
import rateLimit from 'express-rate-limit';
import logger from '../utils/logger';

const router = Router();

// Validation schemas
const uuidSchema = z.string().uuid('Invalid device UUID format');
const reasonSchema = z.string().min(5).max(500).regex(/^[a-zA-Z0-9\s\-.,()]+$/, 'Invalid reason format');
const limitSchema = z.number().int().min(1).max(100).default(10);

// Rate limiting for rotation endpoints
const rotationRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Max 5 rotation requests per hour per IP
  message: 'Too many rotation requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false
});

/**
 * POST /device/:uuid/rotate-key
 * 
 * Rotate API key for a device
 * Requires valid current API key
 */
router.post('/device/:uuid/rotate-key', deviceAuth, rotationRateLimit, async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;
    const { reason } = req.body;
    const requestId = (req as any).id || 'unknown';
    const deviceId = (req as any).device?.uuid;

    // Validate UUID
    const validatedUuid = uuidSchema.parse(uuid);

    // Verify device UUID matches authenticated device
    if (deviceId !== validatedUuid) {
      logger.warn('Device rotation key mismatch', { requestId, attemptedUuid: validatedUuid, authenticatedDevice: deviceId });
      return res.status(403).json({
        error: 'Cannot rotate API key for another device',
        requestId
      });
    }

    const rotation = await rotateDeviceApiKey(validatedUuid, {
      rotationDays: 90,
      gracePeriodDays: 7,
      notifyDevice: true,
      autoRevoke: true
    });

    logger.info('API key rotated', { requestId, deviceUuid: validatedUuid });
    res.json({
      message: 'API key rotated successfully',
      data: {
        expires_at: rotation.expiresAt.toISOString(),
        grace_period_ends: rotation.gracePeriodEnds.toISOString(),
        old_key_valid_until: rotation.gracePeriodEnds.toISOString()
      }
    });

  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid rotation parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid request parameters', requestId });
    }
    logger.error('API key rotation error', { requestId, deviceId: (req as any).device?.uuid, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * GET /device/:uuid/key-status
 * 
 * Get rotation status for a device
 * Check if rotation is needed, days until expiry
 */
router.get('/device/:uuid/key-status', deviceAuth, async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;
    const requestId = (req as any).id || 'unknown';
    const deviceId = (req as any).device?.uuid;

    // Validate UUID
    const validatedUuid = uuidSchema.parse(uuid);

    // Verify device UUID matches authenticated device
    if (deviceId !== validatedUuid) {
      logger.warn('Device key status mismatch', { requestId, attemptedUuid: validatedUuid, authenticatedDevice: deviceId });
      return res.status(403).json({
        error: 'Cannot view key status for another device',
        requestId
      });
    }

    const status = await getDeviceRotationStatus(validatedUuid);
    const needsRotation = status.days_until_expiry !== null && status.days_until_expiry <= 7;

    res.json({
      data: {
        agent_uuid: status.uuid,
        device_name: status.device_name,
        rotation_enabled: status.api_key_rotation_enabled,
        rotation_days: status.api_key_rotation_days,
        expires_at: status.api_key_expires_at,
        last_rotated_at: status.api_key_last_rotated_at,
        days_until_expiry: status.days_until_expiry,
        needs_rotation: needsRotation,
        total_rotations: parseInt(status.total_rotations),
        active_keys: parseInt(status.active_keys)
      }
    });

  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid key status parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid request parameters', requestId });
    }
    logger.error('Key status error', { requestId, deviceId: (req as any).device?.uuid, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * GET /device/:uuid/rotation-history
 * 
 * Get rotation history for a device
 */
router.get('/device/:uuid/rotation-history', deviceAuth, async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;
    const { limit } = req.query;
    const requestId = (req as any).id || 'unknown';
    const deviceId = (req as any).device?.uuid;

    // Validate UUID
    const validatedUuid = uuidSchema.parse(uuid);

    // Validate limit
    const validatedLimit = limitSchema.parse(limit ? parseInt(limit as string) : 10);

    // Verify device UUID matches authenticated device
    if (deviceId !== validatedUuid) {
      logger.warn('Device rotation history mismatch', { requestId, attemptedUuid: validatedUuid, authenticatedDevice: deviceId });
      return res.status(403).json({
        error: 'Cannot view rotation history for another device',
        requestId
      });
    }

    const history = await getDeviceRotationHistory(validatedUuid, validatedLimit);

    res.json({
      data: history.map(h => ({
        id: h.id,
        issued_at: h.issued_at,
        expires_at: h.expires_at,
        revoked_at: h.revoked_at,
        revoked_reason: h.revoked_reason,
        is_active: h.is_active
      }))
    });

  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid rotation history parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid request parameters', requestId });
    }
    logger.error('Rotation history error', { requestId, deviceId: (req as any).device?.uuid, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * POST /admin/device/:uuid/emergency-revoke
 * 
 * Emergency revoke API key for a device (admin/owner only)
 * This immediately invalidates the old key and issues a new one
 */
router.post('/admin/device/:uuid/emergency-revoke', jwtAuth, isAdminOrOwner(), async (req: Request, res: Response) => {
  try {
    const { uuid } = req.params;
    const { reason } = req.body;
    const requestId = (req as any).id || 'unknown';
    const userId = (req as any).user?.id;
    const userCustomerId = (req as any).user?.customerId;

    // Validate inputs
    const validatedUuid = uuidSchema.parse(uuid);
    const validatedReason = reasonSchema.parse(reason);

    if (!validatedReason) {
      return res.status(400).json({
        error: 'Reason is required for emergency revocation',
        requestId
      });
    }

    // Verify customer context exists
    if (!userCustomerId) {
      logger.error('Missing customer context for admin user', { requestId, userId });
      return res.status(403).json({
        error: 'Invalid user context',
        requestId
      });
    }

    // Verify device belongs to user's customer (MULTI-TENANCY BOUNDARY)
    // Query database to get device's customer_id
    const { pool } = require('../db');
    const deviceResult = await pool.query(
      'SELECT customer_id FROM agents WHERE uuid = $1 LIMIT 1',
      [validatedUuid]
    );

    if (deviceResult.rows.length === 0) {
      logger.warn('Device not found for emergency revoke', { requestId, userId, deviceUuid: validatedUuid });
      return res.status(404).json({
        error: 'Device not found',
        requestId
      });
    }

    const deviceCustomerId = deviceResult.rows[0].customer_id;
    
    // Enforce customer boundary
    if (deviceCustomerId !== userCustomerId) {
      logger.warn('Cross-customer emergency revoke attempt blocked', { 
        requestId, 
        userId, 
        userCustomerId, 
        deviceCustomerId,
        deviceUuid: validatedUuid 
      });
      return res.status(403).json({
        error: 'Cannot revoke API key for agents outside your customer',
        requestId
      });
    }

    logger.warn('Emergency API key revocation initiated', { requestId, userId, deviceUuid: validatedUuid, userCustomerId, reason: validatedReason });

    await emergencyRevokeApiKey(validatedUuid, validatedReason);

    logger.warn('Emergency API key revocation completed', { requestId, userId, deviceUuid: validatedUuid, userCustomerId });

    res.json({
      message: 'API key emergency revocation complete',
      data: {
        agent_uuid: validatedUuid,
        revoked_at: new Date().toISOString()
      }
    });

  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid emergency revocation parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid request parameters', requestId });
    }
    logger.error('Emergency revocation error', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

export default router;
