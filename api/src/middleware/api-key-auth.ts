/**
 * API Key Authentication Middleware
 * Validates service-level API keys from api_keys table
 * Used for internal service-to-service communication (e.g., Node-RED storage)
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/connection';
import logger from '../utils/logger';

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

    const keyRecord = result.rows[0];

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
      description: keyRecord.description
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
