import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
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
  onConfigure?: () => void;
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

export function MetricDataCard({ config, onConfigure }: MetricDataCardProps) {
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
    
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [config.deviceName, config.metricName, config.timeRange]);

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
                tickFormatter={formatValue}
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
                tickFormatter={formatValue}
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

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="flex-none pb-3">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-base font-medium">
              {config.title || `${config.metricName} - ${config.deviceName}`}
            </CardTitle>
            {data && (
              <div className="flex items-center gap-2 mt-1">
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
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={fetchData}
              disabled={refreshing}
              className="h-8 w-8 p-0"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
            {onConfigure && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onConfigure}
                className="h-8 w-8 p-0"
              >
                <Settings className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col">
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
      </CardContent>
    </Card>
  );
}
