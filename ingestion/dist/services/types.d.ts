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
export interface RedisDeviceEntry {
    id: string;
    data: DeviceDataEntry | CompressedDeviceEntry;
    isCompressed?: boolean;
}
//# sourceMappingURL=types.d.ts.map