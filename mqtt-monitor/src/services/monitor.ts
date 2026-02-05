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
import { PrometheusExporter } from './prometheus';

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
 * Collected MQTT Message (raw ingestion)
 */
interface CollectedMessage {
  topic: string;
  payload: Buffer;
  packet: any;
  timestamp: number;
}

/**
 * Aggregated Topic Data (computed state)
 */
interface AggregatedTopic {
  topic: string;
  parts: string[];
  isRedelivery: boolean;
  messageStr: string;
  isBinary: boolean;
  isTruncated: boolean;
  schema?: JSONSchema;
  schemaHash?: string;
  messageType?: string;
  samplingReason?: 'rate_limit' | 'degraded_mode';  // Why was this message sampled?
  qos?: number;
  retain?: boolean;
  packet?: any; // Original MQTT packet for cmd, dup, retain, qos
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
  _messageType?: 'json' | 'xml' | 'string' | 'binary' | 'truncated' | 'sampled';
  _schema?: JSONSchema;
  _schemaHash?: string;          // Hash of current schema
  _schemaVersion?: number;       // Schema version (increments on change)
  _schemaConfidence?: number;    // Confidence 0-1 (based on stability)
  _schemaSampleCount?: number;   // How many messages validated against schema
  _lastSampledTs?: number;       // Last time this topic was sampled (for display)
  _cmd?: string;
  _dup?: boolean;
  _retain?: boolean;
  _qos?: number;
  _redeliveryCounter?: number;   // Count of duplicate/redelivered messages
  _deliveredCounter?: number;    // Count of new (non-dup) messages
  [key: string]: any; // Child nodes
}

/**
 * Broker Statistics Structure (from $SYS topics)
 */
export interface BrokerStats {
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
export interface CalculatedMetrics {
  messageRate: {
    published: number[];  // Last 15 measurements (delta-based, msgs/sec)
    received: number[];   // Last 15 measurements (delta-based, msgs/sec)
    current: {
      published: number;  // Current delta-based rate (msgs/sec)
      received: number;   // Current delta-based rate (msgs/sec)
    };
  };
  throughput: {
    inbound: number[];   // Last 15 measurements (delta-based, KB/sec)
    outbound: number[];  // Last 15 measurements (delta-based, KB/sec)
    current: {
      inbound: number;   // Current delta-based rate (KB/sec)
      outbound: number;  // Current delta-based rate (KB/sec)
    };
    avg15min?: {         // Broker's 15-minute averages (if available)
      inbound: number;   // KB/sec (15min avg from $SYS)
      outbound: number;  // KB/sec (15min avg from $SYS)
    };
  };
  clients: number;
  subscriptions: number;
  retainedMessages: number;
  totalMessagesSent: number;
  totalMessagesReceived: number;
  totalBytesSent: number;       // Raw counter for delta calculation
  totalBytesReceived: number;   // Raw counter for delta calculation
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
  
  // Production safety options
  monitorTopics?: string[]; // Scoped monitoring (default: ['#'])
  excludeTopics?: string[]; // Topics to exclude from monitoring
  ignoreRetained?: boolean; // Ignore retained message deliveries (default: true)
  maxPayloadBytes?: number; // Max payload size to store (default: 8KB)
  maxTopics?: number; // Max topics to track (default: 10000)
  topicIdleTTL?: number; // Prune topics idle for N ms (default: 24h)
  topicSampleInterval?: number; // Min interval between payload samples per topic (default: 10s)
  encodeBinaryPayloads?: boolean; // Base64 encode binary payloads (default: false, shows size only)
  brokerType?: 'mosquitto' | 'emqx' | 'hivemq' | 'auto'; // Broker type (default: auto)
  schemaStabilityThreshold?: number; // Min samples before schema update (default: 5)
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

  // Topic tree pruning
  private pruningInterval?: NodeJS.Timeout;
  private detectedBrokerType: string = 'unknown';
  
  // Backpressure awareness
  private degradedMode = false;
  private eventLoopLagInterval?: NodeJS.Timeout;
  private lastEventLoopCheck = Date.now();
  private eventLoopLagThreshold = parseInt(process.env.MQTT_EVENT_LOOP_LAG_THRESHOLD || '100'); // ms
  private droppedPayloadsCount = 0;
  
