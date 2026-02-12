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
import type { ModbusDataPoint, OPCUADataPoint, AnomalyDetectionDataPointConfig, AnomalyMetric } from '../types/target-state';

const eventPublisher = new EventPublisher();

export interface EndpointDeviceConfig {
  id?: string; // UUID - generated at creation, persists through lifecycle
  uuid?: string; // Stable identifier for cloud/edge sync (survives name changes)
  name: string;
  protocol: 'modbus' | 'can' | 'opcua' | 'mqtt' | 'snmp';
  enabled: boolean;
  pollInterval: number;
  connection: any;
  dataPoints: (ModbusDataPoint | OPCUADataPoint | any)[];  // Typed for Modbus/OPC-UA, any for other protocols
  metadata?: any;
}

export class DeviceSensorSyncService {
  private lastRefreshTime: number = 0;
  private readonly REFRESH_THROTTLE_MS = 60000; // Max once per minute

  /**
   * Refresh materialized views (throttled)
   * Called after device sensors are synced
   */
  private async refreshMetricCatalog(): Promise<void> {
    const now = Date.now();
    
    // Throttle: only refresh once per minute
    if (now - this.lastRefreshTime < this.REFRESH_THROTTLE_MS) {
      return;
    }

    try {
      await query('SELECT refresh_all_catalog_views()');
      this.lastRefreshTime = now;
      logger.debug('Refreshed metric catalog views');
    } catch (error) {
      logger.error('Failed to refresh metric catalog views:', error);
    }
  }

  /**
   * Mark endpoints as pending deployment
   * Called when user clicks Deploy button (POST /deploy)
   * Transitions 'draft' → 'pending', updates already 'pending' devices
   * Doesn't touch 'deployed' devices (those match actual agent state)
   */
  async markEndpointsAsPending(
    deviceUuid: string,
    endpointOverrides: EndpointDeviceConfig[],
    configVersion: number,
    userId?: string
  ): Promise<void> {
    try {
      const uuids = endpointOverrides.map(e => e.uuid).filter(Boolean);
      
      logger.info(`Marking endpoints as pending for device ${deviceUuid.substring(0, 8)}`, {
        endpointsCount: endpointOverrides.length,
        uuidsFound: uuids.length,
        uuids: uuids,
        configVersion
      });
      
      if (uuids.length === 0) {
        logger.warn('No UUIDs found in endpoint overrides - cannot mark as pending');
        return;
      }

      // Set to 'pending' for draft devices, update config_version for already-pending
      // Don't touch 'deployed' (those represent actual agent state)
      const result = await query(
        `UPDATE device_sensors 
         SET deployment_status = CASE 
               WHEN deployment_status = 'draft' THEN 'pending'
               ELSE deployment_status
             END,
             config_version = $1,
             updated_by = $2,
             updated_at = NOW()
         WHERE device_uuid = $3 
           AND uuid = ANY($4) 
           AND deployment_status NOT IN ('deployed')`,
        [configVersion, userId || 'system', deviceUuid, uuids]
      );

      if (result.rowCount === 0) {
        logger.warn(`No endpoints updated - UUIDs may not match database records`, {
          uuids,
          deviceUuid: deviceUuid.substring(0, 8)
        });
      } else {
        logger.info(`Marked ${result.rowCount} endpoints as pending deployment (${uuids.length} total in config)`);
      }
    } catch (error) {
      logger.error('Failed to mark endpoints as pending:', error);
      throw error;
    }
  }

