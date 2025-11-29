/**
 * Device Sensor Sync Service
 * 
 * Purpose: Keep device_sensors table in sync with device_target_state.config
 * Pattern: Dual-write - config is source of truth, table for querying
 * 
 * Responsibilities:
 * 1. Sync config → table when target state is updated
 * 2. Sync table → config when sensor is added/updated via API
 * 3. Detect and resolve conflicts
 * 4. Track sync status and version
 */

import { query } from '../db/connection';
import { EventPublisher } from './event-sourcing';
import logger from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

const eventPublisher = new EventPublisher();

export interface EndpointDeviceConfig {
  id?: string; // UUID - generated at creation, persists through lifecycle
  uuid?: string; // Stable identifier for cloud/edge sync (survives name changes)
  name: string;
  protocol: 'modbus' | 'can' | 'opcua' | 'mqtt' | 'snmp';
  enabled: boolean;
  pollInterval: number;
  connection: any;
  dataPoints: any[];
  metadata?: any;
}

export class DeviceSensorSyncService {
  /**
   * Sync sensor devices from config to database table
   * Called during deployment or reconciliation
   * 
   * Flow:
   * - During deployment (userId != 'agent-reconciliation'): Add sensors with deployment_status='pending'
   * - During reconciliation (userId === 'agent-reconciliation'): Update sensors with deployment_status='deployed'
   */
  async syncConfigToTable(
    deviceUuid: string,
    configDevices: EndpointDeviceConfig[],
    configVersion: number,
    userId?: string
  ): Promise<void> {
    const isReconciliation = userId === 'agent-reconciliation';
    logger.info(`Syncing ${configDevices.length} endpoints from config to table for device ${deviceUuid.substring(0, 8)}... (${isReconciliation ? 'RECONCILIATION' : 'DEPLOYMENT'})`);

    try {
      // Get existing sensors from table
      const existingResult = await query(
        'SELECT name, uuid FROM device_sensors WHERE device_uuid = $1',
        [deviceUuid]
      );
      const existingUuids = new Set(existingResult.rows.map((r: any) => r.uuid).filter(Boolean));
      const configUuids = new Set(configDevices.map(d => d.uuid).filter(Boolean));

      // 1. Insert or update sensors from config
      for (const endpoint of configDevices) {
        if (endpoint.uuid && existingUuids.has(endpoint.uuid)) {
          // Update existing sensor by UUID (stable identifier)
          // If reconciliation from agent, mark as deployed
          // Otherwise, mark as pending (just triggered deployment)
          const deploymentStatus = isReconciliation ? 'deployed' : 'pending';
          
          await query(
            `UPDATE device_sensors SET
              name = $1,
              protocol = $2,
              enabled = $3,
              poll_interval = $4,
              connection = $5,
              data_points = $6,
              metadata = $7,
              updated_by = $8,
              config_version = $9,
              synced_to_config = true,
              deployment_status = $10,
              config_id = $11
            WHERE device_uuid = $12 AND uuid = $13`,
            [
              endpoint.name,
              endpoint.protocol,
              endpoint.enabled,
              endpoint.pollInterval,
              JSON.stringify(endpoint.connection),
              JSON.stringify(endpoint.dataPoints),
              JSON.stringify(endpoint.metadata || {}),
              userId || 'system',
              configVersion,
              deploymentStatus,
              endpoint.id || null, // Populate config_id from config JSON
              deviceUuid,
              endpoint.uuid
            ]
          );
          logger.info(`Updated: ${endpoint.name} (${endpoint.protocol}) - ${deploymentStatus}`);
        } else {
          // Insert new sensor into table
          // If reconciliation from agent, mark as deployed (agent confirms it's running)
          // Otherwise, mark as pending (deployment just triggered, waiting for agent confirmation)
          const deploymentStatus = isReconciliation ? 'deployed' : 'pending';
          
          await query(
            `INSERT INTO device_sensors (
              device_uuid, uuid, name, protocol, enabled, poll_interval,
              connection, data_points, metadata, created_by, updated_by,
              config_version, synced_to_config, deployment_status, config_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14)`,
            [
              deviceUuid,
              endpoint.uuid,
              endpoint.name,
              endpoint.protocol,
              endpoint.enabled,
              endpoint.pollInterval,
              JSON.stringify(endpoint.connection),
              JSON.stringify(endpoint.dataPoints),
              JSON.stringify(endpoint.metadata || {}),
              userId || 'system',
              userId || 'system',
              configVersion,
              deploymentStatus,
              endpoint.id || null // Populate config_id from config JSON
            ]
          );
          logger.info(`Inserted: ${endpoint.name} (${endpoint.protocol}) - ${deploymentStatus}`);
        }
      }

      // 2. Delete endpoints removed from config (by UUID)
      for (const row of existingResult.rows) {
        if (row.uuid && !configUuids.has(row.uuid)) {
          await query(
            'DELETE FROM device_sensors WHERE device_uuid = $1 AND uuid = $2',
            [deviceUuid, row.uuid]
          );
          logger.info(`   Deleted: ${row.name} (removed from config)`);
        }
      }

      logger.info(`Sync complete: config → table (version ${configVersion}) - ${isReconciliation ? 'DEPLOYED' : 'PENDING'}`);
    } catch (error) {
      logger.error(' Error syncing config to table:', error);
      throw error;
    }
  }

