import { useState, useEffect, useRef, useMemo, useCallback, memo } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import { buildApiUrl } from '@/config/api';
import { metricsRequestQueue } from '@/utils/metricsRequestQueue';
import { useGlobalNow } from '../hooks/useGlobalNow';
import { useVisibilityState } from '../hooks/useVisibilityState';
import { useIngestionHealth } from '../hooks/useIngestionHealth';
import { buildMetricChartPipeline, getTimeRangeMs, stabilizeYDomain } from '@/utils/metricChartPipeline';

const Y_DOMAIN_SHRINK_LERP = 0.08;
const CHART_Y_AXIS_WIDTH = 40;
const OFFSCREEN_REFRESH_MULTIPLIER = 4;
const OFFSCREEN_MIN_REFRESH_SECONDS = 120;
const HIDDEN_TAB_REFRESH_MULTIPLIER = 10;
const HIDDEN_TAB_MIN_REFRESH_SECONDS = 300;
/** How stale lastProcessedTimestamp must be before the delay zone is rendered on the chart. */
const DELAY_THRESHOLD_MS = 120_000;
const MIN_ZOOM_WINDOW_MS = 10_000;

interface ZoomWindow {
  startTimeMs: number;
  endTimeMs: number;
}

export interface ThresholdLine {
  value: number;
  label?: string;
  color: string;
  lineStyle: 'solid' | 'dashed';
}

export interface MetricDataCardConfig {
  widgetId: string;
  title?: string;
  agentUuid?: string;
  agentName?: string;
  endpointName?: string;
  deviceUuid?: string;
  endpointUuid?: string;
  alertEnabled?: boolean;
  alertMin?: number;
  alertMax?: number;
  deviceName: string;
  metricName: string;
  chartType: 'line' | 'area' | 'bar';
  timeRange: '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d';
  color?: string;
  showStats?: boolean;
  showAnomalyOverlay?: boolean;
  thresholds?: ThresholdLine[];
  thresholdsEnabled?: boolean;
}

interface MetricDataCardProps {
  config: MetricDataCardConfig;
  refreshInterval?: number; // in seconds, 0 = off
  refreshTrigger?: number; // timestamp to trigger manual refresh
  onDataLoaded?: (data: TimeSeriesResponse | null) => void;
}

interface TimeSeriesDataPoint {
  time: string;
  avg_value: number;
  min_value: number;
  max_value: number;
  sample_count: number;
  quality_ratio: number;
  anomaly_score?: number | null;
  anomaly_confidence?: number | null;
  anomaly_event_count?: number;
}

interface TimeSeriesResponse {
  metric: {
    deviceName: string;
    metricName: string;
    unit: string;
    protocol: string;
  };
  metadata: {
    sampleCount: number;
    startTime: string;
    endTime: string;
    aggregationLevel: string;
    timeRange: string;
    qualityPercentage: number;
  };
  data: TimeSeriesDataPoint[];
}

function isValidTimeSeriesResponse(value: unknown): value is TimeSeriesResponse {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<TimeSeriesResponse> & {
    metric?: Partial<TimeSeriesResponse['metric']>;
    metadata?: Partial<TimeSeriesResponse['metadata']>;
  };

  return Array.isArray(candidate.data)
    && typeof candidate.metric?.metricName === 'string'
    && typeof candidate.metric?.protocol === 'string'
    && typeof candidate.metadata?.aggregationLevel === 'string';
}

function normalizeTimeSeriesResponse(response: TimeSeriesResponse): TimeSeriesResponse {
  return {
    ...response,
    data: response.data.map((point) => ({
      ...point,
      sample_count: Number(point.sample_count),
    })),
  };
}

function pointsEqual(a: TimeSeriesDataPoint, b: TimeSeriesDataPoint): boolean {
  return (
    a.time === b.time &&
    a.avg_value === b.avg_value &&
    a.min_value === b.min_value &&
    a.max_value === b.max_value &&
    a.sample_count === b.sample_count &&
    a.quality_ratio === b.quality_ratio &&
    a.anomaly_score === b.anomaly_score &&
    a.anomaly_confidence === b.anomaly_confidence &&
    a.anomaly_event_count === b.anomaly_event_count
  );
}

