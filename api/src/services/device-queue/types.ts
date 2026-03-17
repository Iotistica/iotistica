export interface SensorDataEntry {
  deviceUuid: string;
  sensorName: string;
  timestamp: string;
  data: any;
  metadata?: Record<string, any>;
}

export interface DeviceIdentity {
  endpointUuid?: string;
  deviceName?: string;
}

export interface CompressedSensorEntry {
  deviceUuid: string;
  sensorName: string;
  batchId: string;
  compressedPayload: Buffer;
  contentEncoding: string;
  contentType: string;
}

export interface RedisSensorEntry {
  id: string;
  data: SensorDataEntry | CompressedSensorEntry;
  isCompressed?: boolean;
}
