/**
 * Virtual Device Manager Service
 * 
 * Manages virtual device sidecars (protocol simulators) that run alongside agents.
 * Virtual devices are stored in device_sensors table and deployed as sidecar containers.
 * 
 * Key Features:
 * - Profile-based configuration (defines data points exposed by simulator)
 * - Auto-assigned ports (502, 503, 504... for Modbus; 4840, 4841... for OPC-UA)
 * - Sidecar deployment pattern (same pod as agent, accessed via localhost)
 * - Support for both K8s virtual agents and physical Docker Compose agents
 */

import * as k8s from '@kubernetes/client-node';
import { query } from '../db/connection.js';
import { logger } from '../utils/logger.js';
import { DeviceModel } from '../db/models.js';
import { deviceSensorSync } from './device-endpoints.js';

export interface VirtualDeviceConfig {
  deviceUuid: string; // Parent agent UUID
  name: string; // Display name (e.g., "Virtual PLC 1")
  protocol: 'modbus' | 'opcua'; // Protocol type
  profile: string; // Profile name (e.g., "PM556x", "Generic")
  image?: string; // Container image (defaults to iotistic/{protocol}-simulator:latest)
  slaveCount?: number; // Number of slave IDs (Modbus) or endpoints (OPC-UA)
}

export interface VirtualDeviceSensor {
  uuid: string;
  device_uuid: string;
  name: string;
  protocol: string;
  connection: {
    host: string;
    port: number;
    type: string; // e.g., "tcp" for Modbus
    timeout: number; // Connection timeout in ms
    slaveRange?: { // Modbus slave range (optional)
      start: number;
      end: number;
    };
  };
  data_points?: any[]; // Data points from profile
  metadata: {
    sidecar: boolean; // Indicates this is a sidecar device
    profile: string;
    image: string;
    containerConfig: {
      env: Record<string, string>;
    };
  };
}

export class VirtualDeviceManager {
  private k8sConfig?: k8s.KubeConfig;
  private appsApi?: k8s.AppsV1Api;

