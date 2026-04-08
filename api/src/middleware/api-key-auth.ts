/**
 * API Key Authentication Middleware
 * Validates service-level API keys from api_keys table
 * Used for internal service-to-service communication (e.g., Node-RED storage)
 */

import crypto from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/connection';
import logger from '../utils/logger';

type ApiKeyRow = {
  id: number;
  name: string;
  description: string | null;
  is_active: boolean;
  expires_at: string | null;
};

const API_KEY_CACHE_TTL_SECONDS = parseInt(process.env.API_KEY_AUTH_CACHE_TTL_SECONDS || '60', 10);

function getApiKeyCacheKey(apiKey: string): string {
  const digest = crypto.createHash('sha256').update(apiKey).digest('hex');
  return `auth:api-key:${digest}`;
}

async function getRedisCacheClient() {
  try {
    const { redisClient } = await import('../redis/client');
    if (!redisClient.isReady()) {
      return null;
    }
    return redisClient.getClient();
  } catch (error) {
    logger.debug('API key cache unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getApiKeyFromCache(apiKey: string): Promise<ApiKeyRow | null> {
  try {
    const client = await getRedisCacheClient();
    if (!client) {
      return null;
    }

    const cached = await client.get(getApiKeyCacheKey(apiKey));
    if (!cached) {
      return null;
    }

    return JSON.parse(cached) as ApiKeyRow;
  } catch (error) {
    logger.debug('API key cache read failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function storeApiKeyInCache(apiKey: string, keyRecord: ApiKeyRow): Promise<void> {
  try {
    const client = await getRedisCacheClient();
    if (!client) {
      return;
    }

    await client.setex(
      getApiKeyCacheKey(apiKey),
      API_KEY_CACHE_TTL_SECONDS,
      JSON.stringify(keyRecord),
    );
  } catch (error) {
    logger.debug('API key cache write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function invalidateApiKeyCache(apiKey: string): Promise<void> {
  try {
    const client = await getRedisCacheClient();
    if (!client) {
      return;
    }

    await client.del(getApiKeyCacheKey(apiKey));
  } catch (error) {
    logger.debug('API key cache invalidation failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Validates API key from Authorization header.
 * Expects: Authorization: Bearer <api-key>
 *
 * Usage:
 *   fastify.get('/protected', { preHandler: [validateApiKey] }, handler)
 */
export async function validateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  try {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key required. Use Authorization: Bearer <api-key>'
      });
    }

    const apiKey = authHeader.substring(7);

    if (!apiKey || apiKey.length < 32) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid API key format'
      });
    }

    let keyRecord = await getApiKeyFromCache(apiKey);

    if (!keyRecord) {
      const result = await query(
        `SELECT id, name, description, is_active, expires_at
         FROM api_keys
         WHERE key = $1`,
        [apiKey]
      );

      if (result.rows.length === 0) {
        logger.warn('Invalid API key attempted', {
          keyPrefix: apiKey.substring(0, 8),
          ip: request.ip,
          path: request.url
        });
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'Invalid API key'
        });
      }

      keyRecord = result.rows[0] as ApiKeyRow;
      await storeApiKeyInCache(apiKey, keyRecord);
    }

    if (!keyRecord.is_active) {
      logger.warn('Inactive API key attempted', {
        keyId: keyRecord.id,
        keyName: keyRecord.name,
        ip: request.ip
      });
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'API key is inactive'
      });
    }

    if (keyRecord.expires_at) {
      const expiresAt = new Date(keyRecord.expires_at);
      if (expiresAt < new Date()) {
        logger.warn('Expired API key attempted', {
          keyId: keyRecord.id,
          keyName: keyRecord.name,
          expiresAt: keyRecord.expires_at
        });
        return reply.status(401).send({
          error: 'Unauthorized',
          message: 'API key has expired'
        });
      }
    }

    // Fire-and-forget last_used_at update
    query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [keyRecord.id]
    ).catch(err => {
      logger.error('Failed to update API key last_used_at', { error: err.message, keyId: keyRecord.id });
    });

    request.apiKey = {
      id: keyRecord.id,
      name: keyRecord.name,
      description: keyRecord.description ?? ''
    };

    logger.debug('API key validated', { keyId: keyRecord.id, keyName: keyRecord.name, path: request.url });

  } catch (error: any) {
    logger.error('API key validation error', { error: error.message, stack: error.stack });
    return reply.status(500).send({
      error: 'Internal Server Error',
      message: 'Failed to validate API key'
    });
  }
}

/**
 * Optional API key validation — proceeds without authentication if no key is provided.
 */
export async function optionalApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return;
  await validateApiKey(request, reply);
}
