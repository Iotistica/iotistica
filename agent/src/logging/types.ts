/**
 * Logging types and interfaces
 * 
 * Simplified logging system inspired by balena-supervisor
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * Standardized component names for structured logging.
 * Use these constants instead of hardcoded strings to ensure consistency.
 * 
 * Usage:
 *   logger.info('Connection restored', { component: LogComponents.connectionMonitor });
 */
export const LogComponents = {
	// Core Agent
	agent: 'Agent',
	agentConfig: 'AgentConfig',
	agentUpdater: 'AgentUpdater',
  
	// API Integration
	cloudSync: 'Sync',
	apiPoller: 'ApiPoller',
  
	// Connectivity
	connectionMonitor: 'ConnectionMonitor',
  
	// State Management
	sync: 'Sync',
	stateReconciler: 'Reconciler',
	configManager: 'ConfigManager',
  
	// Container Orchestration
	containerManager: 'ContainerManager',
	dockerManager: 'DockerManager',
	dockerDriver: 'DockerDriver',
	k3sDriver: 'K3sDriver',
	orchestratorDriver: 'OrchestratorDriver',
	driverFactory: 'DriverFactory',
  
	// Protocol Adapters
	discovery: 'Discovery',
	modbus: 'Modbus',
	modbusRtu: 'ModbusRTU',
	modbusTcp: 'ModbusTCP',
	mqtt: 'MQTT',
	dictionary: 'Dictionary',
  
	// Logging System
	logMonitor: 'LogMonitor',
	localLogBackend: 'LocalLog',
	cloudLogBackend: 'CloudLog',
	logs: 'Logs',
	offlineQueue: 'OfflineQueue',
  
	// Device API
	deviceApi: 'DeviceAPI',
	cloudApi: 'CloudAPI',
  
	// Provisioning
	agentManager: 'AgentManager',
  
	// Security
	security: 'Security',
  
	// Network
	firewall: 'Firewall',
	wireGuardManager: 'WireGuardManager',
	tailscaleManager: 'TailscaleManager',
	networkRouteManager: 'NetworkRouteManager',
  
	// Database
	database: 'Database',
	migrations: 'Migrations',
  
	// System
	systemInfo: 'SystemInfo',
	metrics: 'Metrics',
	anomaly: 'Anomaly',
  
	// Features
	jobEngine: 'JobEngine',
	jobs: 'Jobs',
	sshTunnel: 'SSHTunnel',
	remoteAccess: 'RemoteAccess',
	device: 'Device',
	devicePublish: 'Publish',
	shell: 'Shell',
} as const;

export type LogComponent = typeof LogComponents[keyof typeof LogComponents];

export interface LogMessage {
	/** Unique log message ID */
	id?: string;
	/** Log message content */
	message: string;
	/** Timestamp in milliseconds since epoch */
	timestamp: number;
	/** Log level/severity */
	level: LogLevel;
	/** Source of the log */
	source: LogSource;
	/** Service ID (if from container) */
	serviceId?: number;
	/** Service name (if from container) */
	serviceName?: string;
	/** Container ID (if from container) */
	containerId?: string;
	/** Whether this is stdout (false) or stderr (true) */
	isStdErr?: boolean;
	/** Whether this is a system message */
	isSystem?: boolean;
}

export interface LogSource {
	/** Type of log source */
	type: 'container' | 'system' | 'manager';
	/** Name of the source */
	name: string;
}

export interface LogFilter {
	/** Filter by service ID */
	serviceId?: number;
	/** Filter by service name */
	serviceName?: string;
	/** Filter by container ID */
	containerId?: string;
	/** Filter by log level */
	level?: LogLevel;
	/** Filter by source type */
	sourceType?: 'container' | 'system' | 'manager';
	/** Start timestamp (ms) - logs after this time */
	since?: number;
	/** End timestamp (ms) - logs before this time */
	until?: number;
	/** Maximum number of logs to return */
	limit?: number;
	/** Include stderr logs */
	includeStderr?: boolean;
	/** Include stdout logs */
	includeStdout?: boolean;
}

export interface LogBackend {
	/** Store a log message */
	log(message: LogMessage): Promise<void>;
	/** Retrieve logs matching filter */
	getLogs(filter?: LogFilter): Promise<LogMessage[]>;
	/** Clear old logs */
	cleanup(olderThanMs: number): Promise<number>;
	/** Get total number of stored logs */
	getLogCount(): Promise<number>;
}

export interface LogStreamOptions {
	/** Container ID to stream logs from */
	containerId: string;
	/** Service ID */
	serviceId: number;
	/** Service name */
	serviceName: string;
	/** Stream stdout */
	stdout?: boolean;
	/** Stream stderr */
	stderr?: boolean;
	/** Follow log output (tail -f style) */
	follow?: boolean;
	/** Number of lines to show from the end */
	tail?: number;
	/** Show timestamps */
	timestamps?: boolean;
}

export interface ContainerLogAttachment {
	/** Container ID */
	containerId: string;
	/** Service ID */
	serviceId: number;
	/** Service name */
	serviceName: string;
	/** Whether streaming is active */
	isAttached: boolean;
	/** Detach from container logs */
	detach: () => Promise<void>;
}

// ============================================================================
// Cloud Log Backend types
// ============================================================================

import type { HttpClient } from '../lib/http-client';

/**
 * Summary of dropped logs for analysis.
 * Captures key metadata without storing full log content.
 */
export interface DroppedLogSummary {
	droppedAt: number;
	timeRange: {
		start: number;
		end: number;
	};
	totalCount: number;
	levelCounts: {
		error: number;
		warn: number;
		info: number;
		debug: number;
	};
	serviceCounts: Record<string, number>;
	errorSamples: Array<{
		timestamp: number;
		serviceName: string;
		message: string;
	}>;
	warningSamples: Array<{
		timestamp: number;
		serviceName: string;
		message: string;
	}>;
	estimatedBytes: number;
	reason: 'network_failure' | 'buffer_overflow' | 'retry_exhausted' | 'storage_budget';
}

/**
 * Cloud Log Backend Configuration
 */
export interface CloudLogBackendConfig {
	cloudEndpoint: string;
	deviceUuid: string;
	deviceApiKey?: string;
	/** Optional shared HTTP client for connection pooling */
	httpClient?: HttpClient;
	compression?: boolean;
	batchSize?: number;
	maxRetries?: number;
	bufferSize?: number;
	flushInterval?: number;
	reconnectInterval?: number;
	maxReconnectInterval?: number;
	/** Path to spool directory (e.g. /var/lib/agent/log-spool) */
	spoolPath?: string;
	/** Max spool file size before rotation (default: 50 MB) */
	maxSpoolSizeMb?: number;
	/** Max total size across all spool segment files (default: 200 MB) */
	maxTotalSpoolSizeMb?: number;
	/** Hard cap across RAM+disk logging data (default: 256 MB) */
	maxLogStorageMb?: number;
	samplingRates?: {
		error?: number;  // Default: 1.0 (100%)
		warn?: number;   // Default: 1.0 (100%)
		info?: number;   // Default: 1.0 (100%)
		debug?: number;  // Default: 0.05 (5%)
	};
}

/**
 * Batch metadata for ACK-based durability guarantee.
 */
export interface LogBatch {
	batchId: string;
	logs: LogMessage[];
	createdAt: number;
	attempts: number;
	approxBytes?: number;
}

/**
 * ACK cursor state — tracks what has been successfully delivered to the cloud.
 */
export interface AckCursor {
	lastAckBatchId?: string;
	lastAckTime: number;
}
