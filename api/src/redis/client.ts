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
  agentStateChannel,
  agentMetricsChannel,
  agentMetricsPattern,
  parseMetricsChannel,
  normalizeTenantId,
} from './tenant-keys';

function isRedisOomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('OOM command not allowed');
}

class RedisClient {
  private static instance: RedisClient;
  private client: Redis | null = null;
  private subscriber: Redis | null = null;
  private subscriberInitialized: boolean = false;
  
  // Callback maps for pub/sub subscriptions (prevents duplicate handlers)
  private patternCallbacks: Map<string, Set<(deviceUuid: string, metrics: any) => void>> = new Map();
  private channelCallbacks: Map<string, Set<(deviceUuid: string, metrics: any) => void>> = new Map();

  private constructor() {}

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
  public async publishAgentState(tenantId: string, deviceUuid: string, state: any): Promise<boolean> {
    const channel = agentStateChannel(tenantId, deviceUuid);
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
  public async publishAgentMetrics(tenantId: string, deviceUuid: string, metrics: any): Promise<boolean> {
    const channel = agentMetricsChannel(tenantId, deviceUuid);
    const message = JSON.stringify({
      deviceUuid,
      metrics,
      timestamp: new Date().toISOString(),
    });
    return await this.publish(channel, message);
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
   * @param deviceUuid - Device UUID or '*' for all agents (pattern subscription)
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
    const pattern = deviceUuid === '*' ? agentMetricsPattern(tenantId) : agentMetricsChannel(tenantId, deviceUuid);
    
    if (deviceUuid === '*') {
      // Pattern subscription for all agents
      
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
   * @param deviceUuid - Device UUID or '*' for all agents
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

    const pattern = deviceUuid === '*' ? agentMetricsPattern(tenantId) : agentMetricsChannel(tenantId, deviceUuid);
    
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
