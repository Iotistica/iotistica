/**
 * Unified MQTT Monitoring Service
 * Combines topic tree, metrics, and schema generation
 * Based on Cedalo MQTT Management Center architecture
 * 
 * Features:
 * - Hierarchical topic tree with message counts
 * - Automatic JSON schema generation for payloads
 * - Real-time broker statistics from $SYS topics
 * - Message rate tracking (published/received)
 * - Network throughput monitoring
 * - Client and subscription trackingddd
 */

import mqtt, { MqttClient } from 'mqtt';
import { EventEmitter } from 'events';
import isUtf8 from 'is-utf8';
import { MQTTDatabaseService } from './db';
import logger from '../utils/logger';

// Update interval for metrics (milliseconds)
const METRICS_UPDATE_INTERVAL = parseInt(process.env.MQTT_METRICS_UPDATE_INTERVAL || '5000');
const TOPIC_TREE_UPDATE_INTERVAL = parseInt(process.env.MQTT_TOPIC_TREE_UPDATE_INTERVAL || '5000');

/**
 * JSON Schema Structure
 */
interface JSONSchema {
  type: string;
  properties?: Record<string, any>;
  items?: any;
}

/**
 * Topic Tree Node Structure
 */
interface TopicNode {
  _name: string;
  _topic: string;
  _topicId?: string;  // UUID from database
  _created: number;
  _lastModified?: number;
  _messagesCounter: number;
  _sessionCounter?: number; 
  _topicsCounter: number;
  _message?: string;
  _messageType?: 'json' | 'xml' | 'string' | 'binary';
  _schema?: JSONSchema;
  _cmd?: string;
  _dup?: boolean;
  _retain?: boolean;
  _qos?: number;
  [key: string]: any; // Child nodes
}

/**
 * Broker Statistics Structure (from $SYS topics)
 */
interface BrokerStats {
  _name: string;
  $SYS?: {
    broker?: {
      messages?: {
        sent?: string;
        received?: string;
        stored?: string;
      };
      subscriptions?: {
        count?: string;
      };
      clients?: {
        connected?: string;
        total?: string;
        maximum?: string;
      };
      load?: {
        messages?: {
          sent?: {
            '1min'?: string;
            '5min'?: string;
            '15min'?: string;
          };
          received?: {
            '1min'?: string;
            '5min'?: string;
            '15min'?: string;
          };
        };
        bytes?: {
          sent?: {
            '1min'?: string;
            '5min'?: string;
            '15min'?: string;
          };
          received?: {
            '1min'?: string;
            '5min'?: string;
            '15min'?: string;
          };
        };
      };
      'retained messages'?: {
        count?: string;
      };
    };
  };
}

/**
 * Calculated Metrics
 */
interface CalculatedMetrics {
  messageRate: {
    published: number[];  // Last 15 measurements
    received: number[];   // Last 15 measurements
    current: {
      published: number;
      received: number;
    };
  };
  throughput: {
    inbound: number[];   // KB/s history
    outbound: number[];  // KB/s history
    current: {
      inbound: number;   // KB/s
      outbound: number;  // KB/s
    };
  };
  clients: number;
  subscriptions: number;
  retainedMessages: number;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  timestamp: number;
}

interface MonitorOptions {
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId?: string;
  topicTreeEnabled?: boolean;
  metricsEnabled?: boolean;
  schemaGenerationEnabled?: boolean;
  persistToDatabase?: boolean;
  dbSyncInterval?: number; // How often to sync to DB (ms)
}

/**
 * Schema Generator - Generates JSON schemas from payloads
 */
class SchemaGenerator {
  private static getObjectType(obj: any): string {
    let type: string = typeof obj;
    if (type === 'object') {
      if (Array.isArray(obj)) {
        type = 'array';
      } else if (obj === null) {
        type = 'null';
      }
    }
    return type;
  }

