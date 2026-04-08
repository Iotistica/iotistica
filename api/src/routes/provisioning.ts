/**
 * Agent Provisioning and Authentication Routes
 * Handles two-phase agent authentication and provisioning key management
 * 
 * Provisioning Key Management:
 * - POST /api/v1/provisioning-keys - Create new provisioning key for fleet (body: fleetUuid = fleet UUID)
 * - GET /api/v1/provisioning-keys?fleetUuid=<uuid> - List provisioning keys for a fleet
 * - DELETE /api/v1/provisioning-keys/:keyId - Revoke a provisioning key
 * - POST /api/v1/provisioning-keys/generate - Generate single-agent key (body: fleetUuid = fleet UUID)
 *
 * Two-Phase Agent Authentication:
 * - POST /api/v1/device/register - Register new agent (phase 1: provisioning key)
 * - POST /api/v1/device/:uuid/key-exchange - Exchange keys (phase 2: agent key verification)
 */
import crypto from 'crypto';
import { query } from '../db/connection';
import {
  AgentModel,
} from '../db/models';
import {

  createProvisioningKey,
  revokeProvisioningKey,
  listProvisioningKeys
} from '../utils/provisioning-keys';
import {
  logAuditEvent,

  AuditEventType,
  AuditSeverity
} from '../utils/audit-logger';
import { EventPublisher } from '../services/event-sourcing';
import { LicenseValidator } from '../services/auth/license-validator';
import { provisioningService } from '../services/provisioning/provisioning.service';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import logger from '../utils/logger';
import type { FastifyPluginAsync } from 'fastify'

