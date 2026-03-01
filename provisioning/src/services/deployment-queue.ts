import Bull, { Queue, Job, JobOptions } from 'bull';
import { EventEmitter } from 'events';

export interface DeploymentJobData {
  customerId: string;
  email: string;
  companyName: string;
  namespace?: string;
  priority?: number;
  metadata?: Record<string, any>;
  // GitOps-specific fields
  plan?: 'starter' | 'professional' | 'enterprise';
  domain?: string;
  // Note: License is fetched from provisioning API by gitops-provisioning-service
}

export interface UpdateJobData {
  customerId: string;
  namespace: string;
  // Note: License is fetched from provisioning API by gitops-provisioning-service
}

export interface DeleteJobData {
  customerId: string;
  namespace: string;
}

export interface MonitorArgoJobData {
  customerId: string;
  clientId: string;
  namespace: string;
  instanceUrl: string;
}

export class DeploymentQueue extends EventEmitter {
  private queue: Queue;

  constructor() {
    super();

    // Initialize Bull queue with Redis connection (Azure-compatible)
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379');
    const username = process.env.REDIS_USERNAME || undefined;
    const password = process.env.REDIS_PASSWORD || undefined;
    const db = parseInt(process.env.REDIS_DB || '0');
    
    const tlsFlag = (process.env.REDIS_TLS || process.env.REDIS_USE_TLS || '')
      .toLowerCase();
    const useTls = tlsFlag === 'true' || tlsFlag === '1' || tlsFlag === 'yes';
    
    this.queue = new Bull('customer-deployments', {
      redis: {
        host,
        port,
        username,
        password,
        db,
        tls: useTls 
          ? { 
              servername: host,
              rejectUnauthorized: true, // Azure uses valid certs
            } 
          : undefined,
        // Bull requires enableOfflineQueue: true to buffer commands during connection
        enableOfflineQueue: true,
        connectTimeout: 10000, // 10s connect timeout
        // Don't use commandTimeout - causes issues with Bull's blocking operations
        keepAlive: 30000,
        retryStrategy: (times)=>{
          // Exponential backoff: 50ms, 100ms, 150ms... up to 2s
          return Math.min(times * 50, 2000);
        },
      },
      settings: {
        // Stall interval: how often to check if job is still processing.
        // GitOps provisioning includes long-running steps (DB provisioning, secrets, git push, Argo sync)
        // that can exceed 1 minute without yielding in some environments.
        stalledInterval: 300000, // 5 minutes (default is 5s)
        // Max times a job can stall before failing
        maxStalledCount: 10,
      },
      prefix: 'provisioning', // Namespace Bull keys
      defaultJobOptions: {
        attempts: parseInt(process.env.QUEUE_MAX_RETRIES || '5'),
        backoff: {
          type: 'exponential',
          delay: parseInt(process.env.QUEUE_RETRY_DELAY || '60000'), // 1 min
        },
        removeOnComplete: {
          age: 7 * 24 * 3600, // Keep completed jobs for 7 days
          count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: {
          age: 30 * 24 * 3600, // Keep failed jobs for 30 days
        },
      },
    });

    // Add Redis client event handlers for debugging
    const client = this.queue.client;
    client.on('connect', () => {
      console.log('✅ Bull Redis client connected');
    });
    client.on('ready', () => {
      console.log('✅ Bull Redis client ready');
    });
    client.on('error', (err) => {
      console.error('❌ Bull Redis client error:', err.message);
    });
    client.on('close', () => {
      console.warn('⚠️  Bull Redis client closed');
    });
    client.on('reconnecting', () => {
      console.log('🔄 Bull Redis client reconnecting...');
    });

    console.log(`📋 Deployment queue initialized (redis://${host}:${port}/${db})`);

    // Setup event handlers
    this.setupEventHandlers();
  }

  /**
   * Add deployment job to queue
   */
  async addDeploymentJob(
    data: DeploymentJobData,
    options?: JobOptions
  ): Promise<Job<DeploymentJobData>> {
    const job = await this.queue.add(
      'deploy-customer-stack',
      data,
      {
        priority: data.priority || 5, // 1 = highest, 10 = lowest
        jobId: `deploy-${data.customerId}-${Date.now()}`,
        ...options,
      }
    );

    console.log(`🚀 Deployment job queued: ${job.id} for customer ${data.customerId}`);
    return job;
  }

  /**
   * Add update job to queue
   */
  async addUpdateJob(
    data: UpdateJobData,
    options?: JobOptions
  ): Promise<Job<UpdateJobData>> {
    const job = await this.queue.add(
      'update-customer-stack',
      data,
      {
        priority: 3, // Higher priority than new deployments
        jobId: `update-${data.customerId}-${Date.now()}`,
        ...options,
      }
    );

    console.log(`🔄 Update job queued: ${job.id} for customer ${data.customerId}`);
    return job;
  }

  /**
   * Add deletion job to queue
   */
  async addDeleteJob(
    data: DeleteJobData,
    options?: JobOptions
  ): Promise<Job<DeleteJobData>> {
    const job = await this.queue.add(
      'delete-customer-stack',
      data,
      {
        priority: 1, // Highest priority
        jobId: `delete-${data.customerId}-${Date.now()}`,
        ...options,
      }
    );

    console.log(`🗑️  Deletion job queued: ${job.id} for customer ${data.customerId}`);
    return job;
  }

  /**
   * Add Argo CD monitoring job to queue
   * This runs separately from deployment to avoid blocking workers
   * Concurrency: 5 (independent of deployment workers)
   */
  async addMonitorArgoJob(
    data: MonitorArgoJobData,
    options?: JobOptions
  ): Promise<Job<MonitorArgoJobData>> {
    const job = await this.queue.add(
      'monitor-argo',
      data,
      {
        priority: 4, // Lower priority than deployments
        jobId: `monitor-${data.customerId}-${Date.now()}`,
        attempts: 3, // Retry monitoring up to 3 times
        backoff: {
          type: 'exponential',
          delay: 120000, // 2 min between retries
        },
        ...options,
      }
    );

    console.log(`👁️  Argo monitoring job queued: ${job.id} for customer ${data.customerId}`);
    return job;
  }

  /**
   * Add a generic job to the queue (for upgrades, etc.)
   */
  async add(
    jobName: string,
    data: any,
    options?: JobOptions
  ): Promise<Job> {
    const job = await this.queue.add(jobName, data, options);
    console.log(`📋 Job queued: ${jobName} (${job.id})`);
    return job;
  }

  /**
   * Get job by ID
   */
  async getJob(jobId: string): Promise<Job | null> {
    return this.queue.getJob(jobId);
  }

  /**
   * Get all jobs for a customer
   */
  async getCustomerJobs(customerId: string): Promise<Job[]> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaiting(),
      this.queue.getActive(),
      this.queue.getCompleted(),
      this.queue.getFailed(),
    ]);

    const allJobs = [...waiting, ...active, ...completed, ...failed];
    return allJobs.filter(job => job.data.customerId === customerId);
  }

  /**
   * Get queue statistics
   */
  async getStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
      this.queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed,
    };
  }

  /**
   * Cancel pending deployment/update jobs for a customer
   * (Remove waiting/delayed jobs, but cannot stop actively processing jobs)
   */
  async cancelPendingDeploymentJobs(customerId: string): Promise<number> {
    const [waiting, delayed] = await Promise.all([
      this.queue.getWaiting(),
      this.queue.getDelayed(),
    ]);

    const pendingJobs = [...waiting, ...delayed].filter(job => 
      job.data.customerId === customerId &&
      (job.name === 'deploy-customer-stack' || job.name === 'update-customer-stack')
    );

    let cancelledCount = 0;
    for (const job of pendingJobs) {
      await job.remove();
      cancelledCount++;
      console.log(`🚫 Cancelled pending job: ${job.name} (${job.id})`);
    }

    return cancelledCount;
  }

  /**
   * Check if customer has active deployment jobs
   */
  async hasActiveDeploymentJobs(customerId: string): Promise<boolean> {
    const activeJobs = await this.queue.getActive();
    return activeJobs.some(job => 
      job.data.customerId === customerId &&
      (job.name === 'deploy-customer-stack' || job.name === 'update-customer-stack')
    );
  }

  /**
   * Retry failed job
   */
  async retryJob(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    await job.retry();
    console.log(`🔁 Job ${jobId} queued for retry`);
  }

  /**
   * Clean old jobs
   */
  async cleanOldJobs() {
    await Promise.all([
      this.queue.clean(7 * 24 * 3600 * 1000, 'completed'), // 7 days
      this.queue.clean(30 * 24 * 3600 * 1000, 'failed'), // 30 days
    ]);
    console.log('🧹 Old jobs cleaned');
  }

  /**
   * Setup event handlers
   */
  private setupEventHandlers() {
    // Add error handlers FIRST
    this.queue.on('error', (error) => {
      console.error('❌ Queue error:', error.message, error.stack);
      this.emit('queue:error', { error });
    });

    this.queue.on('waiting', (jobId) => {
      console.log(`⏳ Job ${jobId} waiting`);
    });

    this.queue.on('completed', (job, result) => {
      console.log(`✅ Job ${job.id} completed:`, result);
      this.emit('job:completed', { job, result });
    });

    this.queue.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} failed:`, err.message);
      this.emit('job:failed', { job, error: err });
    });

    this.queue.on('progress', (job, progress) => {
      console.log(`📊 Job ${job.id} progress: ${progress}%`);
      this.emit('job:progress', { job, progress });
    });

    this.queue.on('active', (job) => {
      console.log(`▶️  Job ${job.id} started`);
      this.emit('job:active', { job });
    });

    this.queue.on('stalled', (job) => {
      console.warn(`⚠️  Job ${job.id} stalled`);
      this.emit('job:stalled', { job });
    });
  }

  /**
   * Get the Bull queue instance (for worker)
   */
  getQueue(): Queue {
    return this.queue;
  }

  /**
   * Close queue connection
   */
  async close(): Promise<void> {
    await this.queue.close();
    console.log('🔌 Deployment queue closed');
  }
}

// Export singleton instance
export const deploymentQueue = new DeploymentQueue();