  /**
   * Deploy config changes (increment version and sync to table)
   * Called when user clicks "Deploy" button
   * 
   * This triggers:
   * 1. Version increment (tells agent to pick up changes)
   * 2. Sync config → table with deployment_status='pending'
   * 3. Agent will report current state, triggering reconciliation to 'deployed'
   */
  async deployConfig(deviceUuid: string, userId?: string): Promise<any> {
    logger.info(`Deploying config changes for device ${deviceUuid.substring(0, 8)}...`);

    try {
      // 1. Get current target state
      const stateResult = await query(
        'SELECT apps, config, version FROM device_target_state WHERE device_uuid = $1',
        [deviceUuid]
      );

      if (stateResult.rows.length === 0) {
        throw new Error('Device not found');
      }

      const state = stateResult.rows[0];
      const config = typeof state.config === 'string' ? JSON.parse(state.config) : state.config;
      const endpoints: EndpointDeviceConfig[] = config.endpoints || [];

      // 2. Increment version and set needs_deployment flag
      const updateResult = await query(
        `UPDATE device_target_state SET
           version = version + 1,
           updated_at = NOW(),
           needs_deployment = true
         WHERE device_uuid = $1
         RETURNING version`,
        [deviceUuid]
      );

      const newVersion = updateResult.rows[0].version;

      // 3. Sync config → table with deployment_status='pending'
      await this.syncConfigToTable(deviceUuid, endpoints, newVersion, userId);

      // 4. Publish event
      await eventPublisher.publish(
        'device_config.deployed',
        'device',
        deviceUuid,
        {
          version: newVersion,
          endpoints_count: endpoints.length
        }
      );

      logger.info(`Deployed config (version: ${newVersion}) - sensors marked as 'pending'`);

      return {
        version: newVersion,
        config,
        message: 'Config deployed. Endpoints marked as pending. Waiting for agent confirmation.'
      };
    } catch (error) {
      logger.error('Error deploying config:', error);
      throw error;
    }
  }

