/** Where a batch of sensor data ultimately landed after an add() call. */
export type AddOutcome = 'redis' | 'disk' | 'dropped';

export interface DeviceDataEntry {
  deviceUuid: string;
  sensorName: string;
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
  sensorName: string;
  batchId: string;
  compressedPayload: Buffer;
  contentEncoding: string;
  contentType: string;
}

export interface RedisDeviceEntry {
  id: string;
  data: DeviceDataEntry | CompressedDeviceEntry;
  isCompressed?: boolean;
}
