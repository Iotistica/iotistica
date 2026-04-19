/**
 * Device Sensor Configuration Routes
 * Manages sensor device configurations (Modbus, CAN, OPC-UA, MQTT, etc.)
 * 
 * Pattern: Dual-write with sync service
 * - Config in agent_target_state remains source of truth for agent
 * - endpoints table for efficient querying/display
 * 
 * CRUD Endpoints:
 * - GET /api/v1/agents/:uuid/devices - List all devices
 * - POST /api/v1/agents/:uuid/devices - Add new device
 * - PUT /api/v1/agents/:uuid/devices/:name - Update device
 * - DELETE /api/v1/agents/:uuid/devices/:name - Delete device
 * 
 * Health & History Endpoints:
 * - GET /api/v1/agents/:uuid/device-health - Sensor overview and status
 * - GET /api/v1/agents/:uuid/protocol-adapters/:protocol/:deviceName/history - Protocol adapter history
 */


import { query } from '../../db/connection';
import { deviceSensorSync, prepareEndpointForCreate, type EndpointDeviceConfig } from '../../services/agent/devices';
import { logger } from '../../utils/logger';
import { jwtAuth, requireRole } from '../../middleware/jwt-auth';
import { VirtualAgentManager, type VirtualAgentConfig } from '../../services/provisioning/virtual-agent-manager';
import type { FastifyPluginAsync } from 'fastify'

type AgentUuidParams = {
  uuid: string;
};

type AgentDeviceParams = {
  uuid: string;
  name: string;
};

type AgentDeviceHistoryParams = {
  uuid: string;
  protocol: string;
  deviceName: string;
};

type VirtualDeviceParams = {
  uuid: string;
  virtualDeviceUuid: string;
};

type DevicesQuerystring = {
  protocol?: string;
};

type ValidateOnlyQuerystring = {
  validateOnly?: string;
};

type HardDeleteQuerystring = {
  hard?: string;
};

type DeviceHealthQuerystring = {
  protocolType?: string;
};

type DeviceHistoryQuerystring = {
  hours?: string;
};