  /**
   * Sync sensor devices from table to config
   * Called when sensor is added/updated via API
   */
  async syncTableToConfig(deviceUuid: string, userId?: string): Promise<any> {
    logger.info(`Syncing endpoints from table to config for device ${deviceUuid.substring(0, 8)}...`);

    try {
      // Get all sensors from table
      const result = await query(
        `SELECT id, uuid, name, protocol, enabled, poll_interval, connection, data_points, metadata
         FROM device_sensors
         WHERE device_uuid = $1
         ORDER BY created_at`,
        [deviceUuid]
      );

      // Convert to config format
      const configDevices = result.rows.map((row: any) => ({
        id: row.id.toString(), // Convert database id to string for consistency
        uuid: row.uuid, // Include UUID for stable identifier
        name: row.name,
        protocol: row.protocol,
        enabled: row.enabled,
        pollInterval: row.poll_interval,
        connection: typeof row.connection === 'string' ? JSON.parse(row.connection) : row.connection,
        dataPoints: typeof row.data_points === 'string' ? JSON.parse(row.data_points) : row.data_points,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
      }));

      // Get current target state
      const stateResult = await query(
        'SELECT apps, config, version FROM device_target_state WHERE device_uuid = $1',
        [deviceUuid]
      );

      let apps = {};
      let config: any = {};

      if (stateResult.rows.length > 0) {
        const state = stateResult.rows[0];
        apps = typeof state.apps === 'string' ? JSON.parse(state.apps) : state.apps;
        config = typeof state.config === 'string' ? JSON.parse(state.config) : state.config;
      }

      // Update config with endpoints from table
      config.endpoints = configDevices;

      // Save updated target state
      const updateResult = await query(
        `INSERT INTO device_target_state (device_uuid, apps, config, version, updated_at, needs_deployment)
         VALUES ($1, $2, $3, 1, NOW(), true)
         ON CONFLICT (device_uuid) DO UPDATE SET
           apps = $2,
           config = $3,
           version = device_target_state.version + 1,
           updated_at = NOW(),
           needs_deployment = true
         RETURNING version`,
        [deviceUuid, JSON.stringify(apps), JSON.stringify(config)]
      );

      const newVersion = updateResult.rows[0].version;

      // Update table records with new version
      await query(
        'UPDATE device_sensors SET config_version = $1, synced_to_config = true WHERE device_uuid = $2',
        [newVersion, deviceUuid]
      );

      logger.info(`Sync complete: table → config (version ${newVersion})`);

      return { version: newVersion, config };
    } catch (error) {
      logger.error('Error syncing table to config:', error);
      throw error;
    }
  }

  /**
   * Sync agent's current state to table (RECONCILIATION)
   * Called when agent reports its actual running configuration
   * This closes the Event Sourcing loop: config → agent → current state → table
   */
  async syncCurrentStateToTable(deviceUuid: string, currentState: any): Promise<void> {
    logger.info(`Reconciling current state from agent for device ${deviceUuid.substring(0, 8)}...`);

    try {
      // Extract running sensors from agent's current state
      const config = typeof currentState.config === 'string' 
        ? JSON.parse(currentState.config) 
        : currentState.config;
      
    
      const agentEndpoints = config?.endpoints;
      const currentVersion = currentState.version || 0;

      logger.info(`Agent reports ${agentEndpoints.length} running endpoints (version ${currentVersion})`);

      // Convert agent format (ProtocolAdapterDevice) to API format (SensorDeviceConfig)
      // Agent sends: { id, name, protocol, connectionString (JSON string), pollInterval, enabled (number 0/1), metadata }
      // API expects: { id, uuid, name, protocol, connection (object), dataPoints, pollInterval, enabled (boolean), metadata }
      const runningEndpoints: EndpointDeviceConfig[] = agentEndpoints.map((endpoint: any) => ({
        id: endpoint.id,
        uuid: endpoint.id, // Agent uses UUID as id
        name: endpoint.name,
        protocol: endpoint.protocol,
        enabled: Boolean(endpoint.enabled), // Convert 0/1 to boolean
        pollInterval: endpoint.pollInterval,
        connection: typeof endpoint.connectionString === 'string' 
          ? JSON.parse(endpoint.connectionString) 
          : endpoint.connection || {},
        dataPoints: endpoint.dataPoints || [],
        metadata: endpoint.metadata || {}
      }));

      logger.info(`Converted ${runningEndpoints.length} endpoints from agent format to API format`);

      // Sync table to match agent's reality (not desired state!)
      await this.syncConfigToTable(deviceUuid, runningEndpoints, currentVersion, 'agent-reconciliation');

      logger.info(`Reconciliation complete: agent reality → table (version ${currentVersion})`);
    } catch (error) {
      logger.error('Error reconciling current state to table:', error);
      throw error;
    }
  }

