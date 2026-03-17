export class SensorQueueMetrics {
  // Gauges
  streamLength = 0;
  pendingMessages = 0;
  dlqLength = 0;
  failureTrackingCount = 0;
  redisConnected = 1;

  // Counters
  messagesProcessed = 0;
  messagesFailed = 0;
  messagesDropped = 0;
  readingsInserted = 0;
  redisReconnects = 0;

  // Histograms (last 100 samples)
  batchLatencies: number[] = [];
  insertLatencies: number[] = [];
  private maxSamples = 100;

  recordBatchLatency(ms: number): void {
    this.batchLatencies.push(ms);
    if (this.batchLatencies.length > this.maxSamples) this.batchLatencies.shift();
  }

  recordInsertLatency(ms: number): void {
    this.insertLatencies.push(ms);
    if (this.insertLatencies.length > this.maxSamples) this.insertLatencies.shift();
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
}

export const metrics = new SensorQueueMetrics();
