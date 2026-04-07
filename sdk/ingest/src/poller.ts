import { fetchTargetState } from './http';
import type { TargetState } from './types';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Polls `GET /api/v1/device/:uuid/state` on a fixed interval and fires
 * `onTargetState` only when the server signals the state has changed (200 vs
 * 304 Not Modified).  Stores the last ETag in memory so consecutive polls are
 * cheap on both ends.
 */
export class StatePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastEtag: string | undefined;

  constructor(
    private readonly apiUrl: string,
    private readonly deviceUuid: string,
    private readonly deviceApiKey: string,
    private readonly onTargetState: (state: TargetState) => void | Promise<void>,
    private readonly pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer !== null) return;

    // Fire immediately on start so the device gets its initial state without
    // waiting a full poll interval.
    void this.poll();

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    try {
      const result = await fetchTargetState(
        this.apiUrl,
        this.deviceUuid,
        this.deviceApiKey,
        this.lastEtag,
      );
      if (result.changed && result.state) {
        this.lastEtag = result.etag;
        await this.onTargetState(result.state);
      }
    } catch {
      // Transient network/server error — silently ignore and retry next tick.
      // Callers that need visibility into poll errors can wrap onTargetState.
    }
  }
}
