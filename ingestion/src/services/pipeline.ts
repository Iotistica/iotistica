import type Redis from 'ioredis';
import { logger } from '../utils/logger';

type RedisPipelineHandle = ReturnType<Redis['pipeline']>;
type PipelineCallback = (pipeline: RedisPipelineHandle) => void;

interface PendingPipelineEntry {
  callback: PipelineCallback;
  resolve: () => void;
  reject: (error: Error) => void;
}

export interface PipelineOptions {
  /** Number of commands to accumulate before auto-flushing (default: 10) */
  batchSize?: number;
  /** Idle time before auto-flushing pending commands (default: 50ms, 0 = immediate flush) */
  flushIntervalMs?: number;
}

/**
 * Batches multiple XADD calls into a single pipeline flush, reducing round trips.
 * Auto-flushes when batchSize is reached or after the configured idle window.
 */
export class RedisPipeline {
  private pending: RedisPipelineHandle | null = null;
  private pendingEntries: PendingPipelineEntry[] = [];
  private count = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly batchSize: number;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly redis: Redis,
    opts: PipelineOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 10;
    this.flushIntervalMs = Math.max(0, opts.flushIntervalMs ?? 50);
  }

  /**
   * Add a command to the pipeline. The callback receives the active pipeline
   * so commands can be chained without creating a new pipeline each call.
   */
  async add(fn: PipelineCallback): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.pending) {
        this.pending = this.redis.pipeline();
      }

      fn(this.pending);
      this.pendingEntries.push({ callback: fn, resolve, reject });
      this.count++;

      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }

      if (this.count >= this.batchSize) {
        void this.flush().catch(err => reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }

      if (this.flushIntervalMs === 0) {
        void this.flush().catch(err => reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }

      // Schedule flush after the configured idle window if no more commands arrive.
      this.flushTimer = setTimeout(() => {
        this.flush().catch(err =>
          logger.error('Pipeline auto-flush failed', { error: err.message }),
        );
      }, this.flushIntervalMs);
    });
  }

  async flush(): Promise<void> {
    if (!this.pending || this.count === 0) return;

    const count = this.count;
    const pipeline = this.pending;
    const entries = this.pendingEntries;

    // Reset before exec to avoid re-entrance issues
    this.pending = null;
    this.pendingEntries = [];
    this.count = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      const startTime = Date.now();
      // ioredis returns [Error|null, result][] — per-command errors don't throw
      const results = await pipeline.exec() as Array<[Error | null, unknown]> | null;
      const duration = Date.now() - startTime;

      if (results) {
        results.forEach(([err], idx) => {
          const entry = entries[idx];
          if (!entry) return;
          if (!err) {
            entry.resolve();
          } else {
            entry.reject(err);
          }
        });
      } else {
        // Null means pipeline yielded no per-command details; fail safe.
        for (const entry of entries) {
          entry.reject(new Error('Redis pipeline exec returned null'));
        }
      }

      const successCount = results ? results.filter(([err]) => !err).length : 0;
      logger.debug('Flushed device pipeline', {
        operations: successCount,
        totalLatencyMs: duration,
        avgLatencyPerOpMs: successCount > 0 ? Math.round(duration / successCount) : 0,
        opsPerSecond: duration > 0 ? Math.round((successCount / duration) * 1000) : successCount,
      });
    } catch (err) {
      // Connection-level failure (not per-command) — whole flush failed
      for (const entry of entries) {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      }
      logger.error('Device pipeline exec failed', {
        error: err instanceof Error ? err.message : String(err),
        count,
      });
    }
  }
}
