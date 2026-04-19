/**
 * Device State Management Routes
 * Handles device target state, current state, and state reporting
 * 
 * Separated from cloud.ts for better organization
 * 
 * Device-Side Endpoints (used by agents themselves):
 * - GET  /api/v1/device/:uuid/state - Device polls for target state (ETag cached)
 * - POST /api/v1/device/:uuid/logs - Device uploads logs
 * - PATCH /api/v1/device/state - Device reports current state + metrics
 * 
 * Management API Endpoints (used by dashboard/admin):
 * - GET /api/v1/agents/:uuid/target-state - Get device target state
 * - POST /api/v1/agents/:uuid/target-state - Set device target state
 * - PUT /api/v1/agents/:uuid/target-state - Update device target state
 * - GET /api/v1/agents/:uuid/current-state - Get device current state
 * - DELETE /api/v1/agents/:uuid/target-state - Clear device target state
 * - GET /api/v1/agents/:uuid/logs - Get device logs
 * - GET /api/v1/agents/:uuid/metrics - Get device metrics
 */


import {
  AgentModel,
  AgentMetricsModel,
} from '../../services/agent/agents';
import { logger } from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify'

type AgentUuidParams = {
  uuid: string;
};

type MetricsQuerystring = {
  limit?: string | number;
  period?: string;
};

type NetworkInterfaceRow = {
  name: string;
  type?: string;
  ip4?: string;
  ip6?: string;
  mac?: string;
  operstate?: string;
  default?: boolean;
  virtual?: boolean;
  ssid?: string;
  signalLevel?: number;
};

function parseNumericQuery(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

const plugin: FastifyPluginAsync = async (fastify) => {


/**
 * Get device metrics
 * GET /api/v1/agents/:uuid/metrics
 * Query params:
 * - limit: number of recent records (default 100)
 * - period: time period (30min, 6h, 12h, 24h)
 * Note: No auth required - called by dashboard, not device
 */
fastify.get<{ Params: AgentUuidParams; Querystring: MetricsQuerystring }>('/agents/:uuid/metrics', async (req, reply) => {
  try {
    const { uuid } = req.params;
    const limit = parseNumericQuery(req.query.limit, 100);
    const { period } = req.query;

    let metrics;
    
    if (period) {
      let minutes: number;
      const maxPoints = 60;
      
      switch (period) {
        case '30min':
          minutes = 30;
          break;
        case '6h':
          minutes = 360;
          break;
        case '12h':
          minutes = 720;
          break;
        case '24h':
          minutes = 1440;
          break;
        default:
          minutes = 30;
      }
      
      metrics = await AgentMetricsModel.getByTimeRangeMinutes(uuid, minutes, maxPoints);
    } else {
      metrics = await AgentMetricsModel.getRecent(uuid, limit);
    }

    return reply.send({
      count: metrics.length,
      metrics,
    });
  } catch (error: any) {
    logger.error('Error getting metrics', { error: error.message, stack: error.stack });
    return reply.status(500).send({
      error: 'Failed to get metrics',
      message: error.message
    });
  }
});

/**
 * Get network interfaces for device
 * GET /api/v1/agents/:uuid/network-interfaces
 */
fastify.get<{ Params: AgentUuidParams }>('/agents/:uuid/network-interfaces', async (req, reply) => {
  try {
    const { uuid } = req.params;

    // Get device to check if it exists and get network interfaces
    const device = await AgentModel.getByUuid(uuid);
    if (!device) {
      return reply.status(404).send({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Get network interfaces from device (stored as JSONB)
    let interfaces: Array<Record<string, unknown>> = [];
    
    if (device.network_interfaces) {
      // Parse if it's a string, otherwise use as-is
      const networkData = typeof device.network_interfaces === 'string' 
        ? JSON.parse(device.network_interfaces) 
        : device.network_interfaces;
      
      // Transform to dashboard format
      interfaces = (networkData as NetworkInterfaceRow[]).map((iface) => ({
        id: iface.name,
        name: iface.name,
        type: iface.type || 'ethernet',
        ipAddress: iface.ip4,
        ip4: iface.ip4,
        ip6: iface.ip6,
        mac: iface.mac,
        status: iface.operstate === 'up' ? 'connected' : 'disconnected',
        operstate: iface.operstate,
        default: iface.default,
        virtual: iface.virtual,
        // WiFi specific fields
        ...(iface.ssid && { ssid: iface.ssid }),
        ...(iface.signalLevel && { signal: iface.signalLevel }),
      }));
    } else if (device.ip_address) {
      // Fallback: Create a default interface based on device IP
      interfaces.push({
        id: 'eth0',
        name: 'eth0',
        type: 'ethernet',
        ipAddress: device.ip_address,
        ip4: device.ip_address,
        status: device.is_online ? 'connected' : 'disconnected',
        default: true,
        operstate: device.is_online ? 'up' : 'down',
      });
    }

    return reply.send({
      agent_uuid: uuid,
      interfaces,
      is_online: device.is_online,
      last_updated: device.modified_at,
    });
  } catch (error: any) {
    logger.error('Error getting network interfaces', { error: error.message, stack: error.stack });
    return reply.status(500).send({
      error: 'Failed to get network interfaces',
      message: error.message
    });
  }
});


};

export default plugin;