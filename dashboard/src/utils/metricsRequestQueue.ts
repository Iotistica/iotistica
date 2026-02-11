type Fetcher<T> = () => Promise<T>;

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

type QueueTask<T> = {
  key: string;
  fetcher: Fetcher<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  cacheTtlMs: number;
};

const MAX_CONCURRENT = 3;
const MIN_DELAY_MS = 250;
const DEFAULT_CACHE_TTL_MS = 15000;
const DEFAULT_BACKOFF_MS = 30000;
const MAX_CACHE_ENTRIES = 200;
const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_DELAY_MS = 500;

class MetricsRequestQueue {
  private queue: Array<QueueTask<any>> = [];
  private inFlight = new Map<string, Promise<any>>();
  private cache = new Map<string, CacheEntry<any>>();
  private activeCount = 0;
  private lastStartAt = 0;
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  enqueue<T>(key: string, fetcher: Fetcher<T>, cacheTtlMs?: number): Promise<T> {
    const now = Date.now();
    this.cleanupCache(now);

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return Promise.resolve(cached.value as T);
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const taskPromise = new Promise<T>((resolve, reject) => {
      this.queue.push({
        key,
        fetcher,
        resolve,
        reject,
        cacheTtlMs: cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
      });
      this.scheduleProcess();
    });

    this.inFlight.set(key, taskPromise);
    return taskPromise;
  }

  private process(): void {
    if (this.timer) {
      return;
    }

    const delay = this.getDelayMs();
    if (delay > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.process();
      }, delay);
      return;
    }

    while (this.activeCount < MAX_CONCURRENT && this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        return;
      }
      this.startTask(task);
    }
  }

  private getDelayMs(): number {
    const now = Date.now();
    if (now < this.cooldownUntil) {
      return this.cooldownUntil - now;
    }

    const sinceLast = now - this.lastStartAt;
    if (sinceLast < MIN_DELAY_MS) {
      return MIN_DELAY_MS - sinceLast;
    }

    return 0;
  }

  private startTask<T>(task: QueueTask<T>): void {
    this.activeCount += 1;
    this.lastStartAt = Date.now();

    this.runTask(task)
      .then((result) => {
        if (task.cacheTtlMs > 0) {
          this.cache.set(task.key, {
            value: result,
            expiresAt: Date.now() + task.cacheTtlMs
          });
          this.evictCacheIfNeeded();
        }
        task.resolve(result);
      })
      .catch((error) => {
        const status = (error as any)?.status;
        if (status === 429) {
          const retryAfter = (error as any)?.retryAfter;
          const backoffMs = Number.isFinite(retryAfter)
            ? Math.max(0, retryAfter) * 1000
            : DEFAULT_BACKOFF_MS;
          this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + backoffMs);
        }
        task.reject(error);
      })
      .finally(() => {
        this.activeCount -= 1;
        this.inFlight.delete(task.key);
        this.scheduleProcess();
      });
  }

  private async runTask<T>(task: QueueTask<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await task.fetcher();
      } catch (error) {
        const status = (error as any)?.status as number | undefined;
        const isTransient = status !== undefined && status >= 500 && status < 600;
        if (isTransient && attempt < TRANSIENT_RETRY_LIMIT) {
          attempt += 1;
          await this.sleep(TRANSIENT_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
    }
  }

  private scheduleProcess(): void {
    if (this.timer) {
      return;
    }
    queueMicrotask(() => this.process());
  }

  private cleanupCache(now: number): void {
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        this.cache.delete(key);
      }
    }
  }

  private evictCacheIfNeeded(): void {
    if (this.cache.size <= MAX_CACHE_ENTRIES) {
      return;
    }
    const overflow = this.cache.size - MAX_CACHE_ENTRIES;
    for (const key of this.cache.keys()) {
      this.cache.delete(key);
      if (this.cache.size <= MAX_CACHE_ENTRIES - Math.max(0, overflow - 1)) {
        break;
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const metricsRequestQueue = new MetricsRequestQueue();
