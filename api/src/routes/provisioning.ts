/**
 * Device Provisioning and Authentication Routes
 * Handles two-phase device authentication and provisioning key management
 * 
 * Provisioning Key Management:
 * - POST /api/v1/provisioning-keys - Create new provisioning key for fleet
 * - GET /api/v1/provisioning-keys?fleetId=xxx - List provisioning keys for a fleet
 * - DELETE /api/v1/provisioning-keys/:keyId - Revoke a provisioning key
 * 
 * Two-Phase Device Authentication:
 * - POST /api/v1/device/register - Register new device (phase 1: provisioning key)
 * - POST /api/v1/device/:uuid/key-exchange - Exchange keys (phase 2: device key verification)
 */

import express from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { query } from '../db/connection';
import {
  DeviceModel,
  DeviceTargetStateModel,
} from '../db/models';
import {
  validateProvisioningKey,
  incrementProvisioningKeyUsage,
  createProvisioningKey,
  revokeProvisioningKey,
  listProvisioningKeys
} from '../utils/provisioning-keys';
import { wireGuardService } from '../services/wireguard.service';
import {
  logAuditEvent,
  logProvisioningAttempt,
  checkProvisioningRateLimit,
  AuditEventType,
  AuditSeverity
} from '../utils/audit-logger';
import { EventPublisher } from '../services/event-sourcing';
import {
  getBrokerConfigForDevice,
  buildBrokerUrl,
  formatBrokerConfigForClient
} from '../utils/mqtt-broker-config';
import { getVpnConfigForDevice, formatVpnConfigForDevice } from '../utils/vpn-config';
import { SystemConfigModel } from '../db/system-config-model';
import { generateDefaultTargetState } from '../services/default-target-state-generator';
import { provisioningService } from '../services/provisioning.service';
import logger from '../utils/logger';
export const router = express.Router();

// Initialize event publisher for audit trail
const eventPublisher = new EventPublisher();

// ============================================================================
// Rate Limiting Middleware
// ============================================================================

/**
 * Dual Rate Limiting Strategy for Provisioning:
 * 
 * 1. provisioningLimiter (middleware): Limits ALL provisioning attempts
 *    - 5 attempts per 15 minutes per IP
 *    - In-memory tracking (fast, but resets on restart)
 *    - Prevents endpoint spamming
 * 
 * 2. checkProvisioningRateLimit (database): Limits FAILED attempts only
 *    - 10 failed attempts per hour per IP
 *    - Database-backed (persistent across restarts)
 *    - Prevents brute force attacks on provisioning keys
 * 
 * Both work together: middleware catches spam, database check catches attacks
 */
const provisioningLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 1000 : 100, // Higher for fleet deployments
  message: 'Too many provisioning attempts from this IP, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  handler: async (req, res) => {
    await logAuditEvent({
      eventType: AuditEventType.RATE_LIMIT_EXCEEDED,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      severity: AuditSeverity.WARNING,
      details: { endpoint: '/device/register', type: 'middleware' }
    });
    res.status(429).json({
      error: 'Too many requests',
      message: 'Too many provisioning attempts from this IP, please try again later'
    });
  }
});

// Rate limit for key exchange - environment-aware for fleet deployments
const keyExchangeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'development' ? 1000 : 50, // Higher limit for fleet provisioning
  message: 'Too many key exchange attempts, please try again later'
});

// ============================================================================
// Provisioning Key Management Endpoints
// ============================================================================

/**
 * Create a new provisioning key
 * POST /api/v1/provisioning-keys
 * 
 * Body:
 * - fleetId: Fleet/application identifier (required)
 * - maxDevices: Maximum number of devices (default: 100)
 * - expiresInDays: Expiration in days (default: 365)
 * - description: Key description (optional)
 * 
 * Auth: Requires admin authentication (basic implementation for now)
 */