  // Topic sampling state (separate from tree structure)
  private topicSamplingState: Map<string, { lastSampleTs: number; sampleCount: number }> = new Map();
  
  // Layered architecture components
  private collector: MessageCollector;
  private aggregator: MessageAggregator;
  private publisher: EventPublisher;
  private persister: MessagePersister;
  
  // Prometheus exporter
  private prometheusExporter: PrometheusExporter;

  constructor(options: MonitorOptions, dbService?: any) {
    super();
    this.options = {
      topicTreeEnabled: true,
      metricsEnabled: true,
      schemaGenerationEnabled: true,
      persistToDatabase: false,
      dbSyncInterval: 30000, // 30 seconds default
      monitorTopics: ['#'], // Default to all topics
      excludeTopics: [], // No exclusions by default
      ignoreRetained: true, // Ignore retained deliveries by default
      maxPayloadBytes: 8 * 1024, // 8KB max payload
      maxTopics: 10000, // 10k topic limit
      topicIdleTTL: 24 * 60 * 60 * 1000, // 24 hours
      topicSampleInterval: 10000, // 10 seconds per-topic sampling
      encodeBinaryPayloads: false, // Don't base64 encode by default (memory safety)
      brokerType: 'auto',
      schemaStabilityThreshold: 5, // Min 5 samples before schema update
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
        current: { inbound: 0, outbound: 0 },
        avg15min: { inbound: 0, outbound: 0 }
      },
      clients: 0,
      subscriptions: 0,
      retainedMessages: 0,
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      totalBytesSent: 0,
      totalBytesReceived: 0,
      timestamp: Date.now()
    };
    
    // Initialize Prometheus exporter first (needed by aggregator)
    this.prometheusExporter = new PrometheusExporter();
    
    // Initialize layered components
    this.collector = new MessageCollector(this.options);
    this.aggregator = new MessageAggregator(
      this.options,
      () => this.degradedMode,
      () => this.droppedPayloadsCount++,
      this.topicSamplingState,
      this.prometheusExporter
    );
    this.publisher = new EventPublisher(this);
    this.persister = new MessagePersister(this.options, this.dbService);
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
    
    // Start event loop lag monitoring for backpressure detection
    this.startEventLoopMonitoring();
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
      this.prometheusExporter.updateConnectionStatus(true);
      this.emit('connected');

      // Reset per-session counters
      this.resetSessionCounters();

      // Subscribe to scoped topics for topic tree
      if (this.options.topicTreeEnabled) {
        const monitorTopics = this.options.monitorTopics || ['#'];
        
        for (const topic of monitorTopics) {
          this.client!.subscribe(topic, { qos: 0 }, (err) => {
            if (err) {
              logger.error(`Failed to subscribe to ${topic}`, { error: err.message });
            } else {
              logger.info(`Subscribed to ${topic} (QoS 0)`);
            }
          });
        }
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
      this.prometheusExporter.updateConnectionStatus(false);
    });

