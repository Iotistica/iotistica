import { ReadingInsert } from './readings.service';
import { DeviceDataEntry, DeviceIdentity } from './types';
export declare function detectProtocol(entry: DeviceDataEntry): string;
export declare function normalizeQuality(quality: any): string;
export declare function extractDeviceIdentity(reading: any): DeviceIdentity;
export declare function buildExtraPayload(payload: any, entry: DeviceDataEntry, ingestedAt: Date, identityContext?: Record<string, any>): Record<string, any>;
export declare function normalizeReading(reading: any, entry: DeviceDataEntry, protocol: string, ingestedAt: Date, messageTimestamp?: string, messageContext?: Record<string, any>): ReadingInsert | null;
export declare function expandMessages(entry: DeviceDataEntry, protocol: string, ingestedAt: Date): ReadingInsert[];
//# sourceMappingURL=readings-normalizer.d.ts.map