  constructor() {
    // Initialize K8s client for patching virtual agent deployments
    try {
      this.k8sConfig = new k8s.KubeConfig();
      
      // Try in-cluster config first
      const fs = require('fs');
      const serviceAccountPath = '/var/run/secrets/kubernetes.io/serviceaccount';
      const requiredFiles = [
        `${serviceAccountPath}/token`,
        `${serviceAccountPath}/ca.crt`,
        `${serviceAccountPath}/namespace`
      ];
      
      if (requiredFiles.every(f => fs.existsSync(f))) {
        this.k8sConfig.loadFromCluster();
        logger.info('VirtualDeviceManager: K8s in-cluster config loaded');
      } else {
        this.k8sConfig.loadFromDefault();
        logger.info('VirtualDeviceManager: K8s default config loaded');
      }

      this.appsApi = this.k8sConfig.makeApiClient(k8s.AppsV1Api);
    } catch (error) {
      logger.warn('VirtualDeviceManager: K8s config not available, virtual agent deployment patching disabled', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Create virtual device sidecar
   * 
   * Flow:
   * 1. Validate parent device exists
   * 2. Auto-assign port based on existing virtual devices
   * 3. Insert into device_sensors table with profile metadata
   * 4. If parent is K8s virtual agent, patch Deployment to add sidecar
   */
  async createVirtualDevice(config: VirtualDeviceConfig): Promise<VirtualDeviceSensor> {
    // 1. Validate parent device exists
    const agent = await DeviceModel.getByUuid(config.deviceUuid);
    if (!agent) {
      throw new Error(`Parent agent not found: ${config.deviceUuid}`);
    }

    // 2. Fetch profile data points
    const profileResult = await query(
      'SELECT data_points FROM profile_configs WHERE profile_name = $1 AND protocol = $2',
      [config.profile, config.protocol]
    );

    if (profileResult.rows.length === 0) {
      throw new Error(`Profile '${config.profile}' not found for protocol '${config.protocol}'`);
    }

    const dataPoints = typeof profileResult.rows[0].data_points === 'string'
      ? JSON.parse(profileResult.rows[0].data_points)
      : profileResult.rows[0].data_points;

    // 3. Auto-assign port
    const existingDevices = await this.getVirtualDevices(config.deviceUuid);
    const usedPorts = existingDevices.map(d => d.connection.port);
    const nextPort = this.findNextAvailablePort(usedPorts, config.protocol);

    // 4. Build container config
    const image = config.image || `iotistic/${config.protocol}-simulator:latest`;
    const containerEnv = this.buildContainerEnv(config.protocol, config.profile, nextPort, config.slaveCount);

    // 5. Build connection object
    const slaveCount = config.slaveCount || 1;
    const connectionObj: any = {
      host: 'localhost',
      port: nextPort,
      type: 'tcp',
      timeout: 5000
    };

    // Add slaveRange if specified (Modbus only)
    if (config.protocol === 'modbus' && slaveCount > 0) {
      connectionObj.slaveRange = {
        start: 1,
        end: slaveCount
      };
    }

    // 6. Use standard addEndpoint flow (dual-write: table + config)
    // This ensures virtual devices appear in target state like regular devices
    const sensorConfig = {
      name: config.name,
      protocol: config.protocol,
      enabled: true,
      pollInterval: 5000,
      connection: connectionObj,
      dataPoints: dataPoints,
      metadata: {
        sidecar: true, // Flag for K8s deployment (not for filtering)
        profile: config.profile,
        image,
        containerConfig: {
          env: containerEnv
        },
        createdAt: new Date().toISOString(),
        createdBy: 'virtual-device-manager'
      }
    };

    const result = await deviceSensorSync.addEndpoint(
      config.deviceUuid,
      sensorConfig,
      'virtual-device-manager'
    );

    const virtualDevice = result.sensor;

    logger.info('Virtual device created via standard flow', {
      uuid: virtualDevice.uuid,
      deviceUuid: config.deviceUuid,
      protocol: config.protocol,
      profile: config.profile,
      port: nextPort,
      version: result.version
    });

    // 7. If parent is K8s virtual agent, patch Deployment
    if (agent.helm_release_name && agent.k8s_namespace) {
      await this.patchVirtualAgentDeployment(config.deviceUuid, agent.helm_release_name, agent.k8s_namespace);
    }

    return {
      uuid: virtualDevice.uuid,
      device_uuid: config.deviceUuid,
      name: virtualDevice.name,
      protocol: virtualDevice.protocol,
      connection: connectionObj,
      data_points: dataPoints,
      metadata: sensorConfig.metadata
    };
  }

  /**
   * Get all virtual devices for a parent agent
   */
  async getVirtualDevices(deviceUuid: string): Promise<VirtualDeviceSensor[]> {
    const result = await query(
      `SELECT uuid, device_uuid, name, protocol, connection, metadata
       FROM device_sensors
       WHERE device_uuid = $1 
       AND metadata->>'sidecar' = 'true'
       ORDER BY created_at ASC`,
      [deviceUuid]
    );

    return result.rows.map(row => ({
      uuid: row.uuid,
      device_uuid: row.device_uuid,
      name: row.name,
      protocol: row.protocol,
      connection: typeof row.connection === 'string' ? JSON.parse(row.connection) : row.connection,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
    }));
  }

  /**
   * Delete virtual device
   * 
   * Flow:
   * 1. Delete from device_sensors table
   * 2. If parent is K8s virtual agent, patch Deployment to remove sidecar
   */
  async deleteVirtualDevice(deviceUuid: string, sensorUuid: string): Promise<void> {
    // Get parent device info before deletion
    const agent = await DeviceModel.getByUuid(deviceUuid);
    
    // Delete from database
    await query('DELETE FROM device_sensors WHERE uuid = $1 AND device_uuid = $2', [sensorUuid, deviceUuid]);

    logger.info('Virtual device deleted', { uuid: sensorUuid, deviceUuid });

    // If parent is K8s virtual agent, patch Deployment
    if (agent?.helm_release_name && agent?.k8s_namespace) {
      await this.patchVirtualAgentDeployment(deviceUuid, agent?.helm_release_name, agent?.k8s_namespace);
    }
  }

  /**
   * Patch K8s Deployment to sync sidecar containers with device_sensors table
   * 
   * This reads all virtual devices for the agent and rebuilds the sidecar container list.
   */
  async patchVirtualAgentDeployment(deviceUuid: string, helm_release_name: string, k8s_namespace: string): Promise<void> {
    if (!this.appsApi) {
      logger.warn('K8s API not available, skipping deployment patch', { deviceUuid });
      return;
    }

    // Get all virtual devices for this agent
    const virtualDevices = await this.getVirtualDevices(deviceUuid);
    
    // Build sidecar container specs
    const sidecarContainers = virtualDevices.map(vd => {
      const containerName = `${vd.protocol}-sim-${vd.connection.port}`;
      const envArray = Object.entries(vd.metadata.containerConfig.env).map(([name, value]) => ({
        name,
        value: String(value)
      }));

      return {
        name: containerName,
        image: vd.metadata.image,
        env: envArray,
        ports: [{ containerPort: vd.connection.port }],
        resources: {
          limits: {
            cpu: '500m',
            memory: '512Mi'
          },
          requests: {
            cpu: '100m',
            memory: '128Mi'
          }
        }
      };
    });

    try {
      // Get current deployment to preserve agent container
      const deployment = await this.appsApi.readNamespacedDeployment(
        helm_release_name,
        k8s_namespace
      );

      const agentContainer = deployment.body.spec?.template.spec?.containers?.[0];
      if (!agentContainer) {
        throw new Error('Agent container not found in deployment');
      }

      // Patch deployment with agent + sidecars
      const patch = {
        spec: {
          template: {
            spec: {
              containers: [
                agentContainer, // Keep agent container
                ...sidecarContainers // Add/replace sidecars
              ]
            }
          }
        }
      };

      await this.appsApi.patchNamespacedDeployment(
        helm_release_name,
        k8s_namespace,
        patch,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          headers: {
            'Content-Type': 'application/strategic-merge-patch+json'
          }
        }
      );

      logger.info('Virtual agent deployment patched with sidecars', {
        deviceUuid,
        deployment: helm_release_name,
        namespace: k8s_namespace,
        sidecarCount: sidecarContainers.length
      });
    } catch (error) {
      logger.error('Failed to patch virtual agent deployment', {
        deviceUuid,
        deployment: helm_release_name,
        namespace: k8s_namespace,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Find next available port for protocol
   */
  private findNextAvailablePort(usedPorts: number[], protocol: string): number {
    const basePort = this.getBasePort(protocol);
    let port = basePort;
    
    while (usedPorts.includes(port)) {
      port++;
    }

    return port;
  }

  /**
   * Get base port for protocol
   */
  private getBasePort(protocol: string): number {
    const basePorts: Record<string, number> = {
      modbus: 502,
      opcua: 4840,
      mqtt: 1883,
      can: 11898 // Virtual SocketCAN port
    };

    return basePorts[protocol] || 5000;
  }

  /**
   * Build container environment variables for simulator
   */
  private buildContainerEnv(
    protocol: string, 
    profile: string, 
    port: number, 
    slaveCount?: number
  ): Record<string, string> {
    const apiUrl = process.env.CLOUD_API_URL || 'http://api:3002';

    const env: Record<string, string> = {
      LOG_LEVEL: 'INFO'
    };

    if (protocol === 'modbus') {
      env.TRANSPORT = 'tcp';
      env.MODBUS_PROFILE = profile;
      env.MODBUS_PORT = String(port);
      env.MODBUS_SLAVES = String(slaveCount || 40);
      env.MODBUS_API_URL = apiUrl;
      env.GUI_PORT = String(port + 1000); // Web GUI on offset port (e.g., 1502)
    } else if (protocol === 'opcua') {
      env.OPCUA_PROFILE = profile;
      env.OPCUA_PORT = String(port);
      env.OPCUA_ENDPOINT_COUNT = String(slaveCount || 10);
      env.OPCUA_API_URL = apiUrl;
    }

    return env;
  }
}
