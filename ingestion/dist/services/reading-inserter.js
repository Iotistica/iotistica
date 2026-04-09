"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ReadingInserter = void 0;
const logger_1 = require("../utils/logger");
const readings_service_1 = require("./readings.service");
const connection_1 = require("../db/connection");
const readings_normalizer_1 = require("./readings-normalizer");
const metrics_1 = require("./metrics");
class ReadingInserter {
    readingsService = new readings_service_1.ReadingsService();
    short(id) {
        return id?.substring(0, 8);
    }
    async insertBatch(data) {
        const ingestedAt = new Date();
        const allReadings = [];
        for (const entry of data) {
            try {
                const protocol = (0, readings_normalizer_1.detectProtocol)(entry);
                const expanded = (0, readings_normalizer_1.expandMessages)(entry, protocol, ingestedAt);
                allReadings.push(...expanded);
            }
            catch (error) {
                metrics_1.metrics.messagesFailed++;
                logger_1.logger.warn('Skipping malformed device queue entry during reading normalization', {
                    deviceUuid: this.short(entry.deviceUuid),
                    deviceName: entry.deviceName,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (allReadings.length === 0)
            return;
        const seen = new Map();
        for (const r of allReadings) {
            const key = `${r.agent_uuid}:${r.metric_name}:${(r.time ?? ingestedAt).getTime()}`;
            seen.set(key, r);
        }
        const deduped = [...seen.values()];
        const insertStart = Date.now();
        const insertedCount = await this.readingsService.bulkInsert(deduped);
        const insertMs = Date.now() - insertStart;
        metrics_1.metrics.messagesProcessed += deduped.length;
        metrics_1.metrics.readingsInserted += insertedCount;
        metrics_1.metrics.recordInsertLatency(insertMs);
        const telemetryStart = Date.now();
        await this.updateLastTelemetryAt(deduped, ingestedAt);
        const telemetryMs = Date.now() - telemetryStart;
        logger_1.logger.debug(`Inserted ${insertedCount} readings (deduped ${allReadings.length - deduped.length})`, {
            insertMs,
            telemetryMs,
            rows: deduped.length,
        });
        metrics_1.metrics.lastProcessedTimestamp = Date.now();
    }
    async updateLastTelemetryAt(readings, ingestedAt) {
        const endpointUuids = [...new Set(readings
                .map(r => r.extra?.endpoint_uuid)
                .filter((uuid) => Boolean(uuid)))];
        if (endpointUuids.length === 0)
            return;
        const placeholders = endpointUuids.map((_, i) => `$${i + 2}::uuid`).join(', ');
        await (0, connection_1.query)(`UPDATE endpoints SET last_telemetry_at = $1::timestamptz WHERE uuid IN (${placeholders})`, [ingestedAt.toISOString(), ...endpointUuids]);
    }
}
exports.ReadingInserter = ReadingInserter;
//# sourceMappingURL=reading-inserter.js.map