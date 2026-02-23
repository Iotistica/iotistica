import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface AnomalyEventData {
  msg_id: string;
  agent_uuid: string;
  device_name: string;
  device_type: string;
  metric: string;
  timestamp_ms: number;
  observed_value: number;
  baseline: {
    mean: number;
    median: number;
    stdDev: number;
  };
  anomaly_score: number;
  confidence: number;
  severity: 'info' | 'warning' | 'critical';
  deviation: number;
  triggered_by: string[];
  expected_range: [number, number];
}

interface IncidentTimelineChartProps {
  events: AnomalyEventData[];
}

export function IncidentTimelineChart({ events }: IncidentTimelineChartProps) {
  if (events.length === 0) {
    return (
      <div className="w-full h-64 flex items-center justify-center text-gray-500">
        No events data available
      </div>
    );
  }

  // Transform data for chart
  const chartData = events
    .sort((a, b) => a.timestamp_ms - b.timestamp_ms)
    .map((event) => ({
      timestamp: new Date(event.timestamp_ms).toLocaleTimeString(),
      observed: parseFloat(event.observed_value.toFixed(2)),
      baseline: parseFloat(event.baseline.mean.toFixed(2)),
      anomalyScore: parseFloat(event.anomaly_score.toFixed(2)),
      confidence: parseFloat(event.confidence.toFixed(2)),
    }));

  // Calculate Y-axis domains
  const observedValues = chartData.map(d => d.observed);
  const baselineValues = chartData.map(d => d.baseline);
  const allValues = [...observedValues, ...baselineValues];
  const minValue = Math.min(...allValues);
  const maxValue = Math.max(...allValues);
  const padding = (maxValue - minValue) * 0.1;

  return (
    <div className="w-full h-96">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={chartData}
          margin={{ top: 5, right: 30, left: 0, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="timestamp"
            tick={{ fontSize: 12 }}
            angle={-45}
            textAnchor="end"
            height={80}
          />
          <YAxis
            yAxisId="left"
            label={{ value: 'Observed / Baseline', angle: -90, position: 'insideLeft' }}
            domain={[minValue - padding, maxValue + padding]}
          />
          <YAxis
            yAxisId="right"
            orientation="right"
            domain={[0, 1]}
            label={{ value: 'Anomaly Score / Confidence', angle: 90, position: 'insideRight' }}
          />
          <Tooltip
            formatter={(value: any) => {
              if (typeof value === 'number') return value.toFixed(3);
              return value;
            }}
            contentStyle={{
              backgroundColor: '#f3f4f6',
              border: '1px solid #d1d5db',
              borderRadius: '0.375rem',
            }}
          />
          <Legend />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="observed"
            stroke="#3b82f6"
            name="Observed Value"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="baseline"
            stroke="#10b981"
            name="Baseline (Mean)"
            dot={false}
            strokeWidth={2}
            strokeDasharray="5 5"
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="anomalyScore"
            stroke="#f97316"
            name="Anomaly Score"
            dot={false}
            strokeWidth={2}
          />
          <Line
            yAxisId="right"
            type="monotone"
            dataKey="confidence"
            stroke="#8b5cf6"
            name="Confidence"
            dot={false}
            strokeWidth={2}
            strokeDasharray="5 5"
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
