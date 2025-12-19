import mqtt, { MqttClient, IClientOptions, IClientPublishOptions } from 'mqtt';
import { EventEmitter } from 'events';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { MessageIdGenerator } from './message-id';

/**
 * Subscription handler entry
 * Supports multiple subscriptions to same or overlapping patterns
 */
type SubscriptionHandler = {
  pattern: string;
  handler: (topic: string, payload: Buffer) => void;
};

/**
 * Centralized MQTT Manager - Singleton
 * 
 * This manager provides a single MQTT connection shared across the application.
 * Used by jobs, shadows, logging, and other features that need MQTT.
 * 
 * Events:
 * - 'connect': Emitted when MQTT connection is established
 */
export class MqttManager extends EventEmitter {
  private static instance: MqttManager;
  private client: MqttClient | null = null;
  private connected = false;
  private subscriptionHandlers: SubscriptionHandler[] = [];
  private connectionPromise: Promise<void> | null = null;
  private debug = false;
  private logger?: AgentLogger;
  private pendingPublishes: Array<{
    topic: string;
    payload: string | Buffer;
    options?: IClientPublishOptions;
  }> = [];
  private readonly MAX_PENDING_PUBLISHES = 1000; // Prevent memory overflow
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds max
  private readonly BASE_RECONNECT_DELAY_MS = 1000; // 1 second base
  private lastBrokerUrl?: string;
  private lastOptions?: IClientOptions;
  private messageIdGenerator?: MessageIdGenerator; // For HA deduplication
  private isReconnecting: boolean = false; // Prevent overlapping reconnection chains

  private constructor() {
    super();
  }

  public static getInstance(): MqttManager {
    if (!MqttManager.instance) {
      MqttManager.instance = new MqttManager();
    }
    return MqttManager.instance;
  }

  /**
   * Set logger for the MQTT manager (singleton pattern)
   */
  public setLogger(logger: AgentLogger | undefined): void {
    this.logger = logger;
  }

  /**
   * Initialize message ID generator for HA deduplication
   * 
   * @param deviceUuid - Device UUID
   */
  public initMessageIdGenerator(deviceUuid: string): void {
    if (!this.messageIdGenerator) {
      this.messageIdGenerator = new MessageIdGenerator(deviceUuid);
      this.logger?.infoSync('Message ID generator initialized for HA deduplication', {
        component: LogComponents.mqtt,
        deviceUuid
      });
    }
  }

