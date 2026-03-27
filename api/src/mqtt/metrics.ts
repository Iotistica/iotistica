/**
 * MQTT Metrics Routes
 * Fetches MQTT broker metrics from database (populated by mqtt-monitor service)
 */

import express, { Router } from 'express';
import { pool } from '../db/connection';
import { logger } from '../utils/logger';
import zlib from 'zlib';
import msgpack from 'msgpack-lite';
import crypto from 'crypto';
import { jwtAuth } from '../middleware/jwt-auth';

const router = Router();

router.use (jwtAuth); // All routes require authentication

/**
 * Deserialize MQTT payload - auto-detects base64, DEFLATE, msgpack, or JSON format
 * @param message - Buffer or string payload (may be base64-encoded)
 * @returns Deserialized data object
 */
function deserializePayload(message: Buffer | string): any {
  let buffer: Buffer;
  
  // If string, check if it's base64-encoded (from mqtt-monitor storage)
  if (typeof message === 'string') {
    try {
      // Try to decode as base64 first
      buffer = Buffer.from(message, 'base64');
      
      // Validate it's actually base64 by checking if re-encoding matches
      if (buffer.toString('base64') === message) {
        logger.debug('Base64-encoded payload decoded', {
          base64Length: message.length,
          bufferLength: buffer.length
        });
      } else {
        // Not base64, treat as UTF-8 string
        buffer = Buffer.from(message, 'utf-8');
      }
    } catch (error) {
      // Failed to decode base64, treat as UTF-8
      buffer = Buffer.from(message, 'utf-8');
    }
  } else {
    buffer = message;
  }
  
  // Check for DEFLATE compression (zlib header: 0x78 0x9C or 0x78 0x01 or 0x78 0xDA)
  if (buffer.length >= 2) {
    const firstByte = buffer[0];
    const secondByte = buffer[1];
    
    // DEFLATE magic bytes: 0x78 followed by 0x01, 0x5E, 0x9C, 0xDA (different compression levels)
    if (firstByte === 0x78 && (secondByte === 0x01 || secondByte === 0x5E || secondByte === 0x9C || secondByte === 0xDA)) {
      try {
        logger.debug('DEFLATE-compressed payload detected, decompressing', {
          originalSize: buffer.length,
          header: [firstByte, secondByte]
        });
        
        // Decompress using zlib.inflateSync
        buffer = zlib.inflateSync(buffer);
        
        logger.debug('DEFLATE decompression successful', {
          compressedSize: typeof message === 'string' ? message.length : message.length,
          decompressedSize: buffer.length
        });
      } catch (error) {
        logger.warn('DEFLATE decompression failed, treating as raw payload', {
          error: error instanceof Error ? error.message : String(error)
        });
        // Keep buffer as-is if decompression fails
      }
    }
  }
  
  // Try MessagePack first (binary marker detection)
  if (buffer.length > 0) {
    const firstByte = buffer[0];
    // MessagePack markers: fixarray (0x90-0x9f), array16/32 (0xdc-0xdd), fixmap (0x80-0x8f)
    if ((firstByte >= 0x90 && firstByte <= 0x9f) || 
        firstByte === 0xdc || firstByte === 0xdd ||
        (firstByte >= 0x80 && firstByte <= 0x8f)) {
      try {
        return msgpack.decode(buffer);
      } catch {
        // Fall through to JSON if msgpack decode fails
      }
    }
  }
  
  // Try JSON parsing
  try {
    const str = buffer.toString('utf-8');
    return JSON.parse(str);
  } catch {
    // Return raw message if both msgpack and JSON fail
    return buffer.toString('utf-8');
  }
}

/**
 * GET /api/v1/mqtt/stats
 * Get latest MQTT broker stats from database
 */
router.get('/mqtt/stats', async (req, res) => {
  try {
    // Query latest broker stats from database
    const result = await pool.query(
      `SELECT * FROM mqtt_broker_stats ORDER BY timestamp DESC LIMIT 1`
    );

    if (result.rows.length === 0) {
      return res.json({
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
          throughput: { inbound: 0, outbound: 0 }
        }
      });
    }

    const row = result.rows[0];
    
    res.json({
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
          published: parseFloat(row.message_rate_published) || 0,
          received: parseFloat(row.message_rate_received) || 0
        },
        throughput: {
          inbound: parseFloat(row.throughput_inbound) || 0,
          outbound: parseFloat(row.throughput_outbound) || 0
        },
        timestamp: row.timestamp
      }
    });
  } catch (error: any) {
    logger.error('Error fetching MQTT metrics from database:', error);
    res.status(503).json({
      error: 'Failed to fetch MQTT metrics',
      message: error.message,
      connected: false
    });
  }
});