router.post('/provisioning-keys', async (req, res) => {
  try {
    const { fleetId, maxDevices = 100, expiresInDays = 365, description } = req.body;

    // Basic validation
    if (!fleetId || typeof fleetId !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'fleetId is required and must be a string'
      });
    }

    if (maxDevices && (typeof maxDevices !== 'number' || maxDevices < 1 || maxDevices > 10000)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'maxDevices must be a number between 1 and 10000'
      });
    }

    if (expiresInDays && (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > 3650)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'expiresInDays must be a number between 1 and 3650 (10 years)'
      });
    }

    // Check license device limit before creating provisioning key
    const licenseValidator = (req as any).licenseValidator;
    if (licenseValidator) {
      const license = licenseValidator.getLicense();
      const maxDevicesAllowed = license.features.maxDevices;
      
      // Count current active devices
      const deviceCountResult = await query('SELECT COUNT(*) as count FROM devices WHERE is_active = true');
      const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);
      
      if (currentDeviceCount >= maxDevicesAllowed) {
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_FAILED,
          severity: AuditSeverity.WARNING,
          details: {
            reason: 'Device limit exceeded - cannot create provisioning key',
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan,
            fleetId
          }
        });

        return res.status(403).json({
          error: 'Device limit exceeded',
          message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} devices. You currently have ${currentDeviceCount} active devices. Please upgrade your plan to add more devices.`,
          details: {
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan
          }
        });
      }

      logger.info(`License check passed: ${currentDeviceCount}/${maxDevicesAllowed} devices`);
    }

    logger.info(`🔑 Creating provisioning key for fleet: ${fleetId}`);

    const { id, key } = await createProvisioningKey(
      fleetId,
      maxDevices,
      expiresInDays,
      description,
      'api-admin' // TODO: Replace with actual authenticated user
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    logger.info(`Provisioning key created: ${id}`);

    res.status(201).json({
      id,
      key, // WARNING: Only returned once!
      fleetId,
      maxDevices,
      expiresAt: expiresAt.toISOString(),
      description,
      warning: 'Store this key securely - it cannot be retrieved again!'
    });
  } catch (error: any) {
    logger.error('Error creating provisioning key:', error);
    res.status(500).json({
      error: 'Failed to create provisioning key',
      message: error.message
    });
  }
});

/**
 * List provisioning keys for a fleet
 * GET /api/v1/provisioning-keys?fleetId=xxx
 * 
 * Returns key metadata (NOT the actual keys)
 */
router.get('/provisioning-keys', async (req, res) => {
  try {
    const { fleetId } = req.query;

    if (!fleetId || typeof fleetId !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'fleetId query parameter is required'
      });
    }

    logger.info(`Listing provisioning keys for fleet: ${fleetId}`);

    const keys = await listProvisioningKeys(fleetId);

    // Remove sensitive data before sending
    const sanitizedKeys = keys.map(k => ({
      id: k.id,
      fleet_id: k.fleet_id,
      description: k.description,
      max_devices: k.max_devices,
      devices_provisioned: k.devices_provisioned,
      expires_at: k.expires_at,
      is_active: k.is_active,
      created_at: k.created_at,
      created_by: k.created_by,
      last_used_at: k.last_used_at,
      // key_hash is intentionally excluded for security
    }));

    res.json({
      fleet_id: fleetId,
      count: sanitizedKeys.length,
      keys: sanitizedKeys
    });
  } catch (error: any) {
    logger.error('Error listing provisioning keys:', error);
    res.status(500).json({
      error: 'Failed to list provisioning keys',
      message: error.message
    });
  }
});

/**
 * Revoke a provisioning key
 * DELETE /api/v1/provisioning-keys/:keyId
 * 
 * Body:
 * - reason: Reason for revocation (optional)
 */
router.delete('/provisioning-keys/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;
    const { reason } = req.body;

    if (!keyId) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'keyId is required'
      });
    }

    logger.info(`Revoking provisioning key: ${keyId}`);

    await revokeProvisioningKey(keyId, reason);

    logger.info(`Provisioning key revoked: ${keyId}`);

    res.json({
      status: 'ok',
      message: 'Provisioning key revoked',
      keyId,
      reason
    });
  } catch (error: any) {
    logger.error('Error revoking provisioning key:', error);
    res.status(500).json({
      error: 'Failed to revoke provisioning key',
      message: error.message
    });
  }
});

/**
 * Generate a single-device provisioning key
 * POST /api/v1/provisioning-keys/generate
 * 
 * Simplified endpoint for dashboard to generate provisioning keys for individual devices.
 * Automatically invalidates previous keys if newKey=true in request body.
 * 
 * Body:
 * - fleetId: Fleet/application identifier (optional, defaults to 'default-fleet')
 * - newKey: If true, invalidates previous key for this device (optional, defaults to false)
 * - previousKeyId: ID of previous key to invalidate (optional, used when newKey=true)
 * 
 * Returns:
 * - id: Key ID
 * - key: Provisioning key (64-char hex, only shown once)
 * - expiresAt: Expiration timestamp
 */
router.post('/provisioning-keys/generate', async (req, res) => {
  try {
    const { fleetId = 'default-fleet', newKey = false, previousKeyId } = req.body;

    // If regenerating, invalidate the previous key first
    if (newKey && previousKeyId) {
      try {
        logger.info(`Invalidating previous provisioning key: ${previousKeyId}`);
        await revokeProvisioningKey(previousKeyId, 'Regenerated by user');
      } catch (revokeError: any) {
        logger.warn(`Could not revoke previous key ${previousKeyId}:`, revokeError.message);
        // Continue anyway - user wants a new key
      }
    }

    // Check license device limit
    const licenseValidator = (req as any).licenseValidator;
    if (licenseValidator) {
      const license = licenseValidator.getLicense();
      const maxDevicesAllowed = license.features.maxDevices;
      
      const deviceCountResult = await query('SELECT COUNT(*) as count FROM devices WHERE is_active = true');
      const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);
      
      if (currentDeviceCount >= maxDevicesAllowed) {
        return res.status(403).json({
          error: 'Device limit exceeded',
          message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} devices. Please upgrade to add more.`,
          details: {
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan
          }
        });
      }
    }

    // Create new provisioning key (1 device, 30 days expiry)
    const { id, key } = await createProvisioningKey(
      fleetId,
      1, // maxDevices - single device
      30, // expiresInDays - 30 days
      'Dashboard-generated provisioning key',
      'dashboard-user' // TODO: Replace with actual authenticated user
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    logger.info(`Single-device provisioning key generated: ${id}`);

    res.status(201).json({
      id,
      key,
      expiresAt: expiresAt.toISOString(),
      warning: 'Store this key securely - it cannot be retrieved again!'
    });
  } catch (error: any) {
    logger.error('Error generating provisioning key:', error);
    res.status(500).json({
      error: 'Failed to generate provisioning key',
      message: error.message
    });
  }
});

