import type Redis from 'ioredis';
export declare function hIncrByAndExpire(redis: Redis, key: string, field: string, ttlSeconds: number): Promise<number>;
export declare function moveToDlqAtomic(redis: Redis, sourceStream: string, dlqStream: string, failureHash: string, consumerGroup: string, messageId: string, data: string, maxDlqLen: number, error: string, attempts: number, failedAt: string): Promise<string>;
//# sourceMappingURL=redis-scripts.d.ts.map