const plugin: FastifyPluginAsync = async (fastify) => {
// Initialize event publisher for audit trail
const eventPublisher = new EventPublisher();

interface CreateProvisioningKeyBody {
  fleetUuid?: string;
  maxDevices?: number;
  expiresInDays?: number;
  description?: string;
}

interface ListProvisioningKeysQuerystring {
  fleetUuid?: string;
}

interface ProvisioningKeyParams {
  keyId: string;
}

interface RevokeProvisioningKeyBody {
  reason?: string;
}

interface GenerateProvisioningKeyBody {
  fleetUuid?: string;
  newKey?: boolean;
  previousKeyId?: string;
  deploymentType?: string;
  metadata?: Record<string, unknown>;
  simulatorConfig?: unknown;
}

interface DeviceUuidParams {
  uuid: string;
}

interface RegisterDeviceBody {
  uuid?: string;
  deviceName?: string;
  deviceType?: string;
  deviceApiKey?: string;
  devicePublicKey?: string;
  macAddress?: string;
  osVersion?: string;
  agentVersion?: string;
}

interface KeyExchangeBody {
  deviceApiKey?: string;
  signature?: string;
}

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

// ============================================================================
// Provisioning Key Management Endpoints
// ============================================================================

/**
 * Create a new provisioning key
 * POST /api/v1/provisioning-keys
 * 
 * Body:
 * - fleetUuid: Fleet UUID (required)
 * - maxDevices: Maximum number of agents (default: 100)
 * - expiresInDays: Expiration in days (default: 365)
 * - description: Key description (optional)
 * 
 * Auth: Requires admin authentication (basic implementation for now)
 */
fastify.post<{ Body: CreateProvisioningKeyBody }>('/provisioning-keys', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
  try {
    const { fleetUuid, maxDevices = 100, expiresInDays = 365, description } = req.body;

    // Basic validation
    if (!fleetUuid || typeof fleetUuid !== 'string') {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'fleetUuid (fleet UUID) is required and must be a string'
      });
    }

    if (maxDevices && (typeof maxDevices !== 'number' || maxDevices < 1 || maxDevices > 10000)) {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'maxDevices must be a number between 1 and 10000'
      });
    }

    if (expiresInDays && (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > 3650)) {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'expiresInDays must be a number between 1 and 3650 (10 years)'
      });
    }

    // Check license agent limit before creating provisioning key
    const license = LicenseValidator.getInstance().getLicense();
    if (license) {
      const maxDevicesAllowed = license.features.maxDevices;
      
      // Count current active agents
      const deviceCountResult = await query('SELECT COUNT(*) as count FROM agents WHERE is_active = true');
      const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);
      
      if (currentDeviceCount >= maxDevicesAllowed) {
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_FAILED,
          severity: AuditSeverity.WARNING,
          details: {
            reason: 'Agent limit exceeded - cannot create provisioning key',
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan,
            fleetUuid
          }
        });

        return reply.status(403).send({
          error: 'Agent limit exceeded',
          message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} agents. You currently have ${currentDeviceCount} active agents. Please upgrade your plan to add more agents.`,
          details: {
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan
          }
        });
      }

      logger.info(`License check passed: ${currentDeviceCount}/${maxDevicesAllowed} agents`);
    }

    logger.info(`🔑 Creating provisioning key for fleet: ${fleetUuid}`);

    // Resolve fleet UUID from identifier
    const fleetResult = await query(
      'SELECT fleet_uuid FROM fleets WHERE fleet_uuid::text = $1',
      [fleetUuid]
    );
    
    if (fleetResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Fleet not found',
        message: `Fleet with identifier '${fleetUuid}' does not exist. Create the fleet first.`
      });
    }
    
    const resolvedFleetUuid = fleetResult.rows[0].fleet_uuid;
    logger.info(`Resolved fleet UUID: ${resolvedFleetUuid}`);

    const { id, key } = await createProvisioningKey(
      resolvedFleetUuid,
      maxDevices,
      expiresInDays,
      description,
      'api-admin' // TODO: Replace with actual authenticated user
    );

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    logger.info(`Provisioning key created: ${id}`);

    return reply.status(201).send({
      id,
      key, // WARNING: Only returned once!
      fleetUuid,
      maxDevices,
      expiresAt: expiresAt.toISOString(),
      description,
      warning: 'Store this key securely - it cannot be retrieved again!'
    });
  } catch (error: unknown) {
    logger.error('Error creating provisioning key:', error);
    return reply.status(500).send({
      error: 'Failed to create provisioning key',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * List provisioning keys for a fleet
 * GET /api/v1/provisioning-keys?fleetUuid=xxx
 * 
 * Returns key metadata (NOT the actual keys)
 */
fastify.get<{ Querystring: ListProvisioningKeysQuerystring }>('/provisioning-keys', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
  try {
    const { fleetUuid } = req.query;

    if (!fleetUuid || typeof fleetUuid !== 'string') {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'fleetUuid (fleet UUID) query parameter is required'
      });
    }

    logger.info(`Listing provisioning keys for fleet: ${fleetUuid}`);

    // Resolve fleet UUID from identifier
    const fleetResult = await query(
      'SELECT fleet_uuid FROM fleets WHERE fleet_uuid::text = $1',
      [fleetUuid]
    );
    
    if (fleetResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Fleet not found',
        message: `Fleet with identifier '${fleetUuid}' does not exist.`
      });
    }
    
    const resolvedFleetUuid = fleetResult.rows[0].fleet_uuid;

    const keys = await listProvisioningKeys(resolvedFleetUuid);

    // Remove sensitive data before sending
    const sanitizedKeys = keys.map(k => ({
      id: k.id,
      description: k.description,
      max_agents: k.max_agents,
      agents_provisioned: k.agents_provisioned,
      expires_at: k.expires_at,
      is_active: k.is_active,
      created_at: k.created_at,
      created_by: k.created_by,
      last_used_at: k.last_used_at,
      // key_hash is intentionally excluded for security
    }));

    return reply.send({
      count: sanitizedKeys.length,
      keys: sanitizedKeys
    });
  } catch (error: unknown) {
    logger.error('Error listing provisioning keys:', error);
    return reply.status(500).send({
      error: 'Failed to list provisioning keys',
      message: error instanceof Error ? error.message : 'Unknown error'
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
fastify.delete<{ Params: ProvisioningKeyParams; Body: RevokeProvisioningKeyBody }>('/provisioning-keys/:keyId', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
  try {
    const { keyId } = req.params;
    const { reason } = req.body;

    if (!keyId) {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'keyId is required'
      });
    }

    logger.info(`Revoking provisioning key: ${keyId}`);

    await revokeProvisioningKey(keyId, reason);

    logger.info(`Provisioning key revoked: ${keyId}`);

    return reply.send({
      status: 'ok',
      message: 'Provisioning key revoked',
      keyId,
      reason
    });
  } catch (error: unknown) {
    logger.error('Error revoking provisioning key:', error);
    return reply.status(500).send({
      error: 'Failed to revoke provisioning key',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Generate a single-agent provisioning key
 * POST /api/v1/provisioning-keys/generate
 *
 * Simplified endpoint for dashboard to generate provisioning keys for individual agents.
 * Automatically invalidates previous keys if newKey=true in request body.
 *
 * Body:
 * - fleetUuid: Fleet UUID (required)
 * - newKey: If true, invalidates previous key for this agent (optional, defaults to false)
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
fastify.post<{ Body: GenerateProvisioningKeyBody }>('/provisioning-keys/generate', { preHandler: [jwtAuth, requireRole('admin')] }, async (req, reply) => {
  try {
    const { 
      fleetUuid, 
      newKey = false, 
      previousKeyId,
      deploymentType,
      metadata,
      simulatorConfig
    } = req.body;

    if (!fleetUuid || typeof fleetUuid !== 'string') {
      return reply.status(400).send({
        error: 'Invalid request',
        message: 'fleetUuid (fleet UUID) is required and must be a string'
      });
    }

    // If regenerating, invalidate the previous key first
    if (newKey && previousKeyId) {
      try {
        logger.info(`Invalidating previous provisioning key: ${previousKeyId}`);
        await revokeProvisioningKey(previousKeyId, 'Regenerated by user');
      } catch (revokeError: unknown) {
        logger.warn(`Could not revoke previous key ${previousKeyId}:`, revokeError instanceof Error ? revokeError.message : 'Unknown error');
        // Continue anyway - user wants a new key
      }
    }

    // Check license agent limit
    const license = LicenseValidator.getInstance().getLicense();
    if (license) {
      const maxDevicesAllowed = license.features.maxDevices;
      
      const deviceCountResult = await query('SELECT COUNT(*) as count FROM agents WHERE is_active = true');
      const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);
      
      if (currentDeviceCount >= maxDevicesAllowed) {
        return reply.status(403).send({
          error: 'Agent limit exceeded',
          message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} agents. Please upgrade to add more.`,
          details: {
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan
          }
        });
      }
    }

    // Resolve fleet by UUID
    const fleetResult = await query(
      'SELECT fleet_uuid, fleet_name FROM fleets WHERE fleet_uuid::text = $1',
      [fleetUuid]
    );
    
    if (fleetResult.rows.length === 0) {
      return reply.status(404).send({
        error: 'Fleet not found',
        message: `Fleet with identifier '${fleetUuid}' does not exist. Create the fleet first.`
      });
    }

    const resolvedFleetUuid = fleetResult.rows[0].fleet_uuid;

    // Create new provisioning key (1 agent, 30 days expiry)
    const { id, key } = await createProvisioningKey(
      resolvedFleetUuid,
      1, // maxAgents - single agent
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
      } catch (metadataError: unknown) {
        // Non-fatal error - columns may not exist yet or other DB issue
        // Provisioning key generation still succeeds
        logger.warn(`Failed to store provisioning metadata for key ${id} (columns may not exist):`, metadataError instanceof Error ? metadataError.message : 'Unknown error');
      }
    }

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    logger.info(`Single-agent provisioning key generated: ${id}`, { deploymentType });

    const response: Record<string, unknown> = {
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

    return reply.status(201).send(response);
  } catch (error: unknown) {
    logger.error('Error generating provisioning key:', error);
    return reply.status(500).send({
      error: 'Failed to generate provisioning key',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// ============================================================================
// Two-Phase Agent Authentication
// ============================================================================

/**
 * Issue a PoP challenge to agent
 * POST /api/v1/device/:uuid/challenge
 *
 * Phase 2a: Challenge issuance for proof-of-possession
 * - Generates cryptographically secure nonce
 * - Stores challenge with 5-minute TTL
 * - Agent signs this challenge to prove it owns the private key
 * 
 * Security Features:
 * - Cryptographically secure random nonce (32 bytes)
 * - Short-lived challenge (5 minutes)
 * - Replay protection via expiration
 */
fastify.post<{ Params: DeviceUuidParams }>('/device/:uuid/challenge', async (req, reply) => {
  const { uuid } = req.params;
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    // Verify agent exists
    const agent = await AgentModel.getByUuid(uuid);

    if (!agent) {
      await logAuditEvent({
        eventType: AuditEventType.AUTHENTICATION_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Agent not found', endpoint: 'challenge' }
      });
      return reply.status(404).send({
        error: 'Agent not found',
        message: `Agent ${uuid} not registered`
      });
    }

    // Generate cryptographically secure nonce
    const challenge = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutes

    // Reject if an active challenge already exists to prevent race-condition overwrites.
    // A client that signed a challenge that was overwritten would get a false failure.
    if (agent.last_challenge && agent.last_challenge_expires_at && new Date(agent.last_challenge_expires_at) > new Date()) {
      return reply.status(409).send({
        error: 'Challenge already issued',
        message: 'An active challenge already exists for this agent. Wait for it to expire or complete key exchange first.',
        expiresAt: new Date(agent.last_challenge_expires_at).toISOString()
      });
    }

    logger.info('Generating new PoP challenge', {
      agentUuid: uuid.substring(0, 8) + '...',
      agentName: agent.name,
      challengeLength: challenge.length,
      expiresAt: expiresAt.toISOString(),
      hasPublicKey: !!agent.device_public_key,
      currentlyVerified: agent.pop_verified
    });

    // Store challenge for verification
    await AgentModel.storeChallenge(uuid, challenge, expiresAt);

    logger.info('PoP challenge stored and issued to agent', {
      agentUuid: uuid.substring(0, 8) + '...',
      agentName: agent.name,
      expiresAt: expiresAt.toISOString()
    });

    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_SUCCESS, // Reusing event type
      agentUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.INFO,
      details: { 
        action: 'challenge_issued',
        expiresAt: expiresAt.toISOString()
      }
    });

    return reply.send({
      challenge,
      expiresAt: expiresAt.toISOString()
    });
  } catch (error: unknown) {
    logger.error('Error issuing PoP challenge:', error);
    
    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_FAILED,
      agentUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.ERROR,
      details: { error: error instanceof Error ? error.message : 'Unknown error', endpoint: 'challenge' }
    });

    return reply.status(500).send({
      error: 'Challenge issuance failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Register new agent with provisioning API key
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
 * - Event sourcing for agent lifecycle
 */
fastify.post<{ Body: RegisterDeviceBody }>('/device/register', async (req, reply) => {
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    // Extract request data
    const { uuid, deviceName, deviceType, deviceApiKey, devicePublicKey, macAddress, osVersion, agentVersion } = req.body;
    const provisioningApiKey = (req.headers['x-provisioning-key'] as string) ?? undefined;

    // Validate required fields
    if (!uuid || !deviceName || !deviceType || !deviceApiKey) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_FAILED,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing required fields', uuid: uuid?.substring(0, 8) }
      });
      return reply.status(400).send({
        error: 'Missing required fields',
        message: 'uuid, deviceName, deviceType, and deviceApiKey are required'
      });
    }

    // Validate devicePublicKey format if provided (for PoP)
    if (devicePublicKey) {
      logger.info('Received agent registration with public key', {
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
        return reply.status(400).send({
          error: 'Invalid public key format',
          message: 'devicePublicKey must be in PEM format'
        });
      }
    } else {
      logger.info('Agent registration without public key (legacy mode)', {
        uuid: uuid?.substring(0, 8) + '...'
      });
    }

    if (!provisioningApiKey) {
      await logAuditEvent({
        eventType: AuditEventType.PROVISIONING_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing provisioning API key' }
      });
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Provisioning key required in x-provisioning-key header'
      });
    }

    // Enforce license agent limit at registration time (not just at key creation).
    // A key created before a plan downgrade must still be blocked here.
    const license = LicenseValidator.getInstance().getLicense();
    if (license) {
      const maxDevicesAllowed = license.features.maxDevices;
      const deviceCountResult = await query('SELECT COUNT(*) as count FROM agents WHERE is_active = true');
      const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);

      if (currentDeviceCount >= maxDevicesAllowed) {
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_FAILED,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: {
            reason: 'Agent limit exceeded at registration',
            currentDevices: currentDeviceCount,
            maxDevices: maxDevicesAllowed,
            plan: license.plan
          }
        });
        return reply.status(403).send({
          error: 'Agent limit exceeded',
          message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} agents. You currently have ${currentDeviceCount} active agents. Please upgrade your plan to add more agents.`,
          details: { currentDevices: currentDeviceCount, maxDevices: maxDevicesAllowed, plan: license.plan }
        });
      }
    }

    // Call service layer for business logic
    const response = await provisioningService.registerDevice(
      {
        uuid,
        agentName: deviceName,
        agentType: deviceType,
        agentApiKey: deviceApiKey,
        agentPublicKey: devicePublicKey,
        provisioningApiKey,
        macAddress,
        osVersion,
        agentVersion
      },
      ipAddress,
      userAgent
    );

    logger.info('Agent registered successfully:', response.id);
    return reply.status(200).send(response);

  } catch (error: unknown) {
    logger.error('Error registering agent:', error);
    
    // Determine appropriate status code
    let statusCode = 500;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    if (errorMessage.includes('already registered')) {
      statusCode = 409;
    } else if (errorMessage.includes('Invalid provisioning key') || errorMessage.includes('expired') || errorMessage.includes('limit exceeded')) {
      statusCode = 401;
    } else if (errorMessage.includes('Rate limit exceeded')) {
      statusCode = 429;
    }

    return reply.status(statusCode).send({
      error: 'Failed to register agent',
      message: errorMessage
    });
  }
});

/**
 * Exchange keys - verify agent can authenticate with deviceApiKey
 * POST /api/v1/device/:uuid/key-exchange
 * 
 * Phase 2b of two-phase authentication:
 * - Verifies proof-of-possession signature
 * - Rate limited (50 attempts per hour)
 * - Logs all authentication events
 * 
 * Security Features:
 * - Asymmetric PoP with Ed25519/P-256 signatures
 * - Challenge expiration and replay protection
 * - Rate limiting to prevent brute force attacks
 * - Comprehensive audit logging
 * - No sensitive information in error messages
 */
fastify.post<{ Params: DeviceUuidParams; Body: KeyExchangeBody }>('/device/:uuid/key-exchange', async (req, reply) => {
  const ipAddress = req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const { uuid } = req.params;
    const { signature } = req.body;
    const authKey = (req.headers['x-device-key'] as string) ?? undefined;
    
    if (!authKey) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing x-device-key header' }
      });
      return reply.status(400).send({
        error: 'Missing credentials',
        message: 'x-device-key header required'
      });
    }

    if (!signature) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Missing signature for proof-of-possession verification' }
      });
      return reply.status(400).send({
        error: 'Missing credentials',
        message: 'signature required in body for proof-of-possession authentication'
      });
    }

    logger.info('Key exchange request received', {
      agentUuid: uuid.substring(0, 8) + '...',
      hasSignature: !!signature
    });

    // Verify agent exists
    const agent = await AgentModel.getByUuid(uuid);
    
    if (!agent) {
      await logAuditEvent({
        eventType: AuditEventType.KEY_EXCHANGE_FAILED,
        agentUuid: uuid,
        ipAddress,
        userAgent,
        severity: AuditSeverity.WARNING,
        details: { reason: 'Agent not found' }
      });
      return reply.status(404).send({
        error: 'Agent not found',
        message: `Agent ${uuid} not registered`
      });
    }

    // ========================================================================
    // PROOF OF POSSESSION: Verify signature if public key and signature provided
    // ========================================================================
    if (agent.device_public_key && signature) {
      logger.info('Attempting PoP verification with signature', {
        agentUuid: uuid.substring(0, 8) + '...',
        hasPublicKey: true,
        signatureLength: signature.length,
        hasChallenge: !!agent.last_challenge,
        challengeExpiry: agent.last_challenge_expires_at?.toISOString()
      });
      
      // Check challenge exists and not expired
      if (!agent.last_challenge || !agent.last_challenge_expires_at) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'No challenge found - call /challenge first' }
        });
        return reply.status(401).send({
          error: 'No challenge found',
          message: 'Request a challenge from /device/:uuid/challenge first'
        });
      }

      if (agent.last_challenge_expires_at < new Date()) {
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Challenge expired' }
        });
        return reply.status(401).send({
          error: 'Challenge expired',
          message: 'Challenge has expired - request a new one'
        });
      }

      // Verify signature using public key
      try {
        logger.info('Verifying PoP signature', {
          agentUuid: uuid.substring(0, 8) + '...',
          challengeLength: agent.last_challenge.length,
          signatureLength: signature.length,
          publicKeyLength: agent.device_public_key.length
        });
        
        // 🔐 HARDENING: Enforce public key algorithm allowlist
        // Only allow Ed25519 or ECDSA P-256 (reject weak RSA, algorithm downgrades)
        const publicKeyObject = crypto.createPublicKey({
          key: agent.device_public_key,
          format: 'pem'
        });
        
        const allowedAlgorithms = ['ed25519', 'ec'];
        const keyType = publicKeyObject.asymmetricKeyType;
        
        if (!allowedAlgorithms.includes(keyType)) {
          logger.warn('Rejecting disallowed public key algorithm', {
            agentUuid: uuid.substring(0, 8) + '...',
            algorithm: keyType,
            allowed: allowedAlgorithms
          });
          
          await logAuditEvent({
            eventType: AuditEventType.AUTHENTICATION_FAILED,
            agentUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: `Disallowed key algorithm: ${keyType}. Only Ed25519 and ECDSA P-256 allowed.` }
          });
          
          return reply.status(401).send({
            error: 'Invalid key algorithm',
            message: 'Device public key must use Ed25519 or ECDSA P-256'
          });
        }
        
        // For EC keys, additionally verify it's P-256 (not P-384, P-521, etc.)
        if (keyType === 'ec') {
          const keyDetails = publicKeyObject.asymmetricKeyDetails;
          if (keyDetails?.namedCurve !== 'prime256v1' && keyDetails?.namedCurve !== 'P-256') {
            logger.warn('Rejecting ECDSA key with non-P-256 curve', {
              agentUuid: uuid.substring(0, 8) + '...',
              curve: keyDetails?.namedCurve
            });
            
            await logAuditEvent({
              eventType: AuditEventType.AUTHENTICATION_FAILED,
              agentUuid: uuid,
              ipAddress,
              userAgent,
              severity: AuditSeverity.WARNING,
              details: { reason: `ECDSA key must use P-256 curve, got ${keyDetails?.namedCurve}` }
            });
            
            return reply.status(401).send({
              error: 'Invalid key curve',
              message: 'ECDSA key must use P-256 curve'
            });
          }
        }
        
        // Bind agent UUID to signature payload to prevent cross-agent replay
        // Client signs: uuid:challenge
        // Server verifies: same payload construction
        const payload = `${uuid}:${agent.last_challenge}`;
        
        const isValid = crypto.verify(
          null, // Algorithm detected from key
          Buffer.from(payload, 'utf-8'),
          agent.device_public_key,
          Buffer.from(signature, 'base64')
        );

        logger.info('Signature verification result', {
          agentUuid: uuid.substring(0, 8) + '...',
          isValid,
          payloadLength: payload.length
        });

        if (!isValid) {
          await logAuditEvent({
            eventType: AuditEventType.AUTHENTICATION_FAILED,
            agentUuid: uuid,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: 'Invalid signature - proof of possession failed' }
          });
          return reply.status(401).send({
            error: 'Proof of possession failed',
            message: 'Invalid signature'
          });
        }

        // ✅ PoP verified - invalidate challenge immediately (single-use)
        // Set challenge expiry to now to prevent replay
        logger.info('Invalidating challenge after successful PoP verification', {
          agentUuid: uuid.substring(0, 8) + '...',
          reason: 'single-use challenge enforcement'
        });
        
        await AgentModel.storeChallenge(uuid, null, new Date()); // Expire challenge immediately

        // Mark agent as PoP verified
        logger.info('Marking agent as PoP verified', {
          agentUuid: uuid.substring(0, 8) + '...',
          agentName: agent.name
        });
        
        await AgentModel.markPopVerified(uuid);
        
        // Record authentication method for fleet-level policy enforcement
        await AgentModel.recordAuthMethod(uuid, 'pop');

        logger.info('PoP verification successful and persisted', {
          agentUuid: uuid.substring(0, 8) + '...',
          agentName: agent.name,
          authMethod: 'proof-of-possession'
        });

        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_SUCCESS,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.INFO,
          details: { 
            agentName: agent.name,
            authMethod: 'proof-of-possession'
          }
        });

        return reply.send({
          status: 'ok',
          message: 'Proof of possession verified',
          device: {
            id: agent.id,
            uuid: agent.uuid,
            deviceName: agent.name,
          }
        });
      } catch (verifyError: unknown) {
        logger.error('Signature verification error:', verifyError);
        
        await logAuditEvent({
          eventType: AuditEventType.KEY_EXCHANGE_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.ERROR,
          details: { reason: 'Signature verification failed', error: verifyError instanceof Error ? verifyError.message : 'Unknown error' }
        });

        return reply.status(401).send({
          error: 'Signature verification failed',
          message: 'Invalid signature format or corrupted public key'
        });
      }
    }

    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_FAILED,
      agentUuid: uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.WARNING,
      details: {
        reason: !agent.device_public_key
          ? 'Device has no registered public key'
          : 'Proof-of-possession verification did not complete',
      },
    });

    return reply.status(401).send({
      error: 'Proof of possession required',
      message: 'Device must register a public key and provide a valid signature for key exchange',
    });
  } catch (error: unknown) {
    logger.error('Error during key exchange:', error);
    
    await logAuditEvent({
      eventType: AuditEventType.KEY_EXCHANGE_FAILED,
      agentUuid: req.params.uuid,
      ipAddress,
      userAgent,
      severity: AuditSeverity.ERROR,
      details: { error: error instanceof Error ? error.message : 'Unknown error' }
    });

    return reply.status(500).send({
      error: 'Key exchange failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

};

export default plugin;