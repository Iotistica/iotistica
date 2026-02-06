import { createContext, useContext, useState, ReactNode, useCallback } from 'react';

export interface SystemMetricsDataPoint {
  timestamp: number;  // Unix timestamp (Date.now())
  time: string;       // Formatted for display
  cpuPercent: number;
  memoryUsedPercent: number;
  networkRxMbps: number;
  networkTxMbps: number;
  temperature?: number;
}

export interface SystemMetricsCurrentData {
  cpuPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  memoryUsedPercent: number;
  networkRxMbps: number;
  networkTxMbps: number;
  temperature: number | null;
  uptime: number;
  loadAverage: [number, number, number];
}

interface DeviceMetricsHistory {
  [deviceUuid: string]: {
    chartHistory: SystemMetricsDataPoint[];
    currentStats: SystemMetricsCurrentData | null;
    selectedTimePeriod: '30min' | '6h' | '12h' | '24h';
    selectedMetric: 'cpu' | 'memory' | 'network';
  };
}

interface SystemMetricsContextType {
  // Per-device historical data
  getDeviceHistory: (deviceUuid: string) => SystemMetricsDataPoint[];
  getCurrentStats: (deviceUuid: string) => SystemMetricsCurrentData | null;
  getTimePeriod: (deviceUuid: string) => '30min' | '6h' | '12h' | '24h';
  getSelectedMetric: (deviceUuid: string) => 'cpu' | 'memory' | 'network';
  
  // Actions
  addMetricsDataPoint: (deviceUuid: string, point: SystemMetricsDataPoint) => void;
  updateCurrentStats: (deviceUuid: string, stats: SystemMetricsCurrentData) => void;
  setTimePeriod: (deviceUuid: string, period: '30min' | '6h' | '12h' | '24h') => void;
  setSelectedMetric: (deviceUuid: string, metric: 'cpu' | 'memory' | 'network') => void;
  clearDeviceHistory: (deviceUuid: string) => void;
  clearAllHistory: () => void;
}

const SystemMetricsContext = createContext<SystemMetricsContextType | undefined>(undefined);

const MAX_CHART_POINTS = 30; // Keep last 30 points (30 minutes at 1-min intervals for real-time)

export function SystemMetricsProvider({ children }: { children: ReactNode }) {
  const [deviceMetrics, setDeviceMetrics] = useState<DeviceMetricsHistory>({});

  const getDeviceHistory = useCallback((deviceUuid: string): SystemMetricsDataPoint[] => {
    return deviceMetrics[deviceUuid]?.chartHistory || [];
  }, [deviceMetrics]);

  const getCurrentStats = useCallback((deviceUuid: string): SystemMetricsCurrentData | null => {
    return deviceMetrics[deviceUuid]?.currentStats || null;
  }, [deviceMetrics]);

  const getTimePeriod = useCallback((deviceUuid: string): '30min' | '6h' | '12h' | '24h' => {
    return deviceMetrics[deviceUuid]?.selectedTimePeriod || '30min';
  }, [deviceMetrics]);

  const getSelectedMetric = useCallback((deviceUuid: string): 'cpu' | 'memory' | 'network' => {
    return deviceMetrics[deviceUuid]?.selectedMetric || 'cpu';
  }, [deviceMetrics]);

  const addMetricsDataPoint = useCallback((deviceUuid: string, point: SystemMetricsDataPoint) => {
    setDeviceMetrics(prev => {
      const deviceData = prev[deviceUuid] || { chartHistory: [], currentStats: null, selectedTimePeriod: '30min', selectedMetric: 'cpu' };
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceData,
          chartHistory: [...deviceData.chartHistory, point].slice(-MAX_CHART_POINTS)
        }
      };
    });
  }, []);

  const updateCurrentStats = useCallback((deviceUuid: string, stats: SystemMetricsCurrentData) => {
    setDeviceMetrics(prev => {
      const deviceData = prev[deviceUuid] || { chartHistory: [], currentStats: null, selectedTimePeriod: '30min', selectedMetric: 'cpu' };
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceData,
          currentStats: stats
        }
      };
    });
  }, []);

  const setTimePeriod = useCallback((deviceUuid: string, period: '30min' | '6h' | '12h' | '24h') => {
    setDeviceMetrics(prev => {
      const deviceData = prev[deviceUuid] || { chartHistory: [], currentStats: null, selectedTimePeriod: '30min', selectedMetric: 'cpu' };
      
      // When switching time periods, clear chart history (will be refetched)
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceData,
          chartHistory: [], // Clear history on period change
          selectedTimePeriod: period
        }
      };
    });
  }, []);

  const setSelectedMetric = useCallback((deviceUuid: string, metric: 'cpu' | 'memory' | 'network') => {
    setDeviceMetrics(prev => {
      const deviceData = prev[deviceUuid] || { chartHistory: [], currentStats: null, selectedTimePeriod: '30min', selectedMetric: 'cpu' };
      
      return {
        ...prev,
        [deviceUuid]: {
          ...deviceData,
          selectedMetric: metric
        }
      };
    });
  }, []);

  const clearDeviceHistory = useCallback((deviceUuid: string) => {
    setDeviceMetrics(prev => {
      const newMetrics = { ...prev };
      delete newMetrics[deviceUuid];
      return newMetrics;
    });
  }, []);

  const clearAllHistory = useCallback(() => {
    setDeviceMetrics({});
  }, []);

  return (
    <SystemMetricsContext.Provider value={{
      getDeviceHistory,
      getCurrentStats,
      getTimePeriod,
      getSelectedMetric,
      addMetricsDataPoint,
      updateCurrentStats,
      setTimePeriod,
      setSelectedMetric,
      clearDeviceHistory,
      clearAllHistory
    }}>
      {children}
    </SystemMetricsContext.Provider>
  );
}

export function useSystemMetrics() {
  const context = useContext(SystemMetricsContext);
  if (context === undefined) {
    throw new Error('useSystemMetrics must be used within a SystemMetricsProvider');
  }
  return context;
}
