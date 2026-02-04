import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Cpu, HardDrive, MemoryStick, Package, Network, Loader2 } from "lucide-react";
import { Card } from "./ui/card";
import { useWebSocket } from "@/hooks/useWebSocket";
import type { SystemInfoData, ProcessData, MetricsHistoryData } from "@/services/websocket";
import { MetricCard } from "./ui/metric-card";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { Device } from "./DeviceSidebar";
import { DeviceActions } from "./DeviceActions";
import { ApplicationsCard, Application } from "./ApplicationsCard";
import { NetworkingCard, NetworkInterface } from "./NetworkingCard";
import { AnalyticsCard } from "./AnalyticsCard";
import { GeneralInfoCard } from "./GeneralInfoCard";
import { buildApiUrl } from "@/config/api";

const MAX_POINTS = 60; // Keep last 60 points (30 minutes)

// Helper to convert period to minutes
const getPeriodMinutes = (period: '30min' | '6h' | '12h' | '24h'): number => {
  const map = { '30min': 30, '6h': 360, '12h': 720, '24h': 1440 };
  return map[period];
};

interface SystemMetricsProps {
  device: Device;
  networkInterfaces?: NetworkInterface[];
}

export function SystemMetrics({ 
  device,
  networkInterfaces = []
}: SystemMetricsProps) {
  const [selectedMetric, setSelectedMetric] = useState<'cpu' | 'memory' | 'network'>('cpu');
  const [timePeriod, setTimePeriod] = useState<'30min' | '6h' | '12h' | '24h'>('30min');
  
  // Local state for history data (populated by WebSocket for 30min, API for longer periods)
  const [cpuHistory, setCpuHistory] = useState<Array<{ time: string; value: number }>>([]);
  const [memoryHistory, setMemoryHistory] = useState<Array<{ time: string; used: number; available: number }>>([]);
  const [networkHistory, setNetworkHistory] = useState<Array<{ time: string; download: number; upload: number }>>([]);
  
  // Check if we're still waiting for initial data
  const isLoading = device.cpu === 0 && device.memory === 0 && device.disk === 0;

  // Calculate trends from history data
  const calculateTrend = (history: Array<{ value?: number; used?: number }>): { trend: "up" | "down" | "neutral"; trendValue: string } => {
    if (history.length < 2) return { trend: "neutral", trendValue: "" };
    
    // Get the average of the last 5 data points (or less if not enough data)
    const recentPoints = history.slice(-5);
    const avgRecent = recentPoints.reduce((sum, point) => sum + (point.value || point.used || 0), 0) / recentPoints.length;
    
    // Get the average of the 5 points before that (or start of history)
    const olderPoints = history.slice(Math.max(0, history.length - 10), Math.max(0, history.length - 5));
    if (olderPoints.length === 0) return { trend: "neutral", trendValue: "" };
    
    const avgOlder = olderPoints.reduce((sum, point) => sum + (point.value || point.used || 0), 0) / olderPoints.length;
    
    const change = avgRecent - avgOlder;
    const percentChange = avgOlder > 0 ? (change / avgOlder) * 100 : 0;
    
    if (Math.abs(percentChange) < 2) return { trend: "neutral", trendValue: "" };
    
    return {
      trend: change > 0 ? "up" : "down",
      trendValue: `${change > 0 ? "+" : ""}${percentChange.toFixed(1)}%`
    };
  };

  const cpuTrend = calculateTrend(cpuHistory);
  const memoryTrend = calculateTrend(memoryHistory);
  // For disk, we don't have history, so just show neutral
  const diskTrend = { trend: "neutral" as const, trendValue: "" };

  // Calculate network stats
  const calculateNetworkTrend = (history: Array<{ download: number; upload: number }>): { trend: "up" | "down" | "neutral"; trendValue: string } => {
    if (history.length < 2) return { trend: "neutral", trendValue: "" };
    
    const recentPoints = history.slice(-5);
    const avgRecentTotal = recentPoints.reduce((sum, point) => sum + point.download + point.upload, 0) / recentPoints.length;
    
    const olderPoints = history.slice(Math.max(0, history.length - 10), Math.max(0, history.length - 5));
    if (olderPoints.length === 0) return { trend: "neutral", trendValue: "" };
    
    const avgOlderTotal = olderPoints.reduce((sum, point) => sum + point.download + point.upload, 0) / olderPoints.length;
    
    const change = avgRecentTotal - avgOlderTotal;
    const percentChange = avgOlderTotal > 0 ? (change / avgOlderTotal) * 100 : 0;
    
    if (Math.abs(percentChange) < 2) return { trend: "neutral", trendValue: "" };
    
    return {
      trend: change > 0 ? "up" : "down",
      trendValue: `${change > 0 ? "+" : ""}${percentChange.toFixed(1)}%`
    };
  };

  const networkTrend = calculateNetworkTrend(networkHistory);
  
  // Get current network speed (last data point or 0)
  const currentNetworkSpeed = networkHistory.length > 0 
    ? networkHistory[networkHistory.length - 1].download + networkHistory[networkHistory.length - 1].upload
    : 0;
  
  const formatNetworkSpeed = (kbps: number): string => {
    // Handle NaN or invalid values
    if (!kbps || isNaN(kbps) || kbps < 0) return '0 KB/s';
    if (kbps < 1024) return `${kbps.toFixed(0)} KB/s`;
    const mbps = kbps / 1024;
    return `${mbps.toFixed(1)} MB/s`;
  };

  const metrics = [
    {
      icon: Cpu,
      label: "CPU Usage",
      value: `${device.cpu}%`,
      color: "blue",
      trend: cpuTrend.trend,
      trendValue: cpuTrend.trendValue,
    },
    {
      icon: MemoryStick,
      label: "Memory",
      value: `${device.memory}%`,
      color: "purple",
      trend: memoryTrend.trend,
      trendValue: memoryTrend.trendValue,
    },
    {
      icon: HardDrive,
      label: "Disk Usage",
      value: `${device.disk}%`,
      color: "green",
      trend: diskTrend.trend,
      trendValue: diskTrend.trendValue,
    },
    {
      icon: Network,
      label: "Network",
      value: formatNetworkSpeed(currentNetworkSpeed),
      color: "orange",
      trend: networkTrend.trend,
      trendValue: networkTrend.trendValue,
    },
  ];

  // Fetch system info and processes from API
  const [systemInfo, setSystemInfo] = useState([
    { label: "Operating System", value: "Unknown" },
    { label: "Architecture", value: "Unknown" },
    { label: "Uptime", value: "Unknown" },
    { label: "Hostname", value: device.name },
    { label: "IP Address", value: device.ipAddress },
    { label: "MAC Address", value: "Unknown" },
  ]);

  const [processes, setProcesses] = useState<Array<{
    pid: number;
    name: string;
    cpu: number;
    mem: number;
    command?: string;
  }>>([]);
  const [processesLoading, setProcessesLoading] = useState(true);

  // Format uptime from seconds to human readable
  const formatUptime = useCallback((seconds: number): string => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days > 0) parts.push(`${days} day${days !== 1 ? 's' : ''}`);
    if (hours > 0) parts.push(`${hours} hour${hours !== 1 ? 's' : ''}`);
    if (minutes > 0) parts.push(`${minutes} minute${minutes !== 1 ? 's' : ''}`);
    return parts.length > 0 ? parts.join(', ') : 'Less than a minute';
  }, []);

  // Handle system info updates via WebSocket
  const handleSystemInfo = useCallback((data: SystemInfoData) => {
    const osVersion = data.os || '';
    const osMatch = osVersion.match(/^([^0-9]+)/);
    const os = osMatch ? osMatch[1].trim() : (osVersion || 'Unknown');
    
    setSystemInfo([
      { label: "Operating System", value: os },
      { label: "Architecture", value: data.architecture || "Unknown" },
      { label: "Uptime", value: data.uptime ? formatUptime(data.uptime) : "Unknown" },
      { label: "Hostname", value: data.hostname || device.name },
      { label: "IP Address", value: device.ipAddress },
      { label: "MAC Address", value: data.macAddress || device.macAddress || "Unknown" },
    ]);
  }, [device.name, device.ipAddress, device.macAddress, formatUptime]);

  // Handle processes updates via WebSocket
  const handleProcesses = useCallback((data: { top_processes: ProcessData[] }) => {
    if (data.top_processes && Array.isArray(data.top_processes)) {
      setProcesses(data.top_processes);
      setProcessesLoading(false);
    }
  }, []);

  // Fetch historical data from API
  const fetchHistoricalData = useCallback(async (period: string) => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        buildApiUrl(`/api/v1/devices/${device.deviceUuid}/metrics?period=${period}`),
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      if (!response.ok) {
        console.error('[SystemMetrics] Metrics fetch failed:', response.status, response.statusText);
        return;
      }
      
      const data = await response.json();
      console.log('[SystemMetrics] Fetched metrics:', { period, count: data.metrics?.length, data });
      
      const cpu: Array<{ time: string; value: number }> = [];
      const memory: Array<{ time: string; used: number; available: number }> = [];
      const network: Array<{ time: string; download: number; upload: number }> = [];
      
      // Log time range of data
      if (data.metrics.length > 0) {
        const firstTime = new Date(data.metrics[0].recorded_at);
        const lastTime = new Date(data.metrics[data.metrics.length - 1].recorded_at);
        const spanMinutes = (lastTime.getTime() - firstTime.getTime()) / 60000;
        console.log('[SystemMetrics] Data time range:', {
          first: firstTime.toISOString(),
          last: lastTime.toISOString(),
          spanMinutes: Math.round(spanMinutes),
          expectedMinutes: period === '30min' ? 30 : period === '6h' ? 360 : period === '12h' ? 720 : 1440
        });
      }
      
      // Format time based on period
      const formatTime = (timestamp: string) => {
        const date = new Date(timestamp);
        if (period === '30min') {
          return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          return date.toLocaleString([], { 
            month: 'short', 
            day: 'numeric', 
            hour: '2-digit', 
            minute: '2-digit' 
          });
        }
      };
      
      if (data.metrics && data.metrics.length > 0) {
        data.metrics.forEach((m: any) => {
          const time = formatTime(m.recorded_at);
          cpu.push({ time, value: Math.round(m.cpu_usage || 0) });
          memory.push({ 
            time, 
            used: Math.round(m.memory_usage || 0)
          });
          network.push({
            time,
            download: Math.round((m.network_rx_rate || 0) / 1024),
            upload: Math.round((m.network_tx_rate || 0) / 1024)
          });
        });
      }
      
      setCpuHistory(cpu);
      setMemoryHistory(memory);
      setNetworkHistory(network);
    } catch (error) {
      console.error('Failed to fetch historical data:', error);
    }
  }, [device.deviceUuid]);

  // Handle metrics history updates via WebSocket (append live data only for 30min period)
  const handleMetricsHistory = useCallback((data: MetricsHistoryData) => {
    console.log('[SystemMetrics] handleMetricsHistory called:', {
      deviceUuid: device.deviceUuid.substring(0, 8) + '...',
      timePeriod,
      hasCpuData: !!data?.cpu,
      cpuLength: data?.cpu?.length,
      hasMemoryData: !!data?.memory,
      memoryLength: data?.memory?.length,
      hasNetworkData: !!data?.network,
      networkLength: data?.network?.length,
      firstCpuPoint: data?.cpu?.[0],
      firstMemoryPoint: data?.memory?.[0]
    });
    
    // Only append live data for 30min period, ignore for historical periods
    if (timePeriod !== '30min') {
      console.log('[SystemMetrics] Ignoring history data - not in 30min period');
      return;
    }
    
    // Format timestamps from WebSocket to match API format
    const formatTime = (timestamp: string) => {
      const date = new Date(timestamp);
      // Filter out invalid dates
      if (isNaN(date.getTime())) {
        console.warn('[SystemMetrics] Invalid timestamp:', timestamp);
        return null;
      }
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };
    
    if (data.cpu && data.cpu.length > 0) {
      console.log(`[SystemMetrics] Updating CPU history: adding ${data.cpu.length} points`);
      setCpuHistory(prev => {
        const formatted = data.cpu
          .map(point => {
            const time = formatTime(point.time);
            return time ? { time, value: point.value } : null;
          })
          .filter((point): point is { time: string; value: number } => point !== null);
        
        // Remove duplicates by time
        const combined = [...prev, ...formatted];
        const unique = combined.filter((point, index, self) => 
          index === self.findIndex(p => p.time === point.time)
        );
        const updated = unique.slice(-MAX_POINTS);
        console.log(`[SystemMetrics] CPU history updated: ${prev.length} -> ${updated.length} points (${formatted.length} new, ${combined.length - unique.length} duplicates removed)`);
        return updated;
      });
    }
    if (data.memory && data.memory.length > 0) {
      console.log(`[SystemMetrics] Updating memory history: adding ${data.memory.length} points`);
      setMemoryHistory(prev => {
        const formatted = data.memory
          .map(point => {
            const time = formatTime(point.time);
            return time ? { time, used: point.used } : null;
          })
          .filter((point): point is { time: string; used: number } => point !== null);
        
        // Remove duplicates by time
        const combined = [...prev, ...formatted];
        const unique = combined.filter((point, index, self) => 
          index === self.findIndex(p => p.time === point.time)
        );
        return unique.slice(-MAX_POINTS);
      });
    }
    if (data.network && data.network.length > 0) {
      console.log(`[SystemMetrics] Updating network history: adding ${data.network.length} points`);
      setNetworkHistory(prev => {
        const formatted = data.network
          .map(point => {
            const time = formatTime(point.time);
            return time ? { time, download: point.download, upload: point.upload } : null;
          })
          .filter((point): point is { time: string; download: number; upload: number } => point !== null);
        
        // Remove duplicates by time
        const combined = [...prev, ...formatted];
        const unique = combined.filter((point, index, self) => 
          index === self.findIndex(p => p.time === point.time)
        );
        return unique.slice(-MAX_POINTS);
      });
    }
  }, [timePeriod, device.deviceUuid]);

  // Subscribe to WebSocket channels
  useWebSocket(device.deviceUuid, 'system-info', handleSystemInfo);
  useWebSocket(device.deviceUuid, 'processes', handleProcesses);
  // Only subscribe to history channel for 30min period (live updates)
  useWebSocket(device.deviceUuid, 'history', timePeriod === '30min' ? handleMetricsHistory : () => {});

  // Fetch historical data when time period changes
  // For all periods (including 30min), fetch initial data from API
  // Then WebSocket provides live updates for 30min period only
  useEffect(() => {
    console.log('[SystemMetrics] Time period changed to:', timePeriod);
    console.log('[SystemMetrics] Fetching historical data from API');
    fetchHistoricalData(timePeriod);
  }, [timePeriod, fetchHistoricalData]);

  // Clear data when device changes
  useEffect(() => {
    setSystemInfo([
      { label: "Operating System", value: "Unknown" },
      { label: "Architecture", value: "Unknown" },
      { label: "Uptime", value: "Unknown" },
      { label: "Hostname", value: device.name },
      { label: "IP Address", value: device.ipAddress },
      { label: "MAC Address", value: "Unknown" },
    ]);
    setProcesses([]);
    setProcessesLoading(true);
    setCpuHistory([]);
    setMemoryHistory([]);
    setNetworkHistory([]);
  }, [device.deviceUuid, device.name, device.ipAddress]);

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Quick Metrics */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {metrics.map((metric, index) => (
            <MetricCard
              key={index}
              label={metric.label}
              value={metric.value}
              icon={metric.icon}
              iconColor={metric.color as "blue" | "purple" | "green" | "orange"}
              trend={metric.trend}
              trendValue={metric.trendValue}
              loading={isLoading}
            />
          ))}
        </div>

        {/* Cards in 2-Column Layout */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Telemetry Chart - Combined CPU, Memory, and Network */}
          <Card className="p-4 md:p-6">
            <div className="mb-4 space-y-3">
              <div>
                <h3 className="text-lg text-foreground font-medium mb-1">Telemetry</h3>
                <p className="text-sm text-muted-foreground">System performance metrics</p>
              </div>
              <div className="flex items-center gap-2">
                <Select value={timePeriod} onValueChange={(value: any) => setTimePeriod(value)}>
                  <SelectTrigger className="w-[120px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30min">30 minutes</SelectItem>
                    <SelectItem value="6h">6 hours</SelectItem>
                    <SelectItem value="12h">12 hours</SelectItem>
                    <SelectItem value="24h">24 hours</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={selectedMetric} onValueChange={(value: any) => setSelectedMetric(value)}>
                  <SelectTrigger className="w-[140px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cpu">CPU Usage</SelectItem>
                    <SelectItem value="memory">Memory Usage</SelectItem>
                    <SelectItem value="network">Network Activity</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {selectedMetric === 'cpu' && (
              <>
                {console.log('[SystemMetrics] Rendering CPU chart with', cpuHistory.length, 'points')}
                <ResponsiveContainer width="100%" height={250} key="cpu-chart">
                      <AreaChart data={cpuHistory} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                        <defs>
                          <linearGradient id="colorCpu" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis 
                          dataKey="time" 
                          stroke="#6b7280" 
                          tick={{ fontSize: 10 }} 
                          interval={0}
                          angle={0}
                          textAnchor="middle"
                          height={40}
                        />
                        <YAxis 
                          stroke="#6b7280" 
                          width={50} 
                          tick={{ fontSize: 10 }} 
                          domain={[0, 100]} 
                          tickFormatter={(value) => `${value}%`}
                        />
                        <Tooltip />
                        <Area
                          type="linear"
                          dataKey="value"
                          stroke="#3b82f6"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorCpu)"
                          isAnimationActive={false}
                          dot={{ fill: '#3b82f6', r: 3 }}
                          activeDot={{ r: 5 }}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
              </>
            )}

            {selectedMetric === 'memory' && (
              <>
                  <ResponsiveContainer width="100%" height={250} key="memory-chart">
                    <AreaChart data={memoryHistory} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                  <defs>
                    <linearGradient id="colorMemory" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis 
                    dataKey="time" 
                    stroke="#6b7280" 
                    tick={{ fontSize: 10 }} 
                    interval={0}
                    angle={0}
                    textAnchor="middle"
                    height={40}
                  />
                  <YAxis 
                    stroke="#6b7280" 
                    width={60} 
                    tick={{ fontSize: 10 }} 
                    domain={[0, (dataMax: number) => Math.ceil(dataMax / 1000) * 1000]} 
                    tickFormatter={(value) => `${value} MB`}
                    tickCount={6}
                  />
                  <Tooltip />
                  <Area
                    type="linear"
                    dataKey="used"
                    name="Used Memory"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorMemory)"
                    isAnimationActive={false}
                    dot={{ fill: '#8b5cf6', r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
              </>
            )}

            {selectedMetric === 'network' && (
              <>
                  <ResponsiveContainer width="100%" height={250} key="network-chart">
                    <LineChart data={networkHistory} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                      <XAxis 
                        dataKey="time" 
                        stroke="#6b7280" 
                        tick={{ fontSize: 10 }} 
                        interval={0}
                        angle={0}
                        textAnchor="middle"
                        height={40}
                      />
                      <YAxis stroke="#6b7280" width={40} tick={{ fontSize: 10 }} domain={[0, 'auto']} />
                      <Tooltip />
                      <Legend />
                      <Line
                        type="linear"
                        dataKey="download"
                        stroke="#3b82f6"
                        strokeWidth={2}
                        dot={{ fill: '#3b82f6', r: 3 }}
                        activeDot={{ r: 5 }}
                        isAnimationActive={false}
                      />
                      <Line
                        type="linear"
                        dataKey="upload"
                        stroke="#10b981"
                        strokeWidth={2}
                        dot={{ fill: '#10b981', r: 3 }}
                        activeDot={{ r: 5 }}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
              </>
            )}
          </Card>

          {/* System Info */}
          <GeneralInfoCard systemInfo={systemInfo} />

          {/* Network Interfaces */}
          <NetworkingCard interfaces={networkInterfaces} />

          {/* Analytics Card */}
          <div id="analytics-section">
            <AnalyticsCard 
              deviceName={device.name} 
              deviceId={device.deviceUuid} 
              processes={processes.map(p => ({
                name: p.name,
                pid: p.pid,
                cpu: p.cpu,
                memory: p.mem, // Map mem to memory for AnalyticsCard
              }))} 
              provisioned={device.status !== 'pending'}
            />
          </div>
        </div>

        {/* Top Processes */}
        <Card className="p-4 md:p-6" id="processes-section">
          <div className="mb-4">
            <h3 className="text-lg text-foreground font-medium mb-1">Top Processes</h3>
            <p className="text-sm text-muted-foreground">Most resource-intensive processes</p>
          </div>
          {processesLoading ? (
            <div className="text-center py-8 text-muted-foreground">Loading processes...</div>
          ) : processes.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">No process data available</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-0 text-sm font-medium text-muted-foreground">Process</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground hidden sm:table-cell">PID</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground">CPU %</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground hidden md:table-cell">Memory %</th>
                    <th className="text-left py-3 px-4 text-sm font-medium text-muted-foreground hidden lg:table-cell">CPU Usage</th>
                  </tr>
                </thead>
                <tbody>
                  {processes.map((process, index) => (
                    <tr key={index} className="border-b border-border last:border-0">
                      <td className="py-3 px-0 text-foreground truncate max-w-[150px]">
                        {process.name}
                      </td>
                      <td className="py-3 px-4 text-muted-foreground hidden sm:table-cell">{process.pid}</td>
                      <td className="py-3 px-4 text-foreground">{process.cpu.toFixed(1)}%</td>
                      <td className="py-3 px-4 text-foreground hidden md:table-cell">{process.mem.toFixed(1)}%</td>
                      <td className="py-3 px-4 hidden lg:table-cell">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-muted rounded-full h-2 max-w-[120px]">
                            <div
                              className="bg-blue-600 h-2 rounded-full transition-all"
                              style={{ width: `${Math.min(process.cpu * 5, 100)}%` }}
                            />
                          </div>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
