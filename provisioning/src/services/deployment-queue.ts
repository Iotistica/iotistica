import Bull, { Queue, Job, JobOptions } from 'bull';
import { EventEmitter } from 'events';
import IORedis, { RedisOptions } from 'ioredis';

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
  private redisClients: Map<string, IORedis> = new Map();

  constructor() {
    super();

    // Initialize Bull queue with Redis connection (Azure-compatible)
    // Note: Azure Redis with clustering is accessed as a single endpoint (standalone mode)
    // Azure handles sharding internally - no Redis Cluster protocol needed from client
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379');
    const password = process.env.REDIS_PASSWORD || undefined;
    const db = parseInt(process.env.REDIS_DB || '0');
    
    const tlsFlag = (process.env.REDIS_TLS || process.env.REDIS_USE_TLS || process.env.REDIS_TLS_ENABLED || '')
      .toLowerCase();
    const useTls = tlsFlag === 'true' || tlsFlag === '1' || tlsFlag === 'yes';

    console.log(`🔐 Redis Config: host=${host}, port=${port}, db=${db}, tls=${useTls}, password=${password ? '***' : 'none'}`);

    const baseRedisOptions: RedisOptions = {
      host,
      port,
      password,
      db,
      tls: useTls
        ? {
            servername: host,
            rejectUnauthorized: true,
          }
        : undefined,
      enableOfflineQueue: true,
      enableAutoPipelining: true,
      connectTimeout: 20000,
      keepAlive: 30000,
      maxLoadingRetryTime: 30000,
      retryStrategy: (times: number) => {
        if (times > 20) {
          console.error(`❌ Redis retry strategy exhausted after ${times} attempts`);
          return null;
        }
        const delay = Math.min(times * 1000, 5000);
        console.warn(`⏳ Redis retry attempt ${times}, delaying ${delay}ms`);
        return delay;
      },
      reconnectOnError: (err: Error) => {
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
        const shouldReconnect = targetErrors.some(e => err.message?.toUpperCase().includes(e));
        console.warn(`🔄 Redis reconnectOnError check: ${err.message} -> should reconnect: ${shouldReconnect}`);
        return shouldReconnect;
      },
    };
    
    this.queue = new Bull('customer-deployments', {
      redis: {
        ...baseRedisOptions,
        host,
        port,
        password,
        db,
      },
      createClient: (type: 'client' | 'subscriber' | 'bclient', redisOpts: RedisOptions) => {
        console.log(`🔌 Creating Redis ${type} connection`);
        
        const redisInstance = new IORedis({
          ...baseRedisOptions,
          ...redisOpts,
          enableReadyCheck: type === 'client',
          // Bull uses blocking commands on bclient/subscriber; commandTimeout breaks those.
          commandTimeout: type === 'client' ? 30000 : undefined,
          maxRetriesPerRequest: type === 'client' ? 20 : null,
        });

        // Store reference for monitoring
        this.redisClients.set(type, redisInstance);

        // Add detailed connection logging
                // Log ALL commands sent to Redis (to catch timeout culprit)
                redisInstance.on('command', (args: any) => {
                  const cmd = args?.args?.[0];
                  if (cmd && cmd !== 'PING') {
                    console.log(`📤 Redis ${type} command: ${cmd}`);
                  }
                });

        redisInstance.on('connect', () => {
          console.log(`✅ Redis ${type} connected`);
        });

        redisInstance.on('ready', () => {
          console.log(`🟢 Redis ${type} ready`);
        });

        redisInstance.on('error', (err) => {
          console.error(`❌ Redis ${type} error:`, {
            message: err.message,
            code: (err as any).code,
            errno: (err as any).errno,
            stack: err.stack?.split('\n')[0],
          });
        });

        redisInstance.on('close', () => {
          console.log(`🔌 Redis ${type} closed`);
        });

        redisInstance.on('reconnecting', (delay: number) => {
          console.warn(`🔄 Redis ${type} reconnecting (delay ${delay}ms)`);
        });

        redisInstance.on('warn', (msg) => {
          console.warn(`⚠️  Redis ${type} warning:`, msg);
        });

        return redisInstance;
      },
      settings: {
        stalledInterval: 600000, // 10 minutes - reduce aggressive polling
        maxStalledCount: 10,
      },
      prefix: 'provisioning',
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

    // Event handlers and health-check timers are intentionally NOT started here.
    // Call enableConsumerMode() from the worker process to activate them.
    console.log('📋 DeploymentQueue ready (producer mode)');
  }

  /**
   * Enable consumer mode.
   * Must be called once from the worker process after start-up.
   * Sets up queue event handlers and periodic Redis/queue health-check logging.
   * The API process is a producer only and must NOT call this.
   */
  enableConsumerMode(): void {
    this.setupEventHandlers();
    // DISABLED: setupRedisHealthCheck() causes command timeouts in worker
    // The automatic health check (queue.count every 30s) times out even though 
    // Redis connection shows "ready". API works fine without it (manual /health calls).
    // this.setupRedisHealthCheck();
    console.log('🔧 DeploymentQueue consumer mode enabled');
  }

  /**
   * Add deployment job to queuedd
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
    this.queue.on('completed', (job, result) => {
      console.log(`✅ Job ${job.id} completed:`, result);
      this.emit('job:completed', { job, result });
    });

    this.queue.on('failed', (job, err) => {
      console.error(`❌ Job ${job.id} failed:`, {
        message: err.message,
        stack: err.stack?.split('\n')[0],
      });
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

    // Bull queue connection events
    this.queue.on('error', (err) => {
      console.error(`❌ Bull queue error:`, {
        message: err.message,
        code: (err as any).code,
        stack: err.stack?.split('\n')[0],
      });
    });

    this.queue.on('waiting', (jobId: any) => {
      console.log(`⏳ Job ${jobId} waiting`);
    });

    this.queue.on('removed', (job) => {
      console.log(`🗑️  Job ${job.id} removed`);
    });
  }

  /**
   * Setup Redis health check monitoring
   */
  private setupRedisHealthCheck() {
    // Check Redis connection every 30 seconds
    setInterval(async () => {
      try {
        const count = await this.queue.count();
        console.log(`📊 Bull Queue Health - Waiting: ${count} jobs`);

        // Check all Redis client connections
        for (const [type, client] of this.redisClients.entries()) {
          const status = client.status;
          console.log(`   Redis ${type}: ${status}`);
        }
      } catch (error) {
        console.error('❌ Redis health check failed:', {
          message: (error as any).message,
          code: (error as any).code,
        });
      }
    }, 30000);

    // Log queue stats periodically
    setInterval(async () => {
      try {
        const stats = await this.getStats();
        console.log(`📈 Queue Stats:`, {
          waiting: stats.waiting,
          active: stats.active,
          completed: stats.completed,
          failed: stats.failed,
          delayed: stats.delayed,
          total: stats.total,
        });
      } catch (error) {
        console.error('❌ Failed to get queue stats:', (error as any).message);
      }
    }, 60000);
  }

  /**
   * Get Redis connection status
   */
  async getRedisStatus(): Promise<Record<string, string>> {
    const status: Record<string, string> = {};
    
    for (const [type, client] of this.redisClients.entries()) {
      try {
        await client.ping();
        status[type] = `OK (${client.status})`;
      } catch (error) {
        status[type] = `ERROR: ${(error as any).message}`;
      }
    }

    return status;
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
