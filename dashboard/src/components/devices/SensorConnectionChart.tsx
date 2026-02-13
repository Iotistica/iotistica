/**
 * Sensor Connection Chart
 * Shows connection/disconnection timeline over 24 hours
 */

import React from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';

interface HistoryPoint {
  reported_at: string;
  connected: boolean;
  healthy: boolean;
  error_count: number;
}

interface SensorConnectionChartProps {
  data: HistoryPoint[];
}

export const SensorConnectionChart: React.FC<SensorConnectionChartProps> = ({ data }) => {
  // Transform data for chart
  const chartData = data.map((point) => ({
    time: new Date(point.reported_at).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    connected: point.connected ? 1 : 0,
    healthy: point.healthy ? 1 : 0,
    timestamp: point.reported_at,
  }));

  if (chartData.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-2">
        <p className="font-medium">No historical data available</p>
        <p className="text-sm">Data will appear here as the sensor reports over time (24h history)</p>
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={300}>
      <LineChart data={chartData}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis 
          dataKey="time" 
          stroke="#6b7280"
          fontSize={12}
        />
        <YAxis 
          stroke="#6b7280"
          fontSize={12}
          domain={[0, 1]}
          ticks={[0, 1]}
          tickFormatter={(value) => value === 1 ? 'Yes' : 'No'}
        />
        <Tooltip 
          contentStyle={{ 
            backgroundColor: 'white', 
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
          }}
          formatter={(value: any, name: string) => {
            if (name === 'connected' || name === 'healthy') {
              return [value === 1 ? 'Yes' : 'No', name === 'connected' ? 'Connected' : 'Healthy'];
            }
            return [value, name];
          }}
        />
        <Legend />
        <Line 
          type="stepAfter" 
          dataKey="connected" 
          stroke="#10b981" 
          strokeWidth={2}
          dot={false}
          name="Connected"
        />
        <Line 
          type="stepAfter" 
          dataKey="healthy" 
          stroke="#3b82f6" 
          strokeWidth={2}
          dot={false}
          name="Healthy"
        />
      </LineChart>
    </ResponsiveContainer>
  );
};