  /**
   * Sync sensor devices from config to database table
   * Called during deployment or reconciliation
   * 
   * Flow:
   * - During deployment (userId != 'agent-reconciliation'): Add sensors with deployment_status='pending'
   * - During reconciliation (userId === 'agent-reconciliation'): New sensors='deployed', existing='deployed'
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
      const existingByName = new Map(existingResult.rows.map((r: any) => [r.name, r]));
      const existingUuids = new Set(existingResult.rows.map((r: any) => r.uuid).filter(Boolean));
      const configUuids = new Set(configDevices.map(d => d.uuid).filter(Boolean));

      // 1. Insert or update sensors from config
      for (const endpoint of configDevices) {
        if (endpoint.uuid && existingUuids.has(endpoint.uuid)) {
          const existing = existingByUuid.get(endpoint.uuid);
          
          // Update existing sensor by UUID (stable identifier)
          // Keep the existing deployment_status during deploy to avoid flipping all to pending.
          // During reconciliation, mark as deployed (agent has applied changes).
          const deploymentStatus = isReconciliation
            ? 'deployed'
            : (existing?.deployment_status || 'deployed');
          
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
              -- CRITICAL: DO NOT update health_* fields here - they come from updateEndpointHealth()
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
          const existingByNameMatch = existingByName.get(endpoint.name);
          
          // Insert new sensor into table
          // If reconciliation from agent, mark as deployed (agent found it running)
          // Otherwise, mark as pending ONLY for truly new sensors
          const deploymentStatus = isReconciliation
            ? 'deployed'
            : (existingByNameMatch
                ? (existingByNameMatch.deployment_status || 'deployed')
                : 'pending');
          
          // Reuse UUID if name already exists, otherwise generate a new one
          const sensorUuid = endpoint.uuid || existingByNameMatch?.uuid || uuidv4();
          
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
              config_id = EXCLUDED.config_id
              -- CRITICAL: DO NOT update health_* fields - they are updated separately via updateEndpointHealth()
              -- health_status, health_connected, health_last_poll, health_error_count, health_last_error, health_updated_at`,
            [
              deviceUuid,
              sensorUuid,
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
              sensorUuid // Use same UUID for config_id
            ]
          );
          logger.info(`Upserted: ${endpoint.name} (${endpoint.protocol}) - ${deploymentStatus} (uuid: ${sensorUuid.substring(0, 8)}...)`);
        }
      }


      logger.info(`Sync complete: config → table (version ${configVersion}) - ${isReconciliation ? 'DEPLOYED' : 'PENDING'}`);
      
      // Refresh metric catalog views after syncing device sensors
      // Fire-and-forget (don't block on refresh)
      if (configDevices.length > 0) {
        this.refreshMetricCatalog().catch(err => 
          logger.error('Background metric catalog refresh failed:', err)
        );
      }
    } catch (error) {
      logger.error(' Error syncing config to table:', error);
      throw error;
    }
  }

  /**
   * Deploy config changes (increment version and mark endpoints as pending)
   * Called when user clicks "Deploy" button
   * 
   * This triggers:
   * 1. Version increment (tells agent to pick up changes)
   * 2. Mark ONLY changed endpoints as 'pending' (config.endpoints are OVERRIDES, not full records)
   * 3. Agent will pick up changes and report back
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
      const endpointOverrides: EndpointDeviceConfig[] = config.endpoints || [];

      // 2. Increment version (tells agent to pick up changes)
      const updateResult = await query(
        `UPDATE device_target_state SET
           version = version + 1,
           updated_at = NOW()
         WHERE device_uuid = $1
         RETURNING version`,
        [deviceUuid]
      );

      const newVersion = updateResult.rows[0].version;

      // 3. Mark ONLY endpoints with overrides as 'pending'
      // Note: config.endpoints are OVERRIDE objects (just uuid + enabled), NOT full endpoint records
      if (endpointOverrides.length > 0) {
        const uuidsToMarkPending = endpointOverrides.map(e => e.uuid).filter(Boolean);
        
        if (uuidsToMarkPending.length > 0) {
          const result = await query(
            `UPDATE device_sensors 
             SET deployment_status = 'pending',
                 config_version = $1,
                 updated_by = $2,
                 updated_at = NOW()
             WHERE device_uuid = $3 AND uuid = ANY($4)`,
            [newVersion, userId || 'system', deviceUuid, uuidsToMarkPending]
          );
        }
      }

      // 4. Publish event
      await eventPublisher.publish(
        'device_config.deployed',
        'agent',
        deviceUuid,
        {
          version: newVersion,
          endpoints_count: endpointOverrides.length
        }
      );

      logger.info(`Deployed config (version: ${newVersion})`);

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
      
      // Ensure anomalyDetection config exists with defaults
      if (!config.anomalyDetection) {
        config.anomalyDetection = {
          enabled: true,
          defaults: {
            methods: ['mad'],
            threshold: 3.0,
            windowSize: 120,
            minSamples: 5
          },
          alerts: { cooldownMs: 300000, maxQueueSize: 1000 },
          systemMetrics: [],  // System metrics (cpu, memory, temp) - managed separately
          storage: { retention: 30, minSamples: 5 },
          sensitivity: 5,
          warmupPeriodMs: 900000
        };
      }
      
      // Data point anomaly configurations remain in endpoints[].dataPoints[].anomalyDetection
      // Agent will process them directly with inheritance from defaults

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
   * 
   * CRITICAL: Also handles cleanup of devices marked pending_deletion:
   * - If device is pending_deletion and NOT in agent's current state → hard delete
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

      // Sync table to match agent's reality (not desired state!)
      await this.syncConfigToTable(deviceUuid, runningEndpoints, currentVersion, 'agent-reconciliation');

      // CRITICAL: Check for devices pending deletion that agent has stopped
      // If device is pending_deletion and NOT in agent's current state → hard delete
      const agentEndpointNames = new Set(runningEndpoints.map(e => e.name));
      
      const pendingDeletionResult = await query(
        `SELECT uuid, name FROM device_sensors 
         WHERE device_uuid = $1 AND deployment_status = 'pending_deletion'`,
        [deviceUuid]
      );

      for (const row of pendingDeletionResult.rows) {
        if (!agentEndpointNames.has(row.name)) {
          logger.info(`Device "${row.name}" is pending_deletion and NOT in agent's state → hard deleting`);
          await this.hardDeleteEndpoint(deviceUuid, row.uuid, 'agent-reconciliation');
        } else {
          logger.warn(`Device "${row.name}" is pending_deletion but STILL in agent's state - agent hasn't stopped it yet`);
        }
      }

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
      
      logger.info(`[getEndpoints] Device ${deviceUuid.substring(0, 8)}: Found ${targetSensors.length} devices in target state`);
      logger.info(`[getEndpoints] Target state config.endpoints:`, targetSensors.map((s: any) => ({ name: s.name, enabled: s.enabled })));
      
      const targetSensorsByName = new Map(
        targetSensors.map((s: any) => [s.name, s])
      );
      
      // Read from TABLE (deployed/running state)
      // Include ALL devices (regular + virtual/sidecar) - agent sees them all
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

      logger.debug(`[getEndpoints] Fetching all devices (including virtual/sidecar) for device ${deviceUuid.substring(0, 8)}`);

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
        // If pending deletion, force disabled so UI doesn't show offline.
        const targetSensor: any = targetSensorsByName.get(row.name);
        const enabledFromTarget = row.deployment_status === 'pending_deletion'
          ? false
          : (targetSensor?.enabled !== undefined 
              ? targetSensor.enabled 
              : row.enabled);
        
        logger.debug(`[getEndpoints] Device "${row.name}": target=${targetSensor?.enabled}, table=${row.enabled}, final=${enabledFromTarget}`);
        
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
    logger.info(`Updating device "${endpointIdentifier}" for node ${deviceUuid.substring(0, 8)}...`);

    try {
      // 1. Check if endpoint exists in device_sensors table (source of truth)
      const tableResult = await query(
        `SELECT id, uuid, name, protocol, enabled, poll_interval, connection, data_points, metadata
         FROM device_sensors 
         WHERE device_uuid = $1 AND (uuid::text = $2 OR name = $2)`,
        [deviceUuid, endpointIdentifier]
      );

      if (tableResult.rows.length === 0) {
        throw new Error(`Device "${endpointIdentifier}" not found`);
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
        'agent',
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
   * Add new sensor device (Adds to config, then syncs to table)
   */
  async addEndpoint(
    deviceUuid: string,
    sensorConfig: EndpointDeviceConfig,
    userId?: string
  ): Promise<any> {
    logger.info(`Adding endpoint "${sensorConfig.name}" for device ${deviceUuid.substring(0, 8)}...`);

    try {
      // 1. Generate UUID if not provided
      if (!sensorConfig.uuid) {
        sensorConfig.uuid = uuidv4();
      }

      // 2. Get current target state
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
      const existingDevices: EndpointDeviceConfig[] = config.endpoints || [];

      // Clean up incomplete sensors (legacy discovery entries without required fields)
      const validExistingDevices = existingDevices.filter(d => {
        const isValid = d.protocol && d.connection && d.name;
        if (!isValid) {
          logger.warn(`Removing incomplete sensor from config: ${d.name || 'unnamed'} (missing protocol/connection)`);
          return false;
        }
        
        // Generate UUID if missing (legacy entries may have "id" instead of "uuid")
        if (!d.uuid) {
          if ((d as any).id) {
            d.uuid = (d as any).id; // Use existing id as uuid
            delete (d as any).id;
            logger.info(`Migrated sensor "${d.name}": id → uuid`);
          } else {
            d.uuid = uuidv4(); // Generate new UUID
            logger.info(`Generated UUID for sensor "${d.name}": ${d.uuid}`);
          }
        }
        
        return true;
      });

      // 3. Check for duplicate name
      const duplicate = validExistingDevices.find(d => d.name === sensorConfig.name);
      if (duplicate) {
        throw new Error(`Sensor with name "${sensorConfig.name}" already exists`);
      }

      // 4. Add sensor to config (SOURCE OF TRUTH)
      validExistingDevices.push(sensorConfig);
      config.endpoints = validExistingDevices;

      // 5. Save updated target state
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

      // 6. Insert ONLY the new sensor into table (don't touch existing sensors)
      await this.syncConfigToTable(deviceUuid, [sensorConfig], newVersion, userId);

      // 7. Publish event
      await eventPublisher.publish(
        'device_sensor.added',
        'agent',
        deviceUuid,
        {
          sensor_name: sensorConfig.name,
          sensor_uuid: sensorConfig.uuid,
          protocol: sensorConfig.protocol,
          version: newVersion
        }
      );

      logger.info(`Added sensor "${sensorConfig.name}" to config (version: ${newVersion})`);

      return {
        sensor: sensorConfig,
        version: newVersion
      };
    } catch (error) {
      logger.error('Error adding sensor:', error);
      throw error;
    }
  }

