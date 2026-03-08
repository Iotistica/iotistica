import mqtt, { MqttClient, IClientOptions, IClientPublishOptions } from 'mqtt';
import { EventEmitter } from 'events';
import msgpack from 'msgpack-lite';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { MessageIdGenerator } from './message-id';
import type { DictionaryManager } from '../dictionary/manager';

/**
 * Explicit payload contract - callers must specify format
 * This prevents implicit parsing/serialization in the transport layer
 */
export type MqttPayload =
  | { format: 'json'; data: object }
  | { format: 'msgpack'; data: object }
  | { format: 'binary'; data: Buffer }
  | { format: 'text'; data: string };

/**
 * Subscription handler entry
 * Supports multiple subscriptions to same or overlapping patterns
 */
type SubscriptionHandler = {
  pattern: string;
  handler: (topic: string, payload: Buffer) => void;
};

/**
 * Helper: Create JSON payload with msgId injection
 * Use this for messages that need HA deduplication
 */
export function createJsonPayload(data: object, msgIdGenerator?: MessageIdGenerator): MqttPayload {
  const enrichedData = msgIdGenerator
    ? { ...data, msgId: msgIdGenerator.generate() }
    : data;
  return { format: 'json', data: enrichedData };
}

/**
 * Helper: Create MessagePack payload with msgId injection
 * Use this for high-frequency sensor data (better compression + faster)
 */
export function createMsgpackPayload(data: object, msgIdGenerator?: MessageIdGenerator): MqttPayload {
  const enrichedData = msgIdGenerator
    ? { ...data, msgId: msgIdGenerator.generate() }
    : data;
  return { format: 'msgpack', data: enrichedData };
}

/**
 * Helper: Serialize payload to Buffer for MQTT transport
 * This is the ONLY place where serialization happens
 */
export function serializePayload(payload: MqttPayload): Buffer {
  switch (payload.format) {
    case 'json':
      return Buffer.from(JSON.stringify(payload.data), 'utf-8');
    case 'msgpack':
      return msgpack.encode(payload.data);
    case 'binary':
      return payload.data;
    case 'text':
      return Buffer.from(payload.data, 'utf-8');
    default:
      // TypeScript exhaustiveness check
      const _exhaustive: never = payload;
      throw new Error(`Unknown payload format: ${(_exhaustive as any).format}`);
  }
}

/**
 * Helper: Deserialize Buffer to payload (for received messages)
 * Tries MessagePack first (fast binary check), then JSON, then binary
 * 
 * TODO (POST-POC): Replace auto-detection with explicit format signaling
 * 
 * Current approach (first-byte heuristics) is acceptable for POC but not production-safe:
 * - Binary data can coincidentally start with msgpack markers (0x90-0x9f, 0x80-0x8f)
 * - Some msgpack types won't match markers (e.g., positive fixint 0x00-0x7f)
 * - False positives = corrupted decoding and data loss
 * 
 * Production solution (choose one):
 * 
 * 1. Topic-based format (RECOMMENDED):
 *    - Agent: Publish to `iot/device/{uuid}/endpoints/msgpack/{endpoint}`
 *    - API: Route by topic pattern, deserialize with explicit format
 *    - Benefits: Format visible in topic, easy debugging, backward compatible
 * 
 * 2. MQTT v5 contentType property:
 *    - Set `properties: { contentType: 'application/x-msgpack' }`
 *    - Requires MQTT v5 broker support
 * 
 * 3. Format prefix byte:
 *    - Prepend 0x01 (JSON) or 0x02 (msgpack) before serialized data
 *    - Simple but adds 1 byte overhead per message
 * 
 * See: docs/MESSAGEPACK-POC-GUIDE.md for migration plan
 */