  this.client.on('message', (topic, payload, packet) => {
    // Ignore $SYS messages for topic tree (still handle system stats)
    if (topic.startsWith('$SYS/')) {
        this.updateSystemStats(topic, payload.toString());
        
        // Detect broker type from $SYS structure
        if (this.detectedBrokerType === 'unknown') {
          this.detectBrokerType(topic);
        }
        return;
    }

    if (this.options.topicTreeEnabled) {
      // Layered processing: Collect → Aggregate → Publish → Persist
      const collected = this.collector.collect(topic, payload, packet);
      if (!collected) return; // Filtered out
      
      const aggregated = this.aggregator.aggregate(collected, this.topicTree);
      const treeUpdated = this.updateTopicTreeFromAggregated(aggregated);
      
      if (treeUpdated) {
        this.publisher.publish(aggregated, this.topicTree);
        
        // Get node for intelligent persistence filtering
        const parts = topic.split('/');
        let node: any = this.topicTree;
        for (const part of parts) {
          if (!node[part]) break;
          node = node[part];
        }
        this.persister.markForPersist(topic, node);
      }
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

    // Emit event for real-time updates (immutable copy)
    this.emit('system-stats-updated', structuredClone(this.systemStats));
  }

  /**
   * Update topic tree with aggregated data (tree manipulation only)
   * Returns true if tree was updated, false if skipped (max topics reached)
   */
  private updateTopicTreeFromAggregated(agg: AggregatedTopic): boolean {
    const { topic, parts, isRedelivery, messageStr, isBinary, isTruncated, 
            schema, schemaHash, messageType, qos, retain } = agg;
    
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
          _messagesCounter: 0,
          _topicsCounter: 0
        };
        newTopic = true;
      }

      // update lastModified for all nodes on the path
      current[part]._lastModified = Date.now();

      // Only increment counters for the leaf (exact topic)
      if (isLeaf) {
        if (isRedelivery) {
          // Track redeliveries separately
          current[part]._redeliveryCounter = (current[part]._redeliveryCounter || 0) + 1;
        } else {
          // New message delivery
          current[part]._deliveredCounter = (current[part]._deliveredCounter || 0) + 1;
          
          // Total messages counter (lifetime)
          if (typeof current[part]._messagesCounter === 'number' &&
              current[part]._messagesCounter >= 2147483640) {
            logger.warn(`Overflow threshold reached for ${topicPath}. Resetting counter.`);
            current[part]._messagesCounter = 0;
          }

          current[part]._messagesCounter = (current[part]._messagesCounter || 0) + 1;
          current[part]._sessionCounter = (current[part]._sessionCounter || 0) + 1;
        }
      }

      // Store message details for leaf nodes
      if (isLeaf) {
        // Only update message for non-sampled messages (preserve last real payload)
        if (messageType !== 'sampled') {
          current[part]._message = messageStr;
          current[part]._messageType = messageType;
        } else {
          // For sampled messages, just update timestamp
          current[part]._lastSampledTs = Date.now();
        }
        
        current[part]._cmd = agg.packet?.cmd;
        current[part]._dup = agg.packet?.dup;
        current[part]._retain = retain;
        current[part]._qos = qos;
        
        // Enforce schema stability with versioning
        if (schema && schemaHash) {
          const threshold = this.options.schemaStabilityThreshold || 5;
          
          if (!current[part]._schema) {
            // First schema - set it immediately
            current[part]._schema = schema;
            current[part]._schemaHash = schemaHash;
            current[part]._schemaVersion = 1;
            current[part]._schemaSampleCount = 1;
            current[part]._schemaConfidence = 0;
          } else if (current[part]._schemaHash === schemaHash) {
            // Same schema - increase sample count and confidence
            current[part]._schemaSampleCount = (current[part]._schemaSampleCount || 0) + 1;
            current[part]._schemaConfidence = Math.min(1, 
              (current[part]._schemaSampleCount || 0) / threshold
            );
          } else if ((current[part]._schemaSampleCount || 0) >= threshold) {
            // Different schema and stability threshold reached - update version
            current[part]._schema = schema;
            current[part]._schemaHash = schemaHash;
            current[part]._schemaVersion = (current[part]._schemaVersion || 1) + 1;
            current[part]._schemaSampleCount = 1;
            current[part]._schemaConfidence = 0;
            logger.debug(`Schema updated for ${topicPath}`, {
              version: current[part]._schemaVersion,
              prevHash: current[part]._schemaHash,
              newHash: schemaHash
            });
          }
          // else: Different schema but not stable yet - keep old schema, don't increment count
        }
      }

      current = current[part];
    }