  /**
   * Delete sensor device (SOFT DELETE PATTERN - Reconciliation Required)
   * NOTE: sensorIdentifier can be either UUID (preferred) or name (backward compatibility)
   * 
   * CRITICAL: This is a SOFT DELETE that requires agent reconciliation:
   * 1. Mark sensor with deployment_status='pending_deletion' in database
   * 2. Keep in config.endpoints but marked for deletion
   * 3. Agent sees it in target state and stops polling it
   * 4. Agent reports it stopped in current state
   * 5. Hard delete happens later when agent confirms (via reconciliation or separate cleanup job)
   */
  async deleteEndpoint(
    deviceUuid: string,
    sensorIdentifier: string,
    userId?: string
  ): Promise<any> {
    logger.info(`Marking endpoint "${sensorIdentifier}" for deletion (device ${deviceUuid.substring(0, 8)}...)`);

    try {
      // 1. Check if sensor exists in database first (may not be in target state config yet)
      const sensorCheck = await query(
        'SELECT uuid, name FROM device_sensors WHERE device_uuid = $1 AND (uuid::text = $2 OR name = $2)',
        [deviceUuid, sensorIdentifier]
      );

      if (sensorCheck.rows.length === 0) {
        throw new Error(`Sensor "${sensorIdentifier}" not found`);
      }

      const sensorToDelete = sensorCheck.rows[0];

      // 2. SOFT DELETE: Mark in database (sensor may or may not be in config)
      // Update deployment_status to 'pending_deletion' in device_sensors table
      await query(
        `UPDATE device_sensors 
         SET deployment_status = 'pending_deletion',
             enabled = false,
             updated_at = NOW()
         WHERE device_uuid = $1 AND (uuid::text = $2 OR name = $2)`,
        [deviceUuid, sensorIdentifier]
      );

      // 3. Update target state version (triggers deployment)
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

      // 4. Publish event
      await eventPublisher.publish(
        'device_sensor.pending_deletion',
        'agent',
        deviceUuid,
        {
          sensor_name: sensorToDelete.name,
          sensor_uuid: sensorToDelete.uuid,
          version: newVersion
        }
      );

      logger.info(`Marked sensor "${sensorToDelete.name}" for deletion (version: ${newVersion}) - waiting for agent reconciliation`);

      return {
        version: newVersion,
        status: 'pending_deletion',
        message: 'Sensor marked for deletion - will be removed after agent confirmation'
      };
    } catch (error) {
      logger.error('Error marking sensor for deletion:', error);
      throw error;
    }
  }

