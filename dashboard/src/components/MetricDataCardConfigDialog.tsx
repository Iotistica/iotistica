import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './ui/select';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from './ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from './ui/popover';
import { buildApiUrl } from '@/config/api';
import type { MetricDataCardConfig, ThresholdLine } from './MetricDataCard';
import { Plus, Trash2, Check, ChevronsUpDown } from 'lucide-react';
import { Checkbox } from './ui/checkbox';
import { Badge } from './ui/badge';
import { cn } from './ui/utils';

interface MetricDataCardConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: MetricDataCardConfig) => void;
  initialConfig?: MetricDataCardConfig;
}

interface MetricSourceRef {
  deviceUuid: string;
  endpointUuid: string;
  agentName?: string;
}

interface EndpointDevice {
  device_name: string;
  protocol: string;
  last_seen: string;
  metric_count: string;
  available_metrics: string[];
  overall_quality_percentage: number;
  agent_count: number;
  agent_uuids: string[];
  agent_names: string[];
  source_refs?: MetricSourceRef[];
}

export function MetricDataCardConfigDialog({
  open,
  onOpenChange,
  onSave,
  initialConfig,
}: MetricDataCardConfigDialogProps) {
  const [devices, setDevices] = useState<EndpointDevice[]>([]);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<string>(initialConfig?.deviceName || '');
  const [selectedSourceKey, setSelectedSourceKey] = useState<string>(
    initialConfig?.deviceUuid && initialConfig?.endpointUuid
      ? `${initialConfig.deviceUuid}:${initialConfig.endpointUuid}`
      : ''
  );
  const [selectedMetric, setSelectedMetric] = useState<string>(initialConfig?.metricName || '');
  const [chartType, setChartType] = useState<'line' | 'area' | 'bar'>(initialConfig?.chartType || 'line');
  const [timeRange, setTimeRange] = useState<'1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d'>(initialConfig?.timeRange || '1h');
  const [title, setTitle] = useState<string>(initialConfig?.title || '');
  const [color, setColor] = useState<string>(initialConfig?.color || '#3b82f6');
  const [loading, setLoading] = useState(false);
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);
  const [thresholds, setThresholds] = useState<ThresholdLine[]>(initialConfig?.thresholds || []);
  const [showThresholds, setShowThresholds] = useState<boolean>((initialConfig?.thresholds?.length || 0) > 0);
  const [enableAlert, setEnableAlert] = useState<boolean>(initialConfig?.alertEnabled ?? false);
  const [alertMin, setAlertMin] = useState<string>(
    initialConfig?.alertMin !== undefined ? String(initialConfig.alertMin) : ''
  );
  const [alertMax, setAlertMax] = useState<string>(
    initialConfig?.alertMax !== undefined ? String(initialConfig.alertMax) : ''
  );
  const [showStats, setShowStats] = useState<boolean>(initialConfig?.showStats ?? true);
  const [registeredDevices, setRegisteredDevices] = useState<Map<string, { isOnline: boolean }>>(new Map());

  const getSourceKey = (sourceRef: MetricSourceRef) => `${sourceRef.deviceUuid}:${sourceRef.endpointUuid}`;

  // Update form fields when initialConfig changes (for editing existing widgets)
  useEffect(() => {
    if (open && initialConfig) {
      setSelectedDevice(initialConfig.deviceName || '');
      setSelectedSourceKey(
        initialConfig.deviceUuid && initialConfig.endpointUuid
          ? `${initialConfig.deviceUuid}:${initialConfig.endpointUuid}`
          : ''
      );
      setSelectedMetric(initialConfig.metricName || '');
      setChartType(initialConfig.chartType || 'line');
      setTimeRange(initialConfig.timeRange || '1h');
      setTitle(initialConfig.title || '');
      setColor(initialConfig.color || '#3b82f6');
      setThresholds(initialConfig.thresholds || []);
      setShowThresholds(initialConfig.thresholdsEnabled ?? ((initialConfig.thresholds?.length || 0) > 0));
      setEnableAlert(initialConfig.alertEnabled ?? false);
      setAlertMin(initialConfig.alertMin !== undefined ? String(initialConfig.alertMin) : '');
      setAlertMax(initialConfig.alertMax !== undefined ? String(initialConfig.alertMax) : '');
      setShowStats(initialConfig.showStats ?? true);
    } else if (open && !initialConfig) {
      // Reset form for new widget
      setSelectedDevice('');
      setSelectedSourceKey('');
      setSelectedMetric('');
      setChartType('line');
      setTimeRange('1h');
      setTitle('');
      setColor('#3b82f6');
      setThresholds([]);
      setShowThresholds(false);
      setEnableAlert(false);
      setAlertMin('');
      setAlertMax('');
      setShowStats(false);
    }
  }, [open, initialConfig]);

  useEffect(() => {
    if (open) {
      fetchDevices();
    }
  }, [open]);

  useEffect(() => {
    if (selectedDevice) {
      const device = devices.find(d => d.device_name === selectedDevice);
      if (device) {
        setAvailableMetrics(device.available_metrics);
        const sourceRefs = Array.isArray(device.source_refs) ? device.source_refs : [];
        if (sourceRefs.length === 1) {
          setSelectedSourceKey(getSourceKey(sourceRefs[0]));
          return;
        }

        const currentSourceStillValid = sourceRefs.some(sourceRef => getSourceKey(sourceRef) === selectedSourceKey);
        if (!currentSourceStillValid) {
          const matchesInitialConfig =
            initialConfig?.deviceName === selectedDevice &&
            initialConfig?.deviceUuid &&
            initialConfig?.endpointUuid
              ? sourceRefs.some(
                  sourceRef =>
                    sourceRef.deviceUuid === initialConfig.deviceUuid &&
                    sourceRef.endpointUuid === initialConfig.endpointUuid
                )
              : false;

          setSelectedSourceKey(
            matchesInitialConfig && initialConfig?.deviceUuid && initialConfig?.endpointUuid
              ? `${initialConfig.deviceUuid}:${initialConfig.endpointUuid}`
              : ''
          );
        }
      }
    }
  }, [selectedDevice, devices, selectedSourceKey, initialConfig]);

  const selectedDeviceData = devices.find(d => d.device_name === selectedDevice);
  const selectedDeviceSources = Array.isArray(selectedDeviceData?.source_refs)
    ? selectedDeviceData.source_refs.filter(sourceRef => sourceRef.deviceUuid && sourceRef.endpointUuid)
    : [];
  const selectedSourceRef = selectedDeviceSources.find(sourceRef => getSourceKey(sourceRef) === selectedSourceKey);
  const requiresExactSourceSelection = selectedDeviceSources.length > 1;
  const canSave = Boolean(
    selectedDevice &&
    selectedMetric &&
    selectedSourceRef?.deviceUuid &&
    selectedSourceRef?.endpointUuid
  );
  const parsedAlertMin = alertMin.trim() === '' ? undefined : Number(alertMin);
  const parsedAlertMax = alertMax.trim() === '' ? undefined : Number(alertMax);
  const hasValidAlertRange =
    parsedAlertMin !== undefined &&
    parsedAlertMax !== undefined &&
    Number.isFinite(parsedAlertMin) &&
    Number.isFinite(parsedAlertMax);
  const canSaveWithAlert = canSave && (!enableAlert || hasValidAlertRange);

  const fetchDevices = async () => {
    try {
      setLoading(true);
      
      // Fetch devices with metric data
      const metricsUrl = buildApiUrl('/api/v1/metrics/devices');
      const metricsResponse = await fetch(metricsUrl, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });

      if (!metricsResponse.ok) {
        throw new Error('Failed to fetch devices');
      }

      const metricsResult = await metricsResponse.json();
      setDevices(metricsResult.devices || []);
      
      // Fetch registered devices to check status
      const devicesUrl = buildApiUrl('/api/v1/devices?limit=1000');
      const devicesResponse = await fetch(devicesUrl, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });
      
      if (devicesResponse.ok) {
        const devicesData = await devicesResponse.json();
        const deviceMap = new Map();
        devicesData.devices?.forEach((d: any) => {
          deviceMap.set(d.uuid, {
            isOnline: d.is_online || false
          });
        });
        setRegisteredDevices(deviceMap);
      }
    } catch (err) {
      console.error('Error fetching devices:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = () => {
    if (!selectedDevice || !selectedMetric || !selectedSourceRef) {
      return;
    }

    if (enableAlert && !hasValidAlertRange) {
      return;
    }

    const config: MetricDataCardConfig = {
      widgetId: initialConfig?.widgetId || `metric-${Date.now()}`,
      agentName: selectedSourceRef.agentName,
      deviceUuid: selectedSourceRef.deviceUuid,
      endpointUuid: selectedSourceRef.endpointUuid,
      deviceName: selectedDevice,
      metricName: selectedMetric,
      chartType,
      timeRange,
      color,
      title: title || undefined,
      showStats,
      alertEnabled: enableAlert,
      alertMin: enableAlert && hasValidAlertRange ? parsedAlertMin : undefined,
      alertMax: enableAlert && hasValidAlertRange ? parsedAlertMax : undefined,
      thresholds: thresholds.length > 0 ? thresholds : undefined,
      thresholdsEnabled: showThresholds,
    };

    onSave(config);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Metric Data Card</DialogTitle>
          <DialogDescription>
            Select a device and metric to visualize time-series data
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label>Device</Label>
            <Popover open={deviceOpen} onOpenChange={setDeviceOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={deviceOpen}
                  className="w-full justify-between"
                >
                  {selectedDevice
                    ? devices.find((device) => device.device_name === selectedDevice)?.device_name
                    : "Select device..."}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0">
                <Command>
                  <CommandInput placeholder="Search devices..." />
                  <CommandList>
                    <CommandEmpty>
                      {loading ? "Loading devices..." : "No devices found."}
                    </CommandEmpty>
                    <CommandGroup>
                      {devices.map((device) => {
                        // Check if any of the device's agents are registered and online
                        const hasOnlineAgent = device.agent_uuids?.some(uuid => {
                          const deviceInfo = registeredDevices.get(uuid);
                          return deviceInfo && deviceInfo.isOnline;
                        });
                        
                        const hasRegisteredAgent = device.agent_uuids?.some(uuid => 
                          registeredDevices.has(uuid)
                        );
                        
                        const isDeleted = !hasRegisteredAgent;
                        const isOffline = hasRegisteredAgent && !hasOnlineAgent;
                        
                        return (
                          <CommandItem
                            key={device.device_name}
                            value={device.device_name}
                            onSelect={(currentValue) => {
                              setSelectedDevice(currentValue === selectedDevice ? "" : currentValue);
                              setDeviceOpen(false);
                            }}
                            className={isDeleted || isOffline ? 'opacity-50' : ''}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedDevice === device.device_name ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex items-center justify-between w-full gap-2">
                              <span>
                                {device.device_name} ({device.protocol}) - {device.metric_count} metrics
                              </span>
                              {isDeleted && (
                                <Badge variant="outline" className="text-xs bg-red-50 text-red-600 border-red-200">
                                  Deleted
                                </Badge>
                              )}
                              {!isDeleted && isOffline && (
                                <Badge variant="outline" className="text-xs bg-gray-100 text-gray-600 border-gray-300">
                                  Offline
                                </Badge>
                              )}
                            </div>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="metric">Metric</Label>
            <Select 
              value={selectedMetric} 
              onValueChange={setSelectedMetric}
              disabled={!selectedDevice || availableMetrics.length === 0}
            >
              <SelectTrigger id="metric">
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent>
                {availableMetrics.length === 0 ? (
                  <SelectItem value="none" disabled>
                    {selectedDevice ? 'No metrics available' : 'Select a device first'}
                  </SelectItem>
                ) : (
                  availableMetrics.map((metric) => (
                    <SelectItem key={metric} value={metric}>
                      {metric}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="metric-source">Exact Source</Label>
            {selectedDeviceSources.length === 0 ? (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                No exact source mapping is available for this device yet.
              </div>
            ) : selectedDeviceSources.length === 1 && selectedSourceRef ? (
              <div className="rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{selectedSourceRef.agentName || 'Source agent'}</div>
                <div className="text-muted-foreground">
                  Device UUID: {selectedSourceRef.deviceUuid}
                </div>
              </div>
            ) : (
              <Select value={selectedSourceKey} onValueChange={setSelectedSourceKey}>
                <SelectTrigger id="metric-source">
                  <SelectValue placeholder="Select exact source" />
                </SelectTrigger>
                <SelectContent>
                  {selectedDeviceSources.map((sourceRef) => {
                    const deviceInfo = registeredDevices.get(sourceRef.deviceUuid);
                    const isOnline = Boolean(deviceInfo?.isOnline);
                    return (
                      <SelectItem key={getSourceKey(sourceRef)} value={getSourceKey(sourceRef)}>
                        {sourceRef.agentName || sourceRef.deviceUuid} {isOnline ? '• online' : '• offline'}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
            {requiresExactSourceSelection && !selectedSourceRef && (
              <p className="text-xs text-muted-foreground">
                Select the exact source so the widget can store stable UUIDs.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="chartType">Chart Type</Label>
            <Select value={chartType} onValueChange={(v) => setChartType(v as any)}>
              <SelectTrigger id="chartType">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="line">Line Chart</SelectItem>
                <SelectItem value="area">Area Chart</SelectItem>
                <SelectItem value="bar">Bar Chart</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="timeRange">Time Range</Label>
            <Select value={timeRange} onValueChange={(v) => setTimeRange(v as any)}>
              <SelectTrigger id="timeRange">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1m">Last 1 Minute</SelectItem>
                <SelectItem value="1h">Last 1 Hour</SelectItem>
                <SelectItem value="6h">Last 6 Hours</SelectItem>
                <SelectItem value="12h">Last 12 Hours</SelectItem>
                <SelectItem value="24h">Last 24 Hours</SelectItem>
                <SelectItem value="7d">Last 7 Days</SelectItem>
                <SelectItem value="30d">Last 30 Days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-stats"
                checked={showStats}
                onCheckedChange={(checked) => setShowStats(checked === true)}
              />
              <Label htmlFor="show-stats" className="cursor-pointer">
                Show Aggregate Cards
              </Label>
            </div>
            <p className="text-xs text-muted-foreground ml-6">
              Display Current/Average/Minimum/Maximum cards above the chart.
            </p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="color">Chart Color</Label>
            <div className="flex gap-2 items-center">
              <Input
                id="color"
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-20 h-10 cursor-pointer"
              />
              <span className="text-sm text-muted-foreground">{color}</span>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="title">Custom Title (Optional)</Label>
            <Input
              id="title"
              placeholder="Leave empty for auto-generated title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Thresholds Section */}
          <div className="grid gap-2 pt-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="show-thresholds"
                checked={showThresholds}
                onCheckedChange={(checked) => setShowThresholds(checked === true)}
              />
              <Label htmlFor="show-thresholds" className="cursor-pointer">
                Thresholds
              </Label>
            </div>

            {showThresholds && (
              <div className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setThresholds([...thresholds, {
                      value: 0,
                      label: '',
                      color: '#ef4444',
                      lineStyle: 'dashed'
                    }]);
                  }}
                  className="w-full"
                >
                  <Plus className="w-4 h-4 mr-2" />
                  Add Threshold
                </Button>

                {thresholds.map((threshold, index) => (
                  <div key={index} className="grid gap-2 p-3 border rounded-lg bg-muted/30">
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">Threshold {index + 1}</Label>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setThresholds(thresholds.filter((_, i) => i !== index));
                        }}
                      >
                        <Trash2 className="w-4 h-4 text-destructive" />
                      </Button>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label htmlFor={`threshold-value-${index}`} className="text-xs">Value</Label>
                        <Input
                          id={`threshold-value-${index}`}
                          type="number"
                          step="any"
                          value={threshold.value}
                          onChange={(e) => {
                            const newThresholds = [...thresholds];
                            newThresholds[index] = { ...threshold, value: parseFloat(e.target.value) || 0 };
                            setThresholds(newThresholds);
                          }}
                          className="h-8"
                        />
                      </div>
                      <div>
                        <Label htmlFor={`threshold-label-${index}`} className="text-xs">Label</Label>
                        <Input
                          id={`threshold-label-${index}`}
                          placeholder="Optional"
                          value={threshold.label || ''}
                          onChange={(e) => {
                            const newThresholds = [...thresholds];
                            newThresholds[index] = { ...threshold, label: e.target.value };
                            setThresholds(newThresholds);
                          }}
                          className="h-8"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label htmlFor={`threshold-style-${index}`} className="text-xs">Line Style</Label>
                        <Select
                          value={threshold.lineStyle}
                          onValueChange={(value: 'solid' | 'dashed') => {
                            const newThresholds = [...thresholds];
                            newThresholds[index] = { ...threshold, lineStyle: value };
                            setThresholds(newThresholds);
                          }}
                        >
                          <SelectTrigger id={`threshold-style-${index}`} className="h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="solid">Solid ─</SelectItem>
                            <SelectItem value="dashed">Dashed ┈</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label htmlFor={`threshold-color-${index}`} className="text-xs">Color</Label>
                        <div className="flex gap-2 items-center">
                          <Input
                            id={`threshold-color-${index}`}
                            type="color"
                            value={threshold.color}
                            onChange={(e) => {
                              const newThresholds = [...thresholds];
                              newThresholds[index] = { ...threshold, color: e.target.value };
                              setThresholds(newThresholds);
                            }}
                            className="w-16 h-8 cursor-pointer"
                          />
                          <span className="text-xs text-muted-foreground">{threshold.color}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}

                {thresholds.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-2">
                    No thresholds added yet
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Alert Section */}
          <div className="grid gap-2 pt-2">
            <div className="flex items-center gap-2">
              <Checkbox
                id="enable-alert"
                checked={enableAlert}
                onCheckedChange={(checked) => setEnableAlert(checked === true)}
              />
              <Label htmlFor="enable-alert" className="cursor-pointer">
                Add Alert (Expected Range)
              </Label>
            </div>

            {enableAlert && (
              <div className="space-y-2 rounded-lg border p-3 bg-muted/20">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="alert-min" className="text-xs">Minimum</Label>
                    <Input
                      id="alert-min"
                      type="number"
                      step="any"
                      value={alertMin}
                      onChange={(e) => setAlertMin(e.target.value)}
                      className="h-8"
                      placeholder="e.g. 20"
                    />
                  </div>
                  <div>
                    <Label htmlFor="alert-max" className="text-xs">Maximum</Label>
                    <Input
                      id="alert-max"
                      type="number"
                      step="any"
                      value={alertMax}
                      onChange={(e) => setAlertMax(e.target.value)}
                      className="h-8"
                      placeholder="e.g. 80"
                    />
                  </div>
                </div>

                {!hasValidAlertRange && (
                  <p className="text-xs text-amber-700">
                    Enter both minimum and maximum values to enable alert syncing.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            disabled={!canSaveWithAlert}
          >
            Save Widget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
