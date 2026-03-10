/**
 * Redis Client Singleton
 * 
 * Manages Redis connection with automatic reconnection, error handling,
 * and graceful shutdown for pub/sub operations and real-time data distribution.
 * 
 * Now uses centralized RedisClientFactory for consistent configuration.
 */

import Redis from 'ioredis';
import logger from '../utils/logger';
import { getRedisClient, getRedisSubscriber } from './client-factory';
import {
  deviceStateChannel,
  deviceMetricsChannel,
  deviceMetricsPattern,
  metricsStreamKey,
  metricsStreamScanPattern,
  parseMetricsStreamKey,
  parseMetricsChannel,
  normalizeTenantId,
  consumerGroupName,
  consumerName as makeConsumerName,
} from './tenant-keys';

class RedisClient {
  private static instance: RedisClient;
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private metricsConsumerGroup = 'metrics-writers';
  private metricsConsumerName: string;
  private subscriberInitialized: boolean = false;
  
  // Callback maps for pub/sub subscriptions (prevents duplicate handlers)
  private patternCallbacks: Map<string, Set<(deviceUuid: string, metrics: any) => void>> = new Map();
  private channelCallbacks: Map<string, Set<(deviceUuid: string, metrics: any) => void>> = new Map();

  private constructor() {
    this.metricsConsumerName = `worker-${process.pid}-${Date.now()}`;
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  /**
   * Initialize Redis connection (using factory)
   */
  public async connect(): Promise<void> {
    if (this.client?.status === 'ready') {
      logger.info('Redis already connected');
      return;
    }

    logger.info('Initializing Redis client via factory...');

    // Get client from factory (handles all cluster/auth/TLS/timeout configuration)
    this.client = getRedisClient();

    // Wait for ready state (ioredis handles connectTimeout internally)
    await new Promise<void>((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Redis client not initialized'));
        return;
      }

      // If already ready, resolve immediately
      if (this.client.status === 'ready') {
        logger.info('Redis client already ready');
        resolve();
        return;
      }

      // Let ioredis handle connection timeout (configured in factory with connectTimeout)
      // This will throw after connectTimeout ms if connection fails
      this.client.once('ready', () => {
        resolve();
      });

      this.client.once('error', (err: Error) => {
        reject(err);
      });
    });
  }

  /**
   * Get Redis client instance
   */
  public getClient(): Redis {
    if (!this.client) {
      throw new Error('Redis client not initialized. Call connect() first.');
    }
    return this.client;
  }

  /**
   * Check if Redis is connected
   */
  public isReady(): boolean {
    return this.client?.status === 'ready';
  }

  /**
   * Publish message to Redis channel
   * Returns false on error (graceful degradation)
   */
  public async publish(channel: string, message: string): Promise<boolean> {
    if (!this.isReady()) {
       logger.warn(` Redis not ready, skipping publish to ${channel}`);
      return false;
    }

    try {
      await this.client!.publish(channel, message);
      // Uncomment for debugging:  logger.info(`📤 Published to Redis channel: ${channel}`);
      return true;
    } catch (error) {
       logger.error(` Failed to publish to Redis channel ${channel}:`, error);
      return false;
    }
  }

  /**
   * Publish device state update to Redis
    * @param tenantId - Tenant identifier (customerId)
    * @param deviceUuid - Device UUID
    * @param state - State object to publish
   * Returns false on error (graceful degradation)
   */
  public async publishDeviceState(tenantId: string, deviceUuid: string, state: any): Promise<boolean> {
    const channel = deviceStateChannel(tenantId, deviceUuid);
    const message = JSON.stringify({
      deviceUuid,
      state,
      timestamp: new Date().toISOString(),
    });
    return await this.publish(channel, message);
  }

