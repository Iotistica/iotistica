import mqtt, { MqttClient, IClientOptions, IClientPublishOptions } from 'mqtt';
import { EventEmitter } from 'events';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { MessageIdGenerator } from './utils';
import type { DictionaryManager } from '../managers/dictionary';
import { MessageBufferSync } from './buffer';
import type { BufferSyncConfig } from './buffer';
import { serializePayload } from './codec';
import type { MqttPayload } from './codec';
import { MqttRouter } from './router';

export {
  createJsonPayload,
  createMsgpackPayload,
  serializePayload,
  deserializePayload,
  logCompressionStats,
} from './codec';
export type { MqttPayload } from './codec';

export type PublishMode = 'direct' | 'buffer-only' | 'recovering';

export interface MqttConnectOptions {
  bufferSync?: boolean;
  bufferSyncOptions?: Partial<BufferSyncConfig>;
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
export class CloudMqttClient extends EventEmitter {
  private static instance: CloudMqttClient;
  private client: MqttClient | null = null;
  private connected = false;
  private readonly router = new MqttRouter();
  private subscribedTopics = new Set<string>(); // Tracks topics actually subscribed with the broker
  private connectionPromise: Promise<void> | null = null;
  private debug = false;
  private logger?: AgentLogger;
  private bufferSync?: MessageBufferSync;
  private publishMode: PublishMode = 'direct';
  
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

  public static getInstance(): CloudMqttClient {
    if (!CloudMqttClient.instance) {
      CloudMqttClient.instance = new CloudMqttClient();
    }
    return CloudMqttClient.instance;
  }

  /**
   * Set logger for the MQTT manager (singleton pattern)
   */
  public setLogger(logger: AgentLogger | undefined): void {
    this.logger = logger;
  }

  public getPublishMode(): PublishMode {
    return this.publishMode;
  }

  public setPublishMode(mode: PublishMode, reason?: string): void {
    if (this.publishMode === mode) {
      return;
    }

    const previousMode = this.publishMode;
    this.publishMode = mode;

    this.logInfo('MQTT publish mode changed', {
      previousMode,
      nextMode: mode,
      ...(reason ? { reason } : {}),
    });
  }

  public requestBufferedFlush(reason?: string): void {
    if (!this.bufferSync?.isEnabled()) {
      return;
    }

    this.debugLog(`Requesting buffered flush${reason ? ` (${reason})` : ''}`);
    this.bufferSync.requestFlush();
  }

  /**
   * Enable local message buffer sync service (idempotent)
   */
  public async enableBufferSync(
    logger?: AgentLogger,
    options?: Partial<BufferSyncConfig>
  ): Promise<void> {
    if (this.bufferSync) {
      return;
    }

    const syncLogger = logger || this.logger;

    this.bufferSync = new MessageBufferSync(this, syncLogger, {
      flushBatchSize: 100,
      flushIntervalMs: 30000,
      maxRetries: 3,
      cleanupIntervalMs: 3600000,
      maxBufferRecords: 10000,
      dropPolicy: 'oldest',
      flushTriggerThreshold: 1000,
      maxFlushPerCycle: 1000,
      bufferEvenWhenOnline: false,
      enabled: options?.enabled ?? true,
      ...options,
    });

    if (this.isConnected()) {
      await this.bufferSync.start();
      syncLogger?.infoSync('Message buffer sync started', {
        component: LogComponents.mqtt,
      });
    } else {
      this.once('connect', () => {
        this.bufferSync
          ?.start()
          .then(() => {
            this.logInfo('Message buffer sync started');
          })
          .catch((error) => {
            this.logError(
              'Failed to start message buffer sync after MQTT connect',
              error instanceof Error ? error : new Error(String(error)),
              undefined
            );
          });
      });
    }
  }

