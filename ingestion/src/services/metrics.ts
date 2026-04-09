export class DeviceQueueMetrics {
  // Gauges — updated by the periodic health collector in RedisDeviceQueue
  streamLength = 0;
  pendingMessages = 0;
  dlqLength = 0;
  failureTrackingCount = 0;
  redisConnected = 1;
  /** Bytes currently used by Redis (from INFO memory → used_memory) */
  redisMemoryUsedBytes = 0;
  /** Configured maxmemory limit in bytes (0 = unlimited) */
  redisMemoryMaxBytes = 0;
  /** Current number of active worker loops in this process. */
  workerCount = 0;
  /**
   * Worker lag: approximate number of messages in the ingestion stream that
   * have not yet been processed. Mirrors streamLength but named for clarity.
   */
  workerLag = 0;

  // Counters
  messagesProcessed = 0;
  messagesFailed = 0;
  messagesDropped = 0;
  readingsInserted = 0;
  /** Unix-ms timestamp of the last successfully committed DB batch. Null until first successful insert. */
  lastProcessedTimestamp: number | null = null;
  /** Most recent per-batch max queue dwell time recorded by the worker. */
  maxDwellMs = 0;
  redisReconnects = 0;
  /** Number of times an OOM response was detected on a pipeline flush */
  oomErrors = 0;
  /** Total individual command retries driven by OOM responses */
  oomRetries = 0;

  // Histograms (last 100 samples)
  batchLatencies: number[] = [];
  insertLatencies: number[] = [];
  /**
   * Per-batch max queue dwell time: how long (ms) the oldest message in the batch
   * waited in the Redis stream before the worker began processing it.
   * Derived from the Redis Stream entry ID (<unix-ms>-<sequence>) — no extra schema needed.
   */
  dwellLatencies: number[] = [];
  private maxSamples = 100;

  recordBatchLatency(ms: number): void {
    this.batchLatencies.push(ms);
    if (this.batchLatencies.length > this.maxSamples) this.batchLatencies.shift();
  }

  recordInsertLatency(ms: number): void {
    this.insertLatencies.push(ms);
    if (this.insertLatencies.length > this.maxSamples) this.insertLatencies.shift();
  }

  recordDwellLatency(ms: number): void {
    this.maxDwellMs = ms;
    this.dwellLatencies.push(ms);
    if (this.dwellLatencies.length > this.maxSamples) this.dwellLatencies.shift();
  }

  clearDwellLatency(): void {
    this.maxDwellMs = 0;
    this.dwellLatencies = [];
  }

  getBatchLatencyP95(): number {
    if (this.batchLatencies.length === 0) return 0;
    const sorted = [...this.batchLatencies].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || 0;
  }

  getInsertLatencyP95(): number {
    if (this.insertLatencies.length === 0) return 0;
    const sorted = [...this.insertLatencies].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || 0;
  }

  getDwellLatencyP95(): number {
    if (this.dwellLatencies.length === 0) return 0;
    const sorted = [...this.dwellLatencies].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || 0;
  }

  setWorkerCount(count: number): void {
    this.workerCount = Math.max(0, count);
  }
}

export const metrics = new DeviceQueueMetrics();
