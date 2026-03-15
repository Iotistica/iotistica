/**
 * Device Sensor Configuration Routes
 * Manages sensor device configurations (Modbus, CAN, OPC-UA, MQTT, etc.)
 * 
 * Pattern: Dual-write with sync service
 * - Config in device_target_state remains source of truth for agent
 * - device_sensors table for efficient querying/display
 * 
 * CRUD Endpoints:
 * - GET /api/v1/devices/:uuid/sensors - List all sensors
 * - POST /api/v1/devices/:uuid/sensors - Add new sensor
 * - PUT /api/v1/devices/:uuid/sensors/:name - Update sensor
 * - DELETE /api/v1/devices/:uuid/sensors/:name - Delete sensor
 * 
 * Health & History Endpoints:
 * - GET /api/v1/devices/:uuid/device-health - Sensor overview and status
 * - GET /api/v1/devices/:uuid/protocol-adapters/:protocol/:deviceName/history - Protocol adapter history
 */

import express from 'express';
import { query } from '../db/connection';
import { deviceSensorSync, prepareEndpointForCreate } from '../services/agent-devices';
import { logger } from '../utils/logger';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { VirtualDeviceManager } from '../services/virtual-device-manager';

export const router = express.Router();

// Initialize virtual device manager
const virtualDeviceManager = new VirtualDeviceManager();

/**
 * List all sensors for a device
 * GET /api/v1/devices/:uuid/sensors
 * 
 * Reads from device_sensors table (faster, allows filtering/sorting)
 */
router.get('/devices/:uuid/sensors', jwtAuth, async (req, res) => {
  try {
    const { uuid } = req.params;
    const { protocol } = req.query; // Optional filter by protocol

    const sensors = await deviceSensorSync.getEndpoints(
      uuid, 
      protocol as string | undefined
    );

    res.json({
      devices: sensors, // Keep "devices" for backward compatibility
      count: sensors.length
    });
  } catch (error: any) {
    logger.error('Error getting sensors:', error);
    res.status(500).json({
      error: 'Failed to get sensors',
      message: error.message
    });
  }
});

/**
 * Add new sensor
 * POST /api/v1/devices/:uuid/sensors
 * 
 * Query Parameters:
 * - validateOnly=true: Only validate config, don't persist (for draft mode)
 * - validateOnly=false (default): Validate and persist using dual-write
 */
