"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisQueueProducer = void 0;
const logger_1 = require("../utils/logger");
const metrics_1 = require("./metrics");
const circuit_breaker_1 = require("./circuit-breaker");
class RedisQueueProducer {
    redis;
    pipeline;
    diskSpool;
    getStreamKey;
    maxStreamLength;
    constructor(redis, pipeline, diskSpool, getStreamKey, maxStreamLength) {
        this.redis = redis;
        this.pipeline = pipeline;
        this.diskSpool = diskSpool;
        this.getStreamKey = getStreamKey;
        this.maxStreamLength = maxStreamLength;
    }
    short(id) {
        return id?.substring(0, 8);
    }
    isRedisReady() {
        return this.redis.status === 'ready' || this.redis.status === 'connect';
    }
    isClientReady() {
        return this.isRedisReady();
    }
    maxlenArgs(len) {
        return ['MAXLEN', '~', len];
    }
    async fallbackToDiskOrDrop(deviceData, reason) {
        if (this.diskSpool.isEnabled()) {
            try {
                await this.diskSpool.spoolToDisk(deviceData);
                logger_1.logger.warn(`${reason} - spooled to disk`, { count: deviceData.length });
                return 'disk';
            }
            catch (err) {
                metrics_1.metrics.messagesDropped += deviceData.length;
                logger_1.logger.error(`${reason} - disk spool write failed, data dropped`, {
                    count: deviceData.length,
                    totalDropped: metrics_1.metrics.messagesDropped,
                    error: err.message,
                });
                return 'dropped';
            }
        }
        else {
            metrics_1.metrics.messagesDropped += deviceData.length;
            logger_1.logger.error(`${reason} and disk spool disabled - data dropped`, {
                count: deviceData.length, totalDropped: metrics_1.metrics.messagesDropped,
            });
            return 'dropped';
        }
    }
    logAddResult(count, payloadBytes, duration) {
        if (duration > 100) {
            logger_1.logger.debug('Slow Redis write (device batch)', { count, payloadBytes, durationMs: duration });
        }
        else {
            logger_1.logger.debug('Added device data to Redis stream', {
                count, payloadBytes, durationMs: duration,
                batchLatencyP95Ms: metrics_1.metrics.getBatchLatencyP95(),
            });
        }
    }
    async addCompressed(entry) {
        try {
            if (!circuit_breaker_1.circuitBreaker.shouldAllowRequest()) {
                logger_1.logger.warn('Redis circuit OPEN, spooling compressed batch to disk', {
                    deviceUuid: this.short(entry.deviceUuid),
                    deviceName: entry.deviceName,
                    batchId: entry.batchId,
                });
                await this.fallbackToDiskOrDrop([{
                        deviceUuid: entry.deviceUuid,
                        deviceName: entry.deviceName,
                        data: { _compressedBatchId: entry.batchId },
                        timestamp: new Date().toISOString(),
                        metadata: {},
                    }], 'Redis circuit OPEN (compressed entry)');
                return;
            }
            if (!this.isRedisReady()) {
                circuit_breaker_1.circuitBreaker.recordFailure();
                await this.fallbackToDiskOrDrop([{
                        deviceUuid: entry.deviceUuid,
                        deviceName: entry.deviceName,
                        data: { _compressedBatchId: entry.batchId },
                        timestamp: new Date().toISOString(),
                        metadata: {},
                    }], 'Redis not ready (compressed entry)');
                return;
            }
            const streamKey = this.getStreamKey();
            const payloadPointer = `${entry.deviceUuid}/${entry.batchId}`;
            const payloadSize = entry.compressedPayload.length;
            await this.pipeline.add(p => {
                p.xadd(streamKey, ...this.maxlenArgs(this.maxStreamLength), '*', 'compressed', '1', 'deviceUuid', entry.deviceUuid, 'deviceName', entry.deviceName, 'batchId', entry.batchId, 'encoding', entry.contentEncoding, 'contentType', entry.contentType, 'payloadPointer', payloadPointer, 'payloadSize', payloadSize.toString());
            });
            logger_1.logger.debug('Queued compressed device metadata (pointer-based)', {
                deviceUuid: this.short(entry.deviceUuid),
                deviceName: entry.deviceName,
                batchId: entry.batchId,
                payloadBytes: payloadSize,
                encoding: entry.contentEncoding,
            });
            circuit_breaker_1.circuitBreaker.recordSuccess();
        }
        catch (err) {
            circuit_breaker_1.circuitBreaker.recordFailure();
            logger_1.logger.error('Failed to queue compressed device metadata to Redis', {
                deviceUuid: this.short(entry.deviceUuid),
                deviceName: entry.deviceName,
                batchId: entry.batchId,
                error: err.message,
            });
            if (err.message?.includes('OOM')) {
                metrics_1.metrics.messagesDropped++;
            }
        }
    }
    async add(deviceData) {
        return this.addInternal(deviceData, false);
    }
    async addInternal(deviceData, bypassCircuit = false) {
        if (deviceData.length === 0)
            return 'redis';
        try {
            const startTime = Date.now();
            if (!bypassCircuit && !circuit_breaker_1.circuitBreaker.shouldAllowRequest()) {
                return this.fallbackToDiskOrDrop(deviceData, 'Redis circuit OPEN');
            }
            if (!this.isRedisReady()) {
                if (!bypassCircuit)
                    circuit_breaker_1.circuitBreaker.recordFailure();
                logger_1.logger.debug('Redis not ready, routing to disk spool', {
                    redisStatus: this.redis.status,
                    count: deviceData.length,
                    circuitState: circuit_breaker_1.circuitBreaker.getState?.() ?? 'unknown',
                });
                return this.fallbackToDiskOrDrop(deviceData, 'Redis not ready');
            }
            const streamKey = this.getStreamKey();
            const payload = JSON.stringify(deviceData);
            await this.pipeline.add(p => {
                p.xadd(streamKey, ...this.maxlenArgs(this.maxStreamLength), '*', 'data', payload);
            });
            const duration = Date.now() - startTime;
            metrics_1.metrics.recordBatchLatency(duration);
            if (!bypassCircuit)
                circuit_breaker_1.circuitBreaker.recordSuccess();
            this.logAddResult(deviceData.length, payload.length, duration);
            return 'redis';
        }
        catch (err) {
            if (!bypassCircuit)
                circuit_breaker_1.circuitBreaker.recordFailure();
            if (err.message?.includes('OOM')) {
                logger_1.logger.error('Redis OOM, routing to fallback', { count: deviceData.length, error: err.message });
                return this.fallbackToDiskOrDrop(deviceData, 'Redis OOM');
            }
            else {
                logger_1.logger.error('Failed to add device data to Redis stream', {
                    count: deviceData.length, error: err.message,
                });
                return 'dropped';
            }
        }
    }
}
exports.RedisQueueProducer = RedisQueueProducer;
//# sourceMappingURL=producer.js.map