function mergeTimeSeriesResponse(
  previous: TimeSeriesResponse | null,
  next: TimeSeriesResponse,
  timeRange: MetricDataCardConfig['timeRange']
): { merged: TimeSeriesResponse; changed: boolean } {
  if (!previous || previous.metric.metricName !== next.metric.metricName || previous.metric.deviceName !== next.metric.deviceName) {
    return { merged: next, changed: true };
  }

  const mergedByTime = new Map(previous.data.map((point) => [point.time, point] as const));

  for (const point of next.data) {
    const prevPoint = mergedByTime.get(point.time);
    if (prevPoint && pointsEqual(prevPoint, point)) {
      mergedByTime.set(point.time, prevPoint);
      continue;
    }

    mergedByTime.set(point.time, point);
  }

  const referenceEnd = next.data.length > 0
    ? Date.parse(next.data[next.data.length - 1].time)
    : Date.now();
  const cutoff = referenceEnd - getTimeRangeMs(timeRange);

  const mergedPoints = Array.from(mergedByTime.values())
    .filter((point) => {
      const ts = Date.parse(point.time);
      return ts >= cutoff && ts <= referenceEnd;
    })
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const hasDataChange =
    mergedPoints.length !== previous.data.length ||
    mergedPoints.some((point, idx) => point !== previous.data[idx]);

  const hasMetadataChange =
    previous.metadata.sampleCount !== next.metadata.sampleCount ||
    previous.metadata.startTime !== next.metadata.startTime ||
    previous.metadata.endTime !== next.metadata.endTime ||
    previous.metadata.aggregationLevel !== next.metadata.aggregationLevel ||
    previous.metadata.timeRange !== next.metadata.timeRange ||
    previous.metadata.qualityPercentage !== next.metadata.qualityPercentage;

  const changed = hasDataChange || hasMetadataChange;

  return {
    merged: changed ? { ...next, data: mergedPoints } : previous,
    changed,
  };
}

