/**
 * Redis Client Singleton
 * 
 * Manages Redis connection with automatic reconnection, error handling,
 * and graceful shutdown for pub/sub operations and real-time data distribution.
 */

import Redis from 'ioredis';
import logger from '../utils/logger';

class RedisClient {
  private static instance: RedisClient;
  private client: Redis | null = null;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;

  private constructor() {}

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  /**
   * Initialize Redis connection
   */
  public async connect(): Promise<void> {
    if (this.client && this.isConnected) {
       logger.info('Redis already connected');
      return;
    }

    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);

     logger.info(`Connecting to Redis at ${host}:${port}...`);

    this.client = new Redis({
      host,
      port,
      retryStrategy: (times: number) => {
        this.reconnectAttempts = times;
        
        if (times > this.maxReconnectAttempts) {
           logger.error(` Redis max reconnection attempts (${this.maxReconnectAttempts}) reached`);
          return null; // Stop retrying
        }

        const delay = Math.min(times * 1000, 5000); // Max 5s delay
         logger.info(`⏳ Redis reconnecting in ${delay}ms (attempt ${times}/${this.maxReconnectAttempts})`);
        return delay;
      },
      maxRetriesPerRequest: 20, // Increased for high load scenarios
      enableOfflineQueue: true, // Queue commands during reconnection
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: 10000, // 10 second timeout
      keepAlive: 30000, // Keep connection alive
      reconnectOnError: (err) => {
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
        return targetErrors.some(e => err.message.includes(e));
      },
    });

    // Event handlers
    this.client.on('connect', () => {
       logger.info(' Redis TCP connection established');
    });

