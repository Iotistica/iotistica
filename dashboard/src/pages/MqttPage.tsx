/**
 * MQTT Page - Shows MQTT broker status and metrics
 */

import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Users, MessageSquare, Zap, TrendingUp, Filter } from "lucide-react";
import { MetricCard } from "../components/ui/metric-card";
import { Device } from "../components/DeviceSidebar";
import MqttBrokerCard from "../components/MqttBrokerCard";
import MqttMetricsCard from "../components/MqttMetricsCard";
import type { MqttStatsData } from "@/services/websocket";
import { useMqtt, type MqttBrokerStatsData, type MqttDataPoint } from "@/contexts/MqttContext";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface MqttPageProps {
  device: Device;
  devices?: Device[];
}

export function MqttPage({ device, devices = [] }: MqttPageProps) {
  // Get context actions and state
  const { brokerStats, topics, chartHistory, updateBrokerStats, updateTopics, addChartDataPoint } = useMqtt();
  
  const [isConnected, setIsConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [initialLoadComplete, setInitialLoadComplete] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Refresh interval state with localStorage persistence
  const [refreshInterval, setRefreshInterval] = useState<number>(() => {
    const saved = localStorage.getItem('mqtt-refresh-interval');
    return saved ? parseInt(saved, 10) : 10; // Default 10 seconds
  });
  
  // Persist refresh interval to localStorage
  useEffect(() => {
    localStorage.setItem('mqtt-refresh-interval', refreshInterval.toString());
  }, [refreshInterval]);
  
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastChartUpdateRef = useRef<number>(0); // Track last chart data point timestamp
  
  // Agent filtering
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string>('all');
  
  // Build agents list from devices prop (sidebar source)
  const agents = useMemo(() => {
    const agentsList = devices.map(device => ({
      uuid: device.deviceUuid,
      name: device.name
    }));
    
    return [
      { uuid: 'all', name: 'All Agents' },
      ...agentsList.sort((a, b) => a.name.localeCompare(b.name))
    ];
  }, [devices]);

  // Note: WebSocket connection removed - now using HTTP polling

  // Handle MQTT stats updates from HTTP endpoints
  const handleMqttStats = useCallback((data: MqttStatsData) => {
    // Helper function to safely parse number or return 0
    const safeNumber = (value: any): number => {
      if (value === null || value === undefined) return 0;
      const num = typeof value === 'number' ? value : parseFloat(value);
      return isNaN(num) ? 0 : num;
    };
    
    // Map data to BrokerStats interface
    const mappedStats: MqttBrokerStatsData = {
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
      
      // Rates (from metrics)
      messageRatePublished: safeNumber(data.messageRate?.published),
      messageRateReceived: safeNumber(data.messageRate?.received),
      throughputInbound: safeNumber(data.throughput?.inbound),
      throughputOutbound: safeNumber(data.throughput?.outbound),
    };
    
    // Update context with broker stats
    updateBrokerStats(mappedStats);
    
    // Add data point to chart history only if enough time has passed
    // This prevents duplicate points from manual refreshes in rapid succession
    const now = Date.now();
    const timeSinceLastUpdate = now - lastChartUpdateRef.current;
    const MIN_UPDATE_INTERVAL = 2000; // 2 seconds minimum between chart updates
    
    if (timeSinceLastUpdate >= MIN_UPDATE_INTERVAL || lastChartUpdateRef.current === 0) {
      const dataPoint: MqttDataPoint = {
        timestamp: now,  // Store Unix timestamp for proper spacing
        time: new Date(now).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        messageRatePublished: mappedStats.messageRatePublished,
        messageRateReceived: mappedStats.messageRateReceived,
        throughputInbound: mappedStats.throughputInbound,
        throughputOutbound: mappedStats.throughputOutbound,
        connectedClients: mappedStats.connectedClients,
        subscriptions: mappedStats.subscriptions
      };
      addChartDataPoint(dataPoint);
      lastChartUpdateRef.current = now;
    }
    
    setIsConnected(data.connected || false);
  }, [updateBrokerStats, addChartDataPoint]);

  // Fetch MQTT data from HTTP endpoints
  const fetchMqttData = useCallback(async () => {
    setLoading(true);
    try {
      const mqttMonitorUrl = import.meta.env.VITE_MQTT_MONITOR_URL || 'http://localhost:3500';
      
      // Fetch broker stats using the same endpoint structure as WebSocket
      const statsRes = await fetch(`${mqttMonitorUrl}/api/v1/stats`);
      if (statsRes.ok) {
        const response = await statsRes.json();
        if (response.success && response.stats) {
          // Transform /stats response to match WebSocket format
          const statsData: MqttStatsData = {
            connected: response.stats.connected,
            broker: mqttMonitorUrl,
            uptime: 0,
            messageRate: response.stats.messageRate,
            throughput: response.stats.throughput,
            clients: response.stats.clients,
            subscriptions: response.stats.subscriptions,
            retainedMessages: response.stats.retainedMessages,
            totalMessagesSent: response.stats.totalMessagesSent,
            totalMessagesReceived: response.stats.totalMessagesReceived,
            totalTopics: response.stats.topicCount || 0,
            topicsWithSchemas: response.stats.schemas?.total || 0,
            schemasDetected: response.stats.schemas?.total || 0,
            messageTypeBreakdown: response.stats.schemas?.byType || {},
            systemStats: response.stats.broker ? { $SYS: { broker: response.stats.broker } } : {},
            timestamp: new Date().toISOString()
          };
          handleMqttStats(statsData);
        }
      } else {
        console.warn('[MqttPage] Failed to fetch broker stats:', statsRes.status);
      }

      // Fetch topics (increased limit to support multiple agents)
      console.log('[MqttPage] Fetching topics from:', `${mqttMonitorUrl}/api/v1/topics?limit=1000`);
      const topicsRes = await fetch(`${mqttMonitorUrl}/api/v1/topics?limit=1000`);
      console.log('[MqttPage] Topics fetch response:', topicsRes.status, topicsRes.statusText);
      if (topicsRes.ok) {
        const response = await topicsRes.json();
        console.log('[MqttPage] Topics API response:', response);
        console.log('[MqttPage] response.data structure:', response.data);
        console.log('[MqttPage] response.data.topics:', response.data?.topics);
        
        // Check if topics are in data.topics or data directly
        const topicsArray = response.data?.topics || response.data;
        if (response.success && topicsArray && Array.isArray(topicsArray)) {
          console.log('[MqttPage] API returned topics:', topicsArray.length, 'topics');
          console.log('[MqttPage] Sample topics:', topicsArray.slice(0, 5).map((t: any) => t.topic));
          updateTopics(topicsArray);
        } else {
          console.warn('[MqttPage] Unexpected response structure:', response);
        }
      } else {
        console.warn('[MqttPage] Failed to fetch topics:', topicsRes.status, topicsRes.statusText);
      }
      
      setInitialLoadComplete(true);
    } catch (error) {
      console.error('[MqttPage] Failed to fetch MQTT data:', error);
    } finally {
      setLoading(false);
    }
  }, [updateBrokerStats, updateTopics, handleMqttStats, setIsConnected, setLoading, setInitialLoadComplete]);
  
  // Manual refresh function
  const handleManualRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await fetchMqttData();
    } finally {
      setIsRefreshing(false);
    }
  }, [fetchMqttData]);
  
  // Initial data fetch on mount
  useEffect(() => {
    fetchMqttData();
  }, [fetchMqttData]);
  
  // Set up polling interval
  useEffect(() => {
    // Clear existing interval
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    
    // Set up new interval if enabled (not 0)
    if (refreshInterval > 0) {
      pollIntervalRef.current = setInterval(() => {
        fetchMqttData();
      }, refreshInterval * 1000);
    }
    
    // Cleanup on unmount or interval change
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [refreshInterval, fetchMqttData]);

  // Filter topics based on selected agent
  const filteredTopics = useMemo(() => {
    if (selectedAgentUuid === 'all') {
      return topics;
    }
    
    // Filter topics that belong to the selected agent
    // Topics typically follow pattern: iot/device/{uuid}/... or device/{uuid}/...
    return topics.filter(topic => 
      topic.topic.match(new RegExp(`^(?:iot\\/)?(?:agent|device)\\/${selectedAgentUuid}\\/`))
    );
  }, [topics, selectedAgentUuid]);

  // Calculate current stats - use latest chart data point if available for more accurate real-time values
  const currentStats = useMemo(() => {
    // Prefer latest chart data point (most recent) over brokerStats
    const latestPoint = chartHistory.length > 0 ? chartHistory[chartHistory.length - 1] : null;
    
    if (latestPoint) {
      return {
        messagesPerSec: Math.round((latestPoint.messageRatePublished || 0) + (latestPoint.messageRateReceived || 0)),
        throughputKBps: Math.round((latestPoint.throughputInbound || 0) + (latestPoint.throughputOutbound || 0)),
        activeClients: latestPoint.connectedClients || 0,
        activeSubscriptions: latestPoint.subscriptions || 0,
      };
    }
    
    // Fallback to brokerStats if no chart data yet
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
      throughputKBps: Math.round((brokerStats.throughputInbound || 0) + (brokerStats.throughputOutbound || 0)),
      activeClients: brokerStats.connectedClients || 0,
      activeSubscriptions: brokerStats.subscriptions || 0,
    };
  }, [brokerStats, chartHistory]);

  return (
    <div className="flex-1 bg-background overflow-auto">
      <div className="p-4 md:p-6 lg:p-8 space-y-6">

        {/* Page Title */}
        <div className="space-y-2">
          <h2 className="text-2xl font-bold tracking-tight text-foreground">MQTT Broker & Metrics</h2>
          <p className="text-sm text-muted-foreground">
            Monitor MQTT broker status, connections, and message flow
            {!initialLoadComplete && <span className="ml-2 text-xs">(Loading initial data...)</span>}
          </p>
        </div>

        {/* Metric Count Cards */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">{loading && !initialLoadComplete ? (
            // Show skeleton while loading initial data
            <>
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="h-4 bg-muted rounded w-2/3 mb-2"></div>
                  <div className="h-8 bg-muted rounded w-1/2"></div>
                </div>
              ))}
            </>
          ) : (
            <>
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
            </>
          )}
        </div>

        {/* MQTT Cards Side by Side */}
        <div className="grid gap-6 lg:grid-cols-2">{loading && !initialLoadComplete ? (
            // Show skeleton for charts
            <>
              <div className="card p-6 animate-pulse">
                <div className="h-6 bg-muted rounded w-1/3 mb-4"></div>
                <div className="h-64 bg-muted rounded"></div>
              </div>
              <div className="card p-6 animate-pulse">
                <div className="h-6 bg-muted rounded w-1/3 mb-4"></div>
                <div className="h-64 bg-muted rounded"></div>
              </div>
            </>
          ) : (
            <>
              {/* MQTT Broker Status Card with Agent Filter */}
              <div className="space-y-4">
                {/* Agent Filter Dropdown */}
                <div className="flex items-center gap-3">
                  <Filter className="w-4 h-4 text-muted-foreground" />
                  <Select value={selectedAgentUuid} onValueChange={setSelectedAgentUuid}>
                    <SelectTrigger className="w-[250px]">
                      <SelectValue placeholder="Filter by agent" />
                    </SelectTrigger>
                    <SelectContent>
                      {agents.map((agent) => (
                        <SelectItem key={agent.uuid} value={agent.uuid}>
                          {agent.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedAgentUuid !== 'all' && (
                    <span className="text-sm text-muted-foreground">
                      Showing {filteredTopics.length} topic{filteredTopics.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>
                
                {filteredTopics.length === 0 && selectedAgentUuid !== 'all' ? (
                  <div className="card p-8 text-center">
                    <p className="text-muted-foreground mb-2">No MQTT topics found for this device</p>
                    <p className="text-sm text-muted-foreground">
                      Device may be offline or not publishing any messages
                    </p>
                  </div>
                ) : (
                  <MqttBrokerCard 
                    deviceId={device.deviceUuid} 
                    topics={filteredTopics}
                    isConnected={isConnected}
                  />
                )}
              </div>

              {/* MQTT Metrics Card */}
              <MqttMetricsCard 
                refreshInterval={refreshInterval}
                onRefreshIntervalChange={setRefreshInterval}
                onManualRefresh={handleManualRefresh}
                isRefreshing={isRefreshing}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
