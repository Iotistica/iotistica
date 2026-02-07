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
    this.mqttBrokerUrl = process.env.MQTT_BROKER_URL || 'mqtts://mqtt1.iotistica.com:8883';

    logger.info('VirtualAgentDeployer configured', {
      defaultNamespace: this.defaultNamespace,
      agentImage: this.agentImage,
      cloudApiUrl: this.cloudApiUrl
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

    logger.info('Starting virtual agent deployment', {
      deviceUuid: config.deviceUuid.substring(0, 8) + '...',
      deviceName: config.deviceName,
      namespace,
      deploymentName: name
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

    } catch (error) {
      logger.error('Virtual agent deployment failed', {
        deviceUuid: config.deviceUuid,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
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
              'iotistic.com/namespace-type': 'virtual-agents'
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
          'iotistic.com/secret-type': 'provisioning-key'
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
    const deployment: k8s.V1Deployment = {
      metadata: {
        name,
        namespace,
        labels: {
          app: 'virtual-agent',
          'app.kubernetes.io/name': 'virtual-agent',
          'app.kubernetes.io/managed-by': 'iotistic-api',
          'iotistic.com/device-uuid': config.deviceUuid,
          'iotistic.com/fleet-id': config.fleetId
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
              'iotistic.com/device-uuid': config.deviceUuid
            }
          },
          spec: {
            containers: [
              {
                name: 'agent',
                image: this.agentImage,
                imagePullPolicy: process.env.AGENT_IMAGE_PULL_POLICY as any || 'Always',
                env: [
                  { name: 'DEVICE_UUID', value: config.deviceUuid },
                  { name: 'FLEET_ID', value: config.fleetId },
                  { name: 'REQUIRE_PROVISIONING', value: 'true' },
                  { name: 'IS_VIRTUAL_AGENT', value: 'true' },
                  { name: 'CLOUD_API_ENDPOINT', value: this.cloudApiUrl },
                  { name: 'MQTT_BROKER_URL', value: this.mqttBrokerUrl },
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
}

// Export singleton instance
export const virtualAgentDeployer = new VirtualAgentDeployer();
