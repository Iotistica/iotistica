import React, { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Settings, TrendingUp, TrendingDown, Minus, RefreshCw } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { buildApiUrl } from '@/config/api';

export interface MetricValueCardConfig {
  widgetId: string;
  title?: string;
  deviceName: string;
  metricName: string;
  timeRange: '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d';
  showSparkline: boolean;
  warningThreshold?: number;
  criticalThreshold?: number;
}

interface MetricValueCardProps {
  config: MetricValueCardConfig;
  refreshInterval?: number;
  refreshTrigger?: number;
  onConfigure?: () => void;
  onDataLoaded?: (data: any) => void;
}

interface TimeSeriesResponse {
  data: Array<{
    time: string;
    avg_value: number;
    min_value: number;
    max_value: number;
  }>;
  metric: {
    name: string;
    unit?: string;
  };
  device_name: string;
  aggregation: string;
  time_range: string;
  data_points: number;
}

const MetricValueCard: React.FC<MetricValueCardProps> = ({
  config,
  refreshInterval = 0,
  refreshTrigger,
  onConfigure,
  onDataLoaded,
}) => {
  const [data, setData] = useState<TimeSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());

  const fetchData = async () => {
    if (!config.deviceName || !config.metricName) return;

    try {
      setIsRefreshing(true);
      setError(null);

      const token = localStorage.getItem('accessToken');
      const apiUrl = buildApiUrl(
        `/api/v1/metrics/timeseries?deviceName=${encodeURIComponent(config.deviceName)}&metricName=${encodeURIComponent(config.metricName)}&timeRange=${config.timeRange}`
      );

      const response = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.statusText}`);
      }

      const result: TimeSeriesResponse = await response.json();
      setData(result);
      setLastUpdate(new Date());
      
      if (onDataLoaded) {
        onDataLoaded(result);
      }
    } catch (err) {
      console.error('Error fetching metric data:', err);
      setError(err instanceof Error ? err.message : 'Failed to fetch data');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [config.deviceName, config.metricName, config.timeRange, refreshTrigger]);

  useEffect(() => {
    if (refreshInterval > 0) {
      const interval = setInterval(fetchData, refreshInterval * 1000);
      return () => clearInterval(interval);
    }
  }, [refreshInterval, config.deviceName, config.metricName, config.timeRange]);

  const formatValue = (value: number): string => {
    if (Math.abs(value) >= 1000000) {
      return (value / 1000000).toFixed(2) + 'M';
    }
    if (Math.abs(value) >= 1000) {
      return (value / 1000).toFixed(2) + 'k';
    }
    return value.toFixed(2);
  };

  const formatTime = (date: Date): string => {
    return date.toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit'
    });
  };

  const calculateTrend = () => {
    if (!data || data.data.length < 2) {
      return { change: 0, trend: 'stable' as const };
    }

    const firstValue = data.data[0].avg_value;
    const lastValue = data.data[data.data.length - 1].avg_value;
    const change = ((lastValue - firstValue) / firstValue) * 100;
    const trend = change > 0 ? 'up' : change < 0 ? 'down' : 'stable';

    return { change, trend };
  };

  const getThresholdColor = (value: number) => {
    if (config.criticalThreshold !== undefined && value >= config.criticalThreshold) {
      return 'text-red-600 dark:text-red-400';
    }
    if (config.warningThreshold !== undefined && value >= config.warningThreshold) {
      return 'text-yellow-600 dark:text-yellow-400';
    }
    return 'text-foreground';
  };

  const getThresholdBgColor = (value: number) => {
    if (config.criticalThreshold !== undefined && value >= config.criticalThreshold) {
      return 'bg-red-50 dark:bg-red-950/20';
    }
    if (config.warningThreshold !== undefined && value >= config.warningThreshold) {
      return 'bg-yellow-50 dark:bg-yellow-950/20';
    }
    return '';
  };

  if (loading && !data) {
    return (
      <Card className="h-full">
        <CardContent className="flex items-center justify-center h-full">
          <div className="text-sm text-muted-foreground">Loading...</div>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="h-full">
        <CardContent className="flex flex-col items-center justify-center h-full gap-2">
          <div className="text-sm text-destructive">{error}</div>
          <Button size="sm" variant="outline" onClick={fetchData}>
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!data || data.data.length === 0) {
    return (
      <Card className="h-full">
        <CardContent className="flex items-center justify-center h-full">
          <div className="text-sm text-muted-foreground">No data available</div>
        </CardContent>
      </Card>
    );
  }

  const currentValue = data.data[data.data.length - 1].avg_value;
  const { change, trend } = calculateTrend();
  const sparklineData = data.data.map(point => point.avg_value);

  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus;
  const trendColorClass = trend === 'up' ? 'text-green-600' : trend === 'down' ? 'text-red-600' : 'text-muted-foreground';

  return (
    <Card className={`h-full flex flex-col ${getThresholdBgColor(currentValue)}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <CardTitle className="text-sm truncate">
              {config.title || config.metricName}
            </CardTitle>
            <Badge variant="outline" className="text-xs whitespace-nowrap shrink-0">
              {config.deviceName}
            </Badge>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                fetchData();
              }}
            >
              <RefreshCw 
                className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                style={{ 
                  transform: isRefreshing ? undefined : 'rotate(0deg)',
                  transition: isRefreshing ? undefined : 'none'
                }}
              />
            </Button>
            {onConfigure && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 cursor-pointer hover:bg-primary/10 transition-colors"
                onClick={onConfigure}
              >
                <Settings className="w-4 h-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      
      <CardContent className="flex-1 flex flex-col justify-center pb-4">
        {/* Large Value Display */}
        <div className="text-center mb-2">
          <div className={`text-4xl font-bold ${getThresholdColor(currentValue)}`}>
            {formatValue(currentValue)}
            {data.metric.unit && (
              <span className="text-2xl ml-1 font-normal text-muted-foreground">
                {data.metric.unit}
              </span>
            )}
          </div>
        </div>

        {/* Trend Indicator */}
        <div className={`flex items-center justify-center gap-1 mb-3 ${trendColorClass}`}>
          <TrendIcon className="w-4 h-4" />
          <span className="text-sm font-medium">
            {change > 0 ? '+' : ''}{change.toFixed(1)}%
          </span>
        </div>

        {/* Sparkline */}
        {config.showSparkline && sparklineData.length > 1 && (
          <div className="h-12 mb-2">
            <ResponsiveContainer width="100%" height={48}>
              <LineChart data={sparklineData.map(value => ({ value }))}>
                <YAxis hide domain={['auto', 'auto']} />
                <Line 
                  type="monotone"
                  dataKey="value"
                  stroke={
                    config.criticalThreshold !== undefined && currentValue >= config.criticalThreshold
                      ? '#dc2626'
                      : config.warningThreshold !== undefined && currentValue >= config.warningThreshold
                      ? '#ca8a04'
                      : '#3b82f6'
                  }
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Footer Info */}
        <div className="text-xs text-muted-foreground text-center">
          {data.data_points} points • {config.timeRange} • Updated {formatTime(lastUpdate)}
        </div>
      </CardContent>
    </Card>
  );
};

export default MetricValueCard;