  /**
   * Get sensor devices from TABLE (deployed state for UI)
   * Reads from device_sensors table which represents agent's actual running state
   * Table is kept in sync via reconciliation when agent reports current state
   */
  async getEndpoints(deviceUuid: string, protocol?: string): Promise<any[]> {
    try {
      // Read from TABLE (deployed/running state)
      let sql = `
        SELECT id, device_uuid, name, protocol, enabled, poll_interval,
               connection, data_points, metadata, config_version, synced_to_config,
               deployment_status, last_deployed_at, deployment_error, deployment_attempts,
               config_id, created_at, updated_at, created_by, updated_by
        FROM device_sensors 
        WHERE device_uuid = $1
      `;
      const params: any[] = [deviceUuid];

      // Filter by protocol if specified
      if (protocol) {
        sql += ' AND protocol = $2';
        params.push(protocol);
      }

      sql += ' ORDER BY created_at';

      const result = await query(sql, params);

      // Return sensors in API format
      return result.rows.map((row: any) => ({
        id: row.id,
        uuid: row.uuid, // Stable identifier for cloud/edge sync
        configId: row.config_id, // UUID from config JSON
        name: row.name,
        protocol: row.protocol,
        enabled: row.enabled,
        pollInterval: row.poll_interval,
        connection: typeof row.connection === 'string' ? JSON.parse(row.connection) : row.connection,
        dataPoints: typeof row.data_points === 'string' ? JSON.parse(row.data_points) : row.data_points,
        metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
        configVersion: row.config_version,
        syncedToConfig: row.synced_to_config,
        deploymentStatus: row.deployment_status,
        lastDeployedAt: row.last_deployed_at,
        deploymentError: row.deployment_error,
        deploymentAttempts: row.deployment_attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        createdBy: row.created_by,
        updatedBy: row.updated_by
      }));
    } catch (error) {
      logger.error('Error getting sensors from table:', error);
      throw error;
    }
  }

  /**
   * Update sensor device (CORRECT PATTERN: Update table first, then sync to config)
   * NOTE: endpointIdentifier can be either UUID (preferred) or name (backward compatibility)
   * 
   * This method handles both:
   * 1. Manual configuration (exists in config) - update config → table
   * 2. Discovered endpoints (only in table) - update table → config
   */
  async updateEndpoint(
    deviceUuid: string,
    endpointIdentifier: string,
    updates: Partial<EndpointDeviceConfig>,
    userId?: string
  ): Promise<any> {
    logger.info(`Updating endpoint "${endpointIdentifier}" for device ${deviceUuid.substring(0, 8)}...`);

    try {
      // 1. Check if endpoint exists in device_sensors table (source of truth)
      const tableResult = await query(
        `SELECT id, uuid, name, protocol, enabled, poll_interval, connection, data_points, metadata
         FROM device_sensors 
         WHERE device_uuid = $1 AND (uuid::text = $2 OR name = $2)`,
        [deviceUuid, endpointIdentifier]
      );

      if (tableResult.rows.length === 0) {
        throw new Error(`Endpoint "${endpointIdentifier}" not found`);
      }

      const existingEndpoint = tableResult.rows[0];

      // 2. Apply updates to table record
      const updatedEndpoint = {
        name: updates.name ?? existingEndpoint.name,
        protocol: updates.protocol ?? existingEndpoint.protocol,
        enabled: updates.enabled ?? existingEndpoint.enabled,
        poll_interval: updates.pollInterval ?? existingEndpoint.poll_interval,
        connection: updates.connection ? JSON.stringify(updates.connection) : existingEndpoint.connection,
        data_points: updates.dataPoints ? JSON.stringify(updates.dataPoints) : existingEndpoint.data_points,
        metadata: updates.metadata ? JSON.stringify(updates.metadata) : existingEndpoint.metadata
      };

      // 3. Update table directly (source of truth)
      await query(
        `UPDATE device_sensors SET
           name = $1,
           protocol = $2,
           enabled = $3,
           poll_interval = $4,
           connection = $5,
           data_points = $6,
           metadata = $7,
           updated_by = $8,
           updated_at = NOW(),
           synced_to_config = false
         WHERE device_uuid = $9 AND uuid = $10`,
        [
          updatedEndpoint.name,
          updatedEndpoint.protocol,
          updatedEndpoint.enabled,
          updatedEndpoint.poll_interval,
          updatedEndpoint.connection,
          updatedEndpoint.data_points,
          updatedEndpoint.metadata,
          userId || 'system',
          deviceUuid,
          existingEndpoint.uuid
        ]
      );


      // 4. Sync table → config (this will increment version and trigger deployment)
      const syncResult = await this.syncTableToConfig(deviceUuid, userId);

      // 5. Publish event
      await eventPublisher.publish(
        'device_sensor.updated',
        'device',
        deviceUuid,
        {
          endpoint_name: updatedEndpoint.name,
          endpoint_uuid: existingEndpoint.uuid,
          updates,
          version: syncResult.version
        }
      );

      logger.info(`Updated endpoint "${updatedEndpoint.name}" and synced to config (version: ${syncResult.version})`);

      // 6. Return updated endpoint
      return {
        sensor: {
          id: existingEndpoint.id,
          uuid: existingEndpoint.uuid,
          name: updatedEndpoint.name,
          protocol: updatedEndpoint.protocol,
          enabled: updatedEndpoint.enabled,
          pollInterval: updatedEndpoint.poll_interval,
          connection: typeof updatedEndpoint.connection === 'string' 
            ? JSON.parse(updatedEndpoint.connection) 
            : updatedEndpoint.connection,
          dataPoints: typeof updatedEndpoint.data_points === 'string'
            ? JSON.parse(updatedEndpoint.data_points)
            : updatedEndpoint.data_points,
          metadata: typeof updatedEndpoint.metadata === 'string'
            ? JSON.parse(updatedEndpoint.metadata)
            : updatedEndpoint.metadata
        },
        version: syncResult.version
      };
    } catch (error) {
      logger.error('Error updating endpoint:', error);
      throw error;
    }
  }

