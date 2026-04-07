import type { WireEntry } from './types';
export interface HttpTransportOptions {
    apiUrl: string;
    deviceUuid: string;
    deviceApiKey: string;
    maxRetries: number;
    onDropped?: (entries: WireEntry[], reason: string) => void;
}
/**
 * Serialises a batch of WireEntries to NDJSON, gzip-compresses it, then POSTs
 * to `POST /api/v1/device/:uuid/logs` reusing the exact protocol the existing
 * agent uses (same route, same headers, same idempotency X-Batch-Id).
 *
 * Retries on 5xx / network errors with exponential backoff.
 * Returns true on success, false after all retries exhausted.
 */
export declare class HttpTransport {
    private readonly opts;
    constructor(opts: HttpTransportOptions);
    send(entries: WireEntry[]): Promise<boolean>;
}
export interface RegisterOptions {
    apiUrl: string;
    provisioningKey: string;
    uuid: string;
    deviceName: string;
    deviceApiKey: string;
}
/**
 * Registers this device with the Iotistica platform using a provisioning key.
 * Only called once per device lifecycle; result is persisted to the state file.
 * Throws on any non-200 response.
 */
export declare function registerDevice(opts: RegisterOptions): Promise<void>;
//# sourceMappingURL=http.d.ts.map