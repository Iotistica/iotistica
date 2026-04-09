import Redis from 'ioredis';
interface RedisConfig {
    host: string;
    port: number;
    username?: string;
    password?: string;
    useTls: boolean;
    tlsServerName: string;
    useCluster: boolean;
}
declare class RedisClientFactory {
    private static instance;
    private readonly config;
    private mainClient;
    private subscriberClient;
    private ingestionClient;
    private consumerClient;
    private constructor();
    static getInstance(): RedisClientFactory;
    private createClient;
    getMainClient(): Redis;
    getSubscriberClient(): Redis;
    getIngestionClient(): Redis;
    getConsumerClient(): Redis;
    getConfig(): RedisConfig;
    closeAll(): Promise<void>;
}
export declare const redisFactory: RedisClientFactory;
export declare function getRedisClient(): Redis;
export declare function getRedisSubscriber(): Redis;
export declare function getRedisIngestion(): Redis;
export declare function getRedisConsumer(): Redis;
export declare function getRedisConfig(): RedisConfig;
export declare function closeAllRedisClients(): Promise<void>;
export {};
//# sourceMappingURL=client-factory.d.ts.map