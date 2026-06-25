import { z } from 'zod';

/**
 * Device State enumeration
 */
export enum DeviceState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}

/**
 * Device Configuration Schema
 */
export const DriftOptionsSchema = z.object({
	enabled: z.boolean().optional(),
	warmupBatches: z.number().int().min(1).optional(),
	consecutiveMissingThreshold: z.number().int().min(1).optional(),
	alertCooldownMs: z.number().min(0).optional(),
	minFieldPresenceRatio: z.number().min(0).max(1).optional(),
}).optional();

export type DriftOptions = z.infer<typeof DriftOptionsSchema>;

export const DeviceConfigSchema = z.object({
	name: z.string().optional(),
	protocol: z.string().optional(),
	enabled: z.boolean().optional().default(true),
	addr: z.string(),
	addrPollSec: z.number().optional().default(10),
	publishInterval: z.number().optional().default(30000),
	bufferTimeMs: z.number().optional().default(0),
	bufferSize: z.number().optional().default(0),
	bufferCapacity: z.number().optional().default(1024 * 1024),
	eomDelimiter: z.string(),
	mqttTopic: z.string(),
	mqttHeartbeatTopic: z.string().optional(),
	heartbeatTimeSec: z.number().optional().default(300),
	driftOptions: DriftOptionsSchema,
});

export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

/**
 * Device Publish Feature Configuration Schema
 */
export const DevicePublishConfigSchema = z.object({
	enabled: z.boolean().default(true),
	endpoints: z.array(DeviceConfigSchema).max(10)
});

export type DevicePublishConfig = z.infer<typeof DevicePublishConfigSchema> & {
  enabled: boolean; // Make sure it extends FeatureConfig
};

/**
 * MQTT Connection interface for publishing device data
 */
export type PublishMode = 'direct' | 'buffer-only' | 'recovering';

export type PublishTarget = 'iotistica' | 'azure' | 'aws' | 'gcp' | 'mqtt' | 'influxdb';

export function normalizeTarget(target?: string): PublishTarget {
	const value = target?.trim().toLowerCase() ?? '';

	switch (value) {
		case 'iotistica':
		case 'azure':
		case 'aws':
		case 'gcp':
		case 'mqtt':
		case 'influxdb':
			return value;
		default:
			return 'iotistica';
	}
}

export interface PublishBatchItem {
  topic: string;
  payload: string | Buffer;
  options?: { qos?: 0 | 1 | 2; destinationTopic?: string };
}

export interface PublishDestinationInfo {
  destinationId?: number;
  destinationName: string;
  destinationType: string;
  subscriptionIds: number[];
  topics: string[];
}

export interface IPublishClient {
  connect?(...args: any[]): Promise<void>;
  disconnect?(...args: any[]): Promise<void>;
  publish(topic: string, payload: string | Buffer, options?: { qos?: 0 | 1 | 2; destinationTopic?: string }): Promise<void>;
  isConnected(): boolean;
  getMessageIdGenerator?(): any;
  getPublishMode?(): PublishMode;
}

export interface IPublishPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  isConnected(): boolean;
  publishBatch(batch: PublishBatchItem[]): Promise<void>;
  getDestinationInfo?(): PublishDestinationInfo[];
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface PublishPluginStarterContext {
  target: string;
  client: IPublishClient;
  logger?: Logger;
  config?: Record<string, unknown> | null;
  endpointName?: string;
}

export type PublishPluginStarter = (
  context: PublishPluginStarterContext,
) => IPublishPlugin;

export interface MqttConnection extends IPublishClient {
  publish(topic: string, payload: string | Buffer, options?: { qos?: 0 | 1 | 2 }): Promise<void>;
  isConnected(): boolean;
  getMessageIdGenerator?(): any; // Optional for HA deduplication (returns MessageIdGenerator if available)
  getPublishMode?(): PublishMode;
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
 * Device Statistics
 */
export interface DeviceStats {
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
 * Device Message Batch
 * OPTIMIZATION: Stores pre-parsed objects to avoid duplicate JSON.parse() calls
 * - feedMessagesToAnomaly() and enrichMessagesWithAnomalyScores() both need parsed objects
 * - Parsing once at batch entry reduces CPU by ~50% (eliminates 1 of 2 parse operations)
 * - firstMessageTime uses timestamp (number) instead of Date object for efficiency
 */
export interface MessageBatch {
  messages: any[]; // Pre-parsed objects (parsed once in addMessageToBatch)
  totalBytes: number;
  firstMessageTime: number; // Timestamp (ms since epoch) - format once at publish
}
