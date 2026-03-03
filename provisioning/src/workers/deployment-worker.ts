import { Job } from 'bull';
import crypto from 'crypto';
import axios from 'axios';
import { deploymentQueue, DeploymentJobData, UpdateJobData, DeleteJobData, MonitorArgoJobData } from '../services/deployment-queue';
import { gitOpsProvisioningService } from '../services/gitops-provisioning-service';
import { argoStatusService } from '../services/argo-status-service';
import { CustomerModel } from '../db/customer-model';
import { logger } from '../utils/logger';

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

    console.log(`🔌 Connecting to Bull queue: ${queue.name}`);

    // Add queue event listeners for job processing flow
    queue.on('checking', (job) => {
      console.log(`👀 Checking job ${job.id}`);
    });

    queue.on('waiting', (jobId) => {
      console.log(`⏳ Job ${jobId} waiting for processing`);
    });

    queue.on('active', (job, jobPromise) => {
      console.log(`▶️  Job ${job.id} (${job.name}) started processing`);
    });

    queue.on('completed', (job, result) => {
      console.log(`✅ Job ${job.id} completed successfully`);
    });

    queue.on('failed', (job, error) => {
      console.error(`❌ Job ${job.id} failed:`, {
        message: error.message,
        attempt: job.attemptsMade,
        maxAttempts: job.opts.attempts,
      });
    });

    queue.on('error', (error) => {
      console.error('❌ Bull queue error:', {
        message: error.message,
        code: (error as any).code,
      });
    });

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

    // Process Argo CD monitoring jobs (separate from deployment)
    // Concurrency: 5 (can handle more monitoring than deployments)
    queue.process('monitor-argo', 5, async (job: Job<MonitorArgoJobData>) => {
      return this.handleArgoMonitoring(job);
    });

    // Process upgrade jobs (single concurrency for upgrades) - Disabled (missing upgrade-service)
    // queue.process('system-upgrade', 1, async (job: Job<UpgradeJobData>) => {
    //   return this.handleUpgrade(job);
    // });

    this.isRunning = true;
    console.log(`✅ Deployment worker started (concurrency: ${concurrency})`);
    console.log(`📊 Configured processors: deploy-customer-stack, update-customer-stack, delete-customer-stack, monitor-argo`);
  }

  /**
   * Handle deployment job
   */
  private async handleDeployment(job: Job<DeploymentJobData>) {
    const { customerId, email, companyName, namespace, plan, domain } = job.data;

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

      // Check if subscription was cancelled before starting
      if (await this.isCustomerCancelled(customerId)) {
        console.log('🚫 Deployment aborted - subscription cancelled');
        await CustomerModel.updateDeploymentStatus(customerId, 'cancelled');
        return {
          success: false,
          customerId,
          message: 'Deployment aborted due to subscription cancellation',
          aborted: true,
        };
      }

      // Update customer status to db_provisioning (GitOps service will handle provisioning stages)
      console.log('\n🔄 Updating customer status to: db_provisioning');
      await CustomerModel.updateDeploymentStatus(customerId, 'db_provisioning');

      // Update job progress: Database provisioning
      console.log('📊 Progress: 20% - Starting database provisioning');
      await job.progress(20);

      // Fetch license from provisioning API
      const provisioningUrl = process.env.BASE_URL || 'http://localhost:3100';
      console.log('🔑 Fetching license from provisioning API...');
      const licenseRes = await axios.get<{ license: string; plan: 'starter' | 'professional' | 'enterprise'; monitoring: any }>(
        `${provisioningUrl}/api/licenses/${customerId}`
      );
      const { license: licenseKey, plan: licensePlan, monitoring: licenseMonitoring } = licenseRes.data;
      console.log(`✓ License fetched for plan: ${licensePlan}`);

      // GitOps flow: Provision DB, create secrets, write to Git, let Argo CD handle deployment
      logger.info('Using GitOps provisioning with TigerData + 1Password', { customerId });

        // Sanitize client ID
        const clientId = this.sanitizeClientId(customerId);
        const clientNamespace = namespace || `client-${clientId}`;

        // GitOps service handles:
        // - TigerData DB provisioning (status: db_provisioning -> db_ready)
        // - 1Password secret creation (status: secret_creating -> secret_ready)
        // - Git commit (status: deploying)
        // Progress: 20% -> 40% (DB ready), 40% -> 50% (Secrets ready), 50% -> 60% (Git committed)
        
        console.log('📊 Progress: 30% - Preparing GitOps deployment');
        await job.progress(30);

        // Check if subscription was cancelled during early provisioning
        if (await this.isCustomerCancelled(customerId)) {
          console.log('🚫 Deployment aborted - subscription cancelled during provisioning');
          await CustomerModel.updateDeploymentStatus(customerId, 'cancelled');
          return {
            success: false,
            customerId,
            message: 'Deployment aborted due to subscription cancellation',
            aborted: true,
          };
        }

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
          plan: plan || licensePlan,
          licenseKey,
          namespace: clientNamespace,
          domain: domain || process.env.BASE_DOMAIN || 'iotistic.com',
          monitoring: licenseMonitoring,
        }, job); // Pass job for retry context

        console.log('\n✅ GitOps deployment completed!');
        console.log('   ✓ Database provisioned');
        console.log('   ✓ Secrets created');
        console.log('   ✓ Manifests committed to Git\n');
        logger.info('GitOps deployment committed and pushed (DB + Secrets + Manifests)', { customerId, clientId });

        console.log('📊 Progress: 60% - GitOps deployment complete');
        await job.progress(60);

        // Deploy job ends here (60%) - monitoring job handles 60 → 100%
        const instanceUrl = `https://client-${clientId}.${domain || process.env.BASE_DOMAIN || 'iotistic.com'}`;
        console.log('\n🔄 Updating customer status to: argo_syncing');
        await CustomerModel.updateDeploymentStatus(customerId, 'argo_syncing', {
          instanceNamespace: clientNamespace,
          instanceUrl,
        });

        // Enqueue Argo CD monitoring job (runs separately, can take 8-15 min)
        const skipArgoCheck = process.env.SKIP_ARGOCD_STATUS_CHECK === 'true';
        
        if (skipArgoCheck) {
          console.log('\n⏭️  Skipping Argo CD monitoring (SKIP_ARGOCD_STATUS_CHECK=true)');
          logger.info('Skipping Argo CD monitoring (SKIP_ARGOCD_STATUS_CHECK=true)', { clientId });
          
          // Mark as ready immediately
          await CustomerModel.updateDeploymentStatus(customerId, 'ready', {
            instanceNamespace: clientNamespace,
            instanceUrl,
            deploymentError: '',
          });
        } else {
          console.log('\n📋 Enqueueing Argo CD monitoring job...');
          await deploymentQueue.addMonitorArgoJob({
            customerId,
            clientId,
            namespace: clientNamespace,
            instanceUrl,
          });
          console.log('✅ Monitoring job queued - deployment worker freed for next deployment');
        }

        console.log('\n' + '='.repeat(80));
        console.log('✅ DEPLOYMENT PHASE COMPLETED');
        console.log('='.repeat(80));
        console.log(`👤 Customer: ${email}`);
        console.log(`🏷️  Namespace: ${clientNamespace}`);
        console.log(`🌐 URL: ${instanceUrl}`);
        console.log(`📊 Progress: ${skipArgoCheck ? '100% (ready)' : '60% (monitoring queued)'}`);
        console.log(`📋 Status: ${skipArgoCheck ? 'Ready (Argo check skipped)' : 'Argo syncing (monitoring job queued)'}`);
        console.log(`⏱️  Completed at: ${new Date().toISOString()}`);
        console.log('='.repeat(80) + '\n');

        logger.info('GitOps deployment completed successfully', { customerId, clientId });

        return {
          success: true,
          customerId,
          instanceUrl,
          namespace: clientNamespace,
          argoStatus: skipArgoCheck ? 'ready' : 'monitoring_queued',
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

      // Classify error into specific failure type for observability
      const failureStatus = this.classifyError(error);
      
      console.log(`🏷️  Failure type: ${failureStatus}`);
      logger.info('Classified deployment failure', { customerId, failureType: failureStatus });

      // Update customer status with classified failure type
      await CustomerModel.updateDeploymentStatus(
        customerId,
        failureStatus,
        { deploymentError: error.message }
      );

      throw error; // Bull will handle retry
    }
  }

  /**
   * Sanitize customer ID for use as client ID
   * Uses SHA256 hash to prevent namespace collisions (critical for multi-tenant SaaS)
   * 
   * @param customerId - Internal customer ID (e.g., 47d48f27e0774d6a9f89a1c1dab9870a)
   * @returns 12-character hex hash (e.g., 3f558f4667c9)
   * 
   * Security: SHA256 ensures uniqueness across millions of customers
   * 12 hex chars = 48 bits = ~281 trillion combinations
   */
  private sanitizeClientId(customerId: string): string {
    return crypto
      .createHash('sha256')
      .update(customerId)
      .digest('hex')
      .substring(0, 12);
  }

  /**
   * Classify error into specific failure type based on error message
   * This enables granular observability in production
   */
  private classifyError(error: any): 'failed_db' | 'failed_secret' | 'failed_deployment' | 'argo_failed' | 'failed' {
    const errorMessage = error.message?.toLowerCase() || '';
    
    // Database provisioning errors
    if (errorMessage.includes('tigerdata') || errorMessage.includes('database')) {
      return 'failed_db';
    }
    
    // Secret management errors
    if (errorMessage.includes('1password') || errorMessage.includes('secret')) {
      return 'failed_secret';
    }
    
    // Argo CD sync/health errors
    if (errorMessage.includes('argo') || errorMessage.includes('application') || errorMessage.includes('sync')) {
      return 'argo_failed';
    }
    
    // Git commit/push errors
    if (errorMessage.includes('git') || errorMessage.includes('commit') || errorMessage.includes('push')) {
      return 'failed_deployment';
    }
    
    // Generic failure (unknown error type)
    return 'failed';
  }

  /**
   * Check if customer subscription has been cancelled
   * Used to abort in-progress deployments gracefully
   */
  private async isCustomerCancelled(customerId: string): Promise<boolean> {
    try {
      const customer = await CustomerModel.getById(customerId);
      return customer?.deployment_status === 'cancelled' || customer?.is_active === false;
    } catch (error) {
      logger.warn('Failed to check customer cancellation status', { customerId, error });
      return false; // Continue deployment if check fails
    }
  }

  /**
   * Handle update job
   */
  private async handleUpdate(job: Job<UpdateJobData>) {
    const { customerId, namespace } = job.data;

    logger.info('Processing update', { customerId });

    try {
      await job.progress(10);

      const customer = await CustomerModel.getById(customerId);
      if (!customer) {
        throw new Error('Customer not found');
      }

      await job.progress(20);

      // Fetch license from provisioning API
      const provisioningUrl = process.env.BASE_URL || 'http://localhost:3100';
      const licenseRes = await axios.get<{ license: string; plan: 'starter' | 'professional' | 'enterprise'; monitoring: any }>(
        `${provisioningUrl}/api/licenses/${customerId}`
      );
      const { license: licenseKey, plan: licensePlan, monitoring } = licenseRes.data;

      await job.progress(30);

      // GitOps flow: Update client in Git
      logger.info('Using GitOps update', { customerId });

        const clientId = this.sanitizeClientId(customerId);

        await gitOpsProvisioningService.updateClient({
          clientId,
          customerId,
          email: customer.email,
          companyName: customer.company_name || 'Unknown',
          plan: licensePlan || 'starter',
          licenseKey,
          namespace: namespace || `client-${clientId}`,
          domain: process.env.BASE_DOMAIN || 'iotistic.com',
          monitoring,
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
   * Comprehensive cleanup: Git + Secrets + Database
   */
  private async handleDeletion(job: Job<DeleteJobData>) {
    const { customerId, namespace } = job.data;

    console.log('\n' + '='.repeat(80));
    console.log('🗑️  STARTING DELETION JOB');
    console.log('='.repeat(80));
    console.log(`📋 Job ID: ${job.id}`);
    console.log(`👤 Customer ID: ${customerId}`);
    console.log(`📦 Namespace: ${namespace}`);
    console.log('='.repeat(80) + '\n');

    logger.info('Processing deletion', { customerId, namespace });

    try {
      // Update customer status to 'deleting'
      console.log('🔄 Updating status to: deleting');
      await CustomerModel.updateDeploymentStatus(customerId, 'deleting');
      
      await job.progress(10);

      // GitOps flow: Comprehensive deletion (Git + Secrets + DB)
      logger.info('Starting GitOps comprehensive deletion', { customerId });

      const clientId = this.sanitizeClientId(customerId);
      console.log(`🏷️  Client ID: ${clientId}`);

      // This will:
      // 1. Remove Git manifests
      // 2. Delete 1Password secret
      // 3. Delete TigerData database
      // All steps are idempotent and resilient
      await gitOpsProvisioningService.deleteClient(clientId, customerId);

      await job.progress(80);

      // Update customer status to 'deleted'
      console.log('\n🔄 Updating status to: deleted');
      await CustomerModel.updateDeploymentStatus(customerId, 'deleted');

      await job.progress(100);

      console.log('\n' + '='.repeat(80));
      console.log('✅ DELETION JOB COMPLETED');
      console.log('='.repeat(80));
      console.log(`👤 Customer: ${customerId}`);
      console.log(`🏷️  Client: ${clientId}`);
      console.log(`✅ Status: All resources cleaned up`);
      console.log(`⏱️  Completed at: ${new Date().toISOString()}`);
      console.log('='.repeat(80) + '\n');

      logger.info('Deletion completed successfully', { customerId, clientId });

      return {
        success: true,
        customerId,
        clientId,
        completedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      console.log('\n' + '='.repeat(80));
      console.log('❌ DELETION FAILED');
      console.log('='.repeat(80));
      console.log(`👤 Customer ID: ${customerId}`);
      console.log(`❌ Error: ${error.message}`);
      if (error.stack) {
        console.log(`\n📋 Stack trace:`);
        console.log(error.stack);
      }
      console.log('='.repeat(80) + '\n');

      logger.error('Deletion failed', { customerId, error: error.message, stack: error.stack });
      
      // Note: Don't update status to 'failed' - keep as 'deleting' for retry
      // The deletion job will be retried automatically by Bull
      
      throw error; // Bull will handle retry
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
   * Handle Argo CD monitoring job (runs separately from deployment)
   * This picks up from 60% and completes to 100%
   * Can block for 8-15 minutes without impacting deployment throughput
   */
  private async handleArgoMonitoring(job: Job<MonitorArgoJobData>) {
    const { customerId, clientId, namespace, instanceUrl } = job.data;

    console.log('\n' + '='.repeat(80));
    console.log('👁️  STARTING ARGO CD MONITORING JOB');
    console.log('='.repeat(80));
    console.log(`📋 Job ID: ${job.id}`);
    console.log(`👤 Customer ID: ${customerId}`);
    console.log(`🏷️  Client ID: ${clientId}`);
    console.log(`📦 Namespace: ${namespace}`);
    console.log(`📊 Progress: Starting from 60% (deployment phase completed)`);
    console.log('='.repeat(80) + '\n');

    logger.info('Processing Argo CD monitoring', { customerId, clientId });

    try {
      // Monitor job starts at 60% (where deploy job ended)
      await job.progress(60);

      console.log('⏳ Waiting for Argo CD to sync and deploy application...');
      console.log('   (This can take 8-15 minutes depending on cluster load)');
      logger.info('Waiting for Argo CD to deploy Application', { clientId });

      await job.progress(70);

      // TEMPORARY: Use test client ID if configured (for testing while Argo CD integration is in progress)
      const testClientId = process.env.ARGOCD_TEST_CLIENT_ID;
      const clientIdToMonitor = testClientId || clientId;
      
      if (testClientId) {
        console.log(`⚠️  TEST MODE: Using existing Argo CD app: client-${testClientId}`);
        logger.warn('Using test client ID for Argo CD monitoring', { 
          actualClientId: clientId,
          testClientId,
          customerId,
        });
      }

      // Wait for Argo CD (can block for 8-15 min - that's OK for this dedicated job)
      const isReady = await argoStatusService.waitForApplicationReady(clientIdToMonitor, customerId);

      if (!isReady) {
        throw new Error('Argo CD deployment did not reach healthy state within timeout');
      }

      await job.progress(90);

      // Check if deployment is actually ready or still progressing
      const customer = await CustomerModel.getById(customerId);
      const finalStatus = customer?.deployment_status;
      
      if (finalStatus === 'deploying') {
        // Argo CD monitoring timed out but deployment is still progressing
        console.log('\n' + '='.repeat(80));
        console.log('⏳ ARGO CD MONITORING COMPLETED (Deployment Still Progressing)');
        console.log('='.repeat(80));
        console.log(`👤 Customer: ${customerId}`);
        console.log(`🏷️  Client: ${clientId}`);
        console.log(`🌐 URL: ${instanceUrl}`);
        console.log(`⏳ Status: Argo CD is still syncing in the background`);
        console.log(`📋 Note: Check Argo CD UI at https://argocd.iotistica.com for real-time progress`);
        console.log(`⏱️  Monitoring stopped at: ${new Date().toISOString()}`);
        console.log('='.repeat(80) + '\n');

        logger.info('Argo CD monitoring completed (deployment still progressing)', { customerId, clientId });

        await job.progress(100);

        return {
          success: true,
          customerId,
          clientId,
          instanceUrl,
          completedAt: new Date().toISOString(),
          note: 'Deployment is still progressing in Argo CD',
        };
      }

      // Update customer deployment status to 'ready'
      console.log('\n🔄 Updating customer status to: ready');
      console.log(`🌐 Instance URL: ${instanceUrl}`);
      await CustomerModel.updateDeploymentStatus(customerId, 'ready', {
        instanceNamespace: namespace,
        instanceUrl,
        deploymentError: '',
      });

      await job.progress(100);

      console.log('\n' + '='.repeat(80));
      console.log('✅ ARGO CD MONITORING COMPLETED (60% → 100%)');
      console.log('='.repeat(80));
      console.log(`👤 Customer: ${customerId}`);
      console.log(`🏷️  Client: ${clientId}`);
      console.log(`🌐 URL: ${instanceUrl}`);
      console.log(`✅ Status: Application is Healthy and Synced`);
      console.log(`⏱️  Completed at: ${new Date().toISOString()}`);
      console.log('='.repeat(80) + '\n');

      logger.info('Argo CD monitoring completed successfully', { customerId, clientId });

      return {
        success: true,
        customerId,
        clientId,
        instanceUrl,
        completedAt: new Date().toISOString(),
      };

    } catch (error: any) {
      console.log('\n' + '='.repeat(80));
      console.log('❌ ARGO CD MONITORING FAILED');
      console.log('='.repeat(80));
      console.log(`👤 Customer ID: ${customerId}`);
      console.log(`🏷️  Client ID: ${clientId}`);
      console.log(`❌ Error: ${error.message}`);
      if (error.stack) {
        console.log(`\n📋 Stack trace:`);
        console.log(error.stack);
      }
      console.log('='.repeat(80) + '\n');

      logger.error('Argo CD monitoring failed', { customerId, clientId, error: error.message, stack: error.stack });

      // Update customer status to argo_failed (specific to Argo CD sync failures)
      await CustomerModel.updateDeploymentStatus(
        customerId,
        'argo_failed',
        { deploymentError: `Argo CD sync failed: ${error.message}` }
      );

      throw error; // Bull will handle retry
    }
  }

  /**
   * Stop the worker
   */
  async stop() {
    if (!this.isRunning) {
      console.log('ℹ️  Worker not running, nothing to stop');
      return;
    }

    console.log('🛑 Stopping deployment worker...');
    try {
      console.log('🔌 Closing Bull queue connections...');
      await deploymentQueue.close();
      console.log('✅ Bull queue closed');
    } catch (error) {
      console.error('⚠️  Error closing Bull queue:', (error as any).message);
    }
    this.isRunning = false;
    console.log('✅ Deployment worker stopped');
  }
}

// Export singleton instance
export const deploymentWorker = new DeploymentWorker();
