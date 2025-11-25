/**
 * MQTT Page - Shows MQTT broker status and metrics
 */

import { useState, useMemo, useCallback } from "react";
import { Users, MessageSquare, Zap, TrendingUp } from "lucide-react";
import { MetricCard } from "../components/ui/metric-card";
import { Device } from "../components/DeviceSidebar";
import { MqttBrokerCard } from "../components/MqttBrokerCard";
import { MqttMetricsCard } from "../components/MqttMetricsCard";
import { useWebSocket, useGlobalWebSocketConnection } from "@/hooks/useWebSocket";
import type { MqttStatsData } from "@/services/websocket";

interface MqttPageProps {
  device: Device;
}

interface BrokerStats {
  connectedClients: number;
  disconnectedClients: number;
  totalClients: number;
  subscriptions: number;
  retainedMessages: number;
  messagesSent: number;
  messagesReceived: number;
  messagesPublished: number;
  messagesDropped: number;
  bytesSent: number;
  bytesReceived: number;
  messageRatePublished: number;
  messageRateReceived: number;
  throughputInbound: number;
  throughputOutbound: number;
}

export function MqttPage({ device }: MqttPageProps) {
  const [brokerStats, setBrokerStats] = useState<BrokerStats | null>(null);
  const [mqttTopics, setMqttTopics] = useState<any[]>([]);
  const [isConnected, setIsConnected] = useState(false);

  // Establish global WebSocket connection
  useGlobalWebSocketConnection();

  // Handle MQTT stats updates via WebSocket
  const handleMqttStats = useCallback((data: MqttStatsData) => {
    console.log('[MqttPage] Received MQTT stats:', data);
    
    // Helper function to safely parse number or return 0
    const safeNumber = (value: any): number => {
      if (value === null || value === undefined) return 0;
      const num = typeof value === 'number' ? value : parseFloat(value);
      return isNaN(num) ? 0 : num;
    };
    
    // Map WebSocket data to BrokerStats interface
    // WebSocket sends data directly (not wrapped in 'stats' like HTTP endpoint)
    const mappedStats: BrokerStats = {
      // Use data.clients directly (from metrics.clients)
      connectedClients: safeNumber(data.clients),
      disconnectedClients: 0, // Not available in current metrics
      totalClients: safeNumber(data.clients),
      
      // Direct metrics
      subscriptions: safeNumber(data.subscriptions),
      retainedMessages: safeNumber(data.retainedMessages),
      messagesSent: safeNumber(data.totalMessagesSent),
      messagesReceived: safeNumber(data.totalMessagesReceived),
      
      // System stats (from $SYS topics) - fallback to 0 if not available
      messagesPublished: safeNumber(data.systemStats?.publish?.messages?.sent),
      messagesDropped: safeNumber(data.systemStats?.publish?.messages?.dropped),
      bytesSent: safeNumber(data.systemStats?.bytes?.sent),
      bytesReceived: safeNumber(data.systemStats?.bytes?.received),
      
      // Rates (from metrics) - now using nested structure
      messageRatePublished: safeNumber(data.messageRate?.published),
      messageRateReceived: safeNumber(data.messageRate?.received),
      throughputInbound: safeNumber(data.throughput?.inbound),
      throughputOutbound: safeNumber(data.throughput?.outbound),
    };
    
    console.log('[MqttPage] Mapped stats:', mappedStats);
    setBrokerStats(mappedStats);
    setIsConnected(data.connected || false);
  }, []);

  // Handle MQTT topics updates via WebSocket
  const handleMqttTopics = useCallback((data: any) => {
    console.log('[MqttPage] Received MQTT topics:', data);
    if (data.topics) {
      setMqttTopics(data.topics);
    }
  }, []);

  // Subscribe to mqtt-stats channel
  useWebSocket(null, 'mqtt-stats', handleMqttStats);

  // Subscribe to mqtt-topics channel
  useWebSocket(null, 'mqtt-topics', handleMqttTopics);

  // Calculate current stats
  const currentStats = useMemo(() => {
    if (!brokerStats) {
      return {
        messagesPerSec: 0,
        throughputKBps: 0,
        activeClients: 0,
        activeSubscriptions: 0,
      };
    }

    return {
      messagesPerSec: Math.round((brokerStats.messageRatePublished || 0) + (brokerStats.messageRateReceived || 0)),
      throughputKBps: Math.round(((brokerStats.throughputInbound || 0) + (brokerStats.throughputOutbound || 0)) / 1024),
      activeClients: brokerStats.connectedClients || 0,
      activeSubscriptions: brokerStats.subscriptions || 0,
    };
  }, [brokerStats]);

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Page Title */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">MQTT Broker & Metrics</h2>
          <p className="text-sm text-muted-foreground">
            Monitor MQTT broker status, connections, and message flow
          </p>
        </div>

        {/* Metric Count Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard
            label="Connected Clients"
            value={currentStats.activeClients}
            icon={Users}
            iconColor="blue"
          />

          <MetricCard
            label="Subscriptions"
            value={currentStats.activeSubscriptions}
            icon={MessageSquare}
            iconColor="purple"
          />

          <MetricCard
            label="Messages/sec"
            value={currentStats.messagesPerSec}
            icon={Zap}
            iconColor="green"
          />

          <MetricCard
            label="Throughput"
            value={`${currentStats.throughputKBps} KB/s`}
            icon={TrendingUp}
            iconColor="orange"
          />
        </div>

        {/* MQTT Cards Side by Side */}
        <div className="grid gap-6 lg:grid-cols-2">
          {/* MQTT Broker Status Card */}
          <MqttBrokerCard 
            deviceId={device.deviceUuid} 
            topics={mqttTopics}
            isConnected={isConnected}
          />

          {/* MQTT Metrics Card */}
          <MqttMetricsCard brokerStats={brokerStats} />
        </div>
      </div>
    </div>
  );
}
