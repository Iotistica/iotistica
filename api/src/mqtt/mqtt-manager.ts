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
  private pendingPublishes: Array<{
    topic: string;
    payload: string | Buffer;
    qos?: 0 | 1 | 2;
  }> = [];
  private readonly MAX_PENDING_PUBLISHES = 1000;

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
  }

  /**
   * Connect to MQTT broker
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
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

      this.client.on('connect', () => {
        logger.info('Connected to MQTT broker', { 
          clientId: this.config.clientId, 
          qos: this.config.qos 
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
        // Throttle error logging to reduce spam
        const now = Date.now();
        if (now - this.lastErrorLog > this.errorLogThrottle) {
          logger.error('MQTT connection error (throttled - shown once per 30s)', { 
            error: error.message || (error as any).code,
            reconnectAttempts: this.reconnectAttempts
          });
          this.lastErrorLog = now;
        }
        
        if (!this.reconnecting) {
          reject(error);
        }
      });

      this.client.on('offline', () => {
        // Only log if not already reconnecting to avoid duplicate logs
        if (!this.reconnecting) {
          logger.warn('MQTT client offline, scheduling reconnect');
          this.scheduleReconnect();
        }
      });

      this.client.on('close', () => {
        if (!this.reconnecting && this.client) {
          logger.warn('MQTT connection closed, scheduling reconnect');
          this.scheduleReconnect();
        }
      });

      this.client.on('message', (topic, payload) => {
        this.handleMessage(topic, payload);
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
        logger.debug('Attempting MQTT reconnect');
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
      }
    });

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
    logger.info('Successfully subscribed to all MQTT topics', { count: topicPatterns.length });
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

    messages.forEach(({ topic, payload, qos }) => {
      if (this.client && this.isConnected()) {
        this.client.publish(topic, payload, { qos: qos ?? this.config.qos }, (err) => {
          if (err) {
            logger.error('Failed to publish queued message', { topic, error: err });
          }
        });
      }
    });

    logger.info('Completed draining offline publish queue', {
      sent: messages.length
    });
  }

  /**
   * Re-subscribe to all topics after reconnection
   */
  private resubscribe(): void {
    if (!this.client || this.subscriptions.size === 0) {
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
   * Handle incoming MQTT messages
   */
  private handleMessage(topic: string, payload: Buffer): void {
    const message = payload.toString();
    
    // DEBUG: Log all incoming messages
    logger.info('MQTT message received', { topic, payloadLength: payload.length });
    
    try {
      // Only accept iot/device/{uuid}/{type}/... format
      const parts = topic.split('/');
      
      // Validate topic starts with iot/device
      if (parts[0] !== 'iot' || parts[1] !== 'device') {
        logger.warn('Invalid topic format - must start with iot/device', { topic });
        return;
      }
      
      const deviceUuid = parts[2];
      const messageType = parts[3];
      const rest = parts.slice(4);
      
      // Validate required fields
      if (!deviceUuid || !messageType) {
        logger.warn('Invalid topic structure', { topic });
        return;
      }
      

      // Parse JSON payload
      let data: any;
      try {
        data = JSON.parse(message);
      } catch {
        // Non-JSON payload (e.g., raw log messages)
        data = message;
        // logOperation.step('mqtt-message', 'Non-JSON payload detected', { 
        //   messageType,
        //   preview: message.substring(0, 100)
        // });
      }

      // Route message based on type
      switch (messageType) {
        case 'endpoints':
          // Topic: iot/device/{uuid}/endpoints/{endpointTopic}
          const endpointTopic = rest[0] || 'unknown';
          this.handleEndpointsData(deviceUuid, endpointTopic, data);
          break;
          
        case 'state':

          this.emit('state', data);
          break;
          
        case 'agent':
          // Topic: iot/device/{uuid}/agent/{subTopic}
          const subTopic = rest[0] || 'unknown';
          this.emit('agent', { deviceUuid, subTopic, message: data });
          break;
          
        case 'logs':
          // Topic: iot/device/{uuid}/logs/{containerId}
          const containerId = rest[0] || 'unknown';
          this.handleLogMessage(deviceUuid, containerId, data);
          break;
          
        case 'metrics':
          this.handleMetrics(deviceUuid, data);
          break;
          
        case 'status':
          this.handleStatus(deviceUuid, data);
          break;
          
        default:
          logger.warn(`Unknown message type`, {
            operation: 'mqtt-message',
            messageType,
            topic
          });
          this.emit('unknown', { topic, deviceUuid, data });
      }
      

    } catch (error) {
      logOperation.error('mqtt-message', 'Failed to handle message', error as Error, { topic });
    }
  }


  /**
   * Handle sensor data message
   */
  private handleEndpointsData(deviceUuid: string, sensorName: string, data: any): void {
    const sensorData: SensorData = {
      deviceUuid,
      sensorName,
      timestamp: data.timestamp || new Date().toISOString(),
      data: data.data || data,
      metadata: data.metadata
    };

    logger.info('Sensor data received - emitting event', { 
      deviceUuid: deviceUuid.substring(0, 8) + '...', 
      sensorName,
      hasData: !!data
    });
    this.emit('endpoints', sensorData);
  }

  /**
   * Handle log message
   */
  private handleLogMessage(deviceUuid: string, containerId: string, data: any): void {
    const logMessage: LogMessage = {
      deviceUuid,
      containerId,
      containerName: data.containerName || containerId,
      message: data.message || data,
      timestamp: data.timestamp || new Date().toISOString(),
      level: data.level,
      stream: data.stream
    };

    this.emit('log', logMessage);
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

  
    this.emit('metrics', metrics);
  }

  /**
   * Handle status message
   */
  private handleStatus(deviceUuid: string, data: any): void {
    logger.debug('Status update received', { 
      deviceUuid: deviceUuid.substring(0, 8) + '...', 
      status: data.status || data 
    });
    this.emit('status', { deviceUuid, status: data });
  }

  /**
   * Get connection status
   */
  isConnected(): boolean {
    return this.client?.connected || false;
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
