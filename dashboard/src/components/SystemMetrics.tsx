import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Cpu, HardDrive, MemoryStick, Network, RefreshCw, AlertTriangle, AlertOctagon, Activity, Bell, Info, CheckCircle, XCircle } from "lucide-react";
import { Card } from "./ui/card";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useSystemMetrics } from "@/contexts/SystemMetricsContext";
import type { SystemInfoData, ProcessData } from "@/services/websocket";
import { MetricCard } from "./ui/metric-card";
import { Button } from "./ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
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
  ReferenceLine,
} from "recharts";
import { Device } from "./AgentSidebar";
import { Badge } from "./ui/badge";
import { NetworkingCard, NetworkInterface } from "./NetworkingCard";
import { GeneralInfoCard } from "./GeneralInfoCard";
import { buildApiUrl } from "@/config/api";
import { detectGaps, createGapDotRenderer } from "@/utils/chartGapDetection";

interface SystemMetricsProps {
  device: Device;
  networkInterfaces?: NetworkInterface[];
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

export function SystemMetrics({ 
  device,
  networkInterfaces = []
}: SystemMetricsProps) {
  // Use context for persistent metrics history (survives navigation)
  const { getDeviceHistory, addMetricsDataPoint, getTimePeriod, setTimePeriod: setContextTimePeriod, getSelectedMetric, setSelectedMetric: setContextSelectedMetric } = useSystemMetrics();
  
  // Get persisted history and time period from context
  const persistedHistory = getDeviceHistory(device.deviceUuid);
  const persistedTimePeriod = getTimePeriod(device.deviceUuid);
  const persistedMetric = getSelectedMetric(device.deviceUuid);
  
  // Local state initialized from context
  const [selectedMetric, setSelectedMetric] = useState<'cpu' | 'memory' | 'network'>(persistedMetric);
  const [timePeriod, setTimePeriod] = useState<'30min' | '6h' | '12h' | '24h'>(persistedTimePeriod);
  
  // Refresh interval state with localStorage persistence
  const [refreshInterval, setRefreshInterval] = useState<number>(() => {
    const saved = localStorage.getItem('systemmetrics-refresh-interval');
    return saved ? parseInt(saved, 10) : 30; // Default 30 seconds
  });
  
  // State to track manual refresh loading
  const [isTelemetryRefreshing, setIsTelemetryRefreshing] = useState(false);
  
  // Sync time period changes to context
  useEffect(() => {
    setContextTimePeriod(device.deviceUuid, timePeriod);
  }, [device.deviceUuid, timePeriod, setContextTimePeriod]);
  
  // Sync metric selection changes to context
  useEffect(() => {
    setContextSelectedMetric(device.deviceUuid, selectedMetric);
  }, [device.deviceUuid, selectedMetric, setContextSelectedMetric]);
  
  // Persist refresh interval to localStorage
  useEffect(() => {
    localStorage.setItem('systemmetrics-refresh-interval', refreshInterval.toString());
  }, [refreshInterval]);
  
  // Track previous device UUID to detect actual device changes
  const prevDeviceUuidRef = useRef<string | null>(null);
  
  // Track if we've already restored history for current device (prevent infinite loop)
  const hasRestoredRef = useRef<string | null>(null);
  
  // Local state for history data (populated from context + new WebSocket/API data)
  const [cpuHistory, setCpuHistory] = useState<Array<{ time: string; value: number }>>([]);
  const [memoryHistory, setMemoryHistory] = useState<Array<{ time: string; used: number }>>([]);
  const [networkHistory, setNetworkHistory] = useState<Array<{ time: string; download: number; upload: number }>>([]);
  
  // Initialize from persisted history on mount or device change (ONLY ONCE per device)
  useEffect(() => {
    // Skip if we've already restored for this device
    if (hasRestoredRef.current === device.deviceUuid) {
      return;
    }
    
    console.log('[SystemMetrics] Restoration check:', {
      deviceUuid: device.deviceUuid.substring(0, 8) + '...',
      persistedCount: persistedHistory.length,
      hasPersistedData: persistedHistory.length > 0
    });
    
    if (persistedHistory.length > 0) {
      console.log('[SystemMetrics] Restoring from persisted history:', persistedHistory.length, 'points');
      
      // Filter persisted data to only include points from the last 30 minutes
      const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000);
      const filteredHistory = persistedHistory.filter(point => point.timestamp >= thirtyMinutesAgo);
      
      console.log('[SystemMetrics] Filtered to last 30 minutes:', {
        total: persistedHistory.length,
        filtered: filteredHistory.length,
        removed: persistedHistory.length - filteredHistory.length
      });
      
      const cpu: Array<{ time: string; value: number }> = [];
      const memory: Array<{ time: string; used: number }> = [];
      const network: Array<{ time: string; download: number; upload: number }> = [];
      
      filteredHistory.forEach(point => {
        cpu.push({ time: point.time, value: point.cpuPercent });
        memory.push({ time: point.time, used: point.memoryUsedPercent });
        network.push({ time: point.time, download: point.networkRxMbps, upload: point.networkTxMbps });
      });
      
      console.log('[SystemMetrics] Setting restored state:', {
        cpuPoints: cpu.length,
        memoryPoints: memory.length,
        networkPoints: network.length
      });
      
      setCpuHistory(cpu);
      setMemoryHistory(memory);
      setNetworkHistory(network);
    } else {
      console.log('[SystemMetrics] No persisted data to restore');
    }
    
    // Mark this device as restored to prevent re-running
    hasRestoredRef.current = device.deviceUuid;
  }, [device.deviceUuid, persistedHistory]); // Run when device changes OR when persistedHistory updates
  
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
  const [isProcessesRefreshing, setIsProcessesRefreshing] = useState(false);
  
