import { Job } from 'bull';
import { deploymentQueue } from '../services/deployment-queue';
import { gitOpsProvisioningService } from '../services/gitops-provisioning-service';
import { argoStatusService } from '../services/argo-status-service';
import { CustomerModel } from '../db/customer-model';
import { logger } from '../utils/logger';

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

    console.log('\n' + '='.repeat(80));
    console.log('🚀 STARTING DEPLOYMENT JOB');
    console.log('='.repeat(80));
    console.log(`📋 Job ID: ${job.id}`);
    console.log(`👤 Customer ID: ${customerId}`);
    console.log(`📧 Email: ${email}`);
    console.log(`🏢 Company: ${companyName}`);
    console.log(`📦 Plan: ${plan || 'starter'}`);
    console.log(`🏷️  Namespace: ${namespace || 'auto-generated'}`);
    console.log('='.repeat(80) + '\n');

    logger.info('Processing deployment', { customerId, plan });

    try {
      // Update job progress: Starting
      console.log('📊 Progress: 10% - Job started');
      await job.progress(10);

      // Update customer status to db_provisioning (GitOps service will handle provisioning stages)
      console.log('\n🔄 Updating customer status to: db_provisioning');
      await CustomerModel.updateDeploymentStatus(customerId, 'db_provisioning');

      // Update job progress: Database provisioning
      console.log('📊 Progress: 20% - Starting database provisioning');
      await job.progress(20);

      // GitOps flow: Provision DB, create secrets, write to Git, let Argo CD handle deployment
      logger.info('Using GitOps provisioning with TigerData + 1Password', { customerId });

        // Sanitize client ID
        const clientId = this.sanitizeClientId(customerId);
        const clientNamespace = namespace || `client-${clientId}`;

        // Decode license to extract monitoring config and other settings
        const licenseData = this.decodeLicense(licenseKey);

        // GitOps service handles:
        // - TigerData DB provisioning (status: db_provisioning -> db_ready)
        // - 1Password secret creation (status: secret_creating -> secret_ready)
        // - Git commit (status: deploying)
        // Progress: 20% -> 40% (DB ready), 40% -> 50% (Secrets ready), 50% -> 60% (Git committed)
        
        console.log('📊 Progress: 30% - Preparing GitOps deployment');
        await job.progress(30);

        console.log('\n🔧 Starting GitOps deployment flow...');
        console.log('   ├─ TigerData DB provisioning');
        console.log('   ├─ 1Password secret creation');
        console.log('   ├─ Git manifest generation');
        console.log('   └─ Argo CD synchronization\n');

        // Deploy via GitOps (includes TigerData + 1Password provisioning)
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

        console.log('\n✅ GitOps deployment completed!');
        console.log('   ✓ Database provisioned');
        console.log('   ✓ Secrets created');
        console.log('   ✓ Manifests committed to Git\n');
        logger.info('GitOps deployment committed and pushed (DB + Secrets + Manifests)', { customerId, clientId });

        console.log('📊 Progress: 60% - GitOps deployment complete');
        await job.progress(60);

        // Wait for Argo CD to sync and deploy (optional)
        const skipArgoCheck = process.env.SKIP_ARGOCD_STATUS_CHECK === 'true';
        
        if (skipArgoCheck) {
          console.log('\n⏭️  Skipping Argo CD status check (SKIP_ARGOCD_STATUS_CHECK=true)');
          logger.info('Skipping Argo CD status check (SKIP_ARGOCD_STATUS_CHECK=true)', { clientId });
        } else {
          console.log('\n⏳ Waiting for Argo CD to sync and deploy application...');
          logger.info('Waiting for Argo CD to deploy Application', { clientId });
          
          console.log('📊 Progress: 80% - Monitoring Argo CD deployment');
          await job.progress(80);
          
          // Pass customerId for retry tracking
          const isReady = await argoStatusService.waitForApplicationReady(clientId, customerId);

          if (!isReady) {
            throw new Error('Argo CD deployment did not reach healthy state within timeout');
          }
        }

        console.log('📊 Progress: 90% - Finalizing deployment');
        await job.progress(90);

        // Update customer deployment status to 'ready'
        const instanceUrl = `https://${clientId}.${domain || process.env.BASE_DOMAIN || 'iotistic.com'}`;
        console.log('\n🔄 Updating customer status to: ready');
        console.log(`🌐 Instance URL: ${instanceUrl}`);
        await CustomerModel.updateDeploymentStatus(customerId, 'ready', {
          instanceNamespace: clientNamespace,
          instanceUrl,
          deploymentError: '',
        });

        console.log('📊 Progress: 100% - Deployment complete! 🎉');
        await job.progress(100);

        console.log('\n' + '='.repeat(80));
        console.log('✅ DEPLOYMENT COMPLETED SUCCESSFULLY');
        console.log('='.repeat(80));
        console.log(`👤 Customer: ${email}`);
        console.log(`🏷️  Namespace: ${clientNamespace}`);
        console.log(`🌐 URL: ${instanceUrl}`);
        console.log(`⏱️  Completed at: ${new Date().toISOString()}`);
        console.log('='.repeat(80) + '\n');

        logger.info('GitOps deployment completed successfully', { customerId, clientId });

        return {
          success: true,
          customerId,
          instanceUrl: `https://${clientId}.${domain || process.env.BASE_DOMAIN || 'iotistic.com'}`,
          namespace: clientNamespace,
          completedAt: new Date().toISOString(),
        };

    } catch (error: any) {
      console.log('\n' + '='.repeat(80));
      console.log('❌ DEPLOYMENT FAILED');
      console.log('='.repeat(80));
      console.log(`👤 Customer ID: ${customerId}`);
      console.log(`❌ Error: ${error.message}`);
      if (error.stack) {
        console.log(`\n📋 Stack trace:`);
        console.log(error.stack);
      }
      console.log('='.repeat(80) + '\n');

      logger.error('Deployment failed', { customerId, error: error.message, stack: error.stack });

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

    logger.info('Processing update', { customerId });

    try {
      await job.progress(10);

      const customer = await CustomerModel.getById(customerId);
      if (!customer) {
        throw new Error('Customer not found');
      }

      await job.progress(20);

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

    logger.info('Processing deletion', { customerId });

    try {
      await job.progress(10);

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
