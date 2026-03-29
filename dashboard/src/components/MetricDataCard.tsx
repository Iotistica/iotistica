import { useState, useEffect, useRef, useMemo, memo } from 'react';
import { Badge } from './ui/badge';
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
} from 'recharts';
import { buildApiUrl } from '@/config/api';
import { metricsRequestQueue } from '@/utils/metricsRequestQueue';
import { detectGaps } from '@/utils/chartGapDetection';
import { useGlobalNow } from '../hooks/useGlobalNow';

const VISUAL_DRIFT_MS = 5000;
const MAX_VISIBLE_GAP_LINES = 50;
const Y_DOMAIN_SHRINK_LERP = 0.08;

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
  sample_count: string;
  quality_ratio: number;
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

function getTimeRangeMs(timeRange: MetricDataCardConfig['timeRange']): number {
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

function pointsEqual(a: TimeSeriesDataPoint, b: TimeSeriesDataPoint): boolean {
  return (
    a.time === b.time &&
    a.avg_value === b.avg_value &&
    a.min_value === b.min_value &&
    a.max_value === b.max_value &&
    a.sample_count === b.sample_count &&
    a.quality_ratio === b.quality_ratio
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
    ? new Date(next.data[next.data.length - 1].time).getTime()
    : Date.now();
  const cutoff = referenceEnd - getTimeRangeMs(timeRange);

  const mergedPoints = Array.from(mergedByTime.values())
    .filter((point) => new Date(point.time).getTime() >= cutoff)
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

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
  const now = useGlobalNow();
  const latestDataRef = useRef<TimeSeriesResponse | null>(null);
  const yDomainRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    latestDataRef.current = data;
  }, [data]);

  useEffect(() => {
    yDomainRef.current = null;
  }, [config.deviceUuid, config.metricName, config.timeRange]);

  const fetchData = async () => {
    try {
      if (!config.deviceUuid) {
        setError('Widget is missing device UUID. Please edit and re-save this widget.');
        setLoading(false);
        return;
      }

      const cacheTtlMs = refreshInterval > 0
        ? Math.min(Math.max(refreshInterval * 1000, 5000), 60000)
        : 15000;
      const requestKey = `${config.agentUuid || 'all'}|${config.deviceUuid}|${config.metricName}|${config.timeRange}`;

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

          return response.json();
        },
        cacheTtlMs
      );
      const { merged } = mergeTimeSeriesResponse(latestDataRef.current, result, config.timeRange);
      setData(merged);
      latestDataRef.current = merged;
      setError(null);
      setStale(false);
      setStaleReason(null);
      setLastRefreshed(new Date());
      onDataLoaded?.(merged);
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

  useEffect(() => {
    fetchData();
    
    // Auto-refresh based on global interval (0 = off)
    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [config.deviceUuid, config.metricName, config.timeRange, refreshInterval, refreshTrigger]);

  const formatTimeValue = (timeValue: number) => {
    const date = new Date(timeValue);
    const now = new Date();
    const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffHours < 24) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const formatValue = (value: number | null | undefined) => {
    if (value === null || value === undefined || isNaN(value) || !isFinite(value)) {
      return '--';
    }
    return value.toFixed(2);
  };

  const formatTimeLabel = (timeValue: number) => formatTimeValue(timeValue);

  const timeRangeMs = useMemo(() => getTimeRangeMs(config.timeRange), [config.timeRange]);
  const rawData = useMemo(() => data?.data ?? [], [data]);

  const baseChartData = useMemo(() => {
    return rawData.map((point) => {
      const timeValue = new Date(point.time).getTime();
      return {
        time: timeValue,
        timeValue,
        timeLabel: formatTimeLabel(timeValue),
        value: point.avg_value,
        min: point.min_value,
        max: point.max_value,
      };
    });
  }, [rawData]);

  const dedupedChartData = useMemo(() => {
    const pointByTime = new Map<number, (typeof baseChartData)[number]>();
    for (const point of baseChartData) {
      pointByTime.set(point.timeValue, point);
    }

    const points = Array.from(pointByTime.values());

    let isSorted = true;
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].timeValue < points[i - 1].timeValue) {
        isSorted = false;
        break;
      }
    }

    return isSorted ? points : points.sort((a, b) => a.timeValue - b.timeValue);
  }, [baseChartData]);

  const visibleChartData = useMemo(() => {
    if (dedupedChartData.length === 0) {
      return dedupedChartData;
    }

    const visibleWindowStart = now - VISUAL_DRIFT_MS - timeRangeMs;
    return dedupedChartData.filter((point) => point.timeValue >= visibleWindowStart);
  }, [dedupedChartData, now, timeRangeMs]);

  const chartDataWithGaps = useMemo(() => {
    if (visibleChartData.length === 0) {
      return [] as ReturnType<typeof detectGaps>;
    }

    return detectGaps(visibleChartData);
  }, [visibleChartData]);

  const chartDataWithBreaks = useMemo(() => {
    if (chartDataWithGaps.length === 0) {
      return [] as Array<(typeof chartDataWithGaps)[number] & { value: number | null; isGapBreak?: boolean }>;
    }

    const result: Array<(typeof chartDataWithGaps)[number] & { value: number | null; isGapBreak?: boolean }> = [];

    for (let i = 0; i < chartDataWithGaps.length; i += 1) {
      const point = chartDataWithGaps[i] as (typeof chartDataWithGaps)[number] & { value: number | null };

      if (i > 0 && point.isGap) {
        // Insert a null point just before the resumed point to force a hard line/area break.
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
  }, [chartDataWithGaps]);

  const chartState = useMemo(() => {
    if (!data || chartDataWithBreaks.length === 0) {
      return null;
    }

    const gapTimes = chartDataWithGaps
      .filter((point) => point.isGap)
      .map((point) => point.timeValue)
      .slice(-MAX_VISIBLE_GAP_LINES);

    const dataValues = chartDataWithBreaks
      .map((point) => point.value)
      .filter((value): value is number => Number.isFinite(value));

    const yDomain: [number, number] = (() => {
      let domainMin = 0;
      let domainMax = 100;

      if (dataValues.length > 0) {
        const dataMin = Math.min(...dataValues);
        const dataMax = Math.max(...dataValues);

        domainMin = dataMin;
        domainMax = dataMax;

        if (config.thresholdsEnabled && config.thresholds && config.thresholds.length > 0) {
          const thresholdValues = config.thresholds.map((threshold) => threshold.value);
          domainMin = Math.min(dataMin, ...thresholdValues);
          domainMax = Math.max(dataMax, ...thresholdValues);
        }

        const range = domainMax - domainMin;
        const padding = range > 0 ? range * 0.1 : Math.max(Math.abs(domainMax) * 0.1, 1);
        domainMin -= padding;
        domainMax += padding;
      }

      const previousDomain = yDomainRef.current;
      if (!previousDomain) {
        const initialDomain: [number, number] = [domainMin, domainMax];
        yDomainRef.current = initialDomain;
        return initialDomain;
      }

      const [prevMin, prevMax] = previousDomain;
      const stabilizedMin = domainMin < prevMin
        ? domainMin
        : prevMin + (domainMin - prevMin) * Y_DOMAIN_SHRINK_LERP;
      const stabilizedMax = domainMax > prevMax
        ? domainMax
        : prevMax + (domainMax - prevMax) * Y_DOMAIN_SHRINK_LERP;
      const stabilizedDomain: [number, number] = [stabilizedMin, stabilizedMax];

      yDomainRef.current = stabilizedDomain;
      return stabilizedDomain;
    })();

    const domainEnd = now - VISUAL_DRIFT_MS;
    const xDomain: [number, number] = [domainEnd - timeRangeMs, domainEnd];

    return {
      chartDataWithGaps: chartDataWithBreaks,
      gapTimes,
      yDomain,
      xDomain,
    };
  }, [chartDataWithBreaks, chartDataWithGaps, config.thresholds, config.thresholdsEnabled, data, now, timeRangeMs]);

  const calculateStats = () => {
    if (!data || data.data.length === 0) return null;

    const values = data.data.map(d => d.avg_value);
    const current = values[values.length - 1];
    const previous = values[values.length - 2];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((a, b) => a + b, 0) / values.length;

    const change = previous ? ((current - previous) / previous) * 100 : 0;
    const trend = change > 0 ? 'up' : change < 0 ? 'down' : 'stable';

    return { current, min, max, avg, change, trend };
  };

  const renderChart = () => {
    const currentData = data;

    if (!chartState || !currentData) return null;

    const { chartDataWithGaps, gapTimes, yDomain, xDomain } = chartState;
    const lastDataTime = chartDataWithGaps.length > 0
      ? chartDataWithGaps[chartDataWithGaps.length - 1].timeValue
      : null;
    const unit = currentData.metric.unit ?? '';

    const formatTooltipMetricValue = (value: number | null) => {
      if (value === null || !Number.isFinite(value)) {
        return ['No data', 'Value'];
      }
      return [formatValue(value) + (unit ? ` ${unit}` : ''), 'Value'];
    };

    const commonProps = {
      data: chartDataWithGaps,
      margin: { top: 5, right: 10, left: 24, bottom: 5 },
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
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={yDomain}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.8)', 
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white'
                }}
                labelFormatter={(label: number) => formatTimeValue(label)}
                formatter={(value: number | null) =>
                  formatTooltipMetricValue(value)
                }
              />
              <Area 
                yAxisId="left"
                type="linear" 
                dataKey="value" 
                stroke={color} 
                fill={color}
                fillOpacity={0.3}
                connectNulls={false}
                isAnimationActive={false}
                animationBegin={0}
                animationDuration={350}
                animationEasing="linear"
              />
              {gapTimes.map((gapTime, idx) => (
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
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={yDomain}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.8)', 
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white'
                }}
                labelFormatter={(label: number) => formatTimeValue(label)}
                formatter={(value: number | null) =>
                  formatTooltipMetricValue(value)
                }
              />
              <Bar 
                yAxisId="left"
                dataKey="value" 
                fill={color}
                isAnimationActive={false}
                animationBegin={0}
                animationDuration={350}
                animationEasing="linear"
              />
              {gapTimes.map((gapTime, idx) => (
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
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={yDomain}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.8)', 
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white'
                }}
                labelFormatter={(label: number) => formatTimeValue(label)}
                formatter={(value: number | null) =>
                  formatTooltipMetricValue(value)
                }
              />
              <Line 
                yAxisId="left"
                type="linear" 
                dataKey="value" 
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
                animationBegin={0}
                animationDuration={350}
                animationEasing="linear"
              />
              {gapTimes.map((gapTime, idx) => (
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

  const stats = calculateStats();
  const hasData = Boolean(data && data.data.length > 0);
  const staleAgeLabel = lastRefreshed
    ? `${Math.max(1, Math.floor((now - lastRefreshed.getTime()) / 60000))}m ago`
    : null;

  return (
    <div className="h-full flex flex-col">
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
                    {stats.trend === 'up' && <TrendingUp className="h-4 w-4 text-green-500" />}
                    {stats.trend === 'down' && <TrendingDown className="h-4 w-4 text-red-500" />}
                    {stats.trend === 'stable' && <Minus className="h-4 w-4 text-gray-500" />}
                  </div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Average</div>
                  <div className="text-lg font-bold">{formatValue(stats.avg)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Minimum</div>
                  <div className="text-lg font-bold text-blue-600">{formatValue(stats.min)}</div>
                </div>
                <div className="bg-muted/50 rounded-lg p-3 border">
                  <div className="text-xs text-muted-foreground mb-1">Maximum</div>
                  <div className="text-lg font-bold text-red-600">{formatValue(stats.max)}</div>
                </div>
              </div>
            )}

            <div className="flex-1">
              {renderChart()}
            </div>

            <div className="flex items-center justify-between text-xs text-muted-foreground mt-2">
              <span>{data.metadata.sampleCount} points • {data.metadata.aggregationLevel} aggregation</span>
              <div className="flex items-center gap-3">
                <div
                  className="flex items-center gap-1 text-xs"
                  style={{ color: refreshInterval > 0 ? (stale ? '#f59e0b' : '#22c55e') : '#9ca3af' }}
                >
                  <span
                    className="relative inline-flex h-2.5 w-2.5 shrink-0"
                    aria-hidden="true"
                  >
                    {refreshInterval > 0 && !stale && (
                      <span
                        className="absolute inline-flex h-full w-full rounded-full animate-ping opacity-75"
                        style={{ backgroundColor: '#22c55e' }}
                      />
                    )}
                    <span
                      className="relative inline-flex h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: refreshInterval > 0 ? (stale ? '#f59e0b' : '#22c55e') : '#9ca3af' }}
                    />
                  </span>
                  {refreshInterval > 0 ? (stale ? 'Stale' : 'Live') : 'Paused'}
                </div>
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
