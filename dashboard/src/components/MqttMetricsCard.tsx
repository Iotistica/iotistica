import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMqtt } from "@/contexts/MqttContext";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface MqttMetricsCardProps {
  refreshInterval: number;
  onRefreshIntervalChange: (interval: number) => void;
  onManualRefresh: () => void;
  isRefreshing: boolean;
}

const MqttMetricsCard = ({ refreshInterval, onRefreshIntervalChange, onManualRefresh, isRefreshing }: MqttMetricsCardProps) => {
  // Read chart history directly from context - no local state needed
  const { chartHistory } = useMqtt();
  
  // Custom tick formatter for X-axis - uses timestamp for proper spacing
  const formatXAxis = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit', 
      second: '2-digit' 
    });
  };
  
  // Transform chartHistory for each chart type
  const messageRateData = chartHistory.map(point => ({
    timestamp: point.timestamp,
    published: point.messageRatePublished,
    received: point.messageRateReceived
  }));
  
  const throughputData = chartHistory.map(point => ({
    timestamp: point.timestamp,
    inbound: point.throughputInbound,
    outbound: point.throughputOutbound
  }));
  
  const connectionData = chartHistory.map(point => ({
    timestamp: point.timestamp,
    clients: point.connectedClients,
    subscriptions: point.subscriptions
  }));

  return (
    <Card className="p-4 md:p-6">
      <div className="mb-6">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div>
            <h3 className="text-lg text-foreground font-medium mb-1">MQTT Metrics</h3>
            <p className="text-muted-foreground text-sm">Broker statistics and performance</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Refresh:</span>
            <Select value={refreshInterval.toString()} onValueChange={(value) => onRefreshIntervalChange(parseInt(value, 10))}>
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
              onClick={onManualRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw 
                className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
                style={{ 
                  transform: isRefreshing ? undefined : 'rotate(0deg)',
                  transition: isRefreshing ? undefined : 'none'
                }}
              />
            </Button>
          </div>
        </div>
      </div>

      {/* Charts Grid */}
      <div className="space-y-6">
        {/* Message Rate Chart */}
        <div>
          <div className="mb-3">
            <h4 className="text-foreground text-sm font-medium mb-1">Message Rate</h4>
            <p className="text-muted-foreground text-xs">Published and received messages per second</p>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <AreaChart data={messageRateData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <defs>
                <linearGradient id="colorPublished" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorReceived" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis 
                dataKey="timestamp" 
                stroke="#6b7280" 
                tick={{ fontSize: 10 }}
                tickFormatter={formatXAxis}
                interval="preserveStartEnd"
                type="number"
                domain={['dataMin', 'dataMax']}
              />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }} width={40} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Area
                type="monotone"
                dataKey="published"
                stackId="1"
                stroke="#3b82f6"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorPublished)"
              />
              <Area
                type="monotone"
                dataKey="received"
                stackId="1"
                stroke="#10b981"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorReceived)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Throughput Chart */}
        <div>
          <div className="mb-3">
            <h4 className="text-foreground text-sm font-medium mb-1">Network Throughput</h4>
            <p className="text-muted-foreground text-xs">Inbound and outbound data transfer (KB/s)</p>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={throughputData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis 
                dataKey="timestamp" 
                stroke="#6b7280" 
                tick={{ fontSize: 10 }}
                tickFormatter={formatXAxis}
                interval="preserveStartEnd"
                type="number"
                domain={['dataMin', 'dataMax']}
              />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }} width={40} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Line
                type="monotone"
                dataKey="inbound"
                stroke="#8b5cf6"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="outbound"
                stroke="#f59e0b"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Connections Chart */}
        <div>
          <div className="mb-3">
            <h4 className="text-foreground text-sm font-medium mb-1">Active Connections</h4>
            <p className="text-muted-foreground text-xs">Connected clients and active subscriptions</p>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={connectionData} margin={{ top: 5, right: 5, left: -20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis 
                dataKey="timestamp" 
                stroke="#6b7280" 
                tick={{ fontSize: 10 }}
                tickFormatter={formatXAxis}
                interval="preserveStartEnd"
                type="number"
                domain={['dataMin', 'dataMax']}
              />
              <YAxis stroke="#6b7280" tick={{ fontSize: 10 }} width={40} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Line
                type="monotone"
                dataKey="clients"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
              <Line
                type="monotone"
                dataKey="subscriptions"
                stroke="#06b6d4"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </Card>
  );
};

export default MqttMetricsCard;