  /**
   * Publish device metrics update to Redis
    * @param tenantId - Tenant identifier (customerId)
    * @param deviceUuid - Device UUID
    * @param metrics - Metrics object to publish
   * Returns false on error (graceful degradation)
   */
  public async publishDeviceMetrics(tenantId: string, deviceUuid: string, metrics: any): Promise<boolean> {
    const channel = deviceMetricsChannel(tenantId, deviceUuid);
    const message = JSON.stringify({
      deviceUuid,
      metrics,
      timestamp: new Date().toISOString(),
    });
    return await this.publish(channel, message);
  }

  // ============================================================================
  // Redis Streams Methods (Phase 2)
  // ============================================================================

  /**
   * Add metric to Redis Stream
   * Stream key: metrics:{deviceUuid}
   * Automatically trims stream to ~1000 entries (approximate, Redis optimizes)
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID
   * @param metrics - Metrics object to store
   * @returns Stream ID (e.g., "1699564800000-0") or null on error
   */
  public async addMetric(tenantId: string, deviceUuid: string, metrics: any): Promise<string | null> {
    if (!this.isReady()) {
       logger.warn('  Redis not ready, skipping metric stream write');
      return null;
    }

    const streamKey = metricsStreamKey(tenantId, deviceUuid);
    
    try {
      // Flatten metrics object for Redis Stream fields
      // Redis Streams store key-value pairs, so we JSON stringify nested objects
      const fields: Record<string, string> = {
        timestamp: new Date().toISOString(),
        data: JSON.stringify(metrics)
      };

      // XADD with MAXLEN ~ 1000 (approximate trimming, more efficient than exact)
      // '*' auto-generates stream ID based on timestamp
      const streamId = await this.client!.xadd(
        streamKey,
        'MAXLEN',
        '~', // Approximate trimming (more efficient)
        '1000',
        '*', // Auto-generate ID
        ...Object.entries(fields).flat()
      );

      return streamId;
    } catch (error) {
       logger.error('  Failed to add metric to Redis Stream:', error);
      return null;
    }
  }

