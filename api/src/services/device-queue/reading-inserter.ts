import { logger } from '../../utils/logger';
import { ReadingsService, ReadingInsert } from '../../services/readings.service';
import { query } from '../../db/connection';
import { DeviceDataEntry } from './types';
import { detectProtocol, expandMessages } from './readings-normalizer';

export class ReadingInserter {
  private readonly readingsService = new ReadingsService();

  async insertBatch(data: DeviceDataEntry[]): Promise<void> {
    const chunkSize = 500;
    const ingestedAt = new Date();

    for (let i = 0; i < data.length; i += chunkSize) {
      const chunk = data.slice(i, i + chunkSize);
      const readings: ReadingInsert[] = [];

      chunk.forEach(entry => {
        const protocol = detectProtocol(entry);
        const expanded = expandMessages(entry, protocol, ingestedAt);
        readings.push(...expanded);
      });

      // Deduplicate intra-batch on (agent_uuid, metric_name, time) before hitting the DB.
      // Eliminates ON CONFLICT hits from replay/retry scenarios within the same batch.
      const seen = new Map<string, ReadingInsert>();
      for (const r of readings) {
        const key = `${r.agent_uuid}:${r.metric_name}:${(r.time ?? ingestedAt).getTime()}`;
        seen.set(key, r); // last writer wins (most recent re-send is authoritative)
      }
      const deduped = [...seen.values()];

      const insertedCount = await this.readingsService.bulkInsert(deduped);
      logger.debug(`Inserted ${insertedCount} readings (chunk ${Math.floor(i / chunkSize) + 1}, deduped ${readings.length - deduped.length})`);

      await this.updateLastTelemetryAt(deduped, ingestedAt);
    }
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
