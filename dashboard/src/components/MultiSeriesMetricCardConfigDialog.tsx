import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
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
import { Badge } from './ui/badge';
import { Checkbox } from './ui/checkbox';
import { cn } from './ui/utils';
import { buildApiUrl } from '@/config/api';
import {
  type MultiSeriesMetricCardConfig,
  getDefaultSeriesColor,
} from './MultiSeriesMetricCard';
import { Check, ChevronsUpDown } from 'lucide-react';

interface MultiSeriesMetricCardConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: MultiSeriesMetricCardConfig) => void;
  initialConfig?: MultiSeriesMetricCardConfig;
}

interface MetricSourceRef {
  agentUuid?: string;
  agent_uuid?: string;
  deviceUuid: string;
  endpointUuid: string;
  agentName?: string;
  endpointName?: string;
}

interface EndpointDevice {
  device_name: string;
  available_metrics: string[];
  source_refs?: MetricSourceRef[];
  agent_uuids?: string[];
  agent_names?: string[];
}

interface RegisteredAgent {
  uuid: string;
  name: string;
  isOnline: boolean;
}

interface AgentsResponse {
  agents?: EndpointDevice[];
}

interface RegistryAgentRecord {
  uuid?: string;
  name?: string;
  is_online?: boolean;
}

interface RegistryAgentsResponse {
  agents?: RegistryAgentRecord[];
  devices?: RegistryAgentRecord[];
}

const sourceRefAgentUuid = (sourceRef: MetricSourceRef): string | undefined => sourceRef.agentUuid || sourceRef.agent_uuid;