type EndpointConfig = {
  name?: string;
  uuid?: string;
  protocol?: string;
  enabled?: boolean;
  connection?: Record<string, unknown>;
  dataPoints?: unknown[];
  pollInterval?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type VirtualDeviceCreateBody = {
  name?: string;
  protocol?: string;
  profile?: string;
  image?: string;
  slaveCount?: number;
};

type ReportedDeviceRow = {
  uuid: string;
  agent_uuid: string;
  endpoint_uuid: string | null;
  name: string;
  protocol: string;
  identifier: string | null;
  enabled: boolean;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

type DeviceHealthRow = {
  name: string;
  protocol: string;
  enabled: boolean;
  poll_interval: number | null;
  connection: Record<string, unknown> | null;
  data_points: unknown[] | null;
  metadata: Record<string, unknown> | null;
  updated_at: string;
  synced_to_config: boolean;
  health_status: string | null;
  health_connected: boolean | null;
  health_last_poll: string | null;
  health_error_count: number | null;
  health_last_error: string | null;
  health_updated_at: string | null;
  last_telemetry_at: string | null;
  location: string | null;
};

const endpointProtocols = ['modbus', 'can', 'opcua', 'mqtt', 'snmp'] as const;
const virtualDeviceProtocols = ['modbus', 'opcua'] as const;

function isEndpointProtocol(value: unknown): value is EndpointDeviceConfig['protocol'] {
  return typeof value === 'string' && endpointProtocols.includes(value as EndpointDeviceConfig['protocol']);
}

function isVirtualDeviceProtocol(value: unknown): value is VirtualAgentConfig['protocol'] {
  return typeof value === 'string' && virtualDeviceProtocols.includes(value as VirtualAgentConfig['protocol']);
}

function toEndpointDeviceConfig(config: EndpointConfig): EndpointDeviceConfig {
  return {
    ...config,
    name: config.name as string,
    protocol: config.protocol as EndpointDeviceConfig['protocol'],
    enabled: config.enabled ?? true,
    connection: config.connection as EndpointDeviceConfig['connection'],
    dataPoints: (config.dataPoints ?? []) as EndpointDeviceConfig['dataPoints'],
  };
}

function toEndpointDeviceUpdate(config: EndpointConfig): Partial<EndpointDeviceConfig> {
  const { protocol, dataPoints, ...rest } = config;
  const updates: Partial<EndpointDeviceConfig> = {
    ...rest,
  };

  if (protocol !== undefined) {
    updates.protocol = protocol as EndpointDeviceConfig['protocol'];
  }

  if (dataPoints !== undefined) {
    updates.dataPoints = dataPoints as EndpointDeviceConfig['dataPoints'];
  }

  return updates;
}

const plugin: FastifyPluginAsync = async (fastify) => {

// Initialize virtual device manager
const virtualDeviceManager = new VirtualAgentManager();

/**
 * List all devices for an agent
 * GET /api/v1/agents/:uuid/devices
 * 
 * Reads from endpoints table (faster, allows filtering/sorting)
 */

fastify.get<{ Params: AgentUuidParams; Querystring: DevicesQuerystring }>('/agents/:uuid/devices', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid } = req.params;
    const { protocol } = req.query; // Optional filter by protocol

    const sensors = await deviceSensorSync.getEndpoints(
      uuid, 
      protocol as string | undefined
    );

    return reply.send({
      devices: sensors,
      agents: sensors, // Keep "agents" for backward compatibility
      count: sensors.length
    });
  } catch (error: any) {
    logger.error('Error getting devices:', error);
    return reply.status(500).send({
      error: 'Failed to get devices',
      message: error.message
    });
  }
});

/**
 * List agent-reported physical/logical devices for an agent.
 * GET /api/v1/agents/:uuid/reported-devices
 */

fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/reported-devices', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid } = req.params;

    const result = await query<ReportedDeviceRow>(
      `SELECT
         uuid,
         agent_uuid,
         endpoint_uuid,
         name,
         protocol,
         identifier,
         enabled,
         last_seen_at,
         created_at,
         updated_at
       FROM agent_devices
       WHERE agent_uuid = $1
       ORDER BY protocol, name`,
      [uuid]
    );

    return reply.send({
      agent_uuid: uuid,
      count: result.rows.length,
      devices: result.rows,
    });
  } catch (error: any) {
    logger.error('Error getting agent devices:', error);
    return reply.status(500).send({
      error: 'Failed to get agent devices',
      message: error.message,
    });
  }
});

/**
 * Add new device
 * POST /api/v1/agents/:uuid/devices
 * 
 * Query Parameters:
 * - validateOnly=true: Only validate config, don't persist (for draft mode)
 * - validateOnly=false (default): Validate and persist using dual-write
 */

