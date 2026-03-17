import type Redis from 'ioredis';
import { logger } from '../../utils/logger';
import { metrics } from './metrics';

type RedisPipelineHandle = ReturnType<Redis['pipeline']>;

/**
 * Batches multiple XADD calls into a single pipeline flush, reducing round trips.
 * Auto-flushes when batchSize is reached or after a 50ms idle window.
 */
export class RedisPipeline {
  private pending: RedisPipelineHandle | null = null;
  private count = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly batchSize = 10,
  ) {}

  /**
   * Add a command to the pipeline. The callback receives the active pipeline
   * so commands can be chained without creating a new pipeline each call.
   */
  async add(fn: (pipeline: RedisPipelineHandle) => void): Promise<void> {
    if (!this.pending) {
      this.pending = this.redis.pipeline();
    }

    fn(this.pending);
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

    // Reset before exec to avoid re-entrance issues
    this.pending = null;
    this.count = 0;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    try {
      const startTime = Date.now();
      await pipeline.exec();
      const duration = Date.now() - startTime;

      logger.debug('Flushed sensor pipeline', {
        operations: count,
        totalLatencyMs: duration,
        avgLatencyPerOpMs: count > 0 ? Math.round(duration / count) : 0,
        opsPerSecond: duration > 0 ? Math.round((count / duration) * 1000) : count,
      });
    } catch (err) {
      metrics.messagesDropped += count;
      logger.error('Sensor pipeline exec failed', {
        error: err instanceof Error ? err.message : String(err),
        count,
        totalDropped: metrics.messagesDropped,
      });
    }
  }
}
