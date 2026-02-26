import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Loader2, Calendar, TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { SeverityBadge, StatusBadge, ScoreBadge } from '@/components/alerts';
import { buildApiUrl } from '@/config/api';

interface AnomalyEvent {
  msg_id: string;
  agent_uuid: string;
  device_name: string;
  device_type: string;
  metric: string;
  timestamp_ms: number;
  observed_value: number;
  baseline: { mean: number; median: number; stdDev: number };
  anomaly_score: number;
  confidence: number;
  severity: 'info' | 'warning' | 'critical';
  deviation: number;
  triggered_by: string[];
  expected_range: [number, number];
}

interface Incident {
  incident_id: string;
  device_name: string;
  device_uuid?: string;
  device_type: string;
  metric: string;
  severity: 'info' | 'warning' | 'critical';
  first_seen: number | null;
  last_seen: number | null;
  max_anomaly_score: number;
  max_confidence: number;
  event_count: number;
  status: 'open' | 'active' | 'resolved';
  resolution_notes?: string;
}

interface TimeSeriesDataPoint {
  time: string;
  avg_value: number;
  min_value: number;
  max_value: number;
  sample_count: string;
  quality_ratio: number;
}

interface MetricHistory {
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

interface SystemMetric {
  time: string;
  value: number;
}

interface IncidentDetailsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  incident: Incident & { events?: AnomalyEvent[] };
  onResolve: () => void;
}

// System metrics that use /api/v1/devices/{uuid}/metrics endpoint
const SYSTEM_METRICS = ['cpu_usage', 'memory_percent', 'disk_usage', 'network_rx', 'network_tx', 'cpu_temp'];