  /**
   * Connect to MQTT broker (idempotent - can be called multiple times)
   */
  public async connect(brokerUrl: string, options?: IClientOptions): Promise<void> {
    // Store connection config for self-healing
    this.lastBrokerUrl = brokerUrl;
    this.lastOptions = options;
    
    // If already connected, return
    if (this.client && this.connected) {
      this.debugLog('Already connected to MQTT broker');
      return Promise.resolve();
    }

    // If connection in progress, wait for it
    if (this.connectionPromise) {
      this.debugLog('Connection already in progress, waiting...');
      return this.connectionPromise;
    }

    // Clean up old client if exists (prevent listener leaks on reconnection)
    if (this.client) {
      this.debugLog('Cleaning up old MQTT client before reconnection');
      this.client.removeAllListeners();
      try {
        this.client.end(true);
      } catch (error) {
        this.debugLog(`Error ending old client: ${error}`);
      }
      this.client = null;
    }

    this.debugLog(`Connecting to MQTT broker: ${brokerUrl}`);

    this.connectionPromise = new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        if (!this.connected && this.client) {
          this.debugLog('Connection timeout - MQTT broker not responding');
          this.client.end(true);
          reject(new Error(`MQTT connection timeout after 10s: ${brokerUrl}`));
        }
      }, 10000);

      this.client = mqtt.connect(brokerUrl, {
        ...options,
        clean: true,
        reconnectPeriod: 0, // Disable auto-reconnect, we'll handle it manually
        connectTimeout: 10000,
        keepalive: 60, // Send PINGREQ every 60s to detect dead connections
        reschedulePings: true, // Reschedule ping timer on activity
      });

      this.client.on('connect', () => {
        clearTimeout(connectionTimeout);
        this.connected = true;
        this.reconnectAttempts = 0; // Reset backoff counter on successful connect
        this.isReconnecting = false; // Reset reconnection state
        
        this.logger?.infoSync('Connected to MQTT broker', {
          component: LogComponents.mqtt,
          brokerUrl,
          reconnectAttempts: 0
        });
        
        this.connectionPromise = null;
        
        // Drain pending publishes
        this.drainPendingPublishes();
        
        // Emit connect event for listeners (e.g., CloudSync)
        this.emit('connect');
        
        resolve();
      });

      this.client.on('error', (err) => {
        this.logger?.errorSync('MQTT connection error', err, {
          component: LogComponents.mqtt,
          brokerUrl,
          connected: this.connected
        });
        
        if (!this.connected) {
          clearTimeout(connectionTimeout);
          this.connectionPromise = null;
          reject(err);
        }
      });

      this.client.on('reconnect', () => {
        this.logger?.infoSync('MQTT client reconnecting', {
          component: LogComponents.mqtt,
          reconnectAttempts: this.reconnectAttempts + 1
        });
      });

      this.client.on('offline', () => {
        this.connected = false;
        this.logger?.infoSync('MQTT client offline', {
          component: LogComponents.mqtt,
          pendingPublishes: this.pendingPublishes.length
        });
        // Trigger reconnect immediately on offline
        this.scheduleReconnect(brokerUrl, options);
      });

      this.client.on('close', () => {
        this.connected = false;
        this.logger?.infoSync('MQTT connection closed', {
          component: LogComponents.mqtt,
          pendingPublishes: this.pendingPublishes.length,
          reconnectAttempts: this.reconnectAttempts
        });
        
        // Schedule reconnect with exponential backoff
        this.scheduleReconnect(brokerUrl, options);
      });

      // Critical: Handle 'disconnect' event (broker-initiated disconnect)
      this.client.on('disconnect', () => {
        this.connected = false;
        this.logger?.warnSync('MQTT broker disconnected client (possibly API restart)', {
          component: LogComponents.mqtt,
          pendingPublishes: this.pendingPublishes.length
        });
        // Trigger immediate reconnect
        this.scheduleReconnect(brokerUrl, options);
      });

      // Set up global message handler
      this.client.on('message', (topic: string, payload: Buffer) => {
        this.routeMessage(topic, payload);
      });
    });

    return this.connectionPromise;
  }

  /**
   * Inject msgId into payload for HA deduplication
   * 
   * @param payload - Original payload (string or Buffer)
   * @returns Payload with msgId injected (if JSON), or original payload if not JSON or generator not initialized
   */
  private injectMessageId(payload: string | Buffer): string | Buffer {
    if (!this.messageIdGenerator) {
      return payload; // No generator, return original
    }

    try {
      // Convert Buffer to string if needed
      const payloadStr = Buffer.isBuffer(payload) ? payload.toString('utf-8') : payload;
      
      // Try to parse as JSON
      const json = JSON.parse(payloadStr);
      
      // Inject msgId
      json.msgId = this.messageIdGenerator.generate();
      
      // Return as string (MQTT will handle encoding)
      return JSON.stringify(json);
    } catch (error) {
      // Not JSON or parse error - return original
      this.logger?.debugSync('Cannot inject msgId into non-JSON payload', {
        component: LogComponents.mqtt,
        error: error instanceof Error ? error.message : String(error)
      });
      return payload;
    }
  }

  /**
   * Publish message to MQTT topic
   * 
   * If offline, queues message for delivery on reconnect.
   * Automatically adds msgId to JSON payloads for HA deduplication.
   */
  public async publish(
    topic: string,
    payload: string | Buffer,
    options?: IClientPublishOptions
  ): Promise<void> {
    // Inject msgId for deduplication (only for JSON payloads)
    const enrichedPayload = this.injectMessageId(payload);

    if (!this.client || !this.connected) {
      // Trigger reconnection if we have broker config (self-healing)
      if (this.lastBrokerUrl && !this.connectionPromise) {
        this.logger?.warnSync('MQTT disconnected - triggering reconnection', {
          component: LogComponents.mqtt,
          pendingMessages: this.pendingPublishes.length
        });
        this.scheduleReconnect(this.lastBrokerUrl, this.lastOptions);
      }
      
      // Queue message for delivery on reconnect
      if (this.pendingPublishes.length >= this.MAX_PENDING_PUBLISHES) {
        this.logger?.warnSync(`Pending publish queue full (${this.MAX_PENDING_PUBLISHES}), dropping oldest message`, {
          component: LogComponents.mqtt
        });
        this.pendingPublishes.shift(); // Remove oldest
      }
      
      this.pendingPublishes.push({ topic, payload: enrichedPayload, options });
      this.debugLog(`Queued message for offline delivery: ${topic} (queue size: ${this.pendingPublishes.length})`);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const timeoutError = new Error(`MQTT publish timeout after 5s: ${topic}`);
        console.warn('[MQTT] Publish timeout - forcing reconnect:', topic);
        
        // Force reconnect on timeout
        if (this.lastBrokerUrl) {
          this.connected = false; // Mark as disconnected
          this.scheduleReconnect(this.lastBrokerUrl, this.lastOptions);
        }
        reject(timeoutError);
      }, 5000);
      
      this.client!.publish(topic, enrichedPayload, options || {}, (error) => {
        clearTimeout(timeout);
        if (error) {
          this.logger?.warnSync('MQTT publish failed - forcing reconnect', {
            component: LogComponents.mqtt,
            topic,
            error: error.message
          });
          // Force reconnect on publish error (e.g., ACL denied)
          if (this.lastBrokerUrl) {
            this.connected = false; // Mark as disconnected
            this.scheduleReconnect(this.lastBrokerUrl, this.lastOptions);
          }
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }


    /**
   * Publish message to MQTT topic WITHOUT queueing
   * 
   * Throws error immediately if not connected (no offline queue).
   * Use this for messages that have alternative delivery methods (e.g., HTTP fallback).
   * Automatically adds msgId to JSON payloads for HA deduplication.
   */
  public async publishNoQueue(
    topic: string,
    payload: string | Buffer,
    options?: IClientPublishOptions
  ): Promise<void> {
    // Inject msgId for deduplication (only for JSON payloads)
    const enrichedPayload = this.injectMessageId(payload);

    if (!this.client || !this.connected) {
      throw new Error(`MQTT not connected - cannot publish to ${topic}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MQTT publish timeout after 5s: ${topic}`));
      }, 5000);
      
      this.client!.publish(topic, enrichedPayload, options || {}, (error) => {
        clearTimeout(timeout);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Subscribe to MQTT topic with optional handler
   * 
   * Auto-reconnects if disconnected (self-healing).
   */
  public async subscribe(
    topic: string,
    options?: mqtt.IClientSubscribeOptions,
    handler?: (topic: string, payload: Buffer) => void
  ): Promise<void> {
    // Auto-reconnect if disconnected (self-healing)
    if (!this.isConnected()) {
      if (!this.lastBrokerUrl) {
        throw new Error('MQTT client not connected and no broker URL available for reconnect');
      }
      this.logger?.infoSync('Auto-reconnecting for subscribe operation', {
        component: LogComponents.mqtt,
        topic
      });
      await this.connect(this.lastBrokerUrl, this.lastOptions);
    }

    return new Promise((resolve, reject) => {
      this.client!.subscribe(topic, options || {}, (error, granted) => {
        if (error) {
          const errorMsg = `Subscribe error: ${error.message || 'Unspecified error'}`;
          this.debugLog(`${errorMsg} for topic: ${topic}`);
          this.logger?.errorSync(`Subscribe failed for topic: ${topic}`, error, {
            component: LogComponents.mqtt,
            topic,
            errorCode: (error as any).code,
            granted
          });
          reject(new Error(errorMsg));
        } else if (!granted || granted.length === 0) {
          const errorMsg = `Subscribe failed: No subscription granted for topic: ${topic}`;
          this.debugLog(`${errorMsg}`);
          this.logger?.errorSync(errorMsg, undefined, {
            component: LogComponents.mqtt,
            topic,
            granted
          });
          reject(new Error(errorMsg));
        } else if (granted[0].qos === 128) {
          // QoS 128 means subscription failed (rejected by broker)
          const errorMsg = `Subscribe rejected by broker (QoS=128) for topic: ${topic}`;
          this.debugLog(` ${errorMsg}`);
          this.logger?.errorSync(errorMsg, undefined, {
            component: LogComponents.mqtt,
            topic,
            granted
          });
          reject(new Error(errorMsg));
        } else {
          // Register handler for message routing
          if (handler) {
            this.subscriptionHandlers.push({
              pattern: topic,
              handler
            });
          }
          this.debugLog(`Subscribed to topic: ${topic} (QoS=${granted[0].qos})`);
          resolve();
        }
      });
    });
  }

  /**
   * Unsubscribe from MQTT topic
   */
  public async unsubscribe(topic: string): Promise<void> {
    if (!this.client) {
      throw new Error('MQTT client not initialized');
    }

    return new Promise((resolve, reject) => {
      this.client!.unsubscribe(topic, (error) => {
        if (error) {
          reject(error);
        } else {
          // Remove all handlers for this pattern
          this.subscriptionHandlers = this.subscriptionHandlers.filter(
            h => h.pattern !== topic
          );
          this.debugLog(`Unsubscribed from topic: ${topic}`);
          resolve();
        }
      });
    });
  }

  /**
   * Check if connected
   */
  public isConnected(): boolean {
    return this.connected && this.client !== null;
  }

  /**
   * Disconnect from MQTT broker
   */
  public async disconnect(): Promise<void> {
    if (!this.client) return;

    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        this.connected = false;
        this.subscriptionHandlers = [];
        this.debugLog('Disconnected from MQTT broker');
        resolve();
      });
    });
  }

  /**
   * Get the underlying MQTT client (for advanced usage)
   */
  public getClient(): MqttClient | null {
    return this.client;
  }

  /**
   * Enable/disable debug logging
   */
  public setDebug(enabled: boolean): void {
    this.debug = enabled;
  }

  /**
   * Route incoming messages to registered handlers
   * Supports overlapping patterns (e.g., foo/# and foo/bar)
   */
  private routeMessage(topic: string, payload: Buffer): void {
    this.debugLog(`Received MQTT message: ${topic} (${payload.length} bytes)`);
    
    for (const subscription of this.subscriptionHandlers) {
      if (this.topicMatches(subscription.pattern, topic)) {
        try {
          subscription.handler(topic, payload);
        } catch (error) {
          this.logger?.errorSync(`Error in MQTT handler for pattern ${subscription.pattern}`, error as Error, {
            component: LogComponents.mqtt,
            topic,
            pattern: subscription.pattern
          });
        }
      }
    }
  }

  /**
   * Check if a topic matches a subscription pattern (supports wildcards)
   */
  private topicMatches(pattern: string, topic: string): boolean {
    const patternParts = pattern.split('/');
    const topicParts = topic.split('/');

    if (patternParts.length !== topicParts.length && !pattern.includes('#')) {
      return false;
    }

    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i] === '#') {
        return true; // Multi-level wildcard matches everything after
      }
      if (patternParts[i] === '+') {
        continue; // Single-level wildcard matches any value at this level
      }
      if (patternParts[i] !== topicParts[i]) {
        return false;
      }
    }

    return patternParts.length === topicParts.length;
  }

  /**
   * Schedule reconnect with exponential backoff
   */
  private scheduleReconnect(brokerUrl: string, options?: IClientOptions): void {
    // Prevent overlapping reconnection chains
    if (this.isReconnecting) {
      return;
    }
    this.isReconnecting = true;
    
    this.reconnectAttempts++;
    const delay = Math.min(
      this.MAX_RECONNECT_DELAY_MS,
      this.BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1)
    );
    
    // Use console.log to avoid logging system recursion
    console.log(`[MQTT] Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    setTimeout(() => {
      if (!this.connected && !this.connectionPromise) {
        // Force close stale client before reconnecting (critical for stuck connections)
        if (this.client) {
          console.warn(`[MQTT] Forcefully closing stale client before reconnect (attempt ${this.reconnectAttempts})`);
          this.client.removeAllListeners();
          try {
            this.client.end(true); // Force disconnect
          } catch (error) {
            this.debugLog(`Error ending stale client: ${error}`);
          }
          this.client = null;
        }
        
        this.connect(brokerUrl, options).catch((error) => {
          console.error(`[MQTT] Reconnect attempt ${this.reconnectAttempts} failed:`, error);
          // Reset reconnection state (including connection promise) and schedule next attempt
          this.isReconnecting = false;
          this.connectionPromise = null; // Critical: clear promise so next attempt can proceed
          this.scheduleReconnect(brokerUrl, options);
        });
      }
    }, delay);
  }

  /**
   * Drain pending publishes on reconnect
   */
  private drainPendingPublishes(): void {
    if (this.pendingPublishes.length === 0) {
      return;
    }

    const count = this.pendingPublishes.length;
    this.logger?.infoSync(`Draining ${count} pending MQTT messages`, {
      component: LogComponents.mqtt
    });

    const messages = [...this.pendingPublishes];
    this.pendingPublishes = [];

    for (const msg of messages) {
      this.client!.publish(msg.topic, msg.payload, msg.options || {}, (error) => {
        if (error) {
          this.logger?.errorSync(`Failed to drain message to ${msg.topic}`, error, {
            component: LogComponents.mqtt
          });
          // Re-queue failed message
          this.pendingPublishes.push(msg);
        }
      });
    }
  }

  private debugLog(message: string): void {
    if (this.debug) {
      this.logger?.debugSync(message, {
        component: LogComponents.mqtt
      });
    }
  }
}