fastify.post<{ Params: AgentUuidParams; Querystring: ValidateOnlyQuerystring; Body: EndpointConfig }>('/agents/:uuid/devices', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid } = req.params;
    const sensorConfig = req.body;
    const validateOnly = req.query.validateOnly === 'true';


    // Basic validation
    if (!sensorConfig.name) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Device name is required'
      });
    }

    if (!sensorConfig.protocol) {
      logger.error('Protocol missing in request:', sensorConfig);
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Protocol is required'
      });
    }

    if (!isEndpointProtocol(sensorConfig.protocol)) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: `Protocol must be one of: ${endpointProtocols.join(', ')}`
      });
    }

    if (!sensorConfig.connection) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'Connection configuration is required'
      });
    }

    // OPC UA and MQTT use connection-driven ingestion, dataPoints can be empty
    // Other protocols (e.g., Modbus) require at least one data point
    if (!['opcua', 'mqtt'].includes(sensorConfig.protocol)) {
      if (!sensorConfig.dataPoints || sensorConfig.dataPoints.length === 0) {
        return reply.status(400).send({
          error: 'Validation failed',
          message: 'At least one data point is required'
        });
      }
    }

    const endpointConfig = toEndpointDeviceConfig(sensorConfig);

    // If validation-only mode, return validated config without persisting
    if (validateOnly) {
      const preparedSensorConfig = prepareEndpointForCreate(uuid, endpointConfig);

      // Normalize the sensor config
      // For OPC UA: omit dataPoints if empty (auto-discovery will populate)
      const validatedSensor: EndpointConfig = {
        name: preparedSensorConfig.name,
        uuid: preparedSensorConfig.uuid,
        protocol: preparedSensorConfig.protocol,
        enabled: preparedSensorConfig.enabled !== undefined ? preparedSensorConfig.enabled : true,
        connection: preparedSensorConfig.connection,
        metadata: {
          createdAt: new Date().toISOString(),
          createdBy: req.user?.username || req.user?.email || 'dashboard'
        }
      };

      if (preparedSensorConfig.protocol !== 'mqtt' && sensorConfig.pollInterval !== undefined) {
        validatedSensor.pollInterval = sensorConfig.pollInterval;
      }
      
      // Only include dataPoints if present and not empty (or if not OPC UA)
      if (preparedSensorConfig.dataPoints && (preparedSensorConfig.dataPoints.length > 0 || preparedSensorConfig.protocol !== 'opcua')) {
        validatedSensor.dataPoints = preparedSensorConfig.dataPoints;
      }

      logger.info('Returning validated sensor (not persisting):', validatedSensor.name);
      
      return reply.status(200).send({
        status: 'ok',
        message: 'Sensor validated successfully. Add to pending state.',
        sensor: validatedSensor,
        validateOnly: true
      });
    }

    // Standard path: Add sensor using sync service (handles dual-write)
    const result = await deviceSensorSync.addEndpoint(
      uuid,
      endpointConfig,
      req.user?.username || req.user?.email || 'dashboard'
    );

    return reply.status(201).send({
      status: 'ok',
      message: 'Device added. Click Sync to deploy.',
      device: result.sensor, // Keep "device" for backward compatibility
      version: result.version
    });
  } catch (error: any) {
    logger.error('Error adding device:', error);
    
    if (error.message?.includes('already exists')) {
      return reply.status(409).send({
        error: 'Duplicate device',
        message: error.message
      });
    }
    
    if (error.message?.includes('not found')) {
      return reply.status(404).send({
        error: 'Device not found',
        message: error.message
      });
    }
    
    return reply.status(500).send({
      error: 'Failed to add device',
      message: error.message
    });
  }
});

/**
 * Update device
 * PUT /api/v1/agents/:uuid/devices/:name
 * 
 * Query Parameters:
 * - validateOnly=true: Only validate updates, don't persist (for draft mode)
 * - validateOnly=false (default): Validate and persist using dual-write
 */

