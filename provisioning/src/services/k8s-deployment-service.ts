import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../utils/logger';
import { CustomerModel } from '../db/customer-model';

const execAsync = promisify(exec);

interface DeploymentOptions {
  customerId: string;
  email: string;
  companyName: string;
  licenseKey: string;
  namespace?: string;
  domain?: string;
}

interface DeploymentResult {
  success: boolean;
  namespace: string;
  instanceUrl?: string;
  error?: string;
}

export class K8sDeploymentService {
  private readonly chartPath: string;
  private readonly baseDomain: string;
  private readonly licensePublicKey: string;

  constructor() {
    // Path to Helm chart (adjust based on your deployment structure)
    this.chartPath = process.env.HELM_CHART_PATH || path.join(__dirname, '../../../charts/customer-instance');
    this.baseDomain = process.env.BASE_DOMAIN || 'iotistic.ca';
    
    // Load LICENSE_PUBLIC_KEY from environment (never store in values.yaml!)
    this.licensePublicKey = process.env.LICENSE_PUBLIC_KEY || '';
    
    if (!this.licensePublicKey) {
      logger.warn('⚠️  LICENSE_PUBLIC_KEY not set - customer instances will run in unlicensed mode');
    }
  }

  /**
   * Sanitize customer ID for use as Kubernetes namespace
   * K8s namespace rules: lowercase alphanumeric + hyphens, max 63 chars
   * Uses shortened customer ID to avoid length issues with Helm resource names
   */
  private sanitizeNamespace(customerId: string): string {
    // Extract short unique portion: "cust_dc5fec42901a..." -> "dc5fec42"
    // This keeps total length manageable for Helm-generated resource names
    const shortId = customerId.replace(/^cust_/, '').substring(0, 8);
    return `customer-${shortId}`;
  }

  /**
   * Sanitize customer ID for use in DNS names (ingress hosts)
   * DNS rules: lowercase alphanumeric + hyphens + dots, no underscores
   */
  private sanitizeCustomerId(customerId: string): string {
    return customerId.replace(/_/g, '-').toLowerCase();
  }

  /**
   * Deploy a customer instance to Kubernetes using Helm
   */
  async deployCustomerInstance(options: DeploymentOptions): Promise<DeploymentResult> {
    const namespace = options.namespace || this.sanitizeNamespace(options.customerId);
    const instanceUrl = `https://${options.customerId}.${this.baseDomain}`;

    try {
      logger.info('Starting Kubernetes deployment', { 
        customerId: options.customerId,
        namespace 
      });

      // Update customer deployment status to 'provisioning'
      await CustomerModel.updateDeploymentStatus(options.customerId, 'provisioning', {
        instanceNamespace: namespace,
        instanceUrl: instanceUrl
      });

      // 🎭 SIMULATION MODE - Skip actual K8s deployment for local testing
      if (process.env.SIMULATE_K8S_DEPLOYMENT === 'true') {
        logger.info('🎭 Simulating Kubernetes deployment (SIMULATE_K8S_DEPLOYMENT=true)', {
          customerId: options.customerId,
          namespace
        });

        // Simulate deployment time (3-5 seconds)
        const delay = 3000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, delay));

        logger.info('🎭 Simulated deployment complete', {
          customerId: options.customerId,
          namespace,
          duration: `${Math.round(delay / 1000)}s`
        });

        // Update to ready status
        await CustomerModel.updateDeploymentStatus(options.customerId, 'ready', {
          deploymentError: ''
        });

        return {
          success: true,
          namespace,
          instanceUrl
        };
      }

      // 1. Create namespace if it doesn't exist
      await this.createNamespace(namespace, options.customerId);

      // 2. Install/upgrade Helm release
      await this.installHelmRelease(namespace, options);

      // 3. Wait for deployment to be ready
      await this.waitForDeployment(namespace);

      // 4. Update customer deployment status to 'ready'
      await CustomerModel.updateDeploymentStatus(options.customerId, 'ready', {
        deploymentError: ''
      });

      logger.info('Kubernetes deployment successful', { 
        customerId: options.customerId,
        namespace,
        instanceUrl
      });

