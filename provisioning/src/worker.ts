/**
 * Deployment Worker Entry Point
 * Processes Bull queue jobs for customer provisioning
 */

import dotenv from 'dotenv';
import { testConnection } from './db/connection';
import { LicenseGenerator } from './services/license-generator';
import { deploymentWorker } from './workers/deployment-worker';
import { logger } from './utils/logger';

// Load environment variables
dotenv.config();

async function start() {
  try {
    logger.info('🚀 Starting Workers...');

    // Test database connection
    await testConnection();
    logger.info('✅ Database connected');

    // Initialize license generator (load RSA keys)
    LicenseGenerator.init();
    logger.info('✅ License generator initialized');

    // Start deployment worker
    await deploymentWorker.start();
    logger.info('✅ Deployment worker started and listening for jobs');

    // Log configuration
    logger.info('Worker Configuration', {
      gitOpsEnabled: process.env.GITOPS_ENABLED === 'true',
      queueConcurrency: process.env.QUEUE_CONCURRENCY || '3',
      maxRetries: process.env.QUEUE_MAX_RETRIES || '5',
      retryDelay: process.env.QUEUE_RETRY_DELAY || '60000',
    });

  } catch (error: any) {
    logger.error('❌ Failed to start worker', { error: error.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('📴 SIGTERM received, shutting down gracefully...');
  await deploymentWorker.stop();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('📴 SIGINT received, shutting down gracefully...');
  await deploymentWorker.stop();
  process.exit(0);
});

start();
