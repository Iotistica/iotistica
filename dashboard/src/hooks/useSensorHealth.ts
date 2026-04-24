/**
 * useSensorHealth Hook
 * Fetches sensor health data from the API
 */

import { useState, useEffect, useCallback } from 'react';

interface SensorHealthData {
  devices: Array<{
    name: string;
    protocol: string;
    status: 'online' | 'offline' | 'error';
    connected: boolean;
    lastPoll: string | null;
    errorCount: number;
    lastError: string | null;
    lastSeen: string;
  }>;
  pipelines: Array<{
    name: string;
    state: string;
    healthy: boolean;
    messagesReceived: string | number;
    messagesPublished: string | number;
    lastActivity: string | null;
    lastError: string | null;
    lastSeen: string;
  }>;
  summary: {
    total: number;
    online: number;
    offline: number;
    errors: number;
  };
}

interface UseSensorHealthResult {
  data: SensorHealthData | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export const useSensorHealth = (deviceUuid: string): UseSensorHealthResult => {
  const [data, setData] = useState<SensorHealthData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchData = useCallback(async (isInitialLoad = false) => {
    try {
      // Only show loading spinner on initial load, not on refresh
      if (isInitialLoad) {
        setLoading(true);
      }
      setError(null);

      // Fetch device health (protocol adapters) for summary and devices
      const healthResponse = await fetch(`/api/v1/devices/${deviceUuid}/device-health`);
      
      if (!healthResponse.ok) {
        throw new Error(`HTTP ${healthResponse.status}: ${healthResponse.statusText}`);
      }

      const healthData = await healthResponse.json();
      
      // Fetch sensor pipeline data
      const sensorsResponse = await fetch(`/api/v1/devices/${deviceUuid}/sensors`);
      const sensorsData = sensorsResponse.ok ? await sensorsResponse.json() : { pipelines: [] };
      
      // Transform data to match expected format
      const transformedData: SensorHealthData = {
        devices: (healthData.devices || []).map((device: any) => ({
          ...device,
          status: (device.status === 'online' || device.status === 'offline' || device.status === 'error') 
            ? device.status 
            : 'offline' // Default to offline if status is invalid
        })),
        pipelines: sensorsData.pipelines || [],
        summary: healthData.summary || {
          total: 0,
          online: 0,
          offline: 0,
          errors: 0
        }
      };

      setData(transformedData);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error'));
    } finally {
      if (isInitialLoad) {
        setLoading(false);
      }
    }
  }, [deviceUuid]);

  useEffect(() => {
    fetchData(true); // Pass true for initial load
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    refetch: () => fetchData(false) // Pass false for refresh (no loading state change)
  };
};