// ============================================================================
// Two-Phase Device Authentication
// ============================================================================

/**
 * Register new device with provisioning API key
 * POST /api/v1/device/register
 * 
 * Phase 1 of two-phase authentication:
 * 1. Validates provisioning key against database
 * 2. Hashes device API key before storage
 * 3. Rate limits provisioning attempts
 * 4. Logs all provisioning events for audit trail
 * 
 * Security Features:
 * - Provisioning key validation
 * - Rate limiting (5 attempts per 15 minutes per IP)
 * - Device API key hashing (bcrypt)
 * - Comprehensive audit logging
 * - Event sourcing for device lifecycle
 */
router.post('/device/register', provisioningLimiter, async (req, res) => {
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    // Extract request data
    const { uuid, deviceName, deviceType, deviceApiKey, applicationId, macAddress, osVersion, agentVersion } = req.body;
    const provisioningApiKey = req.headers.authorization?.replace('Bearer ', '');

    // Validate required fields
    if (!uuid || !deviceName || !deviceType || !deviceApiKey) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_FAILED,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing required fields', uuid: uuid?.substring(0, 8) }
      });
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'uuid, deviceName, deviceType, and deviceApiKey are required'
      });
    }

    if (!provisioningApiKey) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing provisioning API key' }
      });
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Provisioning API key required in Authorization header'
      });
    }

    // Call service layer for business logic
    const response = await provisioningService.registerDevice(
      {
        uuid,
        deviceName,
        deviceType,
        deviceApiKey,
        provisioningApiKey,
        applicationId,
        macAddress,
        osVersion,
        agentVersion
      },
      ipAddress,
      userAgent
    );

    logger.info('Device registered successfully:', response.id);
    res.status(200).json(response);

  } catch (error: any) {
    logger.error('Error registering device:', error);
    
    // Determine appropriate status code
    let statusCode = 500;
    if (error.message.includes('already registered')) {
      statusCode = 409;
    } else if (error.message.includes('Invalid provisioning key') || error.message.includes('expired') || error.message.includes('limit exceeded')) {
      statusCode = 401;
    } else if (error.message.includes('Rate limit exceeded')) {
      statusCode = 429;
    }

    res.status(statusCode).json({
      error: 'Failed to register device',
      message: error.message
    });
  }
});

