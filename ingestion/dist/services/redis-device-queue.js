"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisDeviceQueue = exports.RedisDeviceQueue = void 0;
const crypto_1 = require("crypto");
const logger_1 = require("../utils/logger");
const client_factory_1 = require("../redis/client-factory");
const tenant_keys_1 = require("../redis/tenant-keys");
const POD_IDENTITY = (() => {
    const hostname = process.env.HOSTNAME?.trim();
    const isUniqueHostname = hostname && hostname.length > 0 && /[-_.]/.test(hostname);
    const identity = isUniqueHostname ? hostname : (0, crypto_1.randomUUID)();
    logger_1.logger.debug('Redis consumer identity established', {
        identity,
        source: isUniqueHostname ? 'HOSTNAME' : 'uuid-fallback',
    });
    return identity;
})();
const metrics_1 = require("./metrics");
const circuit_breaker_1 = require("./circuit-breaker");
const disk_spool_1 = require("./disk-spool");
const dlq_1 = require("./dlq");
const pipeline_1 = require("./pipeline");
const worker_1 = require("./worker");
const producer_1 = require("./producer");
const reading_inserter_1 = require("./reading-inserter");
const DEVICE_WRITER_GROUP_SUFFIX = process.env.REDIS_DEVICE_CONSUMER_GROUP_SUFFIX
    || 'device-writers';
