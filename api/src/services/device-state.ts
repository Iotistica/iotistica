/**
 * Device State Handler Service
 * 
 * Shared logic for processing device state reports from both HTTP and MQTT paths.
 * Handles:
 * - Device existence verification
 * - Current state updates
 * - Sensor reconciliation
 * - Metrics recording
 * - Event sourcing
 * - Redis pub/sub (Phase 1)
 */

import { query } from '../db/connection';
import {
  DeviceModel,
  DeviceCurrentStateModel,
  DeviceMetricsModel,
} from '../db/models';
import { EventPublisher, objectsAreEqual } from './event-sourcing';
import EventSourcingConfig from '../events/event-sourcing';
import { deviceSensorSync } from './device-endpoints';
import logger from '../utils/logger';

const eventPublisher = new EventPublisher();

export interface DeviceStateReport {
  [uuid: string]: {
    apps?: any;
    config?: any;
    version?: number;
    ip_address?: string;
    local_ip?: string;
    mac_address?: string;
    os_version?: string;
    architecture?: string;
    agent_version?: string;
    uptime?: number;
    cpu_usage?: number;
    cpu_temp?: number;
    memory_usage?: number;
    memory_total?: number;
    storage_usage?: number;
    storage_total?: number;
    top_processes?: any;
    network_interfaces?: any;
    sensor_health?: any;
    protocol_adapters_health?: any;
    endpoints_health?: Record<string, any>; // Endpoint health from agent
  };
}

export interface ProcessingOptions {
  source: 'http' | 'mqtt';
  ipAddress?: string;
  userAgent?: string;
  topic?: string;
}

/**
 * Process device state report
 * Can be called from both HTTP endpoint and MQTT handler
 */