/**
 * GET /api/v1/mqtt/topics
 * Get MQTT topics from database
 * Query params:
 *   - limit: number (default 100)
 *   - offset: number (default 0)
 *   - deviceId: string (optional - filter by device UUID)
 *   - decompress: boolean (default false)
 */
router.get('/mqtt/topics', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = parseInt(req.query.offset as string) || 0;
    const deviceId = req.query.deviceId as string;

    // Build query with optional deviceId filter
    let query = `SELECT 
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
    const queryParams: any[] = [];
    
    if (deviceId) {
      query += ` WHERE topic LIKE $1`;
      countQuery += ` WHERE topic LIKE $1`;
      queryParams.push(`%/device/${deviceId}/%`);
    }
    
    query += ` ORDER BY last_seen DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    const result = await pool.query(query, queryParams);

    const countParams = deviceId ? [`%/device/${deviceId}/%`] : [];
    const countResult = await pool.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].count);

    // Check if decompression is requested
    const decompress = req.query.decompress === 'true';

    // Map database fields to camelCase for frontend
    const topics = result.rows.map((row: any) => {
      let lastMessage = row.last_message;
      
      // Decompress message if requested and message exists
      if (decompress && lastMessage) {
        try {
          // Check if message is base64-encoded (from mqtt-monitor binary storage)
          let buffer: Buffer;
          if (lastMessage.startsWith('base64:')) {
            // Decode base64-encoded binary payload
            buffer = Buffer.from(lastMessage.substring(7), 'base64');
          } else {
            // Legacy: try latin1 encoding (may be corrupted)
            buffer = Buffer.from(lastMessage, 'latin1');
          }
          
          const decompressed = deserializePayload(buffer);
          lastMessage = typeof decompressed === 'string' ? decompressed : JSON.stringify(decompressed, null, 2);
        } catch (error) {
          logger.warn('Failed to decompress message for topic', { 
            topic: row.topic, 
            error: error instanceof Error ? error.message : String(error)
          });
          // Keep original message if decompression fails
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
        lastSeen: row.last_seen
      };
    });

    res.json({
      success: true,
      data: {
        topics,
        count: topics.length,
        total: totalCount,
        limit,
        offset
      }
    });
  } catch (error: any) {
    logger.error('Error fetching MQTT topics from database:', error);
    res.status(503).json({
      error: 'Failed to fetch MQTT topics',
      message: error.message
    });
  }
});

/**
 * POST /api/v1/mqtt/decompress
 * Decompress DEFLATE+msgpack MQTT message
 * Body: { message: Buffer | string (base64 or hex) }
 */
