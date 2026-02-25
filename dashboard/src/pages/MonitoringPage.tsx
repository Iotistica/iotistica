import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { MetricCard } from '@/components/ui/metric-card';
import { AlertTriangle, AlertOctagon, Activity, CheckCircle, Eye, ChevronLeft, ChevronRight, Loader2, Settings } from 'lucide-react';
import { SeverityBadge, StatusBadge, ScoreBadge, IncidentTimelineChart } from '@/components/alerts';
import { AnomalyMetricsTable } from '@/components/monitoring/AnomalyMetricsTable';

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

interface AnomalyAlert {
  alert_id: string;
  severity: 'info' | 'warning' | 'critical';
  device_name: string;
  metric: string;
  affected_devices: string[];
  max_anomaly_score: number;
  message: string;
  created_at: string;
}

interface Incident {
  incident_id: string;
  fingerprint: string;
  device_name: string;
  device_type: string;
  metric: string;
  severity: 'info' | 'warning' | 'critical';
  affected_devices: string[];
  affected_agents: string[];
  first_seen: number;
  last_seen: number;
  max_anomaly_score: number;
  max_confidence: number;
  event_count: number;
  status: 'open' | 'active' | 'resolved';
  acknowledged_at?: string;
  acknowledged_by?: string;
  resolution_notes?: string;
  created_at: string;
  updated_at: string;
}

interface Stats {
  total: number;
  byStatus: { open: number; active: number; resolved: number };
  bySeverity: { info: number; warning: number; critical: number };
  affectedDevices: number;
  topMetrics: { metric: string; count: number }[];
  topDevices: { deviceName: string; count: number }[];
}

interface IncidentDetails extends Incident {
  events: AnomalyEvent[];
  alerts: AnomalyAlert[];
}

const API_BASE = '/api/v1';

