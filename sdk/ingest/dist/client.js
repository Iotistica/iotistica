"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IotisticaClient = void 0;
const crypto_1 = require("crypto");
const state_1 = require("./state");
const http_1 = require("./http");
const batcher_1 = require("./batcher");
const DEFAULT_STATE_FILE = '.iotistica-device.json';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;
const DEFAULT_MAX_RETRIES = 5;
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
class IotisticaClient {
    constructor(batcher, deviceUuid) {
        this.batcher = batcher;
        this.deviceUuid = deviceUuid;
    }
    /**
     * Static factory.  Loads or creates persistent device state, registers with
     * the platform if running for the first time, then starts the flush timer.
     */
    static async create(opts) {
        const stateFile = opts.stateFile ?? DEFAULT_STATE_FILE;
        let state = (0, state_1.loadState)(stateFile);
        if (!state) {
            // First run: self-provision
            const uuid = (0, crypto_1.randomUUID)();
            const deviceApiKey = (0, batcher_1.generateApiKey)();
            await (0, http_1.registerDevice)({
                apiUrl: opts.apiUrl,
                provisioningKey: opts.provisioningKey,
                uuid,
                deviceName: opts.deviceName,
                deviceApiKey,
            });
            state = { uuid, deviceApiKey, registeredAt: new Date().toISOString() };
            (0, state_1.saveState)(stateFile, state);
        }
        const transport = new http_1.HttpTransport({
            apiUrl: opts.apiUrl,
            deviceUuid: state.uuid,
            deviceApiKey: state.deviceApiKey,
            maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
            onDropped: opts.onDropped,
        });
        const batcher = new batcher_1.Batcher(transport, state.uuid, opts.deviceName, opts.batchSize ?? DEFAULT_BATCH_SIZE, opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
        batcher.start();
        return new IotisticaClient(batcher, state.uuid);
    }
    /**
     * Record a single metric reading.  Readings are buffered locally and sent
     * to the platform in batches — this call never blocks on the network.
     */
    track(metric, value, tags) {
        this.batcher.add({ metric, value, tags });
    }
    /**
     * Buffer a pre-built `Reading` (useful when the caller already has a
     * timestamp or more complex tag structure).
     */
    trackReading(reading) {
        this.batcher.add(reading);
    }
    /**
     * Immediately flush any buffered readings to the API.
     * Useful before a controlled shutdown or at the end of a test.
     */
    async flush() {
        await this.batcher.flush();
    }
    /**
     * Flush remaining data, stop the background timer, and release resources.
     * Call this before your process exits.
     */
    async close() {
        await this.batcher.close();
    }
    /** UUID assigned to this device (persisted across restarts). */
    get uuid() {
        return this.deviceUuid;
    }
    /** Number of readings currently buffered (helpful for diagnostics). */
    get bufferedCount() {
        return this.batcher.size;
    }
}
exports.IotisticaClient = IotisticaClient;
//# sourceMappingURL=client.js.map