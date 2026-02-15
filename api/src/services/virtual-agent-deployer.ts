/**
 * Virtual Agent Deployer Service
 * 
 * Handles deployment of virtual agents to Kubernetes clusters via K8s API.
 * Virtual agents are containerized agent instances deployed as single pods.
 * 
 * Key Features:
 * - Direct K8s API calls (no Helm dependency)
 * - Server-side provisioning key injection
 * - Deployment status tracking
 * - Pod lifecycle management
 */

import * as k8s from '@kubernetes/client-node';
import logger from '../utils/logger';
import { DeviceModel } from '../db/models';

export interface VirtualAgentConfig {
  deviceUuid: string;
  deviceName: string;
  provisioningKey: string; // Server-generated, injected to pod
  fleetId: string;
  namespace?: string; // defaults to 'virtual-agents'
  resourceLimits?: {
    cpu?: string; // default: '1000m'
    memory?: string; // default: '2Gi'
  };
  metadata?: {
    opcuaProfile?: string; // OPC UA profile name to load
    modbusProfile?: string; // Modbus profile name (future)
    [key: string]: any;
  };
  endpoints?: Array<{
    protocol: string;
    connection?: any;
    dataPoints?: any[];
  }>;
}

export interface DeploymentStatus {
  status: 'pending' | 'deploying' | 'running' | 'failed' | 'terminated';
  namespace?: string;
  podName?: string;
  deploymentName?: string;
  message?: string;
  error?: string;
}

export class VirtualAgentDeployer {
  private k8sConfig: k8s.KubeConfig;
  private coreApi: k8s.CoreV1Api;
  private appsApi: k8s.AppsV1Api;
  private defaultNamespace: string;
  private agentImage: string;
  private cloudApiUrl: string;
  private mqttBrokerUrl: string;