  /**
   * Disable local message buffer sync service
   */
  public disableBufferSync(): void {
    if (!this.bufferSync) {
      return;
    }

    this.bufferSync.stop();
    this.bufferSync = undefined;

    this.logInfo('Message buffer sync stopped');
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
   * @param extra - Optional manager-level connection options
   */
  public async connect(
    brokerUrl: string,
    options?: IClientOptions,
    deviceUuid?: string,
    extra?: MqttConnectOptions
  ): Promise<void> {
    // Store connection config for self-healing
    this.lastBrokerUrl = brokerUrl;
    this.lastOptions = options;

    if (extra?.bufferSync && !this.bufferSync) {
      await this.enableBufferSync(this.logger, extra.bufferSyncOptions);
    }
    
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
    this.cleanupExistingClient();

    this.debugLog(`Connecting to MQTT broker: ${brokerUrl}`);

    return this.waitForConnection(brokerUrl, options);
  }

  private cleanupExistingClient(): void {
    if (!this.client) {
      return;
    }

    this.debugLog('Cleaning up old MQTT client before reconnection');
    this.client.removeAllListeners();
    try {
      this.client.end(true);
    } catch (error) {
      this.debugLog(`Error ending old client: ${error}`);
    }
    this.client = null;
  }

  private createClient(brokerUrl: string, options?: IClientOptions): MqttClient {
    return mqtt.connect(brokerUrl, {
      ...options,
      clean: true,
      reconnectPeriod: 0, // Disable auto-reconnect, we'll handle it manually
      connectTimeout: 10000,
      keepalive: 60, // Send PINGREQ every 60s to detect dead connections
      reschedulePings: true, // Reschedule ping timer on activity
    });
  }

  private attachClientHandlers(
    client: MqttClient,
    brokerUrl: string,
    options: IClientOptions | undefined,
    connectionTimeout: ReturnType<typeof setTimeout>,
    resolve: () => void,
    reject: (reason?: any) => void
  ): void {
    client.on('connect', () => {
      this.handleConnect(brokerUrl, connectionTimeout, resolve);
    });

    client.on('error', (err) => {
      this.handleConnectionError(err, brokerUrl, connectionTimeout, reject);
    });

    client.on('reconnect', () => {
      this.handleReconnect();
    });

    client.on('offline', () => {
      this.handleOffline(brokerUrl, options);
    });

    client.on('close', () => {
      this.handleClose(brokerUrl, options);
    });

    client.on('disconnect', () => {
      this.handleDisconnect(brokerUrl, options);
    });

    client.on('message', (topic: string, payload: Buffer) => {
      this.routeMessage(topic, payload);
    });
  }

  private waitForConnection(brokerUrl: string, options?: IClientOptions): Promise<void> {
    this.connectionPromise = new Promise((resolve, reject) => {
      const connectionTimeout = setTimeout(() => {
        if (!this.connected && this.client) {
          this.debugLog('Connection timeout - MQTT broker not responding');
          this.client.end(true);
          reject(new Error(`MQTT connection timeout after 10s: ${brokerUrl}`));
        }
      }, 10000);

      this.client = this.createClient(brokerUrl, options);
      this.attachClientHandlers(this.client, brokerUrl, options, connectionTimeout, resolve, reject);
    });

    return this.connectionPromise;
  }

  private handleConnect(
    brokerUrl: string,
    connectionTimeout: ReturnType<typeof setTimeout>,
    resolve: () => void
  ): void {
    clearTimeout(connectionTimeout);
    this.connected = true;
    this.reconnectAttempts = 0; // Reset backoff counter on successful connect
    this.isReconnecting = false; // Reset reconnection state

    this.logInfo('Connected to MQTT broker', {
      brokerUrl,
      reconnectAttempts: 0
    });

    this.connectionPromise = null;

    // Resubscribe to all previously registered topics (new client session starts clean)
    this.resubscribeAll();

    // Drain pending publishes
    this.drainPendingPublishes();

    // Emit connect event for listeners (e.g., CloudSync)
    this.emit('connect');

    resolve();
  }

  private handleConnectionError(
    err: Error,
    brokerUrl: string,
    connectionTimeout: ReturnType<typeof setTimeout>,
    reject: (reason?: any) => void
  ): void {
    this.logError('MQTT connection error', err, {
      brokerUrl,
      connected: this.connected
    });

    if (!this.connected) {
      clearTimeout(connectionTimeout);
      this.connectionPromise = null;
      reject(err);
    }
  }

  private handleReconnect(): void {
    this.logInfo('MQTT client reconnecting', {
      reconnectAttempts: this.reconnectAttempts + 1
    });
  }

  private handleOffline(brokerUrl: string, options?: IClientOptions): void {
    this.connected = false;
    this.logInfo('MQTT client offline', {
      pendingPublishes: this.pendingPublishes.length
    });
    // Trigger reconnect immediately on offline
    this.scheduleReconnect(brokerUrl, options);
  }

  private handleClose(brokerUrl: string, options?: IClientOptions): void {
    this.connected = false;
    this.logInfo('MQTT connection closed', {
      pendingPublishes: this.pendingPublishes.length,
      reconnectAttempts: this.reconnectAttempts
    });

    // Schedule reconnect with exponential backoff
    this.scheduleReconnect(brokerUrl, options);
  }

  private handleDisconnect(brokerUrl: string, options?: IClientOptions): void {
    this.connected = false;
    this.logWarn('MQTT broker disconnected client (possibly API restart)', {
      pendingPublishes: this.pendingPublishes.length
    });
    // Trigger immediate reconnect
    this.scheduleReconnect(brokerUrl, options);
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

    if (this.bufferSync?.isEnabled()) {
      const handled = await this.bufferSync.handlePublish(topic, buffer, options);
      if (handled) {
        return;
      }
    }

    if (!this.client || !this.connected) {
      // Trigger reconnection if we have broker config (self-healing)
      if (this.lastBrokerUrl && !this.connectionPromise) {
        this.logWarn('MQTT disconnected - triggering reconnection', {
          pendingMessages: this.pendingPublishes.length
        });
        this.scheduleReconnect(this.lastBrokerUrl, this.lastOptions);
      }
      
      // Queue message for delivery on reconnect
      if (this.pendingPublishes.length >= this.MAX_PENDING_PUBLISHES) {
        this.logWarn(`Pending publish queue full (${this.MAX_PENDING_PUBLISHES}), dropping oldest message`);
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
          this.logWarn('MQTT publish failed - forcing reconnect', {
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

    if (this.bufferSync?.isEnabled()) {
      const handled = await this.bufferSync.handlePublish(topic, buffer, options);
      if (handled) {
        return;
      }
    }

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
      this.logInfo('Auto-reconnecting for subscribe operation', {
        topic
      });
      await this.connect(this.lastBrokerUrl, this.lastOptions);
    }

    // Register handler and topic BEFORE the broker subscribe call so that
    // resubscribeAll() picks them up if a reconnect fires concurrently.
    if (handler) {
      this.router.addHandler(topic, handler);
    }
    this.subscribedTopics.add(topic);

    return new Promise((resolve, reject) => {
      const rollback = () => {
        if (handler) {
          this.router.removeHandler(handler);
        }
        // Only remove from set if no other handler still references this topic
        if (!this.router.hasPattern(topic)) {
          this.subscribedTopics.delete(topic);
        }
      };

      this.client!.subscribe(topic, options || {}, (error, granted) => {
        if (error) {
          const errorMsg = `Subscribe error: ${error.message || 'Unspecified error'}`;
          this.debugLog(`${errorMsg} for topic: ${topic}`);
          this.logError(`Subscribe failed for topic: ${topic}`, error, {
            topic,
            errorCode: (error as any).code,
            granted
          });
          rollback();
          reject(new Error(errorMsg));
        } else if (!granted || granted.length === 0) {
          const errorMsg = `Subscribe failed: No subscription granted for topic: ${topic}`;
          this.debugLog(`${errorMsg}`);
          this.logError(errorMsg, undefined, {
            topic,
            granted
          });
          rollback();
          reject(new Error(errorMsg));
        } else if (granted[0].qos === 128) {
          // QoS 128 means subscription failed (rejected by broker)
          const errorMsg = `Subscribe rejected by broker (QoS=128) for topic: ${topic}`;
          this.debugLog(` ${errorMsg}`);
          this.logError(errorMsg, undefined, {
            topic,
            granted
          });
          rollback();
          reject(new Error(errorMsg));
        } else {
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
          // Remove all handlers and the tracked topic for this pattern
          this.router.removePattern(topic);
          this.subscribedTopics.delete(topic);
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

    // Stop background flush/cleanup timers before disconnecting transport
    this.disableBufferSync();

    return new Promise((resolve) => {
      this.client!.end(false, {}, () => {
        this.connected = false;
        this.router.clear();
        this.subscribedTopics.clear();
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

    this.router.route(topic, payload, (pattern, error) => {
      this.logError(`Error in MQTT handler for pattern ${pattern}`, error as Error, {
        topic,
        pattern
      });
    });
  }

  /**
   * Schedule reconnect with exponential backoff
   * 
   * Guards against reconnection thrashing:
   * - isReconnecting: Prevents overlapping reconnect chains
   * - MIN_RECONNECT_INTERVAL: Prevents rapid-fire reconnects in pathological cases
   *   (e.g., flapping network + slow DNS → repeated forced teardowns)
   */
  /**
   * Resubscribe all registered handlers after a reconnect.
   * Each reconnect creates a new MQTT client/session, so the broker has no
   * record of previous subscriptions — we must re-issue them explicitly.
   */
  private resubscribeAll(): void {
    if (this.subscribedTopics.size === 0) {
      return;
    }

    const topics = [...this.subscribedTopics];
    this.logInfo(`Resubscribing to ${topics.length} topic(s) after reconnect`, {
      topics
    });

    for (const topic of topics) {
      this.client!.subscribe(topic, { qos: 1 }, (error, granted) => {
        if (error) {
          this.logError(`Resubscribe failed for topic: ${topic}`, error, {
            topic
          });
        } else if (!granted || granted.length === 0 || granted[0].qos === 128) {
          this.logError(`Resubscribe rejected by broker for topic: ${topic}`, undefined, {
            topic,
            granted
          });
        } else {
          this.logInfo(`Resubscribed to topic: ${topic} (QoS=${granted[0].qos})`, {
            topic
          });
        }
      });
    }
  }

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
      if (this.connected) {
        // Connection recovered while waiting for backoff delay.
        this.isReconnecting = false;
        return;
      }

      if (this.connectionPromise) {
        // Another connect attempt is already in flight. Wait for it to settle,
        // then continue the reconnect chain if we're still offline.
        this.connectionPromise
          .catch(() => {
            // Ignore here; follow-up scheduling is handled below.
          })
          .finally(() => {
            if (this.connected) {
              this.isReconnecting = false;
              return;
            }

            this.isReconnecting = false;
            this.connectionPromise = null;
            this.scheduleReconnect(brokerUrl, options);
          });
        return;
      }

      if (!this.connected) {
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
    this.logInfo(`Draining ${count} pending MQTT messages`, {
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
          this.logError(`Failed to drain message to ${msg.topic}`, error);
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

  private logInfo(msg: string, data?: object): void {
    this.logger?.infoSync(msg, {
      component: LogComponents.mqtt,
      ...(data || {})
    });
  }

  private logWarn(msg: string, data?: object): void {
    this.logger?.warnSync(msg, {
      component: LogComponents.mqtt,
      ...(data || {})
    });
  }

  private logError(msg: string, err?: Error, data?: object): void {
    this.logger?.errorSync(msg, err, {
      component: LogComponents.mqtt,
      ...(data || {})
    });
  }
}

