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
import { mqttDeviceTopic } from '../mqtt/topics';
import { getTenantId } from '../redis/tenant-keys';

const eventPublisher = new EventPublisher();

export interface EndpointDeviceConfig {
  id?: string; // UUID - generated at creation, persists through lifecycle
  uuid?: string; // Stable identifier for cloud/edge sync (survives name changes)
  name: string;
  protocol: 'modbus' | 'can' | 'opcua' | 'mqtt' | 'snmp';
  enabled: boolean;
  pollInterval?: number;
  connection: any;
  dataPoints: (ModbusDataPoint | OPCUADataPoint | any)[];  // Typed for Modbus/OPC-UA, any for other protocols
  metadata?: any;
  location?: string; // Physical location for Azure Digital Twins
}

export function prepareEndpointForCreate(
  deviceUuid: string,
  sensorConfig: EndpointDeviceConfig
): EndpointDeviceConfig {
  const { id: _ignoredId, ...configWithoutId } = sensorConfig;
  const preparedConfig: EndpointDeviceConfig = {
    ...configWithoutId,
    uuid: configWithoutId.uuid || uuidv4(),
  };

  if (preparedConfig.protocol === 'mqtt') {
    const topic = mqttDeviceTopic(getTenantId(), deviceUuid, 'mqtt', preparedConfig.uuid!);
    const { pollInterval, ...mqttConfig } = preparedConfig;

    return {
      ...mqttConfig,
      connection: {
        ...(preparedConfig.connection || {}),
        topic,
        qos: preparedConfig.connection?.qos ?? 1,
      },
    };
  }

  return preparedConfig;
}

function resolvePollIntervalForPersistence(endpoint: EndpointDeviceConfig, existingPollInterval?: number | null): number {
  const configured = endpoint.pollInterval;
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  if (typeof existingPollInterval === 'number' && Number.isFinite(existingPollInterval) && existingPollInterval > 0) {
    return existingPollInterval;
  }

  // Keep DB constraint satisfied even when protocol payload omits pollInterval (e.g. MQTT).
  return 5000;
}

export class DeviceSensorSyncService {
  private lastRefreshTime: number = 0;
  private readonly REFRESH_THROTTLE_MS = 60000; // Max once per minute

