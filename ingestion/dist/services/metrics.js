"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metrics = exports.DeviceQueueMetrics = void 0;
class DeviceQueueMetrics {
    streamLength = 0;
    pendingMessages = 0;
    dlqLength = 0;
    failureTrackingCount = 0;
    redisConnected = 1;
    redisMemoryUsedBytes = 0;
    redisMemoryMaxBytes = 0;
    workerCount = 0;
    workerLag = 0;
    messagesProcessed = 0;
    messagesFailed = 0;
    messagesDropped = 0;
    readingsInserted = 0;
    lastProcessedTimestamp = null;
    maxDwellMs = 0;
    redisReconnects = 0;
    oomErrors = 0;
    oomRetries = 0;
    batchLatencies = [];
    insertLatencies = [];
    dwellLatencies = [];
    maxSamples = 100;
    recordBatchLatency(ms) {
        this.batchLatencies.push(ms);
        if (this.batchLatencies.length > this.maxSamples)
            this.batchLatencies.shift();
    }
    recordInsertLatency(ms) {
        this.insertLatencies.push(ms);
        if (this.insertLatencies.length > this.maxSamples)
            this.insertLatencies.shift();
    }
    recordDwellLatency(ms) {
        this.maxDwellMs = ms;
        this.dwellLatencies.push(ms);
        if (this.dwellLatencies.length > this.maxSamples)
            this.dwellLatencies.shift();
    }
    getBatchLatencyP95() {
        if (this.batchLatencies.length === 0)
            return 0;
        const sorted = [...this.batchLatencies].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)] || 0;
    }
    getInsertLatencyP95() {
        if (this.insertLatencies.length === 0)
            return 0;
        const sorted = [...this.insertLatencies].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)] || 0;
    }
    getDwellLatencyP95() {
        if (this.dwellLatencies.length === 0)
            return 0;
        const sorted = [...this.dwellLatencies].sort((a, b) => a - b);
        return sorted[Math.floor(sorted.length * 0.95)] || 0;
    }
    setWorkerCount(count) {
        this.workerCount = Math.max(0, count);
    }
}
exports.DeviceQueueMetrics = DeviceQueueMetrics;
exports.metrics = new DeviceQueueMetrics();
//# sourceMappingURL=metrics.js.map