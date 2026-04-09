import type Redis from 'ioredis';
import { DeviceDataEntry, CompressedDeviceEntry, AddOutcome } from './types';
import { DiskSpool } from './disk-spool';
import { RedisPipeline } from './pipeline';
export declare class RedisQueueProducer {
    private readonly redis;
    private readonly pipeline;
    private readonly diskSpool;
    private readonly getStreamKey;
    private readonly maxStreamLength;
    constructor(redis: Redis, pipeline: RedisPipeline, diskSpool: DiskSpool, getStreamKey: () => string, maxStreamLength: number);
    private short;
    private isRedisReady;
    isClientReady(): boolean;
    private maxlenArgs;
    private fallbackToDiskOrDrop;
    private logAddResult;
    addCompressed(entry: CompressedDeviceEntry): Promise<void>;
    add(deviceData: DeviceDataEntry[]): Promise<AddOutcome>;
    addInternal(deviceData: DeviceDataEntry[], bypassCircuit?: boolean): Promise<AddOutcome>;
}
//# sourceMappingURL=producer.d.ts.map