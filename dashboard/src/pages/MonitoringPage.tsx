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
import { AlertTriangle, AlertOctagon, Activity, CheckCircle, ChevronLeft, ChevronRight, Loader2, Settings } from 'lucide-react';
import { SeverityBadge, StatusBadge, ScoreBadge } from '@/components/alerts';
import { AnomalyMetricsTable } from '@/components/monitoring/AnomalyMetricsTable';
import { IncidentDetailsModal } from '@/components/monitoring/IncidentDetailsModal';
import { useAuth } from '@/contexts/AuthContext';
import { useDeviceState } from '@/contexts/DeviceStateContext';

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
  device_uuid?: string;
  device_type: string;
  metric: string;
  severity: 'info' | 'warning' | 'critical';
  affected_devices: string[];
  affected_agents: string[];
  first_seen: number | null;
  last_seen: number | null;
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

interface AlertsPageProps {
  initialDeviceUuid?: string;
}

export function AlertsPage({ initialDeviceUuid }: AlertsPageProps) {
  const { user, isAuthenticated } = useAuth();
  const { getPendingConfig, getTargetConfig } = useDeviceState();
  
  // State
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('unresolved');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [deviceFilter, setDeviceFilter] = useState('all');
  const [deviceTypeFilter, setDeviceTypeFilter] = useState('all');
  const [metricFilter, setMetricFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [limit] = useState(50);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);

  // Details modal state (for viewing incident details)
  const [detailsIncident, setDetailsIncident] = useState<IncidentDetails | null>(null);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);

  // Resolve modal state (for resolving incidents)
  const [selectedIncident, setSelectedIncident] = useState<IncidentDetails | null>(null);
  const [resolveDialogOpen, setResolveDialogOpen] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [resolutionNotes, setResolutionNotes] = useState('');
  const [resolving, setResolving] = useState(false);

  // Config dialog state
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  // Device list for filters
  const [devices, setDevices] = useState<{ name: string; type: string }[]>([]);

  const pendingConfig = initialDeviceUuid ? getPendingConfig(initialDeviceUuid) : undefined;
  const targetConfig = initialDeviceUuid ? getTargetConfig(initialDeviceUuid) : undefined;
  const configuredEndpoints = Array.isArray(pendingConfig?.endpoints)
    ? pendingConfig.endpoints
    : Array.isArray(targetConfig?.endpoints)
      ? targetConfig.endpoints
      : [];
  const canConfigureAnomalyDetection = Boolean(initialDeviceUuid && configuredEndpoints.length > 0);

  /**
   * Fetch statistics
   */
  const fetchStats = async () => {
    const token = localStorage.getItem('accessToken');
    if (!isAuthenticated || !token) {
      return;
    }

    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/stats?hours=24`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
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
  const fetchIncidents = async (off: number = 0, silent: boolean = false) => {
    const token = localStorage.getItem('accessToken');
    if (!isAuthenticated || !token) {
      if (!silent) {
        setLoading(false);
      }
      return;
    }

    if (!silent) {
      setLoading(true);
    }
    try {
      const params = new URLSearchParams();
      params.append('limit', limit.toString());
      params.append('offset', off.toString());

      if (statusFilter !== 'all' && statusFilter !== 'unresolved') params.append('status', statusFilter);
      if (severityFilter !== 'all') params.append('severity', severityFilter);
      if (deviceFilter !== 'all') params.append('deviceName', deviceFilter);
      if (deviceTypeFilter !== 'all') params.append('deviceType', deviceTypeFilter);
      if (metricFilter) params.append('metric', metricFilter);

      const response = await fetch(`${API_BASE}/anomaly-incidents?${params}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (data.success) {
        let filteredIncidents = data.incidents;
        // Filter unresolved incidents if that filter is selected
        if (statusFilter === 'unresolved') {
          filteredIncidents = data.incidents.filter((inc: any) => inc.status !== 'resolved');
        }
        setIncidents(filteredIncidents);
        setTotal(filteredIncidents.length);
        setHasMore(false);
        setOffset(off);
      }
    } catch (error) {
      console.error('Failed to fetch incidents:', error);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Fetch and show incident details
   */
  const openDetailsModal = async (incidentId: string) => {
    const token = localStorage.getItem('accessToken');
    if (!isAuthenticated || !token) {
      return;
    }

    setDetailsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/${incidentId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (data.success) {
        setDetailsIncident(data.incident);
        setDetailsModalOpen(true);
      }
    } catch (error) {
      console.error('Failed to fetch incident details:', error);
    } finally {
      setDetailsLoading(false);
    }
  };

  /**
   * Open resolve dialog
   */
  const openResolveDialog = async (incidentId: string) => {
    const token = localStorage.getItem('accessToken');
    if (!isAuthenticated || !token) {
      return;
    }

    setDetailsLoading(true);
    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/${incidentId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();

      if (data.success) {
        setSelectedIncident(data.incident);
        setResolveDialogOpen(true);
        setResolutionNotes(data.incident?.resolution_notes || '');
      }
    } catch (error) {
      console.error('Failed to fetch incident details:', error);
    } finally {
      setDetailsLoading(false);
    }
  };

  const resolveIncident = async () => {
    if (!selectedIncident) return;

    const token = localStorage.getItem('accessToken');
    if (!isAuthenticated || !token) {
      return;
    }

    setResolving(true);
    try {
      const response = await fetch(`${API_BASE}/anomaly-incidents/${selectedIncident.incident_id}/resolve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          resolvedBy: user?.email || user?.username || 'anonymous',
          notes: resolutionNotes,
        }),
      });

      const data = await response.json();
      if (data.success) {
        setResolveDialogOpen(false);
        setDetailsModalOpen(false);
        setSelectedIncident(null);
        setDetailsIncident(null);
        setResolutionNotes('');
        await fetchIncidents(offset, true);
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
    setStatusFilter('unresolved');
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

    // Auto-refresh every 30 seconds (silent refresh to prevent flickering)
    const interval = setInterval(() => {
      fetchStats();
      fetchIncidents(offset, true); // Silent refresh
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  // Format timestamp
  const formatTime = (ms: number | null | undefined) => {
    if (!ms || isNaN(ms)) {
      return 'N/A';
    }
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
            <SelectContent>            <SelectItem value="unresolved">Unresolved</SelectItem>              <SelectItem value="all">All Status</SelectItem>
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
              <SelectItem value="mqtt">MQTT</SelectItem>
              <SelectItem value="system">System</SelectItem>
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
        
        {canConfigureAnomalyDetection && (
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
        )}
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
              <div className="overflow-x-auto transition-opacity duration-300">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-28">Severity</TableHead>
                      <TableHead>Device Name</TableHead>
                      <TableHead className="w-36">Type</TableHead>
                      <TableHead>Metric</TableHead>
                      <TableHead className="w-28">Status</TableHead>
                      <TableHead className="w-36">Last Seen</TableHead>
                      <TableHead className="w-28">Score</TableHead>
                      <TableHead className="w-20 text-center">Events</TableHead>
                      <TableHead className="w-48">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {incidents.map((incident) => (
                      <TableRow key={incident.incident_id}>
                        <TableCell className="py-5">
                          <SeverityBadge severity={incident.severity} />
                        </TableCell>
                        <TableCell className="font-medium py-5">{incident.device_name}</TableCell>
                        <TableCell className="py-5">
                          <Badge variant="outline" className="text-xs">
                            {incident.device_type}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm py-5">{incident.metric}</TableCell>
                        <TableCell className="py-5">
                          <StatusBadge status={incident.status} />
                        </TableCell>
                        <TableCell className="text-xs py-5">{formatTime(incident.last_seen)}</TableCell>
                        <TableCell className="py-5">
                          <ScoreBadge score={incident.max_anomaly_score} />
                        </TableCell>
                        <TableCell className="text-center py-5">{incident.event_count}</TableCell>
                        <TableCell className="py-0" style={{ paddingTop: '24px', paddingBottom: '24px' }}>
                          <div className="flex items-center gap-2 w-fit">
                            <Button
                              size="sm"
                              className="h-8"
                              variant="outline"
                              style={{ border: '1px solid rgba(255,255,255,0.3)' }}
                              onClick={() => openDetailsModal(incident.incident_id)}
                            >
                              Details
                            </Button>
                            {incident.status !== 'resolved' && (
                              <Button
                                size="sm"
                                className="h-8"
                                variant="default"
                                onClick={() => openResolveDialog(incident.incident_id)}
                              >
                                <CheckCircle className="w-4 h-4 mr-1" />
                                Resolve
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

      {/* Details Modal */}
      {detailsIncident && (
        <IncidentDetailsModal
          open={detailsModalOpen}
          onOpenChange={setDetailsModalOpen}
          incident={detailsIncident}
          onResolve={() => openResolveDialog(detailsIncident.incident_id)}
        />
      )}

      {/* Resolve Modal */}
      <Dialog open={resolveDialogOpen} onOpenChange={setResolveDialogOpen}>
        <DialogContent className="max-w-md">
          {detailsLoading ? (
            <div className="flex justify-center items-center h-32">
              <Loader2 className="w-8 h-8 animate-spin" />
            </div>
          ) : selectedIncident ? (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <SeverityBadge severity={selectedIncident.severity} />
                  Resolve Incident
                </DialogTitle>
                <DialogDescription>
                  {selectedIncident.device_name} - {selectedIncident.metric}
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4 mt-4">
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
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Anomaly Configuration Dialog */}
      <AnomalyMetricsTable
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        initialDeviceUuid={initialDeviceUuid}
      />
    </div>
  );
}
