/** Where a batch of devie data ultimately landed after an add() call. */
export type AddOutcome = 'redis' | 'disk' | 'dropped';

export interface DeviceDataEntry {
  deviceUuid: string;
  deviceName: string;
  timestamp: string;
  data: any;
  metadata?: Record<string, any>;
}

export interface DeviceIdentity {
  endpointUuid?: string;
  deviceUuid?: string;
  deviceName?: string;
}

export interface CompressedDeviceEntry {
  deviceUuid: string;
  deviceName: string;
  batchId: string;
  compressedPayload: Buffer;
  contentEncoding: string;
  contentType: string;
}

export interface RawDeviceEntry {
  rawData: string;
  deviceUuid?: string;
  deviceName?: string;
}

export interface RedisDeviceEntry {
  id: string;
  data: DeviceDataEntry | CompressedDeviceEntry | RawDeviceEntry;
  isCompressed?: boolean;
  /** Origin of this batch, parsed from the Redis Stream `source` field. */
  source?: string;
}
