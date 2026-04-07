import { randomUUID } from 'crypto';
import { loadState, saveState } from './state';
import { registerDevice, HttpTransport } from './http';
import { Batcher, generateApiKey } from './batcher';
import { StatePoller } from './poller';
import type { IotisticaClientOptions, Reading } from './types';

const DEFAULT_STATE_FILE = '.iotistica-device.json';
const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
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
export class IotisticaClient {
  private constructor(
    private readonly batcher: Batcher,
    private readonly deviceUuid: string,
    private readonly poller: StatePoller | null,
  ) {}

  /**
   * Static factory.  Loads or creates persistent device state, registers with
   * the platform if running for the first time, then starts the flush timer.
   */
  static async create(opts: IotisticaClientOptions): Promise<IotisticaClient> {
    const stateFile = opts.stateFile ?? DEFAULT_STATE_FILE;
    let state = loadState(stateFile);

    if (!state) {
      // First run: self-provision
      const uuid = randomUUID();
      const deviceApiKey = generateApiKey();

      await registerDevice({
        apiUrl: opts.apiUrl,
        provisioningKey: opts.provisioningKey,
        uuid,
        deviceName: opts.deviceName,
        deviceApiKey,
      });

      state = { uuid, deviceApiKey, registeredAt: new Date().toISOString() };
      saveState(stateFile, state);
    }

    const transport = new HttpTransport({
      apiUrl: opts.apiUrl,
      deviceUuid: state.uuid,
      deviceApiKey: state.deviceApiKey,
      maxRetries: opts.maxRetries ?? DEFAULT_MAX_RETRIES,
      onDropped: opts.onDropped,
    });

    const batcher = new Batcher(
      transport,
      state.uuid,
      opts.deviceName,
      opts.batchSize ?? DEFAULT_BATCH_SIZE,
      opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
    );
    batcher.start();

    let poller: StatePoller | null = null;
    if (opts.onTargetState) {
      poller = new StatePoller(
        opts.apiUrl,
        state.uuid,
        state.deviceApiKey,
        opts.onTargetState,
        opts.targetStatePollIntervalMs,
      );
      poller.start();
    }

    return new IotisticaClient(batcher, state.uuid, poller);
  }

  /**
   * Record a single metric reading.  Readings are buffered locally and sent
   * to the platform in batches — this call never blocks on the network.
   */
  track(metric: string, value: number, tags?: Record<string, string>): void {
    this.batcher.add({ metric, value, tags });
  }

  /**
   * Buffer a pre-built `Reading` (useful when the caller already has a
   * timestamp or more complex tag structure).
   */
  trackReading(reading: Reading): void {
    this.batcher.add(reading);
  }

  /**
   * Immediately flush any buffered readings to the API.
   * Useful before a controlled shutdown or at the end of a test.
   */
  async flush(): Promise<void> {
    await this.batcher.flush();
  }

  /**
   * Flush remaining data, stop the background timer, and release resources.
   * Call this before your process exits.
   */
  async close(): Promise<void> {
    this.poller?.stop();
    await this.batcher.close();
  }

  /** UUID assigned to this device (persisted across restarts). */
  get uuid(): string {
    return this.deviceUuid;
  }

  /** Number of readings currently buffered (helpful for diagnostics). */
  get bufferedCount(): number {
    return this.batcher.size;
  }
}
