/**
 * Device Management Routes
 * Endpoints for managing individual agents and their deployed applications
 */

import { z } from 'zod';
import logger from '../../utils/logger';
import deviceAuth from '../../middleware/agent-auth';
import { jwtAuth } from '../../middleware/jwt-auth';
import * as AgentsService from '../../services/agent/agents';
import type { FastifyPluginAsync } from 'fastify';

// ============================================================================
// Route Param / Body Types (HTTP layer only)
// ============================================================================

type AgentUuidParams = {
  uuid: string;
};

type AgentUuidAppParams = {
  uuid: string;
  appId: string;
};

type AgentUpdateBody = {
  deviceName?: string;
  deviceType?: string;
  ipAddress?: string;
  macAddress?: string;
  location?: string | null;
};

type AgentsListQuerystring = {
  online?: string;
  page?: string | number;
  limit?: string | number;
  filter?: string;
  includeTags?: string;
};

type DeviceTagInput = {
  key: string;
  value: string;
};

type RegisterAgentBody = {
  deviceName?: string;
  deviceType?: string;
  ipAddress?: string;
  macAddress?: string;
  namespace?: string;
  fleet_uuid?: string;
  tags?: DeviceTagInput[];
  metadata?: unknown;
  endpoints?: Array<{ protocol: string; [key: string]: unknown }>;
  devicePublicKey?: string;
};

type ActiveBody = {
  is_active?: boolean;
};

type AppServiceInput = {
  serviceName: string;
  image: string;
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  config?: Record<string, unknown>;
  state?: string;
};

type CreateAppBody = {
  appId?: number;
  appName?: string;
  services?: AppServiceInput[];
};

type UpdateAppBody = {
  appName?: string;
  services?: AppServiceInput[];
};

type DeployedByBody = {
  deployedBy?: string;
};

type BrokerBody = {
  brokerId?: number;
};

type UpdateAgentBody = {
  version?: string;
  scheduled_time?: string;
  force?: boolean;
};

type VirtualAgentBody = {
  deviceName?: string;
  fleetId?: string;
  namespace?: string;
  description?: string;
  tags?: DeviceTagInput[];
};

// ============================================================================
// Helpers
// ============================================================================