router.post('/devices/:uuid/sensors', jwtAuth, async (req, res) => {
  try {
    const { uuid } = req.params;
    const sensorConfig = req.body;
    const validateOnly = req.query.validateOnly === 'true';


    // Basic validation
    if (!sensorConfig.name) {
      return res.status(400).json({
        error: 'Validation failed',
        message: 'Sensor name is required'
      });
    }

    if (!sensorConfig.protocol) {
      logger.error('Protocol missing in request:', sensorConfig);
      return res.status(400).json({
        error: 'Validation failed',
        message: 'Protocol is required'
      });
    }

    if (!sensorConfig.connection) {
      return res.status(400).json({
        error: 'Validation failed',
        message: 'Connection configuration is required'
      });
    }

    // OPC UA and MQTT use connection-driven ingestion, dataPoints can be empty
    // Other protocols (e.g., Modbus) require at least one data point
    if (!['opcua', 'mqtt'].includes(sensorConfig.protocol)) {
      if (!sensorConfig.dataPoints || sensorConfig.dataPoints.length === 0) {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'At least one data point is required'
        });
      }
    }

    // If validation-only mode, return validated config without persisting
    if (validateOnly) {
      const preparedSensorConfig = prepareEndpointForCreate(uuid, sensorConfig);

      // Normalize the sensor config
      // For OPC UA: omit dataPoints if empty (auto-discovery will populate)
      const validatedSensor: any = {
        name: preparedSensorConfig.name,
        uuid: preparedSensorConfig.uuid,
        protocol: preparedSensorConfig.protocol,
        enabled: preparedSensorConfig.enabled !== undefined ? preparedSensorConfig.enabled : true,
        connection: preparedSensorConfig.connection,
        metadata: {
          createdAt: new Date().toISOString(),
          createdBy: (req as any).user?.username || (req as any).user?.email || 'dashboard'
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
      
      return res.status(200).json({
        status: 'ok',
        message: 'Sensor validated successfully. Add to pending state.',
        sensor: validatedSensor,
        validateOnly: true
      });
    }

    // Standard path: Add sensor using sync service (handles dual-write)
    const result = await deviceSensorSync.addEndpoint(
      uuid,
      sensorConfig,
      (req as any).user?.username || (req as any).user?.email || 'dashboard'
    );

    res.status(201).json({
      status: 'ok',
      message: 'Sensor added. Click Sync to deploy.',
      device: result.sensor, // Keep "device" for backward compatibility
      version: result.version
    });
  } catch (error: any) {
    logger.error('Error adding sensor:', error);
    
    if (error.message?.includes('already exists')) {
      return res.status(409).json({
        error: 'Duplicate sensor',
        message: error.message
      });
    }
    
    if (error.message?.includes('not found')) {
      return res.status(404).json({
        error: 'Device not found',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Failed to add sensor',
      message: error.message
    });
  }
});

/**
 * Update sensor
 * PUT /api/v1/devices/:uuid/sensors/:name
 * 
 * Query Parameters:
 * - validateOnly=true: Only validate updates, don't persist (for draft mode)
 * - validateOnly=false (default): Validate and persist using dual-write
 */
router.put('/devices/:uuid/sensors/:name', jwtAuth, async (req, res) => {
  try {
    const { uuid, name } = req.params;
    const updates = req.body;
    const validateOnly = req.query.validateOnly === 'true';

    logger.info('Update sensor:', { uuid, name, validateOnly });

    // If validation-only mode, just validate and return
    if (validateOnly) {
      // Basic validation on updates
      if (updates.protocol && typeof updates.protocol !== 'string') {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'Protocol must be a string'
        });
      }

      // OPC UA uses auto-discovery, dataPoints can be empty
      // Other protocols require at least one data point
      if (updates.dataPoints && !Array.isArray(updates.dataPoints)) {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'Data points must be an array'
        });
      }
      
      // Only enforce non-empty dataPoints for protocols that require explicit point maps
      if (updates.protocol && !['opcua', 'mqtt'].includes(updates.protocol) && updates.dataPoints && updates.dataPoints.length === 0) {
        return res.status(400).json({
          error: 'Validation failed',
          message: 'Data points must be a non-empty array'
        });
      }

      return res.status(200).json({
        status: 'ok',
        message: 'Updates validated successfully. Add to pending state.',
        updates: updates,
        validateOnly: true
      });
    }

    // Update sensor using sync service (handles dual-write)
    const result = await deviceSensorSync.updateEndpoint(
      uuid,
      name,
      updates,
      (req as any).user?.username || (req as any).user?.email || 'dashboard'
    );

    res.json({
      status: 'ok',
      message: 'Sensor updated',
      device: result.sensor, // Keep "device" for backward compatibility
      version: result.version
    });
  } catch (error: any) {
    logger.error('Error updating sensor:', error);
    
    if (error.message?.includes('not found')) {
      return res.status(404).json({
        error: 'Sensor not found',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Failed to update sensor',
      message: error.message
    });
  }
});

/**
 * Delete sensor
 * DELETE /api/v1/devices/:uuid/sensors/:name
 * 
 * Query Parameters:
 * - hard=true: Hard delete immediately (remove from target state config + device_sensors)
 * - hard=false (default): Soft delete (mark pending_deletion, wait for agent reconciliation)
 */
