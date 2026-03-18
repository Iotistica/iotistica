import { logger } from '../../utils/logger';
import { ReadingsService, ReadingInsert } from '../../services/readings.service';
import { query } from '../../db/connection';
import { SensorDataEntry } from './types';
import { detectProtocol, expandMessages } from './readings-normalizer';

export class ReadingInserter {
  private readonly readingsService = new ReadingsService();

  async insertBatch(data: SensorDataEntry[]): Promise<void> {
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

      const insertedCount = await this.readingsService.bulkInsert(readings);
      logger.debug(`Inserted ${insertedCount} readings (chunk ${Math.floor(i / chunkSize) + 1})`);

      await this.updateLastTelemetryAt(readings, ingestedAt);
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
