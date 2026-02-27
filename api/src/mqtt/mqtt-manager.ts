/**
 * MQTT Manager for API
 * 
 * Handles incoming MQTT messages from devices:
 * - Sensor data (from sensor-publish feature)
 * - Device state updates (from cloud sync)
 * - Container logs (from cloud logging with MQTT backend)
 * - System metrics
 * 
 * Designed to be broker-agnostic (works with local or external MQTT)
 */

import mqtt from 'mqtt';
import { EventEmitter } from 'events';
import msgpack from 'msgpack-lite';
import zlib from 'zlib';
import pLimit from 'p-limit';
import logger, { logOperation } from '../utils/logger';
import { isDuplicateMessage } from '../utils/mqtt-deduplication';
import { CloudDictionaryManager } from './dictionary-manager';

/**
 * Deserialize MQTT payload - auto-detects DEFLATE, msgpack, or JSON format
 * @param message - Buffer or string payload
 * @returns Deserialized data object
 */
function deserializePayload(message: Buffer | string): any {
  let buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
  
  // Check for DEFLATE compression first (zlib header: 0x78 0x9C or 0x78 0x01 or 0x78 0xDA)
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
          compressedSize: message.length,
          decompressedSize: buffer.length,
          ratio: `${(((message.length - buffer.length) / message.length) * 100).toFixed(1)}%`
        });
      } catch (error) {
        logger.warn('DEFLATE decompression failed, treating as raw payload', {
          error: error instanceof Error ? error.message : String(error)
        });
        // Continue with original buffer if decompression fails
        buffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
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
    return message;
  }
}

export interface MqttConfig {
  brokerUrl: string;
  clientId?: string;
  username?: string;
  password?: string;
  reconnectPeriod?: number;
  keepalive?: number;
  clean?: boolean;
  qos?: 0 | 1 | 2;
}

export interface SensorData {
  deviceUuid: string;
  sensorName: string;
  timestamp: string;
  data: any;
  metadata?: Record<string, any>;
}

export interface LogMessage {
  deviceUuid: string;
  containerId: string;
  containerName: string;
  message: string;
  timestamp: string;
  level?: string;
  stream?: 'stdout' | 'stderr';
}

export interface MetricsData {
  deviceUuid: string;
  timestamp: string;
  cpu_usage?: number;
  memory_usage?: number;
  memory_total?: number;
  storage_usage?: number;
  storage_total?: number;
  cpu_temp?: number;
  network?: any;
}

export interface ParsedTopic {
  deviceUuid: string;
  messageType: string;
  subTopic?: string;
  rest: string[];
}

export interface StateMessage {
  deviceUuid: string;
  data: any; // Full device state payload
}

export interface AgentMessage {
  deviceUuid: string;
  subTopic: string;
  message: any;
}

export interface UnknownMessage {
  topic: string;
  deviceUuid: string;
  messageType: string;
  data: any;
}

/**
 * Map of message types to their payload structures
 * Provides type safety for MQTT message handlingddd
 */
export interface TopicMessageMap {
  endpoints: SensorData;
  state: StateMessage;
  agent: AgentMessage;
  logs: LogMessage;
  metrics: MetricsData;
  status: { deviceUuid: string; status: any };
  anomaly: any;  // Anomaly events from edge detection
  jobs: { topic: string; payload: Buffer };  // Job messages from devices
  unknown: UnknownMessage;
}

/**
 * MQTT Topic Structure (Convention)
 * 
 * IoT Device Format (used by device agent):
 *   Note: No leading $ - topics starting with $ are reserved for MQTT broker system topics
 * 
 *   Sensor Data:     iot/device/{uuid}/sensor/{sensorTopic}
 *   Device State:    iot/device/{uuid}/state
 *   Agent Status:    iot/device/{uuid}/agent/{subTopic}
 *   Logs:            iot/device/{uuid}/logs/{containerId}
 *   Metrics:         iot/device/{uuid}/metrics
 *   Status:          iot/device/{uuid}/status
 */

export class MqttManager extends EventEmitter {
  private client: mqtt.MqttClient | null = null;
  private config: Required<MqttConfig>;
  private subscriptions: Set<string> = new Set();
  private reconnecting: boolean = false;
  private reconnectCount: number = 0;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastErrorLog: number = 0;
  private errorLogThrottle: number = 30000; // Log errors max once per 30 seconds
  private readonly BASE_RECONNECT_DELAY_MS = 1000; // 1 second
  private readonly MAX_RECONNECT_DELAY_MS = 8000; // 8 seconds max
  private readonly MAX_RECONNECT_ATTEMPTS = 20; // Max reconnect attempts before fatal
  private fatalReconnectErrorEmitted = false; // Track if fatal error already emitted
  
  // Health monitoring
  private lastMessageTimestamp: number = 0;
  private lastConnectionTimestamp: number = 0;
  
  private pendingPublishes: Array<{
    topic: string;
    payload: string | Buffer;
    qos?: 0 | 1 | 2;
    retryCount?: number;
  }> = [];
  private readonly MAX_PENDING_PUBLISHES = 1000;
  private readonly MAX_PUBLISH_RETRIES = 3;

  // Dictionary manager for key compaction (POC)
  private cloudDictionaryManager: CloudDictionaryManager | null = null;
  private redisClient: any = null; // For buffering pending messages
  private expansionLimit = pLimit(10); // Max 10 concurrent dictionary expansions

