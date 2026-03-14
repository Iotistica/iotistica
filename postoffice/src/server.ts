/**
 * PostOffice Service - Standalone Email Microservice
 * 
 * Queue-based email delivery service with support for:
 * - SMTP
 * - AWS SES
 * - Template rendering with Handlebars
 * - Bull queue for reliable delivery
 * - REST API for sending emails
 * - Bull Board UI for queue monitoring
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import Queue from 'bull';
import Redis from 'ioredis';
import { createBullBoard } from '@bull-board/api';
import { BullAdapter } from '@bull-board/api/bullAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { PostOffice } from './index';
import logger from './utils/logger';
import { EmailConfig } from './types';

const app = express();
const PORT = parseInt(process.env.PORT || '3300');
const HOST = process.env.HOST || '0.0.0.0';

// Middleware
app.use(cors());
app.use(express.json());

// Email configuration
const emailConfig: EmailConfig = {
  enabled: process.env.EMAIL_ENABLED !== 'false',
  from: process.env.EMAIL_FROM || '"Iotistica Platform" <noreply@iotistica.com>',
  debug: process.env.EMAIL_DEBUG === 'true',
};

// Configure transport based on environment
if (process.env.SMTP_HOST) {
  emailConfig.smtp = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
    },
  };
} else if (process.env.AWS_SES_REGION) {
  emailConfig.ses = {
    region: process.env.AWS_SES_REGION,
    sourceArn: process.env.AWS_SES_SOURCE_ARN,
    fromArn: process.env.AWS_SES_FROM_ARN,
  };
}

// Initialize PostOffice
const baseUrl = process.env.BASE_URL || 'https://iotistica.com';
const postOffice = new PostOffice(emailConfig, logger, baseUrl);

// Initialize Redis for Bull queue
const redisConfig = {
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  maxRetriesPerRequest: null,
};

const emailQueue = new Queue('email', {
  redis: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: false,
    removeOnFail: false,
  },
});

// Process email queue
emailQueue.process(async (job) => {
  const { user, templateName, context } = job.data;
  logger.info(`Processing email job`, {
    jobId: job.id,
    template: templateName,
    to: user.email,
  });

  try {
    await postOffice.send(user, templateName, context);

    logger.info(`Email sent successfully`, {
      jobId: job.id,
      template: templateName,
      to: user.email,
    });
  } catch (error: any) {
    logger.error(`Failed to send email`, {
      jobId: job.id,
      template: templateName,
      to: user.email,
      error: error.message,
    });
    throw error;
  }
});

// Queue event handlers
emailQueue.on('completed', (job) => {
  logger.debug(`Email job completed`, { jobId: job.id });
});

emailQueue.on('failed', (job, err) => {
  logger.warn(`Email job failed`, {
    jobId: job?.id,
    error: err.message,
    attempts: job?.attemptsMade,
  });
});

// Setup Bull Board UI
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullAdapter(emailQueue)],
  serverAdapter: serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    service: 'postoffice',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    email: {
      enabled: postOffice.isEnabled(),
      settings: postOffice.getSettings(),
    },
  });
});

// Readiness check
app.get('/ready', async (req: Request, res: Response) => {
  try {
    // Check Redis connection
    const redisClient = new Redis(redisConfig);
    await redisClient.ping();
    redisClient.disconnect();

    res.json({
      status: 'ready',
      email: postOffice.isEnabled(),
      queue: 'connected',
    });
  } catch (error: any) {
    logger.error('Readiness check failed', { error: error.message });
    res.status(503).json({
      status: 'not ready',
      error: error.message,
    });
  }
});

// Send email endpoint
app.post('/api/email/send', async (req: Request, res: Response) => {
  try {
    const { user, templateName, context } = req.body;

    if (!user || !user.email) {
      return res.status(400).json({ error: 'User with email is required' });
    }

    if (!templateName) {
      return res.status(400).json({ error: 'Template name is required' });
    }

    // Add to queue
    const job = await emailQueue.add({
      user,
      templateName,
      context: context || {},
    });

    res.json({
      message: 'Email queued successfully',
      jobId: job.id,
    });
  } catch (error: any) {
    logger.error('Failed to queue email', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get queue stats
app.get('/api/email/stats', async (req: Request, res: Response) => {
  try {
    const [waiting, active, completed, failed] = await Promise.all([
      emailQueue.getWaitingCount(),
      emailQueue.getActiveCount(),
      emailQueue.getCompletedCount(),
      emailQueue.getFailedCount(),
    ]);

    res.json({
      queue: {
        waiting,
        active,
        completed,
        failed,
        total: waiting + active + completed + failed,
      },
      email: {
        enabled: postOffice.isEnabled(),
        settings: postOffice.getSettings(true),
      },
    });
  } catch (error: any) {
    logger.error('Failed to get queue stats', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Get failed jobs
app.get('/api/email/failed', async (req: Request, res: Response) => {
  try {
    const failed = await emailQueue.getFailed();
    res.json({
      count: failed.length,
      jobs: failed.map((job) => ({
        id: job.id,
        data: job.data,
        failedReason: job.failedReason,
        attemptsMade: job.attemptsMade,
        timestamp: job.timestamp,
      })),
    });
  } catch (error: any) {
    logger.error('Failed to get failed jobs', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Retry failed job
app.post('/api/email/retry/:jobId', async (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = await emailQueue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    await job.retry();
    res.json({ message: 'Job queued for retry', jobId });
  } catch (error: any) {
    logger.error('Failed to retry job', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

// Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({
    service: 'iotistic-postoffice',
    version: '1.0.0',
    description: 'Standalone email service with queue processing',
    endpoints: {
      health: '/health',
      ready: '/ready',
      send: 'POST /api/email/send',
      stats: '/api/email/stats',
      failed: '/api/email/failed',
      retry: 'POST /api/email/retry/:jobId',
      queueUI: '/admin/queues',
    },
  });
});

// 404 handler
app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: any, req: Request, res: Response, next: any) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

// Graceful shutdown
async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`${signal} signal received, starting graceful shutdown...`);

  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    // Close queue
    await emailQueue.close();
    logger.info('Email queue closed');

    // Close postoffice
    await postOffice.close();
    logger.info('PostOffice closed');

    // Close database (if needed in future)
    // await closeDatabase();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error: any) {
    logger.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }
}

// Start server
let server: any;

async function startServer(): Promise<void> {
  try {
    logger.info('Starting PostOffice service...');

    // Test Redis connection
    const redisClient = new Redis(redisConfig);
    await redisClient.ping();
    redisClient.disconnect();
    logger.info('Redis connection successful');

    // Start HTTP server
    server = app.listen(PORT, HOST, () => {
      logger.info(`PostOffice service started`, {
        port: PORT,
        host: HOST,
        environment: process.env.NODE_ENV || 'production',
        emailEnabled: postOffice.isEnabled(),
      });
    });

    // Setup shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error: any) {
    logger.error('Failed to start server', {
      error: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

// Start the service
startServer();
