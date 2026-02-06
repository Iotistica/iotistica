import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

export interface MqttDataPoint {
  timestamp: number;  // Unix timestamp (Date.now())
  time: string;       // Formatted for display
  messageRatePublished: number;
  messageRateReceived: number;
  throughputInbound: number;
  throughputOutbound: number;
  connectedClients: number;
  subscriptions: number;
}

export interface MqttBrokerStatsData {
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

export interface MqttTopic {
  topic: string;
  messageCount: number;
  bytesReceived: number;
  lastMessageAt?: string;
}

interface MqttContextType {
  // Current stats
  brokerStats: MqttBrokerStatsData | null;
  topics: MqttTopic[];
  
  // Historical data for charts (ring buffer - last 30 points)
  chartHistory: MqttDataPoint[];
  
  // Actions
  updateBrokerStats: (stats: MqttBrokerStatsData) => void;
  updateTopics: (topics: MqttTopic[]) => void;
  addChartDataPoint: (point: MqttDataPoint) => void;
  clearHistory: () => void;
}

const MqttContext = createContext<MqttContextType | undefined>(undefined);

const MAX_CHART_POINTS = 30; // Keep last 30 points (5 minutes at 10s intervals)

export function MqttProvider({ children }: { children: ReactNode }) {
  const [brokerStats, setBrokerStats] = useState<MqttBrokerStatsData | null>(null);
  const [topics, setTopics] = useState<MqttTopic[]>([]);
  const [chartHistory, setChartHistory] = useState<MqttDataPoint[]>([]);

  const updateBrokerStats = useCallback((stats: MqttBrokerStatsData) => {
    setBrokerStats(stats);
  }, []);

  const updateTopics = useCallback((newTopics: MqttTopic[]) => {
    setTopics(newTopics);
  }, []);

  const addChartDataPoint = useCallback((point: MqttDataPoint) => {
    setChartHistory(prev => {
      // Add new point and keep only last MAX_CHART_POINTS
      return [...prev, point].slice(-MAX_CHART_POINTS);
    });
  }, []);

  const clearHistory = useCallback(() => {
    setChartHistory([]);
  }, []);

  return (
    <MqttContext.Provider value={{
      brokerStats,
      topics,
      chartHistory,
      updateBrokerStats,
      updateTopics,
      addChartDataPoint,
      clearHistory
    }}>
      {children}
    </MqttContext.Provider>
  );
}

export function useMqtt() {
  const context = useContext(MqttContext);
  if (context === undefined) {
    throw new Error('useMqtt must be used within a MqttProvider');
  }
  return context;
}
