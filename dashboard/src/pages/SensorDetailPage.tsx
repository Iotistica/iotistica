/**
 * Sensor Detail Modal/View
 * Shows detailed information and historical charts for a single sensor
 */

import React, { useState, useEffect } from 'react';
import { Activity, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { SensorConnectionChart } from '@/components/sensors/SensorConnectionChart';
import { SensorErrorChart } from '@/components/sensors/SensorErrorChart';

interface SensorDetail {
  name: string;
  protocol: string;
  status: string;
  connected: boolean;
  lastPoll: string | null;
  errorCount: number;
  lastError: string | null;
  lastSeen: string;
}

interface SensorHistory {
  reported_at: string;
  connected: boolean;
  healthy: boolean;
  error_count: number;
  last_error: string | null;
}

interface SensorDetailPageProps {
  deviceUuid: string;
  sensorName: string;
  onClose: () => void;
}

export const SensorDetailPage: React.FC<SensorDetailPageProps> = ({ 
  deviceUuid, 
  sensorName,
  onClose,
}) => {
  
  const [sensor, setSensor] = useState<SensorDetail | null>(null);
  const [history, setHistory] = useState<SensorHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        
        // Fetch current sensor status from device-health endpoint
        const sensorsResponse = await fetch(`/api/v1/devices/${deviceUuid}/device-health`);
        const sensorsData = await sensorsResponse.json();
        const currentSensor = sensorsData.devices.find((d: any) => d.name === sensorName);
        
        if (currentSensor) {
          const nextSensor = {
            name: currentSensor.name,
            protocol: currentSensor.protocol,
            status: currentSensor.status,
            connected: currentSensor.connected,
            lastPoll: currentSensor.lastPoll,
            errorCount: currentSensor.errorCount,
            lastError: currentSensor.lastError,
            lastSeen: currentSensor.lastSeen
          };
          setSensor(nextSensor);

          // Fetch 24-hour history from protocol adapter history
          const historyResponse = await fetch(
            `/api/v1/devices/${deviceUuid}/protocol-adapters/${currentSensor.protocol}/${sensorName}/history?hours=24`
          );
          
          if (historyResponse.ok) {
            const historyData = await historyResponse.json();
            
            // Transform protocol adapter history to match expected format
            const transformedHistory = (historyData.history || []).map((h: any) => ({
              reported_at: h.timestamp,
              connected: h.connected,
              healthy: h.connected && h.error_count === 0,
              error_count: h.error_count,
              last_error: h.last_error
            }));
            setHistory(transformedHistory);
          } else {
            console.warn('⚠️ History fetch failed:', historyResponse.status, historyResponse.statusText);
          }
        }
        
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load sensor data');
      } finally {
        setLoading(false);
      }
    };

    if (deviceUuid && sensorName) {
      fetchData();
    }
  }, [deviceUuid, sensorName]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Activity className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!sensor) {
    return (
      <Alert>
        <AlertDescription>Sensor not found</AlertDescription>
      </Alert>
    );
  }

  const StatusBadge = ({ status }: { status: string }) => {
    const variants: Record<string, 'default' | 'destructive' | 'secondary'> = {
      online: 'default',
      offline: 'destructive',
      error: 'secondary',
    };
    return <Badge variant={variants[status] || 'secondary'}>{status}</Badge>;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">{sensor.name}</h2>
        <p className="text-muted-foreground">
          {sensor.protocol.toUpperCase()} Protocol
        </p>
      </div>

      {/* Current Status Card */}
      <Card>
        <CardHeader>
          <CardTitle>Current Status</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-sm text-muted-foreground">Status</p>
              <StatusBadge status={sensor.status} />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Error Count</p>
              <p className="text-2xl font-bold text-destructive">{sensor.errorCount}</p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last Poll</p>
              <p className="text-sm font-medium">
                {sensor.lastPoll ? new Date(sensor.lastPoll).toLocaleString() : 'Never'}
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Last Seen</p>
              <p className="text-sm font-medium">
                {sensor.lastSeen ? new Date(sensor.lastSeen).toLocaleString() : 'Never'}
              </p>
            </div>
          </div>

          {sensor.lastError && (
            <div className="mt-4 bg-muted rounded-lg p-4">
              <p className="text-sm">
                <span className="font-medium">Last Error:</span>{' '}
                <span className="text-muted-foreground">{sensor.lastError}</span>
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Connection Status Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Connection Status (Last 24 Hours)
          </CardTitle>
          <CardDescription>
            Shows when the sensor was connected vs disconnected
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SensorConnectionChart data={history} />
        </CardContent>
      </Card>

      {/* Error Trend Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Error Count Trend
          </CardTitle>
          <CardDescription>
            Tracks error accumulation over time
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SensorErrorChart data={history} />
        </CardContent>
      </Card>

      {/* Recent Events */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Events</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {history.slice(0, 10).map((event, index) => (
              <div 
                key={index}
                className="flex items-start gap-3 p-3 rounded-lg border"
              >
                <div className="text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(event.reported_at).toLocaleTimeString()}
                </div>
                <div className="flex-1">
                  <p className="text-sm">
                    {event.connected ? (
                      <span className="text-green-600">✓ Connected</span>
                    ) : (
                      <span className="text-red-600">✗ Disconnected</span>
                    )}
                  </p>
                  {event.last_error && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Error: {event.last_error}
                    </p>
                  )}
                </div>
                <Badge variant="outline">{event.error_count} errors</Badge>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
};
