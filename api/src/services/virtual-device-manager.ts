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
    // Modbus format
    host?: string;
    port?: number;
    type?: string;
    timeout?: number;
    slaveRange?: {
      start: number;
      end: number;
    };
    // OPC UA format
    endpointUrl?: string;
    securityMode?: string;
    securityPolicy?: string;
  };
  data_points?: any[];
  metadata: {
    sidecar: boolean;
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
    
    // Extract ports from both formats (Modbus uses 'port', OPC UA uses 'endpointUrl')
    const usedPorts = existingDevices.map(d => {
      if (d.connection.port) {
        // Modbus format: { host, port, type }
        return d.connection.port;
      } else if (d.connection.endpointUrl) {
        // OPC UA format: { endpointUrl: "opc.tcp://localhost:4840" }
        const match = d.connection.endpointUrl.match(/:(\d+)$/);
        return match ? parseInt(match[1], 10) : null;
      }
      return null;
    }).filter((p): p is number => p !== null);
    
    const nextPort = this.findNextAvailablePort(usedPorts, config.protocol);

    // 4. Build container config
    const image = config.image || `iotistic/${config.protocol}-simulator:latest`;
    const containerEnv = this.buildContainerEnv(config.protocol, config.profile, nextPort, config.slaveCount);

    // 5. Build connection object (protocol-specific format)
    const slaveCount = config.slaveCount || 1;
    let connectionObj: any;
    
    if (config.protocol === 'opcua') {
      // OPC UA: Use endpointUrl format
      connectionObj = {
        endpointUrl: `opc.tcp://localhost:${nextPort}`,
        securityMode: 'None',
        securityPolicy: 'None'
      };
    } else if (config.protocol === 'modbus') {
      // Modbus: Use host/port format with slaveRange
      connectionObj = {
        host: 'localhost',
        port: nextPort,
        type: 'tcp',
        timeout: 5000
      };
      
      if (slaveCount > 0) {
        connectionObj.slaveRange = {
          start: 1,
          end: slaveCount
        };
      }
    } else {
      // Default format for other protocols
      connectionObj = {
        host: 'localhost',
        port: nextPort,
        type: 'tcp',
        timeout: 5000
      };
    }

    // 6. Use standard addEndpoint flow (dual-write: table + config)
    // This ensures virtual devices appear in target state like regular devices
    
    // Base config with all data (for database)
    const sensorConfig = {
      name: config.name,
      protocol: config.protocol,
      enabled: true,
      pollInterval: 5000,
      connection: connectionObj,
      dataPoints: config.protocol === 'opcua' ? [] : dataPoints // OPC UA uses auto-discovery, Modbus needs register mappings
    };

    // K8s deployment metadata: Stored in database only, not in target state
    const deploymentMetadata = {
      sidecar: true,
      profile: config.profile,
      image,
      containerConfig: {
        env: containerEnv
      },
      createdAt: new Date().toISOString(),
      createdBy: 'virtual-device-manager'
    };

    const result = await deviceSensorSync.addEndpoint(
      config.deviceUuid,
      sensorConfig,
      'virtual-device-manager',
      deploymentMetadata // Pass separately so it only goes to DB, not target state
    );

    logger.info('Virtual device added via standard flow', {
      uuid: result.sensor.uuid,
      deviceUuid: config.deviceUuid,
      protocol: config.protocol,
      profile: config.profile,
      port: nextPort,
      version: result.version
    });

    // 7. Query database to get complete record with all fields
    // This ensures we return the same structure as regular devices
    const dbResult = await query(
      `SELECT uuid, device_uuid, name, protocol, enabled, poll_interval,
              connection, data_points, metadata, created_at, updated_at,
              created_by, updated_by, deployment_status, config_version,
              synced_to_config
       FROM device_sensors
       WHERE device_uuid = $1 AND uuid = $2`,
      [config.deviceUuid, result.sensor.uuid]
    );

    if (dbResult.rows.length === 0) {
      throw new Error('Virtual device created but not found in database');
    }

    const dbRecord = dbResult.rows[0];

    // 8. If parent is K8s virtual agent, patch Deployment
    if (agent.helm_release_name && agent.k8s_namespace) {
      await this.patchVirtualAgentDeployment(config.deviceUuid, agent.helm_release_name, agent.k8s_namespace);
    }

    // 9. Return complete database record
    return {
      uuid: dbRecord.uuid,
      device_uuid: dbRecord.device_uuid,
      name: dbRecord.name,
      protocol: dbRecord.protocol,
      connection: typeof dbRecord.connection === 'string'
        ? JSON.parse(dbRecord.connection)
        : dbRecord.connection,
      data_points: typeof dbRecord.data_points === 'string'
        ? JSON.parse(dbRecord.data_points)
        : dbRecord.data_points,
      metadata: typeof dbRecord.metadata === 'string'
        ? JSON.parse(dbRecord.metadata)
        : dbRecord.metadata
    };
  }

  /**
   * Get all virtual devices for a parent agent
   */
  async getVirtualDevices(deviceUuid: string): Promise<VirtualDeviceSensor[]> {
    const result = await query(
      `SELECT uuid, device_uuid, name, protocol, connection, data_points, metadata
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
      data_points: typeof row.data_points === 'string' ? JSON.parse(row.data_points) : row.data_points,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
    }));
  }

  /**
   * Delete virtual device
   * 
   * Flow:
   * 1. Use standard deleteEndpoint flow (soft delete)
   * 2. If parent is K8s virtual agent, patch Deployment to remove sidecar
   */
  async deleteVirtualDevice(deviceUuid: string, sensorUuid: string): Promise<void> {
    // Get parent device info before deletion
    const agent = await DeviceModel.getByUuid(deviceUuid);
    
    // Use standard deleteEndpoint flow (soft delete with reconciliation)
    await deviceSensorSync.deleteEndpoint(deviceUuid, sensorUuid, 'virtual-device-manager');

    logger.info('Virtual device marked for deletion', { uuid: sensorUuid, deviceUuid });

    // If parent is K8s virtual agent, patch Deployment immediately
    // (virtual devices don't need agent reconciliation since they're sidecars)
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
      // Extract port from connection (handles both Modbus and OPC UA formats)
      let port: number;
      if (vd.connection.port) {
        // Modbus format: { host, port, type }
        port = vd.connection.port;
      } else if (vd.connection.endpointUrl) {
        // OPC UA format: { endpointUrl: "opc.tcp://localhost:4840" }
        const match = vd.connection.endpointUrl.match(/:(\d+)$/);
        port = match ? parseInt(match[1], 10) : 4840; // Fallback to default OPC UA port
      } else {
        logger.error('Cannot extract port from connection', {
          virtualDeviceUuid: vd.uuid,
          connection: vd.connection
        });
        throw new Error(`Cannot extract port from connection for device ${vd.uuid}`);
      }
      
      const containerName = `${vd.protocol}-sim-${port}`;
      const envArray = Object.entries(vd.metadata.containerConfig.env).map(([name, value]) => ({
        name,
        value: String(value)
      }));

      return {
        name: containerName,
        image: vd.metadata.image,
        env: envArray,
        ports: [{ containerPort: port }],
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
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
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
      env.PROFILE = profile;
      env.PORT = String(port);
      env.SLAVES = String(slaveCount || 40);
      env.API_URL = apiUrl;
      env.GUI_PORT = String(port + 1000); // Web GUI on offset port (e.g., 1502)
    } else if (protocol === 'opcua') {
      env.PROFILE = profile;
      env.PORT = String(port);
      env.API_URL = apiUrl;
    }

    return env;
  }
}
