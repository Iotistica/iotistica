/**
 * Profile Configuration Management Routes
 * 
 * Replaces static dataPoints.json file with dynamic database-backed profile configs.
 * Allows adding/updating protocol profile configurations via API.
 * 
 * Routes:
 * - GET    /api/v1/profiles?protocol=modbus - List all profiles for protocol
 * - GET    /api/v1/profiles/:name?protocol=modbus - Get specific profile config
 * - POST   /api/v1/profiles - Create/update profile config
 * - DELETE /api/v1/profiles/:name - Delete profile config
 */

import express from 'express';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';

// Profile Config Model (inline for simplicity)
class ProfileConfigModel {
  static async get(profileName: string, protocol: string = 'modbus') {
    const result = await query(
      'SELECT * FROM profile_configs WHERE profile_name = $1 AND protocol = $2',
      [profileName, protocol]
    );
    return result.rows[0] || null;
  }

  static async listByProtocol(protocol: string) {
    const result = await query(
      'SELECT * FROM profile_configs WHERE protocol = $1 ORDER BY profile_name',
      [protocol]
    );
    return result.rows;
  }

  static async upsert(profileName: string, protocol: string, dataPoints: any[], metadata?: any) {
    const result = await query(
      `INSERT INTO profile_configs (profile_name, protocol, data_points, metadata)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (profile_name) DO UPDATE SET
         protocol = $2,
         data_points = $3,
         metadata = $4,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [profileName, protocol, JSON.stringify(dataPoints), metadata ? JSON.stringify(metadata) : null]
    );
    return result.rows[0];
  }

  static async delete(profileName: string) {
    await query('DELETE FROM profile_configs WHERE profile_name = $1', [profileName]);
  }
}

const router = express.Router();
import { jwtAuth } from '../middleware/jwt-auth';
import { validateApiKey } from '../middleware/api-key-auth';

/**
 * Simulator endpoint for protocol simulators (API KEY REQUIRED)
 * GET /api/v1/profiles/sim/datapoints?protocol=modbus
 * 
 * REQUIRES API KEY - For internal Docker network services
 * Used by protocol simulators (modbus-sim, opcua-simulator, bacnet-sim)
 * 
 * Authentication: Authorization: Bearer <api-key> header (from api_keys table)
 * Security: Only accessible within Docker network, not exposed externally
 * 
 * Returns format compatible with modbus-simulator:
 * {
 *   "Generic": { "dataPoints": [...] },
 *   "COMAP": { "dataPoints": [...] }
 * }
 */
router.get('/sim/datapoints', validateApiKey, async (req, res) => {
  try {
    const protocol = (req.query.protocol as string) || 'modbus';
    const profiles = await ProfileConfigModel.listByProtocol(protocol);

    // Transform to dataPoints.json format
    const dataPointsFormat: Record<string, any> = {};
    for (const profile of profiles) {
      // Parse data_points if it's a JSON string
      const dataPoints = typeof profile.data_points === 'string' 
        ? JSON.parse(profile.data_points) 
        : profile.data_points;
      
      // Parse metadata if it's a JSON string
      const metadata = profile.metadata 
        ? (typeof profile.metadata === 'string' ? JSON.parse(profile.metadata) : profile.metadata)
        : undefined;
      
      dataPointsFormat[profile.profile_name] = {
        dataPoints: dataPoints,
        ...(metadata && { metadata })
      };
    }

    logger.debug('Internal profiles accessed', { protocol, count: profiles.length });
    res.json(dataPointsFormat);
  } catch (error: any) {
    logger.error('Error getting internal datapoints', { error: error.message, stack: error.stack });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

/**
 * Get all profiles in dataPoints.json format (PROTECTED - Dashboard Use)
 * GET /api/v1/profiles/datapoints?protocol=modbus
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint for dashboard
 * Used by dashboard GUI to display available profiles
 * 
 * Returns format compatible with modbus-simulator:
 * {
 *   "Generic": { "dataPoints": [...] },
 *   "COMAP": { "dataPoints": [...] }
 * }
 */
router.get('/datapoints', jwtAuth, async (req, res) => {
  try {
    const protocol = (req.query.protocol as string);
    const profiles = await ProfileConfigModel.listByProtocol(protocol);

    // Transform to dataPoints.json format
    const dataPointsFormat: Record<string, any> = {};
    for (const profile of profiles) {
      // Parse data_points if it's a JSON string
      const dataPoints = typeof profile.data_points === 'string' 
        ? JSON.parse(profile.data_points) 
        : profile.data_points;
      
      // Parse metadata if it's a JSON string
      const metadata = profile.metadata 
        ? (typeof profile.metadata === 'string' ? JSON.parse(profile.metadata) : profile.metadata)
        : undefined;
      
      dataPointsFormat[profile.profile_name] = {
        dataPoints: dataPoints,
        ...(metadata && { metadata })
      };
    }

    res.json(dataPointsFormat);
  } catch (error: any) {
    logger.error('Error getting datapoints', { error: error.message, stack: error.stack });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

/**
 * Create or update profile configuration (PROTECTED)
 * POST /api/v1/profiles
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 * Allows authorized users to save modified profiles
 */
router.post('/', jwtAuth, async (req, res) => {
  try {
    const { profile_name, protocol, data_points, metadata } = req.body;

    // Validation
    if (!profile_name || typeof profile_name !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'profile_name is required and must be a string'
      });
    }

    if (!protocol || typeof protocol !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'protocol is required and must be a string (e.g., "modbus")'
      });
    }

    if (!data_points || !Array.isArray(data_points)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'data_points is required and must be an array'
      });
    }

    // Protocol-specific data point validation
    if (protocol === 'modbus' && data_points.length > 0) {
      // Modbus requires: name, address, type, dataType
      for (const dp of data_points) {
        if (!dp.name || dp.address === undefined || !dp.type || !dp.dataType) {
          return res.status(400).json({
            error: 'Invalid data point',
            message: 'Each Modbus data point must have: name, address, type, dataType'
          });
        }
      }
    } else if (protocol === 'opcua' && data_points.length > 0) {
      // OPC UA sensor groups: folder, prefix, model, count, unit, config
      // OR manual nodes: name, nodeId
      for (const dp of data_points) {
        const isSensorGroup = dp.folder && dp.prefix && dp.model && dp.count;
        const isNode = dp.name && dp.nodeId;
        
        if (!isSensorGroup && !isNode) {
          return res.status(400).json({
            error: 'Invalid data point',
            message: 'Each OPC UA data point must be either a sensor group (folder, prefix, model, count, unit, config) or node (name, nodeId)'
          });
        }
        
        // Enforce OPC UA naming convention (IEC 62541 best practices)
        if (isSensorGroup) {
          // Prefix must use format: MetricType_ (e.g., "Temperature_", "Pressure_", "Flow_")
          if (!dp.prefix.includes('_') || !dp.prefix.endsWith('_')) {
            return res.status(400).json({
              error: 'Invalid OPC UA prefix',
              message: `Prefix "${dp.prefix}" must follow format "MetricType_" (e.g., "Temperature_", "Pressure_", "Flow_"). This ensures proper metric extraction following OPC UA standards.`
            });
          }
          
          // Model must be lowercase semantic name (matches prefix without underscore)
          if (!/^[a-z_]+$/.test(dp.model)) {
            return res.status(400).json({
              error: 'Invalid OPC UA model',
              message: `Model "${dp.model}" must be lowercase with underscores only (e.g., "temperature", "pressure", "flow_rate"). This is the semantic metric name used in data collection.`
            });
          }
          
          // Validate prefix and model consistency (warn if mismatch)
          const expectedModel = dp.prefix.replace(/_$/, '').toLowerCase();
          if (dp.model !== expectedModel) {
            logger.warn('OPC UA sensor group prefix/model mismatch', {
              prefix: dp.prefix,
              model: dp.model,
              expected: expectedModel,
              message: 'Prefix should match model (e.g., "Temperature_" → "temperature")'
            });
          }
        }
      }
    }
    // Other protocols: no validation (auto-discovery or custom structure)

    const profile = await ProfileConfigModel.upsert(
      profile_name,
      protocol,
      data_points,
      metadata
    );

    logger.info('Profile config updated', { profile: profile_name, protocol, dataPointsCount: data_points.length, userId: req.user?.id });

    res.json({
      status: 'ok',
      message: `Profile '${profile_name}' configuration saved`,
      profile
    });
  } catch (error: any) {
    logger.error('Error saving profile config', { error: error.message, stack: error.stack });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

/**
 * List all profile configurations for a protocol
 * GET /api/v1/profiles?protocol=modbus
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 * Used by dashboard to show available profiles in device configuration
 */
router.get('/', jwtAuth, async (req, res) => {
  try {
    const protocol = (req.query.protocol as string) || 'modbus';
    const profiles = await ProfileConfigModel.listByProtocol(protocol);

    res.json(profiles); // Return array directly for simplicity
  } catch (error: any) {
    logger.error('Error listing profiles', { error: error.message, stack: error.stack });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

/**
 * Get specific profile configuration
 * GET /api/v1/profiles/:name?protocol=modbus
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.get('/:name', jwtAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const protocol = (req.query.protocol as string) || 'modbus';

    const profile = await ProfileConfigModel.get(name, protocol);

    if (!profile) {
      return res.status(404).json({
        error: 'Not found',
        message: `Profile '${name}' not found for protocol '${protocol}'`
      });
    }

    res.json(profile);
  } catch (error: any) {
    logger.error('Error getting profile', { error: error.message, profile: req.params.name });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

/**
 * Delete profile configuration
 * DELETE /api/v1/profiles/:name
 * 
 * REQUIRES AUTHENTICATION - Protected endpoint
 */
router.delete('/:name', jwtAuth, async (req, res) => {
  try {
    const { name } = req.params;

    await ProfileConfigModel.delete(name);

    logger.info('Profile config deleted', { profile: name, userId: req.user?.id });

    res.json({
      status: 'ok',
      message: `Profile '${name}' deleted`
    });
  } catch (error: any) {
    logger.error('Error deleting profile', { error: error.message, profile: req.params.name });
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.id || 'unknown'
    });
  }
});

export default router;