  /**
   * Remove anomaly metrics bound to an endpoint that is being deleted.
   * Supports canonical endpointUuid_metric names and legacy endpoint-name prefixes.
   */
  private pruneAnomalyMetricsForEndpoint(config: any, endpoint?: { uuid?: string; name?: string }): number {
    if (!config?.anomalyDetection || !Array.isArray(config.anomalyDetection.metrics) || !endpoint) {
      return 0;
    }

    const endpointUuid = (endpoint.uuid || '').trim();
    const endpointName = (endpoint.name || '').trim();
    const metrics: AnomalyMetric[] = config.anomalyDetection.metrics;

    const filtered = metrics.filter((metric) => {
      const metricName = (metric?.name || '').trim();
      if (!metricName) return true;

      // Canonical naming: endpointUuid_metricName
      if (endpointUuid && metricName.startsWith(`${endpointUuid}_`)) {
        return false;
      }

      // Legacy naming compatibility: endpointName_metricName
      if (endpointName && metricName.startsWith(`${endpointName}_`)) {
        return false;
      }

      return true;
    });

    const removed = metrics.length - filtered.length;
    if (removed > 0) {
      config.anomalyDetection.metrics = filtered;
    }

    return removed;
  }

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
   * Expand OPC UA sensor groups into individual nodes
   * Converts: { folder, prefix, model, count, unit } → [ {name, nodeId} ]
   * 
   * CRITICAL: Must match OPC UA simulator nodeId format exactly
   * Simulator creates: prefix_1, prefix_2, etc. (NO model name in node name)
   * Example: Sensor_1, Sensor_2 (folder already indicates "Temperature")
   */
  private expandOPCUASensorGroups(sensorGroups: any[]): OPCUADataPoint[] {
    const nodes: OPCUADataPoint[] = [];
    
    for (const group of sensorGroups) {
      // Check if it's a sensor group (has count/model) or manual node (has nodeId)
      if (group.nodeId) {
        // Already an individual node - pass through
        nodes.push(group);
        continue;
      }
      
      // Expand sensor group - MUST MATCH simulator pattern
      const { folder, prefix, model, count, unit, config } = group;
      
      for (let i = 1; i <= count; i++) {
        // Match simulator pattern: prefix_index (NO model name!)
        // Simulator: f"{prefix}_{i+1}" → "Sensor_1", "Sensor_2", etc.
        const sensorName = `${prefix}_${i}`;
        const nodeId = `ns=2;s=${folder}/${sensorName}`;
        
        nodes.push({
          name: sensorName,
          nodeId: nodeId,
          unit: unit,
          dataType: 'number'
        });
      }
    }
    
    return nodes;
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
        'SELECT id, name, uuid, config_id, enabled, poll_interval, connection, data_points, metadata, deployment_status, health_connected, location FROM device_sensors WHERE device_uuid = $1',
        [deviceUuid]
      );
      const existingByUuid = new Map(existingResult.rows.map((r: any) => [r.uuid, r]));
      const existingByConfigId = new Map(existingResult.rows.map((r: any) => [r.config_id, r]));
      const existingByName = new Map(existingResult.rows.map((r: any) => [r.name, r]));
      const existingUuids = new Set(existingResult.rows.map((r: any) => r.uuid).filter(Boolean));
      const configUuids = new Set(configDevices.map(d => d.uuid).filter(Boolean));

