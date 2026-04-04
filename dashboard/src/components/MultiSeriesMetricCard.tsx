import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { buildApiUrl } from '@/config/api';
import { metricsRequestQueue } from '@/utils/metricsRequestQueue';

const DEFAULT_SERIES_COLORS = [
  '#2563eb',
  '#dc2626',
  '#059669',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
];

type MetricTimeRange = '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d';

export interface MultiSeriesMetricDefinition {
  metricName: string;
  color?: string;
}

export interface MultiSeriesMetricCardConfig {
  widgetId: string;
  title?: string;
  agentUuid?: string;
  agentName?: string;
  endpointName?: string;
  deviceUuid: string;
  endpointUuid?: string;
  deviceName: string;
  metrics: MultiSeriesMetricDefinition[];
  timeRange: MetricTimeRange;
  chartType: 'line' | 'area';
  showLegend?: boolean;
}

interface MultiSeriesMetricCardProps {
  config: MultiSeriesMetricCardConfig;
  refreshInterval?: number;
  refreshTrigger?: number;
  onDataLoaded?: (data: MultiSeriesMetricCardData | null) => void;
}

interface TimeSeriesDataPoint {
  time: string;
  avg_value: number;
}

interface TimeSeriesResponse {
  metric: {
    deviceName: string;
    metricName: string;
    unit?: string;
    protocol?: string;
  };
  data: TimeSeriesDataPoint[];
}

interface MultiSeriesMetricCardData {
  series: Array<{
    metricName: string;
    color: string;
    unit?: string;
    protocol?: string;
    latestValue?: number;
    response: TimeSeriesResponse;
  }>;
}

interface ChartPoint {
  timeValue: number;
  timeLabel: string;
  values: Record<string, number>;
}

function formatMetricValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return 'No data';
  }

  if (Math.abs(value) >= 1000000) {
    return `${(value / 1000000).toFixed(2)}M`;
  }

  if (Math.abs(value) >= 1000) {
    return `${(value / 1000).toFixed(2)}k`;
  }

  return value.toFixed(2);
}

