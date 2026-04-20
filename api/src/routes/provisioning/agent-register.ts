/**
 * Agent Registration Route — Phase 1 of two-phase authentication
 *
 * - POST /api/v1/device/register
 *
 * Validates provisioning key, enforces license limits, and delegates to
 * the provisioning service to create/update the agent record.
 */
import { query } from '../../db/connection';
import { logAuditEvent, AuditEventType, AuditSeverity } from '../../utils/audit-logger';
import { LicenseValidator } from '../../services/auth/license-validator';
import { provisioningService } from '../../services/provisioning/register';
import logger from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify';
import type { RegisterDeviceBody } from './types';

const plugin: FastifyPluginAsync = async (fastify) => {

  /**
   * Register a new agent with a provisioning key
   * POST /api/v1/device/register
   *
   * Phase 1 of two-phase authentication:
   * 1. Validates provisioning key
   * 2. Enforces license agent limits
   * 3. Validates optional public key format (for PoP)
   * 4. Delegates to provisioningService for business logic
   */
  fastify.post<{ Body: RegisterDeviceBody }>('/device/register', async (req, reply) => {
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'];

    try {
      const { uuid, deviceName, deviceType, deviceApiKey, devicePublicKey, macAddress, osVersion, agentVersion } = req.body;
      const provisioningApiKey = (req.headers['x-provisioning-key'] as string) ?? undefined;

      if (!uuid || !deviceName || !deviceType || !deviceApiKey) {
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_FAILED,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Missing required fields', uuid: uuid?.substring(0, 8) },
        });
        return reply.status(400).send({
          error: 'Missing required fields',
          message: 'uuid, deviceName, deviceType, and deviceApiKey are required',
        });
      }

      if (devicePublicKey) {
        logger.info('Received agent registration with public key', {
          uuid: uuid?.substring(0, 8) + '...',
          publicKeyLength: devicePublicKey.length,
          hasBeginMarker: devicePublicKey.includes('BEGIN PUBLIC KEY'),
          hasEndMarker: devicePublicKey.includes('END PUBLIC KEY'),
        });

        if (!devicePublicKey.includes('BEGIN PUBLIC KEY') || !devicePublicKey.includes('END PUBLIC KEY')) {
          logger.warn('Invalid public key format received', {
            uuid: uuid?.substring(0, 8) + '...',
            publicKeyLength: devicePublicKey.length,
            preview: devicePublicKey.substring(0, 50),
          });

          await logAuditEvent({
            eventType: AuditEventType.PROVISIONING_FAILED,
            ipAddress,
            userAgent,
            severity: AuditSeverity.WARNING,
            details: { reason: 'Invalid public key format (must be PEM)', uuid: uuid?.substring(0, 8) },
          });
          return reply.status(400).send({
            error: 'Invalid public key format',
            message: 'devicePublicKey must be in PEM format',
          });
        }
      } else {
        logger.info('Agent registration without public key (legacy mode)', {
          uuid: uuid?.substring(0, 8) + '...',
        });
      }

      if (!provisioningApiKey) {
        await logAuditEvent({
          eventType: AuditEventType.PROVISIONING_FAILED,
          agentUuid: uuid,
          ipAddress,
          userAgent,
          severity: AuditSeverity.WARNING,
          details: { reason: 'Missing provisioning API key' },
        });
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Provisioning key required in x-provisioning-key header',
        });
      }

      // Enforce license agent limit at registration time.
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
              plan: license.plan,
            },
          });
          return reply.status(403).send({
            error: 'Agent limit exceeded',
            message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} agents. You currently have ${currentDeviceCount} active agents. Please upgrade your plan to add more agents.`,
            details: { currentDevices: currentDeviceCount, maxDevices: maxDevicesAllowed, plan: license.plan },
          });
        }
      }

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
          agentVersion,
        },
        ipAddress,
        userAgent,
      );

      logger.info('Agent registered successfully:', response.id);
      return reply.status(200).send(response);
    } catch (error: unknown) {
      logger.error('Error registering agent:', error);

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      let statusCode = 500;

      if (errorMessage.includes('already registered')) statusCode = 409;
      else if (errorMessage.includes('Invalid provisioning key') || errorMessage.includes('expired') || errorMessage.includes('limit exceeded')) statusCode = 401;
      else if (errorMessage.includes('Rate limit exceeded')) statusCode = 429;

      return reply.status(statusCode).send({
        error: 'Failed to register agent',
        message: errorMessage,
      });
    }
  });

};

export default plugin;
