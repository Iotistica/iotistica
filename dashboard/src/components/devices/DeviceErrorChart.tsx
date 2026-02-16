/**
 * Sensor Error Chart
 * Shows error count accumulation over time
 */

import React from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
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
  last_error: string | null;
}

interface SensorErrorChartProps {
  data: HistoryPoint[];
}

export const SensorErrorChart: React.FC<SensorErrorChartProps> = ({ data }) => {
  // Transform data for chart
  const chartData = data.map((point) => ({
    time: new Date(point.reported_at).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    }),
    errors: point.error_count,
    timestamp: point.reported_at,
    lastError: point.last_error,
  }));

  if (chartData.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-muted-foreground space-y-2">
        <p className="font-medium">No historical data available</p>
        <p className="text-sm">Error trends will appear here as data accumulates (24h history)</p>
      </div>
    );
  }

  const maxErrors = Math.max(...chartData.map(d => d.errors), 10);

  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={chartData}>
        <defs>
          <linearGradient id="errorGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3}/>
            <stop offset="95%" stopColor="#ef4444" stopOpacity={0}/>
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
        <XAxis 
          dataKey="time" 
          stroke="#6b7280"
          fontSize={12}
        />
        <YAxis 
          stroke="#6b7280"
          fontSize={12}
          domain={[0, maxErrors]}
        />
        <Tooltip 
          contentStyle={{ 
            backgroundColor: 'white', 
            border: '1px solid #e5e7eb',
            borderRadius: '6px',
          }}
          content={({ active, payload }) => {
            if (active && payload && payload.length) {
              const data = payload[0].payload;
              return (
                <div className="bg-white border border-gray-200 rounded-lg p-3 shadow-lg">
                  <p className="text-sm font-medium">{data.time}</p>
                  <p className="text-sm text-red-600">
                    Errors: <span className="font-bold">{data.errors}</span>
                  </p>
                  {data.lastError && (
                    <p className="text-xs text-muted-foreground mt-1">
                      {data.lastError}
                    </p>
                  )}
                </div>
              );
            }
            return null;
          }}
        />
        <Legend />
        <Area 
          type="monotone" 
          dataKey="errors" 
          stroke="#ef4444" 
          strokeWidth={2}
          fill="url(#errorGradient)"
          name="Error Count"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
};
