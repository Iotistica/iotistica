/**
 * Ingestion facade.
 *
 * Single entry point for all Redis Stream writes in the API.
 * Callers pick a source tag; the class routes to the right publisher.
 *
 *   ingestion.add('metrics', entries)  – device sensor/endpoint data
 *   ingestion.add('system',  entries)  – agent system metrics (cpu, memory, etc.)
 *   ingestion.add('logs',    entry)    – compressed log batch
 */

import { redisDeviceQueue, DeviceLogsPublisher } from './publisher';
import type { CompressedLogEntry } from './publisher';
import type { AddOutcome, DeviceDataEntry, IngestionSource } from './types';

type DataSource = Exclude<IngestionSource, 'logs'>;

export class Ingestion {
  private readonly logQueue = new DeviceLogsPublisher();

  add(source: 'logs', entry: CompressedLogEntry): Promise<void>;
  add(source: DataSource, entries: DeviceDataEntry[]): Promise<AddOutcome>;
  add(
    source: IngestionSource,
    data: DeviceDataEntry[] | CompressedLogEntry,
  ): Promise<AddOutcome | void> {
    if (source === 'logs') {
      return this.logQueue.addCompressed(data as CompressedLogEntry, 'logs');
    }
    return redisDeviceQueue.add(data as DeviceDataEntry[], source);
  }
}

export const ingestion = new Ingestion();