export function IncidentDetailsModal({
  open,
  onOpenChange,
  incident,
  onResolve,
}: IncidentDetailsModalProps) {
  const [metricData, setMetricData] = useState<TimeSeriesDataPoint[] | SystemMetric[] | null>(null);
  const [metricLoading, setMetricLoading] = useState(false);
  const [metricError, setMetricError] = useState<string | null>(null);
  const [unit, setUnit] = useState('');
  const [activeTab, setActiveTab] = useState<'details' | 'history' | 'events'>('details');
  const [events, setEvents] = useState<AnomalyEvent[]>([]);

  const formatTime = (ms: number | null | undefined) => {
    if (!ms || isNaN(ms)) return 'N/A';
    return new Date(ms).toLocaleString();
  };

  const isSystemMetric = SYSTEM_METRICS.includes(incident.metric);

  const calculatePeriod = () => {
    if (!incident.first_seen || !incident.last_seen) return '24h';
    const durationMs = incident.last_seen - incident.first_seen;
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours < 1) return '1h';
    if (durationHours < 6) return '6h';
    if (durationHours < 12) return '12h';
    return '24h';
  };

  const fetchMetricHistory = async () => {
    setMetricLoading(true);
    setMetricError(null);
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('accessToken');

      if (isSystemMetric) {
        // Fetch system metrics using /api/v1/devices/{uuid}/metrics endpoint
        if (!incident.device_uuid) {
          throw new Error('Device UUID not available for system metrics');
        }
        const period = calculatePeriod();
        const response = await fetch(
          buildApiUrl(`/api/v1/devices/${incident.device_uuid}/metrics?period=${period}`),
          {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch system metrics: ${response.statusText}`);
        }

        const data = await response.json();
        // Extract the specific metric from the response
        const formatted = data.metrics?.map((m: any) => ({
          time: new Date(m.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          value: m[incident.metric] || 0,
        })) || [];

        setMetricData(formatted);
        setUnit('%'); // Most system metrics are percentages
      } else {
        // Fetch endpoint metrics using /api/v1/metrics/timeseries endpoint
        const timeRange = calculatePeriod() as any;
        const response = await fetch(
          buildApiUrl(
            `/api/v1/metrics/timeseries?deviceName=${encodeURIComponent(incident.device_name)}&metricName=${encodeURIComponent(incident.metric)}&timeRange=${timeRange}`
          ),
          {
            headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch metric data: ${response.statusText}`);
        }

        const data: MetricHistory = await response.json();
        setMetricData(data.data);
        setUnit(data.metric.unit || '');
      }
    } catch (error) {
      console.error('Error fetching metric history:', error);
      setMetricError(error instanceof Error ? error.message : 'Failed to fetch metric history');
    } finally {
      setMetricLoading(false);
    }
  };

  const fetchEvents = async () => {
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('accessToken');
      const response = await fetch(
        buildApiUrl(`/api/v1/anomaly-incidents/${incident.incident_id}`),
        {
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch incident events');
      }

      const data = await response.json();
      setEvents(data.events || []);
    } catch (error) {
      console.error('Error fetching events:', error);
    }
  };

  useEffect(() => {
    if (open && incident) {
      setActiveTab('details');
      fetchMetricHistory();
      if (!incident.events || incident.events.length === 0) {
        fetchEvents();
      } else {
        setEvents(incident.events);
      }
    }
  }, [open, incident]);

  const renderChart = () => {
    if (!metricData || metricData.length === 0) {
      return <div className="text-center text-gray-500 py-4">No data available</div>;
    }

    return (
      <div className="w-full flex justify-center">
        <div className="w-full max-w-2xl">
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={metricData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tick={{ fontSize: 12 }}
                angle={-45}
                textAnchor="end"
                height={80}
              />
              <YAxis />
              <Tooltip
                formatter={(value: any) => {
                  if (typeof value === 'number') {
                    return value.toFixed(2) + (unit ? ` ${unit}` : '');
                  }
                  if (typeof value === 'object' && 'avg_value' in value) {
                    return (value as any).avg_value.toFixed(2);
                  }
                  return value;
                }}
              />
              <Line
                type="monotone"
                dataKey={isSystemMetric ? 'value' : 'avg_value'}
                stroke="#3b82f6"
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[95vh]">
        <DialogHeader>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <SeverityBadge severity={incident.severity} />
              <DialogTitle>{incident.device_name}</DialogTitle>
              <Badge variant="outline">{incident.device_type}</Badge>
            </div>
            <StatusBadge status={incident.status} />
          </div>
          <DialogDescription>
            Metric: <span className="font-semibold">{incident.metric}</span>
          </DialogDescription>
        </DialogHeader>

        {/* Simple Tab Buttons */}
        <div className="flex gap-2 border-b">
          <Button
            variant={activeTab === 'details' ? 'default' : 'ghost'}
            onClick={() => setActiveTab('details')}
            className="rounded-none"
          >
            Details
          </Button>
          <Button
            variant={activeTab === 'history' ? 'default' : 'ghost'}
            onClick={() => setActiveTab('history')}
            className="rounded-none"
          >
            History
          </Button>
          <Button
            variant={activeTab === 'events' ? 'default' : 'ghost'}
            onClick={() => setActiveTab('events')}
            className="rounded-none"
          >
            Events ({incident.event_count})
          </Button>
        </div>

        {/* Details Tab */}
        {activeTab === 'details' && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <Calendar className="w-4 h-4" />
                  Incident Timeline
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">First Seen</p>
                    <p className="font-mono text-sm">{formatTime(incident.first_seen)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Last Seen</p>
                    <p className="font-mono text-sm">{formatTime(incident.last_seen)}</p>
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-4 pt-4 border-t">
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Max Anomaly Score</p>
                    <ScoreBadge score={incident.max_anomaly_score} />
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Max Confidence</p>
                    <p className="font-semibold">{(incident.max_confidence * 100).toFixed(0)}%</p>
                  </div>
                  <div>
                    <p className="text-xs text-gray-500 mb-1">Total Events</p>
                    <p className="font-semibold text-lg">{incident.event_count}</p>
                  </div>
                </div>

                {incident.resolution_notes && (
                  <div className="pt-4 border-t">
                    <p className="text-xs text-gray-500 mb-1">Resolution Notes</p>
                    <p className="text-sm">{incident.resolution_notes}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* History Tab */}
        {activeTab === 'history' && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" />
                  Trend
                </CardTitle>
              </CardHeader>
              <CardContent>
                {metricLoading ? (
                  <div className="flex justify-center items-center h-80">
                    <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
                  </div>
                ) : metricError ? (
                  <div className="flex justify-center items-center h-80">
                    <p className="text-red-500 text-sm">{metricError}</p>
                  </div>
                ) : (
                  <div className="w-full h-80">
                    {renderChart()}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}

        {/* Events Tab */}
        {activeTab === 'events' && (
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Anomaly Events</CardTitle>
              </CardHeader>
              <CardContent>
                {events && events.length > 0 ? (
                  <div className="max-h-80 overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Time</TableHead>
                          <TableHead>Value</TableHead>
                          <TableHead>Expected</TableHead>
                          <TableHead>Deviation</TableHead>
                          <TableHead>Score</TableHead>
                          <TableHead>Confidence</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {events.slice(0, 20).map((event) => (
                              <TableRow key={event.msg_id}>
                                <TableCell className="text-xs">
                                  {new Date(event.timestamp_ms).toLocaleTimeString()}
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {event.observed_value.toFixed(2)}
                                </TableCell>
                                <TableCell className="text-xs text-gray-600">
                                  [{event.expected_range[0]}, {event.expected_range[1]}]
                                </TableCell>
                                <TableCell className="text-xs">
                                  {event.deviation.toFixed(2)}σ
                                </TableCell>
                                <TableCell className="text-xs">
                                  {event.anomaly_score.toFixed(2)}
                                </TableCell>
                                <TableCell className="text-xs">
                                  {(event.confidence * 100).toFixed(0)}%
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        {events && events.length > 20 && (
                          <p className="text-xs text-gray-500 mt-2">
                            Showing 20 of {events.length} events
                          </p>
                        )}
                      </div>
                    ) : (
                      <p className="text-center text-gray-500 py-8">No events available</p>
                    )}
                  </CardContent>
                </Card>
            </div>
          )}

        <DialogFooter>
          {incident.status !== 'resolved' && (
            <Button onClick={onResolve} variant="default">
              Resolve Incident
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