function readIntEnv(key, fallback) {
    return parseInt(process.env[key] || fallback, 10);
}
function readFloatEnv(key, fallback) {
    return parseFloat(process.env[key] || fallback);
}
class RedisDeviceQueue {
    redisIngestion;
    redisConsumer;
    tenantId;
    ingestionStreamKey;
    consumerGroup;
    consumerName;
    get streamKey() { return this.ingestionStreamKey; }
    get processingStreamKey() { return (0, tenant_keys_1.agentDevicesReadyStreamKey)(this.tenantId); }
    get dlqStreamKey() { return (0, tenant_keys_1.agentDevicesDlqStreamKey)(this.tenantId); }
    maxRetries;
    workerCount;
    batchSize;
    blockTimeMs;
    maxStreamLength;
    maxDlqLength;
    dbWaitingHighWatermark;
    dbSaturationHighWatermarkPct;
    backpressureSleepMs;
    minWorkers;
    maxWorkers;
    lagTargetMs;
    lagScaleUpMs;
    lagCriticalMs;
    lagScaleDownStableChecks;
    scaleCooldownMs;
    dbScaleUpBlockSaturationPct;
    idleTrimStreamLength;
    redisStreamHighWatermarkPct;
    redisMemoryHighWatermarkPct;
    pipeline;
    diskSpool;
    producer;
    inserter;
    worker = null;
    isRunning = false;
    healthCollector = null;
    constructor(streamKey) {
        this.redisIngestion = (0, client_factory_1.getRedisIngestion)();
        this.redisConsumer = (0, client_factory_1.getRedisConsumer)();
        const configuredStreamKey = (streamKey || process.env.REDIS_INGESTION_STREAM_KEY || '').trim();
        if (!configuredStreamKey) {
            throw new Error('REDIS_INGESTION_STREAM_KEY must be set for ingestion service');
        }
        this.ingestionStreamKey = configuredStreamKey;
        this.tenantId = (0, tenant_keys_1.parseAgentDevicesIngestionStreamKey)(configuredStreamKey).tenantId;
        this.consumerGroup = (0, tenant_keys_1.consumerGroupName)(this.tenantId, DEVICE_WRITER_GROUP_SUFFIX);
        this.consumerName = (0, tenant_keys_1.consumerName)(this.tenantId, POD_IDENTITY);
        this.workerCount = readIntEnv('WORKER_COUNT', '2');
        this.maxRetries = readIntEnv('MAX_RETRIES', '3');
        this.batchSize = readIntEnv('BATCH_SIZE', '100');
        this.blockTimeMs = readIntEnv('FLUSH_INTERVAL_MS', '2000');
        this.maxStreamLength = parseInt(process.env.REDIS_INGESTION_STREAM_MAXLEN || '10000', 10);
        this.idleTrimStreamLength = Math.max(0, Math.min(this.maxStreamLength, parseInt(process.env.REDIS_IDLE_INGESTION_STREAM_MAXLEN || String(this.maxStreamLength), 10)));
        this.maxDlqLength = parseInt(process.env.REDIS_DLQ_MAXLEN || '1000', 10);
        this.minWorkers = readIntEnv('AUTOSCALE_MIN_WORKERS', '1');
        this.maxWorkers = readIntEnv('AUTOSCALE_MAX_WORKERS', '20');
        this.lagTargetMs = readIntEnv('AUTOSCALE_LAG_TARGET_MS', '10000');
        this.lagScaleUpMs = readIntEnv('AUTOSCALE_LAG_SCALE_UP_MS', '30000');
        this.lagCriticalMs = readIntEnv('AUTOSCALE_LAG_CRITICAL_MS', '60000');
        this.lagScaleDownStableChecks = readIntEnv('AUTOSCALE_SCALE_DOWN_STABLE_CHECKS', '3');
        this.scaleCooldownMs = readIntEnv('AUTOSCALE_COOLDOWN_MS', '30000');
        this.dbScaleUpBlockSaturationPct = readIntEnv('AUTOSCALE_DB_BLOCK_PCT', '80');
        this.dbWaitingHighWatermark = readIntEnv('DB_WAITING_HIGH_WATERMARK', '10');
        this.dbSaturationHighWatermarkPct = readIntEnv('DB_SATURATION_HIGH_WATERMARK_PCT', '85');
        this.backpressureSleepMs = readIntEnv('DB_BACKPRESSURE_SLEEP_MS', '250');
        this.redisStreamHighWatermarkPct = readFloatEnv('REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT', '0.8');
        this.redisMemoryHighWatermarkPct = parseInt(process.env.REDIS_MEMORY_HIGH_WATERMARK_PCT || '75', 10);
        this.pipeline = new pipeline_1.RedisPipeline(this.redisIngestion, {
            onPersistentOomFailure: (dropped) => {
                for (let i = 0; i < 5; i++)
                    circuit_breaker_1.circuitBreaker.recordFailure();
                metrics_1.metrics.messagesDropped += dropped;
                logger_1.logger.error('Redis OOM: pipeline retries exhausted, circuit forced OPEN', {
                    dropped, totalDropped: metrics_1.metrics.messagesDropped,
                });
            },
        });
        const spoolPath = process.env.DISK_SPOOL_PATH || '/tmp/iotistic-spool';
        const spoolMaxSizeMb = parseInt(process.env.DISK_SPOOL_MAX_SIZE_MB || '1000', 10);
        this.diskSpool = new disk_spool_1.DiskSpool(spoolPath, spoolMaxSizeMb);
        this.producer = new producer_1.RedisQueueProducer(this.redisIngestion, this.pipeline, this.diskSpool, () => this.streamKey, this.maxStreamLength);
        this.inserter = new reading_inserter_1.ReadingInserter();
        if (process.env.DISK_SPOOL_ENABLED === 'true') {
            this.diskSpool.initialize()
                .then(() => this.diskSpool.startReplayer(data => this.producer.addInternal(data, true), () => this.producer.isClientReady()))
                .catch(err => logger_1.logger.error('Failed to initialize disk spool', { error: err.message }));
        }
        this.redisIngestion.on('error', (err) => {
            logger_1.logger.error('Redis device ingestion connection error', { error: err.message });
            metrics_1.metrics.redisConnected = 0;
        });
        this.redisIngestion.on('connect', () => {
            logger_1.logger.debug('Redis device ingestion connected');
            metrics_1.metrics.redisConnected = 1;
            metrics_1.metrics.redisReconnects++;
        });
        this.redisConsumer.on('error', (err) => {
            logger_1.logger.error('Redis device consumer connection error', { error: err.message });
        });
        this.redisConsumer.on('connect', () => {
            logger_1.logger.debug('Redis device consumer connected');
        });
    }
    async addCompressed(entry) {
        return this.producer.addCompressed(entry);
    }
    async add(deviceData) {
        return this.producer.add(deviceData);
    }
    async initialize() {
        const maxAttempts = 5;
        let lastError = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                await this.redisConsumer.xgroup('CREATE', this.streamKey, this.consumerGroup, '0', 'MKSTREAM');
                await this.redisConsumer.xgroup('CREATE', this.processingStreamKey, this.consumerGroup, '0', 'MKSTREAM');
                logger_1.logger.debug('Created Redis consumer groups for devices', {
                    ingestionStream: this.streamKey,
                    processingStream: this.processingStreamKey,
                    group: this.consumerGroup,
                });
                return;
            }
            catch (err) {
                if (err.message.includes('BUSYGROUP')) {
                    logger_1.logger.debug('Redis consumer groups already exist', { group: this.consumerGroup });
                    return;
                }
                lastError = err;
                logger_1.logger.warn(`Failed to create consumer group (attempt ${attempt}/${maxAttempts})`, {
                    error: err.message,
                    group: this.consumerGroup,
                });
                if (attempt < maxAttempts) {
                    await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
                }
            }
        }
        throw new Error(`Failed to initialize Redis consumer group after ${maxAttempts} attempts: ${lastError?.message}`);
    }
    async startWorker() {
        if (this.isRunning) {
            logger_1.logger.debug('Device worker already running');
            return;
        }
        await this.initialize();
        this.isRunning = true;
        this.worker = new worker_1.RedisQueueConsumer(this.redisConsumer, {
            streamKey: this.streamKey,
            processingStreamKey: this.processingStreamKey,
            dlqStreamKey: this.dlqStreamKey,
            consumerGroup: this.consumerGroup,
            consumerName: this.consumerName,
            workerCount: this.workerCount,
            minWorkers: this.minWorkers,
            maxWorkers: this.maxWorkers,
            batchSize: this.batchSize,
            blockTimeMs: this.blockTimeMs,
            maxRetries: this.maxRetries,
            maxDlqLength: this.maxDlqLength,
            dbWaitingHighWatermark: this.dbWaitingHighWatermark,
            dbSaturationHighWatermarkPct: this.dbSaturationHighWatermarkPct,
            backpressureSleepMs: this.backpressureSleepMs,
            lagTargetMs: this.lagTargetMs,
            lagScaleUpMs: this.lagScaleUpMs,
            lagCriticalMs: this.lagCriticalMs,
            lagScaleDownStableChecks: this.lagScaleDownStableChecks,
            scaleCooldownMs: this.scaleCooldownMs,
            dbScaleUpBlockSaturationPct: this.dbScaleUpBlockSaturationPct,
            maxStreamLength: this.maxStreamLength,
            redisStreamHighWatermarkPct: this.redisStreamHighWatermarkPct,
            redisMemoryHighWatermarkPct: this.redisMemoryHighWatermarkPct,
        }, this.inserter, () => this.initialize());
        await this.worker.start();
        this.startHealthCollector();
    }
    async stopWorker() {
        logger_1.logger.debug('Stopping Redis device worker...');
        this.isRunning = false;
        this.worker?.stop();
        if (this.healthCollector) {
            clearInterval(this.healthCollector);
            this.healthCollector = null;
        }
        await new Promise(resolve => setTimeout(resolve, 10000));
        await Promise.all([this.redisIngestion.quit(), this.redisConsumer.quit()]);
        logger_1.logger.debug('Redis device worker stopped');
    }
    startHealthCollector() {
        const collectInterval = 30_000;
        const collect = async () => {
            try {
                const streamLen = await this.redisConsumer.xlen(this.streamKey).catch(() => 0);
                metrics_1.metrics.streamLength = streamLen;
                const pending = await this.redisConsumer
                    .xpending(this.streamKey, this.consumerGroup)
                    .catch(() => null);
                const pendingCount = pending ? pending[0] : 0;
                if (pending)
                    metrics_1.metrics.pendingMessages = pendingCount;
                let consumerGroupLag = streamLen;
                try {
                    const rawGroups = await this.redisConsumer.xinfo('GROUPS', this.streamKey);
                    for (const groupData of rawGroups) {
                        const pairs = groupData;
                        const nameIdx = pairs.indexOf('name');
                        if (nameIdx >= 0 && pairs[nameIdx + 1] === this.consumerGroup) {
                            const lagIdx = pairs.indexOf('lag');
                            if (lagIdx >= 0)
                                consumerGroupLag = pairs[lagIdx + 1];
                            break;
                        }
                    }
                }
                catch { }
                metrics_1.metrics.workerLag = consumerGroupLag;
                const streamFullyDrained = consumerGroupLag === 0 && pendingCount === 0;
                const trimTarget = streamFullyDrained
                    ? Math.min(this.maxStreamLength, Math.max(0, this.idleTrimStreamLength))
                    : this.maxStreamLength;
                if (streamFullyDrained && streamLen > trimTarget) {
                    await this.redisConsumer.xtrim(this.streamKey, 'MAXLEN', String(trimTarget)).catch(() => { });
                    metrics_1.metrics.streamLength = trimTarget;
                    logger_1.logger.info('Trimmed drained ingestion stream to retention target', {
                        from: streamLen,
                        to: trimTarget,
                        maxStreamLength: this.maxStreamLength,
                        idleTrimStreamLength: this.idleTrimStreamLength,
                    });
                }
                metrics_1.metrics.dlqLength = await this.redisConsumer.xlen(this.dlqStreamKey).catch(() => 0);
                metrics_1.metrics.failureTrackingCount = await this.redisConsumer.hlen(dlq_1.FAILURE_TRACKING_KEY).catch(() => 0);
                const memInfo = await this.redisConsumer.info('memory').catch(() => '');
                for (const line of memInfo.split('\r\n')) {
                    if (line.startsWith('used_memory:')) {
                        metrics_1.metrics.redisMemoryUsedBytes = parseInt(line.split(':')[1], 10) || 0;
                    }
                    else if (line.startsWith('maxmemory:')) {
                        metrics_1.metrics.redisMemoryMaxBytes = parseInt(line.split(':')[1], 10) || 0;
                    }
                }
                logger_1.logger.debug('Redis health metrics collected', {
                    streamLength: metrics_1.metrics.streamLength,
                    workerLag: metrics_1.metrics.workerLag,
                    pendingMessages: metrics_1.metrics.pendingMessages,
                    dlqLength: metrics_1.metrics.dlqLength,
                    redisMemoryMb: Math.round(metrics_1.metrics.redisMemoryUsedBytes / 1024 / 1024),
                    redisMemoryMaxMb: metrics_1.metrics.redisMemoryMaxBytes
                        ? Math.round(metrics_1.metrics.redisMemoryMaxBytes / 1024 / 1024)
                        : 'unlimited',
                });
            }
            catch (err) {
                logger_1.logger.debug('Health metrics collection failed', { error: err.message });
            }
        };
        collect();
        this.healthCollector = setInterval(collect, collectInterval);
    }
    async getIngestionHealth() {
        const backlogSize = await this.diskSpool.getBacklogCount();
        const state = circuit_breaker_1.circuitBreaker.getState();
        const lagMs = metrics_1.metrics.maxDwellMs;
        const status = state !== circuit_breaker_1.CircuitState.CLOSED || backlogSize > 0
            ? 'buffering'
            : metrics_1.metrics.redisConnected !== 1
                ? 'offline'
                : lagMs >= this.lagScaleUpMs
                    ? 'delayed'
                    : 'healthy';
        return {
            lastProcessedTimestamp: metrics_1.metrics.lastProcessedTimestamp,
            lagMs,
            maxDwellMs: metrics_1.metrics.maxDwellMs,
            workers: metrics_1.metrics.workerCount,
            status,
            ingestionHealthy: state === circuit_breaker_1.CircuitState.CLOSED && metrics_1.metrics.redisConnected === 1,
            spoolingActive: state !== circuit_breaker_1.CircuitState.CLOSED || backlogSize > 0,
            backlogSize,
            workerLag: metrics_1.metrics.workerLag,
            pendingMessages: metrics_1.metrics.pendingMessages,
            streamLength: metrics_1.metrics.streamLength,
            dlqLength: metrics_1.metrics.dlqLength,
            workerCount: metrics_1.metrics.workerCount,
            messagesProcessed: metrics_1.metrics.messagesProcessed,
            readingsInserted: metrics_1.metrics.readingsInserted,
            messagesDropped: metrics_1.metrics.messagesDropped,
            dwellP95Ms: metrics_1.metrics.getDwellLatencyP95(),
            batchLatP95Ms: metrics_1.metrics.getBatchLatencyP95(),
        };
    }
    async getStats() {
        try {
            const info = await this.redisConsumer.xinfo('STREAM', this.streamKey);
            const pending = await this.redisConsumer.xpending(this.streamKey, this.consumerGroup);
            const length = info[1];
            const firstEntry = info[11];
            const lastEntry = info[13];
            let dlqLength = 0;
            try {
                const dlqInfo = await this.redisConsumer.xinfo('STREAM', this.dlqStreamKey);
                dlqLength = dlqInfo[1];
            }
            catch { }
            const failureTrackingCount = await this.redisConsumer.hlen(dlq_1.FAILURE_TRACKING_KEY);
            let memoryUsedMb = 0;
            let memoryMaxMb = 'unlimited';
            try {
                const memInfo = await this.redisConsumer.info('memory');
                for (const line of memInfo.split('\r\n')) {
                    if (line.startsWith('used_memory:')) {
                        memoryUsedMb = Math.round((parseInt(line.split(':')[1], 10) || 0) / 1024 / 1024);
                    }
                    else if (line.startsWith('maxmemory:')) {
                        const v = parseInt(line.split(':')[1], 10);
                        memoryMaxMb = v > 0 ? Math.round(v / 1024 / 1024) : 'unlimited';
                    }
                }
            }
            catch { }
            return {
                streamLength: length,
                workerLag: length,
                firstEntryId: firstEntry ? firstEntry[0] : null,
                lastEntryId: lastEntry ? lastEntry[0] : null,
                pendingMessages: pending[0],
                dlqLength,
                failureTrackingCount,
                consumerGroup: this.consumerGroup,
                consumerName: this.consumerName,
                isRunning: this.isRunning,
                workers: {
                    configured: this.workerCount,
                    current: this.worker?.getCurrentWorkerCount() ?? 0,
                    desired: this.worker?.getDesiredWorkerCount() ?? this.workerCount,
                    min: this.minWorkers,
                    max: this.maxWorkers,
                },
                maxRetries: this.maxRetries,
                maxStreamLength: this.maxStreamLength,
                redis: {
                    memoryUsedMb,
                    memoryMaxMb,
                    memoryUtilizationPct: typeof memoryMaxMb === 'number' && memoryMaxMb > 0
                        ? Math.round((memoryUsedMb / memoryMaxMb) * 100)
                        : null,
                },
                counters: {
                    messagesDropped: metrics_1.metrics.messagesDropped,
                    messagesFailed: metrics_1.metrics.messagesFailed,
                    readingsInserted: metrics_1.metrics.readingsInserted,
                    redisReconnects: metrics_1.metrics.redisReconnects,
                    oomErrors: metrics_1.metrics.oomErrors,
                    oomRetries: metrics_1.metrics.oomRetries,
                },
                latencyP95Ms: {
                    batch: metrics_1.metrics.getBatchLatencyP95(),
                    insert: metrics_1.metrics.getInsertLatencyP95(),
                    dwell: metrics_1.metrics.getDwellLatencyP95(),
                },
                maxDwellMs: metrics_1.metrics.maxDwellMs,
                streamHeadDwellMs: firstEntry && firstEntry[0]
                    ? (() => {
                        const ms = parseInt(firstEntry[0].split('-')[0], 10);
                        return isNaN(ms) ? null : Date.now() - ms;
                    })()
                    : null,
            };
        }
        catch (err) {
            return { error: err.message };
        }
    }
}
exports.RedisDeviceQueue = RedisDeviceQueue;
exports.redisDeviceQueue = new RedisDeviceQueue();
//# sourceMappingURL=redis-device-queue.js.map