  /**
   * Initialize consumer group for metrics streaming
   * Call this once during app startup
   */
  public async initializeMetricsConsumerGroup(): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis not connected');
    }

    try {
      // We don't know which device streams exist yet, so we'll create groups lazily
      logger.info('Metrics consumer group will be created on-demand per device stream', {
        group: this.metricsConsumerGroup
      });
    } catch (error) {
      logger.error('Failed to initialize metrics consumer group', { error });
      throw error;
    }
  }

  /**
   * Ensure consumer group exists for a device's metrics stream
   */
  private async ensureConsumerGroup(tenantId: string, streamKey: string): Promise<void> {
    const groupName = consumerGroupName(tenantId, this.metricsConsumerGroup);
    try {
      await this.client!.xgroup('CREATE', streamKey, groupName, '0', 'MKSTREAM');
      logger.debug(`Created consumer group for ${streamKey}`);
    } catch (err: any) {
      if (!err.message.includes('BUSYGROUP')) {
        throw err; // Unexpected error
      }
      // Group already exists, that's fine
    }
  }

  /**
   * Read metrics from Redis Stream using consumer groups
   * Used by background worker to batch process metrics with at-least-once delivery
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID (or '*' for all streams)
   * @param count - Maximum number of messages to read (default: 100)
   * @param blockMs - Block for this many ms if no messages (default: 5000, 0 = no block)
   * @returns Array of stream entries with {id, deviceUuid, metrics, timestamp}
   */
  public async readMetrics(
    tenantId: string,
    deviceUuid: string = '*',
    count: number = 100,
    blockMs: number = 5000
  ): Promise<Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }>> {
    if (!this.isReady()) {
      return [];
    }

    try {
      const groupName = consumerGroupName(tenantId, this.metricsConsumerGroup);
      const scopedConsumerName = makeConsumerName(tenantId, this.metricsConsumerName);

      // Build stream keys to read from
      const streamKey = deviceUuid === '*' ? metricsStreamScanPattern(tenantId) : metricsStreamKey(tenantId, deviceUuid);
      
      // For wildcard, we need to scan all tenant metrics:* keys first
      let streamKeys: string[];
      if (deviceUuid === '*') {
        // Use SCAN instead of KEYS - non-blocking and safe for production
        streamKeys = [];
        let cursor = '0';
        
        do {
          const result = await this.client!.scan(
            cursor,
            'MATCH',
            metricsStreamScanPattern(tenantId),
            'COUNT',
            100
          );
          cursor = result[0];
          streamKeys.push(...result[1]);
        } while (cursor !== '0');
        
        if (streamKeys.length === 0) {
          return []; // No streams yet
        }
      } else {
        streamKeys = [streamKey];
      }

      // Ensure consumer groups exist for all streams
      await Promise.all(streamKeys.map(key => this.ensureConsumerGroup(tenantId, key)));

      const entries: Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }> = [];

      // Use XREADGROUP for reliable processing with at-least-once delivery
      // In clustered Redis, read each stream separately to avoid CROSSSLOT errors
      for (const key of streamKeys) {
        try {
          // Build xreadgroup args - conditionally include BLOCK option
          const xreadgroupArgs: any[] = [
            'GROUP',
            groupName,
            scopedConsumerName,
            'COUNT',
            count
          ];
          
          if (blockMs > 0) {
            xreadgroupArgs.push('BLOCK', blockMs);
          }
          
          xreadgroupArgs.push('STREAMS', key, '>');
          
          const results = await (this.client!.xreadgroup as any)(...xreadgroupArgs);

          if (!results) {
            continue; // No new messages for this stream
          }

          for (const [streamKeyResult, messages] of results as any[]) {
            const parsed = parseMetricsStreamKey(streamKeyResult);
            if (parsed.tenantId !== normalizeTenantId(tenantId)) {
              logger.warn('Ignoring cross-tenant stream key during readMetrics', {
                expectedTenantId: normalizeTenantId(tenantId),
                actualTenantId: parsed.tenantId,
                streamKey: streamKeyResult,
              });
              continue;
            }
            const uuid = parsed.uuid;
            for (const [messageId, fields] of messages) {
              const fieldObj: Record<string, string> = {};
              for (let i = 0; i < fields.length; i += 2) {
                fieldObj[fields[i]] = fields[i + 1];
              }

              entries.push({
                id: messageId,
                deviceUuid: uuid,
                metrics: JSON.parse(fieldObj.data || '{}'),
                timestamp: fieldObj.timestamp || new Date().toISOString()
              });

              // Stop if we've reached the count limit across all streams
              if (entries.length >= count) {
                break;
              }
            }
            
            if (entries.length >= count) {
              break;
            }
          }
        } catch (err: any) {
          logger.error(`Failed to read from ${key}:`, { error: err.message });
        }
        
        if (entries.length >= count) {
          break;
        }
      }

      return entries;
    } catch (error) {
       logger.error('  Failed to read metrics from Redis Stream:', error);
      return [];
    }
  }

  /**
   * Acknowledge processed metrics using consumer group
   * Called after batch write to PostgreSQL succeeds
   * Provides at-least-once delivery guarantee
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID
   * @param messageIds - Array of stream message IDs to acknowledge
   * @returns Number of messages acknowledged
   */
  public async ackMetrics(tenantId: string, deviceUuid: string, messageIds: string[]): Promise<number> {
    if (!this.isReady() || messageIds.length === 0) {
      return 0;
    }

    const streamKey = metricsStreamKey(tenantId, deviceUuid);
    const groupName = consumerGroupName(tenantId, this.metricsConsumerGroup);
    
    try {
      // XACK marks messages as processed in the consumer group
      // Messages remain in stream for other consumers or manual inspection
      const count = await this.client!.xack(
        streamKey,
        groupName,
        ...messageIds
      );
      return count;
    } catch (error) {
      logger.error('Failed to acknowledge metrics:', error);
      return 0;
    }
  }

  /**
   * Get stream length (number of pending metrics)
   * Used for monitoring and alerting
   */
  public async getStreamLength(tenantId: string, deviceUuid: string): Promise<number> {
    if (!this.isReady()) {
      return 0;
    }

    const streamKey = metricsStreamKey(tenantId, deviceUuid);
    
    try {
      const length = await this.client!.xlen(streamKey);
      return length;
    } catch (error) {
      return 0;
    }
  }

  // ============================================================================
  // Redis Pub/Sub Subscription Methods (Phase 1)
  // ============================================================================

  /**
   * Initialize subscriber event handlers (called once)
   */
  private initializeSubscriber(): void {
    if (this.subscriberInitialized || !this.subscriber) {
      return;
    }

    // Pattern message handler (for wildcard subscriptions)
    this.subscriber.on('pmessage', (pattern: string, channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        const patternMatch = pattern.match(/^tenant:\{([^}]+)\}:/);
        const expectedTenantId = patternMatch?.[1];
        if (!expectedTenantId) {
          logger.warn('Ignoring malformed Redis pattern without tenant', { pattern, channel });
          return;
        }
        const parsed = parseMetricsChannel(channel);
        if (parsed.tenantId !== normalizeTenantId(expectedTenantId)) {
          logger.warn('Ignoring cross-tenant pmessage', {
            expectedTenantId: normalizeTenantId(expectedTenantId),
            actualTenantId: parsed.tenantId,
            pattern,
            channel,
          });
          return;
        }
        
        // Call all registered callbacks for this pattern
        const callbacks = this.patternCallbacks.get(pattern);
        if (callbacks) {
          callbacks.forEach(callback => callback(parsed.uuid, data.metrics));
        }
      } catch (error) {
        logger.error('[Redis] Error parsing pattern message:', error);
      }
    });

    // Channel message handler (for specific channel subscriptions)
    this.subscriber.on('message', (channel: string, message: string) => {
      try {
        const data = JSON.parse(message);
        const channelMatch = channel.match(/^tenant:\{([^}]+)\}:/);
        const expectedTenantId = channelMatch?.[1];
        if (!expectedTenantId) {
          logger.warn('Ignoring malformed Redis channel without tenant', { channel });
          return;
        }
        const parsed = parseMetricsChannel(channel);
        if (parsed.tenantId !== normalizeTenantId(expectedTenantId)) {
          logger.warn('Ignoring cross-tenant message', {
            expectedTenantId: normalizeTenantId(expectedTenantId),
            actualTenantId: parsed.tenantId,
            channel,
          });
          return;
        }
        
        // Call all registered callbacks for this channel
        const callbacks = this.channelCallbacks.get(channel);
        if (callbacks) {
          callbacks.forEach(callback => callback(parsed.uuid, data.metrics));
        }
      } catch (error) {
        logger.error('[Redis] Error parsing channel message:', error);
      }
    });

    // Error handler
    this.subscriber.on('error', (error: Error) => {
      logger.error('[Redis] Subscriber error:', error);
    });

    this.subscriberInitialized = true;
    logger.debug('[Redis] Subscriber event handlers initialized');
  }

  /**
   * Subscribe to device metrics updates (Phase 1)
   * Used by WebSocket manager to forward real-time updates to dashboard
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID or '*' for all devices (pattern subscription)
   * @param callback - Function to call when metrics received
   * @returns Promise<void>
   */
  public async subscribeToDeviceMetrics(
    tenantId: string,
    deviceUuid: string,
    callback: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis not connected - cannot subscribe');
    }

    // Get subscriber client from factory (separate connection for pub/sub)
    if (!this.subscriber) {
      this.subscriber = getRedisSubscriber();
      this.initializeSubscriber(); // Initialize handlers once
    }

    // Determine pattern or channel
    const pattern = deviceUuid === '*' ? deviceMetricsPattern(tenantId) : deviceMetricsChannel(tenantId, deviceUuid);
    
    if (deviceUuid === '*') {
      // Pattern subscription for all devices
      
      // Register callback
      if (!this.patternCallbacks.has(pattern)) {
        this.patternCallbacks.set(pattern, new Set());
        // Only subscribe to Redis if this is a new pattern
        await this.subscriber.psubscribe(pattern);
        logger.info(`[Redis] Subscribed to pattern: ${pattern}`);
      }
      this.patternCallbacks.get(pattern)!.add(callback);
      
    } else {
      // Single channel subscription
      
      // Register callback
      if (!this.channelCallbacks.has(pattern)) {
        this.channelCallbacks.set(pattern, new Set());
        // Only subscribe to Redis if this is a new channel
        await this.subscriber.subscribe(pattern);
        logger.info(`[Redis] Subscribed to channel: ${pattern}`);
      }
      this.channelCallbacks.get(pattern)!.add(callback);
    }

    logger.debug(`[Redis] Callback registered for ${deviceUuid === '*' ? 'pattern' : 'channel'}: ${pattern}`);
  }

  /**
   * Unsubscribe from device metrics updates
   * 
   * @param tenantId - Tenant identifier (customerId)
   * @param deviceUuid - Device UUID or '*' for all devices
   * @param callback - The callback to remove (optional - if not provided, removes all callbacks)
   */
  public async unsubscribeFromDeviceMetrics(
    tenantId: string,
    deviceUuid: string,
    callback?: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.subscriber) {
      return;
    }

    const pattern = deviceUuid === '*' ? deviceMetricsPattern(tenantId) : deviceMetricsChannel(tenantId, deviceUuid);
    
    if (deviceUuid === '*') {
      // Pattern unsubscription
      const callbacks = this.patternCallbacks.get(pattern);
      if (callbacks) {
        if (callback) {
          callbacks.delete(callback);
        } else {
          callbacks.clear();
        }
        
        // If no more callbacks, unsubscribe from Redis
        if (callbacks.size === 0) {
          await this.subscriber.punsubscribe(pattern);
          this.patternCallbacks.delete(pattern);
          logger.info(`[Redis] Unsubscribed from pattern: ${pattern}`);
        }
      }
    } else {
      // Channel unsubscription
      const callbacks = this.channelCallbacks.get(pattern);
      if (callbacks) {
        if (callback) {
          callbacks.delete(callback);
        } else {
          callbacks.clear();
        }
        
        // If no more callbacks, unsubscribe from Redis
        if (callbacks.size === 0) {
          await this.subscriber.unsubscribe(pattern);
          this.channelCallbacks.delete(pattern);
          logger.info(`[Redis] Unsubscribed from channel: ${pattern}`);
        }
      }
    }
  }

  /**
   * Graceful shutdown
   */
  public async disconnect(): Promise<void> {
    logger.info('Disconnecting Redis clients...');

    try {
      // Clear all subscription callbacks
      this.patternCallbacks.clear();
      this.channelCallbacks.clear();
      this.subscriberInitialized = false;
      
      // Import and use factory closeAll
      const { closeAllRedisClients } = await import('./client-factory');
      await closeAllRedisClients();
      
      this.client = null;
      this.subscriber = null;
      logger.info('Redis clients disconnected gracefully');
    } catch (error) {
      logger.error('Error disconnecting Redis:', error);
      this.client = null;
      this.subscriber = null;
      this.patternCallbacks.clear();
      this.channelCallbacks.clear();
      this.subscriberInitialized = false;
    }
  }

  /**
   * Health check
   */
  public async healthCheck(): Promise<boolean> {
    if (!this.isReady()) {
      return false;
    }

    try {
      const pong = await this.client!.ping();
      return pong === 'PONG';
    } catch (error) {
       logger.error(' Redis health check failed:', error);
      return false;
    }
  }
}

// Export singleton instance
export const redisClient = RedisClient.getInstance();

// Graceful shutdown handlers
process.on('SIGINT', async () => {
  logger.info('\nSIGINT received, closing Redis connections...');
  await redisClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\nSIGTERM received, closing Redis connections...');
  await redisClient.disconnect();
  process.exit(0);
});
