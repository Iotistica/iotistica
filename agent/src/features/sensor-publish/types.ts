import { z } from 'zod';

/**
 * Sensor State enumeration
 */
export enum SensorState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

/**
 * Sensor Configuration Schema
 */
export const SensorConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  addr: z.string(),
  addrPollSec: z.number().optional().default(10),
  publishInterval: z.number().optional().default(30000), // Publish interval in milliseconds
  bufferTimeMs: z.number().optional().default(0),
  bufferSize: z.number().optional().default(0),
  bufferCapacity: z.number().optional().default(128 * 1024), // 128KB default
  eomDelimiter: z.string(),
  mqttTopic: z.string(),
  mqttHeartbeatTopic: z.string().optional(),
  heartbeatTimeSec: z.number().optional().default(300)
});

export type SensorConfig = z.infer<typeof SensorConfigSchema>;

/**
 * Sensor Publish Feature Configuration Schema
 */
export const SensorPublishConfigSchema = z.object({
  enabled: z.boolean().default(true),
  endpoints: z.array(SensorConfigSchema).max(10)
});

export type SensorPublishConfig = z.infer<typeof SensorPublishConfigSchema> & {
  enabled: boolean; // Make sure it extends FeatureConfig
};

/**
 * MQTT Connection interface for publishing sensor data
 */
export interface MqttConnection {
  publish(topic: string, payload: string | Buffer, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
  isConnected(): boolean;
}

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}

/**
 * Sensor Statistics
 */
export interface SensorStats {
  messagesReceived: number;
  messagesPublished: number;
  bytesReceived: number;
  bytesPublished: number;
  reconnectAttempts: number;
  lastPublishTime?: Date;
  lastHeartbeatTime?: Date;
  lastError?: string;
  lastErrorTime?: Date;
  lastConnectedTime?: Date;
}

/**
 * Sensor Message Batch
 */
export interface MessageBatch {
  messages: string[];
  totalBytes: number;
  firstMessageTime: Date;
}
