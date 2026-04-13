export type AddOutcome = 'redis' | 'disk' | 'dropped';

/**
 * Discriminates where a publish call is coming from.
 * Used as the first argument to `ingestion.add()`.
 *
 *   'metrics' – device sensor/endpoint data (MQTT endpoints)
 *   'system'  – agent system metrics: cpu, memory, storage, etc.
 *   'logs'    – compressed log batches uploaded over HTTP
 *   'broker'   – mqtt broker metrics
 */
export type IngestionSource = 'metrics' | 'system' | 'logs' | 'broker';

export interface DeviceDataEntry {
  deviceUuid: string;
  deviceName: string;
  timestamp: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}