export function deserializePayload(buffer: Buffer): MqttPayload {
  // Try MessagePack first (check first byte for msgpack markers)
  if (buffer.length > 0) {
    const firstByte = buffer[0];
    // MessagePack markers: 0x90-0x9f (fixarray), 0xdc-0xdd (array16/32), 0x80-0x8f (fixmap)
    if ((firstByte >= 0x90 && firstByte <= 0x9f) || 
        firstByte === 0xdc || firstByte === 0xdd ||
        (firstByte >= 0x80 && firstByte <= 0x8f)) {
      try {
        const data = msgpack.decode(buffer);
        return { format: 'msgpack', data };
      } catch {
        // Not msgpack, continue to JSON
      }
    }
  }
  
  // Try JSON
  try {
    const str = buffer.toString('utf-8');
    const data = JSON.parse(str);
    return { format: 'json', data };
  } catch {
    // Not JSON - treat as binary
    return { format: 'binary', data: buffer };
  }
}

/**
 * Calculate and log compression ratio for POC testing
 * Compares msgpack size vs JSON size
 */
export function logCompressionStats(
  data: object,
  format: 'json' | 'msgpack',
  logger?: AgentLogger | { info: (msg: string, ...args: any[]) => void },
  topic?: string
): void {
  if (format !== 'msgpack' || !logger) return; // Only log for msgpack with valid logger
  
  try {
    const jsonSize = Buffer.from(JSON.stringify(data), 'utf-8').length;
    const msgpackSize = msgpack.encode(data).length;
    const compressionRatio = ((jsonSize - msgpackSize) / jsonSize * 100).toFixed(1);
    const savingsBytes = jsonSize - msgpackSize;
    
    // Use infoSync for AgentLogger, info for simple Logger
    if ('infoSync' in logger) {
      logger.infoSync('MessagePack compression stats', {
        component: LogComponents.mqtt,
        topic: topic?.substring(topic.lastIndexOf('/') + 1) || 'unknown',
        jsonBytes: jsonSize,
        msgpackBytes: msgpackSize,
        savingsBytes,
        compressionPct: `${compressionRatio}%`,
        ratio: `${jsonSize}:${msgpackSize}`
      });
    } else {
      logger.info(
        `MessagePack compression stats - topic: ${topic?.substring(topic.lastIndexOf('/') + 1) || 'unknown'}, ` +
        `json: ${jsonSize}B, msgpack: ${msgpackSize}B, savings: ${savingsBytes}B (${compressionRatio}%)`
      );
    }
  } catch (error) {
    // Ignore logging errors
  }
}

/**
 * Centralized MQTT Manager - Singleton
 * 
 * This manager provides a single MQTT connection shared across the application.
 * Used by jobs, shadows, logging, and other features that need MQTT.
 * 
 * Events:
 * - 'connect': Emitted when MQTT connection is established
 * 
 * TODO (ARCHITECTURE): Consider splitting into layered architecture when complexity justifies
 * 
 * Current monolithic design works well for single-protocol use case, but future needs
 * (multi-protocol support, complex codec switching, advanced testing) may benefit from:
 * 
 * 1. MqttTransport (connect, disconnect, publish, subscribe)
 *    - Pure MQTT.js wrapper
 *    - Easy to mock for unit tests
 *    - Could be abstracted to support AMQP/WebSocket transports
 * 
 * 2. MqttCodec (serialize, deserialize)
 *    - JSON/MessagePack/Protobuf encoding
 *    - Format detection/negotiation
 *    - Independent of transport layer
 * 
 * 3. MqttReliability (queue, retry, deduplication, inflight limiting)
 *    - Pending message queue management
 *    - Exponential backoff reconnection
 *    - Token bucket inflight control
 *    - Message ID deduplication
 * 
 * Benefits:
 * - Testability: Mock transport, test reliability logic in isolation
 * - Codec swapping: Add Protobuf without touching transport/reliability
 * - Maintenance: Clear boundaries reduce cognitive load (~800 lines → 3x ~250 lines)
 * - Reusability: Transport layer could support non-MQTT protocols
 * 
 * Trade-offs:
 * - More files/classes (3 vs 1)
 * - More indirection (method calls across layers)
 * - Only worth it if adding MessagePack/Protobuf support or multi-protocol transport
 * 
 * Decision: Keep monolithic for now. Refactor when adding second codec or protocol.
 */
