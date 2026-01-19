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
  alias?: string; // User-friendly name override
  tags?: string[]; // User categorization tags
  metadata?: any;
}

export class DeviceSensorSyncService {
  /**
   * Mark endpoints as pending deployment
   * Called ONLY when user clicks Sync button (POST /deploy)
   * Updates ONLY deployment_status='pending', does NOT touch device config (enabled, connection, etc.)
   */
  async markEndpointsAsPending(
    deviceUuid: string,
    configDevices: EndpointDeviceConfig[],
    configVersion: number,
    userId?: string
  ): Promise<void> {
    logger.info(`Marking ${configDevices.length} endpoints as pending deployment for device ${deviceUuid.substring(0, 8)}...`);

    try {
      const configUuids = configDevices.map(d => d.uuid).filter(Boolean);
      
      if (configUuids.length === 0) {
        logger.warn('No valid UUIDs in config, skipping pending update');
        return;
      }

      // Update ONLY deployment metadata (status, version, updated_by)
      // Do NOT touch device config (enabled, connection, dataPoints, etc.)
      const result = await query(
        `UPDATE device_sensors 
         SET deployment_status = 'pending',
             config_version = $1,
             updated_by = $2,
             updated_at = NOW()
         WHERE device_uuid = $3 AND uuid = ANY($4)`,
        [configVersion, userId || 'system', deviceUuid, configUuids]
      );

      logger.info(`Marked ${result.rowCount} endpoints as pending deployment`);
    } catch (error) {
      logger.error('Failed to mark endpoints as pending:', error);
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
      const allConfigEndpoints: EndpointDeviceConfig[] = config.endpoints || [];
      
      // FILTER: Only mark endpoints that have actual overrides (non-default values)
      // This prevents marking all endpoints as pending when only one changed
      const tableEndpoints = await query(
        'SELECT uuid, enabled, poll_interval FROM device_sensors WHERE device_uuid = $1',
        [deviceUuid]
      );
      const tableByUuid = new Map(tableEndpoints.rows.map((e: any) => [e.uuid, e]));
      
      const endpointsWithChanges = allConfigEndpoints.filter(configEp => {
        if (!configEp.uuid) return false;
        const tableEp = tableByUuid.get(configEp.uuid);
        if (!tableEp) {
          logger.info(`[DEPLOY FILTER] New endpoint (not in table): ${configEp.uuid}`);
          return true; // New endpoint, include it
        }
        
        // Check if config has actual overrides different from table
        // Note: DB stores enabled as 0/1, config uses true/false
        const hasEnabledOverride = configEp.enabled !== undefined && Boolean(configEp.enabled) !== Boolean(tableEp.enabled);
        const hasPollIntervalOverride = configEp.pollInterval !== undefined && configEp.pollInterval !== tableEp.poll_interval;
        
        return hasEnabledOverride || hasPollIntervalOverride;
      });
      
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

      // Mark endpoints as pending (ONLY endpoints with actual changes)
      await this.markEndpointsAsPending(deviceUuid, endpointsWithChanges, newVersion, userId);

      // 4. Publish event
      await eventPublisher.publish(
        'device_config.deployed',
        'device',
        deviceUuid,
        {
          version: newVersion,
          endpoints_count: endpointsWithChanges.length
        }
      );

      logger.info(`Deployed config (version: ${newVersion}) - ${endpointsWithChanges.length} endpoints marked as 'pending'`);

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
   * Sync agent's current state to table (RECONCILIATION)
   * Called when agent reports its actual running configuration (PATCH /current-state)
   * 
   * Flow:
   * 1. Agent applies config changes to protocol adapters
   * 2. Agent reports actual adapter state (enabled, connection, dataPoints)
   * 3. API updates device_sensors table with ACTUAL state
   * 4. Sets deployment_status='deployed' (agent confirmed changes)
   * 
   * This is the ONLY place that updates device config fields (enabled, connection, dataPoints)
   * in the device_sensors table. User edits go to config, deployment sets status=pending,
   * but only agent reports update the actual device state.
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

      if (agentEndpoints.length === 0) {
        logger.info(`Agent reports 0 endpoints - skipping reconciliation (device may not have discovered anything yet)`);
        return;
      }

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

      // Get existing endpoints from table
      const existingResult = await query(
        'SELECT uuid FROM device_sensors WHERE device_uuid = $1',
        [deviceUuid]
      );
      const existingUuids = new Set(existingResult.rows.map((r: any) => r.uuid).filter(Boolean));

      // Insert new endpoints discovered by agent
      for (const endpoint of runningEndpoints) {
        if (!endpoint.uuid || existingUuids.has(endpoint.uuid)) {
          // Already exists - skip (we'll update in next loop)
          continue;
        }

        logger.info(`Inserting new discovered endpoint: ${endpoint.name} (${endpoint.protocol})`);
        
        await query(
          `INSERT INTO device_sensors (
            device_uuid, uuid, name, protocol, enabled, poll_interval,
            connection, data_points, metadata, config_version,
            deployment_status, synced_to_config, created_by, updated_by
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            deviceUuid,
            endpoint.uuid,
            endpoint.name,
            endpoint.protocol,
            endpoint.enabled,
            endpoint.pollInterval,
            JSON.stringify(endpoint.connection),
            JSON.stringify(endpoint.dataPoints),
            JSON.stringify(endpoint.metadata),
            currentVersion,
            'deployed', // Agent is reporting actual state
            true,
            'agent-discovery',
            'agent-discovery'
          ]
        );
        
        existingUuids.add(endpoint.uuid);
      }

      // Update existing endpoints with agent's current state
      for (const endpoint of runningEndpoints) {
        if (!endpoint.uuid || !existingUuids.has(endpoint.uuid)) {
          continue; // Was just inserted above
        }

        await query(
          `UPDATE device_sensors SET
            enabled = $1,
            poll_interval = $2,
            connection = $3,
            data_points = $4,
            metadata = $5,
            config_version = $6,
            deployment_status = $7,
            synced_to_config = $8,
            updated_by = $9
          WHERE device_uuid = $10 AND uuid = $11`,
          [
            endpoint.enabled,
            endpoint.pollInterval,
            JSON.stringify(endpoint.connection),
            JSON.stringify(endpoint.dataPoints),
            JSON.stringify(endpoint.metadata),
            currentVersion,
            'deployed',
            true,
            'agent-reconciliation',
            deviceUuid,
            endpoint.uuid
          ]
        );
      }

      logger.info(`Reconciliation complete: agent reality → table (version ${currentVersion}), inserted ${runningEndpoints.length - existingResult.rows.length} new endpoints`);
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
      
      logger.info(`[getEndpoints] Device ${deviceUuid.substring(0, 8)}: Found ${targetSensors.length} devices in target state`);
      logger.info(`[getEndpoints] Target state config.endpoints:`, targetSensors.map((s: any) => ({ uuid: s.uuid, name: s.name, enabled: s.enabled })));
      
      // Match by UUID (stable identifier, survives name changes)
      const targetSensorsByUuid = new Map(
        targetSensors.map((s: any) => [s.uuid, s])
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
        // Get desired 'enabled' state from target config, match by UUID
        const targetSensor: any = targetSensorsByUuid.get(row.uuid);
        const enabledFromTarget = targetSensor?.enabled !== undefined 
          ? targetSensor.enabled 
          : row.enabled;
        
        logger.debug(`[getEndpoints] Device "${row.name}" (${row.uuid}): target=${targetSensor?.enabled}, table=${row.enabled}, final=${enabledFromTarget}`);
        
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
      logger.error('Error getting devices from table:', error);
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
          logger.warn(`Endpoint "${endpointName}" not found in device_sensors table`);
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