export async function processDeviceStateReport(
  stateReport: DeviceStateReport,
  options: ProcessingOptions
): Promise<void> {
  for (const uuid in stateReport) {
    const deviceState = stateReport[uuid];

    logger.debug(`Device ${uuid.substring(0, 8)} state report details:`, {
      appsKeys: deviceState.apps ? Object.keys(deviceState.apps) : 'empty',
      configKeys: deviceState.config ? Object.keys(deviceState.config) : 'empty',
      hasConfigEndpoints: deviceState.config?.endpoints ? deviceState.config.endpoints.length : 'missing',
      hasEndpointsHealth: !!deviceState.endpoints_health,
      endpointsHealthCount: deviceState.endpoints_health ? Object.keys(deviceState.endpoints_health).length : 0,
      version: deviceState.version,
      hasVersion: deviceState.version !== undefined,
      versionType: typeof deviceState.version
    });
    
    // Ensure device exists and mark as online
    const device = await DeviceModel.getOrCreate(uuid);
    if (!device) {
      logger.warn('Device state report from unregistered device - skipping', {
        deviceUuid: uuid.substring(0, 8) + '...',
      });
      continue; // Skip this device
    }

    // Update current state (including version from agent report)
    await DeviceCurrentStateModel.update(
      uuid,
      deviceState.apps || {},
      deviceState.config || {},
      {
        ip_address: deviceState.ip_address,
        mac_address: deviceState.mac_address,
        os_version: deviceState.os_version,
        architecture: deviceState.architecture,
        agent_version: deviceState.agent_version,
        uptime: deviceState.uptime,
      },
      deviceState.version // Pass version from agent report
    );

    // 🩺 HEALTH UPDATE: Update endpoint health from agent report FIRST
    // endpoints_health is sent at root level, not in config
    // CRITICAL: Must happen BEFORE config sync to avoid race conditions
    if (deviceState.endpoints_health) {
      logger.info(`Processing endpoint health for device ${uuid.substring(0, 8)}... (${Object.keys(deviceState.endpoints_health).length} endpoints)`);
      await deviceSensorSync.updateEndpointHealth(uuid, deviceState.endpoints_health);
    } else {
      logger.debug(`No endpoints_health in state report for device ${uuid.substring(0, 8)}`);
    }

    // 🔄 RECONCILIATION: Sync agent's current state to device_sensors table
    // Only reconcile if config.endpoints is present in the report
    // This runs AFTER health update to preserve health_* columns
    if (deviceState.config?.endpoints) {
        await deviceSensorSync.syncCurrentStateToTable(uuid, deviceState);
    }

    // EVENT SOURCING: Publish current state updated event
    const oldState = await DeviceCurrentStateModel.get(uuid);
    
    // Use hash comparison for efficient change detection
    const stateChanged = !oldState || !objectsAreEqual(oldState.apps, deviceState.apps);

    // Check config to see if we should publish state updates
    if (EventSourcingConfig.shouldPublishStateUpdate(stateChanged)) {
      await eventPublisher.publish(
        'current_state.updated',
        'agent',
        uuid,
        {
          apps: deviceState.apps || {},
          config: deviceState.config || {},
          system_info: {
            ip_address: deviceState.ip_address || deviceState.local_ip,
            mac_address: deviceState.mac_address,
            os_version: deviceState.os_version,
            architecture: deviceState.architecture,
            agent_version: deviceState.agent_version,
            uptime: deviceState.uptime,
            cpu_usage: deviceState.cpu_usage,
            memory_usage: deviceState.memory_usage,
            storage_usage: deviceState.storage_usage
          },
          apps_count: Object.keys(deviceState.apps || {}).length,
          reported_at: new Date().toISOString(),
          changed_from: oldState ? {
            apps_count: Object.keys(oldState.apps || {}).length
          } : null
        },
        {
          metadata: {
            ip_address: options.ipAddress,
            user_agent: options.userAgent,
            endpoint: options.source === 'http' ? '/device/state' : 'mqtt',
            change_detection: stateChanged ? 'apps_changed' : 'no_change',
            config_mode: EventSourcingConfig.PUBLISH_STATE_UPDATES
          }
        }
      );
    }

    // Update device table with IP address and system info
    const updateFields: any = {};
    if (deviceState.ip_address) updateFields.ip_address = deviceState.ip_address;
    if (deviceState.local_ip) updateFields.ip_address = deviceState.local_ip;
    if (deviceState.mac_address) updateFields.mac_address = deviceState.mac_address;
    if (deviceState.os_version) updateFields.os_version = deviceState.os_version;
    if (deviceState.agent_version) updateFields.agent_version = deviceState.agent_version;
    
    if (Object.keys(updateFields).length > 0) {
      await DeviceModel.update(uuid, updateFields);
    }

    // Record metrics if provided
    // Phase 2: Write to Redis Streams + Pub/Sub in one pass
    // Background worker will batch process stream metrics
    if (
      deviceState.cpu_usage !== undefined ||
      deviceState.memory_usage !== undefined ||
      deviceState.storage_usage !== undefined
    ) {
      // Import Redis client once for both operations
      try {
        const { redisClient } = await import('../redis/client');
        
        const metrics = {
          cpu_usage: deviceState.cpu_usage,
          cpu_temp: deviceState.cpu_temp,
          memory_usage: deviceState.memory_usage,
          memory_total: deviceState.memory_total,
          storage_usage: deviceState.storage_usage,
          storage_total: deviceState.storage_total,
          top_processes: deviceState.top_processes,
          network_interfaces: deviceState.network_interfaces,
        };
        
        // 1. Add to Redis Stream for batch processing (Phase 2)
        const streamId = await redisClient.addMetric(uuid, metrics);
        
        if (!streamId) {
          // Redis Stream unavailable - fallback to direct write
          logger.warn(`Redis Stream unavailable, using direct write for ${uuid.substring(0, 8)}...`);
          await DeviceMetricsModel.record(uuid, metrics);
        }
        
        // 2. Publish to pub/sub for real-time distribution (Phase 1)
        await redisClient.publishDeviceMetrics(uuid, metrics);
        
      } catch (error) {
        // Error with Redis - fallback to direct write
        logger.error('Redis error, using direct PostgreSQL write:', error);
        await DeviceMetricsModel.record(uuid, {
          cpu_usage: deviceState.cpu_usage,
          cpu_temp: deviceState.cpu_temp,
          memory_usage: deviceState.memory_usage,
          memory_total: deviceState.memory_total,
          storage_usage: deviceState.storage_usage,
          storage_total: deviceState.storage_total,
          top_processes: deviceState.top_processes,
        });
      }
      
      // Update latest snapshot in devices table (still needed for quick access)
      if (deviceState.top_processes) {
        await query(
          `UPDATE devices SET top_processes = $1 WHERE uuid = $2`,
          [JSON.stringify(deviceState.top_processes), uuid]
        );
      }
      
      // Store network interfaces if provided
      if (deviceState.network_interfaces) {
        await query(
          `UPDATE devices SET network_interfaces = $1 WHERE uuid = $2`,
          [JSON.stringify(deviceState.network_interfaces), uuid]
        );
      }
    }

    logger.info(`Processed state report for device ${uuid.substring(0, 8)}... (${options.source})`);
  }
}