export class MqttManager extends EventEmitter {
  private static instance: MqttManager;
  private client: MqttClient | null = null;
  private connected = false;
  private subscriptionHandlers: SubscriptionHandler[] = [];
  private connectionPromise: Promise<void> | null = null;
  private debug = false;
  private logger?: AgentLogger;
  
  // TODO (FUTURE): Store format metadata in pending queue for better observability
  // 
  // Current approach (Buffer only) works but loses format information:
  // - Can't re-log compression stats when draining queue
  // - Can't differentiate msgpack/JSON/binary in debug logs
  // - Can't implement format-specific retry logic
  // 
  // Enhanced structure (if needed):
  // private pendingPublishes: Array<{
  //   topic: string;
  //   payload: { buffer: Buffer; format: MqttPayload['format'] };
  //   options?: IClientPublishOptions;
  // }> = [];
  // 
  // Trade-offs:
  // - Pro: Better debugging, format-aware retry, compression stats on drain
  // - Con: Extra memory per queued message (~8 bytes per message)
  // - Con: More complex queue logic
  // 
  // Decision: Not needed for POC. Consider if queue debugging becomes important.
  private pendingPublishes: Array<{
    topic: string;
    payload: string | Buffer;
    options?: IClientPublishOptions;
  }> = [];
  private readonly MAX_PENDING_PUBLISHES = 1000; // Prevent memory overflow
  private readonly MAX_INFLIGHT = 10; // Max concurrent publishes (prevents socket congestion)
  private inflightPublishes = 0; // Current inflight publish count (token bucket)
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY_MS = 30000; // 30 seconds max
  private readonly BASE_RECONNECT_DELAY_MS = 1000; // 1 second base
  private readonly MIN_RECONNECT_INTERVAL = 1000; // Minimum time between reconnect attempts (prevents thrashing)
  private lastReconnectAt = 0; // Timestamp of last reconnect attempt
  private lastBrokerUrl?: string;
  private lastOptions?: IClientOptions;
  private lastDeviceUuid?: string; // Store device UUID for reuse on reconnects
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
      this.logger?.debugSync('Message ID generator initialized for HA deduplication', {
        component: LogComponents.mqtt,
        deviceUuid
      });
    }
  }

  // Dictionary Manager now initialized in agent.ts as top-level service
  // Consumers receive it via dependency injection (FeatureContext)

  /**
   * Connect to MQTT broker (idempotent - can be called multiple times)
   * @param brokerUrl - MQTT broker URL
   * @param options - MQTT client options
   * @param deviceUuid - Optional device UUID to initialize message ID generator for HA deduplication
   */
  public async connect(brokerUrl: string, options?: IClientOptions, deviceUuid?: string): Promise<void> {
    // Store connection config for self-healing
    this.lastBrokerUrl = brokerUrl;
    this.lastOptions = options;
    
    // Store device UUID for reuse on reconnects
    if (deviceUuid) {
      this.lastDeviceUuid = deviceUuid;
      // Initialize message ID generator for HA deduplication
      this.initMessageIdGenerator(deviceUuid);
    } else if (this.lastDeviceUuid) {
      // Reuse device UUID from previous connection (reconnect scenario)
      this.initMessageIdGenerator(this.lastDeviceUuid);
    }
    
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
   * Get message ID generator (for callers to inject msgId before serialization)
   */
  public getMessageIdGenerator(): MessageIdGenerator | undefined {
    return this.messageIdGenerator;
  }

  /**
   * Publish message to MQTT topic
   * 
   * If offline, queues message for delivery on reconnect.
   * 
   * @param topic - MQTT topic
   * @param payload - Buffer, MqttPayload, or string (for backward compatibility)
   * @param options - MQTT publish options
   * 
   * Note: For HA deduplication, use createJsonPayload() with msgIdGenerator before calling this.
   */
  public async publish(
    topic: string,
    payload: Buffer | MqttPayload | string,
    options?: IClientPublishOptions
  ): Promise<void> {
    // Serialize payload if needed (MqttPayload → Buffer)
    const buffer = this.toBuffer(payload);

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
      
      this.pendingPublishes.push({ topic, payload: buffer, options });
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
      
      this.client!.publish(topic, buffer, options || {}, (error) => {
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
   * 
   * @param topic - MQTT topic
   * @param payload - Buffer, MqttPayload, or string (for backward compatibility)
   * @param options - MQTT publish options
   * 
   * Note: For HA deduplication, use createJsonPayload() with msgIdGenerator before calling this.
   */
  public async publishNoQueue(
    topic: string,
    payload: Buffer | MqttPayload | string,
    options?: IClientPublishOptions
  ): Promise<void> {
    // Serialize payload if needed (MqttPayload → Buffer)
    const buffer = this.toBuffer(payload);

    if (!this.client || !this.connected) {
      throw new Error(`MQTT not connected - cannot publish to ${topic}`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`MQTT publish timeout after 5s: ${topic}`));
      }, 5000);
      
      this.client!.publish(topic, buffer, options || {}, (error) => {
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
   * 
   * Guards against reconnection thrashing:
   * - isReconnecting: Prevents overlapping reconnect chains
   * - MIN_RECONNECT_INTERVAL: Prevents rapid-fire reconnects in pathological cases
   *   (e.g., flapping network + slow DNS → repeated forced teardowns)
   */
  private scheduleReconnect(brokerUrl: string, options?: IClientOptions): void {
    // Guard 1: Prevent overlapping reconnection chains
    if (this.isReconnecting) {
      return;
    }

    // Guard 2: Prevent reconnection thrashing (minimum interval between attempts)
    const now = Date.now();
    if (now - this.lastReconnectAt < this.MIN_RECONNECT_INTERVAL) {
      console.log(`[MQTT] Reconnect throttled (min interval: ${this.MIN_RECONNECT_INTERVAL}ms)`);
      return;
    }
    this.lastReconnectAt = now;
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
   * 
   * Uses inflight limiting (token bucket) to prevent memory spikes and socket congestion.
   * - Max 10 concurrent publishes (MAX_INFLIGHT)
   * - Continues draining as callbacks complete
   * - Critical for stability on flaky links
   */
  private drainPendingPublishes(): void {
    if (this.pendingPublishes.length === 0) {
      return;
    }

    const count = this.pendingPublishes.length;
    this.logger?.infoSync(`Draining ${count} pending MQTT messages`, {
      component: LogComponents.mqtt,
      maxInflight: this.MAX_INFLIGHT
    });

    // Drain with inflight limiting (token bucket pattern)
    this.drainBatch();
  }

  /**
   * Drain a batch of pending publishes (respecting inflight limit)
   * Recursively called as publishes complete to maintain steady flow
   */
  private drainBatch(): void {
    // Stop if queue empty or client disconnected
    if (this.pendingPublishes.length === 0 || !this.client || !this.connected) {
      return;
    }

    // Respect inflight limit to prevent socket congestion
    while (this.pendingPublishes.length > 0 && this.inflightPublishes < this.MAX_INFLIGHT) {
      const msg = this.pendingPublishes.shift()!;
      this.inflightPublishes++;

      this.client.publish(msg.topic, msg.payload, msg.options || {}, (error) => {
        this.inflightPublishes--; // Release token

        if (error) {
          this.logger?.errorSync(`Failed to drain message to ${msg.topic}`, error, {
            component: LogComponents.mqtt
          });
          // Re-queue failed message (back to front to preserve order)
          this.pendingPublishes.unshift(msg);
        }

        // Continue draining as callbacks complete (maintains steady flow)
        this.drainBatch();
      });
    }
  }

  /**
   * Convert payload to Buffer for transport
   * Supports: Buffer (passthrough), MqttPayload (serialize), string (backward compat)
   */
  private toBuffer(payload: Buffer | MqttPayload | string): Buffer {
    if (Buffer.isBuffer(payload)) {
      return payload;
    }
    if (typeof payload === 'string') {
      return Buffer.from(payload, 'utf-8');
    }
    // MqttPayload - serialize using helper
    return serializePayload(payload);
  }

  private debugLog(message: string): void {
    if (this.debug) {
      this.logger?.debugSync(message, {
        component: LogComponents.mqtt
      });
    }
  }
}

