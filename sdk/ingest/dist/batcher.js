"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Batcher = void 0;
exports.generateApiKey = generateApiKey;
const crypto_1 = require("crypto");
/** Convert a `Reading` (user-facing) into the wire format the API expects. */
function toWireEntry(reading, deviceUuid, deviceName) {
    return {
        deviceUuid,
        deviceName,
        timestamp: reading.timestamp ?? new Date().toISOString(),
        data: { [reading.metric]: reading.value },
        metadata: reading.tags ?? {},
    };
}
/**
 * Accumulates readings in memory and flushes them to the API in batches.
 *
 * Flush is triggered by whichever comes first:
 *   - Buffer reaches `maxSize` entries
 *   - Periodic timer fires (`flushIntervalMs`)
 *   - Caller explicitly calls `flush()` or `close()`
 */
class Batcher {
    constructor(transport, deviceUuid, deviceName, maxSize, flushIntervalMs) {
        this.transport = transport;
        this.deviceUuid = deviceUuid;
        this.deviceName = deviceName;
        this.maxSize = maxSize;
        this.flushIntervalMs = flushIntervalMs;
        this.buffer = [];
        this.timer = null;
    }
    start() {
        if (this.timer !== null)
            return;
        this.timer = setInterval(() => {
            void this.flush();
        }, this.flushIntervalMs);
        // Don't keep the process alive just because of the SDK timer
        if (typeof this.timer.unref === 'function')
            this.timer.unref();
    }
    add(reading) {
        this.buffer.push(toWireEntry(reading, this.deviceUuid, this.deviceName));
        if (this.buffer.length >= this.maxSize) {
            void this.flush();
        }
    }
    async flush() {
        if (this.buffer.length === 0)
            return;
        const batch = this.buffer.splice(0, this.buffer.length);
        await this.transport.send(batch);
    }
    async close() {
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
        await this.flush();
    }
    /** Number of entries currently buffered (useful for tests). */
    get size() {
        return this.buffer.length;
    }
}
exports.Batcher = Batcher;
/** Generate a cryptographically random hex string suitable as a device API key. */
function generateApiKey() {
    return (0, crypto_1.randomBytes)(32).toString('hex');
}
//# sourceMappingURL=batcher.js.map