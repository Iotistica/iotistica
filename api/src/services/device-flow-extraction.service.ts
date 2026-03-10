/**
 * Device Flow Extraction Service
 * Extracts device-specific subflows from Node-RED flows and manages deployment
 */

import * as crypto from 'crypto';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { getMqttManager } from '../mqtt';
import { mqttDeviceTopic } from '../mqtt/topics';
import { getTenantId } from '../redis/tenant-keys';

interface SubflowNode {
  id: string;
  type: string;
  name?: string;
  z?: string;
  env?: Array<{ name: string; value: string; type: string }>;
  [key: string]: any;
}

interface DeviceSubflow {
  deviceUuid: string;
  subflowId: string;
  subflowName: string;
  flows: SubflowNode[];
  hash: string;
}

export class DeviceFlowExtractionService {
  /**
   * Extract device-specific subflows from Node-RED flows
   * Called when flows are saved via storage API
   */
  static async extractAndSaveDeviceFlows(flows: any[]): Promise<void> {
    try {
      logger.info('Starting device flow extraction', { flowCount: flows.length });

      // Find all subflows with DeviceId environment variable
      const deviceSubflows = this.extractDeviceSubflows(flows);

      if (deviceSubflows.length === 0) {
        logger.info('No device-specific subflows found');
        return;
      }

      logger.info(`Found ${deviceSubflows.length} device-specific subflow assignments`);

      // Save each device subflow and publish if changed
      for (const deviceSubflow of deviceSubflows) {
        await this.saveDeviceFlow(deviceSubflow);
      }

      logger.info('Device flow extraction completed', { 
        deviceSubflowCount: deviceSubflows.length 
      });
    } catch (error: any) {
      logger.error('Error extracting device flows', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }

  /**
   * Extract subflows that have DeviceId environment variable
   */
  private static extractDeviceSubflows(flows: any[]): DeviceSubflow[] {
    const deviceSubflows: DeviceSubflow[] = [];

    // Find subflows with DeviceId env var
    const subflowsWithDevices = flows.filter(
      (flow) =>
        flow.type === 'subflow' &&
        flow.env?.some((envVar: any) => envVar.name === 'DeviceId' && envVar.value)
    );

    for (const subflow of subflowsWithDevices) {
      const deviceIdEnv = subflow.env.find((envVar: any) => envVar.name === 'DeviceId');
      
      if (!deviceIdEnv || !deviceIdEnv.value) {
        continue;
      }

      // Parse device IDs (can be array of UUIDs or single UUID string)
      let deviceIds: string[];
      try {
        // Try parsing as JSON first (array format)
        const parsed = JSON.parse(deviceIdEnv.value);
        deviceIds = Array.isArray(parsed) ? parsed : [parsed];
      } catch (e) {
        // If not JSON, treat as plain string UUID
        const trimmed = deviceIdEnv.value.trim();
        if (trimmed) {
          deviceIds = [trimmed];
        } else {
          logger.warn('Empty DeviceId env var', {
            subflowId: subflow.id
          });
          continue;
        }
      }

      // Get all nodes belonging to this subflow
      const subflowNodes = this.selectSubflowWithNodes(flows, subflow.id);
      const hash = this.generateHash(subflowNodes);

      // Create entry for each device
      for (const deviceUuid of deviceIds) {
        deviceSubflows.push({
          deviceUuid,
          subflowId: subflow.id,
          subflowName: subflow.name || `Subflow ${subflow.id}`,
          flows: subflowNodes,
          hash
        });
      }
    }

    return deviceSubflows;
  }

  /**
   * Select subflow and all its child nodes
   */
  private static selectSubflowWithNodes(flows: any[], subflowId: string): SubflowNode[] {
    const parent = flows.find((flow) => flow.id === subflowId);
    if (!parent) return [];

    const children = flows.filter((flow) => flow.z === subflowId);
    return [parent, ...children];
  }

  /**
   * Generate SHA-256 hash of flows for change detection
   */
  private static generateHash(flows: any[]): string {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify(flows));
    return hash.digest('hex');
  }

  /**
   * Save device flow to database and publish if changed
   */
  private static async saveDeviceFlow(deviceSubflow: DeviceSubflow): Promise<void> {
    try {
      // Check if device exists
      const deviceCheck = await query(
        'SELECT uuid, device_name FROM devices WHERE uuid = $1',
        [deviceSubflow.deviceUuid]
      );

      if (deviceCheck.rows.length === 0) {
        logger.warn('Device not found, skipping flow save', {
          deviceUuid: deviceSubflow.deviceUuid,
          subflowId: deviceSubflow.subflowId
        });
        return;
      }

      const device = deviceCheck.rows[0];

      // Check if flow already exists with same hash (no changes)
      const existingFlow = await query(
        'SELECT id, hash, version FROM device_flows WHERE device_uuid = $1 AND subflow_id = $2',
        [deviceSubflow.deviceUuid, deviceSubflow.subflowId]
      );

      if (existingFlow.rows.length > 0) {
        const existing = existingFlow.rows[0];
        
        if (existing.hash === deviceSubflow.hash) {
          logger.debug('Device flow unchanged, skipping', {
            deviceUuid: deviceSubflow.deviceUuid,
            subflowId: deviceSubflow.subflowId,
            hash: deviceSubflow.hash
          });
          return;
        }

        // Update existing flow (version incremented)
        await query(
          `UPDATE device_flows 
           SET flows = $1, hash = $2, subflow_name = $3, version = version + 1, updated_at = NOW()
           WHERE device_uuid = $4 AND subflow_id = $5
           RETURNING id, version`,
          [
            JSON.stringify(deviceSubflow.flows),
            deviceSubflow.hash,
            deviceSubflow.subflowName,
            deviceSubflow.deviceUuid,
            deviceSubflow.subflowId
          ]
        );

        logger.info('Device flow updated', {
          deviceUuid: deviceSubflow.deviceUuid,
          deviceName: device.device_name,
          subflowId: deviceSubflow.subflowId,
          subflowName: deviceSubflow.subflowName,
          newVersion: existing.version + 1
        });
      } else {
        // Insert new flow
        await query(
          `INSERT INTO device_flows (device_uuid, subflow_id, subflow_name, flows, hash, version)
           VALUES ($1, $2, $3, $4, $5, 1)
           RETURNING id`,
          [
            deviceSubflow.deviceUuid,
            deviceSubflow.subflowId,
            deviceSubflow.subflowName,
            JSON.stringify(deviceSubflow.flows),
            deviceSubflow.hash
          ]
        );

        logger.info('Device flow created', {
          deviceUuid: deviceSubflow.deviceUuid,
          deviceName: device.device_name,
          subflowId: deviceSubflow.subflowId,
          subflowName: deviceSubflow.subflowName
        });
      }

      // Publish to MQTT
      await this.publishDeviceFlow(deviceSubflow, device.device_name);

    } catch (error: any) {
      logger.error('Error saving device flow', {
        error: error.message,
        deviceUuid: deviceSubflow.deviceUuid,
        subflowId: deviceSubflow.subflowId
      });
      throw error;
    }
  }

  /**
   * Publish device flow to MQTT
   */
  private static async publishDeviceFlow(
    deviceSubflow: DeviceSubflow,
    deviceName: string
  ): Promise<void> {
    try {
      const mqttManager = getMqttManager();
      
      if (!mqttManager) {
        logger.warn('MQTT manager not initialized, skipping flow publish', {
          deviceUuid: deviceSubflow.deviceUuid
        });
        return;
      }

      // Follow standard IoT topic pattern: iot/{tenantId}/device/{uuid}/subflow/snapshot
      const tenantId = getTenantId();
      const topic = mqttDeviceTopic(tenantId, deviceSubflow.deviceUuid, 'subflow', 'snapshot');
      const payload = {
        name: 'Auto snapshot',
        description: `Auto snapshot for device ${deviceName}`,
        flows: deviceSubflow.flows,
        modules: null,
        timestamp: new Date().toISOString()
      };

      await mqttManager.publish(topic, payload);

      logger.info('Published device flow to MQTT', {
        deviceUuid: deviceSubflow.deviceUuid,
        deviceName,
        subflowId: deviceSubflow.subflowId,
        topic
      });

      // Update deployed_at timestamp
      await query(
        'UPDATE device_flows SET deployed_at = NOW() WHERE device_uuid = $1 AND subflow_id = $2',
        [deviceSubflow.deviceUuid, deviceSubflow.subflowId]
      ).catch(err => {
        logger.error('Failed to update deployed_at', {
          error: err.message,
          deviceUuid: deviceSubflow.deviceUuid
        });
      });
    } catch (error: any) {
      logger.error('Error in publishDeviceFlow', {
        error: error.message,
        deviceUuid: deviceSubflow.deviceUuid
      });
    }
  }

  /**
   * Get device flows for a specific device
   */
  static async getDeviceFlows(deviceUuid: string): Promise<any[]> {
    const result = await query(
      `SELECT id, subflow_id, subflow_name, flows, settings, modules, hash, version, 
              is_active, created_at, updated_at, deployed_at
       FROM device_flows
       WHERE device_uuid = $1 AND is_active = true
       ORDER BY updated_at DESC`,
      [deviceUuid]
    );

    return result.rows;
  }

  /**
   * Force redeploy a device flow via MQTT
   */
  static async redeployDeviceFlow(deviceUuid: string, subflowId: string): Promise<void> {
    const result = await query(
      `SELECT df.*, d.device_name
       FROM device_flows df
       JOIN devices d ON d.uuid = df.device_uuid
       WHERE df.device_uuid = $1 AND df.subflow_id = $2 AND df.is_active = true`,
      [deviceUuid, subflowId]
    );

    if (result.rows.length === 0) {
      throw new Error('Device flow not found');
    }

    const deviceFlow = result.rows[0];
    
    await this.publishDeviceFlow(
      {
        deviceUuid,
        subflowId,
        subflowName: deviceFlow.subflow_name,
        flows: deviceFlow.flows,
        hash: deviceFlow.hash
      },
      deviceFlow.device_name
    );
  }
}
