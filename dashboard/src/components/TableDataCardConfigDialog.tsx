import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Checkbox } from './ui/checkbox';
import { TableDataCardConfig } from './TableDataCard';
import { buildApiUrl } from '../config/api';

interface TableDataCardConfigDialogProps {
  open: boolean;
  onClose: () => void;
  onSave: (config: TableDataCardConfig) => void;
  initialConfig?: TableDataCardConfig;
}

interface EndpointDevice {
  agent_uuid: string;
  agent_name: string;
  device_name: string;
  protocol: string;
  metric_count: string;
  available_metrics: string[];
}

export function TableDataCardConfigDialog({ 
  open, 
  onClose, 
  onSave, 
  initialConfig 
}: TableDataCardConfigDialogProps) {
  const [devices, setDevices] = useState<EndpointDevice[]>([]);
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);
  const [selectedDevice, setSelectedDevice] = useState('');
  const [selectedMetric, setSelectedMetric] = useState('');
  const [timeRange, setTimeRange] = useState('1h');
  const [title, setTitle] = useState('');
  const [pageSize, setPageSize] = useState('10');
  
  const [columns, setColumns] = useState({
    time: true,
    value: true,
    min: false,
    max: false,
    avg: false,
    quality: true
  });

  // Load devices on mount
  useEffect(() => {
    if (open) {
      fetchDevices();
    }
  }, [open]);

  // Sync form with initialConfig when dialog opens
  useEffect(() => {
    if (open && initialConfig) {
      setSelectedDevice(initialConfig.deviceName || '');
      setSelectedMetric(initialConfig.metricName || '');
      setTimeRange(initialConfig.timeRange || '1h');
      setTitle(initialConfig.title || '');
      setPageSize((initialConfig.pageSize || 10).toString());
      setColumns(initialConfig.columns || {
        time: true,
        value: true,
        min: false,
        max: false,
        avg: false,
        quality: true
      });
    } else if (open && !initialConfig) {
      // Reset for new widget
      setSelectedDevice('');
      setSelectedMetric('');
      setTimeRange('1h');
      setTitle('');
      setPageSize('10');
      setColumns({
        time: true,
        value: true,
        min: false,
        max: false,
        avg: false,
        quality: true
      });
    }
  }, [open, initialConfig]);

  // Load metrics when device changes
  useEffect(() => {
    if (selectedDevice) {
      const device = devices.find(d => d.device_name === selectedDevice);
      if (device) {
        setAvailableMetrics(device.available_metrics || []);
      }
    } else {
      setAvailableMetrics([]);
    }
  }, [selectedDevice, devices]);

  const fetchDevices = async () => {
    try {
      const token = localStorage.getItem('accessToken');
      const url = buildApiUrl('/api/v1/metrics/devices');
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (response.ok) {
        const data = await response.json();
        setDevices(data.devices || []);
      } else {
        console.error('Failed to fetch devices:', response.status, response.statusText);
      }
    } catch (error) {
      console.error('Error fetching devices:', error);
    }
  };

  const handleSave = () => {
    const config: TableDataCardConfig = {
      deviceName: selectedDevice,
      metricName: selectedMetric,
      timeRange,
      title: title || `${selectedMetric} - Metrics Table`,
      columns,
      pageSize: parseInt(pageSize, 10)
    };
    onSave(config);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure Table Widget</DialogTitle>
          <DialogDescription>
            Display time-series data in a table format
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Device Selection */}
          <div className="grid gap-2">
            <Label htmlFor="device">Device</Label>
            <Select value={selectedDevice} onValueChange={setSelectedDevice}>
              <SelectTrigger id="device">
                <SelectValue placeholder="Select device" />
              </SelectTrigger>
              <SelectContent>
                {devices.map(device => (
                  <SelectItem key={device.device_name} value={device.device_name}>
                    {device.device_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Metric Selection */}
          <div className="grid gap-2">
            <Label htmlFor="metric">Metric</Label>
            <Select 
              value={selectedMetric} 
              onValueChange={setSelectedMetric}
              disabled={!selectedDevice}
            >
              <SelectTrigger id="metric">
                <SelectValue placeholder="Select metric" />
              </SelectTrigger>
              <SelectContent>
                {availableMetrics.map(metric => (
                  <SelectItem key={metric} value={metric}>
                    {metric}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Time Range */}
          <div className="grid gap-2">
            <Label htmlFor="timeRange">Time Range</Label>
            <Select value={timeRange} onValueChange={setTimeRange}>
              <SelectTrigger id="timeRange">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1h">Last 1 hour</SelectItem>
                <SelectItem value="6h">Last 6 hours</SelectItem>
                <SelectItem value="12h">Last 12 hours</SelectItem>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
                <SelectItem value="30d">Last 30 days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Title */}
          <div className="grid gap-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={selectedMetric ? `${selectedMetric} - Metrics Table` : 'Metrics Table'}
            />
          </div>

          {/* Page Size */}
          <div className="grid gap-2">
            <Label htmlFor="pageSize">Rows per Page</Label>
            <Select value={pageSize} onValueChange={setPageSize}>
              <SelectTrigger id="pageSize">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="10">10</SelectItem>
                <SelectItem value="20">20</SelectItem>
                <SelectItem value="50">50</SelectItem>
                <SelectItem value="100">100</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Column Configuration */}
          <div className="grid gap-2">
            <Label>Columns</Label>
            <div className="grid gap-3 p-3 border rounded-md">
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="col-time" 
                  checked={columns.time}
                  onCheckedChange={(checked) => 
                    setColumns(prev => ({ ...prev, time: checked as boolean }))
                  }
                />
                <label
                  htmlFor="col-time"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Time
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="col-value" 
                  checked={columns.value}
                  onCheckedChange={(checked) => 
                    setColumns(prev => ({ ...prev, value: checked as boolean }))
                  }
                />
                <label
                  htmlFor="col-value"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Value
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="col-min" 
                  checked={columns.min}
                  onCheckedChange={(checked) => 
                    setColumns(prev => ({ ...prev, min: checked as boolean }))
                  }
                />
                <label
                  htmlFor="col-min"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Minimum
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="col-max" 
                  checked={columns.max}
                  onCheckedChange={(checked) => 
                    setColumns(prev => ({ ...prev, max: checked as boolean }))
                  }
                />
                <label
                  htmlFor="col-max"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Maximum
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="col-avg" 
                  checked={columns.avg}
                  onCheckedChange={(checked) => 
                    setColumns(prev => ({ ...prev, avg: checked as boolean }))
                  }
                />
                <label
                  htmlFor="col-avg"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Average
                </label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox 
                  id="col-quality" 
                  checked={columns.quality}
                  onCheckedChange={(checked) => 
                    setColumns(prev => ({ ...prev, quality: checked as boolean }))
                  }
                />
                <label
                  htmlFor="col-quality"
                  className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                >
                  Data Quality
                </label>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleSave}
            disabled={!selectedDevice || !selectedMetric}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
