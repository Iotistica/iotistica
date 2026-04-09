"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisPipeline = void 0;
const logger_1 = require("../utils/logger");
const metrics_1 = require("./metrics");
const retry_utils_1 = require("./retry-utils");
class RedisPipeline {
    redis;
    pending = null;
    pendingEntries = [];
    count = 0;
    flushTimer = null;
    batchSize;
    maxOomRetries;
    onPersistentOomFailure;
    constructor(redis, opts = {}) {
        this.redis = redis;
        this.batchSize = opts.batchSize ?? 10;
        this.maxOomRetries = opts.maxOomRetries ?? 5;
        this.onPersistentOomFailure = opts.onPersistentOomFailure;
    }
    async add(fn) {
        return new Promise((resolve, reject) => {
            if (!this.pending) {
                this.pending = this.redis.pipeline();
            }
            fn(this.pending);
            this.pendingEntries.push({ callback: fn, resolve, reject });
            this.count++;
            if (this.flushTimer) {
                clearTimeout(this.flushTimer);
                this.flushTimer = null;
            }
            if (this.count >= this.batchSize) {
                void this.flush().catch(err => reject(err instanceof Error ? err : new Error(String(err))));
                return;
            }
            this.flushTimer = setTimeout(() => {
                this.flush().catch(err => logger_1.logger.error('Pipeline auto-flush failed', { error: err.message }));
            }, 50);
        });
    }
    async flush() {
        if (!this.pending || this.count === 0)
            return;
        const count = this.count;
        const pipeline = this.pending;
        const entries = this.pendingEntries;
        this.pending = null;
        this.pendingEntries = [];
        this.count = 0;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        try {
            const startTime = Date.now();
            const results = await pipeline.exec();
            const duration = Date.now() - startTime;
            const oomEntries = [];
            if (results) {
                results.forEach(([err], idx) => {
                    const entry = entries[idx];
                    if (!entry)
                        return;
                    if (!err) {
                        entry.resolve();
                        return;
                    }
                    if (err.message?.includes('OOM')) {
                        oomEntries.push(entry);
                        return;
                    }
                    entry.reject(err);
                });
            }
            else {
                for (const entry of entries) {
                    entry.reject(new Error('Redis pipeline exec returned null'));
                }
            }
            if (oomEntries.length > 0) {
                metrics_1.metrics.oomErrors++;
                logger_1.logger.warn('Redis OOM on pipeline flush, retrying with backoff', {
                    oomCount: oomEntries.length,
                    successCount: count - oomEntries.length,
                });
                const dropped = await this.retryOomFailures(oomEntries, 0);
                if (dropped > 0) {
                    metrics_1.metrics.messagesDropped += dropped;
                    logger_1.logger.error('Redis OOM: exhausted retries, commands dropped', {
                        dropped,
                        totalDropped: metrics_1.metrics.messagesDropped,
                    });
                    this.onPersistentOomFailure?.(dropped);
                }
            }
            const successCount = count - oomEntries.length;
            logger_1.logger.debug('Flushed device pipeline', {
                operations: successCount,
                totalLatencyMs: duration,
                avgLatencyPerOpMs: successCount > 0 ? Math.round(duration / successCount) : 0,
                opsPerSecond: duration > 0 ? Math.round((successCount / duration) * 1000) : successCount,
            });
        }
        catch (err) {
            metrics_1.metrics.messagesDropped += count;
            for (const entry of entries) {
                entry.reject(err instanceof Error ? err : new Error(String(err)));
            }
            logger_1.logger.error('Device pipeline exec failed', {
                error: err instanceof Error ? err.message : String(err),
                count,
                totalDropped: metrics_1.metrics.messagesDropped,
            });
        }
    }
    async retryOomFailures(failedEntries, attempt) {
        if (failedEntries.length === 0)
            return 0;
        if (attempt >= this.maxOomRetries) {
            for (const entry of failedEntries) {
                entry.reject(new Error('Redis OOM: exhausted pipeline retries'));
            }
            return failedEntries.length;
        }
        const delay = (0, retry_utils_1.backoffDelayMs)(attempt);
        metrics_1.metrics.oomRetries += failedEntries.length;
        logger_1.logger.debug('OOM retry backoff', {
            attempt: attempt + 1,
            maxAttempts: this.maxOomRetries,
            delayMs: delay,
            commandCount: failedEntries.length,
        });
        await (0, retry_utils_1.sleep)(delay);
        const retryPipeline = this.redis.pipeline();
        for (const entry of failedEntries)
            entry.callback(retryPipeline);
        let results = null;
        try {
            results = await retryPipeline.exec();
        }
        catch {
            return this.retryOomFailures(failedEntries, attempt + 1);
        }
        const stillFailing = [];
        if (results) {
            results.forEach(([err], idx) => {
                const entry = failedEntries[idx];
                if (!entry)
                    return;
                if (!err) {
                    entry.resolve();
                    return;
                }
                if (err.message?.includes('OOM')) {
                    stillFailing.push(entry);
                    return;
                }
                entry.reject(err);
            });
        }
        else {
            return this.retryOomFailures(failedEntries, attempt + 1);
        }
        if (stillFailing.length === 0) {
            logger_1.logger.debug('OOM retry succeeded', {
                attempt: attempt + 1,
                recoveredCount: failedEntries.length,
            });
            return 0;
        }
        return this.retryOomFailures(stillFailing, attempt + 1);
    }
}
exports.RedisPipeline = RedisPipeline;
//# sourceMappingURL=pipeline.js.map