function parseNumericQuery(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function getHeaderValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

// ============================================================================
// Plugin
// ============================================================================

const plugin: FastifyPluginAsync = async (fastify) => {
  const deviceNameSchema = z.string().min(1).max(255).regex(
    /^[a-zA-Z0-9\-_\s.]+$/,
    'Device name contains invalid characters. Allowed: letters, numbers, spaces, hyphens, underscores, dots'
  );
  const deviceTypeSchema = z.string().min(1).max(100).regex(
    /^[a-zA-Z0-9\-_]+$/,
    'Device type contains invalid characters'
  );
  const ipAddressSchema = z
    .string().ip({ version: 'v4' })
    .or(z.string().ip({ version: 'v6' }))
    .or(z.string().refine((val) => /^[a-zA-Z0-9.-]+$/.test(val), 'Invalid IP address or hostname'));
  const macAddressSchema = z.string().regex(
    /^([0-9A-Fa-f]{2}:){5}([0-9A-Fa-f]{2})$/,
    'Invalid MAC address format (use XX:XX:XX:XX:XX:XX)'
  );
  const locationSchema = z
    .string().max(255)
    .regex(/^[a-zA-Z0-9\-_\s.,()]+$/, 'Location contains invalid characters')
    .nullable();

  fastify.get('/agents/locations', { preHandler: [jwtAuth] }, async (_req, reply) => {
    try {
      const locations = await AgentsService.getLocations();
      reply.send({ locations });
    } catch (error: unknown) {
      logger.error('Error fetching locations:', error);
      reply.status(500).send({ error: 'Failed to fetch locations' });
    }
  });

  fastify.get<{ Querystring: AgentsListQuerystring }>('/agents', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const isOnline =
        req.query.online === 'true' ? true :
        req.query.online === 'false' ? false :
        undefined;
      const page = parseNumericQuery(req.query.page, 1);
      const limit = parseNumericQuery(req.query.limit, 10);
      const filter = req.query.filter?.toLowerCase() || 'all';
      const includeTags = req.query.includeTags === 'true';
      const result = await AgentsService.listAgents({ isOnline, page, limit, filter, includeTags });
      reply.send({ count: result.agents.length, agents: result.agents, pagination: result.pagination });
    } catch (error: unknown) {
      logger.error('Error listing agents', { error: error instanceof Error ? error.message : String(error) });
      reply.status(500).send({ error: 'Failed to list agents' });
    }
  });

  fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid', async (req, reply) => {
    try {
      const result = await AgentsService.getAgent(req.params.uuid);
      if (!result) return reply.status(404).send({ error: 'Device not found', message: `Device ${req.params.uuid} not found` });
      reply.send(result);
    } catch (error: unknown) {
      logger.error('Error getting device', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to get device' });
    }
  });

  fastify.patch<{ Params: AgentUuidParams; Body: AgentUpdateBody }>('/agents/:uuid', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { deviceName, deviceType, ipAddress, macAddress, location } = req.body;
      if (!deviceName && !deviceType && !ipAddress && !macAddress && location === undefined) {
        return reply.status(400).send({ error: 'Invalid request', message: 'At least one of deviceName, deviceType, ipAddress, macAddress, or location must be provided.' });
      }
      if (deviceName) {
        const v = deviceNameSchema.safeParse(deviceName);
        if (!v.success) return reply.status(400).send({ error: 'Invalid deviceName', message: v.error.errors[0].message });
      }
      if (deviceType) {
        const v = deviceTypeSchema.safeParse(deviceType);
        if (!v.success) return reply.status(400).send({ error: 'Invalid deviceType', message: v.error.errors[0].message });
      }
      if (ipAddress) {
        const v = ipAddressSchema.safeParse(ipAddress);
        if (!v.success) return reply.status(400).send({ error: 'Invalid ipAddress', message: 'IP address must be valid IPv4, IPv6, or hostname' });
      }
      if (macAddress) {
        const v = macAddressSchema.safeParse(macAddress);
        if (!v.success) return reply.status(400).send({ error: 'Invalid macAddress', message: 'MAC address must be in format XX:XX:XX:XX:XX:XX' });
      }
      if (location !== undefined) {
        const v = locationSchema.safeParse(location);
        if (!v.success) return reply.status(400).send({ error: 'Invalid location', message: v.error.errors[0].message });
      }
      const updated = await AgentsService.updateAgent(uuid, { deviceName, deviceType, ipAddress, macAddress, location });
      if (!updated) return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
      reply.send({ success: true, device: updated });
    } catch (error: unknown) {
      logger.error('Error updating device', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Internal server error', requestId: req.id || 'unknown' });
    }
  });

  fastify.post<{ Body: RegisterAgentBody }>('/agents', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { deviceName, deviceType, ipAddress, macAddress, namespace, fleet_uuid, tags, metadata, endpoints } = req.body;
      if (!deviceName) return reply.status(400).send({ error: 'Device name required', message: 'deviceName is required' });
      const actor: AgentsService.ActorInfo = { ip: req.ip, userAgent: getHeaderValue(req.headers['user-agent']) };
      const result = await AgentsService.registerAgent(
        { deviceName, deviceType, ipAddress, macAddress, namespace, fleet_uuid, tags, metadata, endpoints },
        actor
      );
      if ('error' in result && result.error === 'fleet_not_found') {
        return reply.status(400).send({ error: 'Invalid fleet_uuid', message: `Fleet ${(result as any).fleet_uuid} not found` });
      }
      if ((result as any).virtual) {
        return reply.status(202).send({
          success: true,
          deviceUuid: (result as any).deviceUuid,
          deviceName: (result as any).deviceName,
          originalName: (result as any).originalName,
          deviceType: 'virtual',
          deploymentStatus: 'deploying',
          namespace: (result as any).namespace,
          message: 'Virtual agent deployment initiated',
        });
      }
      reply.status(201).send({ success: true, device: (result as any).device });
    } catch (error: unknown) {
      logger.error('Error registering device', { error: error instanceof Error ? error.message : String(error) });
      reply.status(500).send({ error: 'Failed to register device' });
    }
  });

  fastify.patch<{ Params: AgentUuidParams; Body: ActiveBody }>('/agents/:uuid/active', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { is_active } = req.body;
      if (typeof is_active !== 'boolean') return reply.status(400).send({ error: 'Invalid request', message: 'is_active must be a boolean (true or false)' });
      const actor: AgentsService.ActorInfo = {
        userId: String(req.user?.id ?? 'system'),
        userEmail: req.user?.email,
        ip: req.ip,
        userAgent: getHeaderValue(req.headers['user-agent']),
      };
      const updated = await AgentsService.setAgentActive(uuid, is_active, actor);
      if (!updated) return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
      const action = is_active ? 'enabled' : 'disabled';
      reply.send({ status: 'ok', message: `Device ${action}`, device: updated });
    } catch (error: unknown) {
      logger.error('Error updating device active status', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to update device status' });
    }
  });

  fastify.delete<{ Params: AgentUuidParams }>('/agents/:uuid', { preHandler: [deviceAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const deleted = await AgentsService.deleteAgent(uuid);
      if (!deleted) return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
      logger.info('Device deleted (deprovisioned)', { deviceId: uuid.substring(0, 8), deviceName: req.device?.deviceName });
      reply.send({ status: 'ok', message: 'Device deleted' });
    } catch (error: unknown) {
      logger.error('Error deleting device', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to delete device' });
    }
  });

  fastify.post<{ Params: AgentUuidParams; Body: CreateAppBody }>('/agents/:uuid/apps', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { appId, appName, services } = req.body;
      if (!appId || typeof appId !== 'number') return reply.status(400).send({ error: 'Invalid request', message: 'appId is required and must be a number' });
      if (!services || !Array.isArray(services)) return reply.status(400).send({ error: 'Invalid request', message: 'services is required and must be an array' });
      const userId = getHeaderValue(req.headers['x-user-id']) || 'system';
      const result = await AgentsService.deployApp(uuid, appId, appName, services, userId);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Not found', message: `Device ${uuid} not found` });
        if (result.error === 'app_not_found') return reply.status(400).send({ error: 'Invalid request', message: `Application ${appId} not found in catalog. Please provide appName for ad-hoc deployment.` });
      }
      reply.status(201).send({ status: 'ok', message: 'Application deployed to device', deviceUuid: uuid, ...result });
    } catch (error: unknown) {
      logger.error('Error deploying application', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to deploy application' });
    }
  });

  fastify.patch<{ Params: AgentUuidAppParams; Body: UpdateAppBody }>('/agents/:uuid/apps/:appId', async (req, reply) => {
    try {
      const { uuid, appId: appIdStr } = req.params;
      const { appName, services } = req.body;
      const appId = parseInt(appIdStr);
      if (isNaN(appId)) return reply.status(400).send({ error: 'Invalid request', message: 'appId must be a number' });
      if (!services || !Array.isArray(services)) return reply.status(400).send({ error: 'Invalid request', message: 'services is required and must be an array' });
      const result = await AgentsService.updateApp(uuid, appId, appName, services);
      if ('error' in result) {
        if (result.error === 'no_target_state') return reply.status(404).send({ error: 'Not found', message: `Device ${uuid} has no target state` });
        if (result.error === 'app_not_found') return reply.status(404).send({ error: 'Not found', message: `App ${appId} not deployed on device ${uuid}` });
      }
      reply.send({ status: 'ok', message: 'Application updated on device', deviceUuid: uuid, ...result });
    } catch (error: unknown) {
      logger.error('Error updating application', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to update application' });
    }
  });

  fastify.delete<{ Params: AgentUuidAppParams }>('/agents/:uuid/apps/:appId', async (req, reply) => {
    try {
      const { uuid, appId: appIdStr } = req.params;
      const appId = parseInt(appIdStr);
      if (isNaN(appId)) return reply.status(400).send({ error: 'Invalid request', message: 'appId must be a number' });
      const result = await AgentsService.removeApp(uuid, appId);
      if (result && 'error' in result) {
        if (result.error === 'no_target_state') return reply.status(404).send({ error: 'Not found', message: `Device ${uuid} has no target state` });
        if (result.error === 'app_not_found') return reply.status(404).send({ error: 'Not found', message: `App ${appId} not deployed on device ${uuid}` });
      }
      reply.send({ status: 'ok', message: 'Application removed from device', deviceUuid: uuid, ...result });
    } catch (error: unknown) {
      logger.error('Error removing application', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to remove application' });
    }
  });

  fastify.post<{ Params: AgentUuidAppParams; Body: DeployedByBody }>('/agents/:uuid/apps/:appId/deploy', async (req, reply) => {
    try {
      const { uuid, appId: appIdStr } = req.params;
      const deployedBy = req.body.deployedBy || 'dashboard';
      const appId = parseInt(appIdStr);
      if (isNaN(appId)) return reply.status(400).send({ error: 'Invalid request', message: 'appId must be a number' });
      const result = await AgentsService.deployAppVersion(uuid, appId, deployedBy);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'no_target_state') return reply.status(404).send({ error: 'Not found', message: `Device ${uuid} has no target state` });
        if (result.error === 'app_not_found') return reply.status(404).send({ error: 'Not found', message: `App ${appId} not found in target state` });
      }
      reply.send({ status: 'ok', message: `Application ${(result as any).appName} deployed successfully`, ...result });
    } catch (error: unknown) {
      logger.error('Error deploying app', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to deploy application' });
    }
  });

  fastify.post<{ Params: AgentUuidParams; Body: DeployedByBody }>('/agents/:uuid/deploy', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const deployedBy = req.body.deployedBy || 'dashboard';
      const result = await AgentsService.deployTargetState(uuid, deployedBy);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'no_target_state') return reply.status(404).send({ error: 'Not found', message: `Device ${uuid} has no target state to deploy` });
        if (result.error === 'nothing_to_deploy') return reply.status(400).send({ error: 'Nothing to deploy', message: 'Target state is already deployed', version: (result as any).version });
      }
      reply.send({ status: 'ok', message: 'Target state deployed successfully', deviceUuid: uuid, ...result });
    } catch (error: unknown) {
      logger.error('Error deploying target state', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to deploy target state' });
    }
  });

  fastify.post<{ Params: AgentUuidParams }>('/agents/:uuid/deploy/cancel', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const result = await AgentsService.cancelDeployment(uuid);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'no_target_state') return reply.status(404).send({ error: 'Not found', message: `Device ${uuid} has no target state` });
        if (result.error === 'nothing_to_cancel') return reply.status(400).send({ error: 'Nothing to cancel', message: 'No pending changes to cancel', version: (result as any).version });
      }
      reply.send({ status: 'ok', message: 'Pending deployment canceled successfully', deviceUuid: uuid, ...result });
    } catch (error: unknown) {
      logger.error('Error canceling deployment', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to cancel deployment' });
    }
  });

  fastify.put<{ Params: AgentUuidParams; Body: BrokerBody }>('/agents/:uuid/broker', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { brokerId } = req.body;
      if (!brokerId || typeof brokerId !== 'number') return reply.status(400).send({ error: 'Invalid request', message: 'brokerId is required and must be a number' });
      const actor: AgentsService.ActorInfo = {
        userId: String(req.user?.id ?? 'system'),
        userEmail: req.user?.email,
        ip: req.ip,
        userAgent: getHeaderValue(req.headers['user-agent']),
      };
      const result = await AgentsService.assignBroker(uuid, brokerId, actor);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'broker_not_found') return reply.status(404).send({ error: 'Broker not found', message: `Broker ${brokerId} not found or inactive` });
      }
      const r = result as any;
      reply.send({
        success: true,
        message: `Device assigned to broker: ${r.broker?.name}`,
        device: r.device,
        broker: r.broker,
        shadow: {
          version: r.shadow?.version,
          mqttNotified: r.shadow?.mqttPublished,
          message: r.shadow?.mqttPublished ? 'Device will be notified immediately via MQTT' : 'Device will receive update on next shadow sync',
        },
      });
    } catch (error: unknown) {
      logger.error('Error assigning device to broker', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to assign device to broker' });
    }
  });

  fastify.post<{ Params: AgentUuidParams; Body: UpdateAgentBody }>('/agents/:uuid/update-agent', async (req, reply) => {
    try {
      const { uuid } = req.params;
      const { version, scheduled_time, force = false } = req.body;
      if (version && !/^\d+\.\d+\.\d+$/.test(version) && version !== 'latest') {
        return reply.status(400).send({ error: 'Invalid version format', message: 'Version must be in format X.Y.Z or "latest"' });
      }
      const actor: AgentsService.ActorInfo = { ip: req.ip, userAgent: getHeaderValue(req.headers['user-agent']) };
      const result = await AgentsService.triggerAgentUpdate(uuid, { version, scheduled_time, force }, actor);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'broker_not_configured') return reply.status(500).send({ error: 'MQTT broker not configured', message: 'Cannot trigger agent update - MQTT broker configuration missing' });
      }
      reply.send({ success: true, message: 'Agent update command sent via MQTT', ...result });
    } catch (error: unknown) {
      logger.error('Error triggering agent update', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to trigger agent update' });
    }
  });

  fastify.post<{ Body: VirtualAgentBody }>('/agents/virtual', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { deviceName, fleetId, namespace, tags } = req.body;
      if (!deviceName) return reply.status(400).send({ error: 'Device name required', message: 'deviceName is required' });
      const actor: AgentsService.ActorInfo = { ip: req.ip, userAgent: getHeaderValue(req.headers['user-agent']) };
      const result = await AgentsService.createVirtualAgent({ deviceName, fleetId, namespace, tags }, actor);
      if ('error' in result) {
        if (result.error === 'fleet_not_found') return reply.status(400).send({ error: 'Invalid fleetId', message: `Fleet ${(result as any).fleetId} not found` });
      }
      const r = result as any;
      reply.status(202).send({ message: 'Virtual agent deployment initiated', deviceUuid: r.deviceUuid, deviceName: r.deviceName, deploymentStatus: 'deploying', namespace: r.namespace });
    } catch (error: unknown) {
      logger.error('Error creating virtual agent', { error: error instanceof Error ? error.message : String(error) });
      reply.status(500).send({ error: 'Failed to create virtual agent' });
    }
  });

  fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/deployment-status', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const result = await AgentsService.getDeploymentStatus(uuid);
      if (!result) return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
      if ('error' in result && result.error === 'not_virtual') return reply.status(400).send({ error: 'Not a virtual agent', message: 'This endpoint is only for virtual agents' });
      reply.send(result);
    } catch (error: unknown) {
      logger.error('Error getting deployment status', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to get deployment status' });
    }
  });

  fastify.delete<{ Params: AgentUuidParams }>('/agents/:uuid/virtual', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const result = await AgentsService.destroyVirtualAgent(uuid);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'not_virtual') return reply.status(400).send({ error: 'Not a virtual agent', message: 'This endpoint is only for virtual agents' });
      }
      reply.send({ message: 'Virtual agent deleted successfully (K8s + database)', ...result });
    } catch (error: unknown) {
      logger.error('Error destroying virtual agent', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to destroy virtual agent' });
    }
  });

  fastify.post<{ Params: AgentUuidParams }>('/agents/:uuid/virtual/restart', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { uuid } = req.params;
      const result = await AgentsService.restartVirtualAgent(uuid);
      if ('error' in result) {
        if (result.error === 'device_not_found') return reply.status(404).send({ error: 'Device not found', message: `Device ${uuid} not found` });
        if (result.error === 'not_virtual') return reply.status(400).send({ error: 'Not a virtual agent', message: 'This endpoint is only for virtual agents' });
      }
      reply.send({ message: 'Virtual agent restart initiated', ...result, note: 'Pod deleted - Kubernetes will automatically recreate it' });
    } catch (error: unknown) {
      logger.error('Error restarting virtual agent', { error: error instanceof Error ? error.message : String(error), deviceId: req.params.uuid });
      reply.status(500).send({ error: 'Failed to restart virtual agent' });
    }
  });
};

export default plugin;