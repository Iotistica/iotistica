import { DeviceDataEntry } from './types';
export declare class ReadingInserter {
    private readonly readingsService;
    private short;
    insertBatch(data: DeviceDataEntry[]): Promise<void>;
    private updateLastTelemetryAt;
}
//# sourceMappingURL=reading-inserter.d.ts.map