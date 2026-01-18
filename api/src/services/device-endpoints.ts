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
import { DeviceTargetStateModel } from '../db/models';

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
      // Get existing sensors from table (fetch full records to compare changes AND health status)
      const existingResult = await query(
        'SELECT name, uuid, enabled, poll_interval, connection, data_points, metadata, deployment_status, health_connected FROM device_sensors WHERE device_uuid = $1',
        [deviceUuid]
      );
      const existingByUuid = new Map(existingResult.rows.map((r: any) => [r.uuid, r]));
      const existingUuids = new Set(existingResult.rows.map((r: any) => r.uuid).filter(Boolean));
      const configUuids = new Set(configDevices.map(d => d.uuid).filter(Boolean));

      // 1. Insert or update sensors from config
      for (const endpoint of configDevices) {
        if (endpoint.uuid && existingUuids.has(endpoint.uuid)) {
          // Compare with existing record to detect changes
          const existing = existingByUuid.get(endpoint.uuid);
          const hasChanged = !existing || 
            existing.enabled !== endpoint.enabled ||
            existing.poll_interval !== endpoint.pollInterval ||
            JSON.stringify(existing.connection) !== JSON.stringify(endpoint.connection) ||
            JSON.stringify(existing.data_points) !== JSON.stringify(endpoint.dataPoints);
          
          // Detect out-of-sync: enabled state doesn't match agent's actual state
          // - If we disabled but agent still has it connected → needs deployment
          // - If we enabled but agent has it disconnected → needs deployment
          const isOutOfSync = existing && existing.health_connected !== null && 
            existing.enabled !== existing.health_connected;
          
          // Update existing sensor by UUID (stable identifier)
          // If reconciliation from agent, mark as deployed
          // If deployment and (changed OR out of sync), mark as pending
          // If deployment but unchanged and in sync, keep existing status (don't reset to pending)
          const deploymentStatus = isReconciliation 
            ? 'deployed' 
            : (hasChanged || isOutOfSync ? 'pending' : existing?.deployment_status || 'deployed');
          
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
              endpoint.uuid || null, // Use UUID (not numeric id) for config_id
              deviceUuid,
              endpoint.uuid
            ]
          );
          logger.info(`Updated: ${endpoint.name} (${endpoint.protocol}) - ${deploymentStatus}`);
        } else {
          // Insert new sensor into table (or update if name collision exists)
          // If reconciliation from agent, mark as deployed (agent confirms it's running)
          // Otherwise, mark as pending (deployment just triggered, waiting for agent confirmation)
          const deploymentStatus = isReconciliation ? 'deployed' : 'pending';
          
          await query(
            `INSERT INTO device_sensors (
              device_uuid, uuid, name, protocol, enabled, poll_interval,
              connection, data_points, metadata, created_by, updated_by,
              config_version, synced_to_config, deployment_status, config_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true, $13, $14)
            ON CONFLICT (device_uuid, name) DO UPDATE SET
              uuid = EXCLUDED.uuid,
              protocol = EXCLUDED.protocol,
              enabled = EXCLUDED.enabled,
              poll_interval = EXCLUDED.poll_interval,
              connection = EXCLUDED.connection,
              data_points = EXCLUDED.data_points,
              metadata = EXCLUDED.metadata,
              updated_by = EXCLUDED.updated_by,
              config_version = EXCLUDED.config_version,
              synced_to_config = EXCLUDED.synced_to_config,
              deployment_status = EXCLUDED.deployment_status,
              config_id = EXCLUDED.config_id`,
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
              endpoint.uuid || null // Use UUID (not numeric id) for config_id
            ]
          );
          logger.info(`Upserted: ${endpoint.name} (${endpoint.protocol}) - ${deploymentStatus}`);
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
      const configDevices = result.rows.map((row: any) => {
        // Ensure endpoint has a valid UUID (generate if missing)
        const endpointUuid = row.uuid || uuidv4();
        
        // If UUID was just generated, update the table
        if (!row.uuid) {
          query(
            'UPDATE device_sensors SET uuid = $1 WHERE id = $2',
            [endpointUuid, row.id]
          ).catch(err => logger.error('Failed to update sensor UUID:', err));
        }
        
        return {
          id: row.id.toString(), // Convert database id to string for consistency
          uuid: endpointUuid, // Include UUID for stable identifier (always valid UUID)
          name: row.name,
          protocol: row.protocol,
          enabled: row.enabled,
          pollInterval: row.poll_interval,
          connection: typeof row.connection === 'string' ? JSON.parse(row.connection) : row.connection,
          dataPoints: typeof row.data_points === 'string' ? JSON.parse(row.data_points) : row.data_points,
          metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        };
      });

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

      // 🔄 SYNC: Propagate enabled flags to all protocol connections
      // This ensures agent reads the correct enabled state from target state
      if (!config.protocols) config.protocols = {};

      // Build map of enabled status by endpoint name
      const enabledByName = new Map<string, boolean>();
      for (const endpoint of configDevices) {
        enabledByName.set(endpoint.name, endpoint.enabled);
      }

      // Sync to Modbus connections
      if (config.protocols.modbus?.connections) {
        for (const connection of config.protocols.modbus.connections) {
          if (connection.name && enabledByName.has(connection.name)) {
            connection.enabled = enabledByName.get(connection.name);
            logger.info(`Synced enabled=${connection.enabled} to modbus connection "${connection.name}"`);
          }
        }
      }

      // Sync to OPC UA discovery URLs (match by URL)
      if (config.protocols.opcua?.discoveryUrls) {
        for (const endpoint of configDevices.filter(e => e.protocol === 'opcua')) {
          const urlMatch = config.protocols.opcua.discoveryUrls.find((url: string) => 
            endpoint.connection?.endpointUrl === url || endpoint.name === url
          );
          if (urlMatch) {
            if (!config.protocols.opcua.servers) config.protocols.opcua.servers = [];
            const existing = config.protocols.opcua.servers.find((s: any) => s.url === urlMatch);
            if (existing) {
              existing.enabled = endpoint.enabled;
            } else {
              config.protocols.opcua.servers.push({ url: urlMatch, enabled: endpoint.enabled });
            }
            logger.info(`Synced enabled=${endpoint.enabled} to opcua server "${urlMatch}"`);
          }
        }
      }

      // Sync to SNMP IP ranges (match by IP)
      if (config.protocols.snmp?.ipRanges) {
        for (const endpoint of configDevices.filter(e => e.protocol === 'snmp')) {
          const ipMatch = config.protocols.snmp.ipRanges.find((ip: string) => 
            endpoint.connection?.host === ip || endpoint.name === ip
          );
          if (ipMatch) {
            if (!config.protocols.snmp.hosts) config.protocols.snmp.hosts = [];
            const existing = config.protocols.snmp.hosts.find((h: any) => h.ip === ipMatch);
            if (existing) {
              existing.enabled = endpoint.enabled;
            } else {
              config.protocols.snmp.hosts.push({ ip: ipMatch, enabled: endpoint.enabled });
            }
            logger.info(`Synced enabled=${endpoint.enabled} to snmp host "${ipMatch}"`);
          }
        }
      }

      // Sync to MQTT discovery roots (match by topic)
      if (config.protocols.mqtt?.discoveryRoots) {
        for (const endpoint of configDevices.filter(e => e.protocol === 'mqtt')) {
          const topicMatch = config.protocols.mqtt.discoveryRoots.find((topic: string) => 
            endpoint.connection?.topic === topic || endpoint.name === topic
          );
          if (topicMatch) {
            if (!config.protocols.mqtt.topics) config.protocols.mqtt.topics = [];
            const existing = config.protocols.mqtt.topics.find((t: any) => t.name === topicMatch);
            if (existing) {
              existing.enabled = endpoint.enabled;
            } else {
              config.protocols.mqtt.topics.push({ name: topicMatch, enabled: endpoint.enabled });
            }
            logger.info(`Synced enabled=${endpoint.enabled} to mqtt topic "${topicMatch}"`);
          }
        }
      }

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

      if (!agentEndpoints || !Array.isArray(agentEndpoints)) {
        logger.warn(`No endpoints array found in config for device ${deviceUuid.substring(0, 8)}`);
        return;
      }

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
   * 
   * IMPORTANT: For 'enabled' field, we read from device_target_state.config.sensors
   * to show user's DESIRED state, not actual state (which is in health_connected)
   */
  async getEndpoints(deviceUuid: string, protocol?: string): Promise<any[]> {
    try {
      // Get target state to read desired 'enabled' values
      const targetState = await DeviceTargetStateModel.get(deviceUuid);
      const targetSensors: any[] = (targetState?.config as any)?.endpoints || [];
      
      logger.info(`[getEndpoints] Device ${deviceUuid.substring(0, 8)}: Found ${targetSensors.length} sensors in target state`);
      logger.info(`[getEndpoints] Target state config.endpoints:`, targetSensors.map((s: any) => ({ name: s.name, enabled: s.enabled })));
      
      const targetSensorsByName = new Map(
        targetSensors.map((s: any) => [s.name, s])
      );
      
      // Read from TABLE (deployed/running state)
      let sql = `
        SELECT id, uuid, device_uuid, name, protocol, enabled, poll_interval,
               connection, data_points, metadata, config_version, synced_to_config,
               deployment_status, last_deployed_at, deployment_error, deployment_attempts,
               config_id, created_at, updated_at, created_by, updated_by,
               health_status, health_connected, health_last_poll, health_error_count,
               health_last_error, health_updated_at
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
      return result.rows.map((row: any) => {
        // Get desired 'enabled' state from target, fallback to table value
        const targetSensor: any = targetSensorsByName.get(row.name);
        const enabledFromTarget = targetSensor?.enabled !== undefined 
          ? targetSensor.enabled 
          : row.enabled;
        
        logger.debug(`[getEndpoints] Sensor "${row.name}": target=${targetSensor?.enabled}, table=${row.enabled}, final=${enabledFromTarget}`);
        
        return {
          id: row.id,
          uuid: row.uuid, // Stable identifier for cloud/edge sync
          configId: row.config_id, // UUID from config JSON
          name: row.name,
          protocol: row.protocol,
          enabled: enabledFromTarget, // Read from target state (user's desired state)
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
          updatedBy: row.updated_by,
          // Health data from agent reports (actual state)
          health: row.health_status ? {
            status: row.health_status,
            connected: row.health_connected, // This is actual state from agent
            lastPoll: row.health_last_poll,
            errorCount: row.health_error_count,
            lastError: row.health_last_error,
            updatedAt: row.health_updated_at
          } : null
        };
      });
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
      // Always stringify JSON columns (they might be objects from pg driver)
      const updatedEndpoint = {
        name: updates.name ?? existingEndpoint.name,
        protocol: updates.protocol ?? existingEndpoint.protocol,
        enabled: updates.enabled ?? existingEndpoint.enabled,
        poll_interval: updates.pollInterval ?? existingEndpoint.poll_interval,
        connection: updates.connection 
          ? JSON.stringify(updates.connection) 
          : (typeof existingEndpoint.connection === 'string' 
              ? existingEndpoint.connection 
              : JSON.stringify(existingEndpoint.connection)),
        data_points: updates.dataPoints 
          ? JSON.stringify(updates.dataPoints) 
          : (typeof existingEndpoint.data_points === 'string' 
              ? existingEndpoint.data_points 
              : JSON.stringify(existingEndpoint.data_points)),
        metadata: updates.metadata 
          ? JSON.stringify(updates.metadata) 
          : (typeof existingEndpoint.metadata === 'string' 
              ? existingEndpoint.metadata 
              : JSON.stringify(existingEndpoint.metadata))
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

  /**
   * Update endpoint health from agent state reports
   * Called when agent reports endpoint health status
   */
  async updateEndpointHealth(
    deviceUuid: string,
    endpointsHealth: Record<string, any>
  ): Promise<void> {
    if (!endpointsHealth || Object.keys(endpointsHealth).length === 0) {
      return;
    }

    logger.info(`Updating health for ${Object.keys(endpointsHealth).length} endpoints (device ${deviceUuid.substring(0, 8)}...)`);

    try {
      // Process each endpoint's health data
      for (const [endpointName, health] of Object.entries(endpointsHealth)) {
        const { status, connected, lastPoll, errorCount, lastError } = health;

        // Update health columns in device_sensors table (match by name)
        // Note: Store actual boolean state even for disabled sensors (needed for out-of-sync detection)
        const result = await query(
          `UPDATE device_sensors SET
             health_status = $1,
             health_connected = $2,
             health_last_poll = $3,
             health_error_count = $4,
             health_last_error = $5,
             health_updated_at = NOW()
           WHERE device_uuid = $6 AND name = $7`,
          [
            status,
            connected, // Always store boolean value (true/false), not null
            lastPoll ? new Date(lastPoll) : null,
            errorCount || 0,
            lastError || null,
            deviceUuid,
            endpointName
          ]
        );

        if (result.rowCount === 0) {
          logger.warn(`Endpoint "${endpointName}" not found in device_sensors table (device ${deviceUuid.substring(0, 8)}...)`);
        }
      }

      logger.info(`Health updated for device ${deviceUuid.substring(0, 8)}...`);
    } catch (error) {
      logger.error('Error updating endpoint health:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const deviceSensorSync = new DeviceSensorSyncService();

// Export standalone function for backward compatibility
export const syncTableToConfig = (deviceUuid: string, userId?: string) => 
  deviceSensorSync.syncTableToConfig(deviceUuid, userId);
