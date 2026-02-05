/**
 * MQTT Database Service
 * Handles persistent storage of MQTT topics, schemas, and statistics
 */

import { Pool } from 'pg';
import crypto from 'crypto';

export interface MQTTTopicRecord {
  id?: number;
  topicId?: string;  // UUID
  topic: string;
  messageType?: 'json' | 'xml' | 'string' | 'binary';
  schema?: any;
  lastMessage?: string;
  messageCount: number;
  qos?: number;
  retain?: boolean;
  firstSeen?: Date;
  lastSeen?: Date;
}

export interface BrokerStatsRecord {
  connectedClients?: number;
  disconnectedClients?: number;
  totalClients?: number;
  subscriptions?: number;
  retainedMessages?: number;
  messagesSent?: number;
  messagesReceived?: number;
  messagesPublished?: number;
  messagesDropped?: number;
  bytesSent?: number;
  bytesReceived?: number;
  messageRatePublished?: number;
  messageRateReceived?: number;
  throughputInbound?: number;
  throughputOutbound?: number;
  sysData?: any;
}

export interface TopicMetrics {
  topic: string;
  messageCount: number;
  bytesReceived: number;
  messageRate?: number;
  avgMessageSize?: number;
}

export class MQTTDatabaseService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Upsert topic with schema and metadata
   * @returns topic_id UUID
   */
  async upsertTopic(data: MQTTTopicRecord): Promise<string> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO mqtt_topics (
          topic, message_type, schema, last_message, message_count, qos, retain
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (topic) 
        DO UPDATE SET
          message_type = COALESCE(EXCLUDED.message_type, mqtt_topics.message_type),
          schema = COALESCE(EXCLUDED.schema, mqtt_topics.schema),
          last_message = EXCLUDED.last_message,
          message_count = EXCLUDED.message_count,
          qos = COALESCE(EXCLUDED.qos, mqtt_topics.qos),
          retain = COALESCE(EXCLUDED.retain, mqtt_topics.retain),
          last_seen = NOW(),
          updated_at = NOW()
        RETURNING topic_id`,
        [
          data.topic,
          data.messageType,
          data.schema ? JSON.stringify(data.schema) : null,
          data.lastMessage,
          data.messageCount || 1,
          data.qos,
          data.retain,
        ]
      );
      return result.rows[0].topic_id;
    } finally {
      client.release();
    }
  }

  /**
   * Batch upsert multiple topics (more efficient)
   * @returns Map of topic name to topic_id UUID
   */
  async batchUpsertTopics(topics: MQTTTopicRecord[]): Promise<Map<string, string>> {
    const topicIdMap = new Map<string, string>();
    if (topics.length === 0) return topicIdMap;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      for (const topic of topics) {
        const result = await client.query(
          `INSERT INTO mqtt_topics (
            topic, message_type, schema, last_message, message_count, qos, retain
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (topic) 
          DO UPDATE SET
            message_type = COALESCE(EXCLUDED.message_type, mqtt_topics.message_type),
            schema = COALESCE(EXCLUDED.schema, mqtt_topics.schema),
            last_message = EXCLUDED.last_message,
            message_count = EXCLUDED.message_count,
            qos = COALESCE(EXCLUDED.qos, mqtt_topics.qos),
            retain = COALESCE(EXCLUDED.retain, mqtt_topics.retain),
            last_seen = NOW(),
            updated_at = NOW()
          RETURNING topic_id`,
          [
            topic.topic,
            topic.messageType,
            topic.schema ? JSON.stringify(topic.schema) : null,
            topic.lastMessage,
            topic.messageCount || 1,
            topic.qos,
            topic.retain,
          ]
        );
        topicIdMap.set(topic.topic, result.rows[0].topic_id);
      }

      await client.query('COMMIT');
      return topicIdMap;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get all topics from database
   */
  async getTopics(options?: {
    messageType?: string;
    hasSchema?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<MQTTTopicRecord[]> {
    let query = 'SELECT * FROM mqtt_topics WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (options?.messageType) {
      query += ` AND message_type = $${paramIndex++}`;
      params.push(options.messageType);
    }

    if (options?.hasSchema !== undefined) {
      query += options.hasSchema
        ? ` AND schema IS NOT NULL`
        : ` AND schema IS NULL`;
    }

    query += ' ORDER BY last_seen DESC';

    if (options?.limit) {
      query += ` LIMIT $${paramIndex++}`;
      params.push(options.limit);
    }

    if (options?.offset) {
      query += ` OFFSET $${paramIndex++}`;
      params.push(options.offset);
    }

    const result = await this.pool.query(query, params);
    return result.rows.map(row => ({
      ...row,
      schema: row.schema,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      messageCount: row.message_count,
      messageType: row.message_type,
      lastMessage: row.last_message,
    }));
  }

  /**
   * Get topic by name
   */
  async getTopicByName(topic: string): Promise<MQTTTopicRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM mqtt_topics WHERE topic = $1',
      [topic]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...row,
      topicId: row.topic_id,
      schema: row.schema,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      messageCount: row.message_count,
      messageType: row.message_type,
      lastMessage: row.last_message,
    };
  }

  /**
   * Get topic by topic_id UUID
   */
  async getTopicById(topicId: string): Promise<MQTTTopicRecord | null> {
    const result = await this.pool.query(
      'SELECT * FROM mqtt_topics WHERE topic_id = $1',
      [topicId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...row,
      topicId: row.topic_id,
      schema: row.schema,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      messageCount: row.message_count,
      messageType: row.message_type,
      lastMessage: row.last_message,
    };
  }

  /**
   * Save schema history (for tracking schema evolution)
   */
  async saveSchemaHistory(
    topic: string,
    schema: any,
    sampleMessage?: string
  ): Promise<void> {
    const schemaStr = JSON.stringify(schema);
    const schemaHash = crypto.createHash('md5').update(schemaStr).digest('hex');

    // Check if this exact schema already exists
    const existing = await this.pool.query(
      'SELECT id FROM mqtt_schema_history WHERE topic = $1 AND schema_hash = $2',
      [topic, schemaHash]
    );

    if (existing.rows.length === 0) {
      // Get topic_id from mqtt_topics
      const topicRecord = await this.pool.query(
        'SELECT topic_id FROM mqtt_topics WHERE topic = $1',
        [topic]
      );
      
      const topicId = topicRecord.rows[0]?.topic_id;
      
      await this.pool.query(
        `INSERT INTO mqtt_schema_history (topic, topic_id, schema, schema_hash, sample_message)
         VALUES ($1, $2, $3, $4, $5)`,
        [topic, topicId, schema, schemaHash, sampleMessage]
      );
    }
  }

  /**
   * Get schema history for a topic
   */
  async getSchemaHistory(topic: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT schema, detected_at, sample_message 
       FROM mqtt_schema_history 
       WHERE topic = $1 
       ORDER BY detected_at DESC`,
      [topic]
    );

    return result.rows.map(row => ({
      schema: row.schema,
      detectedAt: row.detected_at,
      sampleMessage: row.sample_message,
    }));
  }

  /**
   * Save broker statistics snapshot
   */
  async saveBrokerStats(stats: BrokerStatsRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO mqtt_broker_stats (
        connected_clients, disconnected_clients, total_clients, subscriptions, retained_messages,
        messages_sent, messages_received, messages_published, messages_dropped,
        bytes_sent, bytes_received,
        message_rate_published, message_rate_received,
        throughput_inbound, throughput_outbound,
        sys_data
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        stats.connectedClients,
        stats.disconnectedClients,
        stats.totalClients,
        stats.subscriptions,
        stats.retainedMessages,
        stats.messagesSent,
        stats.messagesReceived,
        stats.messagesPublished,
        stats.messagesDropped,
        stats.bytesSent,
        stats.bytesReceived,
        stats.messageRatePublished,
        stats.messageRateReceived,
        stats.throughputInbound,
        stats.throughputOutbound,
        stats.sysData ? JSON.stringify(stats.sysData) : null,
      ]
    );
  }

  /**
   * Get latest broker stats
   */
  async getLatestBrokerStats(): Promise<BrokerStatsRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM mqtt_broker_stats ORDER BY timestamp DESC LIMIT 1`
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      connectedClients: row.connected_clients,
      disconnectedClients: row.disconnected_clients,
      totalClients: row.total_clients,
      subscriptions: row.subscriptions,
      retainedMessages: row.retained_messages,
      messagesSent: row.messages_sent,
      messagesReceived: row.messages_received,
      messagesPublished: row.messages_published,
      messagesDropped: row.messages_dropped,
      bytesSent: row.bytes_sent,
      bytesReceived: row.bytes_received,
      messageRatePublished: parseFloat(row.message_rate_published),
      messageRateReceived: parseFloat(row.message_rate_received),
      throughputInbound: parseFloat(row.throughput_inbound),
      throughputOutbound: parseFloat(row.throughput_outbound),
      sysData: row.sys_data,
    };
  }

  /**
   * Get broker stats history
   */
  async getBrokerStatsHistory(
    hours: number = 24
  ): Promise<BrokerStatsRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM mqtt_broker_stats 
       WHERE timestamp > NOW() - INTERVAL '1 hour' * $1
       ORDER BY timestamp ASC`,
      [hours]
    );

    return result.rows.map(row => ({
      connectedClients: row.connected_clients,
      subscriptions: row.subscriptions,
      messageRatePublished: parseFloat(row.message_rate_published),
      messageRateReceived: parseFloat(row.message_rate_received),
      throughputInbound: parseFloat(row.throughput_inbound),
      throughputOutbound: parseFloat(row.throughput_outbound),
    }));
  }

  /**
   * Save topic metrics
   */
  async saveTopicMetrics(metrics: TopicMetrics): Promise<void> {
    // Get topic_id from mqtt_topics
    const topicRecord = await this.pool.query(
      'SELECT topic_id FROM mqtt_topics WHERE topic = $1',
      [metrics.topic]
    );
    
    const topicId = topicRecord.rows[0]?.topic_id;
    
    await this.pool.query(
      `INSERT INTO mqtt_topic_metrics (
        topic, topic_id, message_count, bytes_received, message_rate, avg_message_size
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        metrics.topic,
        topicId,
        metrics.messageCount,
        metrics.bytesReceived,
        metrics.messageRate,
        metrics.avgMessageSize,
      ]
    );
  }

  /**
   * Batch save schema history (more efficient than individual calls)
   */
  async saveSchemaHistoryBatch(items: Array<{
    topic: string;
    schema: any;
    exampleMessage?: string;
  }>): Promise<void> {
    if (items.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get all topic_ids in one query
      const topicNames = items.map(item => item.topic);
      const topicIdsResult = await client.query(
        'SELECT topic, topic_id FROM mqtt_topics WHERE topic = ANY($1)',
        [topicNames]
      );
      
      const topicIdMap = new Map<string, string>();
      topicIdsResult.rows.forEach(row => {
        topicIdMap.set(row.topic, row.topic_id);
      });

      // Prepare values for batch insert
      const valuesToInsert: any[] = [];
      for (const item of items) {
        // Validate and debug schema
        if (!item.schema) {
          console.warn('Schema is null/undefined, skipping:', { topic: item.topic });
          continue;
        }
        
        if (typeof item.schema === 'string') {
          // Schema was already stringified - try to parse it
          try {
            item.schema = JSON.parse(item.schema);
            console.log('Parsed stringified schema for:', item.topic);
          } catch (err) {
            console.error('Invalid JSON string schema:', { 
              topic: item.topic, 
              schema: item.schema.substring(0, 100) 
            });
            continue;
          }
        }
        
        if (typeof item.schema !== 'object') {
          console.warn('Schema is not an object after parsing:', { 
            topic: item.topic, 
            schemaType: typeof item.schema,
            schemaValue: String(item.schema).substring(0, 100)
          });
          continue;
        }
        
        const schemaStr = JSON.stringify(item.schema);
        const schemaHash = crypto.createHash('md5').update(schemaStr).digest('hex');
        const topicId = topicIdMap.get(item.topic);
        
        // Check if this schema+topic combo already exists
        const existing = await client.query(
          'SELECT id FROM mqtt_schema_history WHERE topic = $1 AND schema_hash = $2',
          [item.topic, schemaHash]
        );
        
        if (existing.rows.length === 0) {
          valuesToInsert.push({
            topic: item.topic,
            topicId,
            schema: item.schema, // Keep as object for PostgreSQL JSON column
            schemaHash,
            sampleMessage: item.exampleMessage || null
          });
        }
      }

      // Batch insert new schema history records
      if (valuesToInsert.length > 0) {
        const values = valuesToInsert.map((v, idx) => {
          const base = idx * 5;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        }).join(', ');

        const params = valuesToInsert.flatMap(v => [
          v.topic,
          v.topicId,
          v.schema, // Pass object directly - pg driver handles JSON conversion
          v.schemaHash,
          v.sampleMessage
        ]);

        await client.query(
          `INSERT INTO mqtt_schema_history (topic, topic_id, schema, schema_hash, sample_message)
           VALUES ${values}`,
          params
        );
      }

      await client.query('COMMIT');
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('Batch schema history save failed:', {
        error: error.message,
        itemCount: items.length
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Batch save topic metrics (more efficient than individual calls)
   */
  async saveTopicMetricsBatch(items: Array<TopicMetrics>): Promise<void> {
    if (items.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get all topic_ids in one query
      const topicNames = items.map(item => item.topic);
      const topicIdsResult = await client.query(
        'SELECT topic, topic_id FROM mqtt_topics WHERE topic = ANY($1)',
        [topicNames]
      );
      
      const topicIdMap = new Map<string, string>();
      topicIdsResult.rows.forEach(row => {
        topicIdMap.set(row.topic, row.topic_id);
      });

      // Batch insert metrics
      const values = items.map((_, idx) => {
        const base = idx * 6;
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      }).join(', ');

      const params = items.flatMap(item => [
        item.topic,
        topicIdMap.get(item.topic),
        item.messageCount,
        item.bytesReceived,
        item.messageRate,
        item.avgMessageSize
      ]);

      await client.query(
        `INSERT INTO mqtt_topic_metrics (
          topic, topic_id, message_count, bytes_received, message_rate, avg_message_size
        ) VALUES ${values}`,
        params
      );

      await client.query('COMMIT');
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error('Batch topic metrics save failed:', {
        error: error.message,
        itemCount: items.length
      });
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get statistics summary
   */
  async getStatsSummary(): Promise<any> {
    const result = await this.pool.query(`
      SELECT 
        COUNT(*) as total_topics,
        COUNT(CASE WHEN schema IS NOT NULL THEN 1 END) as topics_with_schemas,
        COUNT(CASE WHEN message_type = 'json' THEN 1 END) as json_topics,
        COUNT(CASE WHEN message_type = 'xml' THEN 1 END) as xml_topics,
        COUNT(CASE WHEN message_type = 'string' THEN 1 END) as string_topics,
        COUNT(CASE WHEN message_type = 'binary' THEN 1 END) as binary_topics,
        SUM(message_count) as total_messages,
        MAX(last_seen) as last_activity
      FROM mqtt_topics
    `);

    return result.rows[0];
  }

  /**
   * Get recent message counts for topics (time-windowed)
   * @param windowMinutes - Time window in minutes (default: 15)
   * @returns Array of topics with recent message counts
   */
  async getRecentMessageCounts(windowMinutes: number = 15): Promise<Array<{
    topic: string;
    messageCount: number;
    messageRate: number;
    windowMinutes: number;
    oldestTimestamp: Date;
    latestTimestamp: Date;
  }>> {
    const result = await this.pool.query(`
      WITH recent_metrics AS (
        SELECT 
          topic,
          message_count,
          timestamp,
          LAG(message_count) OVER (PARTITION BY topic ORDER BY timestamp) as prev_message_count,
          LAG(timestamp) OVER (PARTITION BY topic ORDER BY timestamp) as prev_timestamp
        FROM mqtt_topic_metrics
        WHERE timestamp >= NOW() - INTERVAL '${windowMinutes} minutes'
      ),
      topic_activity AS (
        SELECT 
          topic,
          MAX(message_count) - MIN(message_count) as message_count,
          MIN(timestamp) as oldest_timestamp,
          MAX(timestamp) as latest_timestamp,
          EXTRACT(EPOCH FROM (MAX(timestamp) - MIN(timestamp))) / 60.0 as actual_window_minutes
        FROM recent_metrics
        WHERE message_count IS NOT NULL
        GROUP BY topic
      )
      SELECT 
        topic,
        message_count,
        CASE 
          WHEN actual_window_minutes > 0 
          THEN ROUND((message_count / actual_window_minutes)::numeric, 2)
          ELSE 0
        END as message_rate,
        $1 as window_minutes,
        oldest_timestamp,
        latest_timestamp
      FROM topic_activity
      WHERE message_count > 0
      ORDER BY message_count DESC
    `, [windowMinutes]);

    return result.rows.map(row => ({
      topic: row.topic,
      messageCount: parseInt(row.message_count),
      messageRate: parseFloat(row.message_rate),
      windowMinutes: windowMinutes,
      oldestTimestamp: row.oldest_timestamp,
      latestTimestamp: row.latest_timestamp,
    }));
  }

  /**
   * Get recent message counts for a specific topic
   * @param topicOrId - Topic name or topic_id UUID
   * @param windowMinutes - Time window in minutes (default: 15)
   */
  async getTopicRecentActivity(topicOrId: string, windowMinutes: number = 15): Promise<{
    topic: string;
    messageCount: number;
    messageRate: number;
    dataPoints: Array<{ timestamp: Date; count: number }>;
  } | null> {
    // Detect if it's a UUID or topic name
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(topicOrId);
    
    const whereClause = isUuid ? 'topic_id = $1' : 'topic = $1';
    
    const result = await this.pool.query(`
      SELECT 
        topic,
        message_count,
        timestamp
      FROM mqtt_topic_metrics
      WHERE ${whereClause}
        AND timestamp >= NOW() - INTERVAL '${windowMinutes} minutes'
      ORDER BY timestamp ASC
    `, [topicOrId]);

    if (result.rows.length === 0) {
      return null;
    }

    const dataPoints = result.rows.map(row => ({
      timestamp: row.timestamp,
      count: parseInt(row.message_count),
    }));

    const oldestCount = dataPoints[0].count;
    const latestCount = dataPoints[dataPoints.length - 1].count;
    const messageCount = Math.max(0, latestCount - oldestCount);
    const messageRate = messageCount / windowMinutes;

    return {
      topic: result.rows[0].topic,
      messageCount,
      messageRate: Math.round(messageRate * 100) / 100,
      dataPoints,
    };
  }

  /**
   * Load initial state from database (on service restart)
   */
  async loadInitialState(): Promise<{
    topics: MQTTTopicRecord[];
    stats: BrokerStatsRecord | null;
  }> {
    const topics = await this.getTopics({ limit: 10000 });
    const stats = await this.getLatestBrokerStats();

    return { topics, stats };
  }

  /**
   * Cleanup old data
   */
  async cleanupOldData(retentionDays: number = 30): Promise<number> {
    const result = await this.pool.query(
      'SELECT cleanup_old_mqtt_metrics($1)',
      [retentionDays]
    );

    return result.rows[0].cleanup_old_mqtt_metrics;
  }
}