  constructor() {
    // Initialize K8s config
    this.k8sConfig = new k8s.KubeConfig();
    
    logger.info('Initializing VirtualAgentDeployer - attempting K8s config load...');
    
    let configLoaded = false;
    
    // Try in-cluster config first (when running in K8s)
    // Check if ALL required service account files exist before attempting in-cluster config
    const fs = require('fs');
    const serviceAccountPath = '/var/run/secrets/kubernetes.io/serviceaccount';
    const requiredFiles = [
      `${serviceAccountPath}/token`,
      `${serviceAccountPath}/ca.crt`,
      `${serviceAccountPath}/namespace`
    ];
    
    const allServiceAccountFilesExist = requiredFiles.every(file => {
      const exists = fs.existsSync(file);
      if (!exists) {
        logger.debug('Missing service account file', { file });
      }
      return exists;
    });
    
    if (allServiceAccountFilesExist) {
      try {
        this.k8sConfig.loadFromCluster();
        const currentContext = this.k8sConfig.getCurrentContext();
        logger.info('✅ VirtualAgentDeployer initialized with in-cluster K8s config', { currentContext });
        configLoaded = true;
      } catch (error) {
        logger.warn('All service account files exist but loadFromCluster() failed', { 
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      logger.debug('Service account files not found, skipping in-cluster config', {
        serviceAccountPath,
        missingFiles: requiredFiles.filter(f => !fs.existsSync(f))
      });
    }
    
    // Fallback to default kubeconfig (for local development)
    if (!configLoaded) {
      try {
        this.k8sConfig.loadFromDefault();
        const currentContext = this.k8sConfig.getCurrentContext();
        const currentCluster = this.k8sConfig.getCurrentCluster();
        logger.info('✅ VirtualAgentDeployer initialized with default kubeconfig', { 
          currentContext,
          clusterServer: currentCluster?.server,
          kubeconfigPath: process.env.KUBECONFIG || '~/.kube/config'
        });
        configLoaded = true;
      } catch (fallbackError) {
        logger.error('❌ Failed to initialize K8s config - Virtual agents will not work', { 
          serviceAccountFilesExist: allServiceAccountFilesExist,
          kubeconfigPath: process.env.KUBECONFIG || '~/.kube/config',
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        });
        throw new Error('Failed to initialize Kubernetes configuration - ensure K8s is enabled in Docker Desktop and kubeconfig is accessible');
      }
    }

    // Create API clients
    this.coreApi = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
    this.appsApi = this.k8sConfig.makeApiClient(k8s.AppsV1Api);

    // Load configuration from environment
    this.defaultNamespace = process.env.VIRTUAL_AGENT_NAMESPACE || 'virtual-agents';
    this.agentImage = process.env.AGENT_IMAGE || 'iotistic/agent:latest';
    this.cloudApiUrl = process.env.CLOUD_API_URL || 'https://api1.iotistica.com:443';
    
    // Use unified broker config (same as device provisioning)
    // This will be fetched async in deploy() method
    this.mqttBrokerUrl = ''; // Populated async from database

    logger.info('VirtualAgentDeployer configured', {
      defaultNamespace: this.defaultNamespace,
      agentImage: this.agentImage,
      cloudApiUrl: this.cloudApiUrl,
      note: 'MQTT broker URL fetched from database at deploy time'
    });
  }

  /**
   * Sanitize device name for Kubernetes DNS compliance
   * - Lowercase
   * - Max 63 characters
   * - Only alphanumeric and hyphens
   * - Start/end with alphanumeric
   */
  private sanitizeDnsName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-') // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '') // Remove leading/trailing hyphens
      .substring(0, 63); // Max DNS label length
  }

  /**
   * Deploy a virtual agent to Kubernetes
   */
  async deploy(config: VirtualAgentConfig): Promise<void> {
    const namespace = config.namespace || this.defaultNamespace;
    const name = this.sanitizeDnsName(config.deviceName); // Use device name instead of UUID
    const secretName = `${name}-prov-key`;

    // Fetch MQTT broker config (same config works for all if using public URL)
    const { getBrokerConfigForExternalDevice, buildBrokerUrl } = await import('../utils/mqtt-broker-config');
    const brokerConfig = await getBrokerConfigForExternalDevice(config.deviceUuid);
    
    if (!brokerConfig) {
      throw new Error('MQTT broker not configured - cannot deploy virtual agent');
    }
    
    // Set instance variable for use in createDeployment()
    this.mqttBrokerUrl = buildBrokerUrl(brokerConfig);

    logger.info('Starting virtual agent deployment', {
      deviceUuid: config.deviceUuid.substring(0, 8) + '...',
      deviceName: config.deviceName,
      namespace,
      deploymentName: name,
      mqttBroker: this.mqttBrokerUrl,
      mqttBrokerSource: brokerConfig.id === 0 ? 'environment' : `database (${brokerConfig.name})`
    });

    try {
      // Ensure namespace exists
      await this.ensureNamespace(namespace);

      // 1. Create Secret with provisioning key
      await this.createProvisioningKeySecret(namespace, secretName, config.provisioningKey);
      logger.info('Provisioning key Secret created', { namespace, secretName });

      // 2. Create Deployment
      await this.createDeployment(namespace, name, secretName, config);
      logger.info('Deployment created', { namespace, deploymentName: name });

      // 3. Update device status in database
      await DeviceModel.update(config.deviceUuid, {
        deployment_status: 'deploying',
        k8s_namespace: namespace,
        k8s_pod_name: null, // Will be set when pod is running
        helm_release_name: name
      });

      logger.info('Virtual agent deployment initiated successfully', {
        deviceUuid: config.deviceUuid.substring(0, 8) + '...',
        namespace,
        deploymentName: name
      });

    } catch (error: any) {
      logger.error('Virtual agent deployment failed', {
        deviceUuid: config.deviceUuid,
        error: error instanceof Error ? error.message : String(error),
        errorBody: error?.body ? JSON.stringify(error.body) : undefined,
        statusCode: error?.statusCode,
        response: error?.response,
        stack: error instanceof Error ? error.stack : undefined,
        fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
      });

      // Update device status to failed
      await DeviceModel.update(config.deviceUuid, {
        deployment_status: 'failed',
        status: 'offline'
      }).catch(dbError => {
        logger.error('Failed to update device status after deployment failure', {
          deviceUuid: config.deviceUuid,
          error: dbError instanceof Error ? dbError.message : String(dbError)
        });
      });

      throw error;
    }
  }

  /**
   * Ensure namespace exists, create if not
   */
  private async ensureNamespace(namespace: string): Promise<void> {
    try {
      await this.coreApi.readNamespace(namespace);
      logger.debug('Namespace already exists', { namespace });
    } catch (error: any) {
      if (error.statusCode === 404) {
        // Namespace doesn't exist, create it
        logger.info('Creating namespace', { namespace });
        await this.coreApi.createNamespace({
          metadata: {
            name: namespace,
            labels: {
              'app.kubernetes.io/managed-by': 'iotistic-api',
              'iotistica.com/namespace-type': 'virtual-agents'
            }
          }
        });
        logger.info('Namespace created', { namespace });
      } else {
        throw error;
      }
    }
  }

  /**
   * Create K8s Secret with provisioning key
   */
  private async createProvisioningKeySecret(
    namespace: string,
    secretName: string,
    provisioningKey: string
  ): Promise<void> {
    const secret: k8s.V1Secret = {
      metadata: {
        name: secretName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'iotistic-api',
          'iotistica.com/secret-type': 'provisioning-key'
        }
      },
      type: 'Opaque',
      stringData: {
        provisioningKey // Plaintext key, encrypted at rest by K8s
      }
    };

    try {
      await this.coreApi.createNamespacedSecret(namespace, secret);
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Secret already exists, replace it
        logger.warn('Secret already exists, replacing', { namespace, secretName });
        await this.coreApi.replaceNamespacedSecret(secretName, namespace, secret);
      } else {
        logger.error('Failed to create Secret', {
          namespace,
          secretName,
          error: error.message,
          errorBody: error?.body ? JSON.stringify(error.body) : undefined,
          statusCode: error?.statusCode,
          fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        });
        throw error;
      }
    }
  }

