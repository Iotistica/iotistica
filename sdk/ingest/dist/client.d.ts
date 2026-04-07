import type { IotisticaClientOptions, Reading } from './types';
/**
 * `IotisticaClient` — a zero-dependency edge ingest client for the Iotistica
 * IoT platform.
 *
 * Usage:
 * ```ts
 * const client = await IotisticaClient.create({
 *   apiUrl: 'https://api.iotistica.com',
 *   provisioningKey: process.env.PROVISIONING_KEY!,
 *   deviceName: 'my-sensor-01',
 * });
 *
 * client.track('temperature', 24.5, { unit: 'C', room: 'office' });
 * // ...
 * await client.close();
 * ```
 *
 * On the very first run the device self-registers using the provisioning key
 * and persists its UUID + API key to disk.  All subsequent runs skip
 * registration and use the stored credentials.
 */
export declare class IotisticaClient {
    private readonly batcher;
    private readonly deviceUuid;
    private constructor();
    /**
     * Static factory.  Loads or creates persistent device state, registers with
     * the platform if running for the first time, then starts the flush timer.
     */
    static create(opts: IotisticaClientOptions): Promise<IotisticaClient>;
    /**
     * Record a single metric reading.  Readings are buffered locally and sent
     * to the platform in batches — this call never blocks on the network.
     */
    track(metric: string, value: number, tags?: Record<string, string>): void;
    /**
     * Buffer a pre-built `Reading` (useful when the caller already has a
     * timestamp or more complex tag structure).
     */
    trackReading(reading: Reading): void;
    /**
     * Immediately flush any buffered readings to the API.
     * Useful before a controlled shutdown or at the end of a test.
     */
    flush(): Promise<void>;
    /**
     * Flush remaining data, stop the background timer, and release resources.
     * Call this before your process exits.
     */
    close(): Promise<void>;
    /** UUID assigned to this device (persisted across restarts). */
    get uuid(): string;
    /** Number of readings currently buffered (helpful for diagnostics). */
    get bufferedCount(): number;
}
//# sourceMappingURL=client.d.ts.map