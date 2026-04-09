"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisQueueConsumer = void 0;
const logger_1 = require("../utils/logger");
const connection_1 = require("../db/connection");
const decoder_1 = require("./decoder");
const dlq_1 = require("./dlq");
const metrics_1 = require("./metrics");
class RecentMessageTracker {
    ids = new Set();
    maxSize;
    constructor(maxSize = 50_000) {
        this.maxSize = maxSize;
    }
    has(id) {
        return this.ids.has(id);
    }
    markAll(ids) {
        for (const id of ids) {
            if (this.ids.size >= this.maxSize) {
                const toEvict = Math.floor(this.maxSize * 0.2);
                const iter = this.ids.values();
                for (let i = 0; i < toEvict; i++) {
                    const { value, done } = iter.next();
                    if (done)
                        break;
                    this.ids.delete(value);
                }
            }
            this.ids.add(id);
        }
    }
}
class RedisQueueConsumer {
    redis;
    config;
    inserter;
    onReinitialize;
    isRunning = false;
    lastBackpressureLogAtMs = 0;
    lastRedisPressureLogAtMs = 0;
    lastScaleAtMs = 0;
    consecutiveBelowTargetLagChecks = 0;
    consecutiveFullReads = 0;
    nextWorkerId = 0;
    desiredWorkerCount = 0;
    activeWorkerIds = new Set();
    retiringWorkerIds = new Set();
    workerConnections = new Map();
    messageTracker = new RecentMessageTracker();
    constructor(redis, config, inserter, onReinitialize) {
        this.redis = redis;
        this.config = config;
        this.inserter = inserter;
        this.onReinitialize = onReinitialize;
    }
    short(id) {
        return id?.substring(0, 8);
    }
    ingestedAtMs(entryId) {
        const ms = parseInt(entryId.split('-')[0], 10);
        return isNaN(ms) ? Date.now() : ms;
    }
    logEntryError(msg, entry, err) {
        const data = entry.data;
        logger_1.logger.error(msg, {
            messageId: entry.id,
            deviceUuid: this.short(data.deviceUuid),
            deviceName: data.deviceName,
            error: err?.message ?? err,
        });
    }
    async sendDecodeFailureToDlq(entry, reason) {
        logger_1.logger.warn('Moving structurally invalid message to DLQ (decode failure, not a transient error)', {
            messageId: entry.id,
            reason,
            deviceUuid: this.short(entry.data.deviceUuid),
            deviceName: entry.data.deviceName,
        });
        const dlqEntry = entry.isCompressed
            ? { ...entry, data: { ...entry.data, compressedPayload: Buffer.alloc(0) } }
            : entry;
        await (0, dlq_1.moveToDLQ)(this.redis, this.config.streamKey, this.config.consumerGroup, this.config.dlqStreamKey, this.config.maxDlqLength, dlqEntry, reason, 0);
    }
    async start() {
        if (this.isRunning) {
            logger_1.logger.debug('Device worker already running');
            return;
        }
        this.isRunning = true;
        this.desiredWorkerCount = this.clampWorkerCount(this.config.workerCount);
        logger_1.logger.info('Starting Redis device workers', {
            consumer: this.config.consumerName,
            workerCount: this.desiredWorkerCount,
            batchSize: this.config.batchSize,
            blockTimeMs: this.config.blockTimeMs,
        });
        (0, dlq_1.startFailureTrackingPruner)(this.redis);
        for (let i = 0; i < this.desiredWorkerCount; i++) {
            this.spawnWorkerLoop();
        }
    }
    stop() {
        this.isRunning = false;
        this.retiringWorkerIds.clear();
        this.activeWorkerIds.clear();
        for (const redis of this.workerConnections.values()) {
            redis.disconnect(false);
        }
        this.workerConnections.clear();
        metrics_1.metrics.setWorkerCount(0);
    }
    getCurrentWorkerCount() {
        return this.activeWorkerIds.size;
    }
    getRetiringWorkerCount() {
        return this.retiringWorkerIds.size;
    }
    getEffectiveWorkerCount() {
        return this.activeWorkerIds.size - this.retiringWorkerIds.size;
    }
    getDesiredWorkerCount() {
        return this.desiredWorkerCount;
    }
    clampWorkerCount(count) {
        return Math.max(this.config.minWorkers, Math.min(this.config.maxWorkers, count));
    }
    spawnWorkerLoop() {
        const workerId = this.nextWorkerId++;
        const workerRedis = this.redis.duplicate();
        this.activeWorkerIds.add(workerId);
        this.workerConnections.set(workerId, workerRedis);
        metrics_1.metrics.setWorkerCount(this.activeWorkerIds.size);
        this.workerLoop(workerId, workerRedis).catch(err => {
            logger_1.logger.error('Device worker loop crashed', {
                workerId,
                error: err.message,
                stack: err.stack,
            });
        }).finally(() => {
            this.workerConnections.delete(workerId);
            workerRedis.disconnect(false);
            this.activeWorkerIds.delete(workerId);
            this.retiringWorkerIds.delete(workerId);
            metrics_1.metrics.setWorkerCount(this.activeWorkerIds.size);
        });
    }
    retireOneWorker() {
        const workerId = [...this.activeWorkerIds].sort((a, b) => b - a)[0];
        if (workerId !== undefined) {
            this.retiringWorkerIds.add(workerId);
        }
    }
    async handleWorkerError(workerId, err) {
        if (err.message?.includes('NOGROUP')) {
            logger_1.logger.warn('Consumer group missing, reinitializing...', {
                group: this.config.consumerGroup,
                stream: this.config.streamKey,
            });
            try {
                await this.onReinitialize();
            }
            catch (initErr) {
                logger_1.logger.error('Failed to reinitialize consumer group', { error: initErr.message });
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        else {
            logger_1.logger.error('Error in device worker loop', {
                workerId,
                error: err.message,
                command: err.command?.name,
            });
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    async workerLoop(workerId, workerRedis) {
        while (this.isRunning &&
            this.activeWorkerIds.has(workerId) &&
            !this.retiringWorkerIds.has(workerId)) {
            try {
                if (this.shouldBackoffForDbPressure()) {
                    await new Promise(resolve => setTimeout(resolve, this.config.backpressureSleepMs));
                    continue;
                }
                const effectiveBatchSize = this.checkRedisPressure();
                const staleEntries = await this.claimStaleMessages(workerRedis);
                if (staleEntries.length > 0) {
                    await this.processBatch(staleEntries, workerRedis);
                    continue;
                }
                const results = await workerRedis.xreadgroup('GROUP', this.config.consumerGroup, this.config.consumerName, 'COUNT', effectiveBatchSize, 'BLOCK', this.config.blockTimeMs, 'STREAMS', this.config.streamKey, '>');
                if (!results || results.length === 0) {
                    this.consecutiveFullReads = 0;
                    continue;
                }
                if (this.retiringWorkerIds.has(workerId)) {
                    continue;
                }
                const [, messages] = results[0];
                const lagEstimateMs = messages[0]?.[0]
                    ? Math.max(0, Date.now() - this.ingestedAtMs(messages[0][0]))
                    : 0;
                if (lagEstimateMs > 0) {
                    this.maybeAutoscale(lagEstimateMs);
                }
                this.noteReadPressure(messages.length, effectiveBatchSize);
                const { entries, parseErrors } = this.parseStreamMessages(messages);
                for (const pe of parseErrors)
                    await this.sendDecodeFailureToDlq(pe.entry, pe.reason);
                if (entries.length === 0)
                    continue;
                await this.processBatch(entries, workerRedis);
            }
            catch (err) {
                await this.handleWorkerError(workerId, err);
            }
        }
    }
    checkRedisPressure() {
        const streamWatermark = Math.floor(this.config.maxStreamLength * this.config.redisStreamHighWatermarkPct);
        const streamLen = metrics_1.metrics.streamLength;
        const effectiveBacklog = metrics_1.metrics.workerLag + metrics_1.metrics.pendingMessages;
        const memUsed = metrics_1.metrics.redisMemoryUsedBytes;
        const memMax = metrics_1.metrics.redisMemoryMaxBytes;
        const streamPressure = streamWatermark > 0 && effectiveBacklog >= streamWatermark;
        const memUsedPct = memMax > 0 ? (memUsed / memMax) * 100 : 0;
        const memPressure = this.config.redisMemoryHighWatermarkPct > 0 &&
            memMax > 0 &&
            memUsedPct >= this.config.redisMemoryHighWatermarkPct;
        const implicitReadPressure = this.consecutiveFullReads >= 3;
        if (!streamPressure && !memPressure && !implicitReadPressure) {
            return this.config.batchSize;
        }
        const now = Date.now();
        if (now - this.lastRedisPressureLogAtMs > 10_000) {
            this.lastRedisPressureLogAtMs = now;
            const pressureReasons = [
                streamPressure ? 'stream backlog' : null,
                memPressure ? 'memory pressure' : null,
                implicitReadPressure ? 'full-read saturation' : null,
            ].filter((reason) => reason !== null);
            const hasExplicitRedisPressure = streamPressure || memPressure;
            const logMessage = hasExplicitRedisPressure
                ? `Redis pressure high (${pressureReasons.join(', ')}) — temporarily increasing batch size`
                : `Queue read saturation detected (${pressureReasons.join(', ')}) — temporarily increasing batch size`;
            const logContext = {
                action: 'autoscale_signal',
                streamLength: streamLen,
                effectiveBacklog,
                streamHighWatermark: streamWatermark,
                streamUtilizationPct: streamWatermark > 0 ? Math.round((effectiveBacklog / streamWatermark) * 100) : null,
                memoryUsedMb: Math.round(memUsed / 1024 / 1024),
                memoryMaxMb: memMax > 0 ? Math.round(memMax / 1024 / 1024) : 'unlimited',
                memoryUtilizationPct: memMax > 0 ? Math.round(memUsedPct) : null,
                streamPressure,
                memPressure,
                implicitReadPressure,
                consecutiveFullReads: this.consecutiveFullReads,
                response: 'increasing batch size to drain stream faster',
            };
            if (hasExplicitRedisPressure) {
                logger_1.logger.warn(logMessage, logContext);
            }
            else {
                logger_1.logger.debug(logMessage, logContext);
            }
        }
        return Math.min(this.config.batchSize * 2, 5000);
    }
    noteReadPressure(messageCount, requestedCount) {
        if (requestedCount <= 0) {
            this.consecutiveFullReads = 0;
            return;
        }
        if (messageCount >= requestedCount) {
            this.consecutiveFullReads = Math.min(this.consecutiveFullReads + 1, 10);
            return;
        }
        this.consecutiveFullReads = 0;
    }
    maybeAutoscale(lagMs) {
        const now = Date.now();
        if (now - this.lastScaleAtMs < this.config.scaleCooldownMs) {
            return;
        }
        const currentWorkers = this.getEffectiveWorkerCount();
        if (currentWorkers === 0) {
            return;
        }
        const db = (0, connection_1.getPoolStats)();
        let desiredWorkers = currentWorkers;
        if (lagMs < this.config.lagTargetMs) {
            this.consecutiveBelowTargetLagChecks += 1;
            if (this.consecutiveBelowTargetLagChecks >= this.config.lagScaleDownStableChecks) {
                desiredWorkers = Math.max(this.config.minWorkers, currentWorkers - 1);
            }
        }
        else if (lagMs > this.config.lagCriticalMs) {
            this.consecutiveBelowTargetLagChecks = 0;
            const scaleFactor = this.config.lagTargetMs > 0 ? lagMs / this.config.lagTargetMs : 1;
            const increment = Math.min(3, Math.max(1, Math.ceil(scaleFactor)));
            desiredWorkers = Math.min(this.config.maxWorkers, currentWorkers + increment);
        }
        else if (lagMs > this.config.lagScaleUpMs) {
            this.consecutiveBelowTargetLagChecks = 0;
            desiredWorkers = Math.min(this.config.maxWorkers, currentWorkers + 1);
        }
        else {
            this.consecutiveBelowTargetLagChecks = 0;
        }
        if (desiredWorkers > currentWorkers &&
            db.saturationPct >= this.config.dbScaleUpBlockSaturationPct) {
            logger_1.logger.debug('Skipping worker scale-up because DB saturation is already high', {
                lagMs,
                currentWorkers,
                requestedWorkers: desiredWorkers,
                dbSaturationPct: db.saturationPct,
                dbScaleUpBlockSaturationPct: this.config.dbScaleUpBlockSaturationPct,
            });
            return;
        }
        if (desiredWorkers === currentWorkers) {
            return;
        }
        this.lastScaleAtMs = now;
        this.desiredWorkerCount = desiredWorkers;
        this.consecutiveBelowTargetLagChecks = 0;
        if (desiredWorkers > currentWorkers) {
            for (let i = currentWorkers; i < desiredWorkers; i++) {
                this.spawnWorkerLoop();
            }
        }
        else {
            for (let i = currentWorkers; i > desiredWorkers; i--) {
                this.retireOneWorker();
            }
        }
        logger_1.logger.debug('Adjusted Redis device worker concurrency based on queue dwell lag', {
            lagMs,
            currentWorkers,
            desiredWorkers,
            consecutiveBelowTargetLagChecks: this.consecutiveBelowTargetLagChecks,
            lagScaleDownStableChecks: this.config.lagScaleDownStableChecks,
            dbSaturationPct: db.saturationPct,
            cooldownMs: this.config.scaleCooldownMs,
            targetMs: this.config.lagTargetMs,
            scaleUpMs: this.config.lagScaleUpMs,
            criticalMs: this.config.lagCriticalMs,
        });
    }
    shouldBackoffForDbPressure() {
        const stats = (0, connection_1.getPoolStats)();
        const waitingTooHigh = stats.waiting >= this.config.dbWaitingHighWatermark;
        const saturationTooHigh = stats.saturationPct >= this.config.dbSaturationHighWatermarkPct;
        if (!waitingTooHigh && !saturationTooHigh) {
            return false;
        }
        const now = Date.now();
        if (now - this.lastBackpressureLogAtMs > 10000) {
            this.lastBackpressureLogAtMs = now;
            logger_1.logger.warn('Applying ingestion backpressure due to DB pool pressure', {
                waiting: stats.waiting,
                saturationPct: stats.saturationPct,
                configuredMax: stats.configuredMax,
                waitingHighWatermark: this.config.dbWaitingHighWatermark,
                saturationHighWatermarkPct: this.config.dbSaturationHighWatermarkPct,
                sleepMs: this.config.backpressureSleepMs,
            });
        }
        return true;
    }
    parseStreamMessages(messages) {
        const entries = [];
        const parseErrors = [];
        for (const [id, fields] of messages) {
            const fieldMap = {};
            for (let i = 0; i < fields.length; i += 2)
                fieldMap[fields[i]] = fields[i + 1];
            if (fieldMap.compressed === '1') {
                const payloadRaw = fieldMap.payload;
                if (!payloadRaw) {
                    parseErrors.push({
                        entry: {
                            id,
                            data: {
                                deviceUuid: fieldMap.deviceUuid ?? 'unknown',
                                deviceName: fieldMap.deviceName ?? 'unknown',
                                batchId: fieldMap.batchId ?? '',
                                compressedPayload: Buffer.alloc(0),
                                contentEncoding: fieldMap.encoding ?? '',
                                contentType: fieldMap.contentType ?? '',
                            },
                            isCompressed: true,
                        },
                        reason: 'Missing compressed payload field',
                    });
                    continue;
                }
                entries.push({
                    id,
                    data: {
                        deviceUuid: fieldMap.deviceUuid,
                        deviceName: fieldMap.deviceName,
                        batchId: fieldMap.batchId,
                        compressedPayload: Buffer.from(payloadRaw, 'binary'),
                        contentEncoding: fieldMap.encoding,
                        contentType: fieldMap.contentType,
                    },
                    isCompressed: true,
                });
                continue;
            }
            if (!fieldMap.data) {
                parseErrors.push({
                    entry: {
                        id,
                        data: { deviceUuid: 'unknown', deviceName: 'unknown', timestamp: new Date().toISOString(), data: null, metadata: {} },
                        isCompressed: false,
                    },
                    reason: 'Missing data field in uncompressed stream entry',
                });
                continue;
            }
            try {
                entries.push({ id, data: JSON.parse(fieldMap.data), isCompressed: false });
            }
            catch (parseErr) {
                parseErrors.push({
                    entry: {
                        id,
                        data: { deviceUuid: 'unknown', deviceName: 'unknown', timestamp: new Date().toISOString(), data: null, metadata: {} },
                        isCompressed: false,
                    },
                    reason: `JSON parse failed: ${parseErr?.message ?? 'unknown'} (raw prefix: ${fieldMap.data.substring(0, 200)})`,
                });
            }
        }
        return { entries, parseErrors };
    }
    async claimStaleMessages(workerRedis) {
        try {
            const minIdleMs = 60000;
            const result = await workerRedis.xautoclaim(this.config.streamKey, this.config.consumerGroup, this.config.consumerName, minIdleMs, '0-0', 'COUNT', this.config.batchSize);
            const messages = result[1];
            if (messages.length > 0) {
                logger_1.logger.debug('Claimed stale pending messages', { count: messages.length, minIdleMs });
            }
            const parsed = [];
            for (const [id, fields] of messages) {
                const fieldMap = {};
                for (let i = 0; i < fields.length; i += 2)
                    fieldMap[fields[i]] = fields[i + 1];
                if (fieldMap.compressed === '1') {
                    const payloadRaw = fieldMap.payload;
                    if (!payloadRaw) {
                        await this.sendDecodeFailureToDlq({
                            id,
                            data: {
                                deviceUuid: fieldMap.deviceUuid ?? 'unknown',
                                deviceName: fieldMap.deviceName ?? 'unknown',
                                batchId: fieldMap.batchId ?? '',
                                compressedPayload: Buffer.alloc(0),
                                contentEncoding: fieldMap.encoding ?? '',
                                contentType: fieldMap.contentType ?? '',
                            },
                            isCompressed: true,
                        }, 'Missing compressed payload field (stale PEL claim)');
                        continue;
                    }
                    const payloadBuffer = Buffer.isBuffer(payloadRaw)
                        ? payloadRaw
                        : fieldMap.payload_b64
                            ? Buffer.from(fieldMap.payload_b64, 'base64')
                            : Buffer.from(payloadRaw, 'hex');
                    if (payloadBuffer.length === 0) {
                        await this.sendDecodeFailureToDlq({
                            id,
                            data: {
                                deviceUuid: fieldMap.deviceUuid ?? 'unknown',
                                deviceName: fieldMap.deviceName ?? 'unknown',
                                batchId: fieldMap.batchId ?? '',
                                compressedPayload: Buffer.alloc(0),
                                contentEncoding: fieldMap.encoding ?? '',
                                contentType: fieldMap.contentType ?? '',
                            },
                            isCompressed: true,
                        }, 'Empty compressed payload buffer (stale PEL claim)');
                        continue;
                    }
                    parsed.push({
                        id,
                        data: {
                            deviceUuid: fieldMap.deviceUuid,
                            deviceName: fieldMap.deviceName,
                            batchId: fieldMap.batchId,
                            compressedPayload: payloadBuffer,
                            contentEncoding: fieldMap.encoding,
                            contentType: fieldMap.contentType,
                        },
                        isCompressed: true,
                    });
                    continue;
                }
                if (!fieldMap.data) {
                    await this.sendDecodeFailureToDlq({
                        id,
                        data: { deviceUuid: 'unknown', deviceName: 'unknown', timestamp: new Date().toISOString(), data: null, metadata: {} },
                        isCompressed: false,
                    }, 'Missing data field in uncompressed stream entry (stale PEL claim)');
                    continue;
                }
                try {
                    parsed.push({ id, data: JSON.parse(fieldMap.data) });
                }
                catch (parseErr) {
                    await this.sendDecodeFailureToDlq({
                        id,
                        data: { deviceUuid: 'unknown', deviceName: 'unknown', timestamp: new Date().toISOString(), data: null, metadata: {} },
                        isCompressed: false,
                    }, `JSON parse failed in uncompressed entry: ${parseErr?.message ?? 'unknown'} (raw prefix: ${fieldMap.data?.substring(0, 200) ?? ''})`);
                }
            }
            return parsed;
        }
        catch (err) {
            if (err.message?.includes('unknown command')) {
                logger_1.logger.debug('XAUTOCLAIM not supported (Redis <6.2), skipping stale message recovery');
                return [];
            }
            logger_1.logger.error('Failed to claim stale messages', { error: err.message });
            return [];
        }
    }
    async resolveEntryData(entry) {
        if (!entry.isCompressed) {
            const data = entry.data;
            return Array.isArray(data) ? data : [data];
        }
        const compressed = entry.data;
        if (!compressed.compressedPayload || compressed.compressedPayload.length === 0) {
            this.logEntryError('Compressed entry has empty payload, moving to DLQ', entry, null);
            await this.sendDecodeFailureToDlq(entry, 'Empty or missing compressed payload');
            return null;
        }
        try {
            return await (0, decoder_1.decompressAndParseDevices)(compressed.compressedPayload, compressed.contentEncoding, compressed.deviceUuid, compressed.deviceName);
        }
        catch (err) {
            this.logEntryError('Failed to decompress device entry, moving to DLQ', entry, err);
            await this.sendDecodeFailureToDlq(entry, `Decompression failed: ${err.message}`);
            return null;
        }
    }
    logBatchSuccess(entries, allData, startTime, phases) {
        const duration = Date.now() - startTime;
        const now = Date.now();
        const dwellTimes = entries.map(e => now - this.ingestedAtMs(e.id));
        const maxDwellMs = Math.max(...dwellTimes);
        const avgDwellMs = Math.round(dwellTimes.reduce((a, b) => a + b, 0) / dwellTimes.length);
        metrics_1.metrics.recordDwellLatency(maxDwellMs);
        const compressedCount = entries.filter(e => e.isCompressed).length;
        logger_1.logger.debug('Processed device data batch from Redis', {
            totalReadings: entries.length,
            compressedEntries: compressedCount,
            legacyEntries: entries.length - compressedCount,
            agents: new Set(allData.map(d => d.deviceUuid)).size,
            devices: new Set(allData.map(d => `${d.deviceUuid}/${d.deviceName}`)).size,
            durationMs: duration,
            resolveMs: phases?.resolveMs,
            ackMs: phases?.ackMs,
            readingsPerSecond: Math.round((entries.length / duration) * 1000),
            maxDwellMs,
            avgDwellMs,
        });
    }
    async xackBatch(ids, workerRedis) {
        if (ids.length === 0)
            return;
        const pl = workerRedis.pipeline();
        pl.xack(this.config.streamKey, this.config.consumerGroup, ...ids);
        await pl.exec();
    }
    async processBatch(entries, workerRedis) {
        const startTime = Date.now();
        const fresh = [];
        const alreadySeenIds = [];
        for (const entry of entries) {
            if (this.messageTracker.has(entry.id)) {
                alreadySeenIds.push(entry.id);
            }
            else {
                fresh.push(entry);
            }
        }
        if (alreadySeenIds.length > 0) {
            logger_1.logger.debug('Skipping already-processed message IDs (in-process redelivery)', { count: alreadySeenIds.length });
        }
        if (fresh.length === 0) {
            await this.xackBatch(alreadySeenIds, workerRedis);
            return;
        }
        const pendingAck = [];
        const allData = [];
        const resolveStart = Date.now();
        for (const entry of fresh) {
            const data = await this.resolveEntryData(entry);
            if (data !== null) {
                pendingAck.push(entry);
                allData.push(...data);
            }
        }
        const resolveMs = Date.now() - resolveStart;
        if (allData.length === 0) {
            const toAck = [...alreadySeenIds, ...pendingAck.map(e => e.id)];
            await this.xackBatch(toAck, workerRedis);
            if (pendingAck.length > 0) {
                this.messageTracker.markAll(pendingAck.map(e => e.id));
                logger_1.logger.debug('ACK\'d entries that decoded to empty data payloads', { count: pendingAck.length });
            }
            return;
        }
        try {
            await this.inserter.insertBatch(allData);
            const toAck = [...alreadySeenIds, ...pendingAck.map(e => e.id)];
            const ackStart = Date.now();
            await this.xackBatch(toAck, workerRedis);
            const ackMs = Date.now() - ackStart;
            this.messageTracker.markAll(pendingAck.map(e => e.id));
            this.logBatchSuccess(pendingAck, allData, startTime, { resolveMs, ackMs });
        }
        catch (err) {
            await this.xackBatch(alreadySeenIds, workerRedis);
            logger_1.logger.error('Failed to process device data batch', { count: pendingAck.length, error: err.message });
            await this.handleBatchFailures(pendingAck, err);
        }
    }
    async handleBatchFailures(entries, err) {
        for (const entry of entries) {
            try {
                const attempts = await (0, dlq_1.incrementFailureCount)(this.redis, entry.id);
                if (attempts >= this.config.maxRetries) {
                    await (0, dlq_1.moveToDLQ)(this.redis, this.config.streamKey, this.config.consumerGroup, this.config.dlqStreamKey, this.config.maxDlqLength, entry, err.message, attempts);
                }
                else {
                    logger_1.logger.debug('Message retry scheduled', {
                        messageId: entry.id,
                        attempts,
                        maxRetries: this.config.maxRetries,
                    });
                }
            }
            catch (dlqErr) {
                logger_1.logger.error('Failed to handle message failure', { messageId: entry.id, error: dlqErr.message });
            }
        }
    }
}
exports.RedisQueueConsumer = RedisQueueConsumer;
//# sourceMappingURL=worker.js.map