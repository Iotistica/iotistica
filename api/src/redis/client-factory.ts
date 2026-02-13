/**
 * Redis Client Factory
 * 
 * Centralized Redis client creation with support for:
 * - Cluster vs standalone mode
 * - Authentication (username/password)
 * - TLS encryption
 * - Different client types (main, subscriber, ingestion, consumer)
 * 
 * Similar to MQTT singleton pattern - provides reusable instances
 * with consistent configuration across the application.
 */

import Redis from 'ioredis';
import logger from '../utils/logger';

interface RedisConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  useTls: boolean;
  tlsServerName: string;
  useCluster: boolean;
}

interface RedisClientOptions {
  clientType?: 'main' | 'subscriber' | 'ingestion' | 'consumer';
  username?: string;
  password?: string;
  tls?: { servername: string };
  maxRetriesPerRequest?: number;
  enableOfflineQueue?: boolean;
  retryStrategy?: (times: number) => number | null;
  reconnectOnError?: (err: Error) => boolean;
  maxReconnectAttempts?: number;
}

class RedisClientFactory {
  private static instance: RedisClientFactory;
  private config: RedisConfig;
  
  // Singleton instances for each client type
  private mainClient: Redis | null = null;
  private subscriberClient: Redis | null = null;
  private ingestionClient: Redis | null = null;
  private consumerClient: Redis | null = null;

  private constructor() {
    // Load configuration from environment
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const username = process.env.REDIS_USERNAME || undefined;
    const password = process.env.REDIS_PASSWORD || undefined;
    
    const tlsFlag = (process.env.REDIS_TLS || process.env.REDIS_USE_TLS || process.env.REDIS_TLS_ENABLED || '')
      .toLowerCase();
    const useTls = tlsFlag === 'true' || tlsFlag === '1' || tlsFlag === 'yes';
    const tlsServerName = process.env.REDIS_TLS_SERVERNAME || host;
    
    const clusterFlag = (process.env.REDIS_CLUSTER || process.env.REDIS_CLUSTER_MODE || '')
      .toLowerCase();
    const useCluster = clusterFlag === 'true' || clusterFlag === '1' || clusterFlag === 'yes';

    this.config = {
      host,
      port,
      username,
      password,
      useTls,
      tlsServerName,
      useCluster,
    };

    logger.info('Redis factory initialized', {
      host,
      port,
      useCluster,
      useTls,
      hasPassword: !!password,
      hasUsername: !!username,
    });
  }

  public static getInstance(): RedisClientFactory {
    if (!RedisClientFactory.instance) {
      RedisClientFactory.instance = new RedisClientFactory();
    }
    return RedisClientFactory.instance;
  }

  /**
   * Create a Redis client with specified options
   */
  private createClient(options: RedisClientOptions): Redis {
    const { host, port, username, password, useTls, tlsServerName, useCluster } = this.config;
    const clientType = options.clientType || 'generic';

    const redisOptions = {
      username: username,
      password: password,
      tls: useTls 
        ? { 
            servername: tlsServerName,
            rejectUnauthorized: true, // Azure uses valid certs - always verify
          } 
        : undefined,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 20,
      enableOfflineQueue: options.enableOfflineQueue ?? true,
      enableReadyCheck: true,
      enableAutoPipelining: true, // Batch commands per event loop for better throughput
      lazyConnect: false,
      
      // Azure Redis failover can take 30-60s, so we need generous timeouts
      connectTimeout: 20000, // 20s for initial connection (Azure failover)
      commandTimeout: 10000, // 10s for hung commands during failover
      keepAlive: 30000, // TCP keepalive interval
      maxLoadingRetryTime: 30000, // 30s to retry LOADING errors during Azure failover
      
      retryStrategy: options.retryStrategy || ((times: number) => {
        const maxAttempts = options.maxReconnectAttempts || 20; // Azure failover needs more attempts
        if (times > maxAttempts) {
          logger.error(`Redis ${clientType} max reconnection attempts (${maxAttempts}) reached`);
          return null;
        }
        // Linear backoff capped at 5s: 1s, 2s, 3s, 4s, 5s, 5s...
        const delay = Math.min(times * 1000, 5000);
        logger.info(`⏳ Redis ${clientType} reconnecting in ${delay}ms (attempt ${times}/${maxAttempts})`);
        return delay;
      }),
      
      reconnectOnError: options.reconnectOnError || ((err: Error) => {
        // Reconnect on common Azure Redis failover errors (case-insensitive)
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT', 'MOVED', 'ASK', 'CLUSTERDOWN'];
        return targetErrors.some(e => err.message?.toUpperCase().includes(e));
      }),
    };

    let client: Redis;

    if (useCluster) {
      logger.info(`Creating Redis Cluster client (${clientType})`, { host, port });
      client = new (Redis as any).Cluster(
        [{ host, port }],
        {
          redisOptions,
          // Prevent DNS lookup issues with Azure internal addresses during MOVED/ASK redirects
          dnsLookup: (address: string, callback: any) => callback(null, address),
          clusterRetryStrategy: (times: number) => {
            const maxAttempts = options.maxReconnectAttempts || 20; // Azure cluster failover
            if (times > maxAttempts) {
              logger.error(`Redis cluster ${clientType} max reconnection attempts (${maxAttempts}) reached`);
              return null;
            }
            // Linear backoff capped at 5s: 1s, 2s, 3s, 4s, 5s, 5s...
            return Math.min(times * 1000, 5000);
          }
        }
      );
    } else {
      logger.info(`Creating Redis standalone client (${clientType})`, { host, port });
      client = new Redis({
        host,
        port,
        ...redisOptions,
      });
    }

    // Event handlers
    client.on('connect', () => {
      logger.info(`✅ Redis ${clientType} TCP connection established`);
    });

    client.on('ready', () => {
      logger.info(`✅ Redis ${clientType} ready and authenticated`);
    });

    client.on('error', (err: Error) => {
      logger.error(`❌ Redis ${clientType} error:`, {
        message: err.message,
        code: (err as any).code,
      });
    });

    client.on('close', () => {
      logger.info(`🔌 Redis ${clientType} connection closed`);
    });

    client.on('reconnecting', () => {
      logger.info(`⏳ Redis ${clientType} reconnecting...`);
    });

    client.on('end', () => {
      logger.info(`🛑 Redis ${clientType} connection ended`);
    });

    return client;
  }

