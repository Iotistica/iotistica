/**
 * MQTT Metrics Routes
 * Fetches MQTT broker metrics from database (populated by mqtt-monitor service)
 */

import crypto from 'crypto';
import type { FastifyPluginAsync } from 'fastify';
import msgpack from 'msgpackr';
import zlib from 'zlib';
import { pool } from '../db/connection';
import { jwtAuth } from '../middleware/jwt-auth';
import { logger } from '../utils/logger';

interface TopicsQuerystring {
  limit?: string;
  offset?: string;
  deviceId?: string;
  decompress?: string;
}

interface StatsHistoryQuerystring {
  limit?: string;
}

interface TopicLookupQuerystring {
  topic?: string;
}

interface DecompressBody {
  message?: Buffer | string;
}

interface MqttStatsRow {
  connected_clients: number | null;
  subscriptions: number | null;
  retained_messages: number | null;
  messages_sent: number | null;
  messages_received: number | null;
  sys_data: Record<string, unknown> | null;
  message_rate_published: string | number | null;
  message_rate_received: string | number | null;
  throughput_inbound: string | number | null;
  throughput_outbound: string | number | null;
  timestamp: string;
}

interface MqttTopicRow {
  topic_id: string;
  topic: string;
  message_type: string | null;
  schema: Record<string, unknown> | null;
  last_message: string | null;
  message_count: number;
  qos: number;
  retain: boolean;
  first_seen: string;
  last_seen: string;
}

interface CountRow {
  count: string;
}

interface TopicSchemaRow {
  topic: string;
  schema: Record<string, unknown> | null;
  message_type: string | null;
  first_seen: string;
  last_seen: string;
}

interface MqttAclTopicRow {
  id: number;
  username: string | null;
  clientid: string | null;
  topic: string;
  access: number;
  priority: number;
  created_at: string;
}

const authOnly = { preHandler: [jwtAuth] };

