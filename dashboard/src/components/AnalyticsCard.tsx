import { useState, useEffect } from "react";
import { Card } from "./ui/card";
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
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { buildApiUrl } from "@/config/api";

type MetricType = "ram" | "cpu" | "storage" | "temperature" | "network";
type TimePeriod = "30min" | "6h" | "12h" | "24h";

interface Process {
  name: string;
  cpu: number;
  memory: number;
  pid: number;
}

interface AnalyticsCardProps {
  deviceName?: string;
  deviceId?: string;
  processes?: Process[];
  provisioned?: boolean;
}

// Mock data for different processes based on actual process data
const generateProcessData = (timePeriod: TimePeriod, processes: Process[], metricType: MetricType) => {
  const dataPointsMap = {
    "30min": 30,
    "6h": 36,
    "12h": 48,
    "24h": 48
  };
  
  const dataPoints = dataPointsMap[timePeriod];
  const data = [];

  for (let i = 0; i < dataPoints; i++) {
    const timeStr = `${String(Math.floor(i * (24 / dataPoints))).padStart(2, '0')}:${String((i * 5) % 60).padStart(2, '0')}`;

    const dataPoint: any = { time: timeStr };
    
    // Generate data for each process based on their current metrics
    processes.forEach(process => {
      const baseValue = metricType === 'cpu' ? process.cpu : process.memory;
      // Add some variation over time
      dataPoint[process.name] = Math.max(0, baseValue + Math.random() * 10 - 5 + Math.sin(i / 10) * 5);
    });

    data.push(dataPoint);
  }

  return data;
};

const metricOptions = [
  { value: "ram", label: "RAM Usage" },
  { value: "cpu", label: "CPU Usage" },
  { value: "storage", label: "Storage" },

  { value: "network", label: "Network" },
];

const timePeriodOptions = [
  { value: "30min", label: "30 minutes" },
  { value: "6h", label: "6 hours" },
  { value: "12h", label: "12 hours" },
  { value: "24h", label: "24 hours" },
];

// Colors for different processes
const processColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

export function AnalyticsCard({ deviceName = "Device 1", deviceId, processes = [], provisioned = true }: AnalyticsCardProps) {
  const [selectedMetric, setSelectedMetric] = useState<MetricType>("cpu");
  const [timePeriod, setTimePeriod] = useState<TimePeriod>("24h");
  const [historicalData, setHistoricalData] = useState<any[]>([]);
  const [useRealData, setUseRealData] = useState(false);

  // Use default processes if none provided
  const defaultProcesses = [
    { name: "node", cpu: 18.5, memory: 12.3, pid: 1234 },
    { name: "postgres", cpu: 12.2, memory: 8.7, pid: 5678 },
    { name: "nginx", cpu: 8.1, memory: 5.2, pid: 9012 },
    { name: "docker", cpu: 6.5, memory: 15.6, pid: 3456 },
    { name: "systemd", cpu: 4.2, memory: 3.1, pid: 1 },
  ];

  const activeProcesses = processes.length > 0 ? processes : defaultProcesses;

  // TODO: Convert to WebSocket for real-time process history
  // Fetch historical process data from API
  useEffect(() => {
    // Temporarily disabled - will be replaced with WebSocket implementation
    setUseRealData(false);
    return;
    
    /* Disabled HTTP polling - to be replaced with WebSocket
    if (!deviceId) {
      setUseRealData(false);
      return;
    }

    const fetchHistoricalData = async () => {
      try {
        const hoursMap = { "30min": 1, "6h": 6, "12h": 12, "24h": 24 };
        const hours = hoursMap[timePeriod];
        
        const response = await fetch(
          buildApiUrl(`/api/v1/devices/${deviceId}/processes/history?hours=${hours}&limit=50`)
        );
        const data = await response.json();
        
        if (data.history && data.history.length > 0) {
          // Process historical data into chart format
          const processed = data.history.reverse().map((entry: any) => {
            const time = new Date(entry.recorded_at).toLocaleTimeString('en-US', {
              hour: '2-digit',
              minute: '2-digit',
              hour12: false
            });
            
            const dataPoint: any = { time };
            
            // Add data for each process
            entry.top_processes.forEach((proc: any) => {
              dataPoint[proc.name] = selectedMetric === 'cpu' ? proc.cpu : proc.mem;
            });
            
            return dataPoint;
          });
          
          setHistoricalData(processed);
          setUseRealData(true);
        } else {
          setUseRealData(false);
        }
      } catch (error) {
        console.error('Failed to fetch historical process data:', error);
        setUseRealData(false);
      }
    };

    fetchHistoricalData();
    const interval = setInterval(fetchHistoricalData, 30000); // Refresh every 30 seconds

    return () => clearInterval(interval);
    */
  }, [deviceId, timePeriod, selectedMetric]);


  // Fallback to simulated data if no real data available, but only if provisioned
  let chartData: any[] = [];
  if (provisioned) {
    chartData = useRealData && historicalData.length > 0 
      ? historicalData 
      : generateProcessData(timePeriod, activeProcesses, selectedMetric);
  }

  const getMetricUnit = () => {
    switch (selectedMetric) {
      case "ram":
      case "cpu":
        return "%";
      case "storage":
        return "%";
      case "temperature":
        return "°C";
      case "network":
        return "Mbps";
      default:
        return "%";
    }
  };

  if (!provisioned) {
    return (
      <Card className="p-4 md:p-6">
        <div className="mb-4 space-y-3">
          <h3 className="text-lg text-foreground font-medium mb-1">Analytics</h3>
          <p className="text-sm text-muted-foreground">Process performance metrics</p>
        </div>
        <div className="text-center py-8 text-muted-foreground">
          <p>No analytics available</p>
        </div>
      </Card>
    );
  }

  return (
    <Card className="p-4 md:p-6">
      <div className="mb-4 space-y-3">
        <div>
          <h3 className="text-lg text-foreground font-medium mb-1">Analytics</h3>
          <p className="text-sm text-muted-foreground">Process performance metrics</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={timePeriod} onValueChange={(value: any) => setTimePeriod(value)}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {timePeriodOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={selectedMetric} onValueChange={(value: any) => setSelectedMetric(value)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {metricOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={250}>
        <LineChart data={chartData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey="time" stroke="#6b7280" tick={{ fontSize: 10 }} />
          <YAxis stroke="#6b7280" width={40} tick={{ fontSize: 10 }} />
          <Tooltip />
          <Legend />
          {activeProcesses.map((process, index) => (
            <Line
              key={process.name}
              type="monotone"
              dataKey={process.name}
              stroke={processColors[index % processColors.length]}
              strokeWidth={2}
              dot={false}
              name={process.name}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}
