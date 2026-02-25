import { Job } from 'bull';
import { deploymentQueue } from '../services/deployment-queue';
import { k8sDeploymentService } from '../services/k8s-deployment-service';
import { gitOpsProvisioningService } from '../services/gitops-provisioning-service';
import { argoStatusService } from '../services/argo-status-service';
import { CustomerModel } from '../db/customer-model';
import { logger } from '../utils/logger';
// import { upgradeService } from '../services/upgrade-service'; // Disabled - missing module

interface DeploymentJobData {
  customerId: string;
  email: string;
  companyName: string;
  licenseKey: string;
  namespace?: string;
  // GitOps-specific fields
  plan?: 'starter' | 'professional' | 'enterprise';
  licensePublicKey?: string;
  domain?: string;
}

interface UpdateJobData {
  customerId: string;
  licenseKey: string;
  namespace: string;
}

interface DeleteJobData {
  customerId: string;
  namespace: string;
}

interface UpgradeJobData {
  upgradeId: string;
  customerIds?: string[];
}

export class DeploymentWorker {
  private isRunning = false;

  /**
   * Start the worker
   */
  async start() {
    if (this.isRunning) {
      console.warn('⚠️  Deployment worker already running');
      return;
    }

    console.log('🚀 Starting deployment worker...');

    const queue = deploymentQueue.getQueue();
    const concurrency = parseInt(process.env.QUEUE_CONCURRENCY || '3');

    // Process deployment jobs
    queue.process('deploy-customer-stack', concurrency, async (job: Job<DeploymentJobData>) => {
      return this.handleDeployment(job);
    });

    // Process update jobs
    queue.process('update-customer-stack', concurrency, async (job: Job<UpdateJobData>) => {
      return this.handleUpdate(job);
    });

    // Process deletion jobs
    queue.process('delete-customer-stack', concurrency, async (job: Job<DeleteJobData>) => {
      return this.handleDeletion(job);
    });

    // Process upgrade jobs (single concurrency for upgrades) - Disabled (missing upgrade-service)
    // queue.process('system-upgrade', 1, async (job: Job<UpgradeJobData>) => {
    //   return this.handleUpgrade(job);
    // });

    this.isRunning = true;
    console.log(`✅ Deployment worker started (concurrency: ${concurrency})`);
  }

