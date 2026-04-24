/**
 * Generic Endpoints Visualization Dashboard
 * 
 * Dynamically discovers and displays ALL metrics from ANY protocol
 * No hardcoded metric names - fully data-driven from TimescaleDB
 */

import { useState, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Badge } from '../components/ui/badge';

interface Metadata {
  devices: Array<{
    uuid: string;
    device_name: string;
    status: 'online' | 'degraded' | 'offline';
    metric_count: number;
  }>;
  metrics: Array<{
    metric_name: string;
    protocol: string;
    device_count: number;
    sample_value: number;
  }>;
  protocols: Array<{
    protocol: string;
    device_count: number;
  }>;
}

interface TimeSeriesDataPoint {
  bucket: string;
  device_uuid: string;
  metric_name: string;
  value: number;
}

export function EndpointsVisualizationPage() {
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [selectedDevices, setSelectedDevices] = useState<string[]>([]);
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>([]);
  const [selectedProtocol, setSelectedProtocol] = useState<string>('all');
  const [timeRange, setTimeRange] = useState('24h');
  const [aggregation, setAggregation] = useState('avg');
  const [chartData, setChartData] = useState<any[]>([]);
  const [currentValues, setCurrentValues] = useState<any[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Fetch metadata on mount (discover what's available)
  useEffect(() => {
    fetchMetadata();
  }, []);

  // Fetch data when filters change
  useEffect(() => {
    if (metadata) {
      fetchData();
    }
  }, [selectedDevices, selectedMetrics, selectedProtocol, timeRange, aggregation, metadata]);

  const fetchMetadata = async () => {
    try {
      const res = await fetch('/api/v1/endpoints/metadata');
      if (!res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await res.json();
          throw new Error(`HTTP ${res.status}: ${errorData.error || res.statusText}`);
        } else {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${res.statusText}. Response: ${text.substring(0, 200)}`);
        }
      }
      const data = await res.json();
      setMetadata(data);
      
      // Auto-select first device and its metrics (if any)
      if (data.devices.length > 0) {
        setSelectedDevices([data.devices[0].uuid]);
      }
      if (data.metrics.length > 0) {
        // Select first 3 metrics by default
        setSelectedMetrics(data.metrics.slice(0, 3).map((m: any) => m.metric_name));
      }
    } catch (error) {
      console.error('Failed to fetch metadata:', error);
      alert(`Failed to load metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const fetchData = async () => {
    setLoading(true);
    try {
      // Build query params
      const params = new URLSearchParams({
        timeRange,
        aggregation
      });
      
      if (selectedDevices.length > 0) {
        params.append('devices', selectedDevices.join(','));
      }
      if (selectedMetrics.length > 0) {
        params.append('metrics', selectedMetrics.join(','));
      }

      // Fetch time-series data
      const [timeseriesRes, currentRes, statsRes] = await Promise.all([
        fetch(`/api/v1/endpoints/timeseries?${params}`),
        fetch(`/api/v1/endpoints/current?${params}`),
        fetch(`/api/v1/endpoints/statistics?timeRange=${timeRange}`)
      ]);

      // Validate responses
      for (const res of [timeseriesRes, currentRes, statsRes]) {
        if (!res.ok) {
          const contentType = res.headers.get('content-type');
          if (contentType?.includes('application/json')) {
            const errorData = await res.json();
            throw new Error(`HTTP ${res.status}: ${errorData.error || res.statusText}`);
          } else {
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }
        }
      }

      const timeseriesData = await timeseriesRes.json();
      const currentData = await currentRes.json();
      const statsData = await statsRes.json();

      // Transform time-series data for Recharts
      setChartData(transformTimeSeriesData(timeseriesData.data || []));
      setCurrentValues(currentData.data || []);
      setStats(statsData);
    } catch (error) {
      console.error('Failed to fetch data:', error);
      alert(`Failed to load data: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setLoading(false);
    }
  };

  // Transform database rows into Recharts format
  const transformTimeSeriesData = (rows: TimeSeriesDataPoint[]) => {
    const grouped: Record<string, any> = {};
    
    rows.forEach(row => {
      const time = new Date(row.bucket).getTime();
      if (!grouped[time]) {
        grouped[time] = { time };
      }
      // Create unique key for each device+metric combination
      const key = `${row.metric_name}`;
      grouped[time][key] = row.value;
    });

    return Object.values(grouped).sort((a: any, b: any) => a.time - b.time);
  };

  // Get unique data keys for chart lines (all metric names in the dataset)
  const getDataKeys = (): string[] => {
    if (chartData.length === 0) return [];
    const keys = Object.keys(chartData[0]).filter(k => k !== 'time');
    return keys;
  };

  // Generate colors dynamically
  const getColor = (index: number): string => {
    const colors = [
      '#8884d8', '#82ca9d', '#ffc658', '#ff7c7c', '#8dd1e1',
      '#a4de6c', '#d0ed57', '#ffa07a', '#20b2aa', '#778899'
    ];
    return colors[index % colors.length];
  };

  const toggleDevice = (uuid: string) => {
    setSelectedDevices(prev => 
      prev.includes(uuid) ? prev.filter(d => d !== uuid) : [...prev, uuid]
    );
  };

  const toggleMetric = (metric: string) => {
    setSelectedMetrics(prev =>
      prev.includes(metric) ? prev.filter(m => m !== metric) : [...prev, metric]
    );
  };

  if (!metadata) {
    return <div className="p-8">Loading metadata...</div>;
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Endpoints Visualization</h1>
        <button 
          onClick={fetchData}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Refresh
        </button>
      </div>

      {/* Statistics Cards */}
      {stats && (
        <div className="grid grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{stats.total_devices}</div>
              <p className="text-sm text-gray-500">Total Devices</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold text-green-600">{stats.devices_online}</div>
              <p className="text-sm text-gray-500">Online</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{stats.total_metrics}</div>
              <p className="text-sm text-gray-500">Total Metrics</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="text-2xl font-bold">{stats.total_readings?.toLocaleString()}</div>
              <p className="text-sm text-gray-500">Readings ({timeRange})</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <Card>
        <CardHeader>
          <CardTitle>Filters</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            {/* Time Range */}
            <div>
              <label className="block text-sm font-medium mb-2">Time Range</label>
              <select 
                value={timeRange} 
                onChange={(e) => setTimeRange(e.target.value)}
                className="w-full border rounded px-3 py-2"
              >
                <option value="1h">Last Hour</option>
                <option value="6h">Last 6 Hours</option>
                <option value="24h">Last 24 Hours</option>
                <option value="7d">Last 7 Days</option>
                <option value="30d">Last 30 Days</option>
              </select>
            </div>

            {/* Aggregation */}
            <div>
              <label className="block text-sm font-medium mb-2">Aggregation</label>
              <select 
                value={aggregation} 
                onChange={(e) => setAggregation(e.target.value)}
                className="w-full border rounded px-3 py-2"
              >
                <option value="avg">Average</option>
                <option value="min">Minimum</option>
                <option value="max">Maximum</option>
                <option value="last">Last Value</option>
              </select>
            </div>

            {/* Protocol Filter */}
            <div>
              <label className="block text-sm font-medium mb-2">Protocol</label>
              <select 
                value={selectedProtocol} 
                onChange={(e) => setSelectedProtocol(e.target.value)}
                className="w-full border rounded px-3 py-2"
              >
                <option value="all">All Protocols</option>
                {metadata.protocols.map(p => (
                  <option key={p.protocol} value={p.protocol}>
                    {p.protocol} ({p.device_count} devices)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Device Selection */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Devices ({selectedDevices.length} selected)
            </label>
            <div className="flex flex-wrap gap-2">
              {metadata.devices.map(device => (
                <Badge
                  key={device.uuid}
                  variant={selectedDevices.includes(device.uuid) ? 'default' : 'outline'}
                  className="cursor-pointer"
                  onClick={() => toggleDevice(device.uuid)}
                >
                  {device.device_name || device.uuid.slice(0, 8)}
                  <span className={`ml-2 w-2 h-2 rounded-full ${
                    device.status === 'online' ? 'bg-green-500' :
                    device.status === 'degraded' ? 'bg-yellow-500' : 'bg-gray-400'
                  }`} />
                </Badge>
              ))}
            </div>
          </div>

          {/* Metric Selection */}
          <div>
            <label className="block text-sm font-medium mb-2">
              Metrics ({selectedMetrics.length} selected)
            </label>
            <div className="flex flex-wrap gap-2">
              {metadata.metrics
                .filter(m => selectedProtocol === 'all' || m.protocol === selectedProtocol)
                .map(metric => (
                  <Badge
                    key={metric.metric_name}
                    variant={selectedMetrics.includes(metric.metric_name) ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleMetric(metric.metric_name)}
                  >
                    {metric.metric_name}
                    <span className="ml-1 text-xs opacity-70">({metric.protocol})</span>
                  </Badge>
                ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Time-Series Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Time-Series Data</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-96 flex items-center justify-center">Loading...</div>
          ) : chartData.length === 0 ? (
            <div className="h-96 flex items-center justify-center text-gray-500">
              No data available for selected filters
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={400}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis 
                  dataKey="time" 
                  tickFormatter={(t) => new Date(t).toLocaleTimeString()} 
                />
                <YAxis />
                <Tooltip 
                  labelFormatter={(t) => new Date(t).toLocaleString()}
                  formatter={(value: any) => [value.toFixed(2), '']}
                />
                <Legend />
                {getDataKeys().map((key, index) => (
                  <Line 
                    key={key}
                    dataKey={key}
                    stroke={getColor(index)}
                    strokeWidth={2}
                    dot={false}
                    name={key}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Current Values Grid */}
      <div className="grid grid-cols-4 gap-4">
        {currentValues.map((item, index) => (
          <Card key={`${item.device_uuid}_${item.metric_name}`}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {item.metric_name}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">
                {item.value !== null ? Number(item.value).toFixed(2) : 'N/A'}
              </div>
              <div className="flex justify-between items-center mt-2">
                <p className="text-xs text-gray-500">
                  {item.device_name || item.device_uuid.slice(0, 8)}
                </p>
                <Badge variant={
                  item.device_status === 'online' ? 'default' :
                  item.device_status === 'degraded' ? 'secondary' : 'outline'
                }>
                  {item.device_status}
                </Badge>
              </div>
              <p className="text-xs text-gray-400 mt-1">{item.protocol}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
