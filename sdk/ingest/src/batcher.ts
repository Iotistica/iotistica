import { randomBytes } from 'crypto';
import type { Reading, WireEntry } from './types';
import type { HttpTransport } from './http';

/** Convert a `Reading` (user-facing) into the wire format the API expects. */
function toWireEntry(
  reading: Reading,
  deviceUuid: string,
  deviceName: string,
): WireEntry {
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
export class Batcher {
  private readonly buffer: WireEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transport: HttpTransport,
    private readonly deviceUuid: string,
    private readonly deviceName: string,
    private readonly maxSize: number,
    private readonly flushIntervalMs: number,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    // Don't keep the process alive just because of the SDK timer
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  add(reading: Reading): void {
    this.buffer.push(toWireEntry(reading, this.deviceUuid, this.deviceName));
    if (this.buffer.length >= this.maxSize) {
      void this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.buffer.length);
    await this.transport.send(batch);
  }

  async close(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  /** Number of entries currently buffered (useful for tests). */
  get size(): number {
    return this.buffer.length;
  }
}

/** Generate a cryptographically random hex string suitable as a device API key. */
export function generateApiKey(): string {
  return randomBytes(32).toString('hex');
}
