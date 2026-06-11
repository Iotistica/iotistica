import { z } from "zod";


/**
 * Unix Socket Output Configuration Schema (Protocol-agnostic)
 */
export const SocketOutputSchema = z.object({
	socketPath: z.string().min(1),
	dataFormat: z.enum(["json", "csv"]).optional().default("json"),
	delimiter: z.string().optional().default("\n"),
	includeTimestamp: z.boolean().optional().default(true),
	includeDeviceName: z.boolean().optional().default(true),
});

export type SocketOutput = z.infer<typeof SocketOutputSchema>;

/**
 * device Data Point interface
 * Quality model follows OPC UA standard (GOOD, BAD, UNCERTAIN)
 */
export interface DeviceDataPoint {
	deviceName: string;
	deviceId?: string;
	device_uuid?: string;
	endpoint_uuid?: string; // UUID from the endpoints table (target state)
	metric: string; // Generic field name (Modbus register, OPC UA node, SNMP OID)
	value: number | boolean | string | null; // null when quality is BAD
	unit?: string;
	timestamp: string;
	quality: "GOOD" | "BAD" | "UNCERTAIN"; // OPC UA quality codes
	qualityCode?: string; // Error code when quality is BAD (e.g., 'ETIMEDOUT', 'DEVICE_OFFLINE')
	protocol?: string; // Protocol context for enum namespacing (modbus, snmp, opcua, mqtt, bacnet)
	nodeType?: "metric" | "metadata"; // Node classification (OPC UA only)
	resolvedDisplayName?: string; // Human-readable name resolved from the protocol server (e.g. OPC-UA DisplayName, SNMP sysName, BACnet objectName, or metadata.displayName config override). Used by AdapterManager as the base of the final unique display name instead of the raw config name.
	anomaly_score?: number; // anomaly score (0.0 = normal, 1.0 = max anomaly)
	anomaly_threshold?: number; // Confidence threshold used for alerting (e.g., 0.7)
	baseline_samples?: number; // Number of samples in baseline buffer
	detection_methods?: string[]; // Detection methods used (e.g., ["zscore", "mad"])
}

/**
 * Device Status interface
 * Contains both static metadata and dynamic health metrics
 *
 * Generic across all protocols (Modbus, SNMP, OPC-UA, MQTT, BACnet)
 */
export interface IDeviceStatus {
	// Basic identity
	deviceName: string;

	// Connection state
	connected: boolean;
	lastPoll: Date | null;
	lastSeen: Date | null; // Last successful communication (different from lastPoll which can be failed attempt)

	// Error tracking
	errorCount: number;
	lastError: string | null;

	// Performance metrics (point-in-time)
	responseTimeMs: number | null; // Last response time in milliseconds
	pollSuccessRate: number; // Rolling success rate 0-1 (calculated from recent polls)

	// Data quality
	registersUpdated: number; // How many registers/values changed in last poll

	// Overall health indicator
	communicationQuality: "good" | "degraded" | "poor" | "offline";

	// Time-series metrics (optional - for advanced monitoring)
	// Enables P95/P99 calculations, trending, and anomaly detection
	metrics?: {
		pollDurations: number[]; // Last N poll durations (ms) - for P95/P99
		pollSuccessCount: number; // Total successful polls
		pollTotalCount: number; // Total poll attempts
		dataPointsUpdated: number[]; // Last N data points changed per poll
		lastErrors: Array<{
			// Last N errors with context
			timestamp: Date;
			type: string; // Error code (TIMEOUT, CONNECTION_REFUSED, etc.)
			message: string;
		}>;
	};
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
 * Standard client contract for protocol-specific device clients.
 *
 * Adapters orchestrate multiple clients; each client owns one device connection.
 * External plugin authors should follow this shape to keep lifecycle behavior
 * consistent across protocols.
 */
export interface IProtocolClient<
	TReadRequest = unknown,
	TReadResult = DeviceDataPoint[]
> {
	connect(): Promise<void>;
	disconnect(): Promise<void>;
	isConnected(): boolean;
	read(request?: TReadRequest): Promise<TReadResult>;
	write?(registerName: string, value: number | boolean | string): Promise<void>;
}

/**
 * Common runtime contract for protocol adapters managed by AdapterManager.
 */
export interface IProtocolAdapter {
	start(): Promise<void>;
	stop(): Promise<void>;
	isRunning(): boolean;
	getDeviceStatuses(): IDeviceStatus[];
	on(event: string, listener: (...args: any[]) => void): this;
}

export interface IDiscovery {
	discover(options?: any): Promise<DiscoveredDevice[]>;
	validate(device: DiscoveredDevice, timeout?: number): Promise<any>;
	isAvailable(): Promise<boolean>;
	generateFingerprint(...args: any[]): string;
	getInfo(): PluginInfo;
}

/**
 * Startup callback registered per protocol in AdapterManager.
 */
export type ProtocolAdapterStarter = () => Promise<void>;

/**
 * External plugin module configuration in agent config.
 */
export interface ExternalPluginConfig {
	modulePath: string;
	enabled?: boolean;
	options?: Record<string, unknown>;
	allowBuiltInOverride?: boolean;
}

/**
 * Manifest exposed by external protocol plugins.
 */
export interface ExternalPluginManifest {
	name: string;
	version: string;
	apiVersion: string;
	protocol: string;
	description?: string;
}

// ---------------------------------------------------------------------------
// Discovery types (previously base.discovery.ts)
// ---------------------------------------------------------------------------

export interface ValidationResult {
	deviceInfo?: any;
	manufacturer?: string;
	modelNumber?: string;
	firmwareVersion?: string;
	capabilities?: string[];

	dataPointValidation?: {
		result: "config_match" | "config_mismatch" | "degraded" | "unknown";
		state: "idle" | "active" | "unknown";
		responseConfidence: number;
		dataConfidence: number;
		readableCount: number;
		errorCount: number;
		zeroCount: number;
		totalPoints: number;
		details?: string;
		guidance?: string;
		meiVendor?: string;
		meiModel?: string;
	};
}

export interface DiscoveredDevice {
	protocol: "modbus" | "opcua" | "can" | "snmp" | "mqtt" | "bacnet";
	name: string;
	fingerprint: string;
	uuid?: string;
	connection: Record<string, any>;
	dataPoints: any[];
	confidence: "low" | "medium" | "high";
	discoveredAt: string;
	validated: boolean;
	validationData?: ValidationResult;
	metadata?: Record<string, any>;
}

export interface DiscoveryResult {
	devices: DiscoveredDevice[];
	duration: number;
	errors?: string[];
}

export interface PluginInfo {
	protocol: string;
	version: string;
	description: string;
	capabilities?: string[];
}


