/**
 * Anomaly Metrics Configuration Table
 * 
 * Manages metric-based anomaly detection configuration with Add/Edit/Delete functionality.
 * Follows OPCUADataPointsTable pattern for consistency.
 */

import React, { useState, useEffect } from 'react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';
import { useDeviceState } from '@/contexts/DeviceStateContext';
import { buildApiUrl } from '@/config/api';
import { toast } from 'sonner';

interface AnomalyMetric {
  name: string;
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
}

interface Device {
  uuid: string;
  name: string;
  device_name: string;
  is_online: boolean;
}

interface MetricCatalogItem {
  metric_name: string;
  device_name: string;
  protocol: string;
  unit?: string;
}

export const AnomalyMetricsTable: React.FC<AnomalyMetricsTableProps> = ({
  open,
  onOpenChange,
  initialDeviceUuid,
}) => {
  const [selectedDeviceUuid, setSelectedDeviceUuid] = useState<string>(initialDeviceUuid || '');
  const [devices, setDevices] = useState<Device[]>([]);
  const [metrics, setMetrics] = useState<AnomalyMetric[]>([]);
  const [availableMetrics, setAvailableMetrics] = useState<MetricCatalogItem[]>([]);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isFormDialogOpen, setIsFormDialogOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { getPendingConfig, updatePendingConfig, fetchDeviceState } = useDeviceState();

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
      fetchMetricsCatalog(selectedDeviceUuid);
    }
  }, [selectedDeviceUuid, open]);

  const fetchDevices = async () => {
    try {
      const response = await fetch(buildApiUrl('/api/v1/devices?limit=100'));
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

  const fetchMetricsCatalog = async (deviceUuid: string) => {
    const device = devices.find(d => d.uuid === deviceUuid);
    if (!device) return;

    setCatalogLoading(true);
    try {
      const response = await fetch(
        buildApiUrl(`/api/v1/metrics/catalog?deviceName=${encodeURIComponent(device.device_name || device.name)}`)
      );
      const data = await response.json();
      if (data.metrics) {
        setAvailableMetrics(data.metrics);
      }
    } catch (err: any) {
      console.error('Failed to fetch metrics catalog:', err);
    } finally {
      setCatalogLoading(false);
    }
  };

  const loadMetricsForDevice = async (deviceUuid: string) => {
    setLoading(true);
    try {
      // Fetch device state to get current config
      await fetchDeviceState(deviceUuid);
      
      const pendingConfig = getPendingConfig(deviceUuid);
      const systemMetrics = pendingConfig?.anomalyDetection?.systemMetrics || [];
      
      setMetrics(systemMetrics);
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
      enabled: true,
      methods: [],
      threshold: 3.0,
      windowSize: 120,
      expectedRange: undefined,
    });
    setEditingIndex(null);
    setIsFormDialogOpen(true);
  };

  const handleEdit = (index: number) => {
    const metric = metrics[index];
    reset({
      ...metric,
      expectedRange: metric.expectedRange ? metric.expectedRange : undefined,
    });
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

    // Clean up expectedRange
    if (data.expectedRange) {
      const [min, max] = data.expectedRange;
      if ((min === null || min === undefined) && (max === null || max === undefined)) {
        delete data.expectedRange;
      } else {
        data.expectedRange = [min, max];
      }
    }

    // Validate at least one method selected if enabled
    if (data.enabled && data.methods.length === 0) {
      toast.error('Please select at least one detection method');
      return;
    }

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
      // Update pending config locally (does not save to database)
      updatePendingConfig(
        selectedDeviceUuid, 
        'anomalyDetection.systemMetrics', 
        updatedMetrics
      );
      
      setMetrics(updatedMetrics);
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
  const configuredMetricNames = new Set(metrics.map(m => m.name));
  const unusedMetrics = availableMetrics.filter(m => !configuredMetricNames.has(m.metric_name));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-none max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Configure Anomaly Detection
          </DialogTitle>
          <DialogDescription>
            Configure metric-based anomaly detection for system and endpoint metrics
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Device Selector */}
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
              <div className="border border-border rounded-lg overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Metric Name</TableHead>
                      <TableHead>Methods</TableHead>
                      <TableHead>Threshold</TableHead>
                      <TableHead>Window Size</TableHead>
                      <TableHead>Range</TableHead>
                      <TableHead>Enabled</TableHead>
                      <TableHead className="w-24">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {metrics.map((metric, index) => (
                      <TableRow key={index}>
                        <TableCell className="font-medium">{metric.name}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1">
                            {metric.methods.map((method) => (
                              <Badge key={method} variant="secondary" className="text-xs">
                                {method}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>{metric.threshold}</TableCell>
                        <TableCell>{metric.windowSize}</TableCell>
                        <TableCell>
                          {metric.expectedRange
                            ? `${metric.expectedRange[0] ?? '-'} to ${metric.expectedRange[1] ?? '-'}`
                            : '-'}
                        </TableCell>
                        <TableCell>
                          {metric.enabled ? (
                            <Badge variant="default">Enabled</Badge>
                          ) : (
                            <Badge variant="outline">Disabled</Badge>
                          )}
                        </TableCell>
                        <TableCell>
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

        <DialogFooter>
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
            <Tabs defaultValue="basic" className="flex-1 flex flex-col overflow-hidden">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="basic">Basic Configuration</TabsTrigger>
                <TabsTrigger value="detection">Detection Methods</TabsTrigger>
              </TabsList>

              <div className="flex-1 overflow-y-auto pr-2">
                <TabsContent value="basic" className="space-y-4 mt-4">
                  {/* Metric Name */}
                  <div className="space-y-2">
                    <Label htmlFor="metric-name">
                      Metric Name <span className="text-red-500">*</span>
                    </Label>
                    {editingIndex === null ? (
                      catalogLoading ? (
                        <div className="flex items-center gap-2 py-2">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span className="text-sm text-muted-foreground">Loading metrics...</span>
                        </div>
                      ) : (
                        <Select
                          value={watch('name')}
                          onValueChange={(value) => reset({ ...watch(), name: value })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select a metric..." />
                          </SelectTrigger>
                          <SelectContent>
                            {unusedMetrics.map((metric) => (
                              <SelectItem key={metric.metric_name} value={metric.metric_name}>
                                {metric.metric_name}
                                {metric.unit && ` (${metric.unit})`}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )
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

                  {/* Enabled */}
                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
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
                      <Label htmlFor="metric-enabled" className="font-semibold">
                        Enable Anomaly Detection
                      </Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Monitor this metric for statistical anomalies
                    </p>
                  </div>

                  {/* Threshold */}
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
                      Higher values = less sensitive (fewer alerts). Default: 3.0
                    </p>
                  </div>

                  {/* Window Size */}
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
                      Number of samples for rolling window analysis. Default: 120
                    </p>
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
                </TabsContent>

                <TabsContent value="detection" className="space-y-6 mt-4">
                  {/* Detection Methods */}
                  <div className="space-y-3">
                    <Label>Detection Methods</Label>
                    <div className="space-y-2">
                      {[
                        { id: 'zscore', label: 'Z-Score (Standard Deviation)' },
                        { id: 'mad', label: 'MAD (Median Absolute Deviation)' },
                        { id: 'iqr', label: 'IQR (Interquartile Range)' },
                        { id: 'roc', label: 'Rate of Change' },
                        { id: 'ewma', label: 'EWMA (Exponentially Weighted Moving Average)' },
                      ].map(({ id, label }) => (
                        <div key={id} className="flex items-center space-x-2">
                          <Controller
                            name="methods"
                            control={control}
                            render={({ field }) => {
                              const methods = Array.isArray(field.value) ? field.value : [];
                              return (
                                <Checkbox
                                  id={`method-${id}`}
                                  checked={methods.includes(id)}
                                  onCheckedChange={(checked) => {
                                    const updated = checked
                                      ? [...methods, id]
                                      : methods.filter((m: string) => m !== id);
                                    field.onChange(updated);
                                  }}
                                />
                              );
                            }}
                          />
                          <Label htmlFor={`method-${id}`} className="text-sm font-normal cursor-pointer">
                            {label}
                          </Label>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Select one or more statistical methods to detect anomalies
                    </p>
                  </div>
                </TabsContent>
              </div>
            </Tabs>

            <DialogFooter className="mt-4 pt-4 border-t">
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