function MetricDataCardComponent({ config, refreshInterval = 30, refreshTrigger, onDataLoaded }: MetricDataCardProps) {
  const [data, setData] = useState<TimeSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [staleReason, setStaleReason] = useState<string | null>(null);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [zoomWindow, setZoomWindow] = useState<ZoomWindow | null>(null);
  const [zoomSelectionStart, setZoomSelectionStart] = useState<number | null>(null);
  const [zoomSelectionEnd, setZoomSelectionEnd] = useState<number | null>(null);
  const now = useGlobalNow();
  const ingestionHealth = useIngestionHealth();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const latestDataRef = useRef<TimeSeriesResponse | null>(null);
  const fetchDataRef = useRef<() => Promise<void>>(async () => {});
  const yDomainRef = useRef<[number, number] | null>(null);
  const { isInViewport, isPageVisible } = useVisibilityState(cardRef, {
    rootMargin: '240px 0px',
    threshold: 0.01,
  });

  const effectiveRefreshInterval = useMemo(() => {
    if (refreshInterval <= 0) {
      return 0;
    }

    if (!isPageVisible) {
      return Math.max(refreshInterval * HIDDEN_TAB_REFRESH_MULTIPLIER, HIDDEN_TAB_MIN_REFRESH_SECONDS);
    }

    if (!isInViewport) {
      return Math.max(refreshInterval * OFFSCREEN_REFRESH_MULTIPLIER, OFFSCREEN_MIN_REFRESH_SECONDS);
    }

    return refreshInterval;
  }, [isInViewport, isPageVisible, refreshInterval]);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  useEffect(() => {
    yDomainRef.current = null;
  }, [config.deviceUuid, config.metricName, config.timeRange]);

  useEffect(() => {
    setZoomWindow(null);
    setZoomSelectionStart(null);
    setZoomSelectionEnd(null);
  }, [config.deviceUuid, config.metricName, config.timeRange, config.agentUuid]);

  const resetZoom = useCallback(() => {
    setZoomWindow(null);
    setZoomSelectionStart(null);
    setZoomSelectionEnd(null);
  }, []);

  const fetchData = async () => {
    try {
      if (!config.deviceUuid) {
        setError('Widget is missing device UUID. Please edit and re-save this widget.');
        setLoading(false);
        return;
      }

      const cacheTtlMs = effectiveRefreshInterval > 0
        ? Math.min(Math.max(effectiveRefreshInterval * 1000, 5000), 60000)
        : 15000;
      const zoomKey = zoomWindow
        ? `${zoomWindow.startTimeMs}|${zoomWindow.endTimeMs}`
        : 'full';
      const requestKey = `${config.agentUuid || 'all'}|${config.deviceUuid}|${config.metricName}|${config.timeRange}|${zoomKey}`;

      const result: TimeSeriesResponse = await metricsRequestQueue.enqueue(
        requestKey,
        async () => {
          const params = new URLSearchParams({
            metricName: config.metricName,
            timeRange: config.timeRange,
          });
          if (config.deviceUuid) {
            params.set('deviceUuid', config.deviceUuid);
          }
          if (config.agentUuid) {
            params.set('agentUuid', config.agentUuid);
          }
          if (zoomWindow) {
            params.set('startTime', new Date(zoomWindow.startTimeMs).toISOString());
            params.set('endTime', new Date(zoomWindow.endTimeMs).toISOString());
          }
          const url = buildApiUrl(
            `/api/v1/metrics/timeseries?${params.toString()}`
          );

          const response = await fetch(url, {
            headers: {
              Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
            },
          });

          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : 30;
            const error: any = new Error('Rate limited');
            error.status = 429;
            error.retryAfter = Number.isFinite(retrySeconds) ? retrySeconds : 30;
            throw error;
          }
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          const payload: unknown = await response.json();
          if (!isValidTimeSeriesResponse(payload)) {
            throw new Error('Invalid timeseries response payload');
          }

          return normalizeTimeSeriesResponse(payload);
        },
        cacheTtlMs
      );
      const nextData = zoomWindow
        ? result
        : mergeTimeSeriesResponse(latestDataRef.current, result, config.timeRange).merged;
      setData(nextData);
      latestDataRef.current = nextData;
      setError(null);
      setStale(false);
      setStaleReason(null);
      setLastRefreshed(new Date());
      onDataLoaded?.(nextData);
    } catch (err: any) {
      console.error('Error fetching metric data:', err);
      const message = err?.status === 429
        ? 'Rate limited. Pausing refresh briefly.'
        : (err?.message || 'Connection lost');

      const hasExistingData = Boolean(latestDataRef.current && latestDataRef.current.data && latestDataRef.current.data.length > 0);

      if (hasExistingData) {
        // Keep rendering last known-good chart data and mark it stale.
        setStale(true);
        setStaleReason(message);
        setError(null);
      } else {
        // No historical data available - show an empty/offline state instead of a hard fetch error.
        setError(message);
      }

      if (err?.status === 429) {
        setStale(true);
      }
    } finally {
      setLoading(false);
    }
  };

  fetchDataRef.current = fetchData;

  useEffect(() => {
    void fetchDataRef.current();
    
    // Auto-refresh based on global interval (0 = off)
    if (effectiveRefreshInterval > 0) {
      const interval = setInterval(() => {
        void fetchDataRef.current();
      }, effectiveRefreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [config.deviceUuid, config.metricName, config.timeRange, effectiveRefreshInterval, refreshTrigger, config.agentUuid, zoomWindow]);

  const formatTimeValue = useCallback((timeValue: number) => {
    const date = new Date(timeValue);
    const now = new Date();
    const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffHours < 24) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }, []);

  const formatValue = useCallback((value: number | null | undefined) => {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) {
      return '--';
    }
    return value.toFixed(2);
  }, []);

  const formatTimeLabel = useCallback((timeValue: number) => formatTimeValue(timeValue), [formatTimeValue]);
  const timeRangeMs = useMemo(() => getTimeRangeMs(config.timeRange), [config.timeRange]);
  const activeTimeRangeMs = zoomWindow
    ? Math.max(zoomWindow.endTimeMs - zoomWindow.startTimeMs, MIN_ZOOM_WINDOW_MS)
    : timeRangeMs;

  const chartState = useMemo(() => {
    if (!data) {
      return null;
    }

    const thresholdValues = config.thresholdsEnabled && config.thresholds
      ? config.thresholds.map((threshold) => threshold.value)
      : [];

    const pipeline = buildMetricChartPipeline({
      rawData: data.data,
      now,
      timeRangeMs: activeTimeRangeMs,
      thresholdValues,
      formatTimeLabel,
      domainStartTime: zoomWindow?.startTimeMs,
      domainEndTime: zoomWindow?.endTimeMs,
    });

    if (!pipeline) {
      return null;
    }

    const yDomain = stabilizeYDomain(
      yDomainRef.current,
      pipeline.targetYDomain,
      Y_DOMAIN_SHRINK_LERP,
    );
    yDomainRef.current = yDomain;

    return {
      chartDataWithGaps: pipeline.chartDataWithGaps,
      gapMarkerTimes: pipeline.gapMarkerTimes,
      yDomain,
      xDomain: pipeline.xDomain,
    };
  }, [activeTimeRangeMs, config.thresholds, config.thresholdsEnabled, data, formatTimeLabel, now, zoomWindow]);

  const handleChartMouseDown = useCallback((state: { activeLabel?: number | string }) => {
    const labelValue = Number(state?.activeLabel);
    if (!Number.isFinite(labelValue)) {
      return;
    }

    setZoomSelectionStart(labelValue);
    setZoomSelectionEnd(labelValue);
  }, []);

  const handleChartMouseMove = useCallback((state: { activeLabel?: number | string }) => {
    if (zoomSelectionStart === null) {
      return;
    }

    const labelValue = Number(state?.activeLabel);
    if (!Number.isFinite(labelValue)) {
      return;
    }

    setZoomSelectionEnd(labelValue);
  }, [zoomSelectionStart]);

  const handleChartMouseUp = useCallback(() => {
    if (zoomSelectionStart === null || zoomSelectionEnd === null) {
      return;
    }

    const startTimeMs = Math.min(zoomSelectionStart, zoomSelectionEnd);
    const endTimeMs = Math.max(zoomSelectionStart, zoomSelectionEnd);

    setZoomSelectionStart(null);
    setZoomSelectionEnd(null);

    if (endTimeMs - startTimeMs < MIN_ZOOM_WINDOW_MS) {
      return;
    }

    setZoomWindow({ startTimeMs, endTimeMs });
  }, [zoomSelectionEnd, zoomSelectionStart]);

  const activeSelectionRange = useMemo(() => {
    if (zoomSelectionStart === null || zoomSelectionEnd === null) {
      return null;
    }

    return {
      startTimeMs: Math.min(zoomSelectionStart, zoomSelectionEnd),
      endTimeMs: Math.max(zoomSelectionStart, zoomSelectionEnd),
    };
  }, [zoomSelectionEnd, zoomSelectionStart]);

  const zoomWindowLabel = useMemo(() => {
    if (!zoomWindow) {
      return null;
    }

    const minutes = Math.round((zoomWindow.endTimeMs - zoomWindow.startTimeMs) / 60000);
    if (minutes < 1) {
      const seconds = Math.max(1, Math.round((zoomWindow.endTimeMs - zoomWindow.startTimeMs) / 1000));
      return `${seconds}s window`;
    }

    if (minutes < 60) {
      return `${minutes}m window`;
    }

    const hours = ((zoomWindow.endTimeMs - zoomWindow.startTimeMs) / (60 * 60 * 1000)).toFixed(1);
    return `${hours}h window`;
  }, [zoomWindow]);

  const calculateStats = () => {
    if (!data || data.data.length === 0) return null;

    const current = data.data[data.data.length - 1]?.avg_value;
    const previous = data.data[data.data.length - 2]?.avg_value;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;

    for (const point of data.data) {
      const value = point.avg_value;
      if (value < min) min = value;
      if (value > max) max = value;
      sum += value;
    }

    const avg = sum / data.data.length;

    const change = previous ? ((current - previous) / previous) * 100 : 0;
    const trend = change > 0 ? 'up' : change < 0 ? 'down' : 'stable';

    return { current, min, max, avg, change, trend };
  };

  const renderTooltipContent = useCallback(({ active, payload, label }: any) => {
    if (!active || !Array.isArray(payload) || payload.length === 0) {
      return null;
    }

    const unit = data?.metric.unit ?? '';
    const formatTooltipMetricValue = (value: number | null, seriesName?: string) => {
      const tooltipLabel = seriesName === 'Anomaly'
        ? 'Anomaly'
        : seriesName === 'Average'
          ? 'Average'
          : 'Value';

      if (value === null || !Number.isFinite(value)) {
        return ['No data', tooltipLabel] as const;
      }

      return [formatValue(value) + (unit ? ` ${unit}` : ''), tooltipLabel] as const;
    };

    const anomalyEntry = payload.find((entry: any) =>
      entry?.name === 'Anomaly' && Number.isFinite(entry?.value)
    );
    const averageEntry = payload.find((entry: any) =>
      entry?.name === 'Average' && Number.isFinite(entry?.value)
    );

    if (!anomalyEntry && !averageEntry) {
      return null;
    }

    const rows: Array<{ label: string; value: string }> = [];

    if (anomalyEntry) {
      const [value, seriesLabel] = formatTooltipMetricValue(anomalyEntry.value, anomalyEntry.name);
      rows.push({ label: seriesLabel, value });

      const point = anomalyEntry.payload as {
        anomalyScore?: number | null;
        anomalyConfidence?: number | null;
      };

      if (Number.isFinite(point?.anomalyScore)) {
        rows.push({
          label: 'Anomaly score',
          value: Number(point.anomalyScore).toFixed(3),
        });
      }

      if (Number.isFinite(point?.anomalyConfidence)) {
        rows.push({
          label: 'Confidence',
          value: `${(Number(point.anomalyConfidence) * 100).toFixed(1)}%`,
        });
      }
    }

    if (averageEntry) {
      const [value, seriesLabel] = formatTooltipMetricValue(averageEntry.value, averageEntry.name);
      rows.push({ label: seriesLabel, value });
    }

    return (
      <div
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          border: 'none',
          borderRadius: '4px',
          color: 'white',
          padding: '8px 10px',
        }}
      >
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 4 }}>
          {formatTimeValue(label as number)}
        </div>
        {rows.map((row, index) => (
          <div key={`${row.label}-${index}`} style={{ fontSize: 13, fontWeight: 600 }}>
            {row.label}: {row.value}
          </div>
        ))}
      </div>
    );
  }, [data?.metric.unit, formatTimeValue, formatValue]);

  const renderChart = () => {
    const currentData = data;

    if (!chartState || !currentData) return null;

    const { chartDataWithGaps, gapMarkerTimes, yDomain, xDomain } = chartState;
    const suppressOfflineGapRendering = isDelayed || isBuffering || isUnhealthy;
    const renderedChartData = suppressOfflineGapRendering
      ? chartDataWithGaps.filter((point) => !point.isGapBreak)
      : chartDataWithGaps;
    const renderedGapMarkerTimes = suppressOfflineGapRendering ? [] : gapMarkerTimes;
    const lastDataTime = chartDataWithGaps.length > 0
      ? chartDataWithGaps[chartDataWithGaps.length - 1].timeValue
      : null;
    const delayZoneStart = (isDelayed || isBuffering) && ingestionHealth?.lastProcessedTimestamp != null
      ? Math.max(ingestionHealth.lastProcessedTimestamp, xDomain[0])
      : null;
    const showDelayZone = delayZoneStart !== null && delayZoneStart < xDomain[1];
    const commonProps = {
      data: renderedChartData,
      margin: { top: 5, right: 10, left: 0, bottom: 5 },
      onMouseDown: handleChartMouseDown,
      onMouseMove: handleChartMouseMove,
      onMouseUp: handleChartMouseUp,
      onDoubleClick: resetZoom,
    };

    const color = config.color || '#3b82f6'; // Use config color or default blue-500

    switch (config.chartType) {
      case 'area':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart {...commonProps}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis 
                id={`xaxis-${config.widgetId}`}
                dataKey="timeValue"
                type="number"
                scale="time"
                domain={xDomain}
                fontSize={12}
                tickLine={false}
                tickFormatter={(value: number) => formatTimeValue(value)}
              />
              <YAxis 
                id={`yaxis-${config.widgetId}`}
                yAxisId="left"
                orientation="left"
                width={CHART_Y_AXIS_WIDTH}
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={yDomain}
              />
              <Tooltip 
                content={renderTooltipContent}
              />
              {showDelayZone && delayZoneStart !== null && (
                <ReferenceArea
                  x1={delayZoneStart}
                  x2={xDomain[1]}
                  yAxisId="left"
                  fill="rgba(156, 163, 175, 0.15)"
                  stroke="rgba(156, 163, 175, 0.4)"
                  strokeDasharray="4 2"
                  label={isBuffering ? { value: 'Data delayed (buffering)', position: 'insideTopRight', fontSize: 11, fill: '#9ca3af' } : undefined}
                />
              )}
              {activeSelectionRange && (
                <ReferenceArea
                  x1={activeSelectionRange.startTimeMs}
                  x2={activeSelectionRange.endTimeMs}
                  yAxisId="left"
                  fill="rgba(59, 130, 246, 0.14)"
                  stroke="rgba(59, 130, 246, 0.6)"
                  strokeDasharray="3 3"
                />
              )}
              <Area 
                yAxisId="left"
                type="linear" 
                dataKey="value" 
                name="Average"
                stroke={color} 
                fill={color}
                fillOpacity={0.3}
                connectNulls={false}
                isAnimationActive={false}
                animationBegin={0}
                animationDuration={350}
                animationEasing="linear"
              />
              {renderedGapMarkerTimes.map((gapTime, idx) => (
                <ReferenceLine
                  key={`area-gap-${idx}`}
                  x={gapTime}
                  yAxisId="left"
                  stroke="#ef4444"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              ))}
              {stale && lastDataTime !== null && (
                <ReferenceLine
                  x={lastDataTime}
                  yAxisId="left"
                  stroke="#f59e0b"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                  opacity={0.95}
                />
              )}
              {config.thresholdsEnabled && config.thresholds?.map((threshold, idx) => (
                <ReferenceLine
                  key={`threshold-${config.widgetId}-${idx}`}
                  yAxisId="left"
                  y={threshold.value}
                  stroke={threshold.color}
                  strokeDasharray={threshold.lineStyle === 'dashed' ? '5 5' : undefined}
                  strokeWidth={2}
                  label={{
                    value: threshold.label || threshold.value.toString(),
                    position: 'left',
                    fill: threshold.color,
                    fontSize: 12
                  }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        );

      case 'bar':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart {...commonProps}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis 
                id={`xaxis-${config.widgetId}`}
                dataKey="timeValue"
                type="number"
                scale="time"
                domain={xDomain}
                fontSize={12}
                tickLine={false}
                tickFormatter={(value: number) => formatTimeValue(value)}
              />
              <YAxis 
                id={`yaxis-${config.widgetId}`}
                yAxisId="left"
                orientation="left"
                width={CHART_Y_AXIS_WIDTH}
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={yDomain}
              />
              <Tooltip 
                content={renderTooltipContent}
              />
              {showDelayZone && delayZoneStart !== null && (
                <ReferenceArea
                  x1={delayZoneStart}
                  x2={xDomain[1]}
                  yAxisId="left"
                  fill="rgba(156, 163, 175, 0.15)"
                  stroke="rgba(156, 163, 175, 0.4)"
                  strokeDasharray="4 2"
                  label={isBuffering ? { value: 'Data delayed (buffering)', position: 'insideTopRight', fontSize: 11, fill: '#9ca3af' } : undefined}
                />
              )}
              {activeSelectionRange && (
                <ReferenceArea
                  x1={activeSelectionRange.startTimeMs}
                  x2={activeSelectionRange.endTimeMs}
                  yAxisId="left"
                  fill="rgba(59, 130, 246, 0.14)"
                  stroke="rgba(59, 130, 246, 0.6)"
                  strokeDasharray="3 3"
                />
              )}
              <Bar 
                yAxisId="left"
                dataKey="value" 
                name="Average"
                fill={color}
                isAnimationActive={false}
                animationBegin={0}
                animationDuration={350}
                animationEasing="linear"
              />
              {renderedGapMarkerTimes.map((gapTime, idx) => (
                <ReferenceLine
                  key={`bar-gap-${idx}`}
                  x={gapTime}
                  yAxisId="left"
                  stroke="#ef4444"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              ))}
              {stale && lastDataTime !== null && (
                <ReferenceLine
                  x={lastDataTime}
                  yAxisId="left"
                  stroke="#f59e0b"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                  opacity={0.95}
                />
              )}
              {config.thresholdsEnabled && config.thresholds?.map((threshold, idx) => (
                <ReferenceLine
                  key={`threshold-${config.widgetId}-${idx}`}
                  yAxisId="left"
                  y={threshold.value}
                  stroke={threshold.color}
                  strokeDasharray={threshold.lineStyle === 'dashed' ? '5 5' : undefined}
                  strokeWidth={2}
                  label={{
                    value: threshold.label || threshold.value.toString(),
                    position: 'left',
                    fill: threshold.color,
                    fontSize: 12
                  }}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        );

      default: // line
        return (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart {...commonProps}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis 
                id={`xaxis-${config.widgetId}`}
                dataKey="timeValue"
                type="number"
                scale="time"
                domain={xDomain}
                fontSize={12}
                tickLine={false}
                tickFormatter={(value: number) => formatTimeValue(value)}
              />
              <YAxis 
                id={`yaxis-${config.widgetId}`}
                yAxisId="left"
                orientation="left"
                width={CHART_Y_AXIS_WIDTH}
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={yDomain}
              />
              <Tooltip 
                content={renderTooltipContent}
              />
              {showDelayZone && delayZoneStart !== null && (
                <ReferenceArea
                  x1={delayZoneStart}
                  x2={xDomain[1]}
                  yAxisId="left"
                  fill="rgba(156, 163, 175, 0.15)"
                  stroke="rgba(156, 163, 175, 0.4)"
                  strokeDasharray="4 2"
                  label={isBuffering ? { value: 'Data delayed (buffering)', position: 'insideTopRight', fontSize: 11, fill: '#9ca3af' } : undefined}
                />
              )}
              {activeSelectionRange && (
                <ReferenceArea
                  x1={activeSelectionRange.startTimeMs}
                  x2={activeSelectionRange.endTimeMs}
                  yAxisId="left"
                  fill="rgba(59, 130, 246, 0.14)"
                  stroke="rgba(59, 130, 246, 0.6)"
                  strokeDasharray="3 3"
                />
              )}
              <Line 
                yAxisId="left"
                type="linear" 
                dataKey="value" 
                name="Average"
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
                animationBegin={0}
                animationDuration={350}
                animationEasing="linear"
              />
              {config.showAnomalyOverlay !== false && (
                <Line
                  yAxisId="left"
                  type="linear"
                  dataKey="anomalyMarker"
                  name="Anomaly"
                  stroke="transparent"
                  strokeWidth={0}
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={{ r: 4, fill: '#ef4444', stroke: '#ffffff', strokeWidth: 1 }}
                  activeDot={{ r: 5, fill: '#ef4444', stroke: '#ffffff', strokeWidth: 1 }}
                />
              )}
              {renderedGapMarkerTimes.map((gapTime, idx) => (
                <ReferenceLine
                  key={`line-gap-${idx}`}
                  x={gapTime}
                  yAxisId="left"
                  stroke="#ef4444"
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  opacity={0.8}
                />
              ))}
              {stale && lastDataTime !== null && (
                <ReferenceLine
                  x={lastDataTime}
                  yAxisId="left"
                  stroke="#f59e0b"
                  strokeDasharray="3 3"
                  strokeWidth={1.5}
                  opacity={0.95}
                />
              )}
              {config.thresholdsEnabled && config.thresholds?.map((threshold, idx) => (
                <ReferenceLine
                  key={`threshold-${config.widgetId}-${idx}`}
                  yAxisId="left"
                  y={threshold.value}
                  stroke={threshold.color}
                  strokeDasharray={threshold.lineStyle === 'dashed' ? '5 5' : undefined}
                  strokeWidth={2}
                  label={{
                    value: threshold.label || threshold.value.toString(),
                    position: 'left',
                    fill: threshold.color,
                    fontSize: 12
                  }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        );
    }
  };

  const stats = useMemo(() => calculateStats(), [data]);
  const staleAgeLabel = lastRefreshed
    ? `${Math.max(1, Math.floor((now - lastRefreshed.getTime()) / 60000))}m ago`
    : null;
  const isDelayed = ingestionHealth !== null
    && ingestionHealth.lastProcessedTimestamp !== null
    && (now - ingestionHealth.lastProcessedTimestamp > DELAY_THRESHOLD_MS);
  const isBuffering = ingestionHealth?.spoolingActive === true;
  const isUnhealthy = ingestionHealth?.ingestionHealthy === false;
  const refreshState = refreshInterval <= 0
    ? { label: 'Paused', color: '#9ca3af', detail: 'Auto-refresh disabled' }
    : isUnhealthy
      ? { label: 'Warning', color: '#ef4444', detail: 'Ingestion pipeline error' }
      : isBuffering
        ? { label: 'Buffering', color: '#f97316', detail: 'Data delayed - pipeline is spooling to disk' }
        : stale
          ? { label: 'Stale', color: '#f59e0b', detail: staleReason || 'Showing last known data' }
          : !isPageVisible
            ? { label: 'Background', color: '#64748b', detail: `Throttled to every ${effectiveRefreshInterval}s while tab is hidden` }
            : !isInViewport
              ? { label: 'Throttled', color: '#0ea5e9', detail: `Throttled to every ${effectiveRefreshInterval}s while offscreen` }
              : { label: 'Live', color: '#22c55e', detail: `Refreshing every ${effectiveRefreshInterval}s` };

  return (
    <div ref={cardRef} className="h-full flex flex-col">
        {loading && !data ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : !data || data.data.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">
              {error ? 'No data available (connection lost)' : 'No data available'}
            </div>
          </div>
        ) : (
          <>
            {config.showStats !== false && stats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Current</div>
                  <div className="text-lg font-bold flex items-center gap-1">
                    {formatValue(stats.current)}
                    {data?.metric.unit && <span className="text-sm font-normal text-muted-foreground">{data.metric.unit}</span>}
                    {stats.trend === 'up' && <TrendingUp className="h-4 w-4 text-green-500" />}
                    {stats.trend === 'down' && <TrendingDown className="h-4 w-4 text-red-500" />}
                    {stats.trend === 'stable' && <Minus className="h-4 w-4 text-gray-500" />}
                  </div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Average</div>
                  <div className="text-lg font-bold">
                    {formatValue(stats.avg)}
                    {data?.metric.unit && <><span> </span><span className="text-sm font-normal text-muted-foreground">{data.metric.unit}</span></>}
                  </div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Minimum</div>
                  <div className="text-lg font-bold text-blue-600">
                    {formatValue(stats.min)}
                    {data?.metric.unit && <><span> </span><span className="text-sm font-normal text-muted-foreground">{data.metric.unit}</span></>}
                  </div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Maximum</div>
                  <div className="text-lg font-bold text-red-600">
                    {formatValue(stats.max)}
                    {data?.metric.unit && <><span> </span><span className="text-sm font-normal text-muted-foreground">{data.metric.unit}</span></>}
                  </div>
                </div>
              </div>
            )}

            <div className="flex-1">
              {renderChart()}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
              <div className="flex items-center gap-2">
                <span>{data.metadata.sampleCount} points • {data.metadata.aggregationLevel} aggregation</span>
                {zoomWindow && zoomWindowLabel && (
                  <span className="text-[11px] leading-none px-2 py-1 rounded border border-blue-300/60 bg-blue-50/80 text-blue-800 whitespace-nowrap">
                    Zoomed • {zoomWindowLabel}
                  </span>
                )}
                {!zoomWindow && (
                  <span className="text-[11px] text-muted-foreground/80 whitespace-nowrap">
                    Drag chart to zoom
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3">
                {zoomWindow && (
                  <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={resetZoom}>
                    Reset zoom
                  </Button>
                )}
                <div
                  className="flex items-center gap-1 text-xs"
                  style={{ color: refreshState.color }}
                  title={refreshState.detail}
                >
                  <span
                    className="relative inline-flex h-2.5 w-2.5 shrink-0"
                    aria-hidden="true"
                  >
                    {refreshInterval > 0 && refreshState.label === 'Live' && (
                      <span
                        className="absolute inline-flex h-full w-full rounded-full animate-ping opacity-75"
                        style={{ backgroundColor: refreshState.color }}
                      />
                    )}
                    <span
                      className="relative inline-flex h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: refreshState.color }}
                    />
                  </span>
                  {refreshState.label}
                </div>
                {isUnhealthy && (
                  <span
                    className="text-[11px] leading-none px-2 py-1 rounded border border-red-300/60 bg-red-50/80 text-red-700 whitespace-nowrap"
                  >
                    Ingestion offline
                  </span>
                )}
                {stale && (
                  <span
                    className="text-[11px] leading-none px-2 py-1 rounded border border-amber-300/60 bg-amber-50/80 text-amber-800 whitespace-nowrap"
                    title={staleReason || 'Showing last known data'}
                  >
                    Last known{staleAgeLabel ? ` • ${staleAgeLabel}` : ''}
                  </span>
                )}
                {lastRefreshed && (
                  <span className="text-right">
                    Updated {lastRefreshed.toLocaleTimeString()}
                  </span>
                )}
              </div>
            </div>
          </>
        )}
    </div>
  );
}

// Export helper to get badge elements for parent rendering
export function getMetricBadges(data: TimeSeriesResponse | null, config: MetricDataCardConfig) {
  if (!data) return null;
  return (
    <div className="flex items-center gap-2">
      <Badge variant="outline" className="text-xs">
        {data.metric.protocol}
      </Badge>
      <Badge variant="outline" className="text-xs">
        {config.timeRange}
      </Badge>
      {data.metadata.qualityPercentage && (
        <Badge 
          variant={data.metadata.qualityPercentage > 95 ? "default" : "destructive"}
          className="text-xs"
        >
          {data.metadata.qualityPercentage.toFixed(1)}% quality
        </Badge>
      )}
    </div>
  );
}

export const MetricDataCard = memo(MetricDataCardComponent);
