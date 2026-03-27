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

import express from 'express';
import { query } from '../db/connection';
import {
  AgentModel,
  DeviceMetricsModel,
} from '../db/models';


export const router = express.Router();

/**
 * Get device metrics
 * GET /api/v1/agents/:uuid/metrics
 * Query params:
 * - limit: number of recent records (default 100)
 * - period: time period (30min, 6h, 12h, 24h)
 * Note: No auth required - called by dashboard, not device
 */
router.get('/agents/:uuid/metrics', async (req, res) => {
  try {
    const { uuid } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;
    const period = req.query.period as string;

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
      
      metrics = await DeviceMetricsModel.getByTimeRangeMinutes(uuid, minutes, maxPoints);
    } else {
      metrics = await DeviceMetricsModel.getRecent(uuid, limit);
    }

    res.json({
      count: metrics.length,
      metrics,
    });
  } catch (error: any) {
    console.error('Error getting metrics:', error);
    res.status(500).json({
      error: 'Failed to get metrics',
      message: error.message
    });
  }
});

/**
 * Get current top processes for device
 * GET /api/v1/agents/:uuid/processes
 */
router.get('/agents/:uuid/processes', async (req, res) => {
  try {
    const { uuid } = req.params;

    // Get device to check if it exists and get latest processes
    const device = await AgentModel.getByUuid(uuid);
    if (!device) {
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    res.json({
      agent_uuid: uuid,
      top_processes: device.top_processes || [],
      is_online: device.is_online,
      last_updated: device.modified_at,
    });
  } catch (error: any) {
    console.error('Error getting top processes:', error);
    res.status(500).json({
      error: 'Failed to get top processes',
      message: error.message
    });
  }
});

/**
 * Get network interfaces for device
 * GET /api/v1/agents/:uuid/network-interfaces
 */
router.get('/agents/:uuid/network-interfaces', async (req, res) => {
  try {
    const { uuid } = req.params;

    // Get device to check if it exists and get network interfaces
    const device = await AgentModel.getByUuid(uuid);
    if (!device) {
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }

    // Get network interfaces from device (stored as JSONB)
    let interfaces = [];
    
    if (device.network_interfaces) {
      // Parse if it's a string, otherwise use as-is
      const networkData = typeof device.network_interfaces === 'string' 
        ? JSON.parse(device.network_interfaces) 
        : device.network_interfaces;
      
      // Transform to dashboard format
      interfaces = networkData.map((iface: any) => ({
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

    res.json({
      agent_uuid: uuid,
      interfaces,
      is_online: device.is_online,
      last_updated: device.modified_at,
    });
  } catch (error: any) {
    console.error('Error getting network interfaces:', error);
    res.status(500).json({
      error: 'Failed to get network interfaces',
      message: error.message
    });
  }
});

/**
 * Get historical process metrics for device
 * GET /api/v1/agents/:uuid/processes/history
 */
router.get('/agents/:uuid/processes/history', async (req, res) => {
  try {
    const { uuid } = req.params;
    const limit = parseInt(req.query.limit as string) || 50;
    const hours = parseInt(req.query.hours as string) || 24;

    // Query metrics with process data
    const result = await query(
      `SELECT top_processes, recorded_at 
       FROM agent_metrics 
       WHERE agent_uuid = $1 
         AND top_processes IS NOT NULL
         AND recorded_at >= NOW() - INTERVAL '${hours} hours'
       ORDER BY recorded_at DESC 
       LIMIT $2`,
      [uuid, limit]
    );

    // Parse JSONB data
    const history = result.rows.map(row => ({
      top_processes: typeof row.top_processes === 'string' 
        ? JSON.parse(row.top_processes) 
        : row.top_processes,
      recorded_at: row.recorded_at,
    }));

    res.json({
      agent_uuid: uuid,
      count: history.length,
      history,
    });
  } catch (error: any) {
    console.error('Error getting process history:', error);
    res.status(500).json({
      error: 'Failed to get process history',
      message: error.message
    });
  }
});


export default router;