  /**
   * Handle deployment job
   */
  private async handleDeployment(job: Job<DeploymentJobData>) {
    const { customerId, email, companyName, licenseKey, namespace, plan, licensePublicKey, domain } = job.data;

    logger.info('Processing deployment', { customerId, plan, gitOpsEnabled: gitOpsProvisioningService.isEnabled() });

    try {
      // Update job progress: Starting
      await job.progress(10);

      // Update customer status
      await CustomerModel.updateDeploymentStatus(customerId, 'provisioning');

      // Update job progress: Namespace creation
      await job.progress(20);

      // Check if GitOps mode is enabled
      if (gitOpsProvisioningService.isEnabled()) {
        // GitOps flow: Write to Git, let Argo CD handle deployment
        logger.info('Using GitOps provisioning', { customerId });

        // Sanitize client ID
        const clientId = this.sanitizeClientId(customerId);
        const clientNamespace = namespace || `client-${clientId}`;

        // Decode license to extract monitoring config and other settings
        const licenseData = this.decodeLicense(licenseKey);

        await job.progress(40);

        // Deploy via GitOps
        await gitOpsProvisioningService.deployClient({
          clientId,
          customerId,
          email,
          companyName,
          plan: plan || licenseData.plan || 'starter',
          licenseKey,
          licensePublicKey: licensePublicKey || process.env.LICENSE_PUBLIC_KEY || '',
          namespace: clientNamespace,
          domain: domain || process.env.BASE_DOMAIN || 'iotistic.com',
          monitoring: licenseData.monitoring,
        });

        logger.info('GitOps deployment committed and pushed', { customerId, clientId });

        await job.progress(60);

        // Wait for Argo CD to sync and deploy (optional)
        const skipArgoCheck = process.env.SKIP_ARGOCD_STATUS_CHECK === 'true';
        
        if (skipArgoCheck) {
          logger.info('Skipping Argo CD status check (SKIP_ARGOCD_STATUS_CHECK=true)', { clientId });
        } else {
          logger.info('Waiting for Argo CD to deploy Application', { clientId });
          
          const isReady = await argoStatusService.waitForApplicationReady(clientId);

          if (!isReady) {
            throw new Error('Argo CD deployment did not reach healthy state within timeout');
          }
        }

        await job.progress(90);

        // Update customer deployment status to 'ready'
        await CustomerModel.updateDeploymentStatus(customerId, 'ready', {
          instanceNamespace: clientNamespace,
          instanceUrl: `https://${clientId}.${domain || process.env.BASE_DOMAIN || 'iotistic.com'}`,
          deploymentError: '',
        });

        await job.progress(100);

        logger.info('GitOps deployment completed', { customerId, clientId });

        return {
          success: true,
          customerId,
          instanceUrl: `https://${clientId}.${domain || process.env.BASE_DOMAIN || 'iotistic.com'}`,
          namespace: clientNamespace,
          completedAt: new Date().toISOString(),
        };

      } else {
        // Legacy Helm-based deployment
        logger.info('Using legacy Helm deployment', { customerId });

        // Deploy to Kubernetes
        const result = await k8sDeploymentService.deployCustomerInstance({
          customerId,
          email,
          companyName,
          licenseKey,
          namespace,
        });

        if (!result.success) {
          throw new Error(result.error || 'Deployment failed');
        }

        // Update job progress: Completed
        await job.progress(100);

        logger.info('Helm deployment completed', { customerId });

        return {
          success: true,
          customerId,
          instanceUrl: result.instanceUrl,
          namespace: result.namespace,
          completedAt: new Date().toISOString(),
        };
      }

    } catch (error: any) {
      logger.error('Deployment failed', { customerId, error: error.message });

      // Update customer status to failed
      await CustomerModel.updateDeploymentStatus(
        customerId,
        'failed',
        { deploymentError: error.message }
      );

      throw error; // Bull will handle retry
    }
  }

  /**
   * Sanitize customer ID for use as client ID
   */
  private sanitizeClientId(customerId: string): string {
    return customerId.replace(/^cust_/, '').substring(0, 8);
  }

  /**
   * Decode license JWT to extract configuration
   */
  private decodeLicense(licenseKey: string): any {
    try {
      const jwt = require('jsonwebtoken');
      const decoded = jwt.decode(licenseKey);
      
      if (!decoded) {
        return {};
      }

      // Extract monitoring configuration from license
      const monitoring = decoded.features ? {
        enabled: true,
        dedicated: decoded.features.hasDedicatedPrometheus || false,
        retention: `${decoded.features.prometheusRetentionDays || 7}d`,
        storageSize: decoded.features.prometheusStorageGb > 0 
          ? `${decoded.features.prometheusStorageGb}Gi` 
          : '10Gi',
      } : undefined;

      return {
        plan: decoded.plan || 'starter',
        monitoring,
      };
    } catch (error: any) {
      logger.warn('Failed to decode license', { error: error.message });
      return {};
    }
  }

