import logger from '../utils/logger';
import { getRedisClient } from '../redis/client-factory';
import { redisDeviceQueue } from '../services';

async function connectSharedRedisClient(): Promise<void> {
  const client = getRedisClient();

  if (client.status === 'ready') {
    logger.info('Redis already connected');
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onReady = () => {
      client.off('error', onError);
      resolve();
    };

    const onError = (err: Error) => {
      client.off('ready', onReady);
      reject(err);
    };

    client.once('ready', onReady);
    client.once('error', onError);
  });
}

export async function bootstrapIngestionRedis(): Promise<void> {
  try {
    await connectSharedRedisClient();
    logger.info('[OK] Redis client connected successfully');
  } catch (error) {
    logger.warn('Redis connection failed - continuing without real-time features', {
      error: error instanceof Error ? error.message : String(error),
      note: 'This is non-critical - metrics will use PostgreSQL only',
    });
  }

  try {
    await redisDeviceQueue.startWorker();
    logger.info('Redis device queue worker started');
  } catch (error) {
    logger.error('Failed to start Redis device queue worker', { error });
    process.exit(1);
  }
}