import type Redis from 'ioredis';
import { RedisDeviceEntry } from './types';
export declare const FAILURE_TRACKING_KEY = "device:failed:attempts";
export declare function incrementFailureCount(redis: Redis, messageId: string): Promise<number>;
export declare function getFailureCount(redis: Redis, messageId: string): Promise<number>;
export declare function moveToDLQ(redis: Redis, streamKey: string, consumerGroup: string, dlqStreamKey: string, maxDlqLength: number, entry: RedisDeviceEntry, error: string, attempts: number): Promise<void>;
export declare function startFailureTrackingPruner(redis: Redis): NodeJS.Timeout;
//# sourceMappingURL=dlq.d.ts.map