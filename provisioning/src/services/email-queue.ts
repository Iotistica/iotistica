/**
 * Email Queue Service
 * Manages Bull queue for email jobs (password reset, notifications, etc.)
 */

import Bull, { Queue, Job, JobOptions } from 'bull';
import { EventEmitter } from 'events';

export interface SendPasswordResetLinkJobData {
  customerId: string;
  email: string;
  clientId: string;
  resetLink: string;
  expiresAt: string; // ISO timestamp
}

export class EmailQueue extends EventEmitter {
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
    
    this.queue = new Bull('customer-emails', {
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
        // Note: maxRetriesPerRequest and enableReadyCheck are not compatible with Bull
        // Bull sets maxRetriesPerRequest to null internally
        enableOfflineQueue: true,
        connectTimeout: 20000, // 20s for Azure failover
        commandTimeout: 10000, // 10s for commands
        keepAlive: 30000,
      },
      settings: {
        // Stall interval for email jobs (faster than deployments)
        stalledInterval: 30000, // 30 seconds (default is 5s)
        maxStalledCount: 3, // Allow 3 stall events before giving up
      },
      prefix: 'provisioning', // Namespace Bull keys
      defaultJobOptions: {
        attempts: parseInt(process.env.QUEUE_EMAIL_MAX_RETRIES || '3'),
        backoff: {
          type: 'exponential',
          delay: parseInt(process.env.QUEUE_EMAIL_RETRY_DELAY || '30000'), // 30s
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
   * Queue password reset link email
   */
  async addPasswordResetLinkJob(
    data: SendPasswordResetLinkJobData,
    options?: JobOptions
  ): Promise<Job<SendPasswordResetLinkJobData>> {
    const job = await this.queue.add(
      'send-admin-password-reset-link',
      data,
      {
        priority: 5, // Medium priority
        jobId: `email-reset-${data.customerId}-${Date.now()}`,
        ...options,
      }
    );

    console.log(`📧 Email job queued: ${job.id} for customer ${data.customerId}`);
    console.log(`   Job Type: send-admin-password-reset-link`);
    console.log(`   Email: ${data.email}`);
    console.log(`   Reset Link: ${data.resetLink}`);
    console.log(`   Expires At: ${data.expiresAt}`);
    
    return job;
  }

  /**
   * Get the Bull queue instance (for worker)
   */
  getQueue(): Queue {
    return this.queue;
  }

  /**
   * Setup event handlers for queue state changes
   */
  private setupEventHandlers(): void {
    this.queue.on('active', (job) => {
      console.log(`📧 Email job started: ${job.id}`);
    });

    this.queue.on('completed', (job) => {
      console.log(`✅ Email job completed: ${job.id}`);
    });

    this.queue.on('failed', (job, error) => {
      console.error(`❌ Email job failed: ${job.id}`, error.message);
    });

    this.queue.on('error', (error) => {
      console.error(`❌ Email queue error:`, error);
    });

    this.queue.on('stalled', (job) => {
      console.warn(`⚠️  Email job stalled: ${job.id}`);
    });
  }

  /**
   * Clean up queue (for testing)
   */
  async close(): Promise<void> {
    await this.queue.close();
  }
}

// Singleton instance
export const emailQueue = new EmailQueue();
