"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.readingsService = exports.ReadingsService = void 0;
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const pg_copy_streams_1 = require("pg-copy-streams");
const connection_1 = require("../db/connection");
const client_factory_1 = require("../redis/client-factory");
const logger_1 = __importDefault(require("../utils/logger"));
class LruSet {
    maxSize;
    map = new Map();
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    has(key) {
        return this.map.has(key);
    }
    add(key) {
        if (this.map.has(key))
            return;
        if (this.map.size >= this.maxSize) {
            this.map.delete(this.map.keys().next().value);
        }
        this.map.set(key, 1);
    }
    get size() {
        return this.map.size;
    }
    clear() {
        this.map.clear();
    }
}
class ReadingsService {
    static refreshInFlight = null;
    static lastRefreshAttemptAtMs = 0;
    static LOCAL_REFRESH_ATTEMPT_COOLDOWN_MS = 5000;
    static CATALOG_DISCOVERY_CACHE_MAX = 10000;
    static seenCatalogDevices = new LruSet(ReadingsService.CATALOG_DISCOVERY_CACHE_MAX);
    static seenCatalogMetrics = new LruSet(ReadingsService.CATALOG_DISCOVERY_CACHE_MAX);
    static seenCatalogDeviceMetrics = new LruSet(ReadingsService.CATALOG_DISCOVERY_CACHE_MAX);
    static COPY_TEMP_TABLE_NAME = 'tmp_readings_ingest';
    static COPY_TEMP_TABLE_READY_FLAG = Symbol('copy-temp-table-ready');
    static REDIS_CATALOG_LEASE_KEY = 'catalog:refresh:lease_until_ms';
    static getRedis() {
        try {
            return (0, client_factory_1.getRedisClient)();
        }
        catch {
            return null;
        }
    }
    MAX_ROWS_PER_BULK_INSERT = 500;
    COPY_STAGE_ROWS_PER_BATCH = 5000;
    BULK_INSERT_MODE = (process.env.READINGS_BULK_INSERT_MODE || 'copy').toLowerCase();
    COPY_MIN_ROWS = Math.max(1, Number.isFinite(parseInt(process.env.READINGS_COPY_MIN_ROWS || '1000', 10))
        ? parseInt(process.env.READINGS_COPY_MIN_ROWS || '1000', 10)
        : 1000);
    escapeCopyText(value) {
        return value
            .replace(/\\/g, '\\\\')
            .replace(/\t/g, '\\t')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r');
    }
    copyValue(value) {
        if (value === null || value === undefined)
            return '\\N';
        if (value instanceof Date)
            return this.escapeCopyText(value.toISOString());
        if (typeof value === 'string')
            return this.escapeCopyText(value);
        if (typeof value === 'number' || typeof value === 'boolean')
            return this.escapeCopyText(String(value));
        return this.escapeCopyText(JSON.stringify(value));
    }
    toCopyLine(reading) {
        const { agent_uuid, metric_name, value, quality = 'good', unit = null, protocol, extra = {}, extraJson, time = new Date(), anomaly_score, anomaly_threshold, baseline_samples, detection_methods, detectionMethodsJson, } = reading;
        const fields = [
            this.copyValue(time),
            this.copyValue(agent_uuid),
            this.copyValue(metric_name),
            this.copyValue(value),
            this.copyValue(quality),
            this.copyValue(unit),
            this.copyValue(protocol),
            this.copyValue(extraJson ?? JSON.stringify(extra)),
            this.copyValue(anomaly_score !== undefined ? anomaly_score : null),
            this.copyValue(anomaly_threshold !== undefined ? anomaly_threshold : null),
            this.copyValue(baseline_samples !== undefined ? baseline_samples : null),
            this.copyValue(detectionMethodsJson ?? (detection_methods !== undefined ? JSON.stringify(detection_methods) : null)),
        ];
        return `${fields.join('\t')}\n`;
    }
    async ensureCopyTempTable(client) {
        const trackedClient = client;
        if (trackedClient[ReadingsService.COPY_TEMP_TABLE_READY_FLAG]) {
            return;
        }
        await client.query(`
      CREATE TEMP TABLE IF NOT EXISTS ${ReadingsService.COPY_TEMP_TABLE_NAME} (
        time timestamptz,
        agent_uuid uuid,
        metric_name text,
        value double precision,
        quality text,
        unit text,
        protocol text,
        extra jsonb,
        anomaly_score double precision,
        anomaly_threshold double precision,
        baseline_samples integer,
        detection_methods jsonb
      )
    `);
        trackedClient[ReadingsService.COPY_TEMP_TABLE_READY_FLAG] = true;
    }
    async bulkInsertViaCopy(readings) {
        let insertedTotal = 0;
        const client = await (0, connection_1.getClient)();
        try {
            await this.ensureCopyTempTable(client);
            for (let i = 0; i < readings.length; i += this.COPY_STAGE_ROWS_PER_BATCH) {
                const batch = readings.slice(i, i + this.COPY_STAGE_ROWS_PER_BATCH);
                try {
                    await client.query('BEGIN');
                    await client.query(`TRUNCATE TABLE ${ReadingsService.COPY_TEMP_TABLE_NAME}`);
                    const copySql = `
            COPY ${ReadingsService.COPY_TEMP_TABLE_NAME} (
              time, agent_uuid, metric_name, value, quality, unit, protocol,
              extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods
            )
            FROM STDIN WITH (FORMAT text)
          `;
                    const copyStream = client.query((0, pg_copy_streams_1.from)(copySql));
                    const batchSeen = new Set();
                    await (0, promises_1.pipeline)(stream_1.Readable.from((function* () {
                        for (const r of batch) {
                            const key = `${r.agent_uuid}\t${r.metric_name}\t${(r.time ?? new Date()).getTime()}`;
                            if (batchSeen.has(key))
                                continue;
                            batchSeen.add(key);
                            yield this.toCopyLine(r);
                        }
                    }).call(this)), copyStream);
                    const insertResult = await client.query(`
            INSERT INTO readings (
              time, agent_uuid, metric_name, value, quality, unit, protocol,
              extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods
            )
            SELECT
              time, agent_uuid, metric_name, value, quality, unit, protocol,
              extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods
            FROM ${ReadingsService.COPY_TEMP_TABLE_NAME}
            ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING
          `);
                    insertedTotal += insertResult.rowCount || 0;
                    await client.query('COMMIT');
                }
                catch (error) {
                    await client.query('ROLLBACK').catch(() => undefined);
                    throw error;
                }
            }
        }
        finally {
            client.release();
        }
        return insertedTotal;
    }
    noteCatalogCandidates(readings) {
        let hasMeaningfulChange = false;
        for (const reading of readings) {
            const metric = reading.metric_name;
            if (metric && !ReadingsService.seenCatalogMetrics.has(metric)) {
                ReadingsService.seenCatalogMetrics.add(metric);
                hasMeaningfulChange = true;
            }
            const extra = reading.extra;
            const device = extra?.device_uuid
                || extra?.deviceUuid
                || extra?.device_name
                || extra?.deviceName
                || reading.agent_uuid;
            if (!device) {
                continue;
            }
            if (!ReadingsService.seenCatalogDevices.has(device)) {
                ReadingsService.seenCatalogDevices.add(device);
                hasMeaningfulChange = true;
            }
            if (!metric) {
                continue;
            }
            const deviceMetricKey = `${device}:${metric}`;
            if (!ReadingsService.seenCatalogDeviceMetrics.has(deviceMetricKey)) {
                ReadingsService.seenCatalogDeviceMetrics.add(deviceMetricKey);
                hasMeaningfulChange = true;
            }
        }
        return hasMeaningfulChange;
    }
    async refreshMetricCatalog() {
        const now = Date.now();
        if (now - ReadingsService.lastRefreshAttemptAtMs < ReadingsService.LOCAL_REFRESH_ATTEMPT_COOLDOWN_MS) {
            return;
        }
        ReadingsService.lastRefreshAttemptAtMs = now;
        if (ReadingsService.refreshInFlight) {
            return;
        }
        ReadingsService.refreshInFlight = (async () => {
            let leaseAcquired = false;
            const redis = ReadingsService.getRedis();
            try {
                if (redis) {
                    try {
                        const leaseUntilMs = await redis.get(ReadingsService.REDIS_CATALOG_LEASE_KEY);
                        if (leaseUntilMs && parseInt(leaseUntilMs, 10) > Date.now()) {
                            logger_1.default.debug('Skipped metric catalog refresh - Redis lease cache indicates another pod holds the lease');
                            return;
                        }
                    }
                    catch {
                    }
                }
                const claimTime = Date.now();
                const claim = await (0, connection_1.query)(`UPDATE refresh_control
             SET last_refresh = NOW(),
                 lease_until  = NOW() + interval '120 seconds'
           WHERE key = 'metric_catalog'
             AND NOW() > lease_until
           RETURNING 1`, []);
                if (claim.rowCount === 0) {
                    logger_1.default.debug('Skipped metric catalog refresh - another worker holds the lease');
                    return;
                }
                leaseAcquired = true;
                if (redis) {
                    redis
                        .set(ReadingsService.REDIS_CATALOG_LEASE_KEY, String(claimTime + 120_000), 'EX', 120)
                        .catch(() => undefined);
                }
                await (0, connection_1.query)('SELECT refresh_all_catalog_views()', []);
                logger_1.default.debug('Refreshed metric catalog views');
            }
            catch (error) {
                logger_1.default.error('Failed to refresh metric catalog views:', error);
            }
            finally {
                if (leaseAcquired) {
                    if (redis) {
                        redis
                            .set(ReadingsService.REDIS_CATALOG_LEASE_KEY, String(Date.now() + 60_000), 'EX', 60)
                            .catch(() => undefined);
                    }
                    await (0, connection_1.query)(`UPDATE refresh_control
               SET lease_until = NOW() + interval '60 seconds'
             WHERE key = 'metric_catalog'`, []).catch(err => logger_1.default.warn('Failed to release refresh lease:', err));
                }
            }
        })().finally(() => {
            ReadingsService.refreshInFlight = null;
        });
        await ReadingsService.refreshInFlight;
    }
    async insert(reading) {
        const { agent_uuid, metric_name, value, quality = 'good', unit = null, protocol, extra = {}, time = new Date() } = reading;
        await (0, connection_1.query)(`INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`, [time, agent_uuid, metric_name, value, quality, unit, protocol, JSON.stringify(extra)]);
    }
    async bulkInsert(readings) {
        if (readings.length === 0)
            return 0;
        let insertedTotal = 0;
        let copySucceeded = false;
        const copyEnabled = this.BULK_INSERT_MODE === 'copy';
        if (copyEnabled && readings.length >= this.COPY_MIN_ROWS) {
            try {
                insertedTotal = await this.bulkInsertViaCopy(readings);
                copySucceeded = true;
            }
            catch (error) {
                logger_1.default.warn('COPY ingest path failed; falling back to INSERT batching', {
                    error: error.message,
                    readings: readings.length,
                });
            }
        }
        if (!copySucceeded) {
            const insertClient = await (0, connection_1.getClient)();
            try {
                for (let i = 0; i < readings.length; i += this.MAX_ROWS_PER_BULK_INSERT) {
                    const batch = readings.slice(i, i + this.MAX_ROWS_PER_BULK_INSERT);
                    const values = [];
                    const placeholders = [];
                    let paramIndex = 1;
                    batch.forEach((reading) => {
                        const { agent_uuid, metric_name, value, quality = 'good', unit = null, protocol, extra = {}, extraJson, detectionMethodsJson, time = new Date(), anomaly_score, anomaly_threshold, baseline_samples, detection_methods } = reading;
                        placeholders.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
                        values.push(time, agent_uuid, metric_name, value, quality, unit, protocol, extraJson ?? JSON.stringify(extra), anomaly_score !== undefined ? anomaly_score : null, anomaly_threshold !== undefined ? anomaly_threshold : null, baseline_samples !== undefined ? baseline_samples : null, detectionMethodsJson ?? (detection_methods !== undefined ? JSON.stringify(detection_methods) : null));
                    });
                    const result = await insertClient.query(`INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`, values);
                    insertedTotal += result.rowCount || 0;
                }
            }
            finally {
                insertClient.release();
            }
        }
        const hasMeaningfulCatalogChange = this.noteCatalogCandidates(readings);
        if (hasMeaningfulCatalogChange && insertedTotal > 0) {
            this.refreshMetricCatalog().catch(err => logger_1.default.error('Background metric catalog refresh failed:', err));
        }
        return insertedTotal;
    }
}
exports.ReadingsService = ReadingsService;
exports.readingsService = new ReadingsService();
//# sourceMappingURL=readings.service.js.map