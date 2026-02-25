import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { logger } from '../utils/logger';
import { CustomerModel } from '../db/customer-model';
import { k8sDeploymentService } from './k8s-deployment-service';

const execAsync = promisify(exec);

interface UpgradeOptions {
  dryRun?: boolean;
  force?: boolean;
  timeout?: number; // seconds
  additionalValues?: Record<string, any>;
}

interface UpgradeResult {
  success: boolean;
  customerId: string;
  namespace: string;
  version: string;
  duration?: number;
  error?: string;
  rolledBack?: boolean;
}

interface HealthCheckResult {
  healthy: boolean;
  checks: {
    podsRunning: boolean;
    apiHealthy: boolean;
    databaseConnected: boolean;
  };
  errors: string[];
}

export class UpgradeService {
  private readonly chartPath: string;

  constructor() {
    this.chartPath = process.env.HELM_CHART_PATH || path.join(__dirname, '../../../charts/customer-instance');
  }

  /**
   * Upgrade a single customer instance to a new version
   */
  async upgradeCustomerInstance(
    customerId: string,
    newVersion: string,
    options: UpgradeOptions = {}
  ): Promise<UpgradeResult> {
    const startTime = Date.now();
    const customer = await CustomerModel.getById(customerId);

    if (!customer) {
      throw new Error(`Customer not found: ${customerId}`);
    }

    const namespace = customer.instance_namespace;
    if (!namespace) {
      throw new Error(`Customer ${customerId} has no deployed instance`);
    }

    const releaseName = namespace; // Release name matches namespace

    logger.info(`🚀 Starting upgrade for ${customerId}`, {
      customerId,
      namespace,
      currentVersion: 'unknown', // TODO: Track current version in DB
      newVersion,
      dryRun: options.dryRun
    });

    try {
      // Update deployment status to 'provisioning' (reusing existing status for upgrades)
      await CustomerModel.updateDeploymentStatus(customerId, 'provisioning', {
        deploymentError: ''
      });

      // Prepare values file
      const valuesFile = this.prepareValuesFile(customer, newVersion, options);

      if (options.dryRun) {
        logger.info('🔍 Dry-run mode - simulating upgrade');
        await this.dryRunUpgrade(releaseName, namespace, valuesFile);
        
        // Clean up temp file
        this.cleanupValuesFile(valuesFile);
        
        return {
          success: true,
          customerId,
          namespace,
          version: newVersion,
          duration: Date.now() - startTime
        };
      }

      // Execute Helm upgrade with rolling update strategy
      await this.executeHelmUpgrade(releaseName, namespace, valuesFile, options);

      // Wait for rollout to complete
      await this.waitForRollout(namespace, options.timeout || 600);

      // Run post-upgrade health checks
      const healthCheck = await this.verifyUpgrade(namespace);
      
      if (!healthCheck.healthy) {
        throw new Error(`Health checks failed: ${healthCheck.errors.join(', ')}`);
      }

      // Update database with success
      await CustomerModel.updateDeploymentStatus(customerId, 'ready', {
        deploymentError: ''
      });

      // Log successful upgrade
      await this.logUpgrade(customerId, newVersion, 'success', Date.now() - startTime);

      logger.info(`✅ Upgrade complete for ${customerId}`, {
        customerId,
        namespace,
        newVersion,
        duration: `${Math.round((Date.now() - startTime) / 1000)}s`
      });

      // Clean up temp file
      this.cleanupValuesFile(valuesFile);

      return {
        success: true,
        customerId,
        namespace,
        version: newVersion,
        duration: Date.now() - startTime
      };

    } catch (error: any) {
      logger.error(`❌ Upgrade failed for ${customerId}`, {
        customerId,
        namespace,
        error: error.message
      });

      // Attempt automatic rollback
      let rolledBack = false;
      try {
        await this.rollbackUpgrade(namespace, releaseName);
        rolledBack = true;
        
        // Update status back to ready (rolled back)
        await CustomerModel.updateDeploymentStatus(customerId, 'ready', {
          deploymentError: `Upgrade to ${newVersion} failed and was rolled back: ${error.message}`
        });
      } catch (rollbackError: any) {
        logger.error(`❌ Rollback also failed for ${customerId}`, {
          customerId,
          rollbackError: rollbackError.message
        });
        
        // Update status to failed
        await CustomerModel.updateDeploymentStatus(customerId, 'failed', {
          deploymentError: `Upgrade failed and rollback failed: ${error.message}`
        });
      }

      // Log failed upgrade
      await this.logUpgrade(customerId, newVersion, 'failed', Date.now() - startTime, error.message);

      return {
        success: false,
        customerId,
        namespace,
        version: newVersion,
        duration: Date.now() - startTime,
        error: error.message,
        rolledBack
      };
    }
  }