router.post('/mqtt/decompress', async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Convert to Buffer if needed
    let buffer: Buffer;
    if (Buffer.isBuffer(message)) {
      buffer = message;
    } else if (typeof message === 'string') {
      // Try base64 first, then hex
      try {
        buffer = Buffer.from(message, 'base64');
      } catch {
        buffer = Buffer.from(message, 'hex');
      }
    } else {
      return res.status(400).json({ error: 'Invalid message format' });
    }

    const decompressed = deserializePayload(buffer);

    res.json({
      decompressed,
      originalSize: buffer.length,
      decompressedSize: JSON.stringify(decompressed).length,
      type: typeof decompressed
    });
  } catch (error: any) {
    logger.error('Error decompressing MQTT message:', error);
    res.status(500).json({
      error: 'Failed to decompress message',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/mqtt/stats/history
 * Get broker stats history from database
 */
router.get('/mqtt/stats/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 30;
    
    const result = await pool.query(
      `SELECT * FROM mqtt_broker_stats
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit]
    );

    // Transform to match frontend expectations
    const history = result.rows.map(row => ({
      timestamp: row.timestamp,
      clients: row.connected_clients || 0,
      subscriptions: row.subscriptions || 0,
      messageRate: {
        published: parseFloat(row.message_rate_published) || 0,
        received: parseFloat(row.message_rate_received) || 0
      },
      throughput: {
        inbound: parseFloat(row.throughput_inbound) || 0,
        outbound: parseFloat(row.throughput_outbound) || 0
      }
    })).reverse(); // Reverse to get chronological order

    res.json({
      success: true,
      count: history.length,
      history
    });
  } catch (error: any) {
    logger.error('Error fetching MQTT stats history from database:', error);
    res.status(503).json({
      success: false,
      error: 'Failed to fetch MQTT stats history',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/mqtt/topics/:topic/schema
 * Get JSON schema for a specific MQTT topic from database
 */
router.get('/mqtt/topics/:topic(*)/schema', async (req, res) => {
  try {
    const topic = req.params.topic;
    
    const result = await pool.query(
      `SELECT 
        topic,
        schema,
        message_type,
        first_seen,
        last_seen
       FROM mqtt_topics
       WHERE topic = $1`,
      [topic]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Schema not available for this topic'
      });
    }

    const row = result.rows[0];
    
    if (!row.schema) {
      return res.status(404).json({
        success: false,
        error: 'No schema available yet. Schema is generated after analyzing message patterns.'
      });
    }

    // Calculate schema hash from the schema JSON
    const schemaStr = JSON.stringify(row.schema);
    const schemaHash = crypto.createHash('md5').update(schemaStr).digest('hex');

    res.json({
      success: true,
      data: {
        topic: row.topic,
        schema: row.schema,
        messageType: row.message_type,
        // Note: version/confidence/sampleCount are in-memory only in mqtt-monitor
        // Database only stores the schema JSON
        schemaVersion: 1,  // Default since not persisted
        schemaConfidence: 1.0,  // Default since not persisted
        schemaSampleCount: 0,  // Default since not persisted
        schemaHash: schemaHash,
        firstSeen: row.first_seen,
        lastSeen: row.last_seen
      }
    });
  } catch (error: any) {
    logger.error('Error fetching topic schema from database:', error);
    res.status(503).json({
      success: false,
      error: 'Failed to fetch topic schema',
      message: error.message
    });
  }
});

/**
 * GET /api/v1/mqtt/topics/:topic/acls
 * Get ACL rules for a specific MQTT topic from database
 */
router.get('/mqtt/topics/:topic(*)/acls', async (req, res) => {
  try {
    const topic = req.params.topic;
    
    // Fetch all ACLs and filter in-memory using proper MQTT topic matching
    const result = await pool.query(
      `SELECT 
        id,
        username,
        clientid,
        topic,
        access,
        priority,
        created_at
       FROM mqtt_acls
       ORDER BY priority DESC, created_at DESC`
    );

    // Filter ACLs that match the requested topic using MQTT pattern matching
    const matchingAcls = result.rows.filter(row => {
      const pattern = row.topic;
      
      // Exact match
      if (pattern === topic) return true;
      
      // Convert MQTT pattern to regex
      // Replace + with [^/]+ (matches one level)
      // Replace # with .* (matches zero or more levels, but only at end)
      const regexPattern = pattern
        .replace(/\+/g, '[^/]+')           // + matches exactly one level (non-slash chars)
        .replace(/#$/, '.*')               // # at end matches zero or more levels
        .replace(/([.?*+^$[\]\\(){}|-])/g, '\\$1'); // Escape other regex chars (except our replacements)
      
      // # must be at the end of the pattern (MQTT spec)
      if (pattern.includes('#') && !pattern.endsWith('#')) {
        return false;
      }
      
      try {
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(topic);
      } catch (error) {
        logger.warn('Invalid ACL pattern', { pattern, error });
        return false;
      }
    });

    const acls = matchingAcls.map(row => ({
      id: row.id,
      username: row.username || '*',  // NULL means all users
      clientId: row.clientid || '*',  // NULL means all clients
      topic: row.topic,
      access: row.access,
      accessLabel: row.access === 1 ? 'Subscribe' : row.access === 2 ? 'Publish' : 'Publish + Subscribe',
      priority: row.priority,
      createdAt: row.created_at
    }));

    res.json({
      success: true,
      data: {
        topic,
        count: acls.length,
        acls
      }
    });
  } catch (error: any) {
    logger.error('Error fetching topic ACLs from database:', error);
    res.status(503).json({
      success: false,
      error: 'Failed to fetch topic ACLs',
      message: error.message
    });
  }
});

export default router;