fastify.put<{ Params: AgentDeviceParams; Querystring: ValidateOnlyQuerystring; Body: EndpointConfig }>('/agents/:uuid/devices/:name', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid, name } = req.params;
    const updates = req.body;
    const validateOnly = req.query.validateOnly === 'true';

    logger.info('Update sensor:', { uuid, name, validateOnly });

    // If validation-only mode, just validate and return
    if (validateOnly) {
      // Basic validation on updates
      if (updates.protocol && typeof updates.protocol !== 'string') {
        return reply.status(400).send({
          error: 'Validation failed',
          message: 'Protocol must be a string'
        });
      }

      if (updates.protocol !== undefined && !isEndpointProtocol(updates.protocol)) {
        return reply.status(400).send({
          error: 'Validation failed',
          message: `Protocol must be one of: ${endpointProtocols.join(', ')}`
        });
      }

      // OPC UA uses auto-discovery, dataPoints can be empty
      // Other protocols require at least one data point
      if (updates.dataPoints && !Array.isArray(updates.dataPoints)) {
        return reply.status(400).send({
          error: 'Validation failed',
          message: 'Data points must be an array'
        });
      }
      
      // Only enforce non-empty dataPoints for protocols that require explicit point maps
      if (updates.protocol && !['opcua', 'mqtt'].includes(updates.protocol) && updates.dataPoints && updates.dataPoints.length === 0) {
        return reply.status(400).send({
          error: 'Validation failed',
          message: 'Data points must be a non-empty array'
        });
      }

      return reply.status(200).send({
        status: 'ok',
        message: 'Updates validated successfully. Add to pending state.',
        updates: updates,
        validateOnly: true
      });
    }

    const endpointUpdates = toEndpointDeviceUpdate(updates);

    // Update sensor using sync service (handles dual-write)
    const result = await deviceSensorSync.updateEndpoint(
      uuid,
      name,
      endpointUpdates,
      req.user?.username || req.user?.email || 'dashboard'
    );

    return reply.send({
      status: 'ok',
      message: 'Device updated',
      device: result.sensor, // Keep "device" for backward compatibility
      version: result.version
    });
  } catch (error: any) {
    logger.error('Error updating device:', error);
    
    if (error.message?.includes('not found')) {
      return reply.status(404).send({
        error: 'Device not found',
        message: error.message
      });
    }
    
    return reply.status(500).send({
      error: 'Failed to update device',
      message: error.message
    });
  }
});

/**
 * Delete device
 * DELETE /api/v1/agents/:uuid/devices/:name
 * 
 * Query Parameters:
 * - hard=true: Hard delete immediately (remove from target state config + endpoints)
 * - hard=false (default): Soft delete (mark pending_deletion, wait for agent reconciliation)
 */

fastify.delete<{ Params: AgentDeviceParams; Querystring: HardDeleteQuerystring }>('/agents/:uuid/devices/:name', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid, name } = req.params;
    const hardDelete = req.query.hard === 'true';

    const actor = req.user?.username || req.user?.email || 'dashboard';
    const result = hardDelete
      ? await deviceSensorSync.hardDeleteEndpoint(uuid, name, actor)
      : await deviceSensorSync.deleteEndpoint(uuid, name, actor);

    return reply.send({
      status: 'ok',
      mode: hardDelete ? 'hard' : 'soft',
      message: hardDelete
        ? 'Device hard deleted (removed from target state and database)'
        : 'Device marked for deletion (pending agent reconciliation)',
      version: result.version
    });
  } catch (error: any) {
    logger.error('Error deleting device:', error);
    
    if (error.message?.includes('not found')) {
      return reply.status(404).send({
        error: 'Device not found',
        message: error.message
      });
    }
    
    return reply.status(500).send({
      error: 'Failed to delete device',
      message: error.message
    });
  }
});

// ============================================================================
// Health Monitoring & Historical Data
// ============================================================================

/**
 * Get device sensor overview
 * Shows Configured Endpoints with protocol breakdown
 * GET /api/v1/agents/:uuid/device-health
 */

