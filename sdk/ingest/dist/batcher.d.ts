import type { Reading } from './types';
import type { HttpTransport } from './http';
/**
 * Accumulates readings in memory and flushes them to the API in batches.
 *
 * Flush is triggered by whichever comes first:
 *   - Buffer reaches `maxSize` entries
 *   - Periodic timer fires (`flushIntervalMs`)
 *   - Caller explicitly calls `flush()` or `close()`
 */
export declare class Batcher {
    private readonly transport;
    private readonly deviceUuid;
    private readonly deviceName;
    private readonly maxSize;
    private readonly flushIntervalMs;
    private readonly buffer;
    private timer;
    constructor(transport: HttpTransport, deviceUuid: string, deviceName: string, maxSize: number, flushIntervalMs: number);
    start(): void;
    add(reading: Reading): void;
    flush(): Promise<void>;
    close(): Promise<void>;
    /** Number of entries currently buffered (useful for tests). */
    get size(): number;
}
/** Generate a cryptographically random hex string suitable as a device API key. */
export declare function generateApiKey(): string;
//# sourceMappingURL=batcher.d.ts.map