export function MultiSeriesMetricCardConfigDialog({
  open,
  onOpenChange,
  onSave,
  initialConfig,
}: MultiSeriesMetricCardConfigDialogProps) {
  const [devices, setDevices] = useState<EndpointDevice[]>([]);
  const [registeredAgents, setRegisteredAgents] = useState<RegisteredAgent[]>([]);
  const [loading, setLoading] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [selectedAgentUuid, setSelectedAgentUuid] = useState(initialConfig?.agentUuid || '');
  const [selectedDevice, setSelectedDevice] = useState(initialConfig?.deviceName || '');
  const [selectedSourceKey, setSelectedSourceKey] = useState(
    initialConfig?.deviceUuid && initialConfig?.endpointUuid
      ? `${initialConfig.deviceUuid}:${initialConfig.endpointUuid}`
      : '',
  );
  const [selectedMetrics, setSelectedMetrics] = useState<string[]>(initialConfig?.metrics.map((metric) => metric.metricName) || []);
  const [timeRange, setTimeRange] = useState<MultiSeriesMetricCardConfig['timeRange']>(initialConfig?.timeRange || '1h');
  const [chartType, setChartType] = useState<MultiSeriesMetricCardConfig['chartType']>(initialConfig?.chartType || 'line');
  const [showLegend, setShowLegend] = useState(initialConfig?.showLegend ?? true);
  const [title, setTitle] = useState(initialConfig?.title || '');

  useEffect(() => {
    if (open && initialConfig) {
      setSelectedAgentUuid(initialConfig.agentUuid || '');
      setSelectedDevice(initialConfig.deviceName || '');
      setSelectedSourceKey(
        initialConfig.deviceUuid && initialConfig.endpointUuid
          ? `${initialConfig.deviceUuid}:${initialConfig.endpointUuid}`
          : '',
      );
      setSelectedMetrics(initialConfig.metrics.map((metric) => metric.metricName));
      setTimeRange(initialConfig.timeRange || '1h');
      setChartType(initialConfig.chartType || 'line');
      setShowLegend(initialConfig.showLegend ?? true);
      setTitle(initialConfig.title || '');
    } else if (open && !initialConfig) {
      setSelectedAgentUuid('');
      setSelectedDevice('');
      setSelectedSourceKey('');
      setSelectedMetrics([]);
      setTimeRange('1h');
      setChartType('line');
      setShowLegend(true);
      setTitle('');
    }
  }, [initialConfig, open]);

  useEffect(() => {
    if (!open || devices.length > 0 || loading) {
      return;
    }

    const fetchDevices = async () => {
      try {
        setLoading(true);

        const token = localStorage.getItem('accessToken');
        const metricsResponse = await fetch(buildApiUrl('/api/v1/metrics/agents'), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!metricsResponse.ok) {
          throw new Error('Failed to fetch metric sources');
        }

        const metricsResult = await metricsResponse.json() as AgentsResponse;
        setDevices(Array.isArray(metricsResult.agents) ? metricsResult.agents : []);

        const registryResponse = await fetch(buildApiUrl('/api/v1/agents?limit=1000'), {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!registryResponse.ok) {
          setRegisteredAgents([]);
          return;
        }

        const registryResult = await registryResponse.json() as RegistryAgentsResponse;
        const agentRecords = Array.isArray(registryResult.agents)
          ? registryResult.agents
          : (Array.isArray(registryResult.devices) ? registryResult.devices : []);

        setRegisteredAgents(
          agentRecords
            .filter((record): record is Required<Pick<RegistryAgentRecord, 'uuid'>> & RegistryAgentRecord => Boolean(record.uuid))
            .map((record) => ({
              uuid: record.uuid,
              name: (record.name || '').trim() || `Agent ${record.uuid.slice(0, 8)}`,
              isOnline: Boolean(record.is_online),
            })),
        );
      } catch (error) {
        console.error('Error fetching multi-series config options:', error);
      } finally {
        setLoading(false);
      }
    };

    void fetchDevices();
  }, [open, devices.length, loading]);

  const agentOptions = useMemo(() => {
    const map = new Map<string, RegisteredAgent>();

    for (const agent of registeredAgents) {
      map.set(agent.uuid, agent);
    }

    for (const device of devices) {
      const uuids = Array.isArray(device.agent_uuids) ? device.agent_uuids : [];
      const names = Array.isArray(device.agent_names) ? device.agent_names : [];
      uuids.forEach((uuid, index) => {
        if (!uuid || map.has(uuid)) {
          return;
        }

        map.set(uuid, {
          uuid,
          name: (names[index] || '').trim() || `Agent ${uuid.slice(0, 8)}`,
          isOnline: false,
        });
      });

      const sourceRefs = Array.isArray(device.source_refs) ? device.source_refs : [];
      sourceRefs.forEach((sourceRef) => {
        const uuid = sourceRefAgentUuid(sourceRef);
        if (!uuid || map.has(uuid)) {
          return;
        }

        map.set(uuid, {
          uuid,
          name: (sourceRef.agentName || '').trim() || `Agent ${uuid.slice(0, 8)}`,
          isOnline: false,
        });
      });
    }

    return Array.from(map.values()).sort((left, right) => {
      if (left.isOnline !== right.isOnline) {
        return left.isOnline ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
  }, [devices, registeredAgents]);

  const filteredDevices = useMemo(() => {
    if (!selectedAgentUuid) {
      return devices;
    }

    return devices.filter((device) => {
      if (Array.isArray(device.agent_uuids) && device.agent_uuids.includes(selectedAgentUuid)) {
        return true;
      }

      const sourceRefs = Array.isArray(device.source_refs) ? device.source_refs : [];
      return sourceRefs.some((sourceRef) => sourceRefAgentUuid(sourceRef) === selectedAgentUuid);
    });
  }, [devices, selectedAgentUuid]);

  const selectedDeviceData = useMemo(
    () => filteredDevices.find((device) => device.device_name === selectedDevice) || devices.find((device) => device.device_name === selectedDevice),
    [devices, filteredDevices, selectedDevice],
  );

  const selectedDeviceSources = useMemo(() => {
    if (!selectedDeviceData || !Array.isArray(selectedDeviceData.source_refs)) {
      return [] as MetricSourceRef[];
    }

    return selectedDeviceData.source_refs.filter((sourceRef) => {
      if (!sourceRef.deviceUuid || !sourceRef.endpointUuid) {
        return false;
      }

      if (!selectedAgentUuid) {
        return true;
      }

      return sourceRefAgentUuid(sourceRef) === selectedAgentUuid;
    });
  }, [selectedAgentUuid, selectedDeviceData]);

  const selectedSourceRef = useMemo(
    () => selectedDeviceSources.find((sourceRef) => `${sourceRef.deviceUuid}:${sourceRef.endpointUuid}` === selectedSourceKey) || selectedDeviceSources[0],
    [selectedDeviceSources, selectedSourceKey],
  );

  const availableMetrics = selectedDeviceData?.available_metrics || [];

  useEffect(() => {
    if (!selectedDeviceData) {
      setSelectedMetrics([]);
      setSelectedSourceKey('');
      return;
    }

    setSelectedMetrics((currentMetrics) => currentMetrics.filter((metric) => availableMetrics.includes(metric)));

    if (!selectedSourceRef && selectedDeviceSources.length > 0) {
      const source = selectedDeviceSources[0];
      setSelectedSourceKey(`${source.deviceUuid}:${source.endpointUuid}`);
    }
  }, [availableMetrics, selectedDeviceData, selectedDeviceSources, selectedSourceRef]);

  const toggleMetric = (metricName: string) => {
    setSelectedMetrics((currentMetrics) => (
      currentMetrics.includes(metricName)
        ? currentMetrics.filter((name) => name !== metricName)
        : [...currentMetrics, metricName]
    ));
  };

  const canSave = Boolean(selectedDevice && selectedSourceRef?.deviceUuid && selectedMetrics.length > 0);

  const handleSave = () => {
    if (!selectedSourceRef || selectedMetrics.length === 0) {
      return;
    }

    const existingColorByMetric = new Map(
      initialConfig?.metrics.map((metric) => [metric.metricName, metric.color]) || [],
    );

    onSave({
      widgetId: initialConfig?.widgetId || `multi-series-${Date.now()}`,
      title: title.trim() || undefined,
      agentUuid: selectedAgentUuid || sourceRefAgentUuid(selectedSourceRef),
      agentName: selectedSourceRef.agentName,
      endpointName: selectedSourceRef.endpointName,
      deviceUuid: selectedSourceRef.deviceUuid,
      endpointUuid: selectedSourceRef.endpointUuid,
      deviceName: selectedDevice,
      metrics: selectedMetrics.map((metricName, index) => ({
        metricName,
        color: existingColorByMetric.get(metricName) || getDefaultSeriesColor(index),
      })),
      timeRange,
      chartType,
      showLegend,
    });

    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-md">
        <DialogHeader>
          <DialogTitle>Configure Multi-Series Widget</DialogTitle>
          <DialogDescription>
            Select one device and multiple metrics to compare in a single chart.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          <div className="grid gap-2">
            <Label htmlFor="multi-series-title">Title</Label>
            <Input
              id="multi-series-title"
              placeholder="Optional custom title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>

          <div className="grid gap-2 w-fit">
            <Label>Agent</Label>
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={agentOpen} className="w-[320px] justify-between">
                  {selectedAgentUuid
                    ? agentOptions.find((agent) => agent.uuid === selectedAgentUuid)?.name || `Agent ${selectedAgentUuid.slice(0, 8)}`
                    : 'All agents'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[320px] p-0">
                <Command>
                  <CommandInput placeholder="Search agents..." />
                  <CommandList>
                    <CommandEmpty>No agents found.</CommandEmpty>
                    <CommandGroup>
                      <CommandItem
                        value="all agents"
                        onSelect={() => {
                          setSelectedAgentUuid('');
                          setAgentOpen(false);
                        }}
                      >
                        <Check className={cn('mr-2 h-4 w-4', selectedAgentUuid === '' ? 'opacity-100' : 'opacity-0')} />
                        <span>All agents</span>
                      </CommandItem>
                      {agentOptions.map((agent) => (
                        <CommandItem
                          key={agent.uuid}
                          value={`${agent.name} ${agent.uuid}`}
                          onSelect={() => {
                            setSelectedAgentUuid(agent.uuid === selectedAgentUuid ? '' : agent.uuid);
                            setAgentOpen(false);
                          }}
                        >
                          <Check className={cn('mr-2 h-4 w-4', selectedAgentUuid === agent.uuid ? 'opacity-100' : 'opacity-0')} />
                          <div className="flex items-center justify-between w-full gap-2">
                            <span>{agent.name}</span>
                            {!agent.isOnline && (
                              <Badge variant="outline" className="text-xs bg-gray-100 text-gray-600 border-gray-300">
                                Offline
                              </Badge>
                            )}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid gap-2">
            <Label>Device</Label>
            <Popover open={deviceOpen} onOpenChange={setDeviceOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={deviceOpen} className="w-full justify-between">
                  {selectedDevice || 'Select device...'}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0">
                <Command>
                  <CommandInput placeholder="Search devices..." />
                  <CommandList>
                    <CommandEmpty>{loading ? 'Loading devices...' : 'No devices found.'}</CommandEmpty>
                    <CommandGroup>
                      {filteredDevices.map((device) => (
                        <CommandItem
                          key={device.device_name}
                          value={device.device_name}
                          onSelect={(currentValue) => {
                            setSelectedDevice(currentValue === selectedDevice ? '' : currentValue);
                            setDeviceOpen(false);
                          }}
                        >
                          <Check className={cn('mr-2 h-4 w-4', selectedDevice === device.device_name ? 'opacity-100' : 'opacity-0')} />
                          <span>{device.device_name}</span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          <div className="grid gap-2">
            <Label>Metrics</Label>
            <Popover open={metricsOpen} onOpenChange={setMetricsOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" role="combobox" aria-expanded={metricsOpen} className="w-full justify-between">
                  <span className="truncate">
                    {selectedMetrics.length > 0 ? `${selectedMetrics.length} metrics selected` : 'Select metrics...'}
                  </span>
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[400px] p-0">
                <Command>
                  <CommandInput placeholder="Search metrics..." />
                  <CommandList>
                    <CommandEmpty>{selectedDevice ? 'No metrics found.' : 'Select a device first.'}</CommandEmpty>
                    <CommandGroup>
                      {availableMetrics.map((metricName) => {
                        const checked = selectedMetrics.includes(metricName);
                        return (
                          <CommandItem
                            key={metricName}
                            value={metricName}
                            onSelect={() => toggleMetric(metricName)}
                          >
                            <Checkbox checked={checked} className="mr-2" />
                            <span>{metricName}</span>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            {selectedMetrics.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {selectedMetrics.map((metricName, index) => (
                  <Badge key={metricName} variant="secondary" className="gap-2 pr-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: getDefaultSeriesColor(index) }} />
                    {metricName}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Chart Type</Label>
              <Select value={chartType} onValueChange={(value: MultiSeriesMetricCardConfig['chartType']) => setChartType(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="line">Line</SelectItem>
                  <SelectItem value="area">Area</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Time Range</Label>
              <Select value={timeRange} onValueChange={(value: MultiSeriesMetricCardConfig['timeRange']) => setTimeRange(value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1m">1m</SelectItem>
                  <SelectItem value="1h">1h</SelectItem>
                  <SelectItem value="6h">6h</SelectItem>
                  <SelectItem value="12h">12h</SelectItem>
                  <SelectItem value="24h">24h</SelectItem>
                  <SelectItem value="7d">7d</SelectItem>
                  <SelectItem value="30d">30d</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <div>
              <Label className="text-sm">Show Chart Legend</Label>
              <p className="text-xs text-muted-foreground">Display the metric color legend above the chart.</p>
            </div>
            <Checkbox checked={showLegend} onCheckedChange={(checked) => setShowLegend(checked === true)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave}>Save Widget</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}