  // Message type handlers dispatch map
  private readonly messageHandlers: Record<string, (deviceUuid: string, subTopic: string | undefined, data: any, rest?: string[]) => void>;

  /**
   * Type-safe event emitter
   */
  private emitTyped<K extends keyof TopicMessageMap>(event: K, data: TopicMessageMap[K]): void {
    this.emit(event, data);
  }

  constructor(config: MqttConfig) {
    super();
    
    this.config = {
      brokerUrl: config.brokerUrl,
      clientId: config.clientId || `api-mqtt`,
      username: config.username || '',
      password: config.password || '',
      reconnectPeriod: 0, // Disable built-in reconnect, use manual exponential backoff
      keepalive: config.keepalive || 60,
      clean: config.clean !== false,
      qos: config.qos || 1
    };

    // Initialize message handlers dispatch map
    this.messageHandlers = {
      endpoints: this.handleEndpointsData.bind(this),
      state: this.handleStateMessage.bind(this),
      agent: this.handleAgentMessage.bind(this),
      logs: this.handleLogMessage.bind(this),
      metrics: this.handleMetricsMessage.bind(this),
      status: this.handleStatusMessage.bind(this),
      events: this.handleEventsMessage.bind(this),
      meta: this.handleMetaMessage.bind(this),
      jobs: this.handleJobsMessage.bind(this)
    };
  }

  /**
   * Initialize dictionary manager (call after constructor, before connect)
   */
  initDictionaryManager(redisClient: any): void {
    if (!this.cloudDictionaryManager) {
      this.cloudDictionaryManager = new CloudDictionaryManager(redisClient, logger, {
        mqttPublish: (topic: string, payload: any) => this.publish(topic, payload)
      });
      this.redisClient = redisClient; // Store for message buffering
      logger.info('Cloud dictionary manager initialized with resync capability');
    }
  }

  /**
   * Get dictionary manager instance
   */
  getDictionaryManager(): CloudDictionaryManager | null {
    return this.cloudDictionaryManager;
  }

  /**
   * Register a custom message type handler
   * Allows extending message handling without modifying core class
   * 
   * @param messageType - The message type to handle (e.g., 'custom', 'telemetry')
   * @param handler - Handler function (deviceUuid, subTopic, data, rest) => void
   * @example
   * mqttManager.registerHandler('telemetry', (deviceUuid, subTopic, data) => {
   *   console.log('Telemetry data:', data);
   * });
   */
  registerHandler(
    messageType: string,
    handler: (deviceUuid: string, subTopic: string | undefined, data: any, rest?: string[]) => void
  ): void {
    const normalizedType = messageType.toLowerCase();
    this.messageHandlers[normalizedType] = handler;
    logger.info('Registered custom message handler', { messageType: normalizedType });
  }

  /**
   * Unregister a message type handler
   * 
   * @param messageType - The message type to remove
   */
  unregisterHandler(messageType: string): void {
    const normalizedType = messageType.toLowerCase();
    delete this.messageHandlers[normalizedType];
    logger.info('Unregistered message handler', { messageType: normalizedType });
  }

  /**
   * Check if a handler is registered for a message type
   * 
   * @param messageType - The message type to check
   */
  hasHandler(messageType: string): boolean {
    const normalizedType = messageType.toLowerCase();
    return normalizedType in this.messageHandlers;
  }

