/**
 * Idempotency Key Management
 * 
 * Provides idempotency key caching for provisioning endpoints.
 * Ensures safe retries of provisioning requests without duplicate device creation.
 */

import { redisClient } from '../redis/client';
import logger from './logger';

const redis = redisClient;

/**
 * Cache idempotency key with response
 * TTL: 24 hours to handle retries over extended periods
 */
export async function cacheIdempotencyKey(
  idempotencyKey: string,
  response: any,
  ttlSeconds: number = 24 * 60 * 60
): Promise<void> {
  try {
    const key = `idempotency:${idempotencyKey}`;
    const redisClient = await redis.getClient();
    await redisClient.setex(key, ttlSeconds, JSON.stringify(response));
    logger.debug(`Cached idempotency key: ${key}`);
  } catch (error: any) {
    logger.error('Failed to cache idempotency key:', error);
    // Don't throw - idempotency is a nice-to-have, not critical
  }
}

/**
 * Check if idempotency key has been processed
 * Returns cached response if found
 */
export async function checkIdempotencyKey(idempotencyKey: string): Promise<any | null> {
  try {
    const key = `idempotency:${idempotencyKey}`;
    const redisClient = await redis.getClient();
    const cached = await redisClient.get(key);
    
    if (cached) {
      logger.info(`Idempotency key hit: ${key}`);
      return JSON.parse(cached);
    }
    
    return null;
  } catch (error: any) {
    logger.error('Failed to check idempotency key:', error);
    // Don't throw - proceed with normal flow if cache check fails
    return null;
  }
}

/**
 * Cache provisioning challenge for proof-of-possession
 * TTL: 5 minutes - challenge should be used immediately
 */
export async function cacheProvisioningChallenge(
  uuid: string,
  challenge: string,
  ttlSeconds: number = 5 * 60
): Promise<void> {
  try {
    const key = `challenge:${uuid}`;
    const redisClient = await redis.getClient();
    await redisClient.setex(key, ttlSeconds, challenge);
    logger.debug(`Cached provisioning challenge for device: ${uuid.substring(0, 8)}`);
  } catch (error: any) {
    logger.error('Failed to cache provisioning challenge:', error);
  }
}

/**
 * Retrieve and verify provisioning challenge
 */
export async function getProvisioningChallenge(uuid: string): Promise<string | null> {
  try {
    const key = `challenge:${uuid}`;
    const redisClient = await redis.getClient();
    const challenge = await redisClient.get(key);
    
    if (challenge) {
      // Delete challenge after retrieval (one-time use)
      await redisClient.del(key);
      logger.debug(`Retrieved and deleted provisioning challenge for device: ${uuid.substring(0, 8)}`);
    }
    
    return challenge;
  } catch (error: any) {
    logger.error('Failed to retrieve provisioning challenge:', error);
    return null;
  }
}