fastify.get<{ Params: AgentUuidParams; Querystring: DeviceHealthQuerystring }>('/agents/:uuid/device-health', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid } = req.params;
    const { protocolType } = req.query;

    let whereClause = 'agent_uuid = $1';
    const params: string[] = [uuid];

    if (protocolType) {
      whereClause += ' AND protocol = $2';
      params.push(protocolType);
    }

    const result = await query<DeviceHealthRow>(
      `SELECT 
        ds.name,
        ds.protocol,
        ds.enabled,
        ds.poll_interval,
        ds.connection,
        ds.data_points,
        ds.metadata,
        ds.updated_at,
        ds.synced_to_config,
        ds.health_status,
        ds.health_connected,
        ds.health_last_poll,
        ds.health_error_count,
        ds.health_last_error,
        ds.health_updated_at,
        ds.last_telemetry_at,
        ds.location
      FROM endpoints ds
      WHERE ${whereClause}
      ORDER BY ds.protocol, ds.name`,
      params
    );

    const agents = result.rows.map((row) => ({
      name: row.name,
      protocol: row.protocol,
      status: row.health_status || (row.enabled ? 'configured' : 'disabled'),
      enabled: row.enabled,
      pollInterval: row.poll_interval,
      connection: row.connection,
      dataPoints: row.data_points,
      lastUpdated: row.updated_at,
      synced: row.synced_to_config,
      connected: row.health_connected ?? false,
      lastPoll: row.health_last_poll || null,
      errorCount: row.health_error_count ?? 0,
      lastError: row.health_last_error || null,
      lastSeen: row.health_updated_at || null,
      lastTelemetryAt: row.last_telemetry_at || null,
      location: row.location || null
    }));

    const summary = {
      total: agents.length,
      enabled: agents.filter((device) => device.enabled).length,
      disabled: agents.filter((device) => !device.enabled).length,
      byProtocol: result.rows.reduce<Record<string, number>>((acc, row) => {
        acc[row.protocol] = (acc[row.protocol] || 0) + 1;
        return acc;
      }, {})
    };

    return reply.send({
      deviceUuid: uuid,
      summary,
      devices: agents,
      agents
    });
  } catch (error: any) {
    logger.error('Error fetching device sensors:', error);
    return reply.status(500).send({
      error: 'Failed to fetch device sensors',
      message: error.message
    });
  }
});

/**
 * Get protocol adapter health history for time-series charts
 * GET /api/v1/agents/:uuid/protocol-adapters/:protocol/:deviceName/history
 * Query params: ?hours=24 (default)
 */

fastify.get<{ Params: AgentDeviceHistoryParams; Querystring: DeviceHistoryQuerystring }>('/agents/:uuid/protocol-adapters/:protocol/:deviceName/history', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid, protocol, deviceName } = req.params;
    const hours = Number.parseInt(req.query.hours ?? '', 10) || 24;

    const result = await query(
      `SELECT 
        protocol_type,
        device_name,
        connected,
        last_poll,
        error_count,
        last_error,
        timestamp
      FROM protocol_adapter_health_history
      WHERE agent_uuid = $1 
        AND protocol_type = $2
        AND device_name = $3
        AND timestamp > NOW() - INTERVAL '1 hour' * $4
      ORDER BY timestamp DESC
      LIMIT 1000`,
      [uuid, protocol, deviceName, hours]
    );

    return reply.send({
      agent_uuid: uuid,
      protocol_type: protocol,
      device_name: deviceName,
      hours,
      count: result.rows.length,
      history: result.rows
    });
  } catch (error: any) {
    logger.error('Error fetching protocol adapter history:', error);
    return reply.status(500).send({
      error: 'Failed to fetch protocol adapter history',
      message: error.message
    });
  }
});


// =============================================================================
// VIRTUAL DEVICE ROUTES
// Manage virtual protocol simulators deployed as sidecar containers
// =============================================================================

/**
 * Create virtual device (protocol simulator sidecar)
 * POST /api/v1/agents/:uuid/virtual-agents
 * 
 * Body: {
 *   name: "Virtual PLC 1",
 *   protocol: "modbus" | "opcua",
 *   profile: "PM556x" | "Generic",
 *   image: "iotistic/modbus-simulator:latest" (optional),
 *   slaveCount: 40 (optional)
 * }
 * 
 * Flow:
 * 1. Creates record in endpoints table with virtual=true metadata
 * 2. Auto-assigns port (502, 503, 504... for Modbus)
 * 3. If parent is K8s virtual agent, patches Deployment to add sidecar container
 * 4. If parent is physical agent, agent will reconcile sidecar on next state sync
 * 5. Agent connects to virtual device at localhost:port like a normal physical device
 */

