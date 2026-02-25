import Bull, { Queue, Job, JobOptions } from 'bull';
import { EventEmitter } from 'events';

interface DeploymentJobData {
  customerId: string;
  email: string;
  companyName: string;
  licenseKey: string;
  namespace?: string;
  priority?: number;
  metadata?: Record<string, any>;
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

export class DeploymentQueue extends EventEmitter {
  private queue: Queue;

  constructor() {
    super();

    // Initialize Bull queue with Redis connection
    this.queue = new Bull('customer-deployments', {
      redis: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        password: process.env.REDIS_PASSWORD,
        db: parseInt(process.env.REDIS_DB || '0'),
      },
      defaultJobOptions: {
        attempts: parseInt(process.env.QUEUE_MAX_RETRIES || '3'),
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