  /**
   * Buffer compacted message in Redis until dictionary becomes available
   * Uses Redis sorted set with timestamp score for TTL cleanup
   * Optimized with Redis pipeline for atomic operations
   */
  private async bufferPendingMessage(deviceUuid: string, topic: string, payload: Buffer, version: number): Promise<void> {
    if (!this.redisClient) return;
    
    try {
      const key = `pending_messages:${deviceUuid}`;
      const timestamp = Date.now();
      const messageData = {
        topic,
        payload: payload.toString('base64'), // Store as base64 string
        version,
        timestamp
      };
      
      // Use Redis pipeline for atomic operations (better performance)
      const pipeline = this.redisClient.pipeline();
      pipeline.zadd(key, timestamp, JSON.stringify(messageData));
      pipeline.expire(key, 60); // 60 second TTL
      await pipeline.exec();
      
      logger.debug('Message buffered in Redis', {
        deviceUuid: deviceUuid.substring(0, 8),
        version,
        timestamp
      });
    } catch (error) {
      logger.error('Failed to buffer message in Redis', {
        deviceUuid: deviceUuid.substring(0, 8),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Process all pending messages for a device after dictionary becomes available
   * Uses parallel processing with concurrency limit to avoid backpressure
   */
  private async processPendingMessages(deviceUuid: string): Promise<void> {
    if (!this.redisClient || !this.cloudDictionaryManager) return;
    
    try {
      const key = `pending_messages:${deviceUuid}`;
      
      // Get all pending messages (sorted by timestamp)
      const messages = await this.redisClient.zrange(key, 0, -1);
      
      if (!messages || messages.length === 0) {
        return; // No pending messages
      }
      
      logger.info(`Processing ${messages.length} buffered messages`, {
        deviceUuid: deviceUuid.substring(0, 8)
      });
      
      // Process messages in parallel with concurrency limit (10 concurrent max)
      const processingTasks = messages.map((msgStr: string) => 
        this.expansionLimit(async () => {
          try {
            const msgData = JSON.parse(msgStr);
            const payload = Buffer.from(msgData.payload, 'base64');
            
            // Re-process through message handler (will expand with now-available dictionary)
            await this.handleMessage(msgData.topic, payload);
            
            logger.debug('Buffered message reprocessed', {
              deviceUuid: deviceUuid.substring(0, 8),
              version: msgData.version,
              age: Date.now() - msgData.timestamp
            });
          } catch (error) {
            logger.error('Failed to reprocess buffered message', {
              deviceUuid: deviceUuid.substring(0, 8),
              error: error instanceof Error ? error.message : String(error)
            });
          }
        })
      );
      
      // Wait for all messages to be processed
      await Promise.all(processingTasks);
      
      // Clear processed messages
      await this.redisClient.del(key);
      
      logger.info('Buffered messages processed and cleared', {
        deviceUuid: deviceUuid.substring(0, 8),
        count: messages.length
      });
    } catch (error) {
      logger.error('Failed to process pending messages', {
        deviceUuid: deviceUuid.substring(0, 8),
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let initialConnectionSucceeded = false;
      let connectionTimeout: NodeJS.Timeout | null = null;

      const options: mqtt.IClientOptions = {
        clientId: this.config.clientId,
        username: this.config.username || undefined,
        password: this.config.password || undefined,
        reconnectPeriod: this.config.reconnectPeriod,
        keepalive: this.config.keepalive,
        clean: this.config.clean
      };

      // Add TLS options for mqtts:// connections
      let useTls = false;
      let rejectUnauthorized = true;
      if (this.config.brokerUrl.startsWith('mqtts://')) {
        useTls = true;
        // Check if we should skip certificate validation (for self-signed certs)
        rejectUnauthorized = process.env.MQTT_TLS_REJECT_UNAUTHORIZED !== 'false';
        
        options.rejectUnauthorized = rejectUnauthorized;
      }

      // Log comprehensive connection summary
      logger.info('🔌 MQTT CONNECTION SUMMARY', {
        brokerUrl: this.config.brokerUrl,
        clientId: this.config.clientId,
        username: this.config.username,
        hasPassword: !!this.config.password,
        useTls,
        rejectUnauthorized,
        reconnectPeriod: this.config.reconnectPeriod,
        keepalive: this.config.keepalive,
        clean: this.config.clean,
        qos: this.config.qos
      });

      this.client = mqtt.connect(this.config.brokerUrl, options);

      // Timeout for initial connection (30 seconds)
      connectionTimeout = setTimeout(() => {
        if (!initialConnectionSucceeded) {
          logger.error('MQTT initial connection timeout after 30s');
          this.client?.end(true); // Force close to prevent further events
          reject(new Error('MQTT connection timeout after 30s'));
        }
      }, 30000);

      this.client.on('connect', () => {
        initialConnectionSucceeded = true;
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }

        this.lastConnectionTimestamp = Date.now();
        logger.info('MQTT CLIENT CONNECTED TO BROKER', { 
          brokerUrl: this.config.brokerUrl,
          clientId: this.config.clientId, 
          username: this.config.username,
          qos: this.config.qos,
          keepalive: this.config.keepalive
        });
        this.reconnecting = false;
        this.reconnectCount = 0; // Reset counter on successful connection
        this.reconnectAttempts = 0; // Reset backoff
        this.fatalReconnectErrorEmitted = false; // Reset fatal error flag
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.resubscribe();
        this.drainPendingPublishes();
        resolve();
      });

      this.client.on('error', (error) => {
        // Clear timeout on error
        if (connectionTimeout) {
          clearTimeout(connectionTimeout);
          connectionTimeout = null;
        }

        // Throttle error logging to reduce spam
        const now = Date.now();
        if (now - this.lastErrorLog > this.errorLogThrottle) {
          logger.error('MQTT CONNECTION ERROR', { 
            error: error.message || (error as any).code,
            reconnectAttempts: this.reconnectAttempts,
            initialConnection: !initialConnectionSucceeded,
            // Include connection config for debugging
            brokerUrl: this.config.brokerUrl,
            clientId: this.config.clientId,
            username: this.config.username,
            useTls,
            rejectUnauthorized,
            keepalive: this.config.keepalive
          });
          this.lastErrorLog = now;
        }
        
        // Always schedule reconnect on error (including initial connection failures)
        // This makes the API resilient to cold-start scenarios where MQTT broker starts late
        // scheduleReconnect() has proper guards to cancel existing timers and check max attempts
        logger.warn('MQTT connection error, scheduling reconnect', {
          initialConnection: !initialConnectionSucceeded,
          reconnectAttempts: this.reconnectAttempts
        });
        this.scheduleReconnect();
      });

      this.client.on('offline', () => {
        // Only schedule reconnect if initial connection succeeded
        if (initialConnectionSucceeded && !this.reconnecting) {
          logger.warn('MQTT client offline, scheduling reconnect');
          this.scheduleReconnect();
        }
      });

      this.client.on('close', () => {
        // Only schedule reconnect if initial connection succeeded
        if (initialConnectionSucceeded && !this.reconnecting && this.client) {
          logger.warn('MQTT connection closed, scheduling reconnect');
          this.scheduleReconnect();
        }
      });

      this.client.on('message', (topic, payload) => {
        this.handleMessage(topic, payload).catch(error => {
          logger.error('Error in MQTT message handler', { 
            topic, 
            error: error instanceof Error ? error.message : String(error) 
          });
        });
      });
    });
  }

  /**
   * Disconnect from MQTT broker
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.client) {
      return;
    }

    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        logger.info('Disconnected from MQTT broker');
        this.client = null;
        resolve();
      });
    });
  }

  /**
   * Schedule reconnection with exponential backoff
   * Delays: 1s → 2s → 4s → 8s (max)
   * 
   * Improvements:
   * - Cancels and reschedules if multiple errors arrive in quick succession
   * - Emits fatal event after max retry attempts
   * - Logs detailed reconnection metrics
   */
  private scheduleReconnect(): void {
    // If already scheduled, cancel and reschedule (handles rapid error bursts)
    if (this.reconnectTimer) {
      logger.debug('Canceling existing reconnect timer due to new error');
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Check if max retry limit reached
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      // Emit fatal event for upstream monitoring (only once)
      if (!this.fatalReconnectErrorEmitted) {
        this.fatalReconnectErrorEmitted = true;
        const fatalError = new Error(
          `MQTT reconnection failed after ${this.MAX_RECONNECT_ATTEMPTS} attempts. Broker may be permanently unreachable.`
        );
        
        logger.error('FATAL: MQTT reconnection attempts exhausted', {
          maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
          totalAttempts: this.reconnectAttempts,
          brokerUrl: this.config.brokerUrl,
          lastConnectionAge: this.lastConnectionTimestamp > 0 
            ? Date.now() - this.lastConnectionTimestamp 
            : -1
        });
        
        // Emit fatal event for monitoring systems
        this.emit('reconnect:fatal', {
          error: fatalError,
          attempts: this.reconnectAttempts,
          brokerUrl: this.config.brokerUrl,
          lastConnectionTimestamp: this.lastConnectionTimestamp
        });
      }
      
      // Stop scheduling further reconnects (requires manual restart or intervention)
      this.reconnecting = false;
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(
      this.MAX_RECONNECT_DELAY_MS,
      this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1)
    );

    logger.info('Scheduling MQTT reconnect', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
      delayMs: delay,
      nextDelay: Math.min(
        this.MAX_RECONNECT_DELAY_MS,
        this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts)
      )
    });

    // Emit reconnect attempt event for monitoring
    this.emit('reconnect:attempt', {
      attempt: this.reconnectAttempts,
      maxAttempts: this.MAX_RECONNECT_ATTEMPTS,
      delayMs: delay
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.client) {
        // Ensure clean session flag is preserved across reconnects
        if (this.client.options) {
          this.client.options.clean = this.config.clean;
        }
        logger.debug('Attempting MQTT reconnect', { 
          clean: this.config.clean,
          attempt: this.reconnectAttempts
        });
        this.client.reconnect();
      }
    }, delay);
  }

  /**
   * Subscribe to device topics
   * 
   * @param deviceUuid - Device UUID or '*' for all devices
   * @param topics - Array of topic types: 'sensor', 'state', 'agent', 'logs', 'metrics', 'status'
   */
  async subscribe(deviceUuid: string, topics: string[]): Promise<void> {
    if (!this.client) {
      throw new Error('MQTT client not connected');
    }

    // Convert '*' to MQTT wildcard '+'
    // MQTT wildcards: + (single level), # (multi-level)
    const mqttDevicePattern = deviceUuid === '*' ? '+' : deviceUuid;

    const topicPatterns = topics.map(type => {
      switch (type) {
        case 'endpoints':
          return `iot/device/${mqttDevicePattern}/endpoints/+`;
        case 'state':
          return `iot/device/${mqttDevicePattern}/state`;
        case 'agent':
          return `iot/device/${mqttDevicePattern}/agent/+`;
        case 'logs':
          return `iot/device/${mqttDevicePattern}/logs/+`;
        case 'metrics':
          return `iot/device/${mqttDevicePattern}/metrics`;
        case 'status':
          return `iot/device/${mqttDevicePattern}/status`;
        case 'events':
          return `iot/device/${mqttDevicePattern}/events/+`;
        case 'meta':
          return `iot/device/${mqttDevicePattern}/meta/+`;
        case 'jobs':
          // Jobs topic has two patterns, return both
          return [
            `iot/device/${mqttDevicePattern}/jobs/+/update`,
            `iot/device/${mqttDevicePattern}/jobs/start-next`
          ];
        default:
          logger.warn(`Unknown topic type: ${type}`);
          return null;
      }
    }).flat().filter(Boolean);  // Flatten arrays and remove null values

    logger.info('Subscribing to MQTT topic patterns', { 
      count: topicPatterns.length, 
      patterns: topicPatterns 
    });
    
    // Use Promise.all to track all subscriptions
    const subscriptionPromises = topicPatterns.map(pattern => {
      return new Promise<void>((resolve, reject) => {
        this.client!.subscribe(pattern, { qos: this.config.qos }, (err) => {
          if (err) {
            logger.error('Failed to subscribe to MQTT topic', { pattern, error: err });
            reject(err);
          } else {
            logger.debug('Subscribed to MQTT topic', { pattern, qos: this.config.qos });
            this.subscriptions.add(pattern);
            resolve();
          }
        });
      });
    });

    // Wait for all subscriptions and log summary
    await Promise.all(subscriptionPromises);
    logger.info('SUCCESSFULLY SUBSCRIBED TO ALL MQTT TOPICS', { 
      count: topicPatterns.length,
      topics: topicPatterns,
      clientId: this.config.clientId,
      isConnected: this.isConnected()
    });
  }

  /**
   * Subscribe to all devices
   */
  async subscribeToAll(topics: string[]): Promise<void> {
    await this.subscribe('*', topics);
  }

  /**
   * Subscribe to a specific MQTT topic pattern (for custom subscriptions like jobs)
   */
  async subscribeTopic(topicPattern: string, qos: 0 | 1 | 2 = 1): Promise<void> {
    if (!this.client) {
      throw new Error('MQTT client not connected');
    }

    return new Promise((resolve, reject) => {
      this.client!.subscribe(topicPattern, { qos }, (err) => {
        if (err) {
          logger.error('Failed to subscribe to MQTT topic', { topic: topicPattern, error: err });
          reject(err);
        } else {
          logger.info('Subscribed to MQTT topic', { topic: topicPattern, qos });
          this.subscriptions.add(topicPattern);
          resolve();
        }
      });
    });
  }

  /**
   * Unsubscribe from topics
   */
  async unsubscribe(patterns: string[]): Promise<void> {
    if (!this.client) {
      return;
    }

    const unsubscribePromises = patterns.map(pattern => {
      return new Promise<void>((resolve, reject) => {
        this.client!.unsubscribe(pattern, {}, (err) => {
          if (err) {
            logger.error('Failed to unsubscribe from MQTT topic', { pattern, error: err });
            reject(err);
          } else {
            logger.debug('Unsubscribed from MQTT topic', { pattern });
            this.subscriptions.delete(pattern);
            resolve();
          }
        });
      });
    });

    await Promise.all(unsubscribePromises);
  }

  /**
   * Publish message to device topic
   * Queues messages when offline and drains on reconnect
   */
  publish(topic: string, message: any, qos?: 0 | 1 | 2): Promise<void> {
    const payload = typeof message === 'string' ? message : JSON.stringify(message);
    const publishQos = qos ?? this.config.qos;

    // Queue message if not connected
    if (!this.client || !this.isConnected()) {
      if (this.pendingPublishes.length >= this.MAX_PENDING_PUBLISHES) {
        logger.warn('Offline publish queue full, dropping oldest message', {
          topic,
          queueSize: this.pendingPublishes.length
        });
        this.pendingPublishes.shift(); // Remove oldest
      }
      
      this.pendingPublishes.push({ topic, payload, qos: publishQos });
      logger.debug('Queued message for later publish', {
        topic,
        queueSize: this.pendingPublishes.length
      });
      return Promise.resolve();
    }

    // Publish immediately if connected with timeout protection
    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        logger.error('MQTT publish timeout', { topic, timeoutMs: 5000 });
        reject(new Error(`Publish timeout after 5000ms for topic: ${topic}`));
      }, 5000);