export function AlertsPage() {
  // State
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [deviceFilter, setDeviceFilter] = useState('all');
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');
  const [metricFilter, setMetricFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(50);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  // Modal state
  const [selectedIncident, setSelectedIncident] = useState<IncidentDetails | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [resolving, setResolving] = useState(false);

  // Device list for filters
  const [devices, setDevices] = useState<{ name: string; type: string }[]>([]);

  /**
   * Fetch statistics
   */
  const fetchStats = async () => {
    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/stats?hours=24`);
      const data = await response.json();
      if (data.success) {
        setStats(data.stats);
        // Extract unique devices for filter
        const uniqueDevices = data.stats.topDevices.map((d: any) => ({
          name: d.deviceName,
          type: '', // Will be populated from incidents
        }));
        setDevices(uniqueDevices);
      }
    } catch (error) {
      console.error('Failed to fetch stats:', error);
    }
  };

  /**
   * Fetch incidents with filters
   */
  const fetchIncidents = async (off: number = 0) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('limit', limit.toString());
      params.append('offset', off.toString());

      if (statusFilter !== 'all') params.append('status', statusFilter);
      if (severityFilter !== 'all') params.append('severity', severityFilter);
      if (deviceFilter !== 'all') params.append('deviceName', deviceFilter);
      if (deviceTypeFilter !== 'all') params.append('deviceType', deviceTypeFilter);
      if (metricFilter) params.append('metric', metricFilter);

      const response = await fetch(`${API_BASE}/anomaly-incidents?${params}`);
      const data = await response.json();

      if (data.success) {
        setIncidents(data.incidents);
        setTotal(data.total);
        setHasMore(data.hasMore);
        setOffset(off);
      }
    } catch (error) {
      console.error('Failed to fetch incidents:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Fetch incident details
   */
  const fetchIncidentDetails = async (incidentId: string) => {
    setDetailsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/${incidentId}`);
      const data = await response.json();

      if (data.success) {
        setSelectedIncident(data.incident);
        setDetailsOpen(true);
        setResolutionNotes(data.incident?.resolution_notes || '');
      }
    } catch (error) {
      console.error('Failed to fetch incident details:', error);
    } finally {
      setDetailsLoading(false);
    }
  };

  /**
   * Resolve incident
   */
  const resolveIncident = async () => {
    if (!selectedIncident) return;

    setResolving(true);
    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/${selectedIncident.incident_id}/resolve`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resolvedBy: 'user', // TODO: Get from auth context
          notes: resolutionNotes,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setSelectedIncident(data.incident);
        // Refresh incidents list
        await fetchIncidents(offset);
        await fetchStats();
      }
    } catch (error) {
      console.error('Failed to resolve incident:', error);
    } finally {
      setResolving(false);
    }
  };

  /**
   * Apply filters
   */
  const applyFilters = async () => {
    setOffset(0);
    await fetchIncidents(0);
  };

  /**
   * Clear filters
   */
  const clearFilters = async () => {
    setStatusFilter('all');
    setSeverityFilter('all');
    setDeviceFilter('all');
    setDeviceTypeFilter('all');
    setMetricFilter('');
    setOffset(0);
    await fetchIncidents(0);
  };

  // Initialize on mount
  useEffect(() => {
    fetchStats();
    fetchIncidents(0);

    // Auto-refresh every 30 seconds
    const interval = setInterval(() => {
      fetchStats();
      fetchIncidents(offset);
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // Format timestamp
  const formatTime = (ms: number) => {
    return new Date(ms).toLocaleString();
  };

  // Create metrics array
  const metrics = [
    {
      icon: AlertTriangle,
      label: "Open Incidents",
      value: stats?.byStatus.open.toString() || "0",
      subtitle: stats ? `${stats.total} total` : "Loading...",
      iconColor: "orange" as const,
    },
    {
      icon: AlertOctagon,
      label: "Critical Alerts",
      value: stats?.bySeverity.critical.toString() || "0",
      subtitle: stats ? `${stats.bySeverity.warning} warnings` : "Loading...",
      iconColor: "red" as const,
    },
    {
      icon: Activity,
      label: "Affected Devices",
      value: stats?.affectedDevices.toString() || "0",
      subtitle: stats ? `${stats.topDevices.length} unique` : "Loading...",
      iconColor: "blue" as const,
    },
    {
      icon: CheckCircle,
      label: "Resolved Today",
      value: stats?.byStatus.resolved.toString() || "0",
      subtitle: stats ? `${((stats.byStatus.resolved / stats.total) * 100).toFixed(0)}% of total` : "Loading...",
      iconColor: "green" as const,
    },
  ];

  return (
    <div className="w-full space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">Monitoring</h1>
        <p className="text-gray-600 mt-1">Monitor and manage anomaly detection incidents</p>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.map((metric, index) => (
          <MetricCard
            key={index}
            icon={metric.icon}
            label={metric.label}
            value={metric.value}
            subtitle={metric.subtitle}
            iconColor={metric.iconColor}
          />
        ))}
      </div>

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-4">
        <div>
          <Label className="text-sm font-medium">Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-48 mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-sm font-medium">Severity</Label>
          <Select value={severityFilter} onValueChange={setSeverityFilter}>
            <SelectTrigger className="w-48 mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Severity</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
              <SelectItem value="warning">Warning</SelectItem>
              <SelectItem value="info">Info</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-sm font-medium">Device</Label>
          <Select value={deviceFilter} onValueChange={setDeviceFilter}>
            <SelectTrigger className="w-48 mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Devices</SelectItem>
              {devices.map((d) => (
                <SelectItem key={d.name} value={d.name}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-sm font-medium">Device Type</Label>
          <Select value={deviceTypeFilter} onValueChange={setDeviceTypeFilter}>
            <SelectTrigger className="w-48 mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="modbus">Modbus</SelectItem>
              <SelectItem value="opcua">OPC-UA</SelectItem>
              <SelectItem value="bacnet">BACnet</SelectItem>
              <SelectItem value="mqtt-sensor">MQTT Sensor</SelectItem>
              <SelectItem value="agent-system">Agent System</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label className="text-sm font-medium">Metric</Label>
          <Input
            placeholder="Filter metric..."
            value={metricFilter}
            onChange={(e) => setMetricFilter(e.target.value)}
            className="w-48 mt-1"
          />
        </div>

        <div className="flex gap-2 pt-6">
          <Button onClick={applyFilters} variant="default" size="sm">
            Apply Filters
          </Button>
          <Button onClick={clearFilters} variant="outline" size="sm">
            Clear
          </Button>
        </div>
        
        <div className="ml-auto pt-6">
          <Button 
            onClick={() => setConfigDialogOpen(true)} 
            variant="outline" 
            size="sm"
            className="gap-2"
          >
            <Settings className="h-4 w-4" />
            Configure Anomaly Detection
          </Button>
        </div>
      </div>

      {/* Incidents Table */}
      <Card>
        <CardHeader>
          <CardTitle>Incidents ({total} total)</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex justify-center items-center h-32">
              <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
            </div>
          ) : incidents.length === 0 ? (
            <div className="text-center py-8 text-gray-500">No incidents found</div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-20">Severity</TableHead>
                      <TableHead>Device Name</TableHead>
                      <TableHead className="w-32">Type</TableHead>
                      <TableHead>Metric</TableHead>
                      <TableHead className="w-24">Status</TableHead>
                      <TableHead className="w-32">First Seen</TableHead>
                      <TableHead className="w-32">Last Seen</TableHead>
                      <TableHead className="w-24">Score</TableHead>
                      <TableHead className="w-16">Events</TableHead>
                      <TableHead className="w-20">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {incidents.map((incident) => (
                      <TableRow key={incident.incident_id}>
                        <TableCell>
                          <SeverityBadge severity={incident.severity} />
                        </TableCell>
                        <TableCell className="font-medium">{incident.device_name}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {incident.device_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm">{incident.metric}</TableCell>
                        <TableCell>
                          <StatusBadge status={incident.status} />
                        </TableCell>
                        <TableCell className="text-xs">{formatTime(incident.first_seen)}</TableCell>
                        <TableCell className="text-xs">{formatTime(incident.last_seen)}</TableCell>
                        <TableCell>
                          <ScoreBadge score={incident.max_anomaly_score} />
                        </TableCell>
                        <TableCell className="text-center">{incident.event_count}</TableCell>
                        <TableCell>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => fetchIncidentDetails(incident.incident_id)}
                            >
                              <Eye className="w-4 h-4" />
                            </Button>
                            {incident.status !== 'resolved' && (
                              <Button
                                size="sm"
                                variant="default"
                                onClick={() => {
                                  fetchIncidentDetails(incident.incident_id);
                                }}
                              >
                                <CheckCircle className="w-4 h-4" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              <div className="flex justify-between items-center mt-4 pt-4 border-t">
                <span className="text-sm text-gray-600">
                  Showing {incidents.length} of {total} incidents
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={offset === 0}
                    onClick={() => fetchIncidents(Math.max(0, offset - limit))}
                  >
                    <ChevronLeft className="w-4 h-4 mr-1" />
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!hasMore}
                    onClick={() => fetchIncidents(offset + limit)}
                  >
                    Next
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Incident Details Modal */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          {detailsLoading ? (
            <div className="flex justify-center items-center h-64">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : selectedIncident ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <SeverityBadge severity={selectedIncident.severity} />
                  {selectedIncident.metric}
                </DialogTitle>
                <DialogDescription>
                  Incident ID: {selectedIncident.incident_id}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-6">
                {/* Summary Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <Label className="text-sm text-gray-600">Status</Label>
                    <div className="mt-1">
                      <StatusBadge status={selectedIncident.status} />
                    </div>
                  </div>
                  <div>
                    <Label className="text-sm text-gray-600">Anomaly Score</Label>
                    <div className="mt-1">
                      <ScoreBadge score={selectedIncident.max_anomaly_score} />
                    </div>
                  </div>
                  <div>
                    <Label className="text-sm text-gray-600">First Detected</Label>
                    <p className="text-sm mt-1">{formatTime(selectedIncident.first_seen)}</p>
                  </div>
                  <div>
                    <Label className="text-sm text-gray-600">Last Seen</Label>
                    <p className="text-sm mt-1">{formatTime(selectedIncident.last_seen)}</p>
                  </div>
                </div>

                {/* Affected Devices */}
                {selectedIncident.affected_devices && selectedIncident.affected_devices.length > 0 && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Affected Devices</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-2">
                        {selectedIncident.affected_devices.map((device) => (
                          <Badge key={device} variant="secondary">
                            {device}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* Timeline Chart */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Event Timeline</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <IncidentTimelineChart events={selectedIncident.events || []} />
                  </CardContent>
                </Card>

                {/* Events Table */}
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">
                      Related Events ({selectedIncident.events?.length || 0})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {selectedIncident.events && selectedIncident.events.length > 0 ? (
                      <div className="overflow-x-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Timestamp</TableHead>
                              <TableHead>Device</TableHead>
                              <TableHead>Observed</TableHead>
                              <TableHead>Baseline</TableHead>
                              <TableHead>Deviation</TableHead>
                              <TableHead>Score</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {selectedIncident.events.map((event) => (
                              <TableRow key={event.msg_id}>
                                <TableCell className="text-xs">
                                  {formatTime(event.timestamp_ms)}
                                </TableCell>
                                <TableCell className="text-sm">{event.device_name}</TableCell>
                                <TableCell className="text-sm">
                                  {event.observed_value.toFixed(2)}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {event.baseline.mean.toFixed(2)}
                                </TableCell>
                                <TableCell className="text-sm">
                                  {event.deviation.toFixed(2)}
                                </TableCell>
                                <TableCell>
                                  <ScoreBadge score={event.anomaly_score} />
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : (
                      <p className="text-gray-500">No events available</p>
                    )}
                  </CardContent>
                </Card>

                {/* Resolution Form */}
                {selectedIncident.status !== 'resolved' && (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-lg">Resolve Incident</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div>
                        <Label htmlFor="notes">Resolution Notes</Label>
                        <Textarea
                          id="notes"
                          placeholder="Describe how this incident was resolved..."
                          value={resolutionNotes}
                          onChange={(e) => setResolutionNotes(e.target.value)}
                          rows={4}
                          className="mt-1"
                        />
                      </div>
                      <Button
                        onClick={resolveIncident}
                        disabled={resolving}
                        className="w-full"
                      >
                        {resolving ? (
                          <>
                            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                            Resolving...
                          </>
                        ) : (
                          <>
                            <CheckCircle className="w-4 h-4 mr-2" />
                            Mark as Resolved
                          </>
                        )}
                      </Button>
                    </CardContent>
                  </Card>
                )}
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Anomaly Configuration Dialog */}
      <AnomalyMetricsTable
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
      />
    </div>
  );
}