function deserializePayload(message: Buffer | string): unknown {
  let buffer: Buffer;

  if (typeof message === 'string') {
    try {
      buffer = Buffer.from(message, 'base64');
      if (buffer.toString('base64') !== message) {
        buffer = Buffer.from(message, 'utf-8');
      }
    } catch {
      buffer = Buffer.from(message, 'utf-8');
    }
  } else {
    buffer = message;
  }

  if (buffer.length >= 2) {
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    if (firstByte === 0x78 && (secondByte === 0x01 || secondByte === 0x5e || secondByte === 0x9c || secondByte === 0xda)) {
      try {
        logger.debug('DEFLATE-compressed payload detected, decompressing', {
          originalSize: buffer.length,
          header: [firstByte, secondByte],
        });
        buffer = zlib.inflateSync(buffer);
      } catch (error) {
        logger.warn('DEFLATE decompression failed, treating as raw payload', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (buffer.length > 0) {
    const firstByte = buffer[0];
    if ((firstByte >= 0x90 && firstByte <= 0x9f) || firstByte === 0xdc || firstByte === 0xdd || (firstByte >= 0x80 && firstByte <= 0x8f)) {
      try {
        return msgpack.decode(buffer);
      } catch {
        // Fall through to JSON parsing.
      }
    }
  }

  try {
    return JSON.parse(buffer.toString('utf-8'));
  } catch {
    return buffer.toString('utf-8');
  }
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/mqtt/stats', authOnly, async (_req, reply) => {
    try {
      const result = await pool.query<MqttStatsRow>('SELECT * FROM mqtt_broker_stats ORDER BY timestamp DESC LIMIT 1');

      if (result.rows.length === 0) {
        return reply.send({
          success: true,
          stats: {
            connected: false,
            clients: 0,
            subscriptions: 0,
            retainedMessages: 0,
            totalMessagesSent: 0,
            totalMessagesReceived: 0,
            systemStats: {},
            messageRate: { published: 0, received: 0 },
            throughput: { inbound: 0, outbound: 0 },
          },
        });
      }

      const row = result.rows[0];
      return reply.send({
        success: true,
        stats: {
          connected: true,
          clients: row.connected_clients || 0,
          subscriptions: row.subscriptions || 0,
          retainedMessages: row.retained_messages || 0,
          totalMessagesSent: row.messages_sent || 0,
          totalMessagesReceived: row.messages_received || 0,
          systemStats: row.sys_data || {},
          messageRate: {
            published: parseFloat(String(row.message_rate_published || 0)) || 0,
            received: parseFloat(String(row.message_rate_received || 0)) || 0,
          },
          throughput: {
            inbound: parseFloat(String(row.throughput_inbound || 0)) || 0,
            outbound: parseFloat(String(row.throughput_outbound || 0)) || 0,
          },
          timestamp: row.timestamp,
        },
      });
    } catch (error) {
      logger.error('Error fetching MQTT metrics from database:', error);
      return reply.status(503).send({
        error: 'Failed to fetch MQTT metrics',
        message: error instanceof Error ? error.message : 'Unknown error',
        connected: false,
      });
    }
  });

  fastify.get<{ Querystring: TopicsQuerystring }>('/mqtt/topics', authOnly, async (req, reply) => {
    try {
      const limit = parseInt(req.query.limit || '100', 10) || 100;
      const offset = parseInt(req.query.offset || '0', 10) || 0;
      const deviceId = req.query.deviceId;
      const decompress = req.query.decompress === 'true';

      let topicsQuery = `SELECT 
          topic_id,
          topic,
          message_type,
          schema,
          last_message,
          message_count,
          qos,
          retain,
          first_seen,
          last_seen
         FROM mqtt_topics`;
      let countQuery = 'SELECT COUNT(*) FROM mqtt_topics';
      const queryParams: Array<string | number> = [];

      if (deviceId) {
        topicsQuery += ' WHERE topic LIKE $1';
        countQuery += ' WHERE topic LIKE $1';
        queryParams.push(`%/device/${deviceId}/%`);
      }

      topicsQuery += ` ORDER BY last_seen DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
      queryParams.push(limit, offset);

      const result = await pool.query<MqttTopicRow>(topicsQuery, queryParams);
      const countResult = await pool.query<CountRow>(countQuery, deviceId ? [`%/device/${deviceId}/%`] : []);
      const totalCount = parseInt(countResult.rows[0].count, 10);

      const topics = result.rows.map((row) => {
        let lastMessage = row.last_message;

        if (decompress && lastMessage) {
          try {
            const buffer = lastMessage.startsWith('base64:')
              ? Buffer.from(lastMessage.substring(7), 'base64')
              : Buffer.from(lastMessage, 'latin1');
            const decompressed = deserializePayload(buffer);
            lastMessage = typeof decompressed === 'string' ? decompressed : JSON.stringify(decompressed, null, 2);
          } catch (error) {
            logger.warn('Failed to decompress message for topic', {
              topic: row.topic,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return {
          topicId: row.topic_id,
          topic: row.topic,
          messageType: row.message_type,
          schema: row.schema,
          lastMessage,
          messageCount: row.message_count,
          qos: row.qos,
          retain: row.retain,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        };
      });

      return reply.send({
        success: true,
        data: {
          topics,
          count: topics.length,
          total: totalCount,
          limit,
          offset,
        },
      });
    } catch (error) {
      logger.error('Error fetching MQTT topics from database:', error);
      return reply.status(503).send({
        error: 'Failed to fetch MQTT topics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Body: DecompressBody }>('/mqtt/decompress', authOnly, async (req, reply) => {
    try {
      const { message } = req.body;

      if (!message) {
        return reply.status(400).send({ error: 'Message is required' });
      }

      let buffer: Buffer;
      if (Buffer.isBuffer(message)) {
        buffer = message;
      } else if (typeof message === 'string') {
        try {
          buffer = Buffer.from(message, 'base64');
        } catch {
          buffer = Buffer.from(message, 'hex');
        }
      } else {
        return reply.status(400).send({ error: 'Invalid message format' });
      }

      const decompressed = deserializePayload(buffer);
      return reply.send({
        decompressed,
        originalSize: buffer.length,
        decompressedSize: JSON.stringify(decompressed).length,
        type: typeof decompressed,
      });
    } catch (error) {
      logger.error('Error decompressing MQTT message:', error);
      return reply.status(500).send({
        error: 'Failed to decompress message',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Querystring: StatsHistoryQuerystring }>('/mqtt/stats/history', authOnly, async (req, reply) => {
    try {
      const limit = parseInt(req.query.limit || '30', 10) || 30;
      const result = await pool.query<MqttStatsRow>(
        `SELECT * FROM mqtt_broker_stats
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit],
      );

      const history = result.rows.map((row) => ({
        timestamp: row.timestamp,
        clients: row.connected_clients || 0,
        subscriptions: row.subscriptions || 0,
        messageRate: {
          published: parseFloat(String(row.message_rate_published || 0)) || 0,
          received: parseFloat(String(row.message_rate_received || 0)) || 0,
        },
        throughput: {
          inbound: parseFloat(String(row.throughput_inbound || 0)) || 0,
          outbound: parseFloat(String(row.throughput_outbound || 0)) || 0,
        },
      })).reverse();

      return reply.send({
        success: true,
        count: history.length,
        history,
      });
    } catch (error) {
      logger.error('Error fetching MQTT stats history from database:', error);
      return reply.status(503).send({
        success: false,
        error: 'Failed to fetch MQTT stats history',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Querystring: TopicLookupQuerystring }>('/mqtt/topics/schema', authOnly, async (req, reply) => {
    try {
      const topic = req.query.topic;

      if (!topic) {
        return reply.status(400).send({
          success: false,
          error: 'Topic query parameter is required',
        });
      }

      const result = await pool.query<TopicSchemaRow>(
        `SELECT 
          topic,
          schema,
          message_type,
          first_seen,
          last_seen
         FROM mqtt_topics
         WHERE topic = $1`,
        [topic],
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'Schema not available for this topic',
        });
      }

      const row = result.rows[0];
      if (!row.schema) {
        return reply.status(404).send({
          success: false,
          error: 'No schema available yet. Schema is generated after analyzing message patterns.',
        });
      }

      const schemaHash = crypto.createHash('md5').update(JSON.stringify(row.schema)).digest('hex');

      return reply.send({
        success: true,
        data: {
          topic: row.topic,
          schema: row.schema,
          messageType: row.message_type,
          schemaVersion: 1,
          schemaConfidence: 1.0,
          schemaSampleCount: 0,
          schemaHash,
          firstSeen: row.first_seen,
          lastSeen: row.last_seen,
        },
      });
    } catch (error) {
      logger.error('Error fetching topic schema from database:', error);
      return reply.status(503).send({
        success: false,
        error: 'Failed to fetch topic schema',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Querystring: TopicLookupQuerystring }>('/mqtt/topics/acls', authOnly, async (req, reply) => {
    try {
      const topic = req.query.topic;

      if (!topic) {
        return reply.status(400).send({
          success: false,
          error: 'Topic query parameter is required',
        });
      }

      const result = await pool.query<MqttAclTopicRow>(
        `SELECT 
          id,
          username,
          clientid,
          topic,
          access,
          priority,
          created_at
         FROM mqtt_acls
         ORDER BY priority DESC, created_at DESC`,
      );

      const matchingAcls = result.rows.filter((row) => {
        const pattern = row.topic;
        if (pattern === topic) {
          return true;
        }

        if (pattern.includes('#') && !pattern.endsWith('#')) {
          return false;
        }

        const regexPattern = pattern
          .replace(/\+/g, '[^/]+')
          .replace(/#$/, '.*')
          .replace(/([.?*+^$[\]\\(){}|-])/g, '\\$1');

        try {
          return new RegExp(`^${regexPattern}$`).test(topic);
        } catch (error) {
          logger.warn('Invalid ACL pattern', { pattern, error });
          return false;
        }
      });

      const acls = matchingAcls.map((row) => ({
        id: row.id,
        username: row.username || '*',
        clientId: row.clientid || '*',
        topic: row.topic,
        access: row.access,
        accessLabel: row.access === 1 ? 'Subscribe' : row.access === 2 ? 'Publish' : 'Publish + Subscribe',
        priority: row.priority,
        createdAt: row.created_at,
      }));

      return reply.send({
        success: true,
        data: {
          topic,
          count: acls.length,
          acls,
        },
      });
    } catch (error) {
      logger.error('Error fetching topic ACLs from database:', error);
      return reply.status(503).send({
        success: false,
        error: 'Failed to fetch topic ACLs',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
};

export default plugin;