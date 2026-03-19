import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { MetricValueCardConfig } from './MetricValueCard';
import { buildApiUrl } from '@/config/api';

interface MetricValueCardConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: MetricValueCardConfig) => void;
  initialConfig?: MetricValueCardConfig;
}

interface EndpointDevice {
  agent_uuid: string;
  agent_name: string;
  device_name: string;
  protocol: string;
  available_metrics: string[];
  metric_count: number;
  last_seen: string;
  agent_count?: number;
  agent_uuids?: string[];
  agent_names?: string[];
}

interface AgentOption {
  uuid: string;
  name: string;
}

const MetricValueCardConfigDialog: React.FC<MetricValueCardConfigDialogProps> = ({
  open,
  onOpenChange,
  onSave,
  initialConfig,
}) => {
  const [selectedDevice, setSelectedDevice] = useState('');
  const [selectedAgentUuid, setSelectedAgentUuid] = useState('');
  const [selectedMetric, setSelectedMetric] = useState('');
  const [timeRange, setTimeRange] = useState<'1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d'>('1h');
  const [title, setTitle] = useState('');
  const [showSparkline, setShowSparkline] = useState(true);
  const [warningThreshold, setWarningThreshold] = useState<string>('');
  const [criticalThreshold, setCriticalThreshold] = useState<string>('');
  const [enableWarning, setEnableWarning] = useState(false);
  const[enableCritical, setEnableCritical] = useState(false);
  
  const [devices, setDevices] = useState<EndpointDevice[]>([]);
  const [availableMetrics, setAvailableMetrics] = useState<string[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(false);

  // Fetch devices on mount
  useEffect(() => {
    if (open) {
      fetchDevices();
    }
  }, [open]);

  // Extract available metrics when device changes
  useEffect(() => {
    if (selectedDevice) {
      const device = devices.find(d => d.device_name === selectedDevice);
      if (device) {
        setAvailableMetrics(device.available_metrics);
      }
    }
  }, [selectedDevice, devices]);

  // Update form fields when initialConfig changes (for editing existing widgets)
  useEffect(() => {
    if (open && initialConfig) {
      setSelectedAgentUuid(initialConfig.agentUuid || '');
      setSelectedDevice(initialConfig.deviceName || '');
      setSelectedMetric(initialConfig.metricName || '');
      setTimeRange(initialConfig.timeRange || '1h');
      setTitle(initialConfig.title || '');
      setShowSparkline(initialConfig.showSparkline ?? true);
      setWarningThreshold(initialConfig.warningThreshold?.toString() || '');
      setCriticalThreshold(initialConfig.criticalThreshold?.toString() || '');
      setEnableWarning(initialConfig.warningThreshold !== undefined);
      setEnableCritical(initialConfig.criticalThreshold !== undefined);
    } else if (open && !initialConfig) {
      // Reset form for new widget
      setSelectedAgentUuid('');
      setSelectedDevice('');
      setSelectedMetric('');
      setTimeRange('1h');
      setTitle('');
      setShowSparkline(true);
      setWarningThreshold('');
      setCriticalThreshold('');
      setEnableWarning(false);
      setEnableCritical(false);
    }
  }, [open, initialConfig]);

  const fetchDevices = async () => {
    setLoadingDevices(true);
    try {
      const token = localStorage.getItem('accessToken');
      const response = await fetch(buildApiUrl('/api/v1/metrics/devices'), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      const data = await response.json();
      setDevices(data.devices || []);
    } catch (error) {
      console.error('Error fetching devices:', error);
    } finally {
      setLoadingDevices(false);
    }
  };

  const agentOptions: AgentOption[] = Array.from(
    devices.reduce((acc, device) => {
      const uuids = Array.isArray(device.agent_uuids) && device.agent_uuids.length > 0
        ? device.agent_uuids
        : (device.agent_uuid ? [device.agent_uuid] : []);
      const names = Array.isArray(device.agent_names) && device.agent_names.length > 0
        ? device.agent_names
        : (device.agent_name ? [device.agent_name] : []);

      uuids.forEach((uuid, index) => {
        if (!uuid || acc.has(uuid)) return;
        acc.set(uuid, {
          uuid,
          name: (names[index] || '').trim() || `Agent ${uuid.slice(0, 8)}`,
        });
      });
      return acc;
    }, new Map<string, AgentOption>()).values()
  ).sort((a, b) => a.name.localeCompare(b.name));

  const filteredDevices = selectedAgentUuid
    ? devices.filter((device) => {
        if (Array.isArray(device.agent_uuids) && device.agent_uuids.includes(selectedAgentUuid)) return true;
        return device.agent_uuid === selectedAgentUuid;
      })
    : devices;

  useEffect(() => {
    if (!selectedDevice) return;
    const stillVisible = filteredDevices.some((d) => d.device_name === selectedDevice);
    if (!stillVisible) {
      setSelectedDevice('');
      setSelectedMetric('');
      setAvailableMetrics([]);
    }
  }, [selectedAgentUuid, filteredDevices, selectedDevice]);



  const handleSave = () => {
    if (!selectedDevice || !selectedMetric) {
      return;
    }

    const config: MetricValueCardConfig = {
      widgetId: initialConfig?.widgetId || `metric-value-${Date.now()}`,
      agentUuid: selectedAgentUuid || undefined,
      deviceName: selectedDevice,
      metricName: selectedMetric,
      timeRange,
      title: title || undefined,
      showSparkline,
      warningThreshold: enableWarning && warningThreshold ? parseFloat(warningThreshold) : undefined,
      criticalThreshold: enableCritical && criticalThreshold ? parseFloat(criticalThreshold) : undefined,
    };

    onSave(config);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Metric Value Card</DialogTitle>
          <DialogDescription>
            Display the latest value of a metric with trend and sparkline
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="agent">Agent</Label>
            <Select
              value={selectedAgentUuid || 'all'}
              onValueChange={(value) => setSelectedAgentUuid(value === 'all' ? '' : value)}
            >
              <SelectTrigger id="agent">
                <SelectValue placeholder="All agents" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agentOptions.map((agent) => (
                  <SelectItem key={agent.uuid} value={agent.uuid}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="device">Device</Label>
            <Select value={selectedDevice} onValueChange={setSelectedDevice}>
              <SelectTrigger id="device">
                <SelectValue placeholder="Select device" />
              </SelectTrigger>
              <SelectContent>
                {loadingDevices ? (
                  <SelectItem value="loading" disabled>
                    Loading devices...
                  </SelectItem>
                ) : filteredDevices.length === 0 ? (
                  <SelectItem value="none" disabled>
                    {selectedAgentUuid ? 'No devices for selected agent' : 'No devices available'}
                  </SelectItem>
                ) : (
                  filteredDevices.map((device) => (
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
                  availableMetrics.map((metricName) => (
                    <SelectItem key={metricName} value={metricName}>
                      {metricName}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="timeRange">Time Range</Label>
            <Select value={timeRange} onValueChange={(value: any) => setTimeRange(value)}>
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
            <Label htmlFor="title">Custom Title (Optional)</Label>
            <Input
              id="title"
              placeholder="Leave empty for metric name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="sparkline"
              checked={showSparkline}
              onCheckedChange={(checked) => setShowSparkline(checked === true)}
            />
            <Label htmlFor="sparkline" className="cursor-pointer">
              Show Sparkline
            </Label>
          </div>

          {/* Thresholds Section */}
          <div className="grid gap-2 pt-2">
            <Label>Thresholds</Label>
            
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id="warning-threshold"
                  checked={enableWarning}
                  onCheckedChange={(checked) => setEnableWarning(checked === true)}
                />
                <Label htmlFor="warning-threshold" className="text-sm cursor-pointer">
                  Warning Threshold
                </Label>
              </div>
              {enableWarning && (
                <Input
                  type="number"
                  step="any"
                  placeholder="Warning value"
                  value={warningThreshold}
                  onChange={(e) => setWarningThreshold(e.target.value)}
                />
              )}

              <div className="flex items-center gap-2">
                <Checkbox
                  id="critical-threshold"
                  checked={enableCritical}
                  onCheckedChange={(checked) => setEnableCritical(checked === true)}
                />
                <Label htmlFor="critical-threshold" className="text-sm cursor-pointer">
                  Critical Threshold
                </Label>
              </div>
              {enableCritical && (
                <Input
                  type="number"
                  step="any"
                  placeholder="Critical value"
                  value={criticalThreshold}
                  onChange={(e) => setCriticalThreshold(e.target.value)}
                />
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!selectedDevice || !selectedMetric}>
            Save Widget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MetricValueCardConfigDialog;
