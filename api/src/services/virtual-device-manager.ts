/**
 * Virtual Device Manager Service
 * 
 * Manages virtual device sidecars (protocol simulators) that run alongside agents.
 * Virtual devices are stored in endpoints table and deployed as sidecar containers.
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
import { deviceSensorSync } from './agent-devices.js';

export interface VirtualDeviceConfig {
  deviceUuid: string; // Parent agent UUID
  name: string; // Display name (e.g., "Virtual PLC 1")
  protocol: 'modbus' | 'opcua'; // Protocol type
  profile: string; // Profile name (e.g., "PM556x", "Generic")
  image?: string; // Container image (defaults to iotistic/{protocol}-simulator:latest)
  slaveCount?: number; // Number of slave IDs (Modbus) or endpoints (OPC-UA)
}

export interface VirtualDevice {
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
  private coreApi?: k8s.CoreV1Api;
  private cloudApiUrl?: string;

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
      this.coreApi = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
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
   * 2. Check fleet device limit (devices_per_agent)
   * 3. Fetch profile data points
   * 4. Auto-assign port based on existing virtual devices
   * 5. Build container config and connection object
   * 6. Insert into endpoints table via standard addEndpoint flow
   * 7. If parent is K8s virtual agent, update ResourceQuota and patch Deployment
   */
  async createVirtualDevice(config: VirtualDeviceConfig): Promise<VirtualDevice> {
    logger.info('[VirtualDeviceManager] Starting virtual device creation', {
      deviceUuid: config.deviceUuid,
      name: config.name,
      protocol: config.protocol,
      profile: config.profile,
      slaveCount: config.slaveCount
    });

    // 1. Validate parent device exists
    const agent = await DeviceModel.getByUuid(config.deviceUuid);
    if (!agent) {
      logger.error('[VirtualDeviceManager] Parent agent not found', {
        deviceUuid: config.deviceUuid
      });
      throw new Error(`Parent agent not found: ${config.deviceUuid}`);
    }

    logger.info('[VirtualDeviceManager] Parent agent found', {
      agentUuid: agent.uuid,
      agentName: agent.device_name,
      agentType: agent.device_type,
      helmRelease: agent.helm_release_name,
      namespace: agent.k8s_namespace
    });

    // 2. Check fleet device limit (if agent belongs to a fleet)
    if (agent.k8s_namespace?.startsWith('fleet-')) {
      const fleetResult = await query(
        'SELECT devices_per_agent FROM fleets WHERE k8s_namespace = $1',
        [agent.k8s_namespace]
      );

      if (fleetResult.rows.length > 0) {
        const devicesPerAgent = fleetResult.rows[0].devices_per_agent;
        const existingDevices = await this.getVirtualDevices(config.deviceUuid);

        logger.info('[VirtualDeviceManager] Checking fleet device limit', {
          namespace: agent.k8s_namespace,
          devicesPerAgent,
          existingCount: existingDevices.length,
          wouldExceed: existingDevices.length >= devicesPerAgent
        });

        if (existingDevices.length >= devicesPerAgent) {
          logger.error('[VirtualDeviceManager] Fleet device limit exceeded', {
            namespace: agent.k8s_namespace,
            limit: devicesPerAgent,
            existingCount: existingDevices.length
          });
          throw new Error(
            `Fleet device limit exceeded: ${existingDevices.length}/${devicesPerAgent} virtual devices already created for this agent`
          );
        }
      }
    }

    // 3. Fetch profile data points
    logger.info('[VirtualDeviceManager] Fetching profile configuration', {
      profile: config.profile,
      protocol: config.protocol
    });

    const profileResult = await query(
      'SELECT data_points FROM profile_configs WHERE profile_name = $1 AND protocol = $2',
      [config.profile, config.protocol]
    );

    if (profileResult.rows.length === 0) {
      logger.error('[VirtualDeviceManager] Profile not found', {
        profile: config.profile,
        protocol: config.protocol
      });
      throw new Error(`Profile '${config.profile}' not found for protocol '${config.protocol}'`);
    }

    logger.info('[VirtualDeviceManager] Profile configuration loaded', {
      profile: config.profile,
      dataPointCount: profileResult.rows[0].data_points?.length || 0
    });

    const dataPoints = typeof profileResult.rows[0].data_points === 'string'
      ? JSON.parse(profileResult.rows[0].data_points)
      : profileResult.rows[0].data_points;

    // 4. Auto-assign port
    logger.info('[VirtualDeviceManager] Checking existing virtual devices for port assignment', {
      deviceUuid: config.deviceUuid
    });

    const existingDevices = await this.getVirtualDevices(config.deviceUuid);
    
    logger.info('[VirtualDeviceManager] Found existing virtual devices', {
      deviceUuid: config.deviceUuid,
      existingCount: existingDevices.length,
      existing: existingDevices.map(d => ({ uuid: d.uuid, protocol: d.protocol, connection: d.connection }))
    });

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
    
    logger.info('[VirtualDeviceManager] Port analysis complete', {
      usedPorts,
      protocol: config.protocol
    });

    const nextPort = this.findNextAvailablePort(usedPorts, config.protocol);

    logger.info('[VirtualDeviceManager] Assigned port for new virtual device', {
      protocol: config.protocol,
      assignedPort: nextPort
    });

    // 5. Build container config
    const image = config.image || `docker.io/iotistic/${config.protocol}-simulator:latest`;
    const containerEnv = await this.buildContainerEnv(config.protocol, config.profile, nextPort, config.slaveCount);

    // 6. Build connection object (protocol-specific format)
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

    // 7. Use standard addEndpoint flow (dual-write: table + config)
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

    logger.info('[VirtualDeviceManager] Adding virtual device endpoint to database', {
      deviceUuid: config.deviceUuid,
      sensorConfig,
      deploymentMetadata
    });

    const result = await deviceSensorSync.addEndpoint(
      config.deviceUuid,
      sensorConfig,
      'virtual-device-manager',
      deploymentMetadata // Pass separately so it only goes to DB, not target state
    );

    logger.info('[VirtualDeviceManager] Virtual device added via standard flow', {
      uuid: result.sensor.uuid,
      deviceUuid: config.deviceUuid,
      protocol: config.protocol,
      profile: config.profile,
      port: nextPort,
      version: result.version
    });

    // 8. Query database to get complete record with all fields
    // This ensures we return the same structure as regular devices
    const dbResult = await query(
      `SELECT uuid, agent_uuid AS device_uuid, name, protocol, enabled, poll_interval,
              connection, data_points, metadata, created_at, updated_at,
              created_by, updated_by, deployment_status, config_version,
              synced_to_config
       FROM endpoints
       WHERE agent_uuid = $1 AND uuid = $2`,
      [config.deviceUuid, result.sensor.uuid]
    );

    if (dbResult.rows.length === 0) {
      throw new Error('Virtual device created but not found in database');
    }

    const dbRecord = dbResult.rows[0];

    // 9. If parent is K8s virtual agent, patch Deployment
    logger.info('[VirtualDeviceManager] Checking if K8s deployment patch needed', {
      hasHelmRelease: !!agent.helm_release_name,
      hasNamespace: !!agent.k8s_namespace,
      helmRelease: agent.helm_release_name,
      namespace: agent.k8s_namespace
    });

    if (agent.helm_release_name && agent.k8s_namespace) {
      logger.info('[VirtualDeviceManager] Patching K8s deployment with new sidecar', {
        deviceUuid: config.deviceUuid,
        helmRelease: agent.helm_release_name,
        namespace: agent.k8s_namespace
      });

      // Pre-flight check: Validate namespace has sufficient quota for sidecar
      await this.validateNamespaceQuotaForSidecar(agent.k8s_namespace);

      // Update ResourceQuota before patching deployment
      // Skip quota update - Helm pre-configures ResourceQuota with adequate limits
      // await this.updateFleetQuota(agent.k8s_namespace, config.deviceUuid);

      await this.patchVirtualAgentDeployment(config.deviceUuid, agent.helm_release_name, agent.k8s_namespace);
      logger.info('[VirtualDeviceManager] K8s deployment patch completed successfully', {
        deviceUuid: config.deviceUuid
      });
    } else {
      logger.warn('[VirtualDeviceManager] Skipping K8s deployment patch - not a K8s virtual agent', {
        deviceUuid: config.deviceUuid,
        helmRelease: agent.helm_release_name,
        namespace: agent.k8s_namespace
      });
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
  async getVirtualDevices(deviceUuid: string): Promise<VirtualDevice[]> {
    const result = await query(
      `SELECT uuid, agent_uuid AS device_uuid, name, protocol, connection, data_points, metadata
       FROM endpoints
       WHERE agent_uuid = $1 
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
      // Update ResourceQuota before patching deployment
      // Skip quota update - Helm pre-configures ResourceQuota with adequate limits
      // await this.updateFleetQuota(agent.k8s_namespace, deviceUuid);

      await this.patchVirtualAgentDeployment(deviceUuid, agent?.helm_release_name, agent?.k8s_namespace);
    }
  }

  /**
   * Validate namespace has sufficient quota for adding a sidecar
   * Throws error if quota would be exceeded
   */
  private async validateNamespaceQuotaForSidecar(namespace: string): Promise<void> {
    if (!this.coreApi) {
      logger.warn('[VirtualDeviceManager] K8s coreApi not available, skipping quota validation');
      return;
    }

    try {
      const quotas = await this.coreApi.listNamespacedResourceQuota({ namespace });
      if (!quotas.items || quotas.items.length === 0) {
        logger.debug('[VirtualDeviceManager] No ResourceQuota found for namespace', { namespace });
        return; // No quota, nothing to validate
      }

      const quota = quotas.items[0];
      const hardLimits = quota.spec?.hard || {};
      const used = quota.status?.used || {};

      // Sidecar resources (OPC-UA, Modbus, etc.)
      const sidecarCpuLimit = 150; // in millicores
      const sidecarMemoryLimit = 512; // in Mi

      // Parse quota values
      const parseCpu = (val: any) => {
        const str = String(val);
        if (str.includes('m')) return parseInt(str);
        return parseInt(str) * 1000; // Convert cores to millicores
      };

      const parseMemory = (val: any) => {
        const str = String(val);
        if (str.includes('Mi')) return parseInt(str);
        if (str.includes('Gi')) return parseInt(str) * 1024;
        return parseInt(str);
      };

      const quotaHardCpu = hardLimits['limits.cpu'] ? parseCpu(hardLimits['limits.cpu']) : null;
      const quotaUsedCpu = used['limits.cpu'] ? parseCpu(used['limits.cpu']) : 0;
      const quotaHardMem = hardLimits['limits.memory'] ? parseMemory(hardLimits['limits.memory']) : null;
      const quotaUsedMem = used['limits.memory'] ? parseMemory(used['limits.memory']) : 0;

      // Check if adding sidecar would exceed quota
      if (quotaHardCpu !== null && quotaUsedCpu + sidecarCpuLimit > quotaHardCpu) {
        const error = new Error(
          `Insufficient CPU quota to add sidecar in namespace '${namespace}'. ` +
          `Sidecar requires 150m CPU limit, but only ${quotaHardCpu - quotaUsedCpu}m available. ` +
          `(Current usage: ${quotaUsedCpu}m / ${quotaHardCpu}m limit)`
        );
        (error as any).quotaError = true;
        logger.error('[VirtualDeviceManager] Quota validation failed - CPU', {
          namespace,
          sidecarRequest: '150m',
          quotaUsed: quotaUsedCpu,
          quotaHard: quotaHardCpu,
          available: quotaHardCpu - quotaUsedCpu
        });
        throw error;
      }

      if (quotaHardMem !== null && quotaUsedMem + sidecarMemoryLimit > quotaHardMem) {
        const error = new Error(
          `Insufficient memory quota to add sidecar in namespace '${namespace}'. ` +
          `Sidecar requires 512Mi memory limit, but only ${quotaHardMem - quotaUsedMem}Mi available. ` +
          `(Current usage: ${quotaUsedMem}Mi / ${quotaHardMem}Mi limit)`
        );
        (error as any).quotaError = true;
        logger.error('[VirtualDeviceManager] Quota validation failed - Memory', {
          namespace,
          sidecarRequest: '512Mi',
          quotaUsed: quotaUsedMem,
          quotaHard: quotaHardMem,
          available: quotaHardMem - quotaUsedMem
        });
        throw error;
      }

      logger.info('[VirtualDeviceManager] Quota validation passed for sidecar', {
        namespace,
        cpuAvailable: `${quotaUsedCpu}m + ${sidecarCpuLimit}m = ${quotaUsedCpu + sidecarCpuLimit}m / ${quotaHardCpu}m`,
        memAvailable: `${quotaUsedMem}Mi + ${sidecarMemoryLimit}Mi = ${quotaUsedMem + sidecarMemoryLimit}Mi / ${quotaHardMem}Mi`
      });

    } catch (error: any) {
      // Re-throw quota errors
      if (error.quotaError || error.message?.includes('quota')) {
        throw error;
      }
      // Other errors - log but don't block
      logger.warn('[VirtualDeviceManager] Could not validate quota (non-critical)', {
        namespace,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Patch K8s Deployment to sync sidecar containers with endpoints table
   * 
   * This reads all virtual devices for the agent and rebuilds the sidecar container list.
   */
  async patchVirtualAgentDeployment(deviceUuid: string, helm_release_name: string, k8s_namespace: string): Promise<void> {
    logger.info('[VirtualDeviceManager] patchVirtualAgentDeployment called', {
      deviceUuid,
      helmRelease: helm_release_name,
      namespace: k8s_namespace,
      hasK8sApi: !!this.appsApi
    });

    if (!this.appsApi) {
      logger.warn('[VirtualDeviceManager] K8s API not available, skipping deployment patch', { deviceUuid });
      return;
    }

    // Get all virtual devices for this agent
    logger.info('[VirtualDeviceManager] Fetching all virtual devices for deployment patch', {
      deviceUuid
    });

    const virtualDevices = await this.getVirtualDevices(deviceUuid);

    logger.info('[VirtualDeviceManager] Virtual devices loaded for patching', {
      deviceUuid,
      virtualDeviceCount: virtualDevices.length,
      virtualDevices: virtualDevices.map(vd => ({
        uuid: vd.uuid,
        name: vd.name,
        protocol: vd.protocol,
        connection: vd.connection,
        metadata: vd.metadata
      }))
    });
    
    // Build sidecar container specs
    logger.info('[VirtualDeviceManager] Building sidecar container specs', {
      deviceUuid,
      virtualDeviceCount: virtualDevices.length
    });

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

      const rawImage = vd.metadata.image;
      const image = rawImage?.startsWith('iotistic/')
        ? `docker.io/${rawImage}`
        : rawImage;

      logger.info('[VirtualDeviceManager] Built sidecar container spec', {
        virtualDeviceUuid: vd.uuid,
        containerName,
        image,
        port,
        envVars: envArray
      });

      return {
        name: containerName,
        image,
        env: envArray,
        ports: [{ containerPort: port }],
        securityContext: {
          privileged: false,
          allowPrivilegeEscalation: false,
          runAsNonRoot: true,
          capabilities: {
            drop: ['ALL']
          }
        },
        resources: {
          limits: {
            cpu: '150m',
            memory: '512Mi'
          },
          requests: {
            cpu: '100m',
            memory: '128Mi'
          }
        }
      };
    });

    logger.info('[VirtualDeviceManager] Sidecar containers built, fetching current deployment', {
      deviceUuid,
      sidecarCount: sidecarContainers.length,
      sidecars: sidecarContainers.map(sc => ({ name: sc.name, image: sc.image }))
    });

    try {
      // Get current deployment to preserve agent container
      logger.info('[VirtualDeviceManager] Reading current K8s deployment', {
        helmRelease: helm_release_name,
        namespace: k8s_namespace
      });

      const deployment = await this.appsApi.readNamespacedDeployment({
        name: helm_release_name,
        namespace: k8s_namespace
      });

      logger.info('[VirtualDeviceManager] Current deployment fetched', {
        helmRelease: helm_release_name,
        namespace: k8s_namespace,
        currentContainerCount: deployment.spec?.template.spec?.containers?.length || 0,
        currentContainers: deployment.spec?.template.spec?.containers?.map(c => c.name) || []
      });

      const agentContainer = deployment.spec?.template.spec?.containers?.[0];
      if (!agentContainer) {
        logger.error('[VirtualDeviceManager] Agent container not found in deployment', {
          helmRelease: helm_release_name,
          namespace: k8s_namespace
        });
        throw new Error('Agent container not found in deployment');
      }

      logger.info('[VirtualDeviceManager] Agent container found, preparing patch', {
        agentContainerName: agentContainer.name,
        sidecarCount: sidecarContainers.length
      });

      // Patch deployment with agent + sidecars
      // Use RollingUpdate with maxSurge=0 to avoid quota issues:
      // - Terminates old pod before creating new one (respects quota limits)
      // - Maintains rollout tracking and rollback capability (safer than Recreate)
      // - If new pod fails, deployment stays at 0/1 and can be easily fixed/rolled back
      const patch = {
        spec: {
          strategy: {
            type: 'RollingUpdate',
            rollingUpdate: {
              maxSurge: 0,        // Don't create extra pods during update (stays within quota)
              maxUnavailable: 1   // Allow 1 pod unavailable (enables old pod termination)
            }
          },
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

      logger.info('[VirtualDeviceManager] Applying deployment patch to K8s', {
        helmRelease: helm_release_name,
        namespace: k8s_namespace,
        totalContainers: 1 + sidecarContainers.length,
        patch: JSON.stringify(patch, null, 2)
      });

      await this.appsApi.patchNamespacedDeployment({
        name: helm_release_name,
        namespace: k8s_namespace,
        body: patch
      });

      logger.info('[VirtualDeviceManager] Virtual agent deployment patched with sidecars successfully', {
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
  private async buildContainerEnv(
    protocol: string, 
    profile: string, 
    port: number, 
    slaveCount?: number
  ): Promise<Record<string, string>> {
    const apiUrl = await this.getCloudApiUrl();

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

  private async getCloudApiUrl(): Promise<string> {
    if (process.env.CLOUD_API_URL) {
      return process.env.CLOUD_API_URL;
    }

    if (this.cloudApiUrl) {
      return this.cloudApiUrl;
    }

    if (!this.k8sConfig) {
      const fallbackUrl = 'http://api:3002';
      logger.warn('[VirtualDeviceManager] K8s config not available, using fallback API URL', {
        url: fallbackUrl
      });
      return fallbackUrl;
    }

    const namespace = process.env.NAMESPACE || 'demo';
    const customApi = this.k8sConfig.makeApiClient(k8s.CustomObjectsApi);
    const httproutes = await customApi.listNamespacedCustomObject({
      group: 'gateway.networking.k8s.io',
      version: 'v1',
      namespace,
      plural: 'httproutes'
    });

    const routes = (httproutes as any).items || [];
    for (const route of routes) {
      const backends = route.spec?.rules?.[0]?.backendRefs || [];
      for (const backend of backends) {
        if (backend.name?.includes('-api')) {
          const hostname = route.spec?.hostnames?.[0];
          if (hostname) {
            const url = `https://${hostname}`;
            this.cloudApiUrl = url;
            return url;
          }
        }
      }
    }

    throw new Error('No HTTPRoute found for API service');
  }
}