      return {
        success: true,
        namespace,
        instanceUrl
      };

    } catch (error: any) {
      const errorMessage = error.message || 'Unknown deployment error';
      
      logger.error('Kubernetes deployment failed', { 
        customerId: options.customerId,
        namespace,
        error: errorMessage 
      });

      // Update customer deployment status to 'failed'
      await CustomerModel.updateDeploymentStatus(options.customerId, 'failed', {
        deploymentError: errorMessage
      });

      return {
        success: false,
        namespace,
        error: errorMessage
      };
    }
  }

  /**
   * Create Kubernetes namespace with labels
   */
  private async createNamespace(namespace: string, customerId: string): Promise<void> {
    try {
      // Check if namespace exists
      await execAsync(`kubectl get namespace ${namespace}`);
      logger.info('Namespace already exists', { namespace });
    } catch (error) {
      // Namespace doesn't exist, create it
      logger.info('Creating namespace', { namespace });
      await execAsync(`kubectl create namespace ${namespace}`);
      
      // Add labels after creation
      await execAsync(
        `kubectl label namespace ${namespace} ` +
        `customer-id=${customerId} managed-by=iotistic`
      );
    }
  }

  /**
   * Install or upgrade Helm release
   */
  private async installHelmRelease(namespace: string, options: DeploymentOptions): Promise<void> {
    const releaseName = namespace;  // Use sanitized namespace as release name
    const sanitizedCustomerId = this.sanitizeCustomerId(options.customerId);
    // shortId: first 8 chars of the customer id (without 'cust_' prefix)
    const shortId = options.customerId.replace(/^cust_/, '').replace(/_/g, '-').substring(0, 8);
    
    // Decode license to extract monitoring configuration
    let monitoringConfig = {
      enabled: true,
      dedicated: false,
      scrapeInterval: '30s',
      retention: '7d',
      storageSize: '10Gi'
    };
    
    try {
      // Decode JWT without verification (we already trust it since we generated it)
      const decoded = require('jsonwebtoken').decode(options.licenseKey) as any;
      if (decoded && decoded.features) {
        const plan = decoded.plan || 'starter';
        const hasDedicatedPrometheus = decoded.features.hasDedicatedPrometheus || false;
        
        monitoringConfig = {
          enabled: true,
          dedicated: hasDedicatedPrometheus,
          scrapeInterval: '30s',
          retention: `${decoded.features.prometheusRetentionDays || 7}d`,
          storageSize: decoded.features.prometheusStorageGb > 0 
            ? `${decoded.features.prometheusStorageGb}Gi` 
            : '10Gi'
        };
        
        // Add Grafana configuration for Enterprise (dedicated monitoring)
        if (hasDedicatedPrometheus) {
          (monitoringConfig as any).grafana = {
            enabled: true,
            adminUser: 'admin',
            adminPassword: 'admin', // TODO: Generate secure password
            persistence: {
              enabled: true,
              size: '10Gi'
            }
          };
        }
        
        logger.info('Monitoring configuration extracted from license', { 
          customerId: options.customerId,
          plan,
          monitoring: monitoringConfig 
        });
      }
    } catch (error: any) {
      logger.warn('Failed to decode license for monitoring config, using defaults', { error: error.message });
    }
    
    // Create a temporary values file for complex values like LICENSE_PUBLIC_KEY
    const tempValuesFile = path.join('/tmp', `values-${namespace}.yaml`);
    
    // Build monitoring section with grafana if dedicated
    let monitoringSection = `
monitoring:
  enabled: ${monitoringConfig.enabled}
  dedicated: ${monitoringConfig.dedicated}
  scrapeInterval: "${monitoringConfig.scrapeInterval}"
  retention: "${monitoringConfig.retention}"
  storageSize: "${monitoringConfig.storageSize}"`;
    
    // Add Grafana configuration if present
    if ((monitoringConfig as any).grafana) {
      const grafana = (monitoringConfig as any).grafana;
      monitoringSection += `
  grafana:
    enabled: ${grafana.enabled}
    adminUser: "${grafana.adminUser}"
    adminPassword: "${grafana.adminPassword}"
    persistence:
      enabled: ${grafana.persistence.enabled}
      size: "${grafana.persistence.size}"`;
    }
    
    // MQTT exporter configuration (only for dedicated monitoring)
    const hasDedicatedPrometheus = monitoringConfig.dedicated;
    const mosquittoMetricsSection = `
mosquitto:
  metrics:
    enabled: ${hasDedicatedPrometheus}  # Only enable if dedicated Prometheus is deployed`;
    
    // Determine service types based on base domain
    // Use NodePort for Docker Desktop (localhost), ClusterIP for production
    const isDockerDesktop = this.baseDomain === 'localhost';
    
    // Generate unique NodePort numbers based on customer short ID
    // NodePort range: 30000-32767 (K8s default)
    // Strategy: Use hash of customer ID to generate deterministic port offsets
    let serviceTypeSection = '';
    let mqttBrokerSection = '';
    if (isDockerDesktop) {
      // Hash the customer ID to get a number between 0-2000
      const hashCode = shortId.split('').reduce((acc, char) => {
        return ((acc << 5) - acc) + char.charCodeAt(0);
      }, 0);
      const portOffset = Math.abs(hashCode % 2000); // 0-2000 range for up to 2000 customers
      
      const mqttPort = 31000 + portOffset;          // e.g., 31567
      const websocketPort = 31000 + portOffset + 1; // e.g., 31568
      
      serviceTypeSection = `
mosquitto:
  serviceType: NodePort
  nodePorts:
    mqtt: ${mqttPort}
    websocket: ${websocketPort}`;
      
      mqttBrokerSection = `
mqtt:
  broker:
    host: localhost
    port: ${mqttPort}
    protocol: mqtt
    useTls: false`;
      
      logger.info('NodePort allocation for Docker Desktop', {
        customerId: shortId,
        ports: { mqtt: mqttPort, websocket: websocketPort }
      });
    }
    
    const valuesContent = `
customer:
  id: ${shortId}
  fullId: ${sanitizedCustomerId}
  originalId: ${options.customerId}
  email: ${options.email}
  companyName: "${options.companyName}"
license:
  key: "${options.licenseKey}"
  publicKey: |
${this.licensePublicKey.split('\n').map(line => '    ' + line).join('\n')}
domain:
  base: ${this.baseDomain}
ingress:
  host: ${shortId}.${this.baseDomain}${monitoringSection}
${mosquittoMetricsSection}${serviceTypeSection}${mqttBrokerSection}
`;
    
    await fs.writeFile(tempValuesFile, valuesContent, 'utf8');
    
    // Build Helm command using values file
    const helmCommand = [
      'helm upgrade --install',
      releaseName,
      this.chartPath,
      `-f ${tempValuesFile}`,
      `--namespace ${namespace}`,
      `--create-namespace`,
      `--wait`,
      `--timeout 5m`
    ].join(' ');

    // Try to upgrade if exists, otherwise install
    try {
      logger.info('Installing Helm release', { releaseName, namespace, valuesFile: tempValuesFile });
      
      const { stdout, stderr } = await execAsync(helmCommand);
      
      // Clean up temp values file
      await fs.unlink(tempValuesFile).catch(() => {});
      
      if (stderr && !stderr.includes('STATUS: deployed')) {
        logger.warn('Helm deployment warnings', { stderr });
      }
      
      logger.info('Helm release deployed', { releaseName, stdout });
      
    } catch (error: any) {
      // Clean up temp values file on error
      await fs.unlink(tempValuesFile).catch(() => {});
      
      logger.error('Helm deployment failed', { 
        releaseName, 
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr
      });
      throw new Error(`Helm deployment failed: ${error.stderr || error.message}`);
    }
  }

  /**
   * Wait for all deployments in namespace to be ready
   */
  private async waitForDeployment(namespace: string, timeoutSeconds: number = 300): Promise<void> {
    logger.info('Waiting for deployments to be ready', { namespace, timeoutSeconds });
    
    try {
      await execAsync(
        `kubectl wait --for=condition=available --timeout=${timeoutSeconds}s ` +
        `--all deployments -n ${namespace}`
      );
      
      logger.info('All deployments ready', { namespace });
      
    } catch (error: any) {
      logger.error('Deployment readiness timeout', { 
        namespace, 
        error: error.message 
      });
      throw new Error(`Deployments not ready after ${timeoutSeconds}s: ${error.message}`);
    }
  }

  /**
   * Delete a customer instance from Kubernetes
   * Removes namespace and all resources (Pods, Services, ConfigMaps, PVCs, etc.)
   * Also cleans up cluster-scoped resources (ClusterRole, ClusterRoleBinding from OpenCost)
   */
  async deleteCustomerInstance(customerId: string): Promise<DeploymentResult> {
    const namespace = this.sanitizeNamespace(customerId);
    const releaseName = namespace;

    try {
      logger.info('Starting customer instance deletion', { customerId, namespace });

      // Check if in simulation mode
      const simulateMode = process.env.SIMULATE_K8S_DEPLOYMENT === 'true';
      
      if (simulateMode) {
        logger.info('🎭 SIMULATION MODE - Would delete Kubernetes resources', {
          customerId,
          namespace,
          releaseName
        });

        await CustomerModel.updateDeploymentStatus(customerId, 'pending', {
          instanceNamespace: '',
          instanceUrl: ''
        });

        return { success: true, namespace };
      }

      // Real deletion - Step 1: Uninstall Helm release
      try {
        logger.info('Uninstalling Helm release', { releaseName, namespace });
        await execAsync(`helm uninstall ${releaseName} --namespace ${namespace}`);
        logger.info('✅ Helm release uninstalled', { releaseName });
      } catch (error: any) {
        if (error.message.includes('not found') || error.message.includes('NotFound')) {
          logger.warn('Helm release not found (may have been manually deleted)', { releaseName });
        } else {
          logger.warn('Helm uninstall error (non-critical, continuing)', { error: error.message });
        }
      }

      // Step 2: Delete namespace (cascades to all resources)
      try {
        logger.info('Deleting Kubernetes namespace', { namespace });
        await execAsync(`kubectl delete namespace ${namespace} --timeout=5m`);
        logger.info('✅ Namespace deleted successfully', { namespace });
      } catch (error: any) {
        if (error.message.includes('NotFound') || error.message.includes('not found')) {
          logger.warn('Namespace already deleted or never existed', { namespace });
        } else {
          throw new Error(`Failed to delete namespace: ${error.message}`);
        }
      }

      // Step 3: Clean up cluster-scoped resources (OpenCost creates these)
      const clusterResourcePrefix = `c${namespace.replace('customer-', '')}-customer-instance`;
      
      try {
        logger.info('Cleaning up cluster-scoped resources', { prefix: clusterResourcePrefix });
        
        // Delete ClusterRoleBindings
        const { stdout: bindings } = await execAsync(
          `kubectl get clusterrolebinding -o name 2>/dev/null | grep "${clusterResourcePrefix}" || echo ""`
        );
        
        if (bindings.trim()) {
          for (const binding of bindings.trim().split('\n').filter(b => b)) {
            try {
              await execAsync(`kubectl delete ${binding}`);
              logger.info('Deleted ClusterRoleBinding', { binding });
            } catch (err: any) {
              logger.warn('Failed to delete ClusterRoleBinding', { binding, error: err.message });
            }
          }
        }

        // Delete ClusterRoles
        const { stdout: roles } = await execAsync(
          `kubectl get clusterrole -o name 2>/dev/null | grep "${clusterResourcePrefix}" || echo ""`
        );
        
        if (roles.trim()) {
          for (const role of roles.trim().split('\n').filter(r => r)) {
            try {
              await execAsync(`kubectl delete ${role}`);
              logger.info('Deleted ClusterRole', { role });
            } catch (err: any) {
              logger.warn('Failed to delete ClusterRole', { role, error: err.message });
            }
          }
        }

      } catch (error: any) {
        logger.warn('Error cleaning up cluster-scoped resources (non-critical)', { error: error.message });
      }

      // Step 4: Update customer record - reset to pending state (instance removed)
      await CustomerModel.updateDeploymentStatus(customerId, 'pending', {
        instanceNamespace: '',
        instanceUrl: ''
      });

      logger.info('✅ Customer instance deleted successfully', { customerId, namespace });

      return {
        success: true,
        namespace
      };

    } catch (error: any) {
      logger.error('Failed to delete customer instance', { 
        customerId, 
        error: error.message,
        stack: error.stack
      });

      // Update customer with error
      await CustomerModel.updateDeploymentStatus(customerId, 'failed', {
        deploymentError: `Deletion failed: ${error.message}`
      });

      return {
        success: false,
        namespace,
        error: error.message
      };
    }
  }

  /**
   * Get deployment status for a customer
   */
  async getDeploymentStatus(customerId: string): Promise<any> {
    const customer = await CustomerModel.getById(customerId);

    if (!customer) {
      throw new Error('Customer not found');
    }

    const namespace = customer.instance_namespace || this.sanitizeNamespace(customerId);
    const releaseName = namespace;

    try {
      // Get Helm release status
      const { stdout: helmStatus } = await execAsync(
        `helm status ${releaseName} --namespace ${namespace} --output json`
      );
      const helmData = JSON.parse(helmStatus);

      // Get pod status
      const { stdout: podStatus } = await execAsync(
        `kubectl get pods -n ${namespace} -o json`
      );
      const podData = JSON.parse(podStatus);

      return {
        customer: {
          id: customer.id,
          email: customer.email,
          deploymentStatus: customer.deployment_status,
          instanceUrl: customer.instance_url,
          deployedAt: customer.deployed_at,
          deploymentError: customer.deployment_error
        },
        helm: {
          status: helmData.info.status,
          version: helmData.version,
          lastDeployed: helmData.info.last_deployed
        },
        pods: podData.items.map((pod: any) => ({
          name: pod.metadata.name,
          status: pod.status.phase,
          ready: pod.status.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True'
        }))
      };

    } catch (error: any) {
      logger.warn('Could not get deployment status', { 
        customerId, 
        error: error.message 
      });

      return {
        customer: {
          id: customer.id,
          email: customer.email,
          deploymentStatus: customer.deployment_status,
          instanceUrl: customer.instance_url,
          deployedAt: customer.deployed_at,
          deploymentError: customer.deployment_error
        },
        error: error.message
      };
    }
  }

  /**
   * Update a customer instance (e.g., after license renewal)
   */
  async updateCustomerInstance(options: DeploymentOptions): Promise<DeploymentResult> {
    // Same as deploy - Helm will upgrade existing release
    return this.deployCustomerInstance(options);
  }
}

// Export singleton instance
export const k8sDeploymentService = new K8sDeploymentService();
