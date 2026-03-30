import { detectGaps } from './chartGapDetection';

const VISUAL_DRIFT_MS = 5000;
const MAX_VISIBLE_GAP_LINES = 50;
const MAX_RENDERED_GAP_MARKERS = 12;

export interface MetricChartSourcePoint {
  time: string;
  avg_value: number;
  min_value: number;
  max_value: number;
  anomaly_score?: number | null;
  anomaly_confidence?: number | null;
  anomaly_event_count?: number;
}

export interface MetricChartPoint {
  time: number;
  timeValue: number;
  timeLabel: string;
  value: number | null;
  min: number;
  max: number;
  anomalyScore?: number | null;
  anomalyConfidence?: number | null;
  anomalyMarker: number | null;
  isGap?: boolean;
  isGapBreak?: boolean;
}

export interface MetricChartPipelineResult {
  chartDataWithGaps: MetricChartPoint[];
  gapMarkerTimes: number[];
  targetYDomain: [number, number];
  xDomain: [number, number];
}

export function getTimeRangeMs(timeRange: '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d'): number {
  switch (timeRange) {
    case '1m':
      return 60 * 1000;
    case '1h':
      return 60 * 60 * 1000;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '12h':
      return 12 * 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    default:
      return 60 * 60 * 1000;
  }
}

export function stabilizeYDomain(
  previousDomain: [number, number] | null,
  nextDomain: [number, number],
  lerpFactor: number,
): [number, number] {
  if (!previousDomain) {
    return nextDomain;
  }

  const [prevMin, prevMax] = previousDomain;
  const [nextMin, nextMax] = nextDomain;

  return [
    nextMin < prevMin ? nextMin : prevMin + (nextMin - prevMin) * lerpFactor,
    nextMax > prevMax ? nextMax : prevMax + (nextMax - prevMax) * lerpFactor,
  ];
}

export function buildMetricChartPipeline<T extends MetricChartSourcePoint>(args: {
  rawData: T[];
  now: number;
  timeRangeMs: number;
  thresholdValues?: number[];
  formatTimeLabel: (timeValue: number) => string;
}): MetricChartPipelineResult | null {
  const { rawData, now, timeRangeMs, thresholdValues = [], formatTimeLabel } = args;

  if (rawData.length === 0) {
    return null;
  }

  const baseChartData = rawData.map<MetricChartPoint>((point) => {
    const timeValue = Date.parse(point.time);
    return {
      time: timeValue,
      timeValue,
      timeLabel: formatTimeLabel(timeValue),
      value: point.avg_value,
      min: point.min_value,
      max: point.max_value,
      anomalyScore: point.anomaly_score,
      anomalyConfidence: point.anomaly_confidence,
      anomalyMarker: (point.anomaly_event_count || 0) > 0 ? point.max_value : null,
    };
  });

  const pointByTime = new Map<number, MetricChartPoint>();
  for (const point of baseChartData) {
    pointByTime.set(point.timeValue, point);
  }

  const dedupedChartData = Array.from(pointByTime.values()).sort((a, b) => a.timeValue - b.timeValue);
  const visibleWindowStart = now - VISUAL_DRIFT_MS - timeRangeMs;
  const visibleChartData = dedupedChartData.filter((point) => point.timeValue >= visibleWindowStart);

  if (visibleChartData.length === 0) {
    return null;
  }

  const chartDataWithGapFlags = detectGaps(visibleChartData);
  const chartDataWithGaps = insertGapBreaks(chartDataWithGapFlags);
  const gapMarkerTimes = clusterGapTimes(
    chartDataWithGapFlags
      .filter((point) => point.isGap)
      .map((point) => point.timeValue)
      .slice(-MAX_VISIBLE_GAP_LINES),
    timeRangeMs,
  );

  const targetYDomain = calculateTargetYDomain(chartDataWithGaps, thresholdValues);
  const domainEnd = now - VISUAL_DRIFT_MS;

  return {
    chartDataWithGaps,
    gapMarkerTimes,
    targetYDomain,
    xDomain: [domainEnd - timeRangeMs, domainEnd],
  };
}

function insertGapBreaks<T extends MetricChartPoint>(
  chartDataWithGapFlags: Array<T & { isGap?: boolean }>,
): MetricChartPoint[] {
  if (chartDataWithGapFlags.length === 0) {
    return [];
  }

  const result: MetricChartPoint[] = [];

  for (let i = 0; i < chartDataWithGapFlags.length; i += 1) {
    const point = chartDataWithGapFlags[i];

    if (i > 0 && point.isGap) {
      result.push({
        ...point,
        value: null,
        isGapBreak: true,
        timeValue: point.timeValue - 1,
        time: point.timeValue - 1,
      });
    }

    result.push(point);
  }

  return result;
}

function calculateTargetYDomain(
  chartData: MetricChartPoint[],
  thresholdValues: number[],
): [number, number] {
  let domainMin = 0;
  let domainMax = 100;
  let dataMin = Infinity;
  let dataMax = -Infinity;

  for (const point of chartData) {
    if (!Number.isFinite(point.value)) {
      continue;
    }

    if ((point.value as number) < dataMin) {
      dataMin = point.value as number;
    }

    if ((point.value as number) > dataMax) {
      dataMax = point.value as number;
    }
  }

  if (dataMin !== Infinity && dataMax !== -Infinity) {
    domainMin = dataMin;
    domainMax = dataMax;

    for (const thresholdValue of thresholdValues) {
      if (thresholdValue < domainMin) {
        domainMin = thresholdValue;
      }
      if (thresholdValue > domainMax) {
        domainMax = thresholdValue;
      }
    }

    const range = domainMax - domainMin;
    const padding = range > 0 ? range * 0.1 : Math.max(Math.abs(domainMax) * 0.1, 1);
    domainMin -= padding;
    domainMax += padding;
  }

  return [domainMin, domainMax];
}

function clusterGapTimes(gapTimes: number[], timeRangeMs: number): number[] {
  if (gapTimes.length <= 1) {
    return gapTimes;
  }

  const clustered: number[] = [];
  const clusterWindowMs = Math.max(Math.floor(timeRangeMs / 30), 60 * 1000);

  let clusterStart = gapTimes[0];
  let clusterEnd = gapTimes[0];

  for (let i = 1; i < gapTimes.length; i += 1) {
    const gapTime = gapTimes[i];

    if ((gapTime - clusterEnd) <= clusterWindowMs) {
      clusterEnd = gapTime;
      continue;
    }

    clustered.push(Math.round((clusterStart + clusterEnd) / 2));
    clusterStart = gapTime;
    clusterEnd = gapTime;
  }

  clustered.push(Math.round((clusterStart + clusterEnd) / 2));

  if (clustered.length <= MAX_RENDERED_GAP_MARKERS) {
    return clustered;
  }

  const sampled: number[] = [];
  const step = (clustered.length - 1) / Math.max(MAX_RENDERED_GAP_MARKERS - 1, 1);

  for (let i = 0; i < MAX_RENDERED_GAP_MARKERS; i += 1) {
    sampled.push(clustered[Math.round(i * step)]);
  }

  return sampled;
}