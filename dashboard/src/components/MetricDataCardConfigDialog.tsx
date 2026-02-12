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
import { cn } from './ui/utils';

interface MetricDataCardConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: MetricDataCardConfig) => void;
  initialConfig?: MetricDataCardConfig;
}

interface EndpointDevice {
  agent_uuid: string;
  agent_name: string;
  device_name: string;
  protocol: string;
  metric_count: string;
  available_metrics: string[];
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
  const [selectedMetric, setSelectedMetric] = useState<string>(initialConfig?.metricName || '');
  const [chartType, setChartType] = useState<'line' | 'area' | 'bar'>(initialConfig?.chartType || 'line');
  const [timeRange, setTimeRange] = useState<'1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d'>(initialConfig?.timeRange || '1h');
  const [title, setTitle] = useState<string>(initialConfig?.title || '');
  const [color, setColor] = useState<string>(initialConfig?.color || '#3b82f6');
  const [loading, setLoading] = useState(false);
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);
  const [thresholds, setThresholds] = useState<ThresholdLine[]>(initialConfig?.thresholds || []);
  const [showThresholds, setShowThresholds] = useState<boolean>((initialConfig?.thresholds?.length || 0) > 0);
  const [showStats, setShowStats] = useState<boolean>(initialConfig?.showStats ?? true);

  // Update form fields when initialConfig changes (for editing existing widgets)
  useEffect(() => {
    if (open && initialConfig) {
      setSelectedDevice(initialConfig.deviceName || '');
      setSelectedMetric(initialConfig.metricName || '');
      setChartType(initialConfig.chartType || 'line');
      setTimeRange(initialConfig.timeRange || '1h');
      setTitle(initialConfig.title || '');
      setColor(initialConfig.color || '#3b82f6');
      setThresholds(initialConfig.thresholds || []);
      setShowThresholds(initialConfig.thresholdsEnabled ?? ((initialConfig.thresholds?.length || 0) > 0));
      setShowStats(initialConfig.showStats ?? true);
    } else if (open && !initialConfig) {
      // Reset form for new widget
      setSelectedDevice('');
      setSelectedMetric('');
      setChartType('line');
      setTimeRange('1h');
      setTitle('');
      setColor('#3b82f6');
      setThresholds([]);
      setShowThresholds(false);
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
      }
    }
  }, [selectedDevice, devices]);

  const fetchDevices = async () => {
    try {
      setLoading(true);
      const url = buildApiUrl('/api/v1/metrics/devices');
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${localStorage.getItem('accessToken')}`,
        },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch devices');
      }

      const result = await response.json();
      setDevices(result.devices || []);
    } catch (err) {
      console.error('Error fetching devices:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = () => {
    if (!selectedDevice || !selectedMetric) {
      return;
    }

    const config: MetricDataCardConfig = {
      widgetId: initialConfig?.widgetId || `metric-${Date.now()}`,
      deviceName: selectedDevice,
      metricName: selectedMetric,
      chartType,
      timeRange,
      color,
      title: title || undefined,
      showStats,
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
                      {devices.map((device) => (
                        <CommandItem
                          key={device.device_name}
                          value={device.device_name}
                          onSelect={(currentValue) => {
                            setSelectedDevice(currentValue === selectedDevice ? "" : currentValue);
                            setDeviceOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              selectedDevice === device.device_name ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {device.device_name} ({device.protocol}) - {device.metric_count} metrics
                        </CommandItem>
                      ))}
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            disabled={!selectedDevice || !selectedMetric}
          >
            Save Widget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