  /**
   * Prepare temporary values file for Helm upgrade
   */
  private prepareValuesFile(
    customer: any,
    newVersion: string,
    options: UpgradeOptions
  ): string {
    const namespace = customer.instance_namespace;
    const shortId = customer.customer_id.replace(/^cust_/, '').substring(0, 8);
    
    // Get LICENSE_PUBLIC_KEY from environment
    const licensePublicKey = process.env.LICENSE_PUBLIC_KEY || '';
    
    const values = {
      // Update image tags to new version
      api: {
        image: {
          repository: 'iotistic/api',
          tag: newVersion,
          pullPolicy: 'Always'
        }
      },
      dashboard: {
        image: {
          repository: 'iotistic/dashboard',
          tag: newVersion,
          pullPolicy: 'Always'
        }
      },
      
      // Keep customer info
      customer: {
        id: customer.customer_id.replace(/_/g, '-').toLowerCase(),
        shortId: shortId,
        originalId: customer.customer_id,
        email: customer.email,
        companyName: customer.company_name
      },
      
      // Keep license (re-generate if needed)
      license: {
        key: customer.license_key || '',
        publicKey: licensePublicKey
      },
      
      // Merge any additional values
      ...options.additionalValues
    };

    // Create temp values file with proper YAML formatting
    const valuesFile = `/tmp/upgrade-${namespace}-${Date.now()}.yaml`;
    
    // Use YAML dump to handle multi-line strings properly
    const yamlContent = yaml.dump(values, {
      lineWidth: -1, // Don't wrap lines
      noRefs: true
    });
    
    fs.writeFileSync(valuesFile, yamlContent, 'utf8');
    
    logger.debug('Created values file', { valuesFile, values });
    
    return valuesFile;
  }

  /**
   * Execute Helm upgrade command
   */
  private async executeHelmUpgrade(
    releaseName: string,
    namespace: string,
    valuesFile: string,
    options: UpgradeOptions
  ): Promise<void> {
    const timeout = options.timeout || 600; // 10 minutes default
    
    const helmCommand = [
      'helm upgrade',
      releaseName,
      this.chartPath,
      `-n ${namespace}`,
      `-f ${valuesFile}`,
      '--wait',
      `--timeout ${timeout}s`,
      options.force ? '--force' : ''
    ].filter(Boolean).join(' ');

    logger.info('Executing Helm upgrade', { releaseName, namespace, helmCommand });

    try {
      const { stdout, stderr } = await execAsync(helmCommand);
      
      if (stderr && !stderr.includes('STATUS: deployed')) {
        logger.warn('Helm upgrade warnings', { stderr });
      }
      
      logger.info('Helm upgrade completed', { releaseName, stdout });
      
    } catch (error: any) {
      logger.error('Helm upgrade failed', {
        releaseName,
        namespace,
        error: error.message,
        stdout: error.stdout,
        stderr: error.stderr
      });
      
      throw new Error(`Helm upgrade failed: ${error.stderr || error.message}`);
    }
  }

  /**
   * Dry-run upgrade to validate changes without applying
   */
  private async dryRunUpgrade(
    releaseName: string,
    namespace: string,
    valuesFile: string
  ): Promise<void> {
    const helmCommand = [
      'helm upgrade',
      releaseName,
      this.chartPath,
      `-n ${namespace}`,
      `-f ${valuesFile}`,
      '--dry-run',
      '--debug'
    ].join(' ');

    logger.info('Executing dry-run upgrade', { releaseName, namespace });

    try {
      const { stdout } = await execAsync(helmCommand);
      logger.info('Dry-run successful', { releaseName, output: stdout });
    } catch (error: any) {
      logger.error('Dry-run failed', { error: error.message });
      throw new Error(`Dry-run failed: ${error.stderr || error.message}`);
    }
  }

  /**
   * Wait for Kubernetes rollout to complete
   */
  private async waitForRollout(namespace: string, timeoutSeconds: number): Promise<void> {
    logger.info('Waiting for rollout to complete', { namespace, timeoutSeconds });

    try {
      // Wait for all deployments to be available
      await execAsync(
        `kubectl wait --for=condition=available --timeout=${timeoutSeconds}s ` +
        `--all deployments -n ${namespace}`
      );

      // Also check rollout status
      const { stdout } = await execAsync(
        `kubectl rollout status deployment --timeout=${timeoutSeconds}s -n ${namespace}`
      );

      logger.info('Rollout complete', { namespace, status: stdout });

    } catch (error: any) {
      logger.error('Rollout timeout or failure', {
        namespace,
        error: error.message
      });
      throw new Error(`Rollout failed: ${error.message}`);
    }
  }