  private static handleArray(obj: any[]): JSONSchema {
    const schema: JSONSchema = { type: 'array' };
    
    if (obj.length === 0) return schema;

    let arrayType: string | undefined;
    let multipleTypes = false;
    let itemsSchema: any;

    for (let i = 0; i < obj.length; i++) {
      const elementSchema = this.generateSchema(obj[i]);
      const elementType = elementSchema.type;

      if (i > 0 && elementType !== arrayType) {
        multipleTypes = true;
        break;
      } else {
        arrayType = elementType;
        if (elementType === 'object') {
          if (!itemsSchema) {
            itemsSchema = elementSchema;
          } else {
            const keys = Object.keys(elementSchema.properties || {});
            keys.forEach(key => {
              if (!itemsSchema.properties![key]) {
                itemsSchema.properties![key] = elementSchema.properties![key];
              }
            });
          }
        } else {
          itemsSchema = this.generateSchema(obj[i]);
        }
      }
    }

    if (!multipleTypes && arrayType) {
      schema.items = itemsSchema;
    }

    return schema;
  }

  private static handleObject(obj: Record<string, any>): JSONSchema {
    const schema: JSONSchema = {
      type: 'object',
      properties: {}
    };

    for (const [key, value] of Object.entries(obj)) {
      schema.properties![key] = this.generateSchema(value);
    }

    return schema;
  }

  static generateSchema(obj: any): JSONSchema {
    const type = this.getObjectType(obj);
    
    switch (type) {
      case 'object':
        return this.handleObject(obj);
      case 'array':
        return this.handleArray(obj);
      default:
        return { type };
    }
  }
}

/**
 * MQTT Topic Tree & Metrics Monitor
 * Tracks topic hierarchy and broker statistics in real-time
 */
export class MQTTMonitorService extends EventEmitter {
  private client: MqttClient | null = null;
  private options: MonitorOptions;
  private connected = false;
  private stopped = true;
  private dbService?: any; // MQTTDatabaseService instance

  // Topic Tree
  private topicTree: TopicNode;
  private topicTreeUpdateInterval?: NodeJS.Timeout;
  private lastTopicTreeUpdate = 0;

  // System Stats ($SYS topics)
  private systemStats: BrokerStats;
  private metricsUpdateInterval?: NodeJS.Timeout;
  private dbSyncInterval?: NodeJS.Timeout;

