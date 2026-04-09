"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisFactory = void 0;
exports.getRedisClient = getRedisClient;
exports.getRedisSubscriber = getRedisSubscriber;
exports.getRedisIngestion = getRedisIngestion;
exports.getRedisConsumer = getRedisConsumer;
exports.getRedisConfig = getRedisConfig;
exports.closeAllRedisClients = closeAllRedisClients;
const ioredis_1 = __importDefault(require("ioredis"));
const logger_1 = __importDefault(require("../utils/logger"));
class RedisClientFactory {
    static instance;
    config;
    mainClient = null;
    subscriberClient = null;
    ingestionClient = null;
    consumerClient = null;
    constructor() {
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
        logger_1.default.info('Redis factory initialized', {
            host,
            port,
            useCluster,
            useTls,
            hasPassword: !!password,
            hasUsername: !!username,
        });
    }
    static getInstance() {
        if (!RedisClientFactory.instance) {
            RedisClientFactory.instance = new RedisClientFactory();
        }
        return RedisClientFactory.instance;
    }
    createClient(options) {
        const { host, port, username, password, useTls, tlsServerName, useCluster } = this.config;
        const clientType = options.clientType || 'generic';
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
            commandTimeout: 10000,
            keepAlive: 30000,
            maxLoadingRetryTime: 30000,
            retryStrategy: options.retryStrategy || ((times) => {
                const delay = Math.min(times * 1000, 5000);
                logger_1.default.info(`Redis ${clientType} reconnecting in ${delay}ms (attempt ${times})`);
                return delay;
            }),
            reconnectOnError: options.reconnectOnError || ((err) => {
                const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT', 'MOVED', 'ASK', 'CLUSTERDOWN'];
                return targetErrors.some((code) => err.message?.toUpperCase().includes(code));
            }),
        };
        let client;
        if (useCluster) {
            logger_1.default.info(`Creating Redis Cluster client (${clientType})`, { host, port });
            client = new ioredis_1.default.Cluster([{ host, port }], {
                redisOptions,
                dnsLookup: (address, callback) => callback(null, address),
                clusterRetryStrategy: (times) => Math.min(times * 1000, 5000),
            });
        }
        else {
            logger_1.default.info(`Creating Redis standalone client (${clientType})`, { host, port });
            client = new ioredis_1.default({ host, port, ...redisOptions });
        }
        client.on('connect', () => logger_1.default.info(`Redis ${clientType} TCP connection established`));
        client.on('ready', () => logger_1.default.info(`Redis ${clientType} ready and authenticated`));
        client.on('error', (err) => logger_1.default.error(`Redis ${clientType} error:`, { message: err.message, code: err.code }));
        client.on('close', () => logger_1.default.info(`Redis ${clientType} connection closed`));
        client.on('reconnecting', () => logger_1.default.info(`Redis ${clientType} reconnecting...`));
        client.on('end', () => logger_1.default.info(`Redis ${clientType} connection ended`));
        return client;
    }
    getMainClient() {
        if (!this.mainClient) {
            this.mainClient = this.createClient({ clientType: 'main', maxRetriesPerRequest: 20, enableOfflineQueue: true });
        }
        return this.mainClient;
    }
    getSubscriberClient() {
        if (!this.subscriberClient) {
            this.subscriberClient = this.createClient({ clientType: 'subscriber', maxRetriesPerRequest: 20, enableOfflineQueue: true });
        }
        return this.subscriberClient;
    }
    getIngestionClient() {
        if (!this.ingestionClient) {
            this.ingestionClient = this.createClient({
                clientType: 'ingestion',
                maxRetriesPerRequest: 3,
                enableOfflineQueue: false,
                retryStrategy: (times) => Math.min(times * 100, 2000),
            });
        }
        return this.ingestionClient;
    }
    getConsumerClient() {
        if (!this.consumerClient) {
            this.consumerClient = this.createClient({
                clientType: 'consumer',
                maxRetriesPerRequest: 10,
                enableOfflineQueue: true,
                retryStrategy: (times) => Math.min(times * 200, 3000),
            });
        }
        return this.consumerClient;
    }
    getConfig() {
        return { ...this.config };
    }
    async closeAll() {
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
                    logger_1.default.info(`Redis ${name} client closed`);
                }
                catch (err) {
                    logger_1.default.error(`Error closing Redis ${name} client:`, err);
                }
            }
        }
        this.mainClient = null;
        this.subscriberClient = null;
        this.ingestionClient = null;
        this.consumerClient = null;
    }
}
exports.redisFactory = RedisClientFactory.getInstance();
function getRedisClient() {
    return exports.redisFactory.getMainClient();
}
function getRedisSubscriber() {
    return exports.redisFactory.getSubscriberClient();
}
function getRedisIngestion() {
    return exports.redisFactory.getIngestionClient();
}
function getRedisConsumer() {
    return exports.redisFactory.getConsumerClient();
}
function getRedisConfig() {
    return exports.redisFactory.getConfig();
}
async function closeAllRedisClients() {
    return exports.redisFactory.closeAll();
}
//# sourceMappingURL=client-factory.js.map