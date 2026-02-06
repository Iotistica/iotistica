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
import { buildApiUrl } from '@/config/api';
import type { MetricDataCardConfig } from './MetricDataCard';

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
  const [selectedDevice, setSelectedDevice] = useState<string>(initialConfig?.deviceName || '');
  const [selectedMetric, setSelectedMetric] = useState<string>(initialConfig?.metricName || '');
  const [chartType, setChartType] = useState<'line' | 'area' | 'bar'>(initialConfig?.chartType || 'line');
  const [timeRange, setTimeRange] = useState<'1h' | '6h' | '12h' | '24h' | '7d' | '30d'>(initialConfig?.timeRange || '1h');
  const [title, setTitle] = useState<string>(initialConfig?.title || '');
  const [loading, setLoading] = useState(false);
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);

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
      title: title || undefined,
      showStats: true,
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
            <Label htmlFor="device">Device</Label>
            <Select value={selectedDevice} onValueChange={setSelectedDevice}>
              <SelectTrigger id="device">
                <SelectValue placeholder="Select device" />
              </SelectTrigger>
              <SelectContent>
                {loading ? (
                  <SelectItem value="loading" disabled>
                    Loading devices...
                  </SelectItem>
                ) : devices.length === 0 ? (
                  <SelectItem value="none" disabled>
                    No devices found
                  </SelectItem>
                ) : (
                  devices.map((device) => (
                    <SelectItem key={device.device_name} value={device.device_name}>
                      {device.device_name} ({device.protocol}) - {device.metric_count} metrics
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
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
            <Label htmlFor="title">Custom Title (Optional)</Label>
            <Input
              id="title"
              placeholder="Leave empty for auto-generated title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
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
