export type AddOutcome = 'redis' | 'dropped';

export interface DeviceDataEntry {
  deviceUuid: string;
  deviceName: string;
  timestamp: string;
  data: unknown;
  metadata?: Record<string, unknown>;
}