  // Calculated Metrics
  private metrics: CalculatedMetrics;
  private lastMetricsSnapshot = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesSent: 0,
    bytesReceived: 0,
    timestamp: Date.now()
  };

  // Track changes for batch DB updates
  private pendingTopicUpdates: Set<string> = new Set();

  constructor(options: MonitorOptions, dbService?: any) {
    super();
    this.options = {
      topicTreeEnabled: true,
      metricsEnabled: true,
      schemaGenerationEnabled: true,
      persistToDatabase: false,
      dbSyncInterval: 30000, // 30 seconds default
      ...options
    };
    this.dbService = dbService;

    // Initialize topic tree
    this.topicTree = {
      _name: 'root',
      _topic: '',
      _created: Date.now(),
      _messagesCounter: 0,
      _topicsCounter: 0
    };

    // Initialize system stats
    this.systemStats = {
      _name: 'broker'
    };

    // Initialize metrics
    this.metrics = {
      messageRate: {
        published: Array(15).fill(0),
        received: Array(15).fill(0),
        current: { published: 0, received: 0 }
      },
      throughput: {
        inbound: Array(15).fill(0),
        outbound: Array(15).fill(0),
        current: { inbound: 0, outbound: 0 }
      },
      clients: 0,
      subscriptions: 0,
      retainedMessages: 0,
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      timestamp: Date.now()
    };
  }


    static async initialize(dbPool: any): Promise<{
    instance: MQTTMonitorService;
    dbService: MQTTDatabaseService | null;
  }> {
    const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
    const username = process.env.MQTT_USERNAME;
    const password = process.env.MQTT_PASSWORD;
    const persistToDatabase = process.env.MQTT_PERSIST_DB !== 'false';
    const dbSyncInterval = parseInt(process.env.MQTT_DB_SYNC_INTERVAL || '30000');

    let dbService: MQTTDatabaseService | null = null;

    try {
      if (persistToDatabase) {
        dbService = new MQTTDatabaseService(dbPool);
      }

      const monitor = new MQTTMonitorService(
        {
          brokerUrl,
          username,
          password,
          topicTreeEnabled: true,
          metricsEnabled: true,
          schemaGenerationEnabled: true,
          persistToDatabase,
          dbSyncInterval,
        },
        dbService
      );

      monitor.on('connected', () => {
        logger.info(`MQTT Monitor connected to broker at ${brokerUrl}`);
      });

      monitor.on('error', (error) => {
        logger.error('MQTT Monitor error', { error: error.message });
      });

      await monitor.start();
      logger.info('MQTT Monitor Service started');

      return { instance: monitor, dbService };
    } catch (err: any) {
        logger.error('Failed to start MQTT Monitor', { error: err.message || err });
        logger.info('Retrying initialization every 15s...');
        this.retryInitialization(dbPool);
        return { instance: null as any, dbService };
    }
  }

  private static retryInitialization(dbPool: any, intervalMs: number = 15000): void {
  const timer = setInterval(async () => {
    try {
      const { instance } = await this.initialize(dbPool);
      if (instance) {
        logger.info('MQTT reconnected successfully');
        clearInterval(timer); // clear the correct interval
      }
    } catch (err: any) {
      logger.warn(`MQTT still unavailable (${err?.message || err})`);
    }
  }, intervalMs);
}

  /**
   * Start the monitoring service
   */
  async start(): Promise<void> {
    if (this.client) {
      await this.stop();
    }

    this.stopped = false;

    // Load state from database if persistence is enabled
    if (this.options.persistToDatabase && this.dbService) {
      await this.loadStateFromDatabase();
    }

    await this.connect();

    // Start periodic database sync if enabled
    if (this.options.persistToDatabase && this.dbService) {
      this.startDatabaseSync();
    }
  }

  /**
   * Connect to MQTT broker
   */
  private async connect(): Promise<void> {
    const mqttOptions: mqtt.IClientOptions = {
      clientId: this.options.clientId || `mqtt-monitor`,
      username: this.options.username,
      password: this.options.password,
      reconnectPeriod: 5000
    };

    logger.info(`Connecting to ${this.options.brokerUrl}...`);

    this.client = mqtt.connect(this.options.brokerUrl, mqttOptions);

    this.client.on('connect', () => {
      this.connected = true;
      logger.info(`Connected to ${this.options.brokerUrl}`);
      this.emit('connected');

      // Reset per-session counters
      this.resetSessionCounters();

      // Subscribe to all topics for topic tree
      if (this.options.topicTreeEnabled) {
        this.client!.subscribe('#', (err) => {
          if (err) {
            logger.error('Failed to subscribe to all topics', { error: err.message });
          } else {
            logger.info('Subscribed to all topics (#)');
          }
        });
      }

      // Subscribe to $SYS topics for metrics
      if (this.options.metricsEnabled) {
        this.client!.subscribe('$SYS/#', (err) => {
          if (err) {
            logger.error('Failed to subscribe to $SYS topics', { error: err.message });
          } else {
            logger.info('Subscribed to $SYS topics');
          }
        });
      }

      // Start metric calculation
      this.startMetricsCalculation();
    });

    this.client.on('error', (error) => {
      logger.error('MQTT error', { error: error.message });
      this.emit('error', error);
    });

    this.client.on('close', () => {
      logger.info('Connection closed');
      this.connected = false;
    });

  this.client.on('message', (topic, payload, packet) => {
    // Ignore $SYS messages for topic tree (still handle system stats)
    if (topic.startsWith('$SYS/')) {
        this.updateSystemStats(topic, payload.toString());
        return;
    }

    // Optionally ignore retained messages to avoid counting retained payloads on connect.
    // If you *want* to count retained deliveries as messages, remove/disable the next block.
    // if (packet && packet.retain) {
    //   return;
    // }

    if (this.options.topicTreeEnabled) {
        this.updateTopicTree(topic, payload, packet);
    }
    });

  }

  /**
   * Update system statistics from $SYS topics
   */
  private updateSystemStats(topic: string, message: string): void {
    const parts = topic.split('/');
    let current: any = this.systemStats;

    parts.forEach((part, index) => {
      if (!current[part]) {
        current[part] = {};
      }
      if (index + 1 === parts.length) {
        // Last part - store the value
        current[part] = message;
      }
      current = current[part];
    });

    // Emit event for real-time updates
    this.emit('system-stats-updated', this.systemStats);
  }

  /**
   * Update topic tree with new message (includes schema generation)
   */
 private updateTopicTree(topic: string, payload: Buffer, packet: any): void {
  // Individual topics track their own message counts (do NOT increment root)
  const parts = topic.split('/');
  let current: any = this.topicTree;
  let newTopic = false;

  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const isLeaf = index === parts.length - 1;
    const topicPath = parts.slice(0, index + 1).join('/');

    // Ensure node exists
    if (!current[part]) {
      current[part] = {
        _name: part,
        _topic: topicPath,
        _created: Date.now(),
        _messagesCounter: 0, // start at 0
        _topicsCounter: 0
      };
      newTopic = true;
    }

    // update lastModified for all nodes on the path
    current[part]._lastModified = Date.now();

    // Only increment the counter for the leaf (exact topic)
    if (isLeaf) {
      // safety: reset if approaching 32-bit signed int overflow
      if (typeof current[part]._messagesCounter === 'number' &&
          current[part]._messagesCounter >= 2147483640) {
        logger.warn(`Overflow threshold reached for ${topicPath}. Resetting counter.`);
        current[part]._messagesCounter = 0;
      }

      current[part]._messagesCounter = (current[part]._messagesCounter || 0) + 1;
      current[part]._sessionCounter = (current[part]._sessionCounter || 0) + 1;

      // debug: warn if number is absurdly large
      if (current[part]._messagesCounter > 1_000_000) {
        logger.warn(`High message count for ${topicPath}`, { count: current[part]._messagesCounter });
      }
    }

    // if leaf store message details
    if (isLeaf) {
      const messageStr = payload.toString();
      current[part]._message = messageStr;
      current[part]._cmd = packet?.cmd;
      current[part]._dup = packet?.dup;
      current[part]._retain = packet?.retain;
      current[part]._qos = packet?.qos;

      if (this.options.schemaGenerationEnabled) {
        if (isUtf8(payload)) {
          if (messageStr.startsWith('<') && messageStr.endsWith('>')) {
            current[part]._messageType = 'xml';
          } else {
            try {
              const json = JSON.parse(messageStr);
              current[part]._messageType = 'json';
              current[part]._schema = SchemaGenerator.generateSchema(json);
            } catch {
              current[part]._messageType = 'string';
            }
          }
        } else {
          current[part]._messageType = 'binary';
        }
      }
    }

    // descend
    current = current[part];
  }

  // Update topic counters: increment parent._topicsCounter only when a new child was created
  if (newTopic) {
    current = this.topicTree;
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i];
      if (current[p]) {
        current[p]._topicsCounter = (current[p]._topicsCounter || 0) + 1;
        current = current[p];
      } else {
        // defensive: if path missing, break
        break;
      }
    }
  }

  // Track topic for database sync
  if (this.options.persistToDatabase && this.dbService) {
    this.pendingTopicUpdates.add(topic);
  }

  // Emit update if enough time has passed
  const now = Date.now();
  if (now - this.lastTopicTreeUpdate > TOPIC_TREE_UPDATE_INTERVAL) {
    this.lastTopicTreeUpdate = now;
    this.emit('topic-tree-updated', this.topicTree);
  }
}


  /**
   * Start metrics calculation loop
   */
  private startMetricsCalculation(): void {
    this.metricsUpdateInterval = setInterval(() => {
      this.calculateMetrics();
    }, METRICS_UPDATE_INTERVAL);
  }

  /**
   * Calculate derived metrics from raw stats
   */
  private calculateMetrics(): void {
    const stats = this.systemStats.$SYS?.broker;
    if (!stats) return;

    const now = Date.now();
    const timeDelta = (now - this.lastMetricsSnapshot.timestamp) / 1000; // seconds

    // Extract current values
    const messagesSent = parseInt(stats.messages?.sent || '0');
    const messagesReceived = parseInt(stats.messages?.received || '0');
    const bytesSent15min = parseFloat(stats.load?.bytes?.sent?.['15min'] || '0');
    const bytesReceived15min = parseFloat(stats.load?.bytes?.received?.['15min'] || '0');

    // Calculate message rates (messages per second)
    const publishedRate = Math.max(0, (messagesSent - this.lastMetricsSnapshot.messagesSent) / timeDelta);
    const receivedRate = Math.max(0, (messagesReceived - this.lastMetricsSnapshot.messagesReceived) / timeDelta);

    // Update message rate history
    this.metrics.messageRate.published.push(Math.round(publishedRate));
    if (this.metrics.messageRate.published.length > 15) {
      this.metrics.messageRate.published.shift();
    }

    this.metrics.messageRate.received.push(Math.round(receivedRate));
    if (this.metrics.messageRate.received.length > 15) {
      this.metrics.messageRate.received.shift();
    }

    this.metrics.messageRate.current = {
      published: Math.round(publishedRate),
      received: Math.round(receivedRate)
    };

    // Update throughput (convert to KB/s)
    this.metrics.throughput.current = {
      outbound: Math.round(bytesSent15min / 1024),
      inbound: Math.round(bytesReceived15min / 1024)
    };

    this.metrics.throughput.outbound.push(this.metrics.throughput.current.outbound);
    if (this.metrics.throughput.outbound.length > 15) {
      this.metrics.throughput.outbound.shift();
    }

    this.metrics.throughput.inbound.push(this.metrics.throughput.current.inbound);
    if (this.metrics.throughput.inbound.length > 15) {
      this.metrics.throughput.inbound.shift();
    }

    // Update counts
    this.metrics.clients = parseInt(stats.clients?.connected || '0');
    this.metrics.subscriptions = parseInt(stats.subscriptions?.count || '0');
    this.metrics.retainedMessages = parseInt(stats['retained messages']?.count || '0');
    this.metrics.totalMessagesSent = messagesSent;
    this.metrics.totalMessagesReceived = messagesReceived;
    this.metrics.timestamp = now;

    // Update snapshot
    this.lastMetricsSnapshot = {
      messagesSent,
      messagesReceived,
      bytesSent: bytesSent15min,
      bytesReceived: bytesReceived15min,
      timestamp: now
    };

    // Emit metrics update
    this.emit('metrics-updated', this.metrics);
  }

  /**
   * Stop the monitoring service
   */
  async stop(): Promise<void> {
    this.stopped = true;

    // Sync to database before stopping
    if (this.options.persistToDatabase && this.dbService) {
      logger.info('Syncing to database before stop...');
      await this.syncToDatabase();
    }

    if (this.topicTreeUpdateInterval) {
      clearInterval(this.topicTreeUpdateInterval);
    }

    if (this.metricsUpdateInterval) {
      clearInterval(this.metricsUpdateInterval);
    }

    if (this.dbSyncInterval) {
      clearInterval(this.dbSyncInterval);
    }

    if (this.client) {
      this.client.end();
      this.client = null;
    }

    this.connected = false;
    logger.info('Stopped');
  }

  /**
   * Get current topic tree
   */
  getTopicTree(): TopicNode {
    return this.topicTree;
  }

  /**
   * Get system statistics
   */
  getSystemStats(): BrokerStats {
    return this.systemStats;
  }

  /**
   * Get calculated metrics
   */
  getMetrics(): CalculatedMetrics {
    return this.metrics;
  }

  /**
   * Get connection status
   */
  getStatus(): { connected: boolean; topicCount: number; messageCount: number } {
    // Count actual topics and messages by traversing the tree
    let topicCount = 0;
    let messageCount = 0;

    const traverse = (node: any) => {
      Object.keys(node).forEach(key => {
        if (key.startsWith('_')) return; // Skip metadata
        
        const child = node[key];
        if (child._message !== undefined) {
          topicCount++;
          messageCount += child._messagesCounter || 0;
        }
        
        // Recurse into children
        traverse(child);
      });
    };

    traverse(this.topicTree);

    return {
      connected: this.connected,
      topicCount,
      messageCount
    };
  }

  /**
   * Get flattened topic list with schemas (for API consumption)
   * @param filterTimestamp - Optional timestamp to filter topics (only include topics with lastModified >= filterTimestamp)
   */
  getFlattenedTopics(filterTimestamp?: number | null): Array<{
    topic: string;
    messageCount: number;
    lastMessage?: string;
    messageType?: string;
    schema?: JSONSchema;
    lastModified?: number;
  }> {
    const topics: Array<any> = [];

    const traverse = (node: any, parentPath: string = '') => {
      Object.keys(node).forEach(key => {
        if (key.startsWith('_')) return; // Skip metadata

        const child = node[key];
        const fullPath = parentPath ? `${parentPath}/${key}` : key;

        if (child._message !== undefined) {
          const lastModified = child._lastModified || child._created;
          
          // Apply time filter if specified
          if (filterTimestamp && lastModified && lastModified < filterTimestamp) {
            return; // Skip this topic - it's older than the filter
          }
          
          // This is a leaf node with a message
          const topicData: any = {
            topic: fullPath,
            messageCount: child._messagesCounter,
            sessionCount: child._sessionCounter || 0,
            lastMessage: child._message,
            lastModified: lastModified
          };

          if (child._messageType) {
            topicData.messageType = child._messageType;
          }

          if (child._schema) {
            topicData.schema = child._schema;
          }

          topics.push(topicData);
        }

        // Recurse into children
        traverse(child, fullPath);
      });
    };

    traverse(this.topicTree);
    return topics;
  }

  /**
   * Get schema for a specific topic
   */
  getTopicSchema(topic: string): { schema?: JSONSchema; messageType?: string } | null {
    const parts = topic.split('/');
    let current: any = this.topicTree;

    for (const part of parts) {
      if (!current[part]) {
        return null;
      }
      current = current[part];
    }

    if (current._schema || current._messageType) {
      return {
        schema: current._schema,
        messageType: current._messageType
      };
    }

    return null;
  }

  /**
   * Load initial state from database
   */
  private async loadStateFromDatabase(): Promise<void> {
    if (!this.dbService) return;

    try {
      logger.info('Loading state from database...');
      const { topics, stats } = await this.dbService.loadInitialState();

      logger.info(`Loaded ${topics.length} topics from database`);

      // Restore topic tree from database
      for (const topic of topics) {
        const parts = topic.topic.split('/');
        let current: any = this.topicTree;

        parts.forEach((part: string, index: number) => {
          if (!current[part]) {
            current[part] = {
              _name: part,
              _topic: parts.slice(0, index + 1).join('/'),
              _created: topic.firstSeen?.getTime() || Date.now(),
              _messagesCounter: 0,
              _topicsCounter: 0
            };
          }

          if (index === parts.length - 1) {
            // Last part - restore full data
            current[part]._message = topic.lastMessage;
            current[part]._messagesCounter = Number(topic.messageCount) || 0;
            current[part]._messageType = topic.messageType;
            current[part]._schema = topic.schema;
            current[part]._qos = topic.qos;
            current[part]._retain = topic.retain;
            current[part]._lastModified = topic.lastSeen?.getTime();
          }

          current = current[part];
        });
      }

      // Restore broker stats if available
      if (stats) {
        this.lastMetricsSnapshot = {
          messagesSent: stats.messagesSent || 0,
          messagesReceived: stats.messagesReceived || 0,
          bytesSent: stats.bytesSent || 0,
          bytesReceived: stats.bytesReceived || 0,
          timestamp: Date.now()
        };
      }

      logger.info('State loaded from database');
    } catch (error) {
      logger.error('Failed to load state from database', { error });
    }
  }

  private resetSessionCounters(): void {
  const traverse = (node: any) => {
    Object.keys(node).forEach(key => {
      if (key.startsWith('_')) return;
      const child = node[key];
      if (child._sessionCounter !== undefined) {
        child._sessionCounter = 0;
      }
      traverse(child);
    });
  };
  traverse(this.topicTree);
  logger.info('Session counters reset');
}


  /**
   * Start periodic database sync
   */
  private startDatabaseSync(): void {
    if (this.dbSyncInterval) {
      clearInterval(this.dbSyncInterval);
    }

    this.dbSyncInterval = setInterval(() => {
      this.syncToDatabase();
    }, this.options.dbSyncInterval || 30000);

    console.log(`Database sync started (interval: ${this.options.dbSyncInterval}ms)`);
  }

  /**
   * Sync current state to database
   */
  private async syncToDatabase(): Promise<void> {
    if (!this.dbService ) return;

    try {
      // Get topics that need updating
      const topicsToUpdate = Array.from(this.pendingTopicUpdates);
      const topicRecords = [];

      for (const topic of topicsToUpdate) {
        const parts = topic.split('/');
        let current: any = this.topicTree;

        for (const part of parts) {
          if (!current[part]) break;
          current = current[part];
        }

        if (current._message !== undefined) {
          topicRecords.push({
            topic,
            topicId: current._topicId,  // Include existing topicId if available
            messageType: current._messageType,
            schema: current._schema,
            lastMessage: current._message,
            messageCount: current._messagesCounter || 1,
            qos: current._qos,
            retain: current._retain
          });

          // Save schema history if schema exists
          if (current._schema) {
            await this.dbService.saveSchemaHistory(
              topic,
              current._schema,
              current._message
            ).catch((err: any) => logger.error('Failed to save schema history', { error: err.message }));
          }
        }
      }

      // Batch upsert topics and get back topic_ids
      if (topicRecords.length > 0) {
        const topicIdMap = await this.dbService.batchUpsertTopics(topicRecords);
        
        // Store returned topic_ids back into tree nodes
        for (const topic of topicsToUpdate) {
          const parts = topic.split('/');
          let current: any = this.topicTree;
          
          for (const part of parts) {
            if (!current[part]) break;
            current = current[part];
          }
          
          if (current._topic && topicIdMap.has(topic)) {
            current._topicId = topicIdMap.get(topic);
          }
        }
        
        logger.info(`Synced ${topicRecords.length} topics to database`);
      }

      // Save broker stats
      await this.dbService.saveBrokerStats({
        connectedClients: this.metrics.clients,
        subscriptions: this.metrics.subscriptions,
        retainedMessages: this.metrics.retainedMessages,
        messagesSent: this.metrics.totalMessagesSent,
        messagesReceived: this.metrics.totalMessagesReceived,
        messageRatePublished: this.metrics.messageRate.current.published,
        messageRateReceived: this.metrics.messageRate.current.received,
        throughputInbound: this.metrics.throughput.current.inbound,
        throughputOutbound: this.metrics.throughput.current.outbound,
        sysData: this.systemStats
      });

      // Save per-topic metrics for time-windowed analysis
      for (const record of topicRecords) {
        await this.dbService.saveTopicMetrics({
          topic: record.topic,
          messageCount: record.messageCount,
          bytesReceived: record.lastMessage ? Buffer.byteLength(record.lastMessage) : 0,
          messageRate: 0, // Will be calculated from historical data
          avgMessageSize: record.lastMessage ? Buffer.byteLength(record.lastMessage) : undefined
        }).catch((err: any) => logger.error('Failed to save topic metrics', { error: err.message }));
      }

      // Clear pending updates
      this.pendingTopicUpdates.clear();
    } catch (error) {
      logger.error('Failed to sync to database', { error });
    }
  }

  /**
   * Force immediate database sync
   */
  async flushToDatabase(): Promise<void> {
    if (!this.options.persistToDatabase || !this.dbService) {
      logger.warn('Database persistence not enabled');
      return;
    }

    await this.syncToDatabase();
  }
}
