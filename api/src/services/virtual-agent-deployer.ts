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
  fleetUuid?: string | null; // Optional, null for unassigned devices
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
  private coreApi: k8s.CoreV1Api | null = null;
  private appsApi: k8s.AppsV1Api | null = null;
  private rbacApi: k8s.RbacAuthorizationV1Api | null = null;
  private defaultNamespace: string;
  private agentImage: string;
  private cloudApiUrl: string;
  private mqttBrokerUrl: string;
  private k8sAvailable: boolean = false;
  private apiServiceAccountNamespace: string = 'demo'; // Will be used for RoleBinding

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
        logger.warn('⚠️ K8s config not available - Virtual agent deployment disabled', { 
          serviceAccountFilesExist: allServiceAccountFilesExist,
          kubeconfigPath: process.env.KUBECONFIG || '~/.kube/config',
          error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          hint: 'This is normal for local development without K8s. Virtual agents will not be deployable.'
        });
        this.k8sAvailable = false;
        // Don't throw - just mark K8s as unavailable
      }
    }

    // Create API clients only if K8s is available
    if (configLoaded) {
      this.coreApi = this.k8sConfig.makeApiClient(k8s.CoreV1Api);
      this.appsApi = this.k8sConfig.makeApiClient(k8s.AppsV1Api);
      this.rbacApi = this.k8sConfig.makeApiClient(k8s.RbacAuthorizationV1Api);
      this.k8sAvailable = true;  // Tentatively true, will verify on first use
    }

    // Load configuration from environment
    this.defaultNamespace = process.env.VIRTUAL_AGENT_NAMESPACE || 'virtual-agents';
    this.apiServiceAccountNamespace = process.env.NAMESPACE || process.env.API_NAMESPACE || 'demo'; // Where iotistic-api SA is deployed
    this.agentImage = process.env.AGENT_IMAGE || 'docker.io/iotistic/agent:latest';
    
    // Cloud API URL: Try to auto-discover from K8s HTTPRoute, fall back to env var or default
    this.discoverCloudApiUrl().then((url) => {
      this.cloudApiUrl = url;
      logger.info('Cloud API URL discovered', { cloudApiUrl: this.cloudApiUrl });
    }).catch((err) => {
      logger.warn('Failed to discover Cloud API URL from K8s, using default', { 
        error: err.message,
        cloudApiUrl: this.cloudApiUrl 
      });
    });
    
    // Use unified broker config (same as device provisioning)
    // This will be fetched async in deploy() method
    this.mqttBrokerUrl = ''; // Populated async from database

    logger.info('VirtualAgentDeployer configured', {
      defaultNamespace: this.defaultNamespace,
      agentImage: this.agentImage,
      cloudApiUrl: process.env.CLOUD_API_URL || '(not configured)',
      note: 'Cloud API URL from CLOUD_API_URL env var (Helm: api.cloudApiUrl), MQTT broker URL fetched from database'
    });
  }

  /**
   * Get Cloud API URL from environment variable
   * Must be configured via CLOUD_API_URL env var (set in Helm values under api.cloudApiUrl)
   * Examples:
   *   - In-cluster DNS: http://demo-release-iotistic-api.demo.svc.cluster.local:3002
   *   - External hostname: https://api.iotistica.com
   */
  private async discoverCloudApiUrl(): Promise<string> {
    if (!process.env.CLOUD_API_URL) {
      throw new Error(
        'CLOUD_API_URL environment variable not set. ' +
        'Configure via Helm values: api.cloudApiUrl ' +
        '(e.g., http://demo-release-iotistic-api.demo.svc.cluster.local:3002)'
      );
    }

    logger.info('Using CLOUD_API_URL from environment', { url: process.env.CLOUD_API_URL });
    return process.env.CLOUD_API_URL;
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
    // Check if K8s is available
    if (!this.k8sAvailable) {
      throw new Error('Kubernetes is not configured. Virtual agent deployment is disabled. Enable Kubernetes in Docker Desktop or provide a valid kubeconfig to deploy virtual agents.');
    }
    
    const namespace = config.namespace || this.defaultNamespace;
    const name = this.sanitizeDnsName(config.deviceName); // Use device name instead of UUID
    const secretName = `${name}-prov-key`;

    // Ensure API URL discovery completes before creating sidecars
    try {
      this.cloudApiUrl = await this.discoverCloudApiUrl();
      logger.info('Using discovered Cloud API URL for deployment', {
        cloudApiUrl: this.cloudApiUrl
      });
    } catch (error) {
      logger.warn('Proceeding with existing Cloud API URL', {
        cloudApiUrl: this.cloudApiUrl,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Query fleet configuration if fleetUuid provided
    // This ensures pod resources match the fleet quota
    let fleetConfig = null;
    if (config.fleetUuid) {
      const { query } = await import('../db/connection');
      const result = await query(
        'SELECT agent_count, devices_per_agent, k8s_namespace FROM fleets WHERE fleet_uuid = $1',
        [config.fleetUuid]
      );
      if (result.rows.length > 0) {
        fleetConfig = result.rows[0];
        logger.info('Fleet configuration loaded', {
          fleetUuid: config.fleetUuid,
          agentCount: fleetConfig.agent_count,
          devicesPerAgent: fleetConfig.devices_per_agent
        });
      }
    }

    // Calculate per-agent resources based on fleet quota formula
    // Fleet quota allocates per agent: 256Mi memory request, 0.25 CPU request
    // Limits: 512Mi memory, 0.5 CPU
    // Override only if not explicitly set in config.resourceLimits
    if (!config.resourceLimits) {
      config.resourceLimits = {};
    }
    config.resourceLimits.cpu = config.resourceLimits.cpu || '500m';   // 0.5 CPU limit
    config.resourceLimits.memory = config.resourceLimits.memory || '512Mi'; // 512Mi memory limit

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
      await this.createDeployment(namespace, name, secretName, config, this.cloudApiUrl);
      logger.info('Deployment created', { namespace, deploymentName: name });

      // 3. Check for deployment errors (quota, image pull, etc.)
      await this.checkDeploymentErrors(namespace, name, config.deviceUuid);

      // 4. Update device status in database
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
    config: VirtualAgentConfig,
    cloudApiUrl: string
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
          'iotistica.com/fleet-uuid': config.fleetUuid || 'unassigned'
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
            hostNetwork: false, // Required by Kyverno policy: no host network in fleet namespaces
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
                  privileged: false, // Required by Kyverno policy
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: false, // Agent needs to write to /app/data
                  runAsNonRoot: true,
                  capabilities: {
                    drop: ['ALL']
                  }
                },
                env: [
                  { name: 'DEVICE_UUID', value: config.deviceUuid },
                  { name: 'FLEET_UUID', value: config.fleetUuid || 'unassigned' },
                  { name: 'REQUIRE_PROVISIONING', value: 'true' },
                  { name: 'IS_VIRTUAL_AGENT', value: 'true' },
                  { name: 'CLOUD_API_ENDPOINT', value: cloudApiUrl },
                  { name: 'MQTT_BROKER_URL', value: this.mqttBrokerUrl },
                  { name: 'FIREWALL_ENABLED', value: 'false' },
                  {
                    name: 'PROVISIONING_KEY',
                    valueFrom: {
                      secretKeyRef: {
                        name: secretName,
                        key: 'provisioningKey',
                        optional: true  // Allow pod to restart after provisioning key is deleted
                      }
                    }
                  }
                ],
                resources: {
                  requests: {
                    cpu: process.env.VIRTUAL_AGENT_CPU_REQUEST || '250m',   // 0.25 cores per agent
                    memory: process.env.VIRTUAL_AGENT_MEMORY_REQUEST || '256Mi' // 256Mi per agent
                  },
                  limits: {
                    cpu: config.resourceLimits?.cpu || process.env.VIRTUAL_AGENT_CPU_LIMIT || '500m',   // 0.5 cores burst
                    memory: config.resourceLimits?.memory || process.env.VIRTUAL_AGENT_MEMORY_LIMIT || '512Mi' // 512Mi burst
                  }
                },
                volumeMounts: [
                  {
                    name: 'agent-data',
                    mountPath: '/app/data'
                  }
                ]
              },
              ...this.buildSimulatorSidecars(config, cloudApiUrl)
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
   * Check for deployment errors by examining ReplicaSet and pod events
   * This catches quota errors, image pull failures, etc.
   */
  private async checkDeploymentErrors(namespace: string, deploymentName: string, deviceUuid: string): Promise<void> {
    try {
      // Wait a moment for ReplicaSet to be created
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get events in the namespace
      const events = await this.coreApi.listNamespacedEvent(
        namespace,
        undefined,
        undefined,
        undefined,
        undefined,
        `involvedObject.kind=ReplicaSet`
      );

      // Look for errors related to this deployment
      const deploymentEvents = events.body.items.filter(event => 
        event.involvedObject?.name?.startsWith(deploymentName) &&
        event.type === 'Warning'
      );

      if (deploymentEvents.length > 0) {
        const recentErrors = deploymentEvents
          .slice(-3) // Last 3 errors
          .map(e => `${e.reason}: ${e.message}`);

        // Check for quota errors specifically
        const quotaError = deploymentEvents.find(e => 
          e.reason === 'FailedCreate' && e.message?.includes('exceeded quota')
        );

        if (quotaError) {
          logger.error('Virtual agent deployment failed due to resource quota', {
            deviceUuid,
            namespace,
            deploymentName,
            error: quotaError.message,
            allErrors: recentErrors
          });
          
          // Update device with error details
          await DeviceModel.update(deviceUuid, {
            deployment_status: 'failed',
            status: 'offline'
          }).catch(() => {});

          throw new Error(`Resource quota exceeded: ${quotaError.message}`);
        }

        // Log other warnings but don't fail immediately
        logger.warn('Deployment warnings detected', {
          deviceUuid,
          namespace,
          deploymentName,
          warnings: recentErrors
        });
      } else {
        logger.info('No deployment errors detected', { namespace, deploymentName });
      }
    } catch (error: any) {
      // If this is our thrown quota error, re-throw it
      if (error.message?.includes('Resource quota exceeded')) {
        throw error;
      }
      // Otherwise just log and continue - event checking is best-effort
      logger.warn('Could not check deployment events', {
        namespace,
        deploymentName,
        error: error instanceof Error ? error.message : String(error)
      });
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
   * Restart a virtual agent by deleting its pod(s)
   * Kubernetes Deployment controller will automatically recreate the pod(s)
   */
  async restart(deviceUuid: string): Promise<void> {
    try {
      const device = await DeviceModel.getByUuid(deviceUuid);
      if (!device) {
        throw new Error('Device not found');
      }

      if (device.device_type !== 'virtual') {
        throw new Error('Not a virtual agent');
      }

      const namespace = device.k8s_namespace || this.defaultNamespace;
      const deploymentName = device.helm_release_name || this.sanitizeDnsName(device.device_name);

      logger.info('Restarting virtual agent', {
        deviceUuid: deviceUuid.substring(0, 8) + '...',
        deviceName: device.device_name,
        namespace,
        deploymentName
      });

      // Delete pod(s) - Deployment controller will automatically recreate them
      try {
        const podList = await this.coreApi.listNamespacedPod(
          namespace,
          undefined,
          undefined,
          undefined,
          undefined,
          `app=${deploymentName}`
        );

        const pods = podList.body.items;
        
        if (pods.length === 0) {
          logger.warn('No pods found for virtual agent', {
            deviceUuid: deviceUuid.substring(0, 8) + '...',
            namespace,
            deploymentName
          });
          throw new Error('No pods found for this virtual agent');
        }

        for (const pod of pods) {
          const podName = pod.metadata?.name;
          if (podName) {
            await this.coreApi.deleteNamespacedPod(podName, namespace);
            logger.info('Pod deleted (will be recreated by Deployment)', {
              deviceUuid: deviceUuid.substring(0, 8) + '...',
              podName,
              namespace
            });
          }
        }

        // Update device status to deploying (will be updated by agent when it comes back online)
        await DeviceModel.update(deviceUuid, {
          deployment_status: 'deploying',
          status: 'offline'
        });

        logger.info('Virtual agent restart initiated successfully', {
          deviceUuid: deviceUuid.substring(0, 8) + '...',
          podsDeleted: pods.length
        });

      } catch (error: any) {
        if (error.statusCode === 404) {
          throw new Error('Pod not found - virtual agent may not be deployed');
        }
        throw error;
      }

    } catch (error) {
      logger.error('Failed to restart virtual agent', {
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
  private buildSimulatorSidecars(config: VirtualAgentConfig, cloudApiUrl: string): any[] {
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
        image: process.env.OPCUA_SIMULATOR_IMAGE || 'docker.io/iotistic/opcua-simulator:latest',
        imagePullPolicy: process.env.OPCUA_SIMULATOR_PULL_POLICY as any || 'Always',
        env: [
          { name: 'PORT', value: port.toString() }, // CRITICAL: Pass unique port
          { name: 'PROFILE', value: opcuaProfile },
          { name: 'API_URL', value: cloudApiUrl },
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
          privileged: false, // Required by Kyverno policy
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
            cpu: '150m',
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
   * Create per-namespace RoleBinding to predefined fleet-namespace-manager role
   * 
   * SAFER PATTERN: Instead of creating arbitrary Roles, we bind a predefined
   * ClusterRole that contains safe, admin-approved permissions.
   * 
   * This limits the API's ability to escalate privileges:
   * - API cannot define arbitrary permissions
   * - API can only use permissions from predefined role
   * - If API is compromised, attacker is limited to safe permission set
   */
  private async createFleetManagementRoleBinding(namespace: string, fleetUuid: string): Promise<void> {
    if (!this.rbacApi) {
      logger.warn('RBAC API not available, skipping fleet management rolebinding creation', { namespace });
      return;
    }

    try {
      // Create RoleBinding to bind iotistic-api SA to the predefined fleet-namespace-manager role
      // This role is defined in the RBAC template and contains safe, approved permissions
      const predefinedRole = 'iotistic-fleet-namespace-manager'; // Must match template ClusterRole name
      
      const roleBinding = {
        apiVersion: 'rbac.authorization.k8s.io/v1',
        kind: 'RoleBinding',
        metadata: {
          name: 'fleet-manager-binding',
          namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'iotistic-api',
            'iotistica.com/fleet-uuid': fleetUuid
          }
        },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'ClusterRole',  // Bind to predefined ClusterRole (not arbitrary Role)
          name: predefinedRole
        },
        subjects: [
          {
            kind: 'ServiceAccount',
            name: 'iotistic-api',
            namespace: this.apiServiceAccountNamespace
          }
        ]
      };

      await this.rbacApi.createNamespacedRoleBinding(namespace, roleBinding as any);
      logger.info('Fleet management RoleBinding created', { 
        namespace, 
        fleetUuid,
        bindingTo: `${this.apiServiceAccountNamespace}/iotistic-api`,
        roleRefName: predefinedRole,
        pattern: 'Binds predefined ClusterRole (safe permissions defined by admins)'
      });

    } catch (error: any) {
      // Check if rolebinding already exists
      if (error?.statusCode === 409 || error?.body?.reason === 'AlreadyExists') {
        logger.debug('Fleet management RoleBinding already exists', { namespace, fleetUuid });
        return;
      }

      logger.error('Failed to create fleet management RoleBinding', {
        namespace,
        fleetUuid,
        error: error instanceof Error ? error.message : String(error),
        statusCode: error?.statusCode
      });
      // Don't throw - fleet can still function, just with existing binding
    }
  }

  /**
   * Create fleet namespace with ResourceQuota
   * 
   * Resource calculation accounting for protocol simulator sidecars
   * Supports: OPC UA, Modbus, BACnet, and other protocol simulators
   * 
   * Per-agent resource model:
   *   - Agent container: 250m CPU, 256Mi memory (request), 500m CPU, 512Mi memory (limit)
   *   - Per simulator/endpoint (1 per device): 100m CPU, 128Mi memory (request), 300m CPU, 512Mi memory (limit)
   * 
   * Resource calculation uses devices_per_agent to estimate simulator count
   * (assumes 1 simulator per device = 1 protocol endpoint per device)
   */
  async createFleetNamespace(params: {
    fleet_uuid: string;
    fleet_name: string;
    customer_id: string;
    agent_count: number;
    devices_per_agent: number;
  }): Promise<string> {
    // Check if K8s is available
    if (!this.k8sAvailable || !this.coreApi) {
      throw new Error('Kubernetes is not configured or unavailable. Virtual fleet namespaces require K8s cluster access.');
    }

    const namespace = `fleet-${params.fleet_uuid.substring(0, 8)}`; // Use first 8 chars of UUID for namespace
    
    // Use devices_per_agent to estimate number of simulators per agent
    // (each device typically has 1 protocol endpoint: OPC UA, Modbus, BACnet, etc)
    const simulatorsPerAgent = params.devices_per_agent;
    
    try {
      // Create namespace
      await this.coreApi.createNamespace({
        metadata: {
          name: namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'iotistic-api',
            'iotistica.com/fleet-uuid': params.fleet_uuid,
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
      
      logger.info('Fleet namespace created', { namespace, fleet_uuid: params.fleet_uuid });
      
      // Calculate resource quotas accounting for agent + sidecar containers
      // Agent: 250m request, 500m limit
      // Sidecar (OPC-UA, etc): 100m request, 150m limit (respects 800m pod max)
      // Total per agent: 350m request, 650m limit
      
      const agentCpuRequest = 0.25;        // 250m
      const agentMemoryRequest = 256;      // 256Mi
      const agentCpuLimit = 0.5;           // 500m
      const agentMemoryLimit = 512;        // 512Mi
      
      const simulatorCpuRequest = 0.1;     // 100m per simulator
      const simulatorMemoryRequest = 128;  // 128Mi per simulator
      const simulatorCpuLimit = 0.15;      // 150m per simulator (reduced to fit 800m pod limit)
      const simulatorMemoryLimit = 512;    // 512Mi per simulator
      
      // Total per agent = agent + (simulator * devices_per_agent)
      const cpuRequestPerAgent = agentCpuRequest + (simulatorCpuRequest * simulatorsPerAgent);
      const memoryRequestPerAgent = agentMemoryRequest + (simulatorMemoryRequest * simulatorsPerAgent);
      const cpuLimitPerAgent = agentCpuLimit + (simulatorCpuLimit * simulatorsPerAgent);
      const memoryLimitPerAgent = agentMemoryLimit + (simulatorMemoryLimit * simulatorsPerAgent);
      
      // Calculate totals based on configured agent count
      const totalCpuRequest = params.agent_count * cpuRequestPerAgent;
      const totalMemoryRequest = params.agent_count * memoryRequestPerAgent;
      const totalCpuLimit = params.agent_count * cpuLimitPerAgent;
      const totalMemoryLimit = params.agent_count * memoryLimitPerAgent;
      
      // Create ResourceQuota with calculated resources
      await this.coreApi.createNamespacedResourceQuota(namespace, {
        metadata: {
          name: 'fleet-quota',
          labels: {
            'iotistica.com/fleet-uuid': params.fleet_uuid
          }
        },
        spec: {
          hard: {
            'requests.cpu': `${totalCpuRequest}`,
            'requests.memory': `${totalMemoryRequest}Mi`,
            'limits.cpu': `${totalCpuLimit}`,
            'limits.memory': `${totalMemoryLimit}Mi`,
            'pods': params.agent_count.toString()
          }
        }
      });
      
      logger.info('Fleet ResourceQuota created based on devices_per_agent estimate', {
        namespace,
        fleet_uuid: params.fleet_uuid,
        fleetConfig: {
          agentCount: params.agent_count,
          devicesPerAgent: params.devices_per_agent,
          totalDevices: params.agent_count * params.devices_per_agent,
          estimatedSimulatorsPerAgent: simulatorsPerAgent
        },
        perAgentResources: {
          agentContainer: { cpuRequest: `${agentCpuRequest * 1000}m`, memoryRequest: `${agentMemoryRequest}Mi` },
          perSimulator: { cpuRequest: `${simulatorCpuRequest * 1000}m`, memoryRequest: `${simulatorMemoryRequest}Mi` },
          totalPerAgent: { 
            cpuRequest: `${cpuRequestPerAgent * 1000}m`, 
            memoryRequest: `${memoryRequestPerAgent}Mi` 
          },
          supportedProtocols: ['OPC_UA', 'Modbus', 'BACnet', 'etc']
        },
        totalQuotas: {
          cpuRequest: `${totalCpuRequest}`,
          memoryRequest: `${totalMemoryRequest}Mi`,
          cpuLimit: `${totalCpuLimit}`,
          memoryLimit: `${totalMemoryLimit}Mi`,
          pods: params.agent_count
        }
      });

      // Create RoleBinding to predefined fleet-namespace-manager role
      // SAFER PATTERN: API binds to admin-defined role instead of creating arbitrary roles
      await this.createFleetManagementRoleBinding(namespace, params.fleet_uuid);
      
      return namespace;
      
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check if this is an Azure exec auth error
      if (errorMessage.includes('Cannot read properties of null') || 
          errorMessage.includes('ExecAuth') ||
          errorMessage.includes('getCredential')) {
        logger.error('Failed to create fleet namespace - Azure AKS exec auth failed', {
          fleet_uuid: params.fleet_uuid,
          namespace,
          error: errorMessage,
          hint: 'Azure AKS exec authentication requires Azure CLI in container or service account tokens'
        });
        // Mark K8s as unavailable for future calls
        this.k8sAvailable = false;
        this.coreApi = null;
        this.appsApi = null;
        throw new Error('Kubernetes authentication failed. Azure AKS requires service account tokens when running in containers.');
      }
      
      const k8sBody = error?.body || error?.response?.body;
      const detailedMessage = k8sBody?.message || k8sBody?.status || errorMessage;

      logger.error('Failed to create fleet namespace', {
        fleet_uuid: params.fleet_uuid,
        namespace,
        error: errorMessage,
        statusCode: error?.statusCode,
        k8sReason: k8sBody?.reason,
        k8sMessage: k8sBody?.message,
        k8sBody
      });
      throw new Error(`Failed to create namespace ${namespace}: ${detailedMessage}`);
    }
  }

  /**
   * Soft-delete a fleet namespace (mark for deletion, don't actually delete)
   * 
   * For security hardening, the API no longer has permission to DELETE namespaces.
   * Instead, we mark namespaces with labels for a separate cleanup operator to handle.
   * 
   * This reduces blast radius: if API is compromised, attacker cannot delete namespaces directly.
   * 
   * SAFETY: This should ONLY be called from the DELETE /fleets/:id route
   * Never call this from device creation or other operations
   */
  async deleteFleetNamespace(namespace: string): Promise<void> {
    // Safety check 1: Prevent deletion of system/default namespaces
    const systemNamespaces = ['default', 'demo', 'kube-system', 'kube-public', 'kube-node-lease', 'virtual-agents'];
    if (systemNamespaces.includes(namespace)) {
      logger.error('SAFETY BLOCK: Attempted to delete system namespace - BLOCKED', { namespace });
      throw new Error(`Cannot delete system namespace: ${namespace}`);
    }

    // Safety check 2: Verify namespace is fleet-managed
    if (!namespace.startsWith('fleet-') && !namespace.startsWith('customer-')) {
      logger.error('SAFETY BLOCK: Namespace does not match fleet naming pattern - BLOCKED', { namespace });
      throw new Error(`Namespace does not appear to be a fleet namespace: ${namespace}`);
    }

    // Check if K8s is available
    if (!this.k8sAvailable || !this.coreApi) {
      logger.warn('Kubernetes is not configured or unavailable. Skipping namespace soft-delete.', { namespace });
      return; // Don't throw error - just skip K8s operations
    }

    try {
      // Soft-delete: Mark namespace with labels for cleanup operator
      // Do NOT actually delete the namespace (hardened security: API doesn't need delete permission)
      
      const now = new Date().toISOString();
      const patch = {
        metadata: {
          labels: {
            'iotistica.com/termination-requested': 'true',
            'iotistica.com/deletion-timestamp': now,
            'iotistica.com/delete-after-ttl': '604800' // 7 days in seconds
          }
        }
      };

      await this.coreApi.patchNamespace(namespace, patch);
      
      logger.info('Fleet namespace marked for soft-delete', { 
        namespace,
        deletionTimestamp: now,
        ttlSeconds: 604800,
        message: 'Actual deletion will be handled by external cleanup operator'
      });
      
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // If namespace doesn't exist (404), that's okay - it's already dealt with
      if (error.statusCode === 404 || errorMessage.includes('not found')) {
        logger.info('Fleet namespace not found (already deleted or never created)', { namespace });
        return;
      }
      
      // For other errors, mark it anyway but log the issue
      logger.warn('Failed to patch namespace for soft-delete', {
        namespace,
        error: errorMessage,
        hint: 'Namespace may need manual cleanup or operator intervention'
      });
      
      // Don't throw - gracefully degrade
    }
  }
}

// Export singleton instance
export const virtualAgentDeployer = new VirtualAgentDeployer();