  /**
   * Run health checks after upgrade
   */
  private async verifyUpgrade(namespace: string): Promise<HealthCheckResult> {
    const errors: string[] = [];
    const checks = {
      podsRunning: false,
      apiHealthy: false,
      databaseConnected: false
    };

    try {
      // Check 1: All pods running
      const { stdout: podStatus } = await execAsync(
        `kubectl get pods -n ${namespace} -o json`
      );
      const pods = JSON.parse(podStatus);
      
      const allRunning = pods.items.every((pod: any) => 
        pod.status.phase === 'Running' &&
        pod.status.conditions?.find((c: any) => c.type === 'Ready')?.status === 'True'
      );

      if (!allRunning) {
        errors.push('Not all pods are running and ready');
      } else {
        checks.podsRunning = true;
      }

      // Check 2: API health endpoint
      try {
        const apiPod = pods.items.find((pod: any) => 
          pod.metadata.name.includes('api')
        );

        if (apiPod) {
          const { stdout: healthCheck } = await execAsync(
            `kubectl exec -n ${namespace} ${apiPod.metadata.name} -- ` +
            `curl -s http://localhost:3002/health`
          );

          const health = JSON.parse(healthCheck);
          if (health.status === 'ok') {
            checks.apiHealthy = true;
          } else {
            errors.push('API health check failed');
          }
        }
      } catch (error: any) {
        errors.push(`API health check error: ${error.message}`);
      }

      // Check 3: Database connectivity (check from API pod)
      try {
        const apiPod = pods.items.find((pod: any) => 
          pod.metadata.name.includes('api')
        );

        if (apiPod) {
          // Simple check: Can we connect to postgres service?
          await execAsync(
            `kubectl exec -n ${namespace} ${apiPod.metadata.name} -- ` +
            `nc -zv postgres 5432 2>&1`
          );
          checks.databaseConnected = true;
        }
      } catch (error: any) {
        errors.push(`Database connection check failed: ${error.message}`);
      }

    } catch (error: any) {
      errors.push(`Health check failed: ${error.message}`);
    }

    const healthy = errors.length === 0;

    logger.info('Health check results', { namespace, healthy, checks, errors });

    return { healthy, checks, errors };
  }

  /**
   * Rollback to previous version
   */
  private async rollbackUpgrade(namespace: string, releaseName: string): Promise<void> {
    logger.info(`🔄 Rolling back ${namespace}...`);

    try {
      await execAsync(
        `helm rollback ${releaseName} -n ${namespace} --wait --timeout 5m`
      );

      logger.info(`✅ Rollback complete: ${namespace}`);

    } catch (error: any) {
      logger.error(`❌ Rollback failed: ${namespace}`, {
        error: error.message
      });
      throw new Error(`Rollback failed: ${error.message}`);
    }
  }

  /**
   * Log upgrade attempt to database
   */
  private async logUpgrade(
    customerId: string,
    version: string,
    status: 'success' | 'failed',
    duration: number,
    error?: string
  ): Promise<void> {
    // TODO: Create upgrade_history table and log here
    logger.info('Logging upgrade', {
      customerId,
      version,
      status,
      duration,
      error
    });
  }

  /**
   * Clean up temporary values file
   */
  private cleanupValuesFile(valuesFile: string): void {
    try {
      if (fs.existsSync(valuesFile)) {
        fs.unlinkSync(valuesFile);
        logger.debug('Cleaned up values file', { valuesFile });
      }
    } catch (error: any) {
      logger.warn('Failed to cleanup values file', { 
        valuesFile, 
        error: error.message 
      });
    }
  }

  /**
   * Get upgrade history for a customer
   */
  async getUpgradeHistory(customerId: string): Promise<any[]> {
    // TODO: Query upgrade_history table
    logger.info('Getting upgrade history', { customerId });
    return [];
  }

  /**
   * Check if an upgrade is safe to perform (pre-flight checks)
   */
  async canUpgrade(customerId: string, newVersion: string): Promise<{ canUpgrade: boolean; reasons: string[] }> {
    const reasons: string[] = [];
    const customer = await CustomerModel.getById(customerId);

    if (!customer) {
      reasons.push('Customer not found');
      return { canUpgrade: false, reasons };
    }

    if (customer.deployment_status !== 'ready') {
      reasons.push(`Customer instance is not ready (status: ${customer.deployment_status})`);
    }

    // TODO: Add more checks
    // - Check if version is valid
    // - Check if there are breaking migrations
    // - Check if customer has active maintenance window

    return {
      canUpgrade: reasons.length === 0,
      reasons
    };
  }
}

// Export singleton instance
export const upgradeService = new UpgradeService();
