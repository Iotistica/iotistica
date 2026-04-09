export declare class DeviceQueueMetrics {
    streamLength: number;
    pendingMessages: number;
    dlqLength: number;
    failureTrackingCount: number;
    redisConnected: number;
    redisMemoryUsedBytes: number;
    redisMemoryMaxBytes: number;
    workerCount: number;
    workerLag: number;
    messagesProcessed: number;
    messagesFailed: number;
    messagesDropped: number;
    readingsInserted: number;
    lastProcessedTimestamp: number | null;
    maxDwellMs: number;
    redisReconnects: number;
    oomErrors: number;
    oomRetries: number;
    batchLatencies: number[];
    insertLatencies: number[];
    dwellLatencies: number[];
    private maxSamples;
    recordBatchLatency(ms: number): void;
    recordInsertLatency(ms: number): void;
    recordDwellLatency(ms: number): void;
    getBatchLatencyP95(): number;
    getInsertLatencyP95(): number;
    getDwellLatencyP95(): number;
    setWorkerCount(count: number): void;
}
export declare const metrics: DeviceQueueMetrics;
//# sourceMappingURL=metrics.d.ts.map