  /**
   * Hard delete sensor after agent confirmation (called during reconciliation)
   * Only called when agent reports sensor is stopped in current state
   */
  async hardDeleteEndpoint(
    deviceUuid: string,
    sensorIdentifier: string,
    userId?: string
  ): Promise<any> {
    logger.info(`Hard deleting endpoint "${sensorIdentifier}" for device ${deviceUuid.substring(0, 8)}...`);

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

      // 3. Remove sensor from config (SOURCE OF TRUTH)
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
           updated_at = NOW()
         WHERE device_uuid = $3
         RETURNING version`,
        [JSON.stringify(apps), JSON.stringify(config), deviceUuid]
      );

      const newVersion = updateResult.rows[0].version;

      // 5. Hard delete from database
      await query(
        'DELETE FROM device_sensors WHERE device_uuid = $1 AND (uuid = $2 OR name = $2)',
        [deviceUuid, sensorIdentifier]
      );

      // 6. Publish event
      if (sensorToDelete) {
        await eventPublisher.publish(
          'device_sensor.deleted',
          'agent',
          deviceUuid,
          {
            sensor_name: sensorToDelete.name,
            sensor_uuid: sensorToDelete.uuid,
            version: newVersion
          }
        );
      }

      logger.info(`Hard deleted sensor "${sensorToDelete?.name || sensorIdentifier}" from config and database (version: ${newVersion})`);

      return {
        version: newVersion
      };
    } catch (error) {
      logger.error('Error hard deleting sensor:', error);
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

// Export standalone function for backward compatibility
export const syncTableToConfig = (deviceUuid: string, userId?: string) => 
  deviceSensorSync.syncTableToConfig(deviceUuid, userId);