function formatChartTime(timeValue: number, timeRange: MetricTimeRange): string {
  const date = new Date(timeValue);
  if (timeRange === '7d' || timeRange === '30d') {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getDefaultSeriesColor(index: number): string {
  return DEFAULT_SERIES_COLORS[index % DEFAULT_SERIES_COLORS.length];
}

export function MultiSeriesMetricCard({
  config,
  refreshInterval = 30,
  refreshTrigger,
  onDataLoaded,
}: MultiSeriesMetricCardProps) {
  const [seriesData, setSeriesData] = useState<MultiSeriesMetricCardData['series']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const metricsKey = useMemo(
    () => config.metrics.map((metric) => metric.metricName).join('|'),
    [config.metrics],
  );

  useEffect(() => {
    let cancelled = false;

    const fetchData = async () => {
      if (!config.deviceUuid || config.metrics.length === 0) {
        if (!cancelled) {
          setSeriesData([]);
          setLoading(false);
          setError('Widget is missing metric configuration.');
          onDataLoaded?.(null);
        }
        return;
      }

      try {
        if (!cancelled) {
          setLoading(true);
          setError(null);
        }

        const token = localStorage.getItem('accessToken');
        const cacheTtlMs = refreshInterval > 0
          ? Math.min(Math.max(refreshInterval * 1000, 5000), 60000)
          : 15000;

        const responses = await Promise.all(
          config.metrics.map(async (metric, index) => {
            const params = new URLSearchParams({
              metricName: metric.metricName,
              timeRange: config.timeRange,
              deviceUuid: config.deviceUuid,
            });
            if (config.agentUuid) {
              params.set('agentUuid', config.agentUuid);
            }

            const requestKey = `${config.agentUuid || 'all'}|${config.deviceUuid}|${metric.metricName}|${config.timeRange}`;
            const response = await metricsRequestQueue.enqueue(
              requestKey,
              async () => {
                const apiUrl = buildApiUrl(`/api/v1/metrics/timeseries?${params.toString()}`);
                const result = await fetch(apiUrl, {
                  headers: {
                    Authorization: `Bearer ${token}`,
                  },
                });

                if (!result.ok) {
                  throw new Error(`Failed to fetch ${metric.metricName}: ${result.statusText}`);
                }

                return result.json() as Promise<TimeSeriesResponse>;
              },
              cacheTtlMs,
            );

            return {
              metricName: metric.metricName,
              color: metric.color || getDefaultSeriesColor(index),
              unit: response.metric.unit,
              protocol: response.metric.protocol,
              latestValue: response.data.at(-1)?.avg_value,
              response,
            };
          }),
        );

        if (!cancelled) {
          setSeriesData(responses);
          setLoading(false);
          onDataLoaded?.({ series: responses });
        }
      } catch (fetchError) {
        if (!cancelled) {
          setLoading(false);
          setError(fetchError instanceof Error ? fetchError.message : 'Failed to fetch metric data');
        }
      }
    };

    void fetchData();

    if (refreshInterval > 0) {
      const intervalId = window.setInterval(() => {
        void fetchData();
      }, refreshInterval * 1000);

      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [config.agentUuid, config.deviceUuid, config.metrics, config.timeRange, metricsKey, onDataLoaded, refreshInterval, refreshTrigger, retryNonce]);

  const chartData = useMemo(() => {
    const points = new Map<number, ChartPoint>();

    for (const series of seriesData) {
      for (const point of series.response.data) {
        const timeValue = Date.parse(point.time);
        const existing = points.get(timeValue);

        if (existing) {
          existing.values[series.metricName] = point.avg_value;
          continue;
        }

        points.set(timeValue, {
          timeValue,
          timeLabel: formatChartTime(timeValue, config.timeRange),
          values: {
            [series.metricName]: point.avg_value,
          },
        });
      }
    }

    return Array.from(points.values())
      .sort((left, right) => left.timeValue - right.timeValue)
      .map((point) => ({
        timeValue: point.timeValue,
        timeLabel: point.timeLabel,
        ...point.values,
      }));
  }, [config.timeRange, seriesData]);

  if (loading && seriesData.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading...</div>;
  }

  if (error && seriesData.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <div className="text-sm text-destructive">{error}</div>
        <Button size="sm" variant="outline" onClick={() => setRetryNonce((current) => current + 1)}>
          Retry
        </Button>
      </div>
    );
  }

  if (seriesData.length === 0 || chartData.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">No data available</div>;
  }

  const ChartComponent = config.chartType === 'area' ? AreaChart : LineChart;

  return (
    <div className="flex h-full flex-col gap-4">
      {config.showLegend !== false && (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {seriesData.map((series) => (
            <div key={series.metricName} className="rounded-md border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                    style={{ backgroundColor: series.color }}
                  />
                  <span className="truncate text-sm font-medium">{series.metricName}</span>
                </div>
                {series.protocol && <Badge variant="outline">{series.protocol}</Badge>}
              </div>
              <div className="text-2xl font-semibold">
                {formatMetricValue(series.latestValue)}
                {series.unit && series.unit.toLowerCase() !== 'count' && (
                  <span className="ml-2 text-sm font-normal text-muted-foreground">{series.unit}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%" minHeight={280}>
          <ChartComponent data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
            {config.showLegend !== false && (
              <Legend
                verticalAlign="top"
                height={36}
                wrapperStyle={{ fontSize: '12px', paddingBottom: '8px' }}
              />
            )}
            <XAxis
              dataKey="timeValue"
              tickFormatter={(value: number) => formatChartTime(value, config.timeRange)}
              type="number"
              domain={['dataMin', 'dataMax']}
              tick={{ fontSize: 12 }}
            />
            <YAxis tick={{ fontSize: 12 }} width={48} />
            <Tooltip
              labelFormatter={(value) => new Date(value).toLocaleString()}
              formatter={(value: number | string | null, name: string) => {
                const matchedSeries = seriesData.find((series) => series.metricName === name);
                const unitSuffix = matchedSeries?.unit && matchedSeries.unit.toLowerCase() !== 'count'
                  ? ` ${matchedSeries.unit}`
                  : '';
                return [typeof value === 'number' ? `${formatMetricValue(value)}${unitSuffix}` : value, name];
              }}
            />
            {seriesData.map((series) => (
              config.chartType === 'area' ? (
                <Area
                  key={series.metricName}
                  type="monotone"
                  dataKey={series.metricName}
                  stroke={series.color}
                  fill={series.color}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              ) : (
                <Line
                  key={series.metricName}
                  type="monotone"
                  dataKey={series.metricName}
                  stroke={series.color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              )
            ))}
          </ChartComponent>
        </ResponsiveContainer>
      </div>
    </div>
  );
}