  // Incidents state for alerts card
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsLoading, setIncidentsLoading] = useState(true);
  const [isIncidentsRefreshing, setIsIncidentsRefreshing] = useState(false);

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

  // Fetch system info once via REST to avoid waiting on WebSocket
  const fetchSystemInfo = useCallback(async () => {
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('accessToken');
      const response = await fetch(
        buildApiUrl(`/api/v1/devices/${device.deviceUuid}`),
        {
          headers: token
            ? {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            : {
                'Content-Type': 'application/json'
              }
        }
      );

      if (!response.ok) {
        console.warn('[SystemMetrics] System info fetch failed:', response.status, response.statusText);
        return;
      }

      const data = await response.json();
      const systemInfo = data?.current_state?.system_info || {};
      const deviceInfo = data?.device || {};

      handleSystemInfo({
        os: systemInfo.os || systemInfo.os_version || deviceInfo.os_version || '',
        architecture: systemInfo.architecture || '',
        uptime: systemInfo.uptime || 0,
        hostname: systemInfo.hostname || deviceInfo.device_name || '',
        ipAddress: systemInfo.ipAddress || systemInfo.ip_address || deviceInfo.ip_address || '',
        macAddress: systemInfo.macAddress || systemInfo.mac_address || deviceInfo.mac_address || ''
      });
    } catch (error) {
      console.warn('[SystemMetrics] Error fetching system info:', error);
    }
  }, [device.deviceUuid, handleSystemInfo]);

  // Handle processes updates via WebSocket
  const handleProcesses = useCallback((data: { top_processes: ProcessData[] }) => {
    if (data.top_processes && Array.isArray(data.top_processes)) {
      setProcesses(data.top_processes);
      setProcessesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSystemInfo();
  }, [fetchSystemInfo]);

  // Fetch initial processes data from API
  const fetchProcesses = useCallback(async () => {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        buildApiUrl(`/api/v1/devices/${device.deviceUuid}/processes`),
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (!response.ok) {
        console.error('[SystemMetrics] Processes fetch failed:', response.status, response.statusText);
        setProcessesLoading(false);
        return;
      }
      
      const data = await response.json();
      if (data.top_processes && Array.isArray(data.top_processes)) {
        setProcesses(data.top_processes);
        setProcessesLoading(false);
      }
    } catch (error) {
      console.error('[SystemMetrics] Error fetching processes:', error);
      setProcessesLoading(false);
    }
  }, [device.deviceUuid]);

  // Manual refresh for processes
  const handleProcessesRefresh = useCallback(async () => {
    setIsProcessesRefreshing(true);
    try {
      await fetchProcesses();
    } finally {
      setIsProcessesRefreshing(false);
    }
  }, [fetchProcesses]);

  // Fetch historical data from API
  const fetchHistoricalData = useCallback(async (period: string) => {
    // Don't fetch data for offline devices
    if (device.status === 'offline') {
      console.log('[SystemMetrics] Skipping metrics fetch - device is offline');
      setCpuHistory([]);
      setMemoryHistory([]);
      setNetworkHistory([]);
      return;
    }
    
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
      const memory: Array<{ time: string; used: number }> = [];
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
          
          // Persist to context (for 30min period only)
          if (period === '30min') {
            addMetricsDataPoint(device.deviceUuid, {
              timestamp: new Date(m.recorded_at).getTime(),
              time,
              cpuPercent: Math.round(m.cpu_usage || 0),
              memoryUsedPercent: Math.round(m.memory_usage || 0),
              networkRxMbps: Math.round((m.network_rx_rate || 0) / 1024),
              networkTxMbps: Math.round((m.network_tx_rate || 0) / 1024),
            });
          }
        });
      }
      
      setCpuHistory(cpu);
      setMemoryHistory(memory);
      setNetworkHistory(network);
    } catch (error) {
      console.error('Failed to fetch historical data:', error);
    }
  }, [device.deviceUuid, device.status, addMetricsDataPoint]);

  // Fetch incidents for this agent
  const fetchIncidents = useCallback(async () => {
    try {
      const token = localStorage.getItem('token') || localStorage.getItem('accessToken');
      const params = new URLSearchParams();
      params.append('limit', '20'); // Fetch a few more and filter locally
      params.append('offset', '0');
      
      // Filter by device name (same as MonitoringPage)
      if (device.name) {
        params.append('deviceName', device.name);
      }
      
      const response = await fetch(
        buildApiUrl(`/api/v1/anomaly-incidents?${params.toString()}`),
        {
          headers: token
            ? {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
              }
            : {
                'Content-Type': 'application/json'
              }
        }
      );

      if (!response.ok) {
        console.warn('[SystemMetrics] Incidents fetch failed:', response.status, response.statusText);
        setIncidents([]);
        return;
      }

      const data = await response.json();
      if (data.success && Array.isArray(data.incidents)) {
        const unresolved = data.incidents.filter((inc: Incident) => inc.status !== 'resolved');
        setIncidents(unresolved.slice(0, 5));
      } else {
        setIncidents([]);
      }
    } catch (error) {
      console.error('[SystemMetrics] Failed to fetch incidents:', error);
      setIncidents([]);
    } finally {
      setIncidentsLoading(false);
    }
  }, [device.deviceUuid]);

  // Manual refresh function for incidents
  const handleIncidentsRefresh = useCallback(async () => {
    setIsIncidentsRefreshing(true);
    try {
      await fetchIncidents();
    } finally {
      setIsIncidentsRefreshing(false);
    }
  }, [fetchIncidents]);

  // Manual refresh function for telemetry
  const handleManualRefresh = useCallback(async () => {
    setIsTelemetryRefreshing(true);
    try {
      await fetchHistoricalData(timePeriod);
    } finally {
      setIsTelemetryRefreshing(false);
    }
  }, [timePeriod, fetchHistoricalData]);

  // Subscribe to WebSocket channels (only for online devices)
  const isOnline = device.status === 'online';
  useWebSocket(device.deviceUuid, 'processes', handleProcesses, isOnline);

  // Fetch historical data with HTTP polling (replaces WebSocket approach)
  // Polls at configured interval for all time periods (30min, 6h, 12h, 24h)
  useEffect(() => {
    console.log('[SystemMetrics] Setting up HTTP polling for period:', timePeriod, 'interval:', refreshInterval, 's');
    
    // Initial fetch
    fetchHistoricalData(timePeriod);
    
    // Set up polling if interval > 0
    if (refreshInterval > 0) {
      const interval = setInterval(() => {
        console.log('[SystemMetrics] Polling fetch triggered');
        fetchHistoricalData(timePeriod);
      }, refreshInterval * 1000);
      
      return () => {
        console.log('[SystemMetrics] Clearing polling interval');
        clearInterval(interval);
      };
    }
  }, [timePeriod, refreshInterval, fetchHistoricalData]);
  
  // Fetch incidents on mount and every 30 seconds
  useEffect(() => {
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, [fetchIncidents]);

  // Clear data when device changes (not on initial mount)
  useEffect(() => {
    const deviceChanged = prevDeviceUuidRef.current !== null && 
                          prevDeviceUuidRef.current !== device.deviceUuid;
    
    if (deviceChanged) {
      console.log('[SystemMetrics] Device changed:', {
        from: prevDeviceUuidRef.current?.substring(0, 8) + '...',
        to: device.deviceUuid.substring(0, 8) + '...',
        name: device.name,
        status: device.status
      });
      
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
    } else if (prevDeviceUuidRef.current === null) {
      console.log('[SystemMetrics] Initial mount for device:', {
        uuid: device.deviceUuid.substring(0, 8) + '...',
        name: device.name,
        status: device.status
      });
    }
    
    // Update ref for next comparison
    prevDeviceUuidRef.current = device.deviceUuid;
    
    // Fetch initial processes data (only for online devices)
    if (device.status !== 'offline') {
      fetchProcesses();
    }
  }, [device.deviceUuid, device.name, device.ipAddress, device.status, fetchProcesses]);

  // Process chart data to detect service interruptions (gaps)
  const cpuChartData = useMemo(() => detectGaps(cpuHistory), [cpuHistory]);
  const memoryChartData = useMemo(() => detectGaps(memoryHistory), [memoryHistory]);
  const networkChartData = useMemo(() => detectGaps(networkHistory), [networkHistory]);
  const cpuGapTimes = useMemo(() => cpuChartData.filter(point => point.isGap).map(point => point.time), [cpuChartData]);
  const memoryGapTimes = useMemo(() => memoryChartData.filter(point => point.isGap).map(point => point.time), [memoryChartData]);
  const networkGapTimes = useMemo(() => networkChartData.filter(point => point.isGap).map(point => point.time), [networkChartData]);

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

        {/* Main Cards Layout */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Telemetry / Top Processes Tabs Card */}
          <Card className="p-4 md:p-6">
            <Tabs defaultValue="telemetry" className="w-full">
              <div className="flex items-center justify-between gap-3 mb-4">
                <div>
                  <h3 className="text-lg text-foreground font-medium mb-1">System Insights</h3>
                  <p className="text-sm text-muted-foreground">Telemetry and process activity</p>
                </div>
                <TabsList>
                  <TabsTrigger value="telemetry">Telemetry</TabsTrigger>
                  <TabsTrigger value="processes">Top Processes</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="telemetry" className="mt-0">
                <div className="mb-4 space-y-3">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-2 flex-wrap">
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
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground">Refresh:</span>
                      <Select value={refreshInterval.toString()} onValueChange={(value) => setRefreshInterval(parseInt(value, 10))}>
                        <SelectTrigger className="w-[100px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="5">5s</SelectItem>
                          <SelectItem value="10">10s</SelectItem>
                          <SelectItem value="30">30s</SelectItem>
                          <SelectItem value="60">1m</SelectItem>
                          <SelectItem value="300">5m</SelectItem>
                          <SelectItem value="0">Off</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={handleManualRefresh}
                        disabled={isTelemetryRefreshing}
                      >
                        <RefreshCw 
                          className={`w-4 h-4 ${isTelemetryRefreshing ? 'animate-spin' : ''}`}
                          style={{ 
                            transform: isTelemetryRefreshing ? undefined : 'rotate(0deg)',
                            transition: isTelemetryRefreshing ? undefined : 'none'
                          }}
                        />
                      </Button>
                    </div>
                  </div>
                </div>

                {selectedMetric === 'cpu' && (
                  <>
                    <ResponsiveContainer width="100%" height={250} key="cpu-chart">
                      <AreaChart data={cpuChartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
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
                          dot={createGapDotRenderer({ color: '#ef4444' })}
                          activeDot={{ r: 5 }}
                          connectNulls={true}
                        />
                        {cpuGapTimes.map((gapTime, idx) => (
                          <ReferenceLine
                            key={`cpu-gap-${idx}`}
                            x={gapTime}
                            stroke="#ef4444"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            opacity={0.8}
                          />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  </>
                )}

                {selectedMetric === 'memory' && (
                  <>
                    <ResponsiveContainer width="100%" height={250} key="memory-chart">
                      <AreaChart data={memoryChartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
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
                          dot={createGapDotRenderer({ color: '#ef4444' })}
                          activeDot={{ r: 5 }}
                          connectNulls={true}
                        />
                        {memoryGapTimes.map((gapTime, idx) => (
                          <ReferenceLine
                            key={`memory-gap-${idx}`}
                            x={gapTime}
                            stroke="#ef4444"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            opacity={0.8}
                          />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  </>
                )}

                {selectedMetric === 'network' && (
                  <>
                    <ResponsiveContainer width="100%" height={250} key="network-chart">
                      <LineChart data={networkChartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
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
                          dot={createGapDotRenderer({ color: '#ef4444' })}
                          activeDot={{ r: 5 }}
                          isAnimationActive={false}
                          connectNulls={true}
                        />
                        <Line
                          type="linear"
                          dataKey="upload"
                          stroke="#10b981"
                          strokeWidth={2}
                          dot={createGapDotRenderer({ color: '#ef4444' })}
                          activeDot={{ r: 5 }}
                          isAnimationActive={false}
                          connectNulls={true}
                        />
                        {networkGapTimes.map((gapTime, idx) => (
                          <ReferenceLine
                            key={`network-gap-${idx}`}
                            x={gapTime}
                            stroke="#ef4444"
                            strokeDasharray="4 4"
                            strokeWidth={1.5}
                            opacity={0.8}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </>
                )}
              </TabsContent>

              <TabsContent value="processes" className="mt-0">
                <div className="mb-4 flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-lg text-foreground font-medium mb-1">Top Processes</h3>
                    <p className="text-sm text-muted-foreground">Most resource-intensive processes</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={handleProcessesRefresh}
                    disabled={isProcessesRefreshing || processesLoading}
                  >
                    <RefreshCw 
                      className={`w-4 h-4 ${isProcessesRefreshing ? 'animate-spin' : ''}`}
                      style={{ 
                        transform: isProcessesRefreshing ? undefined : 'rotate(0deg)',
                        transition: isProcessesRefreshing ? undefined : 'none'
                      }}
                    />
                  </Button>
                </div>
                {processesLoading ? (
                  <div className="text-center py-8 text-muted-foreground">Loading processes...</div>
                ) : processes.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">No process data available</div>
                ) : (
                  <div className="overflow-x-auto h-[320px] overflow-y-auto">
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
              </TabsContent>
            </Tabs>
          </Card>

          {/* Alerts Card - Condensed view for this agent */}
          <Card>
            <div className="p-4 md:p-6 pb-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Bell className="h-5 w-5" />
                  <h3 className="text-lg font-semibold">Alerts</h3>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="ghost"
                    className="h-8 w-8 p-0"
                    onClick={handleIncidentsRefresh}
                    disabled={isIncidentsRefreshing}
                  >
                    <RefreshCw 
                      className={`w-4 h-4 ${isIncidentsRefreshing ? 'animate-spin' : ''}`}
                      style={{ 
                        transform: isIncidentsRefreshing ? undefined : 'rotate(0deg)',
                        transition: isIncidentsRefreshing ? undefined : 'none'
                      }}
                    />
                  </Button>
                  {!incidentsLoading && (
                    <>
                      {(() => {
                        const criticalCount = incidents.filter(i => i.severity === 'critical').length;
                        const warningCount = incidents.filter(i => i.severity === 'warning').length;
                        
                        if (criticalCount > 0) {
                          return (
                            <Badge
                              variant="destructive"
                              className="!bg-[#d4183d] !text-white !border-[#d4183d] hover:!bg-[#d4183d]"
                              style={{
                                backgroundColor: '#d4183d',
                                borderColor: '#d4183d',
                                color: '#ffffff',
                              }}
                            >
                              {criticalCount} Critical
                            </Badge>
                          );
                        }
                        if (warningCount > 0) {
                          return (
                            <Badge variant="secondary">
                              {warningCount} Warning
                            </Badge>
                          );
                        }
                        return null;
                      })()}
                    </>
                  )}
                </div>
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {incidentsLoading ? (
                  'Loading...'
                ) : (
                  <>
                    {incidents.length} active alert{incidents.length !== 1 ? 's' : ''}
                    {incidents.length > 0 && (
                      <>
                        {' • '}
                        <button
                          onClick={() => {
                            const event = new CustomEvent('navigate-to-monitoring');
                            window.dispatchEvent(event);
                          }}
                          className="text-blue-600 hover:underline cursor-pointer"
                        >
                          View all
                        </button>
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="px-4 md:px-6 pb-4 md:pb-6">
              {incidentsLoading ? (
                <div className="text-center py-8 text-muted-foreground">Loading alerts...</div>
              ) : incidents.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <Info className="h-12 w-12 mx-auto mb-2 opacity-20" />
                  <p>No alerts to display</p>
                </div>
              ) : (
                <div className="h-[320px] overflow-y-auto pr-2">
                  <div className="space-y-3">
                    {incidents.map((incident) => {
                        // Severity configuration
                        const severityConfig = {
                          critical: {
                            icon: XCircle,
                            color: 'text-red-600 dark:text-red-400',
                            bgColor: 'bg-red-50 dark:bg-red-950/30',
                            badgeVariant: 'destructive' as const,
                            badgeClass: '!bg-[#d4183d] !text-white !border-[#d4183d] hover:!bg-[#d4183d]',
                            badgeStyle: {
                              backgroundColor: '#d4183d',
                              borderColor: '#d4183d',
                              color: '#ffffff',
                            },
                          },
                          warning: {
                            icon: AlertTriangle,
                            color: 'text-orange-600 dark:text-orange-400',
                            bgColor: 'bg-orange-50 dark:bg-orange-950/30',
                            badgeVariant: 'secondary' as const,
                            badgeClass: '!bg-[#f59e0b] !text-white !border-[#f59e0b] hover:!bg-[#f59e0b]',
                            badgeStyle: {
                              backgroundColor: '#f59e0b',
                              borderColor: '#f59e0b',
                              color: '#ffffff',
                            },
                          },
                          info: {
                            icon: Info,
                            color: 'text-blue-600 dark:text-blue-400',
                            bgColor: 'bg-blue-50 dark:bg-blue-950/30',
                            badgeVariant: 'secondary' as const,
                          },
                        };

                        const config = severityConfig[incident.severity] || severityConfig.info;
                        const Icon = config.icon;

                        // Format timestamp
                        const formatTimestamp = (timestamp: number | null) => {
                          if (!timestamp) return 'Just now';
                          const date = new Date(timestamp);
                          const now = new Date();
                          const diffMs = now.getTime() - date.getTime();
                          const diffMins = Math.floor(diffMs / 60000);
                          const diffHours = Math.floor(diffMs / 3600000);
                          const diffDays = Math.floor(diffMs / 86400000);

                          if (diffMins < 1) return 'Just now';
                          if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
                          if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
                          return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
                        };

                        // Create descriptive message
                        const createMessage = () => {
                          const parts = [];
                          if (incident.event_count > 1) {
                            parts.push(`${incident.event_count} anomaly events detected`);
                          } else {
                            parts.push('Anomaly detected');
                          }
                          if (incident.max_anomaly_score) {
                            parts.push(`Maximum anomaly score: ${incident.max_anomaly_score.toFixed(2)}`);
                          }
                          if (incident.max_confidence) {
                            parts.push(`Confidence: ${(incident.max_confidence * 100).toFixed(0)}%`);
                          }
                          return parts.join('. ') + '.';
                        };

                        return (
                          <div
                            key={incident.incident_id}
                            className="rounded-lg border p-4"
                          >
                            <div className="flex gap-3">
                              <div className="h-fit">
                                <Icon className={`h-5 w-5 ${config.color}`} />
                              </div>
                              <div className="flex-1 space-y-1">
                                <div className="flex items-start justify-between gap-2">
                                  <h4 className="font-medium leading-none">
                                    {incident.metric}
                                  </h4>
                                  <Badge
                                    variant={config.badgeVariant}
                                    className={`shrink-0 ${(config as any).badgeClass ? (config as any).badgeClass : ''}`}
                                    style={(config as any).badgeStyle}
                                  >
                                    {incident.severity}
                                  </Badge>
                                </div>
                                <p className="text-sm text-muted-foreground">
                                  {createMessage()}
                                </p>
                                <div className="flex items-center gap-3 text-xs text-muted-foreground pt-1">
                                  <span>{formatTimestamp(incident.last_seen)}</span>
                                  <span>•</span>
                                  <span>{incident.device_name}</span>
                                  {incident.status === 'resolved' && (
                                    <>
                                      <span>•</span>
                                      <span className="text-green-600 dark:text-green-400">Resolved</span>
                                    </>
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* System Info and Networking Cards */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* System Info */}
          <GeneralInfoCard systemInfo={systemInfo} />

          {/* Network Interfaces */}
          <NetworkingCard interfaces={networkInterfaces} />
        </div>
      </div>
    </div>
  );
}
