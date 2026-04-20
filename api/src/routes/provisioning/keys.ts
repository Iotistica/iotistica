/**
 * Provisioning Key Management Routes
 *
 * - POST   /api/v1/provisioning-keys          Create a new provisioning key
 * - GET    /api/v1/provisioning-keys          List provisioning keys for a fleet
 * - DELETE /api/v1/provisioning-keys/:keyId   Revoke a provisioning key
 * - POST   /api/v1/provisioning-keys/generate Generate a single-agent key
 */
import { query } from '../../db/connection';
import {
  createProvisioningKey,
  revokeProvisioningKey,
  listProvisioningKeys,
} from '../../services/provisioning/provisioning-keys';
import { logAuditEvent, AuditEventType, AuditSeverity } from '../../utils/audit-logger';
import { LicenseValidator } from '../../services/auth/license-validator';
import { jwtAuth, requireRole } from '../../middleware/jwt-auth';
import logger from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify';
import type {
  CreateProvisioningKeyBody,
  ListProvisioningKeysQuerystring,
  ProvisioningKeyParams,
  RevokeProvisioningKeyBody,
  GenerateProvisioningKeyBody,
} from './types';

const plugin: FastifyPluginAsync = async (fastify) => {

  /**
   * Create a new provisioning key
   * POST /api/v1/provisioning-keys
   */
  fastify.post<{ Body: CreateProvisioningKeyBody }>(
    '/provisioning-keys',
    { preHandler: [jwtAuth, requireRole('admin')] },
    async (req, reply) => {
      try {
        const { fleetUuid, maxDevices = 100, expiresInDays = 365, description } = req.body;

        if (!fleetUuid || typeof fleetUuid !== 'string') {
          return reply.status(400).send({
            error: 'Invalid request',
            message: 'fleetUuid (fleet UUID) is required and must be a string',
          });
        }

        if (maxDevices && (typeof maxDevices !== 'number' || maxDevices < 1 || maxDevices > 10000)) {
          return reply.status(400).send({
            error: 'Invalid request',
            message: 'maxDevices must be a number between 1 and 10000',
          });
        }

        if (expiresInDays && (typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > 3650)) {
          return reply.status(400).send({
            error: 'Invalid request',
            message: 'expiresInDays must be a number between 1 and 3650 (10 years)',
          });
        }

        // Check license agent limit before creating provisioning key
        const license = LicenseValidator.getInstance().getLicense();
        if (license) {
          const maxDevicesAllowed = license.features.maxDevices;
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
                fleetUuid,
              },
            });
            return reply.status(403).send({
              error: 'Agent limit exceeded',
              message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} agents. You currently have ${currentDeviceCount} active agents. Please upgrade your plan to add more agents.`,
              details: { currentDevices: currentDeviceCount, maxDevices: maxDevicesAllowed, plan: license.plan },
            });
          }

          logger.info(`License check passed: ${currentDeviceCount}/${maxDevicesAllowed} agents`);
        }

        logger.info(`Creating provisioning key for fleet: ${fleetUuid}`);

        const fleetResult = await query(
          'SELECT fleet_uuid FROM fleets WHERE fleet_uuid::text = $1',
          [fleetUuid],
        );

        if (fleetResult.rows.length === 0) {
          return reply.status(404).send({
            error: 'Fleet not found',
            message: `Fleet with identifier '${fleetUuid}' does not exist. Create the fleet first.`,
          });
        }

        const resolvedFleetUuid = fleetResult.rows[0].fleet_uuid;
        logger.info(`Resolved fleet UUID: ${resolvedFleetUuid}`);

        const { id, key } = await createProvisioningKey(
          resolvedFleetUuid,
          maxDevices,
          expiresInDays,
          description,
          'api-admin', // TODO: Replace with actual authenticated user
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
          warning: 'Store this key securely - it cannot be retrieved again!',
        });
      } catch (error: unknown) {
        logger.error('Error creating provisioning key:', error);
        return reply.status(500).send({
          error: 'Failed to create provisioning key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  /**
   * List provisioning keys for a fleet
   * GET /api/v1/provisioning-keys?fleetUuid=xxx
   */
  fastify.get<{ Querystring: ListProvisioningKeysQuerystring }>(
    '/provisioning-keys',
    { preHandler: [jwtAuth, requireRole('admin')] },
    async (req, reply) => {
      try {
        const { fleetUuid } = req.query;

        if (!fleetUuid || typeof fleetUuid !== 'string') {
          return reply.status(400).send({
            error: 'Invalid request',
            message: 'fleetUuid (fleet UUID) query parameter is required',
          });
        }

        logger.info(`Listing provisioning keys for fleet: ${fleetUuid}`);

        const fleetResult = await query(
          'SELECT fleet_uuid FROM fleets WHERE fleet_uuid::text = $1',
          [fleetUuid],
        );

        if (fleetResult.rows.length === 0) {
          return reply.status(404).send({
            error: 'Fleet not found',
            message: `Fleet with identifier '${fleetUuid}' does not exist.`,
          });
        }

        const resolvedFleetUuid = fleetResult.rows[0].fleet_uuid;
        const keys = await listProvisioningKeys(resolvedFleetUuid);

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

        return reply.send({ count: sanitizedKeys.length, keys: sanitizedKeys });
      } catch (error: unknown) {
        logger.error('Error listing provisioning keys:', error);
        return reply.status(500).send({
          error: 'Failed to list provisioning keys',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  /**
   * Revoke a provisioning key
   * DELETE /api/v1/provisioning-keys/:keyId
   */
  fastify.delete<{ Params: ProvisioningKeyParams; Body: RevokeProvisioningKeyBody }>(
    '/provisioning-keys/:keyId',
    { preHandler: [jwtAuth, requireRole('admin')] },
    async (req, reply) => {
      try {
        const { keyId } = req.params;
        const { reason } = req.body;

        if (!keyId) {
          return reply.status(400).send({ error: 'Invalid request', message: 'keyId is required' });
        }

        logger.info(`Revoking provisioning key: ${keyId}`);
        await revokeProvisioningKey(keyId, reason);
        logger.info(`Provisioning key revoked: ${keyId}`);

        return reply.send({ status: 'ok', message: 'Provisioning key revoked', keyId, reason });
      } catch (error: unknown) {
        logger.error('Error revoking provisioning key:', error);
        return reply.status(500).send({
          error: 'Failed to revoke provisioning key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

  /**
   * Generate a single-agent provisioning key
   * POST /api/v1/provisioning-keys/generate
   */
  fastify.post<{ Body: GenerateProvisioningKeyBody }>(
    '/provisioning-keys/generate',
    { preHandler: [jwtAuth, requireRole('admin')] },
    async (req, reply) => {
      try {
        const { fleetUuid, newKey = false, previousKeyId, deploymentType, metadata, simulatorConfig } = req.body;

        if (!fleetUuid || typeof fleetUuid !== 'string') {
          return reply.status(400).send({
            error: 'Invalid request',
            message: 'fleetUuid (fleet UUID) is required and must be a string',
          });
        }

        if (newKey && previousKeyId) {
          try {
            logger.info(`Invalidating previous provisioning key: ${previousKeyId}`);
            await revokeProvisioningKey(previousKeyId, 'Regenerated by user');
          } catch (revokeError: unknown) {
            logger.warn(
              `Could not revoke previous key ${previousKeyId}:`,
              revokeError instanceof Error ? revokeError.message : 'Unknown error',
            );
          }
        }

        const license = LicenseValidator.getInstance().getLicense();
        if (license) {
          const maxDevicesAllowed = license.features.maxDevices;
          const deviceCountResult = await query('SELECT COUNT(*) as count FROM agents WHERE is_active = true');
          const currentDeviceCount = parseInt(deviceCountResult.rows[0].count);

          if (currentDeviceCount >= maxDevicesAllowed) {
            return reply.status(403).send({
              error: 'Agent limit exceeded',
              message: `Your ${license.plan} plan allows a maximum of ${maxDevicesAllowed} agents. Please upgrade to add more.`,
              details: { currentDevices: currentDeviceCount, maxDevices: maxDevicesAllowed, plan: license.plan },
            });
          }
        }

        const fleetResult = await query(
          'SELECT fleet_uuid, fleet_name FROM fleets WHERE fleet_uuid::text = $1',
          [fleetUuid],
        );

        if (fleetResult.rows.length === 0) {
          return reply.status(404).send({
            error: 'Fleet not found',
            message: `Fleet with identifier '${fleetUuid}' does not exist. Create the fleet first.`,
          });
        }

        const resolvedFleetUuid = fleetResult.rows[0].fleet_uuid;

        const { id, key } = await createProvisioningKey(
          resolvedFleetUuid,
          1,
          30,
          'Dashboard-generated provisioning key',
          'dashboard-user', // TODO: Replace with actual authenticated user
        );

        if (deploymentType || simulatorConfig || metadata) {
          try {
            await query(
              `UPDATE provisioning_keys SET deployment_type = $1, simulator_config = $2, metadata = $3 WHERE id = $4`,
              [
                deploymentType || null,
                simulatorConfig ? JSON.stringify(simulatorConfig) : null,
                metadata ? JSON.stringify(metadata) : null,
                id,
              ],
            );
            logger.info(`Stored simulator config for provisioning key ${id}`, { deploymentType, simulatorConfig });
          } catch (metadataError: unknown) {
            logger.warn(
              `Failed to store provisioning metadata for key ${id} (columns may not exist):`,
              metadataError instanceof Error ? metadataError.message : 'Unknown error',
            );
          }
        }

        const expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + 30);

        logger.info(`Single-agent provisioning key generated: ${id}`, { deploymentType });

        const response: Record<string, unknown> = {
          id,
          key,
          expiresAt: expiresAt.toISOString(),
          warning: 'Store this key securely - it cannot be retrieved again!',
        };

        if (deploymentType) response.deploymentType = deploymentType;
        if (simulatorConfig) response.simulatorConfig = simulatorConfig;

        return reply.status(201).send(response);
      } catch (error: unknown) {
        logger.error('Error generating provisioning key:', error);
        return reply.status(500).send({
          error: 'Failed to generate provisioning key',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
  );

};

export default plugin;
