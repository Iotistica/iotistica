import { useState, useEffect } from 'react';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Settings, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
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
  Legend,
} from 'recharts';
import { buildApiUrl } from '@/config/api';

export interface MetricDataCardConfig {
  widgetId: string;
  title?: string;
  deviceName: string;
  metricName: string;
  chartType: 'line' | 'area' | 'bar';
  timeRange: '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d';
  color?: string;
  showStats?: boolean;
}

interface MetricDataCardProps {
  config: MetricDataCardConfig;
  refreshInterval?: number; // in seconds, 0 = off
  onConfigure?: () => void;
  onRefresh?: () => void;
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

export function MetricDataCard({ config, refreshInterval = 30, onConfigure, onRefresh, onDataLoaded }: MetricDataCardProps) {
  const [data, setData] = useState<TimeSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = async () => {
    try {
      setRefreshing(true);
      const url = buildApiUrl(
        `/api/v1/metrics/timeseries?deviceName=${encodeURIComponent(config.deviceName)}&metricName=${encodeURIComponent(config.metricName)}&timeRange=${config.timeRange}`
      );

      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const result: TimeSeriesResponse = await response.json();
      setData(result);
      setError(null);
      onDataLoaded?.(result);
    } catch (err: any) {
      console.error('Error fetching metric data:', err);
      setError(err.message || 'Failed to fetch data');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
    
    // Auto-refresh based on global interval (0 = off)
    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [config.deviceName, config.metricName, config.timeRange, refreshInterval]);

  const formatTime = (timeStr: string) => {
    const date = new Date(timeStr);
    const now = new Date();
    const diffHours = (now.getTime() - date.getTime()) / (1000 * 60 * 60);

    if (diffHours < 24) {
      return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  };

  const formatValue = (value: number) => {
    return value.toFixed(2);
  };

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
    if (!data || data.data.length === 0) return null;

    const chartData = data.data.map(point => ({
      time: formatTime(point.time),
      value: point.avg_value,
      min: point.min_value,
      max: point.max_value,
    }));

    const commonProps = {
      data: chartData,
      margin: { top: 5, right: 10, left: 0, bottom: 5 },
    };

    const color = config.color || '#3b82f6'; // Use config color or default blue-500

    switch (config.chartType) {
      case 'area':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart {...commonProps}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis 
                dataKey="time" 
                fontSize={12}
                tickLine={false}
              />
              <YAxis 
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}
                domain={['auto', 'auto']}
                padding={{ top: 20, bottom: 20 }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.8)', 
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white'
                }}
                formatter={(value: number) => [formatValue(value) + (data.metric.unit ? ` ${data.metric.unit}` : ''), 'Value']}
              />
              <Area 
                type="monotone" 
                dataKey="value" 
                stroke={color} 
                fill={color}
                fillOpacity={0.3}
              />
            </AreaChart>
          </ResponsiveContainer>
        );

      case 'bar':
        return (
          <ResponsiveContainer width="100%" height={200}>
            <BarChart {...commonProps}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis 
                dataKey="time" 
                fontSize={12}
                tickLine={false}
              />
              <YAxis 
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}                domain={['auto', 'auto']}
                padding={{ top: 20, bottom: 20 }}                domain={['auto', 'auto']}
                padding={{ top: 20, bottom: 20 }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.8)', 
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white'
                }}
                formatter={(value: number) => [formatValue(value) + (data.metric.unit ? ` ${data.metric.unit}` : ''), 'Value']}
              />
              <Bar 
                dataKey="value" 
                fill={color}
              />
            </BarChart>
          </ResponsiveContainer>
        );

      default: // line
        return (
          <ResponsiveContainer width="100%" height={200}>
            <LineChart {...commonProps}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis 
                dataKey="time" 
                fontSize={12}
                tickLine={false}
              />
              <YAxis 
                fontSize={12}
                tickLine={false}
                tickFormatter={formatValue}                domain={['auto', 'auto']}
                padding={{ top: 20, bottom: 20 }}                domain={['auto', 'auto']}
                padding={{ top: 20, bottom: 20 }}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: 'rgba(0, 0, 0, 0.8)', 
                  border: 'none',
                  borderRadius: '4px',
                  color: 'white'
                }}
                formatter={(value: number) => [formatValue(value) + (data.metric.unit ? ` ${data.metric.unit}` : ''), 'Value']}
              />
              <Line 
                type="monotone" 
                dataKey="value" 
                stroke={color}
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        );
    }
  };

  const stats = calculateStats();

  // Export badges and controls for parent to render
  const renderBadges = () => {
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
  };

  return (
    <div className="h-full flex flex-col">
        {loading && !data ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">Loading...</div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-destructive">{error}</div>
          </div>
        ) : !data || data.data.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-muted-foreground">No data available</div>
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

            <div className="text-xs text-muted-foreground mt-2 text-center">
              {data.metadata.sampleCount} points • {data.metadata.aggregationLevel} aggregation
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
