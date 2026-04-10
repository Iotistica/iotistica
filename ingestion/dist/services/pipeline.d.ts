import type Redis from 'ioredis';
type RedisPipelineHandle = ReturnType<Redis['pipeline']>;
type PipelineCallback = (pipeline: RedisPipelineHandle) => void;
export interface PipelineOptions {
    batchSize?: number;
    flushIntervalMs?: number;
    maxOomRetries?: number;
    onPersistentOomFailure?: (droppedCount: number) => void;
}
export declare class RedisPipeline {
    private readonly redis;
    private pending;
    private pendingEntries;
    private count;
    private flushTimer;
    private readonly batchSize;
    private readonly flushIntervalMs;
    private readonly maxOomRetries;
    private readonly onPersistentOomFailure?;
    constructor(redis: Redis, opts?: PipelineOptions);
    add(fn: PipelineCallback): Promise<void>;
    flush(): Promise<void>;
    private retryOomFailures;
}
export {};
//# sourceMappingURL=pipeline.d.ts.map