fastify.post<{ Params: AgentUuidParams; Body: VirtualDeviceCreateBody }>('/agents/:uuid/virtual-agents', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid } = req.params;
    const { name, protocol, profile, image, slaveCount } = req.body;

    // Validation
    if (!name || !protocol || !profile) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'name, protocol, and profile are required'
      });
    }

    if (!['modbus', 'opcua'].includes(protocol)) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'protocol must be either "modbus" or "opcua"'
      });
    }

    if (!isVirtualDeviceProtocol(protocol)) {
      return reply.status(400).send({
        error: 'Validation failed',
        message: 'protocol must be either "modbus" or "opcua"'
      });
    }

    const virtualDeviceConfig: VirtualAgentConfig = {
      deviceUuid: uuid,
      name,
      protocol,
      profile,
      image,
      slaveCount
    };

    // Create virtual device
    const virtualDevice = await virtualDeviceManager.createVirtualDevice(virtualDeviceConfig);

    logger.info('Virtual device created via API', {
      deviceUuid: uuid,
      virtualDeviceUuid: virtualDevice.uuid,
      protocol,
      profile,
      port: virtualDevice.connection.port
    });

    return reply.status(201).send({
      status: 'ok',
      message: 'Virtual device created. Agent will auto-configure connection.',
      virtualDevice: {
        uuid: virtualDevice.uuid,
        name: virtualDevice.name,
        protocol: virtualDevice.protocol,
        profile: virtualDevice.metadata.profile,
        connection: virtualDevice.connection,
        image: virtualDevice.metadata.image
      }
    });
  } catch (error: any) {
    logger.error('Error creating virtual device:', error);
    
    if (error.message?.includes('not found')) {
      return reply.status(404).send({
        error: 'Not found',
        message: error.message
      });
    }

    return reply.status(500).send({
      error: 'Failed to create virtual device',
      message: error.message
    });
  }
});

/**
 * List virtual agents for a device
 * GET /api/v1/agents/:uuid/virtual-agents
 * 
 * Returns all virtual device sidecars configured for the agent
 */

fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/virtual-agents', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid } = req.params;

    const virtualDevices = await virtualDeviceManager.getVirtualDevices(uuid);

    return reply.send({
      virtualDevices: virtualDevices.map(vd => ({
        uuid: vd.uuid,
        name: vd.name,
        protocol: vd.protocol,
        profile: vd.metadata.profile,
        connection: vd.connection,
        image: vd.metadata.image,
        dataPoints: vd.data_points || [] // Include data points
      })),
      count: virtualDevices.length
    });
  } catch (error: any) {
    logger.error('Error listing virtual agents:', error);
    return reply.status(500).send({
      error: 'Failed to list virtual agents',
      message: error.message
    });
  }
});

/**
 * Delete virtual device
 * DELETE /api/v1/agents/:uuid/virtual-agents/:virtualDeviceUuid
 * 
 * Flow:
 * 1. Deletes record from endpoints table
 * 2. If parent is K8s virtual agent, patches Deployment to remove sidecar
 * 3. If parent is physical agent, agent will remove sidecar on next state sync
 */

fastify.delete<{ Params: VirtualDeviceParams }>('/agents/:uuid/virtual-agents/:virtualDeviceUuid', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { uuid, virtualDeviceUuid } = req.params;

    await virtualDeviceManager.deleteVirtualDevice(uuid, virtualDeviceUuid);

    logger.info('Virtual device deleted via API', {
      deviceUuid: uuid,
      virtualDeviceUuid
    });

    return reply.send({
      status: 'ok',
      message: 'Virtual device deleted'
    });
  } catch (error: any) {
    logger.error('Error deleting virtual device:', error);
    return reply.status(500).send({
      error: 'Failed to delete virtual device',
      message: error.message
    });
  }
});
};

export default plugin;
