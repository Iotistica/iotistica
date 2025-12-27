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

export interface MqttDevice {
  name: string;
  enabled: boolean;
  topic: string;  // MQTT topic to subscribe to
  qos?: 0 | 1 | 2;
  dataType: string;  // float32, int32, string, boolean, etc.
  unit?: string;
  metric?: string;  // Metric name (defaults to topic if not specified)
  deviceId?: string;  // Optional device identifier
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