  /**
   * Get main Redis client for general operations
   * Singleton - reuses existing connection
   */
  public getMainClient(): Redis {
    if (!this.mainClient) {
      this.mainClient = this.createClient({
        clientType: 'main',
        maxRetriesPerRequest: 20,
        enableOfflineQueue: true,
      });
    }
    return this.mainClient;
  }

  /**
   * Get subscriber Redis client for pub/sub operations
   * Must be separate from command client (Redis requirement)
   * Singleton - reuses existing connection
   */
  public getSubscriberClient(): Redis {
    if (!this.subscriberClient) {
      this.subscriberClient = this.createClient({
        clientType: 'subscriber',
        maxRetriesPerRequest: 20,
        enableOfflineQueue: true,
      });
    }
    return this.subscriberClient;
  }

  /**
   * Get ingestion Redis client for stream writes
   * Fail-fast configuration - drops writes on overload rather than queueing
   * Singleton - reuses existing connection
   */
  public getIngestionClient(): Redis {
    if (!this.ingestionClient) {
      this.ingestionClient = this.createClient({
        clientType: 'ingestion',
        maxRetriesPerRequest: 3, // Fail fast on overload
        enableOfflineQueue: false, // Fail immediately when Redis unavailable
        retryStrategy: (times: number) => {
          if (times > 10) return null;
          return Math.min(times * 100, 2000);
        },
      });
    }
    return this.ingestionClient;
  }

  /**
   * Get consumer Redis client for stream reads
   * Resilient configuration - waits for Redis availability
   * Singleton - reuses existing connection
   */
  public getConsumerClient(): Redis {
    if (!this.consumerClient) {
      this.consumerClient = this.createClient({
        clientType: 'consumer',
        maxRetriesPerRequest: 10,
        enableOfflineQueue: true, // OK for workers to queue reads
        retryStrategy: (times: number) => {
          if (times > 20) return null;
          return Math.min(times * 200, 3000);
        },
      });
    }
    return this.consumerClient;
  }

  /**
   * Get current config (for debugging)
   */
  public getConfig(): RedisConfig {
    return { ...this.config };
  }

  /**
   * Close all connections (for graceful shutdown)
   */
  public async closeAll(): Promise<void> {
    const clients = [
      { name: 'main', client: this.mainClient },
      { name: 'subscriber', client: this.subscriberClient },
      { name: 'ingestion', client: this.ingestionClient },
      { name: 'consumer', client: this.consumerClient },
    ];

    for (const { name, client } of clients) {
      if (client) {
        try {
          await client.quit();
          logger.info(`Redis ${name} client closed`);
        } catch (err) {
          logger.error(`Error closing Redis ${name} client:`, err);
        }
      }
    }

    this.mainClient = null;
    this.subscriberClient = null;
    this.ingestionClient = null;
    this.consumerClient = null;
  }
}

// Export factory singleton instance
export const redisFactory = RedisClientFactory.getInstance();

// Export convenience functions (similar to MQTT pattern)
export function getRedisClient(): Redis {
  return redisFactory.getMainClient();
}

export function getRedisSubscriber(): Redis {
  return redisFactory.getSubscriberClient();
}

export function getRedisIngestion(): Redis {
  return redisFactory.getIngestionClient();
}

export function getRedisConsumer(): Redis {
  return redisFactory.getConsumerClient();
}

export function getRedisConfig(): RedisConfig {
  return redisFactory.getConfig();
}

export async function closeAllRedisClients(): Promise<void> {
  return redisFactory.closeAll();
}
