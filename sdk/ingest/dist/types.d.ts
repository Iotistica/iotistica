export interface IotisticaClientOptions {
    /** Base URL of the Iotistica API, e.g. 'https://api.iotistica.cloud' */
    apiUrl: string;
    /**
     * Provisioning key issued from the Iotistica dashboard.
     * Only needed on first run — afterwards the device API key issued during
     * registration is stored in `stateFile` and used for all subsequent calls.
     */
    provisioningKey: string;
    /** Human-readable name for this device, e.g. 'pump-controller-01' */
    deviceName: string;
    /**
     * Path to a JSON file used to persist the device UUID and API key across
     * process restarts. Defaults to './iotistica-state.json'.
     */
    stateFile?: string;
    /**
     * Maximum number of readings to buffer before an automatic flush.
     * Defaults to 100.
     */
    batchSize?: number;
    /**
     * Maximum milliseconds to wait before flushing a non-empty buffer.
     * Defaults to 5000 (5 s).
     */
    flushIntervalMs?: number;
    /**
     * Maximum number of HTTP retry attempts on transient failures.
     * Defaults to 5.
     */
    maxRetries?: number;
    /**
     * Optional callback invoked when readings cannot be delivered after all retries.
     * Receives the wire-format entries that were dropped and a reason string.
     * Useful for logging or writing to a local fallback store.
     */
    onDropped?: (entries: WireEntry[], reason: string) => void;
}
/** A single metric reading to send to the platform. */
export interface Reading {
    /** Metric name, e.g. 'temperature', 'pressure', 'voltage' */
    metric: string;
    /** Numeric value */
    value: number;
    /**
     * ISO-8601 timestamp. Defaults to `new Date().toISOString()` if omitted.
     */
    timestamp?: string;
    /** Arbitrary key-value metadata attached to this reading */
    tags?: Record<string, string | number | boolean>;
}
/** @internal */
export interface WireEntry {
    deviceUuid: string;
    deviceName: string;
    timestamp: string;
    data: Record<string, number>;
    metadata: Record<string, unknown>;
}
/** @internal */
export interface DeviceState {
    uuid: string;
    /** The plain-text device API key generated at registration time */
    deviceApiKey: string;
    registeredAt: string;
}
//# sourceMappingURL=types.d.ts.map