      this.client!.publish(topic, payload, { qos: publishQos }, (err) => {
        clearTimeout(timeoutId);
        if (err) {
          logger.error('Failed to publish MQTT message', { topic, error: err });
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Drain pending publishes after reconnection
   * Retries failed publishes up to MAX_PUBLISH_RETRIES times
   */
  private drainPendingPublishes(): void {
    if (this.pendingPublishes.length === 0) {
      return;
    }

    logger.info('Draining offline publish queue', {
      count: this.pendingPublishes.length
    });

    const messages = [...this.pendingPublishes];
    this.pendingPublishes = [];
    const failedMessages: typeof messages = [];

    messages.forEach(({ topic, payload, qos, retryCount = 0 }) => {
      if (this.client && this.isConnected()) {
        this.client.publish(topic, payload, { qos: qos ?? this.config.qos }, (err) => {
          if (err) {
            const currentRetryCount = retryCount + 1;
            
            if (currentRetryCount < this.MAX_PUBLISH_RETRIES) {
              // Re-queue for retry
              logger.warn('Failed to publish queued message, will retry', { 
                topic, 
                error: err.message,
                retryCount: currentRetryCount,
                maxRetries: this.MAX_PUBLISH_RETRIES
              });
              failedMessages.push({ topic, payload, qos, retryCount: currentRetryCount });
            } else {
              // Max retries exceeded, discard
              logger.error('Failed to publish queued message after max retries, discarding', { 
                topic, 
                error: err.message,
                retryCount: currentRetryCount
              });
            }
          }
        });
      } else {
        // Client disconnected during drain, re-queue
        failedMessages.push({ topic, payload, qos, retryCount });
      }
    });

    // Re-add failed messages to front of queue for next drain attempt
    if (failedMessages.length > 0) {
      logger.info('Re-queuing failed publishes', {
        failed: failedMessages.length,
        total: this.pendingPublishes.length + failedMessages.length
      });
      this.pendingPublishes = [...failedMessages, ...this.pendingPublishes];
    }

    logger.info('Completed draining offline publish queue', {
      sent: messages.length - failedMessages.length,
      failed: failedMessages.length
    });
  }

  /**
   * Re-subscribe to all topics after reconnection
   * Only re-subscribes if clean=true, since clean=false maintains subscriptions in broker
   */
  private resubscribe(): void {
    if (!this.client || this.subscriptions.size === 0) {
      return;
    }

    // With clean=false, broker maintains subscriptions across reconnects
    // Re-subscribing would create duplicates
    if (!this.config.clean) {
      logger.debug('Skipping re-subscribe (clean=false, broker maintains subscriptions)', {
        count: this.subscriptions.size
      });
      return;
    }

    const topics = Array.from(this.subscriptions);

    this.client.subscribe(topics, { qos: this.config.qos }, (err) => {
      if (err) {
        logger.error('Failed to re-subscribe:', err);
      } else {
        logger.info('Re-subscribed to MQTT topics', { count: topics.length });
      }
    });
  }

  /**
   * Parse MQTT topic into structured components
   * Expected format: iot/device/{uuid}/{type}/[subTopic]
   * 
   * @returns Parsed topic structure or null if invalid
   */
  private parseTopic(topic: string): ParsedTopic | null {
    const parts = topic.split('/');
    
    // Validate minimum topic length: iot/device/{uuid}/{type}
    if (parts.length < 4) {
      logger.warn('Topic too short - expected at least iot/device/{uuid}/{type}', { 
        topic, 
        partCount: parts.length 
      });
      return null;
    }
    
    // Validate topic starts with iot/device
    if (parts[0] !== 'iot' || parts[1] !== 'device') {
      logger.warn('Invalid topic format - must start with iot/device', { topic });
      return null;
    }
    
    const deviceUuid = parts[2];
    const messageType = parts[3].toLowerCase(); // Normalize to lowercase for case-insensitive matching
    const rest = parts.slice(4);
    const subTopic = rest.length > 0 ? rest[0] : undefined;
    
    // Validate required fields are non-empty
    if (!deviceUuid || deviceUuid.trim() === '' || !messageType || messageType.trim() === '') {
      logger.warn('Invalid topic structure - missing deviceUuid or messageType', { 
        topic, 
        deviceUuid: deviceUuid || '(empty)', 
        messageType: messageType || '(empty)' 
      });
      return null;
    }

    return {
      deviceUuid,
      messageType,
      subTopic,
      rest
    };
  }

  /**
   * Handle incoming MQTT messages
   */
  private async handleMessage(topic: string, payload: Buffer): Promise<void> {
    // Update last message timestamp for health monitoring
    this.lastMessageTimestamp = Date.now();
    
    try {
      // Parse topic
      const parsed = this.parseTopic(topic);
      if (!parsed) {
        return; // Invalid topic, already logged
      }

      const { deviceUuid, messageType, subTopic, rest } = parsed;
      

      // Parse payload (auto-detects msgpack or JSON) - pass Buffer directly
      let data: any = deserializePayload(payload);

      // Dictionary expansion: Check if message is compacted and expand it
      if (messageType === 'endpoints' && this.cloudDictionaryManager) {
        const isCompacted = this.cloudDictionaryManager.isCompactedMessage(data);
        
        if (isCompacted) {
          try {
            // Log compacted message structure
            logger.info('Compacted message received', {
              deviceUuid: deviceUuid.substring(0, 8),
              version: data.v,
              indicesCount: data.i?.length,
              valuesCount: data.d?.length,
              compactedPayload: JSON.stringify(data).substring(0, 500)
            });

            // Use concurrency limiter to prevent event loop backpressure during bursts
            const expanded = await this.expansionLimit(() => 
              this.cloudDictionaryManager!.expandMessage(deviceUuid, data)
            );
            
            // Log expanded message
            logger.info('Message expanded using dictionary', {
              deviceUuid: deviceUuid.substring(0, 8),
              version: data.v,
              compactedSize: payload.length,
              expandedFields: Object.keys(expanded).length,
              expandedPayload: JSON.stringify(expanded).substring(0, 500)
            });
            
            data = expanded;
          } catch (error) {
            // Dictionary not available yet - buffer in Redis for retry
            if (error instanceof Error && error.message.includes('no dictionary')) {
              await this.bufferPendingMessage(deviceUuid, topic, payload, data.v);
              logger.warn('Message buffered - waiting for dictionary', {
                deviceUuid: deviceUuid.substring(0, 8),
                version: data.v,
                topic
              });
              return; // Don't process yet, will retry when dictionary arrives
            }
            
            logger.error('Failed to expand compacted message', {
              deviceUuid: deviceUuid.substring(0, 8),
              error: error instanceof Error ? error.message : String(error),
              topic
            });
            return;
          }
        } else {
          // Message is not compacted (legacy format or compaction disabled)
          logger.info('Uncompacted message received', {
            deviceUuid: deviceUuid.substring(0, 8),
            messageType,
            subTopic,
            payloadSize: payload.length,
            uncompactedPayload: JSON.stringify(data).substring(0, 500)
          });
        }
      } else if (messageType === 'endpoints') {
        // Dictionary manager not initialized, log original message
        logger.info('Message received (dictionary manager disabled)', {
          deviceUuid: deviceUuid.substring(0, 8),
          messageType,
          subTopic,
          payloadSize: payload.length,
          payload: JSON.stringify(data).substring(0, 500)
        });
      }

      // HA Deduplication: Check if message has msgId and if we've seen it before
      if (data && typeof data === 'object' && data.msgId) {
        const isDupe = await isDuplicateMessage(data.msgId);
        if (isDupe) {
          logger.debug('Duplicate message detected, skipping processing', {
            msgId: data.msgId,
            topic,
            deviceUuid: deviceUuid.substring(0, 8) + '...'
          });
          return; // Skip duplicate
        }
      }

      // Dispatch to appropriate handler
      const handler = this.messageHandlers[messageType];
      if (handler) {
        handler(deviceUuid, subTopic, data, rest);
      } else {
        logger.warn('Unknown message type', {
          operation: 'mqtt-message',
          messageType,
          topic
        });
        this.emitTyped('unknown', { topic, deviceUuid, messageType, data });
      }

    } catch (error) {
      logOperation.error('mqtt-message', 'Failed to handle message', error as Error, { topic });
    }
  }

  /**
   * Handle state message
   */
  private handleStateMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = []): void {
    this.emitTyped('state', { deviceUuid, data });
  }

  /**
   * Handle agent message
   */
  private handleAgentMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = [], msgTrackId?: string): void {
    this.emitTyped('agent', { deviceUuid, subTopic: subTopic || 'unknown', message: data });
  }

  /**
   * Handle metrics message wrapper
   */
  private handleMetricsMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = []): void {
    this.handleMetrics(deviceUuid, data);
  }