  /**
   * Delete sensor device (CORRECT PATTERN: Delete from config first)
   * NOTE: sensorIdentifier can be either UUID (preferred) or name (backward compatibility)
   */
  async deleteEndpoint(
    deviceUuid: string,
    sensorIdentifier: string,
    userId?: string
  ): Promise<any> {
    logger.info(`Deleting endpoint "${sensorIdentifier}" for device ${deviceUuid.substring(0, 8)}...`);

    try {
      // 1. Get current target state
      const stateResult = await query(
        'SELECT apps, config, version FROM device_target_state WHERE device_uuid = $1',
        [deviceUuid]
      );

      if (stateResult.rows.length === 0) {
        throw new Error('Device not found');
      }

      const state = stateResult.rows[0];
      const apps = typeof state.apps === 'string' ? JSON.parse(state.apps) : state.apps;
      const config = typeof state.config === 'string' ? JSON.parse(state.config) : state.config;
      let existingDevices: EndpointDeviceConfig[] = config.endpoints || [];

      // 2. Find sensor to delete (for event logging)
      const sensorToDelete = existingDevices.find(d => 
        d.uuid === sensorIdentifier || d.name === sensorIdentifier
      );
      if (!sensorToDelete) {
        throw new Error(`Sensor "${sensorIdentifier}" not found`);
      }

      // 3. Remove sensor from config (SOURCE OF TRUTH) by UUID if available, otherwise by name
      existingDevices = existingDevices.filter(d => 
        d.uuid !== sensorIdentifier && d.name !== sensorIdentifier
      );
      config.endpoints = existingDevices;

      // 4. Save updated target state
      const updateResult = await query(
        `UPDATE device_target_state SET
           apps = $1,
           config = $2,
           version = version + 1,
           updated_at = NOW(),
           needs_deployment = true
         WHERE device_uuid = $3
         RETURNING version`,
        [JSON.stringify(apps), JSON.stringify(config), deviceUuid]
      );

      const newVersion = updateResult.rows[0].version;

      // 5. Sync config → table (will delete from table)
      await this.syncConfigToTable(deviceUuid, existingDevices, newVersion, userId);

      // 6. Publish event
      await eventPublisher.publish(
        'device_sensor.deleted',
        'device',
        deviceUuid,
        {
          sensor_name: sensorToDelete.name,
          sensor_uuid: sensorToDelete.uuid,
          version: newVersion
        }
      );

      logger.info(`Deleted sensor "${sensorToDelete.name}" from config (version: ${newVersion})`);

      return {
        version: newVersion
      };
    } catch (error) {
      logger.error('Error deleting sensor:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const deviceSensorSync = new DeviceSensorSyncService();

// Export standalone function for backward compatibility
export const syncTableToConfig = (deviceUuid: string, userId?: string) => 
  deviceSensorSync.syncTableToConfig(deviceUuid, userId);