    // Update topic counters for new topics
    if (newTopic) {
      const status = this.getStatus();
      if (status.topicCount >= (this.options.maxTopics || 10000)) {
        logger.warn(`Max topics limit reached (${this.options.maxTopics}). Ignoring new topic: ${topic}`);
        return false;
      }
      
      current = this.topicTree;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (current[p]) {
          current[p]._topicsCounter = (current[p]._topicsCounter || 0) + 1;
          current = current[p];
        } else {
          break;
        }
      }
    }

    return true;
  }

  /**
   * Start metrics calculation loop
   */
  private startMetricsCalculation(): void {
    this.metricsUpdateInterval = setInterval(() => {
      this.calculateMetrics();
    }, METRICS_UPDATE_INTERVAL);
    
    // Start topic tree pruning (every hour)
    this.pruningInterval = setInterval(() => {
      this.pruneIdleTopics();
    }, 60 * 60 * 1000);
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
    
    // Try to get raw byte counters (Mosquitto: $SYS/broker/bytes/sent)
    // These are cumulative counters, better for delta calculation
    const bytesSent = this.extractByteCounter('sent');
    const bytesReceived = this.extractByteCounter('received');
    
    // Fallback: 15-minute averages (less accurate for instantaneous rates)
    const bytesSent15min = parseFloat(stats.load?.bytes?.sent?.['15min'] || '0');
    const bytesReceived15min = parseFloat(stats.load?.bytes?.received?.['15min'] || '0');

    // Calculate message rates (messages per second) - delta-based
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

    // Calculate throughput (KB/sec) - prefer delta-based from raw counters
    let outboundKBps = 0;
    let inboundKBps = 0;
    
    if (bytesSent > 0 && bytesSent > this.lastMetricsSnapshot.bytesSent) {
      // Delta-based calculation from raw byte counters (accurate)
      const bytesDelta = bytesSent - this.lastMetricsSnapshot.bytesSent;
      outboundKBps = Math.round((bytesDelta / timeDelta) / 1024);
    } else if (bytesSent15min > 0) {
      // Fallback: use 15min average (already in bytes/sec from broker)
      outboundKBps = Math.round(bytesSent15min / 1024);
    }
    
    if (bytesReceived > 0 && bytesReceived > this.lastMetricsSnapshot.bytesReceived) {
      // Delta-based calculation from raw byte counters (accurate)
      const bytesDelta = bytesReceived - this.lastMetricsSnapshot.bytesReceived;
      inboundKBps = Math.round((bytesDelta / timeDelta) / 1024);
    } else if (bytesReceived15min > 0) {
      // Fallback: use 15min average (already in bytes/sec from broker)
      inboundKBps = Math.round(bytesReceived15min / 1024);
    }

    this.metrics.throughput.current = {
      outbound: outboundKBps,
      inbound: inboundKBps
    };
    
    // Store 15min averages separately for reference (if available)
    if (bytesSent15min > 0 || bytesReceived15min > 0) {
      this.metrics.throughput.avg15min = {
        outbound: Math.round(bytesSent15min / 1024),
        inbound: Math.round(bytesReceived15min / 1024)
      };
    }

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
    this.metrics.totalBytesSent = bytesSent || 0;
    this.metrics.totalBytesReceived = bytesReceived || 0;
    this.metrics.timestamp = now;

    // Update snapshot
    this.lastMetricsSnapshot = {
      messagesSent,
      messagesReceived,
      bytesSent: bytesSent || this.lastMetricsSnapshot.bytesSent,
      bytesReceived: bytesReceived || this.lastMetricsSnapshot.bytesReceived,
      timestamp: now
    };

    // Update Prometheus metrics
    this.prometheusExporter.updateBrokerMetrics(this.metrics);
    this.prometheusExporter.updateTopicTreeMetrics(this.getTopicCount(), this.getMessageCount());
    this.prometheusExporter.updateDegradedMode(this.degradedMode);

    // Emit metrics update (immutable copy)
    this.emit('metrics-updated', structuredClone(this.metrics));
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

    if (this.pruningInterval) {
      clearInterval(this.pruningInterval);
    }

    if (this.dbSyncInterval) {
      clearInterval(this.dbSyncInterval);
    }
    
    if (this.eventLoopLagInterval) {
      clearInterval(this.eventLoopLagInterval);
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
   * Get topic count
   */
  getTopicCount(): number {
    let count = 0;
    
    const traverse = (node: any) => {
      Object.keys(node).forEach(key => {
        if (key.startsWith('_')) return;
        const child = node[key];
        if (child._message !== undefined) count++;
        traverse(child);
      });
    };
    
    traverse(this.topicTree);
    return count;
  }
  
  /**
   * Get total message count
   */
  getMessageCount(): number {
    let count = 0;
    
    const traverse = (node: any) => {
      Object.keys(node).forEach(key => {
        if (key.startsWith('_')) return;
        const child = node[key];
        if (child._messagesCounter) count += child._messagesCounter;
        traverse(child);
      });
    };
    
    traverse(this.topicTree);
    return count;
  }
  
  /**
   * Get Prometheus metrics
   */
  async getPrometheusMetrics(): Promise<string> {
    return this.prometheusExporter.getMetrics();
  }
  
  /**
   * Get Prometheus content type
   */
  getPrometheusContentType(): string {
    return this.prometheusExporter.getContentType();
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
    schemaVersion?: number;
    schemaConfidence?: number;
    redeliveryCount?: number;
    deliveredCount?: number;
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
            deliveredCount: child._deliveredCounter || 0,
            redeliveryCount: child._redeliveryCounter || 0,
            lastMessage: child._message,
            lastModified: lastModified
          };

          if (child._messageType) {
            topicData.messageType = child._messageType;
          }

          if (child._schema) {
            topicData.schema = child._schema;
            topicData.schemaVersion = child._schemaVersion || 1;
            topicData.schemaConfidence = child._schemaConfidence || 0;
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
   * Extract raw byte counter from $SYS stats (for delta-based throughput)
   * Different brokers publish this differently:
   * - Mosquitto: $SYS/broker/bytes/sent (cumulative)
   * - EMQX: $SYS/brokers/{node}/bytes/sent
   */
  private extractByteCounter(direction: 'sent' | 'received'): number {
    const stats = this.systemStats.$SYS?.broker;
    if (!stats) return 0;
    
    // Try Mosquitto format first
    const bytesStr = stats[`bytes`]?.[direction];
    if (bytesStr && typeof bytesStr === 'string') {
      return parseInt(bytesStr) || 0;
    }
    
    // Fallback: no raw counter available
    return 0;
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
      // Get topics from persister layer
      const topicsToUpdate = Array.from(this.persister.getPending());
      const topicRecords: any[] = [];
      const schemaHistoryBatch: any[] = [];
      const topicMetricsBatch: any[] = [];

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

          // Collect schema history for batch save
          if (current._schema) {
            // Parse exampleMessage if it's JSON, otherwise skip
            let sampleMessage = null;
            if (current._message && current._messageType === 'json') {
              try {
                sampleMessage = JSON.parse(current._message);
              } catch {
                // Not valid JSON, skip sample
              }
            }
            
            schemaHistoryBatch.push({
              topic,
              schema: current._schema,
              exampleMessage: sampleMessage
            });
          }
          
          // Collect topic metrics for batch save
          topicMetricsBatch.push({
            topic,
            messageCount: current._messagesCounter || 1,
            bytesReceived: current._message ? Buffer.byteLength(current._message) : 0,
            messageRate: 0, // Will be calculated from historical data
            avgMessageSize: current._message ? Buffer.byteLength(current._message) : undefined
          });
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

      // Batch save schema history (if DB service supports it)
      if (schemaHistoryBatch.length > 0) {
        if (typeof this.dbService.saveSchemaHistoryBatch === 'function') {
          await this.dbService.saveSchemaHistoryBatch(schemaHistoryBatch)
            .catch((err: any) => logger.error('Failed to batch save schema history', { 
              error: err.message,
              count: schemaHistoryBatch.length 
            }));
        } else {
          // Fallback: use individual calls (legacy DB service)
          logger.warn('DB service does not support saveSchemaHistoryBatch, using individual calls');
          for (const item of schemaHistoryBatch) {
            await this.dbService.saveSchemaHistory(item.topic, item.schema, item.exampleMessage)
              .catch((err: any) => logger.error('Failed to save schema history', { error: err.message }));
          }
        }
      }

      // Batch save topic metrics (if DB service supports it)
      if (topicMetricsBatch.length > 0) {
        if (typeof this.dbService.saveTopicMetricsBatch === 'function') {
          await this.dbService.saveTopicMetricsBatch(topicMetricsBatch)
            .catch((err: any) => logger.error('Failed to batch save topic metrics', { 
              error: err.message,
              count: topicMetricsBatch.length 
            }));
        } else {
          // Fallback: use individual calls (legacy DB service)
          logger.warn('DB service does not support saveTopicMetricsBatch, using individual calls');
          for (const item of topicMetricsBatch) {
            await this.dbService.saveTopicMetrics(item)
              .catch((err: any) => logger.error('Failed to save topic metrics', { error: err.message }));
          }
        }
      }

      // Clear pending updates in persister
      this.persister.clearPending();
    } catch (error: any) {
      logger.error('Failed to sync to database', { 
        error: error.message,
        stack: error.stack,
        code: error.code,
        detail: error.detail
      });
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

  /**
   * Detect broker type from $SYS topic structure
   */
  private detectBrokerType(topic: string): void {
    if (topic.includes('$SYS/broker/')) {
      this.detectedBrokerType = 'mosquitto';
      logger.info('Detected broker type: Mosquitto');
    } else if (topic.includes('$SYS/brokers/')) {
      this.detectedBrokerType = 'emqx';
      logger.info('Detected broker type: EMQX');
    } else if (topic.includes('$SYS/cluster/')) {
      this.detectedBrokerType = 'hivemq';
      logger.info('Detected broker type: HiveMQ');
    }
  }

  /**
   * Monitor event loop lag for backpressure detection
   */
  private startEventLoopMonitoring(): void {
    this.eventLoopLagInterval = setInterval(() => {
      const now = Date.now();
      const lag = now - this.lastEventLoopCheck - 1000; // Expected 1s interval
      this.lastEventLoopCheck = now;
      
      if (lag > this.eventLoopLagThreshold && !this.degradedMode) {
        this.degradedMode = true;
        logger.warn('Entering degraded mode due to event loop lag', { 
          lag, 
          threshold: this.eventLoopLagThreshold,
          droppedSoFar: this.droppedPayloadsCount 
        });
      } else if (lag <= this.eventLoopLagThreshold / 2 && this.degradedMode) {
        this.degradedMode = false;
        logger.info('Exiting degraded mode - event loop recovered', { 
          lag,
          totalDropped: this.droppedPayloadsCount 
        });
      }
    }, 1000);
  }

  /**
   * Prune idle topics based on TTL
   */
  private pruneIdleTopics(): void {
    const now = Date.now();
    const ttl = this.options.topicIdleTTL || 24 * 60 * 60 * 1000;
    let pruned = 0;
    
    const prune = (node: any, path: string[] = []): void => {
      const keys = Object.keys(node).filter(k => !k.startsWith('_'));
      
      for (const key of keys) {
        const child = node[key];
        const childPath = [...path, key];
        
        // Check if this is a leaf node (has a message)
        if (child._message !== undefined) {
          const lastModified = child._lastModified || child._created;
          const age = now - lastModified;
          
          if (age > ttl) {
            delete node[key];
            pruned++;
            continue;
          }
        }
        
        // Recurse into children
        prune(child, childPath);
        
        // Remove empty parent nodes
        const remainingChildren = Object.keys(node[key]).filter(k => !k.startsWith('_'));
        if (remainingChildren.length === 0 && node[key]._message === undefined) {
          delete node[key];
        }
      }
    };
    
    prune(this.topicTree);
    
    if (pruned > 0) {
      logger.info(`Pruned ${pruned} idle topics (TTL: ${ttl / 1000 / 60 / 60}h)`);
    }
  }
}

/**
 * Layer 1: Message Collector
 * Handles MQTT ingestion and filtering
 */
class MessageCollector {
  constructor(private options: MonitorOptions) {}
  
  /**
   * Collect and filter incoming MQTT messages
   * Returns null if message should be ignored
   */
  collect(topic: string, payload: Buffer, packet: any): CollectedMessage | null {
    // Ignore excluded topics
    if (this.options.excludeTopics?.some(pattern => this.topicMatches(topic, pattern))) {
      return null;
    }

    // Ignore retained message deliveries if configured
    if (this.options.ignoreRetained && packet?.retain) {
      logger.debug(`Ignoring retained message delivery: ${topic}`);
      return null;
    }
    
    return {
      topic,
      payload,
      packet,
      timestamp: Date.now()
    };
  }
  
  private topicMatches(topic: string, pattern: string): boolean {
    if (pattern === '#') return true;
    if (pattern === topic) return true;
    
    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');
    
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') return true;
      if (patternParts[i] === '+') continue;
      if (patternParts[i] !== topicParts[i]) return false;
    }
    
    return topicParts.length === patternParts.length;
  }
}

/**
 * Layer 2: Message Aggregator
 * Computes counters, rates, and schemas
 */
class MessageAggregator {
  constructor(
    private options: MonitorOptions,
    private getDegradedMode: () => boolean,
    private incrementDroppedCount: () => void,
    private samplingState: Map<string, { lastSampleTs: number; sampleCount: number }>,
    private prometheusExporter?: PrometheusExporter
  ) {}
  
  /**
   * Aggregate message data (payload processing, schema generation)
   */
  aggregate(collected: CollectedMessage, topicTree: TopicNode): AggregatedTopic {
    const { topic, payload, packet } = collected;
    const parts = topic.split('/');
    const isRedelivery = packet?.dup === true;
    const qos = packet?.qos;
    const retain = packet?.retain;
    
    // Backpressure: In degraded mode, skip payload processing to reduce load
    if (this.getDegradedMode()) {
      this.incrementDroppedCount();
      return {
        topic,
        parts,
        isRedelivery,
        messageStr: '[DROPPED - DEGRADED MODE]',
        isBinary: false,
        isTruncated: true,
        messageType: 'sampled',
        samplingReason: 'degraded_mode',
        qos,
        retain,
        packet
      };
    }
    
    // Per-topic sampling: Check if we should sample this message
    const now = Date.now();
    const sampleInterval = this.options.topicSampleInterval || 10000;
    const sampling = this.samplingState.get(topic);
    
    if (sampling?.lastSampleTs && now - sampling.lastSampleTs < sampleInterval) {
      // Still count message, but skip payload/schema processing
      // Record sampling metric for Prometheus
      if (this.prometheusExporter) {
        this.prometheusExporter.recordSampledMessage('rate_limit');
      }
      
      return {
        topic,
        parts,
        isRedelivery,
        messageStr: '[SAMPLED]',
        isBinary: false,
        isTruncated: true,
        messageType: 'sampled',
        samplingReason: 'rate_limit',
        qos,
        retain,
        packet
      };
    }
    
    // Normal mode: Handle payload size limiting
    const maxBytes = this.options.maxPayloadBytes || 8192;
    let messageStr: string;
    let isBinary = false;
    let isTruncated = false;
    let messageType: string | undefined;
    
    if (payload.length > maxBytes) {
      messageStr = `[TRUNCATED - ${payload.length} bytes]`;
      messageType = 'truncated';
      isTruncated = true;
    } else {
      isBinary = !isUtf8(payload);
      if (isBinary) {
        // Don't base64 encode by default (can explode memory on hot binary topics)
        if (this.options.encodeBinaryPayloads) {
          messageStr = `base64:${payload.toString('base64')}`;
        } else {
          messageStr = `[BINARY ${payload.length} bytes]`;
        }
        messageType = 'binary';
      } else {
        messageStr = payload.toString('utf8');
      }
    }
    
    // Schema generation (only for non-binary, non-truncated text)
    let schema: JSONSchema | undefined;
    let schemaHash: string | undefined;
    
    if (this.options.schemaGenerationEnabled && !isBinary && !isTruncated) {
      const schemaResult = this.generateSchemaWithVersioning(topic, messageStr, topicTree);
      schema = schemaResult.schema;
      schemaHash = schemaResult.schemaHash;
      if (schemaResult.messageType) {
        messageType = schemaResult.messageType;
      }
    }
    
    // Update sampling state (we actually sampled this message)
    const currentSampling = this.samplingState.get(topic);
    if (!currentSampling) {
      this.samplingState.set(topic, { lastSampleTs: now, sampleCount: 1 });
    } else {
      currentSampling.lastSampleTs = now;
      currentSampling.sampleCount++;
    }
    
    return {
      topic,
      parts,
      isRedelivery,
      messageStr,
      isBinary,
      isTruncated,
      schema,
      schemaHash,
      messageType,
      qos: packet?.qos,
      retain: packet?.retain,
      packet
    };
  }
  
  private generateSchemaWithVersioning(topic: string, messageStr: string, topicTree: TopicNode): {
    schema?: JSONSchema;
    schemaHash?: string;
    messageType?: string;
  } {
    if (messageStr.startsWith('<') && messageStr.endsWith('>')) {
      return { messageType: 'xml' };
    }
    
    try {
      const json = JSON.parse(messageStr);
      const newSchema = SchemaGenerator.generateSchema(json);
      const newSchemaHash = this.hashSchema(newSchema);
      
      // Aggregator only generates schema + hash
      // Tree updater is sole authority on versioning and stability
      return {
        schema: newSchema,
        schemaHash: newSchemaHash,
        messageType: 'json'
      };
    } catch {
      return { messageType: 'string' };
    }
  }
  
  private hashSchema(schema: JSONSchema): string {
    // Deterministic JSON stringify with recursive key sorting
    const canonicalize = (obj: any): any => {
      if (obj === null || typeof obj !== 'object') {
        return obj;
      }
      
      if (Array.isArray(obj)) {
        return obj.map(canonicalize);
      }
      
      // Sort keys recursively
      const sorted: any = {};
      Object.keys(obj)
        .sort()
        .forEach(key => {
          sorted[key] = canonicalize(obj[key]);
        });
      return sorted;
    };
    
    const str = JSON.stringify(canonicalize(schema));
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }
}

/**
 * Layer 3: Event Publisher
 * Emits events for external consumers
 */
class EventPublisher {
  private lastTopicTreeUpdate = 0;
  
  constructor(private monitor: MQTTMonitorService) {}
  
  /**
   * Publish events (topic-tree-updated, etc.)
   */
  publish(aggregated: AggregatedTopic, topicTree: TopicNode): void {
    // Throttle topic tree updates
    const now = Date.now();
    if (now - this.lastTopicTreeUpdate > TOPIC_TREE_UPDATE_INTERVAL) {
      this.lastTopicTreeUpdate = now;
      this.monitor.emit('topic-tree-updated', structuredClone(topicTree));
    }
  }
}

/**
 * Layer 4: Message Persister
 * Handles database sync tracking
 */
class MessagePersister {
  private pendingTopics: Set<string> = new Set();
  
  constructor(
    private options: MonitorOptions,
    private dbService: any
  ) {}
  
  /**
   * Mark topic for persistence (dirty tracking)
   * Only persists meaningful updates: first message, schema changes, non-sampled messages
   */
  markForPersist(topic: string, node?: any, isSchemaChange?: boolean): void {
    if (!this.options.persistToDatabase || !this.dbService) {
      return;
    }
    
    // Always persist if no node context provided (backward compatibility)
    if (!node) {
      this.pendingTopics.add(topic);
      return;
    }
    
    // Skip sampled messages (counters already updated)
    if (node._messageType === 'sampled') {
      return;
    }
    
    // Persist first message (discovery)
    if ((node._messagesCounter || 0) === 1) {
      this.pendingTopics.add(topic);
      return;
    }
    
    // Persist schema changes (versioning)
    if (isSchemaChange || (node._schemaVersion && node._schemaVersion > 1)) {
      this.pendingTopics.add(topic);
      return;
    }
    
    // Otherwise, skip to reduce DB writes for hot topics
  }
  
  /**
   * Get pending topics for batch sync
   */
  getPending(): Set<string> {
    return this.pendingTopics;
  }
  
  /**
   * Clear pending topics after sync
   */
  clearPending(): void {
    this.pendingTopics.clear();
  }
}