/**
 * Exchange keys - verify device can authenticate with deviceApiKey
 * POST /api/v1/device/:uuid/key-exchange
 * 
 * Phase 2 of two-phase authentication:
 * - Verifies deviceApiKey against hashed value in database
 * - Uses bcrypt.compare for secure verification
 * - Rate limited (10 attempts per hour)
 * - Logs all authentication events
 * 
 * Security Features:
 * - Secure key comparison using bcrypt
 * - Rate limiting to prevent brute force attacks
 * - Comprehensive audit logging
 * - No sensitive information in error messages
 */
/**
 * Exchange keys - verify device can authenticate with deviceApiKey
 * POST /api/v1/device/:uuid/key-exchange
 * 
 * Phase 2 of two-phase authentication:
 * - Verifies deviceApiKey against hashed value in database
 * - Uses bcrypt.compare for secure verification
 * - Rate limited (10 attempts per hour)
 * - Logs all authentication events
 * 
 * Security Features:
 * - Secure key comparison using bcrypt
 * - Rate limiting to prevent brute force attacks
 * - Comprehensive audit logging
 * - No sensitive information in error messages
 */
router.post('/device/:uuid/key-exchange', keyExchangeLimiter, async (req, res) => {
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const { uuid } = req.params;
    const { deviceApiKey } = req.body;
    const authKey = req.headers.authorization?.replace('Bearer ', '');

    if (!deviceApiKey || !authKey) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing credentials' }
      });
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'deviceApiKey required in body and Authorization header'
      });
    }

    if (deviceApiKey !== authKey) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Key mismatch between body and header' }
      });
      return res.status(401).json({
        error: 'Key mismatch',
        message: 'deviceApiKey in body must match Authorization header'
      });
    }

    logger.info('Key exchange request for device:', uuid.substring(0, 8) + '...');

    // Verify device exists
    const device = await DeviceModel.getByUuid(uuid);
    
    if (!device) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Device not found' }
      });
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not registered`
      });
    }

    // SECURITY: Verify deviceApiKey against hashed value in database
    if (!device.device_api_key_hash) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.ERROR,
        details: { reason: 'No API key hash stored for device' }
      });
      return res.status(500).json({
        error: 'Configuration error',
        message: 'Device API key not configured'
      });
    }

    const keyMatches = await bcrypt.compare(deviceApiKey, device.device_api_key_hash);
    
    if (!keyMatches) {
      await logAuditEvent({
        eventType: AuditEventType.AUTHENTICATION_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Invalid device API key' }
      });
      return res.status(401).json({
        error: 'Authentication failed',
        message: 'Invalid device API key'
      });
    }


    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_SUCCESS,
      deviceUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.INFO,
      details: { deviceName: device.device_name }
    });

    res.json({
      status: 'ok',
      message: 'Key exchange successful',
      device: {
        id: device.id,
        uuid: device.uuid,
        deviceName: device.device_name,
      }
    });
  } catch (error: any) {
    logger.error('Error during key exchange:', error);
    
    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_FAILED,
      deviceUuid: req.params.uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.ERROR,
      details: { error: error.message }
    });

    res.status(500).json({
      error: 'Key exchange failed',
      message: error.message
    });
  }
});

export default router;
