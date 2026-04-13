export class DeviceQueueMetrics {
  // Gauges — updated by the periodic health collector in DeviceIngestionOrchestrator
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
  /** Process CPU usage over the last sampler window, expressed as percent of one core. */
  processCpuPercent = 0;
  /** Heap used in bytes from process.memoryUsage(). */
  processHeapUsedBytes = 0;
  /** Total allocated V8 heap in bytes from process.memoryUsage(). */
  processHeapTotalBytes = 0;
  /** Resident set size in bytes from process.memoryUsage(). */
  processRssBytes = 0;
  /** Mean event loop delay over the last sampler window in milliseconds. */
  eventLoopDelayMeanMs = 0;
  /** P95 event loop delay over the last sampler window in milliseconds. */
  eventLoopDelayP95Ms = 0;
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
  /** Number of times workers slept because DB pressure gating was active. */
  dbBackpressureEvents = 0;

  // Histograms (last 100 samples)
  batchLatencies: number[] = [];
  insertLatencies: number[] = [];
  resolveLatencies: number[] = [];
  ackLatencies: number[] = [];
  telemetryLatencies: number[] = [];
  processingLatencies: number[] = [];
  /**
   * Per-batch max queue dwell time: how long (ms) the oldest message in the batch
   * waited in the Redis stream before the worker began processing it.
   * Derived from the Redis Stream entry ID (<unix-ms>-<sequence>) — no extra schema needed.
   */
  dwellLatencies: number[] = [];
  private maxSamples = 100;

  private recordSample(samples: number[], ms: number): void {
    samples.push(ms);
    if (samples.length > this.maxSamples) samples.shift();
  }

  private getP95(samples: number[]): number {
    if (samples.length === 0) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.95)] || 0;
  }

  recordBatchLatency(ms: number): void {
    this.recordSample(this.batchLatencies, ms);
  }

  recordInsertLatency(ms: number): void {
    this.recordSample(this.insertLatencies, ms);
  }

  recordResolveLatency(ms: number): void {
    this.recordSample(this.resolveLatencies, ms);
  }

  recordAckLatency(ms: number): void {
    this.recordSample(this.ackLatencies, ms);
  }

  recordTelemetryLatency(ms: number): void {
    this.recordSample(this.telemetryLatencies, ms);
  }

  recordProcessingLatency(ms: number): void {
    this.recordSample(this.processingLatencies, ms);
  }

  recordDwellLatency(ms: number): void {
    this.maxDwellMs = ms;
    this.recordSample(this.dwellLatencies, ms);
  }

  recordRuntimeSample(sample: {
    cpuPercent: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    rssBytes: number;
    eventLoopDelayMeanMs: number;
    eventLoopDelayP95Ms: number;
  }): void {
    this.processCpuPercent = sample.cpuPercent;
    this.processHeapUsedBytes = sample.heapUsedBytes;
    this.processHeapTotalBytes = sample.heapTotalBytes;
    this.processRssBytes = sample.rssBytes;
    this.eventLoopDelayMeanMs = sample.eventLoopDelayMeanMs;
    this.eventLoopDelayP95Ms = sample.eventLoopDelayP95Ms;
  }

  clearDwellLatency(): void {
    this.maxDwellMs = 0;
    this.dwellLatencies = [];
  }

  getBatchLatencyP95(): number {
    return this.getP95(this.batchLatencies);
  }

  getInsertLatencyP95(): number {
    return this.getP95(this.insertLatencies);
  }

  getResolveLatencyP95(): number {
    return this.getP95(this.resolveLatencies);
  }

  getAckLatencyP95(): number {
    return this.getP95(this.ackLatencies);
  }

  getTelemetryLatencyP95(): number {
    return this.getP95(this.telemetryLatencies);
  }

  getProcessingLatencyP95(): number {
    return this.getP95(this.processingLatencies);
  }

  getDwellLatencyP95(): number {
    return this.getP95(this.dwellLatencies);
  }

  setWorkerCount(count: number): void {
    this.workerCount = Math.max(0, count);
  }
}

export const metrics = new DeviceQueueMetrics();
