/**
 * Anomaly Metrics Configuration Table
 * 
 * Manages metric-based anomaly detection configuration with Add/Edit/Delete functionality.
 * Follows OPCUADataPointsTable pattern for consistency.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PlusIcon, TrashIcon, PencilIcon, Settings, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { useDeviceState } from '@/contexts/DeviceStateContext';
import { buildApiUrl } from '@/config/api';
import { toast } from 'sonner';

interface AnomalyMetric {
  name: string;
  deviceName?: string;  // Optional: scopes this config to a specific device (matches "deviceName_name" in publish manager)
  enabled: boolean;
  methods: string[];
  threshold: number;
  windowSize: number;
  expectedRange?: [number, number];
}

interface AnomalyMetricsTableProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDeviceUuid?: string;
  /** Render content inline (no Dialog wrapper). Parent controls the Add button via addTriggerRef. */
  inline?: boolean;
  /** When inline=true, assign handleAdd to this ref so the parent button can trigger the add form. */
  addTriggerRef?: React.MutableRefObject<(() => void) | undefined>;
  /** Controlled filter: selected device label ('all' or a label string). */
  filterDevice?: string;
  onFilterDeviceChange?: (value: string) => void;
  /** Controlled filter: selected method label ('all' or a label string). */
  filterMethod?: string;
  onFilterMethodChange?: (value: string) => void;
  /** Called whenever the available filter option lists change. */
  onFilterOptionsChange?: (devices: string[], methods: string[]) => void;
  /** Called when current metrics totals change (all vs filtered). */
  onMetricsSummaryChange?: (summary: { total: number; filtered: number }) => void;
}

interface Device {
  uuid: string;
  name: string;
  device_name: string;
  is_online: boolean;
}

interface MetricDevice {
  // Legacy single-agent fields
  agent_uuid?: string;
  agent_name?: string;
  // Current aggregated fields from /api/v1/metrics/devices
  agent_uuids?: string[];
  agent_names?: string[];
  device_name: string;
  protocol: string;
  available_metrics: string[];
  metric_count: number;
  last_seen: string;
  source_refs?: Array<{
    deviceUuid?: string;
    endpointUuid?: string;
    agentUuid?: string;
    agentName?: string;
    endpointName?: string;
    device_uuid?: string;
    endpoint_uuid?: string;
    agent_uuid?: string;
    agent_name?: string;
    endpoint_name?: string;
  }>;
}

type SourceRef = {
  deviceUuid?: string;
  endpointUuid?: string;
  agentUuid?: string;
  agentName?: string;
  endpointName?: string;
  device_uuid?: string;
  endpoint_uuid?: string;
  agent_uuid?: string;
  agent_name?: string;
  endpoint_name?: string;
};

function sanitizeExpectedRange(range?: [number, number]): [number, number] | undefined {
  if (!Array.isArray(range) || range.length !== 2) return undefined;
  const [min, max] = range;
  const validMin = typeof min === 'number' && Number.isFinite(min);
  const validMax = typeof max === 'number' && Number.isFinite(max);
  if (!validMin || !validMax) return undefined;
  return [min, max];
}

function isMetricDeviceForAgent(device: MetricDevice, agentUuid: string): boolean {
  if (!agentUuid) return false;
  if (device.agent_uuid && device.agent_uuid === agentUuid) return true;
  if (Array.isArray(device.agent_uuids) && device.agent_uuids.includes(agentUuid)) return true;
  return false;
}

function getSourceRefForAgent(device: MetricDevice | undefined, agentUuid: string, scopeUuid?: string): SourceRef | undefined {
  if (!device || !agentUuid || !Array.isArray(device.source_refs)) return undefined;

  const refs = device.source_refs;

  const normalize = (item: SourceRef) => ({
    deviceUuid: item?.deviceUuid || item?.device_uuid,
    endpointUuid: item?.endpointUuid || item?.endpoint_uuid,
    agentUuid: item?.agentUuid || item?.agent_uuid,
  });

  const matchesScope = (item: SourceRef) => {
    if (!scopeUuid) return true;
    const normalized = normalize(item);
    return normalized.deviceUuid === scopeUuid || normalized.endpointUuid === scopeUuid;
  };

  const exactAgentAndScope = refs.find((item) => {
    const normalized = normalize(item);
    return normalized.agentUuid === agentUuid && matchesScope(item);
  });
  if (exactAgentAndScope) return exactAgentAndScope;

  const scopeOnly = refs.find((item) => matchesScope(item));
  if (scopeOnly) return scopeOnly;

  return refs.find((item) => normalize(item).agentUuid === agentUuid);
}