  /**
   * Create PersistentVolumeClaim for agent data (SQLite database)
   */
  private async createPersistentVolumeClaim(
    namespace: string,
    pvcName: string
  ): Promise<void> {
    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: {
        name: pvcName,
        namespace,
        labels: {
          'app.kubernetes.io/managed-by': 'iotistic-api',
          'iotistica.com/pvc-type': 'agent-data'
        }
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: {
          requests: {
            storage: process.env.VIRTUAL_AGENT_STORAGE_SIZE || '1Gi'
          }
        },
        storageClassName: process.env.VIRTUAL_AGENT_STORAGE_CLASS || undefined // use default if not specified
      }
    };

    try {
      await this.coreApi.createNamespacedPersistentVolumeClaim(namespace, pvc);
      logger.info('PersistentVolumeClaim created', { namespace, pvcName });
    } catch (error: any) {
      if (error.statusCode === 409) {
        // PVC already exists, this is OK - reuse it
        logger.debug('PersistentVolumeClaim already exists, reusing', { namespace, pvcName });
      } else {
        logger.error('Failed to create PVC', {
          namespace,
          pvcName,
          error: error.message,
          errorBody: error?.body ? JSON.stringify(error.body) : undefined,
          statusCode: error?.statusCode,
          fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        });
        throw error;
      }
    }
  }

  /**
   * Create K8s Deployment for virtual agent
   */
  private async createDeployment(
    namespace: string,
    name: string,
    secretName: string,
    config: VirtualAgentConfig
  ): Promise<void> {
    // Create PVC for SQLite database persistence
    await this.createPersistentVolumeClaim(namespace, `${name}-data`);

    const deployment: k8s.V1Deployment = {
      metadata: {
        name,
        namespace,
        labels: {
          app: 'virtual-agent',
          'app.kubernetes.io/name': 'virtual-agent',
          'app.kubernetes.io/managed-by': 'iotistic-api',
          'iotistica.com/device-uuid': config.deviceUuid,
          'iotistica.com/fleet-id': config.fleetId
        }
      },
      spec: {
        replicas: 1,
        selector: {
          matchLabels: {
            app: name
          }
        },
        template: {
          metadata: {
            labels: {
              app: name,
              'iotistica.com/device-uuid': config.deviceUuid
            }
          },
          spec: {
            // Security: Run as non-root user (virtual agents don't need Docker socket or VPN)
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000, // agentuser from Dockerfile
              runAsGroup: 1000, // agentgroup from Dockerfile
              fsGroup: 1000, // Ensure PVC files are owned by agentgroup
              seccompProfile: {
                type: 'RuntimeDefault'
              }
            },
            containers: [
              {
                name: 'agent',
                image: this.agentImage,
                imagePullPolicy: process.env.AGENT_IMAGE_PULL_POLICY as any || 'Always',
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: false, // Agent needs to write to /app/data
                  runAsNonRoot: true,
                  capabilities: {
                    drop: ['ALL']
                  }
                },
                env: [
                  { name: 'DEVICE_UUID', value: config.deviceUuid },
                  { name: 'FLEET_ID', value: config.fleetId },
                  { name: 'REQUIRE_PROVISIONING', value: 'true' },
                  { name: 'IS_VIRTUAL_AGENT', value: 'true' },
                  { name: 'CLOUD_API_ENDPOINT', value: this.cloudApiUrl },
                  { name: 'MQTT_BROKER_URL', value: this.mqttBrokerUrl },
                  { name: 'FIREWALL_ENABLED', value: 'false' },
                  {
                    name: 'PROVISIONING_KEY',
                    valueFrom: {
                      secretKeyRef: {
                        name: secretName,
                        key: 'provisioningKey'
                      }
                    }
                  }
                ],
                resources: {
                  requests: {
                    cpu: process.env.VIRTUAL_AGENT_CPU_REQUEST || '200m',
                    memory: process.env.VIRTUAL_AGENT_MEMORY_REQUEST || '512Mi'
                  },
                  limits: {
                    cpu: config.resourceLimits?.cpu || process.env.VIRTUAL_AGENT_CPU_LIMIT || '1000m',
                    memory: config.resourceLimits?.memory || process.env.VIRTUAL_AGENT_MEMORY_LIMIT || '2Gi'
                  }
                },
                volumeMounts: [
                  {
                    name: 'agent-data',
                    mountPath: '/app/data'
                  }
                ]
              },
              ...this.buildSimulatorSidecars(config)
            ],
            volumes: [
              {
                name: 'agent-data',
                persistentVolumeClaim: {
                  claimName: `${name}-data`
                }
              }
            ],
            restartPolicy: 'Always'
          }
        }
      }
    };

    try {
      await this.appsApi.createNamespacedDeployment(namespace, deployment);
    } catch (error: any) {
      if (error.statusCode === 409) {
        // Deployment already exists, replace it
        logger.warn('Deployment already exists, replacing', { namespace, name });
        await this.appsApi.replaceNamespacedDeployment(name, namespace, deployment);
      } else {
        logger.error('Failed to create deployment', {
          namespace,
          name,
          error: error.message,
          errorBody: error?.body ? JSON.stringify(error.body) : undefined,
          statusCode: error?.statusCode,
          fullError: JSON.stringify(error, Object.getOwnPropertyNames(error))
        });
        throw error;
      }
    }
  }

  /**
   * Get deployment status
   */
  async getStatus(deviceUuid: string): Promise<DeploymentStatus> {
    try {
      const device = await DeviceModel.getByUuid(deviceUuid);
      if (!device) {
        return {
          status: 'failed',
          error: 'Device not found'
        };
      }

      if (device.device_type !== 'virtual') {
        return {
          status: 'failed',
          error: 'Not a virtual agent'
        };
      }

      const namespace = device.k8s_namespace || this.defaultNamespace;
      const deploymentName = device.helm_release_name || this.sanitizeDnsName(device.device_name);

      // Get deployment
      const deployment = await this.appsApi.readNamespacedDeployment(deploymentName, namespace);

      // Get pods for this deployment
      const podList = await this.coreApi.listNamespacedPod(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `app=${deploymentName}`
      );

      const pod = podList.body.items[0];
      const podName = pod?.metadata?.name;

      // Determine status
      let status: DeploymentStatus['status'] = 'deploying';
      let message = 'Deployment in progress';

      if (pod) {
        const phase = pod.status?.phase;
        const conditions = pod.status?.conditions || [];
        
        if (phase === 'Running' && conditions.some(c => c.type === 'Ready' && c.status === 'True')) {
          status = 'running';
          message = 'Pod is running and ready';
        } else if (phase === 'Failed' || phase === 'Unknown') {
          status = 'failed';
          message = `Pod in ${phase} phase`;
        }
      }

      return {
        status,
        namespace,
        podName,
        deploymentName,
        message
      };

    } catch (error: any) {
      logger.error('Failed to get deployment status', {
        deviceUuid,
        error: error instanceof Error ? error.message : String(error)
      });

      return {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Cleanup provisioning key after successful provisioning
   * Idempotent - safe to call multiple times
   * Returns immediately if Secret already deleted (cheap check)
   */
  async cleanupProvisioningKey(deviceUuid: string): Promise<void> {
    try {
      const device = await DeviceModel.getByUuid(deviceUuid);
      if (!device) {
        throw new Error('Device not found');
      }

      if (device.device_type !== 'virtual') {
        throw new Error('Not a virtual agent');
      }

      const namespace = device.k8s_namespace || this.defaultNamespace;
      const name = device.helm_release_name || this.sanitizeDnsName(device.device_name);
      const secretName = `${name}-prov-key`;

      // OPTIMIZATION: Check if Secret exists first (cheap check)
      // If already deleted, cleanup is done - exit early
      try {
        await this.coreApi.readNamespacedSecret(secretName, namespace);
        // Secret exists - proceed with cleanup
      } catch (error: any) {
        if (error.statusCode === 404) {
          // Secret already deleted - cleanup already done, exit early
          logger.debug('Provisioning Secret already deleted - cleanup already complete', {
            deviceUuid: deviceUuid.substring(0, 8) + '...',
            namespace,
            secretName
          });
          return; // Early exit - nothing to do
        }
        // Other error - rethrow
        throw error;
      }

      logger.info('Cleaning up provisioning key after successful provisioning', {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        namespace,
        deploymentName: name
      });

      // 1. Delete the provisioning Secret
      try {
        await this.coreApi.deleteNamespacedSecret(secretName, namespace);
        logger.info('Provisioning Secret deleted', { namespace, secretName });
      } catch (error: any) {
        if (error.statusCode === 404) {
          logger.debug('Provisioning Secret already deleted (race condition)', { namespace, secretName });
        } else {
          logger.error('Failed to delete provisioning Secret', {
            namespace,
            secretName,
            error: error instanceof Error ? error.message : String(error)
          });
          throw error;
        }
      }

      // 2. Patch deployment to remove PROVISIONING_KEY env var
      try {
        const deployment = await this.appsApi.readNamespacedDeployment(name, namespace);
        const agentContainer = deployment.body.spec?.template.spec?.containers.find(c => c.name === 'agent');
        
        if (agentContainer && agentContainer.env) {
          // Check if PROVISIONING_KEY still exists
          const hasProvKeyEnv = agentContainer.env.some(e => e.name === 'PROVISIONING_KEY');
          
          if (hasProvKeyEnv) {
            // Remove PROVISIONING_KEY from env array
            agentContainer.env = agentContainer.env.filter(e => e.name !== 'PROVISIONING_KEY');
            
            // Patch deployment
            await this.appsApi.patchNamespacedDeployment(
              name,
              namespace,
              deployment.body,
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              { headers: { 'Content-Type': 'application/merge-patch+json' } }
            );
            
            logger.info('Deployment patched to remove PROVISIONING_KEY env var', { namespace, deploymentName: name });
          } else {
            logger.debug('PROVISIONING_KEY already removed from deployment', { namespace, deploymentName: name });
          }
        }
      } catch (error: any) {
        logger.error('Failed to patch deployment', {
          namespace,
          name,
          error: error instanceof Error ? error.message : String(error)
        });
        // Don't throw - Secret deletion is more important than deployment patch
      }

      logger.info('Provisioning key cleanup completed successfully', {
        deviceUuid: deviceUuid.substring(0, 8) + '...'
      });

    } catch (error) {
      logger.error('Failed to cleanup provisioning key', {
        deviceUuid,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Destroy a virtual agent (delete deployment and secret)
   */
  async destroy(deviceUuid: string): Promise<void> {
    try {
      const device = await DeviceModel.getByUuid(deviceUuid);
      if (!device) {
        throw new Error('Device not found');
      }

      if (device.device_type !== 'virtual') {
        throw new Error('Not a virtual agent');
      }

      const namespace = device.k8s_namespace || this.defaultNamespace;
      const name = device.helm_release_name || this.sanitizeDnsName(device.device_name);
      const secretName = `${name}-prov-key`;

      logger.info('Destroying virtual agent', {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        namespace,
        deploymentName: name
      });

      // Delete deployment
      try {
        await this.appsApi.deleteNamespacedDeployment(
          name,
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { propagationPolicy: 'Foreground' }
        );
        logger.info('Deployment deleted', { namespace, name });
      } catch (error: any) {
        if (error.statusCode !== 404) {
          throw error;
        }
        logger.warn('Deployment not found, skipping', { namespace, name });
      }

      // Delete secret
      try {
        await this.coreApi.deleteNamespacedSecret(secretName, namespace);
        logger.info('Secret deleted', { namespace, secretName });
      } catch (error: any) {
        if (error.statusCode !== 404) {
          throw error;
        }
        logger.warn('Secret not found, skipping', { namespace, secretName });
      }

      // Delete PVC
      const pvcName = `${name}-data`;
      try {
        await this.coreApi.deleteNamespacedPersistentVolumeClaim(pvcName, namespace);
        logger.info('PersistentVolumeClaim deleted', { namespace, pvcName });
      } catch (error: any) {
        if (error.statusCode !== 404) {
          throw error;
        }
        logger.warn('PersistentVolumeClaim not found, skipping', { namespace, pvcName });
      }

      // Update device status
      await DeviceModel.update(deviceUuid, {
        deployment_status: 'terminated',
        status: 'offline',
        is_online: false,
        k8s_pod_name: null
      });

      logger.info('Virtual agent destroyed successfully', {
        deviceUuid: deviceUuid.substring(0, 8) + '...'
      });

    } catch (error) {
      logger.error('Failed to destroy virtual agent', {
        deviceUuid,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }

  /**
   * Build simulator sidecar containers based on device endpoints
   */
  private buildSimulatorSidecars(config: VirtualAgentConfig): any[] {
    const sidecars: any[] = [];
    
    // Get all OPC UA endpoints
    const opcuaEndpoints = config.endpoints?.filter(ep => ep.protocol === 'opcua') || [];
    
    // Create a separate OPC UA simulator container for each endpoint
    opcuaEndpoints.forEach((endpoint, index) => {
      const port = 4840 + index; // Assign unique ports: 4840, 4841, 4842, etc.
      const webPort = 5002 + index; // Unique web ports: 5002, 5003, 5004, etc.
      const containerName = `opcua-sim-${port}`;
      
      // Get profile from endpoint connection or config metadata
      const opcuaProfile = (endpoint.connection as any)?.profile || 
                          config.metadata?.opcuaProfile || 
                          this.getOPCUAProfileForDevice(config);
      
      sidecars.push({
        name: containerName,
        image: process.env.OPCUA_SIMULATOR_IMAGE || 'iotistic/opcua-simulator:latest',
        imagePullPolicy: process.env.OPCUA_SIMULATOR_PULL_POLICY as any || 'Always',
        env: [
          { name: 'PORT', value: port.toString() }, // CRITICAL: Pass unique port
          { name: 'PROFILE', value: opcuaProfile },
          { name: 'API_URL', value: this.cloudApiUrl },
          { name: 'LOG_LEVEL', value: process.env.LOG_LEVEL || 'INFO' }
        ],
        ports: [
          { containerPort: port, protocol: 'TCP', name: 'opcua' }
        ],
        readinessProbe: {
          tcpSocket: {
            port: port
          },
          initialDelaySeconds: 5,
          periodSeconds: 10,
          timeoutSeconds: 5,
          failureThreshold: 3
        },
        securityContext: {
          allowPrivilegeEscalation: false,
          runAsNonRoot: true,
          capabilities: {
            drop: ['ALL']
          }
        },
        resources: {
          requests: {
            cpu: '100m',
            memory: '128Mi'
          },
          limits: {
            cpu: '500m',
            memory: '512Mi'
          }
        }
      });
      
      logger.info('Added OPC UA simulator sidecar', { 
        deviceUuid: config.deviceUuid,
        containerName,
        port,
        profile: opcuaProfile,
        endpointIndex: index
      });
    });
    
    // Future: Add Modbus, BACnet, etc. simulators
    
    return sidecars;
  }

  /**
   * Extract OPC UA profile name from device configuration
   */
  private getOPCUAProfileForDevice(config: VirtualAgentConfig): string {
    // Check if device metadata specifies profile
    if (config.metadata?.opcuaProfile) {
      return config.metadata.opcuaProfile;
    }
    
    // Default to device name sanitized
    const sanitized = config.deviceName?.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || 'default';
    
    logger.info('Using default OPC UA profile name', { 
      deviceUuid: config.deviceUuid,
      profile: sanitized 
    });
    
    return sanitized;
  }

  /**
   * Create fleet namespace with ResourceQuota
   */
  async createFleetNamespace(params: {
    fleet_id: string;
    fleet_name: string;
    customer_id: string;
    agent_count: number;
    devices_per_agent: number;
  }): Promise<string> {
    const namespace = `fleet-${params.fleet_id.replace('fleet-', '')}`;
    
    try {
      // Create namespace
      await this.coreApi.createNamespace({
        metadata: {
          name: namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'iotistic-api',
            'iotistica.com/fleet-id': params.fleet_id,
            'iotistica.com/fleet-name': params.fleet_name,
            'iotistica.com/fleet-type': 'virtual',
            'iotistica.com/customer-id': params.customer_id
          },
          annotations: {
            'iotistica.com/agent-count': params.agent_count.toString(),
            'iotistica.com/devices-per-agent': params.devices_per_agent.toString(),
            'iotistica.com/total-devices': (params.agent_count * params.devices_per_agent).toString()
          }
        }
      });
      
      logger.info('Fleet namespace created', { namespace, fleet_id: params.fleet_id });
      
      // Calculate resource quotas based on agent count
      // Each agent needs: 256Mi memory, 0.25 CPU
      const totalMemory = `${params.agent_count * 256}Mi`;
      const totalCpu = `${params.agent_count * 0.25}`;
      
      // Create ResourceQuota
      await this.coreApi.createNamespacedResourceQuota(namespace, {
        metadata: {
          name: 'fleet-quota',
          labels: {
            'iotistica.com/fleet-id': params.fleet_id
          }
        },
        spec: {
          hard: {
            'requests.cpu': totalCpu,
            'requests.memory': totalMemory,
            'limits.cpu': `${params.agent_count * 0.5}`,  // 2x burst
            'limits.memory': `${params.agent_count * 512}Mi`,  // 2x burst
            'pods': params.agent_count.toString()
          }
        }
      });
      
      logger.info('Fleet ResourceQuota created', {
        namespace,
        fleet_id: params.fleet_id,
        quotas: { cpu: totalCpu, memory: totalMemory, pods: params.agent_count }
      });
      
      return namespace;
      
    } catch (error: any) {
      logger.error('Failed to create fleet namespace', {
        fleet_id: params.fleet_id,
        namespace,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }
}

// Export singleton instance
export const virtualAgentDeployer = new VirtualAgentDeployer();
