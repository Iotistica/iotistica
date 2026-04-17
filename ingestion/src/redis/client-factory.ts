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
  maxRetriesPerRequest?: number;
  enableOfflineQueue?: boolean;
  retryStrategy?: (times: number) => number | null;
  reconnectOnError?: (err: Error) => boolean;
  /**
   * Override the default commandTimeout (ms). Set to 0 to disable entirely.
   * Must be disabled for blocking consumer clients that use XREADGROUP BLOCK.
   */
  commandTimeout?: number;
}

class RedisClientFactory {
  private static instance: RedisClientFactory;
  private readonly config: RedisConfig;
  private mainClient: Redis | null = null;
  private subscriberClient: Redis | null = null;
  private ingestionClient: Redis | null = null;
  private consumerClient: Redis | null = null;

  private constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = parseInt(process.env.REDIS_PORT || '6379', 10);
    const username = process.env.REDIS_USERNAME || undefined;
    const password = process.env.REDIS_PASSWORD || undefined;

    const tlsFlag = (process.env.REDIS_TLS || process.env.REDIS_USE_TLS || process.env.REDIS_TLS_ENABLED || '').toLowerCase();
    const useTls = tlsFlag === 'true' || tlsFlag === '1' || tlsFlag === 'yes';
    const tlsServerName = process.env.REDIS_TLS_SERVERNAME || host;

    const clusterFlag = (process.env.REDIS_CLUSTER || process.env.REDIS_CLUSTER_MODE || '').toLowerCase();
    const useCluster = clusterFlag === 'true' || clusterFlag === '1' || clusterFlag === 'yes';

    this.config = { host, port, username, password, useTls, tlsServerName, useCluster };

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

  private createClient(options: RedisClientOptions): Redis {
    const { host, port, username, password, useTls, tlsServerName, useCluster } = this.config;
    const clientType = options.clientType || 'generic';

    // commandTimeout must not apply to blocking consumer clients (XREADGROUP BLOCK N).
    // If options.commandTimeout is explicitly 0, disable it (undefined = no timeout).
    const resolvedCommandTimeout = options.commandTimeout === 0
      ? undefined
      : (options.commandTimeout ?? 10000);

    const redisOptions = {
      username,
      password,
      tls: useTls ? { servername: tlsServerName, rejectUnauthorized: true } : undefined,
      maxRetriesPerRequest: options.maxRetriesPerRequest ?? 20,
      enableOfflineQueue: options.enableOfflineQueue ?? true,
      enableReadyCheck: true,
      enableAutoPipelining: true,
      lazyConnect: false,
      connectTimeout: 20000,
      commandTimeout: resolvedCommandTimeout,
      keepAlive: 30000,
      maxLoadingRetryTime: 30000,
      retryStrategy: options.retryStrategy || ((times: number) => {
        const delay = Math.min(times * 1000, 5000);
        logger.info(`Redis ${clientType} reconnecting in ${delay}ms (attempt ${times})`);
        return delay;
      }),
      reconnectOnError: options.reconnectOnError || ((err: Error) => {
        const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT', 'MOVED', 'ASK', 'CLUSTERDOWN'];
        return targetErrors.some((code) => err.message?.toUpperCase().includes(code));
      }),
    };

    let client: Redis;
    if (useCluster) {
      logger.info(`Creating Redis Cluster client (${clientType})`, { host, port });
      client = new (Redis as unknown as { Cluster: new (...args: unknown[]) => Redis }).Cluster(
        [{ host, port }],
        {
          redisOptions,
          dnsLookup: (address: string, callback: (error: Error | null, result: string) => void) => callback(null, address),
          clusterRetryStrategy: (times: number) => Math.min(times * 1000, 5000),
        },
      );
    } else {
      logger.info(`Creating Redis standalone client (${clientType})`, { host, port });
      client = new Redis({ host, port, ...redisOptions });
    }

    client.on('connect', () => logger.info(`Redis ${clientType} TCP connection established`));
    client.on('ready', () => logger.info(`Redis ${clientType} ready and authenticated`));
    client.on('error', (err: Error) => logger.error(`Redis ${clientType} error:`, { message: err.message, code: (err as Error & { code?: string }).code }));
    client.on('close', () => logger.info(`Redis ${clientType} connection closed`));
    client.on('reconnecting', () => logger.info(`Redis ${clientType} reconnecting...`));
    client.on('end', () => logger.info(`Redis ${clientType} connection ended`));

    return client;
  }

  public getMainClient(): Redis {
    if (!this.mainClient) {
      this.mainClient = this.createClient({ clientType: 'main', maxRetriesPerRequest: 20, enableOfflineQueue: true });
    }
    return this.mainClient;
  }

  public getSubscriberClient(): Redis {
    if (!this.subscriberClient) {
      this.subscriberClient = this.createClient({ clientType: 'subscriber', maxRetriesPerRequest: 20, enableOfflineQueue: true });
    }
    return this.subscriberClient;
  }

  public getIngestionClient(): Redis {
    if (!this.ingestionClient) {
      this.ingestionClient = this.createClient({
        clientType: 'ingestion',
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
        retryStrategy: (times: number) => Math.min(times * 100, 2000),
      });
    }
    return this.ingestionClient;
  }

  public getConsumerClient(): Redis {
    if (!this.consumerClient) {
      this.consumerClient = this.createClient({
        clientType: 'consumer',
        maxRetriesPerRequest: 10,
        enableOfflineQueue: true,
        // commandTimeout: 0 disables the timeout — XREADGROUP BLOCK commands legitimately
        // hold the connection for blockTimeMs and must not be interrupted by a socket timeout.
        commandTimeout: 0,
        retryStrategy: (times: number) => Math.min(times * 200, 3000),
      });
    }
    return this.consumerClient;
  }

  public getConfig(): RedisConfig {
    return { ...this.config };
  }

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

export const redisFactory = RedisClientFactory.getInstance();

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