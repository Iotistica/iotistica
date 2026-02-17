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
import { generateDefaultTargetState } from '../services/default-target-state-generator.js';
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

    // Resolve fleet UUID from identifier
    const fleetResult = await query(
      'SELECT fleet_uuid FROM fleets WHERE fleet_uuid::text = $1',
      [fleetId]
    );
    
    if (fleetResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found',
        message: `Fleet with identifier '${fleetId}' does not exist. Create the fleet first.`
      });
    }
    
    const fleetUuid = fleetResult.rows[0].fleet_uuid;
    logger.info(`Resolved fleet UUID: ${fleetUuid}`);

    const { id, key } = await createProvisioningKey(
      fleetUuid,
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

    // Resolve fleet UUID from identifier (could be UUID or legacy fleet_id)
    const fleetResult = await query(
      'SELECT fleet_uuid FROM fleets WHERE fleet_uuid::text = $1 OR fleet_id = $1',
      [fleetId]
    );
    
    if (fleetResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found',
        message: `Fleet with identifier '${fleetId}' does not exist.`
      });
    }
    
    const fleetUuid = fleetResult.rows[0].fleet_uuid;

    const keys = await listProvisioningKeys(fleetUuid);

    // Remove sensitive data before sending
    const sanitizedKeys = keys.map(k => ({
      id: k.id,
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
 * - deploymentType: Deployment type ('k8s-fleet' | 'edge-device' | 'standalone') (optional)
 * - metadata: Additional metadata about the deployment (optional)
 * - simulatorConfig: Simulator configuration for K8s fleet deployments (optional)
 *   - modbus: { count: number, startPort: number, host: string, profile?: string }
 *   - opcua: { count: number, startPort: number, host: string }
 *   - snmp: { ipRanges: string[] }
 * 
 * Returns:
 * - id: Key ID
 * - key: Provisioning key (64-char hex, only shown once)
 * - expiresAt: Expiration timestamp
 * - deploymentType: Echo back deployment type (if provided)
 * - simulatorConfig: Echo back simulator config (if provided)
 */
router.post('/provisioning-keys/generate', async (req, res) => {
  try {
    const { 
      fleetId = 'default-fleet', 
      newKey = false, 
      previousKeyId,
      deploymentType,
      metadata,
      simulatorConfig
    } = req.body;

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

    // Resolve fleet UUID from identifier
    const fleetResult = await query(
      'SELECT fleet_uuid, fleet_name FROM fleets WHERE fleet_uuid::text = $1',
      [fleetId]
    );
    
    if (fleetResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Fleet not found',
        message: `Fleet with identifier '${fleetId}' does not exist. Create the fleet first.`
      });
    }
    
    const fleetUuid = fleetResult.rows[0].fleet_uuid;
    const fleetName = fleetResult.rows[0].fleet_name;
    logger.info(`Resolved fleet for virtual agent: ${fleetName} (${fleetUuid})`);

    // Create new provisioning key (1 device, 30 days expiry)
    const { id, key } = await createProvisioningKey(
      fleetUuid,
      1, // maxDevices - single device
      30, // expiresInDays - 30 days
      'Dashboard-generated provisioning key',
      'dashboard-user' // TODO: Replace with actual authenticated user
    );

    // Store simulator config and deployment metadata if provided (optional - backward compatible)
    if (deploymentType || simulatorConfig || metadata) {
      try {
        // Update the existing provisioning key with metadata (columns may not exist in older deployments)
        await query(
          `UPDATE provisioning_keys 
           SET deployment_type = $1,
               simulator_config = $2,
               metadata = $3
           WHERE id = $4`,
          [
            deploymentType || null,
            simulatorConfig ? JSON.stringify(simulatorConfig) : null,
            metadata ? JSON.stringify(metadata) : null,
            id
          ]
        );
        logger.info(`Stored simulator config for provisioning key ${id}`, { deploymentType, simulatorConfig });
      } catch (metadataError: any) {
        // Non-fatal error - columns may not exist yet or other DB issue
        // Provisioning key generation still succeeds
        logger.warn(`Failed to store provisioning metadata for key ${id} (columns may not exist):`, metadataError.message);
      }
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    logger.info(`Single-device provisioning key generated: ${id}`, { deploymentType });

    const response: any = {
      id,
      key,
      expiresAt: expiresAt.toISOString(),
      warning: 'Store this key securely - it cannot be retrieved again!'
    };

    // Echo back deployment config for verification
    if (deploymentType) {
      response.deploymentType = deploymentType;
    }
    if (simulatorConfig) {
      response.simulatorConfig = simulatorConfig;
    }

    res.status(201).json(response);
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
 * Issue a PoP challenge to device
 * POST /api/v1/device/:uuid/challenge
 * 
 * Phase 2a: Challenge issuance for proof-of-possession
 * - Generates cryptographically secure nonce
 * - Stores challenge with 5-minute TTL
 * - Device signs this challenge to prove it owns the private key
 * 
 * Security Features:
 * - Cryptographically secure random nonce (32 bytes)
 * - Short-lived challenge (5 minutes)
 * - Replay protection via expiration
 */
router.post('/device/:uuid/challenge', async (req, res) => {
  const { uuid } = req.params;
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    // Verify device exists
    const device = await DeviceModel.getByUuid(uuid);
    
    if (!device) {
      await logAuditEvent({
        eventType: AuditEventType.AUTHENTICATION_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Device not found', endpoint: 'challenge' }
      });
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not registered`
      });
    }

    // Generate cryptographically secure nonce
    const challenge = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    logger.info('Generating new PoP challenge', {
      deviceUuid: uuid.substring(0, 8) + '...',
      deviceName: device.device_name,
      challengeLength: challenge.length,
      expiresAt: expiresAt.toISOString(),
      hasPublicKey: !!device.device_public_key,
      currentlyVerified: device.pop_verified
    });

    // Store challenge for verification
    await DeviceModel.storeChallenge(uuid, challenge, expiresAt);

    logger.info('PoP challenge stored and issued to device', {
      deviceUuid: uuid.substring(0, 8) + '...',
      deviceName: device.device_name,
      expiresAt: expiresAt.toISOString()
    });

    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_SUCCESS, // Reusing event type
      deviceUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.INFO,
      details: { 
        action: 'challenge_issued',
        expiresAt: expiresAt.toISOString()
      }
    });

    res.json({
      challenge,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error: any) {
    logger.error('Error issuing PoP challenge:', error);
    
    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_FAILED,
      deviceUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.ERROR,
      details: { error: error.message, endpoint: 'challenge' }
    });

    res.status(500).json({
      error: 'Challenge issuance failed',
      message: error.message
    });
  }
});

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
    const { uuid, deviceName, deviceType, deviceApiKey, devicePublicKey, macAddress, osVersion, agentVersion } = req.body;
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

    // Validate devicePublicKey format if provided (for PoP)
    if (devicePublicKey) {
      logger.info('Received device registration with public key', {
        uuid: uuid?.substring(0, 8) + '...',
        publicKeyLength: devicePublicKey.length,
        hasBeginMarker: devicePublicKey.includes('BEGIN PUBLIC KEY'),
        hasEndMarker: devicePublicKey.includes('END PUBLIC KEY')
      });
      
      if (!devicePublicKey.includes('BEGIN PUBLIC KEY') || !devicePublicKey.includes('END PUBLIC KEY')) {
        logger.warn('Invalid public key format received', {
          uuid: uuid?.substring(0, 8) + '...',
          publicKeyLength: devicePublicKey.length,
          preview: devicePublicKey.substring(0, 50)
        });
        
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_FAILED,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Invalid public key format (must be PEM)', uuid: uuid?.substring(0, 8) }
        });
        return res.status(400).json({
          error: 'Invalid public key format',
          message: 'devicePublicKey must be in PEM format'
        });
      }
    } else {
      logger.info('Device registration without public key (legacy mode)', {
        uuid: uuid?.substring(0, 8) + '...'
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
        devicePublicKey,
        provisioningApiKey,
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
 * Phase 2b of two-phase authentication:
 * - Verifies proof-of-possession signature (preferred)
 * - Falls back to deviceApiKey bcrypt verification (legacy)
 * - Rate limited (50 attempts per hour)
 * - Logs all authentication events
 * 
 * Security Features:
 * - Asymmetric PoP with Ed25519/P-256 signatures
 * - Challenge expiration and replay protection
 * - Fallback to bcrypt for backward compatibility
 * - Rate limiting to prevent brute force attacks
 * - Comprehensive audit logging
 * - No sensitive information in error messages
 */
router.post('/device/:uuid/key-exchange', keyExchangeLimiter, async (req, res) => {
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const { uuid } = req.params;
    const { deviceApiKey, signature } = req.body;
    const authKey = req.headers.authorization?.replace('Bearer ', '');

    // PoP mode: requires signature (deviceApiKey not needed)
    // Bcrypt fallback: requires deviceApiKey
    const isPopMode = !!signature;
    
    if (!authKey) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing Authorization header' }
      });
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'Authorization header required'
      });
    }

    if (!isPopMode && !deviceApiKey) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        deviceUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing deviceApiKey for bcrypt fallback' }
      });
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'deviceApiKey required in body for bcrypt authentication'
      });
    }

    logger.info('Key exchange request received', {
      deviceUuid: uuid.substring(0, 8) + '...',
      hasSignature: !!signature
    });

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

    // ========================================================================
    // PROOF OF POSSESSION: Verify signature if public key and signature provided
    // ========================================================================
    if (device.device_public_key && signature) {
      logger.info('Attempting PoP verification with signature', {
        deviceUuid: uuid.substring(0, 8) + '...',
        hasPublicKey: true,
        signatureLength: signature.length,
        hasChallenge: !!device.last_challenge,
        challengeExpiry: device.last_challenge_expires_at?.toISOString()
      });
      
      // Check challenge exists and not expired
      if (!device.last_challenge || !device.last_challenge_expires_at) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          deviceUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'No challenge found - call /challenge first' }
        });
        return res.status(401).json({
          error: 'No challenge found',
          message: 'Request a challenge from /device/:uuid/challenge first'
        });
      }

      if (device.last_challenge_expires_at < new Date()) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          deviceUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Challenge expired' }
        });
        return res.status(401).json({
          error: 'Challenge expired',
          message: 'Challenge has expired - request a new one'
        });
      }

      // Verify signature using public key
      try {
        logger.info('Verifying PoP signature', {
          deviceUuid: uuid.substring(0, 8) + '...',
          challengeLength: device.last_challenge.length,
          signatureLength: signature.length,
          publicKeyLength: device.device_public_key.length
        });
        
        // 🔐 HARDENING: Enforce public key algorithm allowlist
        // Only allow Ed25519 or ECDSA P-256 (reject weak RSA, algorithm downgrades)
        const publicKeyObject = crypto.createPublicKey({
          key: device.device_public_key,
          format: 'pem'
        });
        
        const allowedAlgorithms = ['ed25519', 'ec'];
        const keyType = publicKeyObject.asymmetricKeyType;
        
        if (!allowedAlgorithms.includes(keyType)) {
          logger.warn('Rejecting disallowed public key algorithm', {
            deviceUuid: uuid.substring(0, 8) + '...',
            algorithm: keyType,
            allowed: allowedAlgorithms
          });
          
          await logAuditEvent({
            eventType: AuditEventType.AUTHENTICATION_FAILED,
            deviceUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: `Disallowed key algorithm: ${keyType}. Only Ed25519 and ECDSA P-256 allowed.` }
          });
          
          return res.status(401).json({
            error: 'Invalid key algorithm',
            message: 'Device public key must use Ed25519 or ECDSA P-256'
          });
        }
        
        // For EC keys, additionally verify it's P-256 (not P-384, P-521, etc.)
        if (keyType === 'ec') {
          const keyDetails = publicKeyObject.asymmetricKeyDetails;
          if (keyDetails?.namedCurve !== 'prime256v1' && keyDetails?.namedCurve !== 'P-256') {
            logger.warn('Rejecting ECDSA key with non-P-256 curve', {
              deviceUuid: uuid.substring(0, 8) + '...',
              curve: keyDetails?.namedCurve
            });
            
            await logAuditEvent({
              eventType: AuditEventType.AUTHENTICATION_FAILED,
              deviceUuid: uuid,
              ipAddress,
              userAgent,
              severity: AuditSeverity.WARNING,
              details: { reason: `ECDSA key must use P-256 curve, got ${keyDetails?.namedCurve}` }
            });
            
            return res.status(401).json({
              error: 'Invalid key curve',
              message: 'ECDSA key must use P-256 curve'
            });
          }
        }
        
        // Bind device UUID to signature payload to prevent cross-device replay
        // Client signs: uuid:challenge
        // Server verifies: same payload construction
        const payload = `${uuid}:${device.last_challenge}`;
        
        const isValid = crypto.verify(
          null, // Algorithm detected from key
          Buffer.from(payload, 'utf-8'),
          device.device_public_key,
          Buffer.from(signature, 'base64')
        );

        logger.info('Signature verification result', {
          deviceUuid: uuid.substring(0, 8) + '...',
          isValid,
          payloadLength: payload.length
        });

        if (!isValid) {
          await logAuditEvent({
            eventType: AuditEventType.AUTHENTICATION_FAILED,
            deviceUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: 'Invalid signature - proof of possession failed' }
          });
          return res.status(401).json({
            error: 'Proof of possession failed',
            message: 'Invalid signature'
          });
        }

        // ✅ PoP verified - invalidate challenge immediately (single-use)
        // Set challenge expiry to now to prevent replay
        logger.info('Invalidating challenge after successful PoP verification', {
          deviceUuid: uuid.substring(0, 8) + '...',
          reason: 'single-use challenge enforcement'
        });
        
        await DeviceModel.storeChallenge(uuid, null, new Date()); // Expire challenge immediately

        // Mark device as PoP verified
        logger.info('Marking device as PoP verified', {
          deviceUuid: uuid.substring(0, 8) + '...',
          deviceName: device.device_name
        });
        
        await DeviceModel.markPopVerified(uuid);
        
        // Record authentication method for fleet-level policy enforcement
        await DeviceModel.recordAuthMethod(uuid, 'pop');

        logger.info('PoP verification successful and persisted', {
          deviceUuid: uuid.substring(0, 8) + '...',
          deviceName: device.device_name,
          authMethod: 'proof-of-possession'
        });

        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_SUCCESS,
          deviceUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.INFO,
          details: { 
            deviceName: device.device_name,
            authMethod: 'proof-of-possession'
          }
        });

        return res.json({
          status: 'ok',
          message: 'Proof of possession verified',
          device: {
            id: device.id,
            uuid: device.uuid,
            deviceName: device.device_name,
          }
        });
      } catch (verifyError: any) {
        logger.error('Signature verification error:', verifyError);
        
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          deviceUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.ERROR,
          details: { reason: 'Signature verification failed', error: verifyError.message }
        });

        return res.status(401).json({
          error: 'Signature verification failed',
          message: 'Invalid signature format or corrupted public key'
        });
      }
    }

    // ========================================================================
    // FALLBACK: Legacy bcrypt verification (for backward compatibility)
    // ========================================================================
    logger.warn('⚠️ Using LEGACY bcrypt verification (not PoP)', {
      deviceUuid: uuid.substring(0, 8) + '...',
      deviceName: device.device_name,
      hasPublicKey: !!device.device_public_key,
      hasSignature: !!signature,
      reason: !device.device_public_key ? 'device has no public key (not PoP-enabled)' : !signature ? 'no signature provided' : 'unknown',
      recommendation: 'Update agent to send devicePublicKey during registration for PoP authentication'
    });
    
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

    logger.info('Legacy key exchange successful (bcrypt)', {
      deviceUuid: uuid.substring(0, 8) + '...',
      deviceName: device.device_name
    });
    
    // Record authentication method for fleet-level policy enforcement
    // This allows future enforcement of PoP-only policies for high-security fleets
    await DeviceModel.recordAuthMethod(uuid, 'bcrypt');

    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_SUCCESS,
      deviceUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.INFO,
      details: { 
        deviceName: device.device_name,
        authMethod: 'bcrypt-fallback'
      }
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