    this.client.on('ready', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
       logger.info(' Redis client ready and authenticated');
    });

    this.client.on('error', (err: Error) => {
       logger.error(' Redis error:', {
        message: err.message,
        code: (err as any).code,
        errno: (err as any).errno,
        syscall: (err as any).syscall,
      });
      
      // Don't throw - let retry logic handle it
    });

    this.client.on('close', () => {
      this.isConnected = false;
       logger.info(' Redis connection closed');
    });

    this.client.on('reconnecting', () => {
       logger.info(' Redis reconnecting...');
    });

    this.client.on('end', () => {
      this.isConnected = false;
       logger.info(' Redis connection ended');
    });

    // Wait for ready state
    await new Promise<void>((resolve, reject) => {
      if (!this.client) {
        reject(new Error('Redis client not initialized'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout'));
      }, 10000); // 10s timeout

      this.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });

      this.client.once('error', (err: Error) => {
        clearTimeout(timeout);
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
    return this.isConnected && this.client !== null;
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
   * Returns false on error (graceful degradation)
   */
  public async publishDeviceState(deviceUuid: string, state: any): Promise<boolean> {
    const channel = `device:${deviceUuid}:state`;
    const message = JSON.stringify({
      deviceUuid,
      state,
      timestamp: new Date().toISOString(),
    });

    return await this.publish(channel, message);
  }

  /**
   * Publish device metrics update to Redis
   * Returns false on error (graceful degradation)
   */
  public async publishDeviceMetrics(deviceUuid: string, metrics: any): Promise<boolean> {
    const channel = `device:${deviceUuid}:metrics`;
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
   * @param deviceUuid - Device UUID
   * @param metrics - Metrics object to store
   * @returns Stream ID (e.g., "1699564800000-0") or null on error
   */
  public async addMetric(deviceUuid: string, metrics: any): Promise<string | null> {
    if (!this.isReady()) {
       logger.warn('  Redis not ready, skipping metric stream write');
      return null;
    }

    const streamKey = `metrics:${deviceUuid}`;
    
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
   * Read metrics from Redis Stream
   * Used by background worker to batch process metrics
   * 
   * @param deviceUuid - Device UUID (or '*' for all streams)
   * @param lastId - Last processed stream ID (default: '0-0' for all messages)
   * @param count - Maximum number of messages to read (default: 100)
   * @param blockMs - Block for this many ms if no messages (default: 5000, 0 = no block)
   * @returns Array of stream entries with {id, deviceUuid, metrics, timestamp}
   */
  public async readMetrics(
    deviceUuid: string = '*',
    lastId: string = '0-0',
    count: number = 100,
    blockMs: number = 5000
  ): Promise<Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }>> {
    if (!this.isReady()) {
      return [];
    }

    try {
      // Build stream keys to read from
      const streamKey = deviceUuid === '*' ? 'metrics:*' : `metrics:${deviceUuid}`;
      
      // For wildcard, we need to scan all metrics:* keys first
      let streamKeys: string[];
      if (deviceUuid === '*') {
        streamKeys = await this.client!.keys('metrics:*');
        if (streamKeys.length === 0) {
          return []; // No streams yet
        }
      } else {
        streamKeys = [streamKey];
      }

      // XREAD [BLOCK ms] [COUNT count] STREAMS key [key ...] id [id ...]
      const args: (string | number)[] = [];
      
      if (blockMs > 0) {
        args.push('BLOCK', blockMs);
      }
      
      args.push('COUNT', count, 'STREAMS');
      args.push(...streamKeys);
      
      // Add corresponding lastId for each stream
      streamKeys.forEach(() => args.push(lastId));

      const results = await (this.client!.xread as any)(...args);
      
      if (!results) {
        return []; // No new messages
      }

      // Parse Redis Stream response format:
      // [[streamKey, [[id, [field, value, field, value, ...]]]], ...]
      const entries: Array<{ id: string; deviceUuid: string; metrics: any; timestamp: string }> = [];
      
      for (const [streamKeyResult, messages] of results as any[]) {
        // Extract deviceUuid from stream key (metrics:{uuid})
        const uuid = streamKeyResult.replace('metrics:', '');
        
        for (const [messageId, fields] of messages) {
          // Convert field array to object: [k1, v1, k2, v2] → {k1: v1, k2: v2}
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
        }
      }

      return entries;
    } catch (error) {
       logger.error('  Failed to read metrics from Redis Stream:', error);
      return [];
    }
  }

  /**
   * Acknowledge processed metrics (remove from stream)
   * Called after batch write to PostgreSQL succeeds
   * 
   * @param deviceUuid - Device UUID
   * @param messageIds - Array of stream message IDs to acknowledge
   * @returns Number of messages acknowledged
   */
  public async ackMetrics(deviceUuid: string, messageIds: string[]): Promise<number> {
    if (!this.isReady() || messageIds.length === 0) {
      return 0;
    }

    const streamKey = `metrics:${deviceUuid}`;
    
    try {
      // XDEL removes messages from stream
      const count = await this.client!.xdel(streamKey, ...messageIds);
      return count;
    } catch (error) {
       logger.error('  Failed to acknowledge metrics:', error);
      return 0;
    }
  }

  /**
   * Get stream length (number of pending metrics)
   * Used for monitoring and alerting
   */
  public async getStreamLength(deviceUuid: string): Promise<number> {
    if (!this.isReady()) {
      return 0;
    }

    const streamKey = `metrics:${deviceUuid}`;
    
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
   * Subscribe to device metrics updates (Phase 1)
   * Used by WebSocket manager to forward real-time updates to dashboard
   * 
   * @param deviceUuid - Device UUID or '*' for all devices (pattern subscription)
   * @param callback - Function to call when metrics received
   * @returns Promise<void>
   */
  public async subscribeToDeviceMetrics(
    deviceUuid: string,
    callback: (deviceUuid: string, metrics: any) => void
  ): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Redis not connected - cannot subscribe');
    }

    // Create subscriber client (must be separate from main client in ioredis)
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    
    const subscriber = new Redis({
      host,
      port,
      retryStrategy: (times: number) => {
        if (times > 5) return null; // Stop retrying after 5 attempts
        return Math.min(times * 1000, 3000);
      },
    });

    // Subscribe to pattern or specific channel
    const pattern = deviceUuid === '*' ? 'device:*:metrics' : `device:${deviceUuid}:metrics`;
    
    if (deviceUuid === '*') {
      // Pattern subscription for all devices
      await subscriber.psubscribe(pattern);
      
      subscriber.on('pmessage', (pattern, channel, message) => {
        try {
          const data = JSON.parse(message);
          const uuid = channel.split(':')[1]; // Extract UUID from "device:uuid:metrics"
          callback(uuid, data.metrics);
        } catch (error) {
           logger.error('[Redis] Error parsing metrics message:', error);
        }
      });
      
       logger.info(`[Redis] Subscribed to pattern: ${pattern}`);
    } else {
      // Single channel subscription
      await subscriber.subscribe(pattern);
      
      subscriber.on('message', (channel, message) => {
        try {
          const data = JSON.parse(message);
          callback(deviceUuid, data.metrics);
        } catch (error) {
           logger.error('[Redis] Error parsing metrics message:', error);
        }
      });
      
       logger.info(`[Redis] Subscribed to channel: ${pattern}`);
    }

    // Handle subscriber errors
    subscriber.on('error', (error) => {
       logger.error('[Redis] Subscriber error:', error);
    });
  }

  /**
   * Graceful shutdown
   */
  public async disconnect(): Promise<void> {
    if (!this.client) {
      return;
    }

     logger.info(' Disconnecting Redis client...');

    try {
      await this.client.quit();
      this.client = null;
      this.isConnected = false;
       logger.info(' Redis client disconnected gracefully');
    } catch (error) {
       logger.error(' Error disconnecting Redis:', error);
      // Force disconnect
      this.client.disconnect();
      this.client = null;
      this.isConnected = false;
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
   logger.info('\n SIGINT received, closing Redis connection...');
  await redisClient.disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
   logger.info('\n SIGTERM received, closing Redis connection...');
  await redisClient.disconnect();
  process.exit(0);
});