function isUuidLike(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseCanonicalMetricName(metricName: string): { deviceUuid: string; scope: string; metric: string } | null {
  if (!metricName) return null;

  const firstSep = metricName.indexOf('_');
  const secondSep = firstSep >= 0 ? metricName.indexOf('_', firstSep + 1) : -1;
  if (firstSep <= 0 || secondSep <= firstSep + 1) return null;

  const deviceUuid = metricName.slice(0, firstSep);
  const scope = metricName.slice(firstSep + 1, secondSep);
  const metric = metricName.slice(secondSep + 1);

  if (!deviceUuid || !scope || !metric) return null;
  return { deviceUuid, scope, metric };
}

const DETECTION_METHOD_OPTIONS = [
  { value: 'zscore', label: 'Z-Score (Standard Deviation)' },
  { value: 'mad', label: 'MAD (Median Absolute Deviation)' },
  { value: 'iqr', label: 'IQR (Interquartile Range)' },
  { value: 'roc', label: 'Rate of Change' },
  { value: 'ewma', label: 'EWMA (Exponentially Weighted Moving Average)' },
];

export const AnomalyMetricsTable: React.FC<AnomalyMetricsTableProps> = ({
  open,
  onOpenChange,
  initialDeviceUuid,
  inline = false,
  addTriggerRef,
  filterDevice: controlledFilterDevice,
  onFilterDeviceChange: _onFilterDeviceChange,
  filterMethod: controlledFilterMethod,
  onFilterMethodChange: _onFilterMethodChange,
  onFilterOptionsChange,
  onMetricsSummaryChange,
}) => {
  const [selectedDeviceUuid, setSelectedDeviceUuid] = useState<string>(initialDeviceUuid || '');
  const [devices, setDevices] = useState<Device[]>([]);
  const [metrics, setMetrics] = useState<AnomalyMetric[]>([]);
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);
  const [metricDevices, setMetricDevices] = useState<MetricDevice[]>([]);
  const [metricDevicesLoading, setMetricDevicesLoading] = useState(false);
  const [selectedMetricDevice, setSelectedMetricDevice] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isFormDialogOpen, setIsFormDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { updatePendingConfig, fetchDeviceState } = useDeviceState();

  const {
    register,
    handleSubmit,
    reset,
    control,
    watch,
    formState: { errors },
  } = useForm<AnomalyMetric>({
    defaultValues: {
      name: '',
      deviceName: undefined,
      enabled: true,
      methods: [],
      threshold: 3.0,
      windowSize: 120,
      expectedRange: undefined,
    },
  });

  // Fetch devices on mount
  useEffect(() => {
    if (open) {
      fetchDevices();
    }
  }, [open]);

  // Load metrics when device selected
  useEffect(() => {
    if (selectedDeviceUuid && open) {
      loadMetricsForDevice(selectedDeviceUuid);
    }
  }, [selectedDeviceUuid, open]);

  // Load available devices/metrics for the Add/Edit Metric dialog
  useEffect(() => {
    if (open && isFormDialogOpen) {
      // When editing, preserve the device selection restored in handleEdit
      fetchMetricDevices(editingIndex !== null);
    }
  }, [open, isFormDialogOpen]);

  // Ensure device source references are available for UUID -> friendly name
  // mapping in the table view (even when Add/Edit dialog is closed).
  useEffect(() => {
    if (open) {
      fetchMetricDevices(true);
    }
  }, [open]);

  // Update available metrics when metric device changes
  useEffect(() => {
    if (!selectedMetricDevice) {
      setAvailableMetrics([]);
      return;
    }

    const device = metricDevices.find(d => d.device_name === selectedMetricDevice);
    setAvailableMetrics(device?.available_metrics || []);
  }, [selectedMetricDevice, metricDevices]);

  const fetchDevices = async () => {
    try {
      const response = await fetch(buildApiUrl('/api/v1/agents?limit=100'));
      const data = await response.json();
      if (data.devices) {
        // Filter online devices
        const onlineDevices = data.devices.filter((d: Device) => d.is_online === true);
        setDevices(onlineDevices);
        
        // Auto-select first device if none selected
        if (!selectedDeviceUuid && onlineDevices.length > 0) {
          setSelectedDeviceUuid(onlineDevices[0].uuid);
        }
      }
    } catch (err: any) {
      console.error('Failed to fetch devices:', err);
      setError('Failed to load devices');
    }
  };

  const fetchMetricDevices = async (preserveDeviceSelection = false) => {
    setMetricDevicesLoading(true);
    try {
      const token = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const response = await fetch(buildApiUrl('/api/v1/metrics/devices'), {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const data = await response.json();
      const fetchedDevices = data.devices || [];
      setMetricDevices(fetchedDevices);

      // Only auto-select a default device when adding (not editing) to avoid overwriting the restored selection
      if (!preserveDeviceSelection) {
        const scopedDevices = fetchedDevices.filter((d: MetricDevice) =>
          isMetricDeviceForAgent(d, selectedDeviceUuid)
        );
        const defaultDevice = scopedDevices[0] || fetchedDevices[0];
        setSelectedMetricDevice(defaultDevice?.device_name || '');
      }
    } catch (err: any) {
      console.error('Failed to fetch metric devices:', err);
    } finally {
      setMetricDevicesLoading(false);
    }
  };

  const loadMetricsForDevice = async (deviceUuid: string) => {
    setLoading(true);
    try {
      // Refresh shared device state for the rest of the dashboard, but read the
      // target-state payload directly here to avoid a stale context read.
      await fetchDeviceState(deviceUuid);

      const accessToken = localStorage.getItem('accessToken') || localStorage.getItem('token');
      const response = await fetch(buildApiUrl(`/api/v1/agents/${deviceUuid}`), {
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });

      if (!response.ok) {
        throw new Error(`Failed to load device state: ${response.statusText}`);
      }

      const deviceState = await response.json();
      const configuredMetrics = deviceState?.target_state?.config?.anomalyDetection?.metrics ?? [];

      setMetrics(configuredMetrics);
      setError(null);
    } catch (err: any) {
      console.error('Failed to load metrics:', err);
      setError('Failed to load anomaly configuration');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = () => {
    reset({
      name: '',
      deviceName: undefined,
      enabled: true,
      methods: [],
      threshold: 3.0,
      windowSize: 120,
      expectedRange: undefined,
    });
    setSelectedMetricDevice('');
    setAvailableMetrics([]);
    setEditingIndex(null);
    setIsFormDialogOpen(true);
  };

  const handleEdit = (index: number) => {
    const metric = metrics[index];
    reset({
      ...metric,
      expectedRange: metric.expectedRange ? metric.expectedRange : undefined,
    });
    // Restore device selection from saved deviceName (new format) or from legacy prefixed name
    if (metric.deviceName) {
      setSelectedMetricDevice(metric.deviceName);
    } else {
      // Legacy: try to match from endpoint uuids embedded in the name
      setSelectedMetricDevice('');
    }
    setEditingIndex(index);
    setIsFormDialogOpen(true);
  };

  const handleDelete = async (index: number) => {
    const updated = metrics.filter((_, i) => i !== index);
    await saveMetrics(updated);
  };

  const onSubmit = async (data: AnomalyMetric) => {
    // Clean up methods: ensure it's an array
    if (Array.isArray(data.methods)) {
      // Filter out any false values
      data.methods = data.methods.filter(m => m);
    } else {
      data.methods = [];
    }

    // Clean up expectedRange: only persist when both bounds are finite numbers.
    data.expectedRange = sanitizeExpectedRange(data.expectedRange);

    // Validate at least one method selected if enabled
    if (data.enabled && data.methods.length === 0) {
      toast.error('Please select at least one detection method');
      return;
    }

    // Keep selected catalog device_name for save-time canonicalization to
    // <agentUuid>_<device_uuid>_<metricName>.
    const selectedDeviceInfo = metricDevices.find(d => d.device_name === selectedMetricDevice);
    const isSystemSelection = !selectedMetricDevice || selectedDeviceInfo?.protocol === 'system';
    data.deviceName = isSystemSelection
      ? undefined
      : (selectedMetricDevice || undefined);

    let updated: AnomalyMetric[];
    if (editingIndex !== null) {
      // Edit existing
      updated = metrics.map((metric, i) => (i === editingIndex ? data : metric));
    } else {
      // Add new
      updated = [...metrics, data];
    }

    await saveMetrics(updated);
    setIsFormDialogOpen(false);
  };

  const saveMetrics = async (updatedMetrics: AnomalyMetric[]) => {
    if (!selectedDeviceUuid) {
      toast.error('No device selected');
      return;
    }

    setLoading(true);
    try {
      const normalizedMetrics = updatedMetrics.map(metric => {
        const metricName = (metric.name || '').trim();
        let normalizedName = metricName;

        // Sanitize deviceName: clear it if the device is a 'system' protocol device in the
        // catalog. This self-heals any existing entries that were incorrectly saved with a
        // deviceName on system metrics (cpu_usage, memory_percent, cpu_temp, etc.).
        let deviceName = metric.deviceName;
        if (deviceName) {
          const deviceInfo = metricDevices.find(d => d.device_name === deviceName);
          if (deviceInfo?.protocol === 'system') {
            deviceName = undefined;
          }
        }

        // For non-system metrics, canonicalize using OPC-UA payload device_uuid
        // (source_refs.deviceUuid) so runtime keys match anomaly feed keys.
        const parsed = parseCanonicalMetricName(metricName);
        const looksCanonical = !!(
          parsed
          && parsed.deviceUuid === selectedDeviceUuid
          && (parsed.scope === 'system' || isUuidLike(parsed.scope))
          && parsed.metric.trim().length > 0
        );

        if (!looksCanonical && deviceName) {
          const deviceInfo = metricDevices.find(d => d.device_name === deviceName);
          const sourceRef = getSourceRefForAgent(deviceInfo, selectedDeviceUuid);
          const metricDeviceUuid = sourceRef?.deviceUuid;

          if (metricDeviceUuid) {
            normalizedName = `${selectedDeviceUuid}_${metricDeviceUuid}_${metricName}`;
            // Canonical name is self-contained; avoid relying on deviceName at API layer.
            deviceName = undefined;
          }
        }

        // Build with explicit field ordering: name → deviceName → rest
        const normalized: AnomalyMetric = {
          name: normalizedName,
          ...(deviceName ? { deviceName } : {}),
          enabled: metric.enabled,
          methods: metric.methods,
          threshold: metric.threshold,
          windowSize: metric.windowSize,
        };
        const cleanRange = sanitizeExpectedRange(metric.expectedRange);
        if (cleanRange) normalized.expectedRange = cleanRange;
        return normalized;
      });

      // Update pending config locally (does not save to database)
      updatePendingConfig(
        selectedDeviceUuid, 
        'anomalyDetection.metrics',
        normalizedMetrics
      );
      
      setMetrics(normalizedMetrics);
      toast.success('Changes saved. Click "Deploy" in the header to apply.');
      setError(null);
    } catch (err: any) {
      console.error('Failed to save metrics:', err);
      setError(err.message || 'Failed to save configuration');
      toast.error('Failed to save configuration');
    } finally {
      setLoading(false);
    }
  };

  const selectedDevice = devices.find(d => d.uuid === selectedDeviceUuid);
  // Build a set of configured metric keys for duplicate detection.
  // Key format: "deviceName|name" for device-scoped metrics, or just "name" for system metrics.
  const configuredMetricKeys = new Set(
    metrics.map(m => m.deviceName ? `${m.deviceName}|${m.name}` : m.name)
  );
  const unusedMetrics = availableMetrics.filter(m => {
    const key = selectedMetricDevice ? `${selectedMetricDevice}|${m}` : m;
    return !configuredMetricKeys.has(key) && !configuredMetricKeys.has(m);
  });
  const metricDeviceOptions = metricDevices.filter(d =>
    isMetricDeviceForAgent(d, selectedDeviceUuid)
  );
  const metricDeviceList = metricDeviceOptions.length > 0 ? metricDeviceOptions : metricDevices;

  const resolveMetricScopeDeviceName = (agentUuid: string, scope: string): string | undefined => {
    if (!agentUuid || !scope || scope === 'system') return undefined;

    for (const metricDevice of metricDevices) {
      if (!isMetricDeviceForAgent(metricDevice, agentUuid)) continue;

      const sourceRef = getSourceRefForAgent(metricDevice, agentUuid, scope);
      const refDeviceUuid = sourceRef?.deviceUuid || sourceRef?.device_uuid;
      const refEndpointUuid = sourceRef?.endpointUuid || sourceRef?.endpoint_uuid;
      if (refDeviceUuid === scope || refEndpointUuid === scope) {
        return metricDevice.device_name;
      }
    }

    return undefined;
  };

  const formatMethod = (method?: string) => {
    if (!method) return '-';
    const labels: Record<string, string> = {
      zscore: 'Z-Score',
      mad: 'MAD',
      iqr: 'IQR',
      roc: 'RoC',
      ewma: 'EWMA',
    };
    return labels[method] || method;
  };

  const formatRange = (range?: [number, number]) => {
    if (!range) return '-';
    const [min, max] = range;
    const isValidMin = typeof min === 'number' && Number.isFinite(min);
    const isValidMax = typeof max === 'number' && Number.isFinite(max);
    if (!isValidMin && !isValidMax) return '-';
    return `${isValidMin ? min : '-'} - ${isValidMax ? max : '-'}`;
  };

  const getMetricDeviceLabel = (metric: AnomalyMetric): string => {
    const name = metric.name || '';
    if (metric.deviceName) return metric.deviceName;
    const parsed = parseCanonicalMetricName(name);
    if (!parsed) return '—';
    const resolvedDeviceName = resolveMetricScopeDeviceName(parsed.deviceUuid, parsed.scope);
    return parsed.scope === 'system'
      ? 'System'
      : (resolvedDeviceName || (isUuidLike(parsed.scope) ? `Endpoint ${parsed.scope.slice(0, 8)}` : parsed.scope));
  };

  const getMetricShortName = (metric: AnomalyMetric): string => {
    const name = metric.name || '';
    if (metric.deviceName) return name;
    const parsed = parseCanonicalMetricName(name);
    return parsed ? parsed.metric : name;
  };

  const formatMetricNameForGrid = (metric: AnomalyMetric) => {
    const name = metric.name || '';
    if (metric.deviceName) {
      return `${metric.deviceName} / ${name}`;
    }

    const parsed = parseCanonicalMetricName(name);
    if (!parsed) {
      return name;
    }

    const resolvedDeviceName = resolveMetricScopeDeviceName(parsed.deviceUuid, parsed.scope);
    const scopeLabel = parsed.scope === 'system'
      ? 'System'
      : (resolvedDeviceName || (isUuidLike(parsed.scope) ? `Endpoint ${parsed.scope.slice(0, 8)}` : parsed.scope));

    return `${scopeLabel} / ${parsed.metric}`;
  };

  const formatMetricTitle = (metric: AnomalyMetric) => {
    const name = metric.name || '';
    if (metric.deviceName) {
      return `${metric.deviceName}_${name}`;
    }

    const parsed = parseCanonicalMetricName(name);
    if (!parsed) {
      return name;
    }

    const resolvedDeviceName = resolveMetricScopeDeviceName(parsed.deviceUuid, parsed.scope);
    if (resolvedDeviceName) {
      return `${resolvedDeviceName}_${parsed.metric}`;
    }

    const prefix = parsed.deviceUuid === selectedDeviceUuid
      ? parsed.scope
      : `${parsed.deviceUuid}_${parsed.scope}`;

    return `${prefix}_${parsed.metric}`;
  };

  // Expose handleAdd to parent for inline/tab mode
  if (addTriggerRef) {
    addTriggerRef.current = handleAdd;
  }

  // ── Filter state (controlled by parent when props provided) ───────────
  const filterDevice = controlledFilterDevice ?? 'all';
  const filterMethod = controlledFilterMethod ?? 'all';

  const uniqueDeviceLabels = useMemo(() => {
    const seen = new Set<string>();
    metrics.forEach(m => { const label = getMetricDeviceLabel(m); seen.add(label); });
    return Array.from(seen).sort();
  }, [metrics]);

  const uniqueMethods = useMemo(() => {
    const seen = new Set<string>();
    metrics.forEach(m => { if (m.methods[0]) seen.add(formatMethod(m.methods[0])); });
    return Array.from(seen).sort();
  }, [metrics]);

  useEffect(() => {
    onFilterOptionsChange?.(uniqueDeviceLabels, uniqueMethods);
  }, [uniqueDeviceLabels, uniqueMethods]);

  const filteredMetrics = useMemo(() => {
    return metrics.filter(m => {
      const deviceMatch = filterDevice === 'all' || getMetricDeviceLabel(m) === filterDevice;
      const methodMatch = filterMethod === 'all' || formatMethod(m.methods[0]) === filterMethod;
      return deviceMatch && methodMatch;
    });
  }, [metrics, filterDevice, filterMethod]);

  useEffect(() => {
    onMetricsSummaryChange?.({ total: metrics.length, filtered: filteredMetrics.length });
  }, [metrics.length, filteredMetrics.length]);

  // ── Inline (tab-embedded) mode ──────────────────────────────────────────
  if (inline) {
    return (
      <>
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {loading && !isFormDialogOpen ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : metrics.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Settings className="h-12 w-12 mx-auto mb-4 opacity-40" />
            <p className="text-lg font-medium mb-2">No metrics configured</p>
            <p className="text-sm">Click "Add Metric" to start monitoring anomalies</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Device</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Metric</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Method</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Threshold</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Window</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Range</th>
                  <th className="text-left py-3 px-4 font-semibold text-sm text-foreground">Enabled</th>
                  <th className="py-3 px-4 font-semibold text-sm text-foreground text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredMetrics.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="py-8 text-center text-muted-foreground text-sm">
                      No metrics match the selected filters
                    </td>
                  </tr>
                ) : filteredMetrics.map((metric, index) => (
                  <tr key={index} className="border-b border-border last:border-0 hover:bg-muted">
                    <td className="py-3 px-4 text-muted-foreground">
                      {getMetricDeviceLabel(metric)}
                    </td>
                    <td className="py-3 px-4 font-medium text-foreground" title={formatMetricTitle(metric)}>
                      {getMetricShortName(metric)}
                    </td>
                    <td className="py-3 px-4">
                      <Badge variant="secondary" className="text-xs whitespace-nowrap">
                        {formatMethod(metric.methods[0])}
                      </Badge>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">{metric.threshold}</td>
                    <td className="py-3 px-4 text-muted-foreground">{metric.windowSize}</td>
                    <td className="py-3 px-4 text-muted-foreground whitespace-nowrap">{formatRange(metric.expectedRange)}</td>
                    <td className="py-3 px-4">
                      {metric.enabled ? (
                        <Badge variant="default">On</Badge>
                      ) : (
                        <Badge variant="outline">Off</Badge>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={() => handleEdit(index)} disabled={loading}>
                          <PencilIcon className="w-4 h-4 mr-2" />
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(index)} disabled={loading}>
                          <TrashIcon className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add/Edit Metric Form Dialog */}
        <Dialog open={isFormDialogOpen} onOpenChange={setIsFormDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>
                {editingIndex !== null ? 'Edit Metric' : 'Add Metric'}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit(onSubmit)} className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto pr-2">
                <div className="space-y-4 mt-4 pb-6">
                  <div className="space-y-2">
                    <Label htmlFor="metric-device-inline">
                      Device <span className="text-red-500">*</span>
                    </Label>
                    <Select value={selectedMetricDevice} onValueChange={setSelectedMetricDevice} disabled={editingIndex !== null}>
                      <SelectTrigger id="metric-device-inline">
                        <SelectValue placeholder="Select a device..." />
                      </SelectTrigger>
                      <SelectContent>
                        {metricDevicesLoading ? (
                          <SelectItem value="loading" disabled>Loading devices...</SelectItem>
                        ) : metricDeviceList.length === 0 ? (
                          <SelectItem value="none" disabled>No devices available</SelectItem>
                        ) : (
                          metricDeviceList.map((device) => (
                            <SelectItem key={device.device_name} value={device.device_name}>
                              {device.device_name} ({device.protocol}) - {device.metric_count} metrics
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {editingIndex === null ? 'Select the device that provides the metric' : 'Device cannot be changed while editing'}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="metric-name-inline">
                      Name <span className="text-red-500">*</span>
                    </Label>
                    {editingIndex === null ? (
                      <Select value={watch('name')} onValueChange={(value) => reset({ ...watch(), name: value })}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a metric..." />
                        </SelectTrigger>
                        <SelectContent>
                          {unusedMetrics.length === 0 ? (
                            <SelectItem value="none" disabled>
                              {selectedMetricDevice ? 'No metrics available' : 'Select a device first'}
                            </SelectItem>
                          ) : (
                            unusedMetrics.map((metricName) => (
                              <SelectItem key={metricName} value={metricName}>{metricName}</SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input id="metric-name-inline" value={watch('name')} disabled className="bg-muted" />
                    )}
                    {errors.name && <p className="text-sm text-red-500">{errors.name.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="detection-method-inline">
                      Detection Method <span className="text-red-500">*</span>
                    </Label>
                    <Controller
                      name="methods"
                      control={control}
                      render={({ field }) => {
                        const methods = Array.isArray(field.value) ? field.value : [];
                        const selectedMethod = methods[0] || '';
                        return (
                          <Select value={selectedMethod} onValueChange={(value) => field.onChange(value ? [value] : [])}>
                            <SelectTrigger id="detection-method-inline">
                              <SelectValue placeholder="Select detection method..." />
                            </SelectTrigger>
                            <SelectContent>
                              {DETECTION_METHOD_OPTIONS.map((method) => (
                                <SelectItem key={method.value} value={method.value}>{method.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="threshold-inline">Sensitivity Threshold</Label>
                      <Input id="threshold-inline" type="number" step="0.1" {...register('threshold', { required: 'Threshold is required', valueAsNumber: true, min: { value: 0.1, message: 'Min 0.1' }, max: { value: 10, message: 'Max 10' } })} placeholder="3.0" />
                      {errors.threshold && <p className="text-sm text-red-500">{errors.threshold.message}</p>}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="windowSize-inline">Window Size (samples)</Label>
                      <Input id="windowSize-inline" type="number" {...register('windowSize', { required: 'Window size is required', valueAsNumber: true, min: { value: 20, message: 'Min 20' }, max: { value: 500, message: 'Max 500' } })} placeholder="120" />
                      {errors.windowSize && <p className="text-sm text-red-500">{errors.windowSize.message}</p>}
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label className="font-semibold">Expected Range (Optional)</Label>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="expected-min-inline">Minimum</Label>
                        <Input id="expected-min-inline" type="number" step="any" {...register('expectedRange.0', { valueAsNumber: true })} placeholder="e.g., 0" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="expected-max-inline">Maximum</Label>
                        <Input id="expected-max-inline" type="number" step="any" {...register('expectedRange.1', { valueAsNumber: true })} placeholder="e.g., 100" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="flex items-center space-x-2 flex-shrink-0" style={{ paddingTop: '20px', paddingBottom: '20px' }}>
                <Controller name="enabled" control={control} defaultValue={true} render={({ field }) => (
                  <Checkbox id="metric-enabled-inline" checked={field.value} onCheckedChange={field.onChange} />
                )} />
                <Label htmlFor="metric-enabled-inline" className="font-semibold" style={{ marginLeft: '10px' }}>Enable</Label>
              </div>
              <DialogFooter className="mt-4 pt-4 flex-shrink-0">
                <Button type="button" variant="outline" onClick={() => setIsFormDialogOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={loading}>
                  {loading ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Saving...</> : editingIndex !== null ? 'Update' : 'Add'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-hidden flex flex-col" style={{ width: 'min(900px, 95vw)', maxWidth: 'min(900px, 95vw)' }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Configure Anomaly Detection
          </DialogTitle>
          <DialogDescription>
            Configure metric-based anomaly detection for system and device metrics
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Device Selector — hidden when agent context is provided by the caller */}
        {!initialDeviceUuid && (
          <div className="space-y-2">
            <Label>Agent</Label>
            <Select value={selectedDeviceUuid} onValueChange={setSelectedDeviceUuid}>
              <SelectTrigger>
                <SelectValue placeholder="Select a device..." />
              </SelectTrigger>
              <SelectContent>
                {devices.map((device) => (
                  <SelectItem key={device.uuid} value={device.uuid}>
                    {device.device_name || device.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedDevice && (
              <p className="text-xs text-muted-foreground">
                {metrics.length} metric{metrics.length !== 1 ? 's' : ''} configured
              </p>
            )}
          </div>
        )}

        {/* Metrics Table */}
        {selectedDeviceUuid && (
          <div className="space-y-4 mt-4 overflow-hidden flex flex-col flex-1">
            <div className="flex items-center justify-between flex-shrink-0">
              <h3 className="text-sm font-semibold">
                Configured Metrics ({metrics.length})
              </h3>
              <Button onClick={handleAdd} size="sm" variant="outline" disabled={loading}>
                <PlusIcon className="w-4 h-4 mr-2" />
                Add Metric
              </Button>
            </div>

            {loading && !isFormDialogOpen ? (
              <div className="flex items-center justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : metrics.length === 0 ? (
              <div className="text-center p-8 border border-dashed border-border rounded-lg">
                <p className="text-sm text-muted-foreground">
                  No metrics configured yet. Click "Add Metric" to get started.
                </p>
              </div>
            ) : (
              <div className="border border-border rounded-lg overflow-x-auto overflow-y-auto">
                <Table className="w-full">
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-8">Metric</TableHead>
                      <TableHead className="px-4">Method</TableHead>
                      <TableHead className="px-4">Threshold</TableHead>
                      <TableHead className="px-4">Window</TableHead>
                      <TableHead className="px-4">Range</TableHead>
                      <TableHead className="px-4">Enabled</TableHead>
                      <TableHead className="px-4">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.map((metric, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium pl-8" title={formatMetricTitle(metric)}>{formatMetricNameForGrid(metric)}</TableCell>
                        <TableCell className="px-4">
                          <Badge variant="secondary" className="text-xs whitespace-nowrap">
                            {formatMethod(metric.methods[0])}
                          </Badge>
                        </TableCell>
                        <TableCell className="px-4">{metric.threshold}</TableCell>
                        <TableCell className="px-4">{metric.windowSize}</TableCell>
                        <TableCell className="px-4 whitespace-nowrap">{formatRange(metric.expectedRange)}</TableCell>
                        <TableCell className="px-4">
                          {metric.enabled ? (
                            <Badge variant="default">On</Badge>
                          ) : (
                            <Badge variant="outline">Off</Badge>
                          )}
                        </TableCell>
                        <TableCell className="px-4">
                          <div className="flex gap-2">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleEdit(index)}
                              disabled={loading}
                            >
                              <PencilIcon className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDelete(index)}
                              disabled={loading}
                            >
                              <TrashIcon className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="mt-4 pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Add/Edit Metric Form Dialog */}
      <Dialog open={isFormDialogOpen} onOpenChange={setIsFormDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {editingIndex !== null ? 'Edit Metric' : 'Add Metric'}
            </DialogTitle>
          </DialogHeader>

          <form onSubmit={handleSubmit(onSubmit)} className="flex-1 flex flex-col overflow-hidden">
              <div className="flex-1 overflow-y-auto pr-2">
                <div className="space-y-4 mt-4 pb-6">
                  {/* Device */}
                  <div className="space-y-2">
                    <Label htmlFor="metric-device">
                      Device <span className="text-red-500">*</span>
                    </Label>
                    <Select
                      value={selectedMetricDevice}
                      onValueChange={setSelectedMetricDevice}
                      disabled={editingIndex !== null}
                    >
                      <SelectTrigger id="metric-device">
                        <SelectValue placeholder="Select a device..." />
                      </SelectTrigger>
                      <SelectContent>
                        {metricDevicesLoading ? (
                          <SelectItem value="loading" disabled>
                            Loading devices...
                          </SelectItem>
                        ) : metricDeviceList.length === 0 ? (
                          <SelectItem value="none" disabled>
                            No devices available
                          </SelectItem>
                        ) : (
                          metricDeviceList.map((device) => (
                            <SelectItem key={device.device_name} value={device.device_name}>
                              {device.device_name} ({device.protocol}) - {device.metric_count} metrics
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      {editingIndex === null
                        ? 'Select the device that provides the metric'
                        : 'Device cannot be changed while editing'}
                    </p>
                  </div>

                  {/* Metric Name */}
                  <div className="space-y-2">
                    <Label htmlFor="metric-name">
                      Name <span className="text-red-500">*</span>
                    </Label>
                    {editingIndex === null ? (
                      <Select
                        value={watch('name')}
                        onValueChange={(value) => reset({ ...watch(), name: value })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select a metric..." />
                        </SelectTrigger>
                        <SelectContent>
                          {unusedMetrics.length === 0 ? (
                            <SelectItem value="none" disabled>
                              {selectedMetricDevice ? 'No metrics available' : 'Select a device first'}
                            </SelectItem>
                          ) : (
                            unusedMetrics.map((metricName) => (
                              <SelectItem key={metricName} value={metricName}>
                                {metricName}
                              </SelectItem>
                            ))
                          )}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        id="metric-name"
                        value={watch('name')}
                        disabled
                        className="bg-muted"
                      />
                    )}
                    {errors.name && (
                      <p className="text-sm text-red-500">{errors.name.message}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {editingIndex === null
                        ? 'Select a metric from the available system and endpoint metrics'
                        : 'Metric name cannot be changed'}
                    </p>
                  </div>

                  {/* Detection Method */}
                  <div className="space-y-2">
                    <Label htmlFor="detection-method">
                      Detection Method <span className="text-red-500">*</span>
                    </Label>
                    <Controller
                      name="methods"
                      control={control}
                      render={({ field }) => {
                        const methods = Array.isArray(field.value) ? field.value : [];
                        const selectedMethod = methods[0] || '';

                        return (
                          <Select
                            value={selectedMethod}
                            onValueChange={(value) => field.onChange(value ? [value] : [])}
                          >
                            <SelectTrigger id="detection-method">
                              <SelectValue placeholder="Select detection method..." />
                            </SelectTrigger>
                            <SelectContent>
                              {DETECTION_METHOD_OPTIONS.map((method) => (
                                <SelectItem key={method.value} value={method.value}>
                                  {method.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        );
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Choose one statistical method for anomaly detection
                    </p>
                  </div>

                  {/* Threshold + Window Size — side by side */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="threshold">Sensitivity Threshold</Label>
                      <Input
                        id="threshold"
                        type="number"
                        step="0.1"
                        {...register('threshold', { 
                          required: 'Threshold is required',
                          valueAsNumber: true,
                          min: { value: 0.1, message: 'Minimum threshold is 0.1' },
                          max: { value: 10, message: 'Maximum threshold is 10' }
                        })}
                        placeholder="3.0"
                      />
                      {errors.threshold && (
                        <p className="text-sm text-red-500">{errors.threshold.message}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Higher values = less sensitive. Default: 3.0
                      </p>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="windowSize">Window Size (samples)</Label>
                      <Input
                        id="windowSize"
                        type="number"
                        {...register('windowSize', { 
                          required: 'Window size is required',
                          valueAsNumber: true,
                          min: { value: 20, message: 'Minimum window size is 20' },
                          max: { value: 500, message: 'Maximum window size is 500' }
                        })}
                        placeholder="120"
                      />
                      {errors.windowSize && (
                        <p className="text-sm text-red-500">{errors.windowSize.message}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Rolling window samples. Default: 120
                      </p>
                    </div>
                  </div>

                  {/* Expected Range */}
                  <div className="space-y-2">
                    <Label className="font-semibold">Expected Range (Optional)</Label>
                    <p className="text-xs text-muted-foreground mb-2">
                      Set normal operating bounds for this metric
                    </p>
                    
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="expected-min">Minimum</Label>
                        <Input
                          id="expected-min"
                          type="number"
                          step="any"
                          {...register('expectedRange.0', { valueAsNumber: true })}
                          placeholder="e.g., 0"
                        />
                      </div>
                      
                      <div className="space-y-2">
                        <Label htmlFor="expected-max">Maximum</Label>
                        <Input
                          id="expected-max"
                          type="number"
                          step="any"
                          {...register('expectedRange.1', { valueAsNumber: true })}
                          placeholder="e.g., 100"
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Values outside this range will be flagged immediately
                    </p>
                  </div>

                </div>
              </div>

              {/* Enabled — outside scroll area so it always has breathing room above footer */}
              <div className="flex items-center space-x-2 flex-shrink-0" style={{ paddingTop: '20px', paddingBottom: '20px' }}>
                <Controller
                  name="enabled"
                  control={control}
                  defaultValue={true}
                  render={({ field }) => (
                    <Checkbox
                      id="metric-enabled"
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
                <Label htmlFor="metric-enabled" className="font-semibold" style={{ marginLeft: '10px' }}>
                  Enable
                </Label>
              </div>

            <DialogFooter className="mt-4 pt-4 flex-shrink-0">
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsFormDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  editingIndex !== null ? 'Update' : 'Add'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
};