  /**
   * Handle status message wrapper
   */
  private handleStatusMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = []): void {
    this.handleStatus(deviceUuid, data);
  }

  /**
   * Handle jobs message
   */
  private handleJobsMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = []): void {
    // Reconstruct original topic: iot/device/{uuid}/jobs/{jobId}/{action}
    const topicParts = ['iot', 'device', deviceUuid, 'jobs'];
    if (subTopic) topicParts.push(subTopic);
    topicParts.push(...rest);
    const topic = topicParts.join('/');
    
    this.emitTyped('jobs', { topic, payload: Buffer.from(JSON.stringify(data)) });
  }

  /**
   * Handle meta message (dictionary sync)
   */
  private async handleMetaMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = []): Promise<void> {
    if (!this.cloudDictionaryManager) {
      logger.warn('Dictionary manager not initialized, ignoring meta message', { deviceUuid, subTopic });
      return;
    }

    try {
      // Check if this is a delta update: /meta/dictionary/delta
      const isDelta = subTopic === 'dictionary' && rest[0] === 'delta';
      
      if (isDelta) {
        // Delta update
        await this.cloudDictionaryManager.applyDelta(deviceUuid, data);
        logger.info('Dictionary delta applied', {
          deviceUuid: deviceUuid.substring(0, 8),
          version: data.version,
          newFields: data.fields?.length
        });
        
        // Process any buffered messages waiting for this dictionary
        await this.processPendingMessages(deviceUuid);
      } else if (subTopic === 'dictionary') {
        // Full dictionary sync
        await this.cloudDictionaryManager.storeDictionary(deviceUuid, data);
        logger.info('Dictionary synchronized from device', {
          deviceUuid: deviceUuid.substring(0, 8),
          version: data.version,
          fieldCount: data.fields?.length
        });
        
        // Process any buffered messages waiting for this dictionary
        await this.processPendingMessages(deviceUuid);
      } else {
        logger.warn('Unknown meta subTopic', { subTopic, rest, deviceUuid });
      }
    } catch (error) {
      logger.error('Failed to handle meta message', {
        error: error instanceof Error ? error.message : String(error),
        deviceUuid,
        subTopic
      });
    }
  }

  /**
   * Handle events message (anomalies, alerts, etc.)
   */
  private handleEventsMessage(deviceUuid: string, subTopic: string | undefined, data: any, rest: string[] = []): void {
    logger.info('handleEventsMessage called', {
      deviceUuid: deviceUuid.substring(0, 8) + '...',
      subTopic: subTopic || 'unknown',
      hasData: !!data,
      dataKeys: data ? Object.keys(data).join(',') : 'none'
    });
    
    // Route based on event subTopic
    if (subTopic === 'anomaly') {
      const event = { deviceId: deviceUuid, ...data };
      
      // Validate required fields
      if (!event.timestampMs || !event.metric || !event.fingerprint) {
        logger.error('Invalid anomaly event - missing required fields', {
          deviceId: deviceUuid,
          hasTimestampMs: !!event.timestampMs,
          hasMetric: !!event.metric,
          hasFingerprint: !!event.fingerprint,
          receivedKeys: Object.keys(data || {}).join(',')
        });
        return;
      }
      
      logger.info('Anomaly event validated, emitting to handler', {
        deviceId: deviceUuid.substring(0, 8),
        metric: event.metric,
        timestampMs: event.timestampMs,
        suppressed: event.suppressed
      });
      
      this.emitTyped('anomaly', event);
    } else {
      logger.warn('Unknown event subTopic', { subTopic, deviceUuid });
    }
  }


  /**
   * Handle endpoint data message
   */
  private handleEndpointsData(deviceUuid: string, sensorName: string | undefined, data: any, rest: string[] = []): void {
    let actualData = data.data || data;
    const timestamp = data.timestamp || new Date().toISOString();

    const endpointData: SensorData = {
      deviceUuid,
      sensorName: sensorName || 'unknown',
      timestamp,
      data: actualData,
      metadata: data.metadata
    };

    this.emitTyped('endpoints', endpointData);
    logger.info('Endpoints event emitted successfully');
  }

  /**
   * Handle log message
   */
  private handleLogMessage(deviceUuid: string, containerId: string | undefined, data: any, rest: string[] = []): void {
    const logMessage: LogMessage = {
      deviceUuid,
      containerId: containerId || 'unknown',
      containerName: data.containerName || containerId || 'unknown',
      message: data.message || data,
      timestamp: data.timestamp || new Date().toISOString(),
      level: data.level,
      stream: data.stream
    };

    this.emitTyped('logs', logMessage);
  }

  /**
   * Handle metrics message
   */
  private handleMetrics(deviceUuid: string, data: any): void {
    logger.info('[MQTT] Received metrics from agent', {
      deviceUuid: deviceUuid.substring(0, 8) + '...',
      cpu_usage: data.cpu_usage,
      memory_usage: data.memory_usage,
      storage_usage: data.storage_usage,
      cpu_temp: data.cpu_temp,
      timestamp: data.timestamp || new Date().toISOString()
    });

    const metrics: MetricsData = {
      deviceUuid,
      timestamp: data.timestamp || new Date().toISOString(),
      cpu_usage: data.cpu_usage,
      memory_usage: data.memory_usage,
      memory_total: data.memory_total,
      storage_usage: data.storage_usage,
      storage_total: data.storage_total,
      cpu_temp: data.cpu_temp,
      network: data.network
    };

  
    this.emitTyped('metrics', metrics);
    logger.info('[MQTT] Emitted metrics event', {
      deviceUuid: deviceUuid.substring(0, 8) + '...',
      eventName: 'metrics'
    });
  }

  /**
   * Handle status message
   */
  private handleStatus(deviceUuid: string, data: any): void {
    logger.debug('Status update received', { 
      deviceUuid: deviceUuid.substring(0, 8) + '...', 
      status: data.status || data 
    });
    this.emitTyped('status', { deviceUuid, status: data });
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    const connected = this.client?.connected || false;
    if (!connected) {
      logger.debug('MQTT connection status check', {
        connected: false,
        clientExists: !!this.client,
        clientId: this.config.clientId
      });
    }
    return connected;
  }

  /**
   * Get reconnecting status
   */
  isReconnecting(): boolean {
    return this.reconnecting;
  }

  /**
   * Get timestamp of last received message (milliseconds since epoch)
   * Returns 0 if no messages received yet
   */
  getLastMessageTimestamp(): number {
    return this.lastMessageTimestamp;
  }

  /**
   * Get timestamp of last successful connection (milliseconds since epoch)
   * Returns 0 if never connected
   */
  getLastConnectionTimestamp(): number {
    return this.lastConnectionTimestamp;
  }

  /**
   * Get broker health metrics
   */
  getHealthMetrics(): {
    connected: boolean;
    reconnecting: boolean;
    lastMessageTimestamp: number;
    lastConnectionTimestamp: number;
    timeSinceLastMessage: number;
    timeSinceLastConnection: number;
    pendingPublishes: number;
    activeSubscriptions: number;
    reconnectAttempts: number;
    maxReconnectAttempts: number;
    isFatal: boolean;
  } {
    const now = Date.now();
    return {
      connected: this.isConnected(),
      reconnecting: this.reconnecting,
      lastMessageTimestamp: this.lastMessageTimestamp,
      lastConnectionTimestamp: this.lastConnectionTimestamp,
      timeSinceLastMessage: this.lastMessageTimestamp > 0 ? now - this.lastMessageTimestamp : -1,
      timeSinceLastConnection: this.lastConnectionTimestamp > 0 ? now - this.lastConnectionTimestamp : -1,
      pendingPublishes: this.pendingPublishes.length,
      activeSubscriptions: this.subscriptions.size,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.MAX_RECONNECT_ATTEMPTS,
      isFatal: this.fatalReconnectErrorEmitted
    };
  }

  /**
   * Wait for MQTT connection to be established
   * @param timeoutMs - Maximum time to wait in milliseconds (default: 5000)
   * @returns Promise that resolves when connected or rejects on timeout
   */
  async awaitConnected(timeoutMs: number = 5000): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.client?.off('connect', onConnect);
        reject(new Error(`MQTT connection timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onConnect = () => {
        clearTimeout(timeout);
        resolve();
      };

      // Wait for next connect event
      this.client?.once('connect', onConnect);

      // If client doesn't exist, reject immediately
      if (!this.client) {
        clearTimeout(timeout);
        reject(new Error('MQTT client not initialized'));
      }
    });
  }

  /**
   * Get active subscriptions
   */
  getSubscriptions(): string[] {
    return Array.from(this.subscriptions);
  }

  /**
   * Manually reset reconnection state after fatal error
   * Useful for recovery after external intervention (e.g., broker restart, network fix)
   * 
   * @example
   * mqttManager.on('reconnect:fatal', () => {
   *   // Alert ops team, wait for fix, then:
   *   setTimeout(() => mqttManager.resetReconnectState(), 60000);
   * });
   */
  resetReconnectState(): void {
    logger.info('Manually resetting MQTT reconnection state', {
      previousAttempts: this.reconnectAttempts,
      wasFatal: this.fatalReconnectErrorEmitted
    });

    this.reconnectAttempts = 0;
    this.fatalReconnectErrorEmitted = false;
    this.reconnecting = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Attempt immediate reconnection
    if (this.client && !this.isConnected()) {
      logger.info('Attempting immediate reconnection after reset');
      this.client.reconnect();
    }

    this.emit('reconnect:reset', {
      timestamp: Date.now()
    });
  }

  /**
   * Destroy manager and cleanup resources
   */
  async destroy(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.disconnect();
    this.removeAllListeners();
    this.subscriptions.clear();
    this.pendingPublishes = [];
  }
}

export default MqttManager;
