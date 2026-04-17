import { logger } from '../utils/logger';
import { ReadingsService, ReadingInsert } from './readings';
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
    let processedMessageCount = 0;

    for (const entry of data) {
      try {
        const protocol = detectProtocol(entry);
        const expanded = expandMessages(entry, protocol, ingestedAt);
        if (expanded.length > 0) {
          processedMessageCount++;
        }
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
    // Sort by PK so all concurrent workers acquire row locks in the same order.
    // Prevents deadlocks when multiple ingestion pods insert overlapping key sets.
    const deduped = [...seen.values()].sort((a, b) => {
      const uuidCmp = a.agent_uuid.localeCompare(b.agent_uuid);
      if (uuidCmp !== 0) return uuidCmp;
      const metricCmp = a.metric_name.localeCompare(b.metric_name);
      if (metricCmp !== 0) return metricCmp;
      return (a.time?.getTime() ?? 0) - (b.time?.getTime() ?? 0);
    });

    const insertStart = Date.now();
    const insertedCount = await this.readingsService.bulkInsert(deduped);
    const insertMs = Date.now() - insertStart;

    metrics.messagesProcessed += processedMessageCount;
    metrics.readingsInserted += insertedCount;
    metrics.recordInsertLatency(insertMs);

    // Fire-and-forget: don't block the batch cycle on a secondary UPDATE
    this.updateLastTelemetryAt(deduped, ingestedAt)
      .then(telemetryMs => metrics.recordTelemetryLatency(telemetryMs))
      .catch(err => logger.warn('Background telemetry timestamp update failed', { error: err instanceof Error ? err.message : String(err) }));

    logger.debug(`Inserted ${insertedCount} readings (deduped ${allReadings.length - deduped.length})`, {
      insertMs,
      rows: deduped.length,
    });
    metrics.lastProcessedTimestamp = Date.now();
  }

  /**
   * Stamp last_telemetry_at on endpoints rows using the endpoint_uuid from extra.
   * Decouples "data is flowing" from MQTT heartbeat / connectivity events.
   */
  private async updateLastTelemetryAt(readings: ReadingInsert[], ingestedAt: Date): Promise<number> {
    const endpointUuids = [...new Set(
      readings
        .map(r => r.extra?.endpoint_uuid as string)
        .filter((uuid): uuid is string => Boolean(uuid)),
    )];

    if (endpointUuids.length === 0) return 0;

    const start = Date.now();
    const placeholders = endpointUuids.map((_, i) => `$${i + 2}::uuid`).join(', ');
    await query(
      `UPDATE endpoints SET last_telemetry_at = $1::timestamptz WHERE uuid IN (${placeholders})`,
      [ingestedAt.toISOString(), ...endpointUuids],
    );
    return Date.now() - start;
  }
}
