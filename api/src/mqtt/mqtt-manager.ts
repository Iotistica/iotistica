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
import logger, { logOperation } from '../utils/logger';
import { isDuplicateMessage } from '../utils/mqtt-deduplication';

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

  // Message type handlers dispatch map
  private readonly messageHandlers: Record<string, (deviceUuid: string, subTopic: string | undefined, data: any) => void>;

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
      events: this.handleEventsMessage.bind(this)
    };
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      let initialConnectionSucceeded = false;
      let connectionTimeout: NodeJS.Timeout | null = null;

      logger.info('Connecting to MQTT broker', { brokerUrl: this.config.brokerUrl });

      const options: mqtt.IClientOptions = {
        clientId: this.config.clientId,
        username: this.config.username || undefined,
        password: this.config.password || undefined,
        reconnectPeriod: this.config.reconnectPeriod,
        keepalive: this.config.keepalive,
        clean: this.config.clean
      };

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
        logger.info('✅ MQTT CLIENT CONNECTED TO BROKER', { 
          brokerUrl: this.config.brokerUrl,
          clientId: this.config.clientId, 
          username: this.config.username,
          qos: this.config.qos,
          keepalive: this.config.keepalive
        });
        this.reconnecting = false;
        this.reconnectCount = 0; // Reset counter on successful connection
        this.reconnectAttempts = 0; // Reset backoff
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
          logger.error('MQTT connection error (throttled - shown once per 30s)', { 
            error: error.message || (error as any).code,
            reconnectAttempts: this.reconnectAttempts,
            initialConnection: !initialConnectionSucceeded
          });
          this.lastErrorLog = now;
        }
        
        // Only reject and cleanup if initial connection failed
        if (!initialConnectionSucceeded && !this.reconnecting) {
          this.client?.end(true); // Force close to prevent further events
          reject(error);
        }
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
        logger.debug('📨 MQTT MESSAGE RECEIVED', { 
          topic, 
          payloadSize: payload.length,
          payloadPreview: payload.toString().substring(0, 100)
        });
        // Handle message asynchronously (deduplication is async)
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
   */
  private scheduleReconnect(): void {
    if (this.reconnecting || this.reconnectTimer) {
      return; // Already scheduled
    }

    this.reconnecting = true;
    this.reconnectAttempts++;

    const delay = Math.min(
      this.MAX_RECONNECT_DELAY_MS,
      this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1)
    );

    logger.info('Scheduling MQTT reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: delay
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.client) {
        // Ensure clean session flag is preserved across reconnects
        if (this.client.options) {
          this.client.options.clean = this.config.clean;
        }
        logger.debug('Attempting MQTT reconnect', { clean: this.config.clean });
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
        default:
          logger.warn(`Unknown topic type: ${type}`);
          return null;
      }
    }).filter(Boolean);  // Remove null values

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
    logger.info('✅ SUCCESSFULLY SUBSCRIBED TO ALL MQTT TOPICS', { 
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
    const messageType = parts[3];
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
    const message = payload.toString();
    
    // Update last message timestamp for health monitoring
    this.lastMessageTimestamp = Date.now();
    
    // DEBUG: Log all incoming messages
    logger.info('MQTT message received', { topic, payloadLength: payload.length });
    
    try {
      // Parse topic
      const parsed = this.parseTopic(topic);
      if (!parsed) {
        return; // Invalid topic, already logged
      }

      const { deviceUuid, messageType, subTopic, rest } = parsed;
      

      // Parse JSON payload
      let data: any;
      try {
        data = JSON.parse(message);
      } catch {
        // Non-JSON payload (e.g., raw log messages)
        data = message;
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
        logger.info('Dispatching to handler', {
          messageType,
          deviceUuid: deviceUuid.substring(0, 8) + '...',
          subTopic,
          hasData: !!data
        });
        handler(deviceUuid, subTopic, data);
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
  private handleStateMessage(deviceUuid: string, subTopic: string | undefined, data: any): void {
    this.emitTyped('state', { deviceUuid, data });
  }

  /**
   * Handle agent message
   */
  private handleAgentMessage(deviceUuid: string, subTopic: string | undefined, data: any): void {
    this.emitTyped('agent', { deviceUuid, subTopic: subTopic || 'unknown', message: data });
  }

  /**
   * Handle metrics message wrapper
   */
  private handleMetricsMessage(deviceUuid: string, subTopic: string | undefined, data: any): void {
    this.handleMetrics(deviceUuid, data);
  }

  /**
   * Handle status message wrapper
   */
  private handleStatusMessage(deviceUuid: string, subTopic: string | undefined, data: any): void {
    this.handleStatus(deviceUuid, data);
  }

  /**
   * Handle events message (anomalies, alerts, etc.)
   */
  private handleEventsMessage(deviceUuid: string, subTopic: string | undefined, data: any): void {
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
      
      this.emitTyped('anomaly', event);
    } else {
      logger.warn('Unknown event subTopic', { subTopic, deviceUuid });
    }
  }


  /**
   * Handle endpoint data message
   */
  private handleEndpointsData(deviceUuid: string, sensorName: string | undefined, data: any): void {
    logger.info('handleEndpointsData called', {
      deviceUuid: deviceUuid.substring(0, 8) + '...',
      sensorName: sensorName || 'unknown',
      hasData: !!data,
      dataKeys: data ? Object.keys(data).join(',') : 'none'
    });

    const endpointData: SensorData = {
      deviceUuid,
      sensorName: sensorName || 'unknown',
      timestamp: data.timestamp || new Date().toISOString(),
      data: data.data || data,
      metadata: data.metadata
    };

    logger.info('Emitting endpoints event', { 
      deviceUuid: deviceUuid.substring(0, 8) + '...', 
      sensorName: endpointData.sensorName,
      timestamp: endpointData.timestamp,
      hasMetadata: !!endpointData.metadata
    });
    this.emitTyped('endpoints', endpointData);
    logger.info('Endpoints event emitted successfully');
  }

  /**
   * Handle log message
   */
  private handleLogMessage(deviceUuid: string, containerId: string | undefined, data: any): void {
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
      activeSubscriptions: this.subscriptions.size
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
