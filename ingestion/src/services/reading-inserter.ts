import { logger } from '../utils/logger';
import { ReadingsService, ReadingInsert } from './readings.service';
import { query } from '../db/connection';
import { DeviceDataEntry } from './types';
import { detectProtocol, expandMessages } from './readings-normalizer';
import { metrics } from './metrics';

export class ReadingInserter {
  private readonly readingsService = new ReadingsService();

  private short(id?: string): string | undefined {
    return id?.substring(0, 8);
  }

  async insertBatch(data: DeviceDataEntry[]): Promise<void> {
    const ingestedAt = new Date();
    const allReadings: ReadingInsert[] = [];

    for (const entry of data) {
      try {
        const protocol = detectProtocol(entry);
        const expanded = expandMessages(entry, protocol, ingestedAt);
        allReadings.push(...expanded);
      } catch (error: unknown) {
        metrics.messagesFailed++;
        logger.warn('Skipping malformed device queue entry during reading normalization', {
          deviceUuid: this.short(entry.deviceUuid),
          deviceName: entry.deviceName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (allReadings.length === 0) return;

    // Deduplicate intra-batch on (agent_uuid, metric_name, time) before hitting the DB.
    // Eliminates ON CONFLICT hits from replay/retry scenarios within the same batch.
    const seen = new Map<string, ReadingInsert>();
    for (const r of allReadings) {
      const key = `${r.agent_uuid}:${r.metric_name}:${(r.time ?? ingestedAt).getTime()}`;
      seen.set(key, r); // last writer wins (most recent re-send is authoritative)
    }
    const deduped = [...seen.values()];

    const insertStart = Date.now();
    const insertedCount = await this.readingsService.bulkInsert(deduped);
    const insertMs = Date.now() - insertStart;

    metrics.messagesProcessed += deduped.length;
    metrics.readingsInserted += insertedCount;
    metrics.recordInsertLatency(insertMs);

    const telemetryStart = Date.now();
    await this.updateLastTelemetryAt(deduped, ingestedAt);
    const telemetryMs = Date.now() - telemetryStart;
    metrics.recordTelemetryLatency(telemetryMs);

    logger.debug(`Inserted ${insertedCount} readings (deduped ${allReadings.length - deduped.length})`, {
      insertMs,
      telemetryMs,
      rows: deduped.length,
    });
    metrics.lastProcessedTimestamp = Date.now();
  }

  /**
   * Stamp last_telemetry_at on endpoints rows using the endpoint_uuid from extra.
   * Decouples "data is flowing" from MQTT heartbeat / connectivity events.
   */
  private async updateLastTelemetryAt(readings: ReadingInsert[], ingestedAt: Date): Promise<void> {
    const endpointUuids = [...new Set(
      readings
        .map(r => r.extra?.endpoint_uuid as string)
        .filter((uuid): uuid is string => Boolean(uuid)),
    )];

    if (endpointUuids.length === 0) return;

    const placeholders = endpointUuids.map((_, i) => `$${i + 2}::uuid`).join(', ');
    await query(
      `UPDATE endpoints SET last_telemetry_at = $1::timestamptz WHERE uuid IN (${placeholders})`,
      [ingestedAt.toISOString(), ...endpointUuids],
    );
  }
}
