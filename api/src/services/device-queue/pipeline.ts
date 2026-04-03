import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { metrics } from './metrics';
import { backoffDelayMs, sleep } from './retry-utils';

type RedisPipelineHandle = ReturnType<Redis['pipeline']>;
type PipelineCallback = (pipeline: RedisPipelineHandle) => void;

export interface PipelineOptions {
  /** Number of commands to accumulate before auto-flushing (default: 10) */
  batchSize?: number;
  /**
   * Max OOM retry attempts before giving up (default: 5).
   * Backoff sequence: ~100ms → 200ms → 400ms → 800ms → 1600ms (~3.1 s total).
   */
  maxOomRetries?: number;
  /** Called with the count of commands permanently dropped after all OOM retries exhausted */
  onPersistentOomFailure?: (droppedCount: number) => void;
}

/**
 * Batches multiple XADD calls into a single pipeline flush, reducing round trips.
 * Auto-flushes when batchSize is reached or after a 50ms idle window.
 *
 * When Redis returns OOM errors on individual commands (noeviction policy), the
 * affected commands are retried with exponential backoff + jitter. Only after all
 * retries are exhausted does it call onPersistentOomFailure so callers can open
 * the circuit breaker and route subsequent writes to the disk spool.
 */
export class RedisPipeline {
  private pending: RedisPipelineHandle | null = null;
  private pendingCallbacks: PipelineCallback[] = [];
  private count = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly batchSize: number;
  private readonly maxOomRetries: number;
  private readonly onPersistentOomFailure?: (droppedCount: number) => void;

  constructor(
    private readonly redis: Redis,
    opts: PipelineOptions = {},
  ) {
    this.batchSize = opts.batchSize ?? 10;
    this.maxOomRetries = opts.maxOomRetries ?? 5;
    this.onPersistentOomFailure = opts.onPersistentOomFailure;
  }

  /**
   * Add a command to the pipeline. The callback receives the active pipeline
   * so commands can be chained without creating a new pipeline each call.
   */
  async add(fn: PipelineCallback): Promise<void> {
    if (!this.pending) {
      this.pending = this.redis.pipeline();
    }

    fn(this.pending);
    this.pendingCallbacks.push(fn);
    this.count++;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.count >= this.batchSize) {
      return this.flush();
    }

    // Schedule flush after 50ms if no more commands arrive
    this.flushTimer = setTimeout(() => {
      this.flush().catch(err =>
        logger.error('Pipeline auto-flush failed', { error: err.message }),
      );
    }, 50);
  }

  async flush(): Promise<void> {
    if (!this.pending || this.count === 0) return;

    const count = this.count;
    const pipeline = this.pending;
    const callbacks = this.pendingCallbacks;

    // Reset before exec to avoid re-entrance issues
    this.pending = null;
    this.pendingCallbacks = [];
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

      // Detect per-command OOM rejections (noeviction policy)
      const oomCallbacks: PipelineCallback[] = [];
      if (results) {
        results.forEach(([err], idx) => {
          if (err?.message?.includes('OOM')) {
            oomCallbacks.push(callbacks[idx]);
          }
        });
      }

      if (oomCallbacks.length > 0) {
        metrics.oomErrors++;
        logger.warn('Redis OOM on pipeline flush, retrying with backoff', {
          oomCount: oomCallbacks.length,
          successCount: count - oomCallbacks.length,
        });
        const dropped = await this.retryOomFailures(oomCallbacks, 0);
        if (dropped > 0) {
          metrics.messagesDropped += dropped;
          logger.error('Redis OOM: exhausted retries, commands dropped', {
            dropped,
            totalDropped: metrics.messagesDropped,
          });
          this.onPersistentOomFailure?.(dropped);
        }
      }

      const successCount = count - oomCallbacks.length;
      logger.debug('Flushed sensor pipeline', {
        operations: successCount,
        totalLatencyMs: duration,
        avgLatencyPerOpMs: successCount > 0 ? Math.round(duration / successCount) : 0,
        opsPerSecond: duration > 0 ? Math.round((successCount / duration) * 1000) : successCount,
      });
    } catch (err) {
      // Connection-level failure (not per-command) — whole flush failed
      metrics.messagesDropped += count;
      logger.error('Sensor pipeline exec failed', {
        error: err instanceof Error ? err.message : String(err),
        count,
        totalDropped: metrics.messagesDropped,
      });
    }
  }

  /**
   * Retry OOM-failed commands with exponential backoff + jitter.
   * Returns the number of commands still failing after all retries.
   */
  private async retryOomFailures(
    failedCallbacks: PipelineCallback[],
    attempt: number,
  ): Promise<number> {
    if (failedCallbacks.length === 0) return 0;

    if (attempt >= this.maxOomRetries) {
      return failedCallbacks.length;
    }

    const delay = backoffDelayMs(attempt);
    metrics.oomRetries += failedCallbacks.length;
    logger.debug('OOM retry backoff', {
      attempt: attempt + 1,
      maxAttempts: this.maxOomRetries,
      delayMs: delay,
      commandCount: failedCallbacks.length,
    });
    await sleep(delay);

    // Rebuild a fresh pipeline from the stored callbacks
    const retryPipeline = this.redis.pipeline();
    for (const cb of failedCallbacks) cb(retryPipeline);

    let results: Array<[Error | null, unknown]> | null = null;
    try {
      results = await retryPipeline.exec() as Array<[Error | null, unknown]> | null;
    } catch {
      // Connection-level failure during retry — retry all callbacks
      return this.retryOomFailures(failedCallbacks, attempt + 1);
    }

    const stillFailing: PipelineCallback[] = [];
    if (results) {
      results.forEach(([err], idx) => {
        if (err?.message?.includes('OOM')) {
          stillFailing.push(failedCallbacks[idx]);
        }
      });
    }

    if (stillFailing.length === 0) {
      logger.info('OOM retry succeeded', {
        attempt: attempt + 1,
        recoveredCount: failedCallbacks.length,
      });
      return 0;
    }

    return this.retryOomFailures(stillFailing, attempt + 1);
  }
}