  /**
   * Handle update job
   */
  private async handleUpdate(job: Job<UpdateJobData>) {
    const { customerId, licenseKey, namespace } = job.data;

    logger.info('Processing update', { customerId, gitOpsEnabled: gitOpsProvisioningService.isEnabled() });

    try {
      await job.progress(10);

      const customer = await CustomerModel.getById(customerId);
      if (!customer) {
        throw new Error('Customer not found');
      }

      await job.progress(20);

      if (gitOpsProvisioningService.isEnabled()) {
        // GitOps flow: Update client in Git
        logger.info('Using GitOps update', { customerId });

        const clientId = this.sanitizeClientId(customerId);
        const licenseData = this.decodeLicense(licenseKey);

        await gitOpsProvisioningService.updateClient({
          clientId,
          customerId,
          email: customer.email,
          companyName: customer.company_name || 'Unknown',
          plan: licenseData.plan || 'starter',
          licenseKey,
          licensePublicKey: process.env.LICENSE_PUBLIC_KEY || '',
          namespace: namespace || `client-${clientId}`,
          domain: process.env.BASE_DOMAIN || 'iotistic.com',
          monitoring: licenseData.monitoring,
        });

        await job.progress(60);

        // Wait for Argo CD to sync changes (optional)
        const skipArgoCheck = process.env.SKIP_ARGOCD_STATUS_CHECK === 'true';
        
        if (skipArgoCheck) {
          logger.info('Skipping Argo CD status check (SKIP_ARGOCD_STATUS_CHECK=true)', { clientId });
        } else {
          const isReady = await argoStatusService.waitForApplicationReady(clientId);

          if (!isReady) {
            throw new Error('Argo CD update did not reach healthy state within timeout');
          }
        }

        await job.progress(100);

        logger.info('GitOps update completed', { customerId, clientId });

        return {
          success: true,
          customerId,
          completedAt: new Date().toISOString(),
        };

      } else {
        // Legacy Helm update
        const result = await k8sDeploymentService.updateCustomerInstance({
          customerId,
          email: customer.email,
          companyName: customer.company_name || 'Unknown',
          licenseKey,
          namespace,
        });

        if (!result.success) {
          throw new Error(result.error || 'Update failed');
        }

        await job.progress(100);

        logger.info('Helm update completed', { customerId });

        return {
          success: true,
          customerId,
          completedAt: new Date().toISOString(),
        };
      }

    } catch (error: any) {
      logger.error('Update failed', { customerId, error: error.message });
      throw error;
    }
  }

  /**
   * Handle deletion job
   */
  private async handleDeletion(job: Job<DeleteJobData>) {
    const { customerId, namespace } = job.data;

    logger.info('Processing deletion', { customerId, gitOpsEnabled: gitOpsProvisioningService.isEnabled() });

    try {
      await job.progress(10);

      if (gitOpsProvisioningService.isEnabled()) {
        // GitOps flow: Remove client from Git
        logger.info('Using GitOps deletion', { customerId });

        const clientId = this.sanitizeClientId(customerId);

        await gitOpsProvisioningService.deleteClient(clientId, customerId);

        await job.progress(50);

        // Note: Argo CD will automatically prune resources when Application is deleted
        // We don't need to wait for complete deletion in this POC
        logger.info('GitOps deletion committed and pushed', { customerId, clientId });

        await job.progress(100);

        logger.info('GitOps deletion completed', { customerId, clientId });

        return {
          success: true,
          customerId,
          completedAt: new Date().toISOString(),
        };

      } else {
        // Legacy Helm deletion
        const result = await k8sDeploymentService.deleteCustomerInstance(customerId);

        if (!result.success) {
          throw new Error(result.error || 'Deletion failed');
        }

        await job.progress(100);

        logger.info('Helm deletion completed', { customerId });

        return {
          success: true,
          customerId,
          completedAt: new Date().toISOString(),
        };
      }

    } catch (error: any) {
      logger.error('Deletion failed', { customerId, error: error.message });
      throw error;
    }
  }

  /**
   * Handle upgrade job - Disabled (missing upgrade-service)
   */
  // private async handleUpgrade(job: Job<UpgradeJobData>) {
  //   const { upgradeId, customerIds } = job.data;
  //   console.log(`🔄 Processing system upgrade ${upgradeId}`);
  //   try {
  //     await job.progress(10);
  //     await upgradeService.executeUpgrade(upgradeId, customerIds);
  //     await job.progress(100);
  //     console.log(`✅ Upgrade ${upgradeId} completed`);
  //     return {
  //       success: true,
  //       upgradeId,
  //       completedAt: new Date().toISOString(),
  //     };
  //   } catch (error: any) {
  //     console.error(`❌ Upgrade ${upgradeId} failed:`, error.message);
  //     throw error;
  //   }
  // }

  /**
   * Stop the worker
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    console.log('🛑 Stopping deployment worker...');
    await deploymentQueue.close();
    this.isRunning = false;
    console.log('✅ Deployment worker stopped');
  }
}

// Export singleton instance
export const deploymentWorker = new DeploymentWorker();
