import { Job } from 'bull';
import { deploymentQueue } from '../services/deployment-queue';
import { k8sDeploymentService } from '../services/k8s-deployment-service';
import { CustomerModel } from '../db/customer-model';
import { upgradeService } from '../services/upgrade-service';

interface DeploymentJobData {
  customerId: string;
  email: string;
  companyName: string;
  licenseKey: string;
  namespace?: string;
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

    // Process upgrade jobs (single concurrency for upgrades)
    queue.process('system-upgrade', 1, async (job: Job<UpgradeJobData>) => {
      return this.handleUpgrade(job);
    });

    this.isRunning = true;
    console.log(`✅ Deployment worker started (concurrency: ${concurrency})`);
  }

  /**
   * Handle deployment job
   */
  private async handleDeployment(job: Job<DeploymentJobData>) {
    const { customerId, email, companyName, licenseKey, namespace } = job.data;

    console.log(`🚀 Processing deployment for customer ${customerId}`);

    try {
      // Update job progress: Starting
      await job.progress(10);

      // Update customer status
      await CustomerModel.updateDeploymentStatus(customerId, 'provisioning');

      // Update job progress: Namespace creation
      await job.progress(20);

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

      console.log(`✅ Deployment completed for customer ${customerId}`);

      return {
        success: true,
        customerId,
        instanceUrl: result.instanceUrl,
        namespace: result.namespace,
        completedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      console.error(`❌ Deployment failed for customer ${customerId}:`, error.message);

      // Update customer status to failed
      await CustomerModel.updateDeploymentStatus(
        customerId,
        'failed',
        error.message
      );

      throw error; // Bull will handle retry
    }
  }

  /**
   * Handle update job
   */
  private async handleUpdate(job: Job<UpdateJobData>) {
    const { customerId, licenseKey, namespace } = job.data;

    console.log(`🔄 Processing update for customer ${customerId}`);

    try {
      await job.progress(10);

      const customer = await CustomerModel.getById(customerId);
      if (!customer) {
        throw new Error('Customer not found');
      }

      await job.progress(20);

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

      console.log(`✅ Update completed for customer ${customerId}`);

      return {
        success: true,
        customerId,
        completedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      console.error(`❌ Update failed for customer ${customerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Handle deletion job
   */
  private async handleDeletion(job: Job<DeleteJobData>) {
    const { customerId, namespace } = job.data;

    console.log(`🗑️  Processing deletion for customer ${customerId}`);

    try {
      await job.progress(10);

      const result = await k8sDeploymentService.deleteCustomerInstance(customerId);

      if (!result.success) {
        throw new Error(result.error || 'Deletion failed');
      }

      await job.progress(100);

      console.log(`✅ Deletion completed for customer ${customerId}`);

      return {
        success: true,
        customerId,
        completedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      console.error(`❌ Deletion failed for customer ${customerId}:`, error.message);
      throw error;
    }
  }

  /**
   * Handle upgrade job
   */
  private async handleUpgrade(job: Job<UpgradeJobData>) {
    const { upgradeId, customerIds } = job.data;

    console.log(`🔄 Processing system upgrade ${upgradeId}`);

    try {
      await job.progress(10);

      // Execute the upgrade
      await upgradeService.executeUpgrade(upgradeId, customerIds);

      await job.progress(100);

      console.log(`✅ Upgrade ${upgradeId} completed`);

      return {
        success: true,
        upgradeId,
        completedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      console.error(`❌ Upgrade ${upgradeId} failed:`, error.message);
      throw error;
    }
  }

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
