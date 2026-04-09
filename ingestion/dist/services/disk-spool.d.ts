import { DeviceDataEntry } from './types';
export declare class DiskSpool {
    private readonly spoolPath;
    private readonly maxSizeMb;
    private currentFile;
    private currentSize;
    private fileIndex;
    private replayInterval;
    private enabled;
    constructor(spoolPath: string, maxSizeMb: number);
    initialize(): Promise<void>;
    isEnabled(): boolean;
    spoolToDisk(deviceData: DeviceDataEntry[]): Promise<void>;
    startReplayer(onBatch: (data: DeviceDataEntry[]) => Promise<unknown>, isReady?: () => boolean): void;
    private getTotalSize;
    getBacklogCount(): Promise<number>;
    private deleteOldestFile;
}
//# sourceMappingURL=disk-spool.d.ts.map