router.delete('/devices/:uuid/sensors/:name', jwtAuth, async (req, res) => {
  try {
    const { uuid, name } = req.params;
    const hardDelete = req.query.hard === 'true';

    const actor = (req as any).user?.username || (req as any).user?.email || 'dashboard';
    const result = hardDelete
      ? await deviceSensorSync.hardDeleteEndpoint(uuid, name, actor)
      : await deviceSensorSync.deleteEndpoint(uuid, name, actor);

    res.json({
      status: 'ok',
      mode: hardDelete ? 'hard' : 'soft',
      message: hardDelete
        ? 'Sensor hard deleted (removed from target state and database)'
        : 'Sensor marked for deletion (pending agent reconciliation)',
      version: result.version
    });
  } catch (error: any) {
    logger.error('Error deleting sensor:', error);
    
    if (error.message?.includes('not found')) {
      return res.status(404).json({
        error: 'Sensor not found',
        message: error.message
      });
    }
    
    res.status(500).json({
      error: 'Failed to delete sensor',
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
 * GET /api/v1/devices/:uuid/device-health
 */
router.get('/devices/:uuid/device-health', jwtAuth, async (req, res) => {
  try {
    const { uuid } = req.params;
    const { protocolType } = req.query;

    let whereClause = 'device_uuid = $1';
    const params: any[] = [uuid];

    if (protocolType) {
      whereClause += ' AND protocol = $2';
      params.push(protocolType);
    }

    const result = await query(
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
        ds.location
      FROM device_sensors ds
      WHERE ${whereClause}
      ORDER BY ds.protocol, ds.name`,
      params
    );

    const devices = result.rows.map((row: any) => ({
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
      location: row.location || null
    }));

    const summary = {
      total: devices.length,
      enabled: devices.filter((d: any) => d.enabled).length,
      disabled: devices.filter((d: any) => !d.enabled).length,
      byProtocol: result.rows.reduce((acc: any, row: any) => {
        acc[row.protocol] = (acc[row.protocol] || 0) + 1;
        return acc;
      }, {})
    };

    res.json({
      deviceUuid: uuid,
      summary,
      devices
    });
  } catch (error: any) {
    logger.error('Error fetching device sensors:', error);
    res.status(500).json({
      error: 'Failed to fetch device sensors',
      message: error.message
    });
  }
});

/**
 * Get protocol adapter health history for time-series charts
 * GET /api/v1/devices/:uuid/protocol-adapters/:protocol/:deviceName/history
 * Query params: ?hours=24 (default)
 */
router.get('/devices/:uuid/protocol-adapters/:protocol/:deviceName/history', jwtAuth, async (req, res) => {
  try {
    const { uuid, protocol, deviceName } = req.params;
    const hours = parseInt(req.query.hours as string) || 24;

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
      WHERE device_uuid = $1 
        AND protocol_type = $2
        AND device_name = $3
        AND timestamp > NOW() - INTERVAL '1 hour' * $4
      ORDER BY timestamp DESC
      LIMIT 1000`,
      [uuid, protocol, deviceName, hours]
    );

    res.json({
      device_uuid: uuid,
      protocol_type: protocol,
      device_name: deviceName,
      hours,
      count: result.rows.length,
      history: result.rows
    });
  } catch (error: any) {
    logger.error('Error fetching protocol adapter history:', error);
    res.status(500).json({
      error: 'Failed to fetch protocol adapter history',
      message: error.message
    });
  }
});

// ============================================================================
// Legacy/Commented Code (Kept for Reference)
// ============================================================================

/**
 * Get sensor-publish configuration
 * GET /api/v1/devices/:uuid/sensor-config
 */
// router.get('/devices/:uuid/sensor-config', async (req, res) => {
//   try {
//     const { uuid } = req.params;
    
//     // Get current target state
//     const targetState = await DeviceTargetStateModel.get(uuid);
    
//     if (!targetState) {
//       return res.json({
//         sensors: []
//       });
//     }

//     // Parse config to get sensors
//     const config = typeof targetState.config === 'string' 
//       ? JSON.parse(targetState.config) 
//       : targetState.config || {};

//     res.json({
//       sensors: config.sensors || []
//     });
//   } catch (error: any) {
//     console.error('Error getting sensor config:', error);
//     res.status(500).json({
//       error: 'Failed to get sensor configuration',
//       message: error.message
//     });
//   }
// });

/**
 * Add sensor to sensor-publish configuration
 * POST /api/v1/devices/:uuid/sensor-config
 */
// router.post('/devices/:uuid/sensor-config', async (req, res) => {
//   try {
//     const { uuid } = req.params;
//     const sensorConfig = req.body;

//     // Validate required fields
//     if (!sensorConfig.name || !sensorConfig.protocolType || !sensorConfig.platform) {
//       return res.status(400).json({
//         error: 'Invalid sensor configuration',
//         message: 'Required fields: name, protocolType, platform'
//       });
//     }

//     // Auto-generate socket/pipe path based on platform and sensor name
//     const addr = sensorConfig.platform === 'windows'
//       ? `\\\\.\\pipe\\${sensorConfig.name}`
//       : `/tmp/${sensorConfig.name}.sock`;

//     // Auto-generate MQTT topic based on protocol type and sensor name
//     const mqttTopic = `${sensorConfig.protocolType}/${sensorConfig.name}`;
//     const mqttHeartbeatTopic = `${mqttTopic}/heartbeat`;

//     // Build complete sensor configuration
//     const completeSensorConfig = {
//       name: sensorConfig.name,
//       protocolType: sensorConfig.protocolType,
//       enabled: sensorConfig.enabled !== undefined ? sensorConfig.enabled : true,
//       addr,
//       eomDelimiter: sensorConfig.eomDelimiter || '\\n',
//       mqttTopic,
//       mqttHeartbeatTopic,
//       bufferCapacity: sensorConfig.bufferCapacity || 8192,
//       publishInterval: sensorConfig.publishInterval || 30000,
//       bufferTimeMs: sensorConfig.bufferTimeMs || 5000,
//       bufferSize: sensorConfig.bufferSize || 10,
//       addrPollSec: sensorConfig.addrPollSec || 10,
//       heartbeatTimeSec: sensorConfig.heartbeatTimeSec || 300,
//     };

//     // Get current target state
//     const currentState = await DeviceTargetStateModel.get(uuid);
    
//     // Get current config or initialize empty
//     const config = currentState && currentState.config
//       ? (typeof currentState.config === 'string' 
//           ? JSON.parse(currentState.config) 
//           : currentState.config)
//       : {};

//     // Initialize sensors array if it doesn't exist
//     if (!config.sensors) {
//       config.sensors = [];
//     }

//     // Check if sensor with same name already exists
//     const existingIndex = config.sensors.findIndex((s: any) => s.name === completeSensorConfig.name);
//     if (existingIndex !== -1) {
//       return res.status(400).json({
//         error: 'Sensor already exists',
//         message: `A sensor with name "${completeSensorConfig.name}" already exists`
//       });
//     }

//     // Add new sensor to config
//     config.sensors.push(completeSensorConfig);

//     // Get current apps or initialize empty
//     const apps = currentState && currentState.apps
//       ? (typeof currentState.apps === 'string' 
//           ? JSON.parse(currentState.apps) 
//           : currentState.apps)
//       : {};

//     // Update target state with new sensor config
//     const targetState = await DeviceTargetStateModel.set(uuid, apps, config);

//     console.log(`📡 Added sensor "${completeSensorConfig.name}" to device ${uuid.substring(0, 8)}...`);
//     console.log(`   Socket/Pipe: ${completeSensorConfig.addr}`);
//     console.log(`   MQTT Topic: ${completeSensorConfig.mqttTopic}`);

//     // Publish event
//     await eventPublisher.publish(
//       'sensor_config.added',
//       'device',
//       uuid,
//       {
//         sensor: completeSensorConfig,
//         version: targetState.version
//       },
//       {
//         metadata: {
//           ip_address: req.ip,
//           user_agent: req.headers['user-agent'],
//           endpoint: '/devices/:uuid/sensor-config'
//         }
//       }
//     );

//     res.json({
//       status: 'ok',
//       message: 'Sensor configuration added',
//       sensor: completeSensorConfig,
//       version: targetState.version
//     });
//   } catch (error: any) {
//     console.error('Error adding sensor config:', error);
//     res.status(500).json({
//       error: 'Failed to add sensor configuration',
//       message: error.message
//     });
//   }
// });

/**
 * Update sensor configuration
 * PUT /api/v1/devices/:uuid/sensor-config/:sensorName
 */
// router.put('/devices/:uuid/sensor-config/:sensorName', async (req, res) => {
//   try {
//     const { uuid, sensorName } = req.params;
//     const updatedConfig = req.body;

//     // Get current target state
//     const currentState = await DeviceTargetStateModel.get(uuid);
    
//     if (!currentState || !currentState.config) {
//       return res.status(404).json({
//         error: 'Sensor not found',
//         message: `No sensor configuration found for "${sensorName}"`
//       });
//     }

//     const config = typeof currentState.config === 'string' 
//       ? JSON.parse(currentState.config) 
//       : currentState.config;

//     if (!config.sensors) {
//       return res.status(404).json({
//         error: 'Sensor not found',
//         message: `No sensor configuration found for "${sensorName}"`
//       });
//     }

//     // Find sensor by name
//     const sensorIndex = config.sensors.findIndex((s: any) => s.name === sensorName);
//     if (sensorIndex === -1) {
//       return res.status(404).json({
//         error: 'Sensor not found',
//         message: `Sensor "${sensorName}" not found`
//       });
//     }

//     // Update sensor config
//     config.sensors[sensorIndex] = { ...config.sensors[sensorIndex], ...updatedConfig };

//     // Get current apps
//     const apps = typeof currentState.apps === 'string' 
//       ? JSON.parse(currentState.apps) 
//       : currentState.apps || {};

//     // Update target state
//     const targetState = await DeviceTargetStateModel.set(uuid, apps, config);

//     console.log(`📡 Updated sensor "${sensorName}" on device ${uuid.substring(0, 8)}...`);

//     // Publish event
//     await eventPublisher.publish(
//       'sensor_config.updated',
//       'device',
//       uuid,
//       {
//         sensor_name: sensorName,
//         sensor: config.sensors[sensorIndex],
//         version: targetState.version
//       },
//       {
//         metadata: {
//           ip_address: req.ip,
//           user_agent: req.headers['user-agent'],
//           endpoint: '/devices/:uuid/sensor-config/:sensorName'
//         }
//       }
//     );

//     res.json({
//       status: 'ok',
//       message: 'Sensor configuration updated',
//       sensor: config.sensors[sensorIndex],
//       version: targetState.version
//     });
//   } catch (error: any) {
//     console.error('Error updating sensor config:', error);
//     res.status(500).json({
//       error: 'Failed to update sensor configuration',
//       message: error.message
//     });
//   }
// });

// /**
//  * Delete sensor configuration
//  * DELETE /api/v1/devices/:uuid/sensor-config/:sensorName
//  */
// router.delete('/devices/:uuid/sensor-config/:sensorName', async (req, res) => {
//   try {
//     const { uuid, sensorName } = req.params;

//     // Get current target state
//     const currentState = await DeviceTargetStateModel.get(uuid);
    
//     if (!currentState || !currentState.config) {
//       return res.status(404).json({
//         error: 'Sensor not found',
//         message: `No sensor configuration found for "${sensorName}"`
//       });
//     }

//     const config = typeof currentState.config === 'string' 
//       ? JSON.parse(currentState.config) 
//       : currentState.config;

//     if (!config.sensors) {
//       return res.status(404).json({
//         error: 'Sensor not found',
//         message: `No sensor configuration found for "${sensorName}"`
//       });
//     }

//     // Find sensor by name
//     const sensorIndex = config.sensors.findIndex((s: any) => s.name === sensorName);
//     if (sensorIndex === -1) {
//       return res.status(404).json({
//         error: 'Sensor not found',
//         message: `Sensor "${sensorName}" not found`
//       });
//     }

//     // Remove sensor from config
//     const removedSensor = config.sensors.splice(sensorIndex, 1)[0];

//     // Get current apps
//     const apps = typeof currentState.apps === 'string' 
//       ? JSON.parse(currentState.apps) 
//       : currentState.apps || {};

//     // Update target state
//     const targetState = await DeviceTargetStateModel.set(uuid, apps, config);

//     console.log(`🗑️  Removed sensor "${sensorName}" from device ${uuid.substring(0, 8)}...`);

//     // Publish event
//     await eventPublisher.publish(
//       'sensor_config.deleted',
//       'device',
//       uuid,
//       {
//         sensor_name: sensorName,
//         sensor: removedSensor,
//         version: targetState.version
//       },
//       {
//         metadata: {
//           ip_address: req.ip,
//           user_agent: req.headers['user-agent'],
//           endpoint: '/devices/:uuid/sensor-config/:sensorName'
//         }
//       }
//     );

//     res.json({
//       status: 'ok',
//       message: 'Sensor configuration deleted',
//       sensor: removedSensor,
//       version: targetState.version
//     });
//   } catch (error: any) {
//     console.error('Error deleting sensor config:', error);
//     res.status(500).json({
//       error: 'Failed to delete sensor configuration',
//       message: error.message
//     });
//   }
// });


// =============================================================================
// VIRTUAL DEVICE ROUTES
// Manage virtual protocol simulators deployed as sidecar containers
// =============================================================================

/**
 * Create virtual device (protocol simulator sidecar)
 * POST /api/v1/devices/:uuid/virtual-devices
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
 * 1. Creates record in device_sensors table with virtual=true metadata
 * 2. Auto-assigns port (502, 503, 504... for Modbus)
 * 3. If parent is K8s virtual agent, patches Deployment to add sidecar container
 * 4. If parent is physical agent, agent will reconcile sidecar on next state sync
 * 5. Agent connects to virtual device at localhost:port like a normal physical device
 */
router.post('/devices/:uuid/virtual-devices', jwtAuth, async (req, res) => {
  try {
    const { uuid } = req.params;
    const { name, protocol, profile, image, slaveCount } = req.body;

    // Validation
    if (!name || !protocol || !profile) {
      return res.status(400).json({
        error: 'Validation failed',
        message: 'name, protocol, and profile are required'
      });
    }

    if (!['modbus', 'opcua'].includes(protocol)) {
      return res.status(400).json({
        error: 'Validation failed',
        message: 'protocol must be either "modbus" or "opcua"'
      });
    }

    // Create virtual device
    const virtualDevice = await virtualDeviceManager.createVirtualDevice({
      deviceUuid: uuid,
      name,
      protocol,
      profile,
      image,
      slaveCount
    });

    logger.info('Virtual device created via API', {
      deviceUuid: uuid,
      virtualDeviceUuid: virtualDevice.uuid,
      protocol,
      profile,
      port: virtualDevice.connection.port
    });

    res.status(201).json({
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
      return res.status(404).json({
        error: 'Not found',
        message: error.message
      });
    }

    res.status(500).json({
      error: 'Failed to create virtual device',
      message: error.message
    });
  }
});

/**
 * List virtual devices for a device
 * GET /api/v1/devices/:uuid/virtual-devices
 * 
 * Returns all virtual device sidecars configured for the agent
 */
router.get('/devices/:uuid/virtual-devices', jwtAuth, async (req, res) => {
  try {
    const { uuid } = req.params;

    const virtualDevices = await virtualDeviceManager.getVirtualDevices(uuid);

    res.json({
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
    logger.error('Error listing virtual devices:', error);
    res.status(500).json({
      error: 'Failed to list virtual devices',
      message: error.message
    });
  }
});

/**
 * Delete virtual device
 * DELETE /api/v1/devices/:uuid/virtual-devices/:virtualDeviceUuid
 * 
 * Flow:
 * 1. Deletes record from device_sensors table
 * 2. If parent is K8s virtual agent, patches Deployment to remove sidecar
 * 3. If parent is physical agent, agent will remove sidecar on next state sync
 */
router.delete('/devices/:uuid/virtual-devices/:virtualDeviceUuid',jwtAuth, async (req, res) => {
  try {
    const { uuid, virtualDeviceUuid } = req.params;

    await virtualDeviceManager.deleteVirtualDevice(uuid, virtualDeviceUuid);

    logger.info('Virtual device deleted via API', {
      deviceUuid: uuid,
      virtualDeviceUuid
    });

    res.json({
      status: 'ok',
      message: 'Virtual device deleted'
    });
  } catch (error: any) {
    logger.error('Error deleting virtual device:', error);
    res.status(500).json({
      error: 'Failed to delete virtual device',
      message: error.message
    });
  }
});
