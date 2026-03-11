/**
 * MQTT Protocol Types
 */

export interface MqttBrokerConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  clientId?: string;
}

export interface MqttReconnectConfig {
  period: number;
  maxAttempts: number;
}

export interface MqttMetricConfig {
  field: string; // Field path in payload (supports dot notation)
  metric: string;
  unit?: string;
  type?: string;
}

export interface MqttDevice {
  name: string;
  enabled: boolean;
  topic: string;  // MQTT topic to subscribe to
  qos?: 0 | 1 | 2;
  dataType: string;  // Broad: 'number', 'boolean', 'string', 'json' (from discovery)
                     // Specific: 'int32', 'float32', 'uint32' (manual configuration only)
                     // ⚠️ Discovery MUST NOT auto-assign specific types - devices change formats
  unit?: string;
  metric?: string;  // Metric name (defaults to topic if not specified)
  deviceId?: string;  // Optional device identifier
  timestampField?: string; // Optional payload field path for source timestamp (e.g., ts, meta.timestamp)
  metrics?: MqttMetricConfig[]; // Optional multi-metric extraction from single topic payload
  autoMetrics?: boolean; // Auto-expand top-level JSON fields into metrics
  allowArrayMetrics?: boolean; // Enable values[0] style field paths by normalizing to values.0
}

export interface MqttAdapterConfig {
  broker: MqttBrokerConfig;
  qos: 0 | 1 | 2;
  reconnect: MqttReconnectConfig;
  devices: MqttDevice[];
  logging?: {
    level: string;
    enableConsole: boolean;
    enableFile: boolean;
  };
}