      // 1. Insert or update sensors from config
      for (const endpoint of configDevices) {
        const enrichedEndpointMetadata = endpoint.metadata || {};
        
        const endpointStableId = endpoint.uuid || endpoint.id;
        const existingByStableId = endpointStableId
          ? (existingByUuid.get(endpointStableId) || existingByConfigId.get(endpointStableId))
          : undefined;

        if (existingByStableId) {
          const existing = existingByStableId;
          
          // Update existing sensor by UUID (stable identifier)
          // Keep the existing deployment_status during deploy to avoid flipping all to pending.
          // During reconciliation, mark as deployed (agent has applied changes).
          const deploymentStatus = isReconciliation
            ? 'deployed'
            : (existing?.deployment_status || 'deployed');
          
          // CRITICAL: Preserve deployment metadata fields during reconciliation
          // Virtual devices have metadata like {sidecar: true, profile: "...", image: "..."} 
          // that must not be overwritten by agent reconciliation (agents don't know about these fields)
          let mergedMetadata = enrichedEndpointMetadata;
          
          if (isReconciliation && existing?.metadata) {
            const existingMeta = typeof existing.metadata === 'string' 
              ? JSON.parse(existing.metadata) 
              : existing.metadata;
            
            // During reconciliation, preserve deployment metadata fields
            const preservedFields = ['sidecar', 'profile', 'image', 'containerConfig', 'createdAt', 'createdBy'];
            preservedFields.forEach(field => {
              if (existingMeta[field] !== undefined) {
                mergedMetadata[field] = existingMeta[field];
              }
            });
          }
          
          if (isReconciliation && existing?.metadata) {
            const existingMeta = typeof existing.metadata === 'string' 
              ? JSON.parse(existing.metadata) 
              : existing.metadata;
            
            // During reconciliation, preserve deployment metadata fields
            const preservedFields = ['sidecar', 'profile', 'image', 'containerConfig', 'createdAt', 'createdBy'];
            preservedFields.forEach(field => {
              if (existingMeta[field] !== undefined) {
                mergedMetadata[field] = existingMeta[field];
              }
            });
          }
          
          const stableSensorUuid = existing.uuid || endpoint.uuid || endpoint.id || uuidv4();

          await query(
            `UPDATE device_sensors SET
              name = $1,
              uuid = $2,
              protocol = $3,
              enabled = $4,
              poll_interval = $5,
              connection = $6,
              data_points = $7,
              metadata = $8,
              location = $9,
              updated_by = $10,
              config_version = $11,
              synced_to_config = true,
              deployment_status = $12,
              config_id = $13
              -- CRITICAL: DO NOT update health_* fields here - they come from updateEndpointHealth()
            WHERE id = $14`,
            [
              endpoint.name,
              stableSensorUuid,
              endpoint.protocol,
              endpoint.enabled,
              resolvePollIntervalForPersistence(endpoint, existing?.poll_interval),
              JSON.stringify(endpoint.connection),
              JSON.stringify(endpoint.dataPoints),
              JSON.stringify(mergedMetadata),
              (endpoint as any).location || null,
              userId || 'system',
              configVersion,
              deploymentStatus,
              endpointStableId || stableSensorUuid,
              existing.id
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
          
          // CRITICAL: Preserve deployment metadata fields during reconciliation
          // If device exists by name, merge metadata to preserve sidecar/profile/image fields
          let mergedMetadata = enrichedEndpointMetadata;
          
          if (isReconciliation && existingByNameMatch?.metadata) {
            const existingMeta = typeof existingByNameMatch.metadata === 'string'
              ? JSON.parse(existingByNameMatch.metadata)
              : existingByNameMatch.metadata;
            
            // During reconciliation, preserve deployment metadata fields
            const preservedFields = ['sidecar', 'profile', 'image', 'containerConfig', 'createdAt', 'createdBy'];
            preservedFields.forEach(field => {
              if (existingMeta[field] !== undefined) {
                mergedMetadata[field] = existingMeta[field];
              }
            });
          }
          
          await query(
            `INSERT INTO device_sensors (
              device_uuid, uuid, name, protocol, enabled, poll_interval,
              connection, data_points, metadata, location, created_by, updated_by,
              config_version, synced_to_config, deployment_status, config_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true, $14, $15)
            ON CONFLICT (device_uuid, name) DO UPDATE SET
              uuid = EXCLUDED.uuid,
              protocol = EXCLUDED.protocol,
              enabled = EXCLUDED.enabled,
              poll_interval = EXCLUDED.poll_interval,
              connection = EXCLUDED.connection,
              data_points = EXCLUDED.data_points,
              metadata = EXCLUDED.metadata,
              location = EXCLUDED.location,
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
              resolvePollIntervalForPersistence(endpoint, existingByNameMatch?.poll_interval),
              JSON.stringify(endpoint.connection),
              JSON.stringify(endpoint.dataPoints),
              JSON.stringify(mergedMetadata),
              (endpoint as any).location || null,
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
          uuid: endpointUuid, // Include UUID for stable identifier (always valid UUID)
          name: row.name,
          protocol: row.protocol,
          enabled: row.enabled,
          connection: typeof row.connection === 'string' ? JSON.parse(row.connection) : row.connection,
          dataPoints: typeof row.data_points === 'string' ? JSON.parse(row.data_points) : row.data_points,
          metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
        };
      });

      configDevices.forEach((device: any, index: number) => {
        if (result.rows[index]?.protocol !== 'mqtt') {
          device.pollInterval = result.rows[index]?.poll_interval;
        }
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
          alerts: { cooldownMs: 300000, maxQueueSize: 1000, minConfidence: 0.7 },
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
  * CRITICAL: Also handles finalization of devices marked pending_deletion:
  * - If device is pending_deletion and NOT in agent's current state → mark deployment_status='deleted'
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
        logger.info(`Agent reports 0 endpoints - continuing reconciliation to finalize pending deletions`);
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

      // CRITICAL: Check for devices pending deletion that agent has stopped.
      // Finalize delete when pending_deletion endpoint is missing from agent current state.
      const agentEndpointByName = new Map(runningEndpoints.map(e => [e.name, e]));
      
      const pendingDeletionResult = await query(
        `SELECT uuid, name FROM device_sensors 
         WHERE device_uuid = $1 AND deployment_status = 'pending_deletion'`,
        [deviceUuid]
      );

      for (const row of pendingDeletionResult.rows) {
        const agentEndpoint = agentEndpointByName.get(row.name);
        const isMissingFromAgentState = !agentEndpoint;

        if (isMissingFromAgentState) {
          logger.info(`Device "${row.name}" is pending_deletion and missing from agent state → marking deleted`);
          await this.markEndpointDeleted(deviceUuid, row.uuid, 'agent-reconciliation');
        } else {
          logger.warn(`Device "${row.name}" is pending_deletion but still present in agent state - waiting for removal`);
        }
      }

      // MODBUS DISCOVERY: Update target state config when slaves are discovered
      // When agent discovers Modbus slaves, remove parent from config and add slaves
      await this.updateTargetStateWithDiscoveredSlaves(deviceUuid, runningEndpoints);

      logger.info(`Reconciliation complete: agent reality → table (version ${currentVersion})`);
    } catch (error) {
      logger.error('Error reconciling current state to table:', error);
      throw error;
    }
  }

  /**
   * Update target state config with discovered Modbus slaves
   * 
   * Flow:
   * 1. Identify discovered slaves (have metadata.slaveId and metadata.connectionName)
   * 2. Match them to their parent discovery target by connectionName
   * 3. Remove parent from target state config
   * 4. Add all discovered slaves to target state config
   * 
   * This ensures the target state reflects actual discovered devices, not just discovery targets
   */
  private async updateTargetStateWithDiscoveredSlaves(
    deviceUuid: string,
    runningEndpoints: EndpointDeviceConfig[]
  ): Promise<void> {
    try {
      // Identify discovered Modbus slaves (have slaveId in metadata)
      const discoveredSlaves = runningEndpoints.filter(e => 
        e.protocol === 'modbus' && 
        e.metadata?.slaveId !== undefined &&
        e.metadata?.connectionName !== undefined
      );

      if (discoveredSlaves.length === 0) {
        // No discovered slaves - skip update
        return;
      }

      logger.info(`Found ${discoveredSlaves.length} discovered Modbus slave(s) - updating target state config...`);

      // Get current target state
      const targetStateResult = await query(
        'SELECT config, version FROM device_target_state WHERE device_uuid = $1',
        [deviceUuid]
      );

      if (targetStateResult.rows.length === 0) {
        logger.warn(`No target state found for device ${deviceUuid.substring(0, 8)} - skipping config update`);
        return;
      }

      const targetState = targetStateResult.rows[0];
      const targetConfig = typeof targetState.config === 'string' 
        ? JSON.parse(targetState.config) 
        : targetState.config;

      if (!targetConfig.endpoints || !Array.isArray(targetConfig.endpoints)) {
        logger.warn(`No endpoints array in target state config - skipping update`);
        return;
      }

      // Group discovered slaves by connectionName
      const slavesByConnection = new Map<string, typeof discoveredSlaves>();
      for (const slave of discoveredSlaves) {
        const connName = slave.metadata?.connectionName;
        if (!slavesByConnection.has(connName)) {
          slavesByConnection.set(connName, []);
        }
        slavesByConnection.get(connName)!.push(slave);
      }

      // Find parent discovery targets (those with slaveRange matching connectionName)
      const parentsToRemove: string[] = [];
      const parentNamesToDelete: string[] = []; // Track names for table deletion
      const slavesToAdd: EndpointDeviceConfig[] = [];

      for (const [connectionName, slaves] of slavesByConnection.entries()) {
        // Find parent by connectionName (endpoint name should match)
        const parentIndex = targetConfig.endpoints.findIndex((ep: any) => 
          ep.protocol === 'modbus' && 
          (ep.name === connectionName || ep.metadata?.connectionName === connectionName || 
           ep.id || ep.uuid) && 
          ep.connection?.slaveRange // Parent has slaveRange
        );

        if (parentIndex !== -1) {
          const parent = targetConfig.endpoints[parentIndex];
          parentsToRemove.push(parent.id || parent.uuid || parent.name);
          parentNamesToDelete.push(parent.name); // Store for table deletion
          
          logger.info(`Found parent "${parent.name}" for ${slaves.length} discovered slave(s) via connectionName: ${connectionName}`);

          // Add discovered slaves to config
          for (const slave of slaves) {
            slavesToAdd.push({
              id: slave.id || slave.uuid,
              uuid: slave.uuid,
              name: slave.name,
              protocol: slave.protocol,
              enabled: slave.enabled,
              pollInterval: slave.pollInterval,
              connection: slave.connection,
              dataPoints: slave.dataPoints,
              metadata: slave.metadata
            });

            logger.info(`Adding discovered slave "${slave.name}" (ID: ${slave.metadata?.slaveId}) to target state config`);
          }
        }
      }

      // If no parents found by connectionName, try fallback: match by name pattern
      if (parentsToRemove.length === 0 && discoveredSlaves.length > 0) {
        logger.info(`No parents matched by connectionName - trying name pattern fallback...`);

        // Try to match by endpoint name pattern: if slave name is "parent_slave_X", find parent
        for (const slave of discoveredSlaves) {
          const slaveIdMatch = slave.name.match(/_slave_(\d+)$/);
          if (slaveIdMatch) {
            // Extract parent name from slave: "myconn_slave_1" → "myconn"
            const parentName = slave.name.substring(0, slave.name.lastIndexOf('_slave_'));
            const parentIndex = targetConfig.endpoints.findIndex((ep: any) => 
              ep.protocol === 'modbus' && 
              ep.name === parentName && 
              ep.connection?.slaveRange
            );

            if (parentIndex !== -1) {
              const parent = targetConfig.endpoints[parentIndex];
              const parentId = parent.id || parent.uuid;
              
              if (!parentsToRemove.includes(parentId)) {
                parentsToRemove.push(parentId);
                parentNamesToDelete.push(parent.name);
                logger.info(`Found parent "${parentName}" by name pattern for slave "${slave.name}"`);
              }

              // Add this slave to the list
              const existingSlave = slavesToAdd.find(s => s.name === slave.name);
              if (!existingSlave) {
                slavesToAdd.push({
                  id: slave.id || slave.uuid,
                  uuid: slave.uuid,
                  name: slave.name,
                  protocol: slave.protocol,
                  enabled: slave.enabled,
                  pollInterval: slave.pollInterval,
                  connection: slave.connection,
                  dataPoints: slave.dataPoints,
                  metadata: slave.metadata
                });

                logger.info(`Adding discovered slave "${slave.name}" (ID: ${slave.metadata?.slaveId}) to target state config`);
              }
            }
          }
        }
      }

      // Update config: remove parents, add slaves
      if (parentsToRemove.length > 0 || slavesToAdd.length > 0) {
        const updatedEndpoints = targetConfig.endpoints.filter((ep: any) => {
          const epId = ep.id || ep.uuid;
          const isParent = parentsToRemove.includes(epId);
          if (isParent) {
            logger.info(`Removing discovery parent "${ep.name}" from target state config`);
          }
          return !isParent;
        });

        // Add discovered slaves
        updatedEndpoints.push(...slavesToAdd);

        // Update target state with new endpoints
        targetConfig.endpoints = updatedEndpoints;

        // CRITICAL: Delete parents from device_sensors table by name
        // Parents are identified by having connection.slaveRange and matching parent names we identified
        logger.info(`Deleting ${parentNamesToDelete.length} parent(s) from device_sensors table: ${parentNamesToDelete.join(', ')}`);
        
        for (const parentName of parentNamesToDelete) {
          try {
            const deleteResult = await query(
              `DELETE FROM device_sensors 
               WHERE device_uuid = $1 AND name = $2 AND protocol = 'modbus'`,
              [deviceUuid, parentName]
            );
            
            if (deleteResult.rowCount && deleteResult.rowCount > 0) {
              logger.info(`Deleted discovery parent "${parentName}" from device_sensors (${deleteResult.rowCount} row(s))`);
            } else {
              logger.warn(`Discovery parent "${parentName}" not found in device_sensors for deletion`);
            }
          } catch (deleteError) {
            logger.error(`Failed to delete parent device "${parentName}": ${deleteError}`);
          }
        }

        await query(
          `UPDATE device_target_state SET
            config = $1,
            version = version + 1,
            updated_at = CURRENT_TIMESTAMP
           WHERE device_uuid = $2`,
          [JSON.stringify(targetConfig), deviceUuid]
        );

        logger.info(`Target state config updated: removed ${parentsToRemove.length} parent(s), added ${slavesToAdd.length} discovered slave(s)`);
      }
    } catch (error) {
      logger.error('Error updating target state with discovered slaves:', error);
      // Don't throw - reconciliation should continue even if config update fails
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
               health_last_error, health_updated_at, last_telemetry_at
        FROM device_sensors 
        WHERE device_uuid = $1 AND deployment_status != 'deleted'
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
            updatedAt: row.health_updated_at,
            lastTelemetryAt: row.last_telemetry_at
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
        `SELECT id, uuid, name, protocol, enabled, poll_interval, connection, data_points, metadata, location
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
      const nextProtocol = updates.protocol ?? existingEndpoint.protocol;
      const updatedEndpoint = {
        name: updates.name ?? existingEndpoint.name,
        protocol: nextProtocol,
        enabled: updates.enabled ?? existingEndpoint.enabled,
        poll_interval: resolvePollIntervalForPersistence(
          {
            ...(updates as EndpointDeviceConfig),
            protocol: nextProtocol,
            pollInterval: updates.pollInterval,
          } as EndpointDeviceConfig,
          existingEndpoint.poll_interval
        ),
        location: updates.location ?? existingEndpoint.location,
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
           location = $8,
           updated_by = $9,
           updated_at = NOW(),
           synced_to_config = false
         WHERE device_uuid = $10 AND uuid = $11`,
        [
          updatedEndpoint.name,
          updatedEndpoint.protocol,
          updatedEndpoint.enabled,
          updatedEndpoint.poll_interval,
          updatedEndpoint.connection,
          updatedEndpoint.data_points,
          updatedEndpoint.metadata,
          updatedEndpoint.location,
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
    userId?: string,
    deploymentMetadata?: any // K8s/deployment metadata - stored in DB only, not in target state
  ): Promise<any> {
    logger.info(`Adding endpoint "${sensorConfig.name}" for device ${deviceUuid.substring(0, 8)}...`);

    try {
      const preparedSensorConfig = prepareEndpointForCreate(deviceUuid, sensorConfig);

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
      const duplicate = validExistingDevices.find(d => d.name === preparedSensorConfig.name);
      if (duplicate) {
        throw new Error(`Sensor with name "${preparedSensorConfig.name}" already exists`);
      }

      // 4. Add sensor to config (SOURCE OF TRUTH)
      // For OPC UA: Remove dataPoints - agent discovers nodes from OPC UA server
      // For Modbus: Keep dataPoints with register mappings (required)
      let configForTargetState: any = preparedSensorConfig;
      
      if (preparedSensorConfig.protocol === 'opcua') {
        const { dataPoints, ...opcuaConfig } = preparedSensorConfig as any;
        configForTargetState = opcuaConfig; // Remove dataPoints field entirely
      }
      
      validExistingDevices.push(configForTargetState);
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

      // 6. Insert ONLY the new sensor into table (with full dataPoints and deployment metadata)
      // Database gets complete record with dataPoints (even for OPC UA) and deployment metadata
      const sensorWithMetadata = deploymentMetadata 
        ? { ...preparedSensorConfig, metadata: deploymentMetadata }
        : preparedSensorConfig;
      
      await this.syncConfigToTable(deviceUuid, [sensorWithMetadata], newVersion, userId);

      // 7. Publish event
      await eventPublisher.publish(
        'device_sensor.added',
        'agent',
        deviceUuid,
        {
          sensor_name: preparedSensorConfig.name,
          sensor_uuid: preparedSensorConfig.uuid,
          protocol: preparedSensorConfig.protocol,
          version: newVersion
        }
      );

      logger.info(`Added sensor "${preparedSensorConfig.name}" to config (version: ${newVersion})`);

      return {
        sensor: preparedSensorConfig,
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
  * 2. Remove sensor from target state config.endpoints
  * 3. Agent applies target state and removes the endpoint
  * 4. Agent reports current state without the endpoint
  * 5. Reconciliation marks deployment_status='deleted' (record retained in DB)
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

      // 3. Remove endpoint from target state so agent removes it on next sync.
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
      const originalCount = existingDevices.length;
      config.endpoints = existingDevices.filter((endpoint: EndpointDeviceConfig) => (
        endpoint.uuid !== sensorIdentifier && endpoint.name !== sensorIdentifier
      ));
      const matchedInTarget = config.endpoints.length < originalCount;

      const removedAnomalyMetrics = this.pruneAnomalyMetricsForEndpoint(config, {
        uuid: sensorToDelete.uuid,
        name: sensorToDelete.name,
      });
      if (removedAnomalyMetrics > 0) {
        logger.info(
          `Pruned ${removedAnomalyMetrics} anomaly metric(s) for deleted endpoint "${sensorToDelete.name}"`
        );
      }

      if (!matchedInTarget) {
        logger.warn(
          `Sensor "${sensorToDelete.name}" was marked pending_deletion in table but not found in target state endpoints`
        );
      }

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
   * Mark endpoint as deleted after agent confirmation (keeps DB record for audit/history)
   */
  async markEndpointDeleted(
    deviceUuid: string,
    sensorIdentifier: string,
    userId?: string
  ): Promise<void> {
    const result = await query(
      `UPDATE device_sensors
       SET deployment_status = 'deleted',
           enabled = false,
           updated_by = $3,
           updated_at = NOW()
       WHERE device_uuid = $1 AND (uuid::text = $2 OR name = $2)
       RETURNING uuid, name`,
      [deviceUuid, sensorIdentifier, userId || 'system']
    );

    if (result.rows.length === 0) {
      logger.warn(`markEndpointDeleted: endpoint not found for identifier ${sensorIdentifier}`);
      return;
    }

    const row = result.rows[0];

    await eventPublisher.publish(
      'device_sensor.deleted',
      'agent',
      deviceUuid,
      {
        sensor_name: row.name,
        sensor_uuid: row.uuid
      }
    );

    logger.info(`Marked sensor "${row.name}" as deleted (kept in database)`);
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

      const removedAnomalyMetrics = this.pruneAnomalyMetricsForEndpoint(config, {
        uuid: sensorToDelete?.uuid,
        name: sensorToDelete?.name,
      });
      if (removedAnomalyMetrics > 0) {
        logger.info(
          `Pruned ${removedAnomalyMetrics} anomaly metric(s) for hard-deleted endpoint "${sensorToDelete?.name || sensorIdentifier}"`
        );
      }

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

      // 5. Hard delete from database
      await query(
        'DELETE FROM device_sensors WHERE device_uuid = $1 AND (uuid::text = $2 OR name = $2)',
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
             health_updated_at = NOW(),
             deployment_status = CASE
               WHEN deployment_status IN ('pending', 'draft') THEN 'deployed'
               ELSE deployment_status
             END
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
