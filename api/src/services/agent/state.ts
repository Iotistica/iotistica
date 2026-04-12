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

import { query } from '../../db/connection';
import {
  AgentModel,
  DeviceCurrentStateModel,
} from '../../db/models';
import { EventPublisher, objectsAreEqual } from '../event-sourcing';
import EventSourcingConfig from '../../events/event-sourcing';
import { deviceSensorSync, syncAgentDevices } from './devices';
import { getTenantId } from '../../redis/tenant-keys';
import logger from '../../utils/logger';

const eventPublisher = new EventPublisher();

export interface AgentStateReport {
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
    devices?: Array<{
      uuid: string;
      endpoint_uuid: string;
      name: string;
      protocol: string;
      identifier: string | null;
      enabled: boolean;
      lastSeenAt: string | null;
    }>; // Agent-reported physical/logical devices
    provisioning_state?: string; // Provisioning state from agent (e.g., 'provisioned', 'registered')
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
export async function processAgentStateReport(
  stateReport: AgentStateReport,
  options: ProcessingOptions
): Promise<void> {
  for (const uuid in stateReport) {
    const deviceState = stateReport[uuid];

    logger.debug(`Agent ${uuid.substring(0, 8)} state report details:`, {
      appsKeys: deviceState.apps ? Object.keys(deviceState.apps) : 'empty',
      configKeys: deviceState.config ? Object.keys(deviceState.config) : 'empty',
      hasConfigEndpoints: deviceState.config?.endpoints ? deviceState.config.endpoints.length : 'missing',
      hasEndpointsHealth: !!deviceState.endpoints_health,
      endpointsHealthCount: deviceState.endpoints_health ? Object.keys(deviceState.endpoints_health).length : 0,
      version: deviceState.version,
      hasVersion: deviceState.version !== undefined,
      versionType: typeof deviceState.version,
      ip_address: deviceState.ip_address ?? null,
      mac_address: deviceState.mac_address ?? null,
      os_version: deviceState.os_version ?? null,
      architecture: deviceState.architecture ?? null,
      agent_version: deviceState.agent_version ?? null,
      uptime: deviceState.uptime ?? null,
    });
    
    // Ensure device exists and mark as online
    const device = await AgentModel.getOrCreate(uuid);
    if (!device) {
      logger.warn('Agent state report from unregistered device - skipping', {
        deviceUuid: uuid.substring(0, 8) + '...',
      });
      continue; // Skip this device
    }

    // 🔐 SECURITY: Cleanup provisioning key for virtual agents after provisioning
    // Agent reports with provisioning_state = 'provisioned' after successful provisioning
    // Trigger cleanup when we receive first state report from provisioned agent
    // Cleanup is idempotent - will gracefully handle if Secret already deleted
    const shouldCleanup = device.type === 'virtual' && 
                          deviceState.provisioning_state === 'provisioned' &&
                          device.provisioning_state !== 'provisioned';
    
    if (shouldCleanup) {
      logger.info('Virtual agent just completed provisioning - triggering cleanup', {
        deviceUuid: uuid.substring(0, 8) + '...',
        deviceName: device.name,
        oldState: device.provisioning_state,
        newState: deviceState.provisioning_state
      });

      // Trigger cleanup (non-blocking, idempotent)
      (async () => {
        try {
          const { virtualAgentDeployer } = await import('../provisioning/virtual-agent-deployer');
          await virtualAgentDeployer.cleanupProvisioningKey(uuid);
        } catch (error) {
          // Cleanup is idempotent - Secret might already be deleted, which is fine
          logger.debug('Provisioning key cleanup completed or already done', {
            deviceUuid: uuid.substring(0, 8) + '...',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })();
    }

    // Update current state (including version from agent report)
    await DeviceCurrentStateModel.update(
      uuid,
      deviceState.apps || {},
      deviceState.config,
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
      logger.info(`Processing device health for agent ${uuid.substring(0, 8)}... (${Object.keys(deviceState.endpoints_health).length} endpoints)`);
      await deviceSensorSync.updateEndpointHealth(uuid, deviceState.endpoints_health);
    } else {
      logger.debug(`No endpoints_health in state report for agent ${uuid.substring(0, 8)}`);
    }

    // RECONCILIATION: Sync agent's current state to endpoints table
    // Only reconcile if config.endpoints is present in the report
    // This runs AFTER health update to preserve health_* columns
    if (deviceState.config?.endpoints) {
        await deviceSensorSync.syncCurrentStateToTable(uuid, deviceState);
    }

    // DEVICES: Store agent-reported physical/logical devices
    if (deviceState.devices?.length) {
      await syncAgentDevices(uuid, deviceState.devices);
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
      await AgentModel.update(uuid, updateFields);
    }

    // Record metrics if provided - push to shared readings stream (protocol='system')
    // so that ingestion handles persistence via the same pipeline as sensor data.
    if (
      deviceState.cpu_usage !== undefined ||
      deviceState.memory_usage !== undefined ||
      deviceState.storage_usage !== undefined
    ) {
      try {
        const { redisDeviceQueue } = await import('../../services/telemetry');
        const { redisClient } = await import('../../redis/client');
        const tenantId = getTenantId();

        // Build numeric readings array (Format 2 — expandFormat2 in readings-normalizer)
        const readings: Array<{ metric: string; value: number }> = [];
        const addNum = (key: string, val: unknown) => {
          if (typeof val === 'number') readings.push({ metric: key, value: val });
        };
        addNum('cpu_usage', deviceState.cpu_usage);
        addNum('cpu_temp', deviceState.cpu_temp);
        addNum('memory_usage', deviceState.memory_usage);
        addNum('memory_total', deviceState.memory_total);
        addNum('storage_usage', deviceState.storage_usage);
        addNum('storage_total', deviceState.storage_total);

        if (readings.length > 0) {
          await redisDeviceQueue.add([{
            deviceUuid: uuid,
            deviceName: uuid,
            timestamp: new Date().toISOString(),
            metadata: { protocol: 'system' },
            data: { protocol: 'system', readings },
          }]);
        }

        // Publish to pub/sub for real-time dashboard distribution
        await redisClient.publishAgentMetrics(tenantId, uuid, {
          cpu_usage: deviceState.cpu_usage,
          cpu_temp: deviceState.cpu_temp,
          memory_usage: deviceState.memory_usage,
          memory_total: deviceState.memory_total,
          storage_usage: deviceState.storage_usage,
          storage_total: deviceState.storage_total,
          network_interfaces: deviceState.network_interfaces,
        });
      } catch (error) {
        logger.error('Failed to publish agent system metrics', { error: (error as Error).message });
      }

      // Store network interfaces if provided
      if (deviceState.network_interfaces) {
        await query(
          `UPDATE agents SET network_interfaces = $1 WHERE uuid = $2`,
          [JSON.stringify(deviceState.network_interfaces), uuid]
        );
      }
    }

    logger.info(`Processed state report for device ${uuid.substring(0, 8)}... (${options.source})`);
  }
}
