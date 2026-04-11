import { monitorEventLoopDelay } from 'perf_hooks';

import logger from '../utils/logger';
import { metrics } from '../services/metrics';

const DEFAULT_SAMPLE_INTERVAL_MS = 5000;
const NS_PER_MS = 1_000_000;

function resolveSampleIntervalMs(): number {
  const raw = process.env.INGESTION_RUNTIME_METRICS_INTERVAL_MS;
  if (!raw) return DEFAULT_SAMPLE_INTERVAL_MS;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn('Invalid INGESTION_RUNTIME_METRICS_INTERVAL_MS, using default runtime sampler interval', {
      configuredValue: raw,
      defaultMs: DEFAULT_SAMPLE_INTERVAL_MS,
    });
    return DEFAULT_SAMPLE_INTERVAL_MS;
  }

  return parsed;
}

export function bootstrapRuntimeProfiler(): void {
  const sampleIntervalMs = resolveSampleIntervalMs();
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  let previousCpuUsage = process.cpuUsage();
  let previousSampleAt = process.hrtime.bigint();

  const interval = setInterval(() => {
    const currentSampleAt = process.hrtime.bigint();
    const currentCpuUsage = process.cpuUsage();
    const elapsedMicros = Number(currentSampleAt - previousSampleAt) / 1000;
    const cpuUserMicros = currentCpuUsage.user - previousCpuUsage.user;
    const cpuSystemMicros = currentCpuUsage.system - previousCpuUsage.system;
    const cpuPercent = elapsedMicros > 0
      ? ((cpuUserMicros + cpuSystemMicros) / elapsedMicros) * 100
      : 0;

    const memoryUsage = process.memoryUsage();

    metrics.recordRuntimeSample({
      cpuPercent: Number(cpuPercent.toFixed(2)),
      heapUsedBytes: memoryUsage.heapUsed,
      heapTotalBytes: memoryUsage.heapTotal,
      rssBytes: memoryUsage.rss,
      eventLoopDelayMeanMs: Number((histogram.mean / NS_PER_MS).toFixed(2)),
      eventLoopDelayP95Ms: Number((histogram.percentile(95) / NS_PER_MS).toFixed(2)),
    });

    previousCpuUsage = currentCpuUsage;
    previousSampleAt = currentSampleAt;
    histogram.reset();
  }, sampleIntervalMs);

  interval.unref();

  logger.info('Runtime profiler initialized for ingestion metrics', {
    sampleIntervalMs,
  });
}