/**
 * CONFIG MANAGER
 * ==============
 * 
 * Manages device configuration reconciliation - separate from container orchestration.
 * Handles sensor (protocol adapter devices) registration, updates, and removal.
 * 
 * This is the config counterpart to ContainerManager, allowing the StateReconciler
 * to manage both containers AND configuration in a unified way.
 */

import { EventEmitter } from 'events';
import _ from 'lodash';
import { models as db } from '../db/connection.js';
import { DeviceEndpointModel, type DeviceEndpoint } from '../db/models/endpoint.model.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents, type LogLevel } from '../logging/types.js';
import type {
	DeviceConfig,
	ConfigStep,
	ConfigReconciliationResult,
	ProtocolAdapterDevice,
} from '../drivers/types.js';

// ==================== CONFIG TYPES ====================

export interface ModbusConnectionConfig {
	uuid?: string;
	name?: string;
	host: string;
	port: number;
	enabled?: boolean;
	timeoutMs?: number;
	profile?: string;
	addressing?: {
		slaveRange?: { start: number; end: number; };
	};
	points?: any;
}

export interface ModbusConfig {
	enabled: boolean;
	connections?: ModbusConnectionConfig[];
	tcpHost?: string;
	tcpPort?: number;
	slaveRangeStart: number;
	slaveRangeEnd: number;
	timeout: number;
	profile?: string;
	profileDataPoints?: any[];
	rtuPort?: string;
	rtuBaudRate?: number;
	rtuParity?: string;
	rtuDataBits?: number;
	rtuStopBits?: number;
}

export interface OPCUAConfig {
	enabled?: boolean;
	connections?: string[];
	discoveryUrls?: string[];
}

export interface SNMPConfig {
	enabled?: boolean;
	connections?: string[];
	ipRanges?: string[];
	port?: number;
}

export interface MQTTConfig {
	enabled?: boolean;
	brokerUrl?: string;
	username?: string;
	password?: string;
	discoveryRoots?: string[];
	monitorDurationMs?: number;
	qos?: 0 | 1 | 2;
}

export interface BACnetConfig {
	enabled?: boolean;
	port?: number;
	discoveryTargets?: string[];
	broadcastAddress?: string;
	timeout?: number;
	maxDevices?: number;
}

export interface PerformanceConfig {
	memoryCheckIntervalMs?: number;
	memoryThresholdMb?: number;
}

export interface LoggingConfig {
	logMaxAge?: number;
	maxLogFileSize?: number;
	maxLogs?: number;
	enableFilePersistence?: boolean;
	enableCompression?: boolean;
	logBatchSize?: number;
	logFlushIntervalMs?: number;
	logDir?: string;
	logLevel?: string;
}

export interface FeatureToggles {
	enableSensorPublish: boolean;
	enableAnomalyDetection: boolean;
}

export interface IntervalConfig {
	discoveryFullIntervalMs?: number;
	discoveryLightIntervalMs?: number;
	targetStatePollIntervalMs?: number;
	deviceReportIntervalMs?: number;
	metricsIntervalMs?: number;
	reconciliationIntervalMs?: number;
}

interface ConfigManagerEvents {
	'config-applied': () => void;
	'device-registered': (device: ProtocolAdapterDevice) => void;
	'device-updated': (device: ProtocolAdapterDevice) => void;
	'device-unregistered': (deviceId: string) => void;
	'features-changed': (change: { old: any; new: any }) => void;
	'anomaly-config-changed': (change: { old: any; new: any }) => void;
	'restart-discovery-timers': (intervals: IntervalConfig) => void;
	'schedule-restart': (config: { restartTimeMs: number; restartConfig: any }) => void;
	'endpoints-reload-required': (data: { changeType: { added: any[]; removed: any[]; modified: any[] }; endpoints: any[]; reason: string }) => void;
}

export class ConfigManager extends EventEmitter {
	private targetConfig: DeviceConfig = {};
	private currentConfig: DeviceConfig = {};
	private logger?: AgentLogger;
	
	// Reactive handler dependencies (initialized via setReactiveHandlers())
	private containerManager?: any;
	private cloudSync?: any;
	private discoveryLightTimer?: NodeJS.Timeout;
	private discoveryFullTimer?: NodeJS.Timeout;
	private scheduledRestartTimer?: NodeJS.Timeout;
	private discoveryService?: any;

	constructor(logger?: AgentLogger) {
		super();
		this.logger = logger;
	}

	/**
	 * Set logger (called after logger is initialized)
	 */
	public setLogger(logger: AgentLogger): void {
		this.logger = logger;
	}

	/**
	 * Initialize config manager
	 */
	public async init(): Promise<void> {
		this.logger?.infoSync('Initializing ConfigManager', {
			component: LogComponents.configManager,
			operation: 'init',
		});
		
		// Load current config from database (persisted reconciled state)
		await this.loadCurrentConfigFromDB();
	}

	/**
	 * Setup reactive configuration handlers
	 * Must be called after init() to enable automatic config change responses
	 */
	public setReactiveHandlers(dependencies: {
		containerManager?: any;
		cloudSync?: any;
		discoveryService?: any;
		discoveryLightTimer?: NodeJS.Timeout;
		discoveryFullTimer?: NodeJS.Timeout;
	}): void {
		this.containerManager = dependencies.containerManager;
		this.cloudSync = dependencies.cloudSync;
		this.discoveryService = dependencies.discoveryService;
		this.discoveryLightTimer = dependencies.discoveryLightTimer;
		this.discoveryFullTimer = dependencies.discoveryFullTimer;

		this.logger?.infoSync('Reactive config handlers enabled', {
			component: LogComponents.configManager,
			operation: 'setReactiveHandlers',
		});
	}

	/**
	 * Load target configuration without triggering reconciliation
	 * Used during initialization to populate targetConfig from database
	 */
	public loadTarget(config: DeviceConfig): void {
		this.targetConfig = _.cloneDeep(config);
	}

	/**
	 * Set target configuration
	 */
	public async setTarget(config: DeviceConfig): Promise<void> {
		this.targetConfig = _.cloneDeep(config);
		
		// Trigger reconciliation
		await this.reconcile();
	}

	/**
	 * Get target configuration
	 */
	public getTargetConfig(): DeviceConfig {
		return _.cloneDeep(this.targetConfig);
	}

	/**
	 * Get current configuration
	 * Augments with all endpoints from database (including discovered ones)
	 */
	public async getCurrentConfig(): Promise<DeviceConfig> {
		// Get all sensors from database (includes discovered devices)
		const allEndpoints = await DeviceEndpointModel.getAll();
		
		// Convert to ProtocolAdapterDevice format
		const endpointsConfig: ProtocolAdapterDevice[] = allEndpoints.map(endpoint => ({
			id: endpoint.uuid || endpoint.name,  // Use UUID as id, fallback to name
			name: endpoint.name,
			protocol: endpoint.protocol,
			connectionString: JSON.stringify(endpoint.connection), // Serialize connection object
			pollInterval: endpoint.poll_interval,
			enabled: Boolean(endpoint.enabled), // Convert SQLite integer (0/1) to boolean
			metadata: endpoint.metadata,
			dataPoints: endpoint.data_points // Include data point definitions for cloud reporting
		}));
		
		const result: DeviceConfig = {
			..._.cloneDeep(this.currentConfig),
			endpoints: endpointsConfig
		};
		
		return result;
	}

	/**
	 * Get current config value for a specific key
	 */
	public getConfig(key: string): any {
		return this.currentConfig[key];
	}

	/**
	 * Check if a config key exists
	 */
	public hasConfig(key: string): boolean {
		return key in this.currentConfig;
	}

	// ==================== PROTOCOL CONFIG GETTERS ====================

	/**
	 * Get discovery targets for a specific protocol
	 */
	public getDiscoveryTargets(protocol: string): any[] {
		const endpoints = this.targetConfig.endpoints || [];
		
		const filtered = endpoints.filter((endpoint: any) => {
			if (endpoint.protocol !== protocol) return false;

			// Parse connection from either object or string format
			let connection: any = endpoint.connection;
			if (!connection && endpoint.connectionString) {
				try {
					connection = JSON.parse(endpoint.connectionString);
				} catch {
					connection = null;
				}
			}

			switch (protocol) {
				case 'modbus':
					// Accept endpoints with slaveRange (scan multiple slaves) OR slaveId (single slave)
					return connection?.slaveRange !== undefined || connection?.slaveId !== undefined;
				case 'opcua':
					const hasEndpointUrl = !!connection?.endpointUrl;
					const hasNoDataPoints = !endpoint.dataPoints || endpoint.dataPoints.length === 0;
					return hasEndpointUrl && hasNoDataPoints;
				case 'snmp':
					return connection?.community && 
						(!endpoint.dataPoints || endpoint.dataPoints.length === 0);
				case 'bacnet':
					return Array.isArray(connection?.discoveryTargets) && 
						connection.discoveryTargets.length > 0;
				case 'mqtt':
					// Accept endpoints with topics array (for validation)
					// Discovery validates that topics receive data (not auto-discovery)
					const hasTopics = Array.isArray(connection?.topics) && connection.topics.length > 0;
					const hasNoMqttDataPoints = !endpoint.dataPoints || endpoint.dataPoints.length === 0;
					return hasTopics && hasNoMqttDataPoints;
				default:
					return false;
			}
		});
		
		return filtered;
	}

	/**
	 * Get Modbus protocol configuration
	 */
	public getModbusConfig(): ModbusConfig {
		const cloudProtocol = this.targetConfig.protocols?.modbus;

		let profileDataPoints = cloudProtocol?.profileDataPoints;
		
		if (cloudProtocol?.points && typeof cloudProtocol.points === 'object') {
			profileDataPoints = Object.entries(cloudProtocol.points).map(([name, point]: [string, any]) => ({
				name,
				...point
			}));
		}

		const cloudConnection = cloudProtocol?.connection;
		const cloudAddressing = cloudProtocol?.addressing;
		const cloudConnections = cloudProtocol?.connections;

		let connections: ModbusConnectionConfig[] | undefined;
		if (Array.isArray(cloudConnections) && cloudConnections.length > 0) {
			connections = cloudConnections.map((conn: any) => {
				const connProfile = conn.profile || cloudProtocol?.profile || 'Generic';
				
				let connPoints: any[] | undefined;
				if (conn.points && typeof conn.points === 'object') {
					connPoints = Object.entries(conn.points).map(([name, point]: [string, any]) => ({
						name,
						...point
					}));
				} else if (!conn.points && profileDataPoints) {
					connPoints = profileDataPoints;
				}

				return {
					name: conn.name,
					host: conn.host,
					port: conn.port ?? 502,
					enabled: conn.enabled ?? false,
					timeoutMs: conn.timeoutMs ?? cloudConnection?.timeoutMs ?? 2000,
					profile: connProfile,
					addressing: conn.addressing,
					points: connPoints
				};
			});
		}

		return {
			enabled: cloudProtocol?.enabled ?? true,
			connections,
			tcpHost: cloudConnection?.host ?? cloudProtocol?.tcpHost ?? 'localhost',
			tcpPort: cloudConnection?.port ?? cloudProtocol?.tcpPort ?? 502,
			timeout: cloudConnection?.timeoutMs ?? cloudProtocol?.timeout ?? 2000,
			slaveRangeStart: cloudAddressing?.slaveRange?.start ?? cloudProtocol?.slaveRangeStart ?? 1,
			slaveRangeEnd: cloudAddressing?.slaveRange?.end ?? cloudProtocol?.slaveRangeEnd ?? 10,
			profileDataPoints: profileDataPoints,
			rtuPort: cloudProtocol?.serialPort,
			rtuBaudRate: cloudProtocol?.baudRate ?? 9600,
		};
	}

	/**
	 * Get OPC-UA protocol configuration
	 */
	public getOPCUAConfig(): OPCUAConfig {
		const cloudProtocol = this.targetConfig.protocols?.opcua;

		return {
			enabled: cloudProtocol?.enabled ?? false,
			connections: cloudProtocol?.connections ?? cloudProtocol?.discoveryUrls ?? [],
			discoveryUrls: cloudProtocol?.discoveryUrls
		};
	}

	/**
	 * Get SNMP protocol configuration
	 */
	public getSNMPConfig(): SNMPConfig {
		const cloudProtocol = this.targetConfig.protocols?.snmp;

		return {
			enabled: cloudProtocol?.enabled ?? false,
			connections: cloudProtocol?.connections ?? cloudProtocol?.ipRanges ?? [],
			ipRanges: cloudProtocol?.ipRanges,
			port: cloudProtocol?.port ?? 161,
		};
	}

	/**
	 * Get MQTT protocol configuration
	 */
	public getMqttConfig(): MQTTConfig {
		const cloudProtocol = this.targetConfig.protocols?.mqtt;

		return {
			enabled: cloudProtocol?.enabled ?? false,
			brokerUrl: cloudProtocol?.connection?.brokerUrl ?? process.env.MQTT_BROKER_URL ?? 'mqtt://mosquitto:1883',
			username: cloudProtocol?.connection?.username ?? process.env.MQTT_USERNAME,
			password: cloudProtocol?.connection?.password ?? process.env.MQTT_PASSWORD,
			discoveryRoots: cloudProtocol?.discoveryRoots ?? [],
			monitorDurationMs: cloudProtocol?.monitorDurationMs ?? 30000,
			qos: (cloudProtocol?.qos ?? 0) as 0 | 1 | 2,
		};
	}

	/**
	 * Get BACnet protocol configuration
	 */
	public getBACnetConfig(): BACnetConfig {
		const cloudProtocol = this.targetConfig.protocols?.bacnet;

		const envTargets = process.env.BACNET_DISCOVERY_TARGETS?.split(',').map(t => t.trim()).filter(Boolean);
		const discoveryTargets = cloudProtocol?.discoveryTargets || envTargets;

		return {
			enabled: cloudProtocol?.enabled ?? false,
			port: cloudProtocol?.port ?? 47808,
			...(discoveryTargets && discoveryTargets.length > 0 && { discoveryTargets }),
			...(cloudProtocol?.broadcastAddress && { broadcastAddress: cloudProtocol.broadcastAddress }),
			timeout: cloudProtocol?.timeout ?? 5000,
			maxDevices: cloudProtocol?.maxDevices ?? 100,
		};
	}

	/**
	 * Get performance settings
	 */
	public getPerformanceConfig(): PerformanceConfig {
		const cloudRuntime = this.targetConfig.runtime;
		const cloudSettings = this.targetConfig.settings;
		const cloudMemory = (cloudRuntime as any)?.memory;

		return {
			memoryCheckIntervalMs: cloudMemory?.checkIntervalMs ?? cloudRuntime?.memoryCheckIntervalMs ?? cloudSettings?.memoryCheckIntervalMs ?? 30000,
			memoryThresholdMb: cloudMemory?.thresholdMb ?? cloudRuntime?.memoryThresholdMb ?? cloudSettings?.memoryThresholdMb ?? 15,
		};
	}

	/**
	 * Get logging configuration
	 */
	public getLoggingConfig(): LoggingConfig {
		const cloudLogging = this.targetConfig.logging;
		const cloudSettings = this.targetConfig.settings;

		return {
			maxLogs: cloudLogging?.maxLogs ?? cloudSettings?.maxLogs ?? 1000,
			logMaxAge: cloudLogging?.logMaxAge ?? cloudSettings?.logMaxAge ?? 86400000,
			maxLogFileSize: cloudLogging?.maxLogFileSize ?? cloudSettings?.maxLogFileSize ?? 5242880,
			enableFilePersistence: cloudLogging?.enableFilePersistence ?? false,
			enableCompression: cloudLogging?.enableCompression ?? true,
			logBatchSize: cloudLogging?.logBatchSize ?? 500,
			logFlushIntervalMs: cloudLogging?.logFlushIntervalMs ?? 30000,
			logDir: process.env.LOG_DIR ?? cloudSettings?.logDir ?? `${process.env.DATA_DIR || '/app/data'}/logs`,
			logLevel: (cloudLogging?.level ?? process.env.LOG_LEVEL ?? "info") as 'error' | 'warn' | 'info' | 'debug',
		};
	}

	/**
	 * Get feature toggles
	 */
	public getFeatures(): FeatureToggles {
		const cloud = this.targetConfig.features;

		return {
			enableSensorPublish: cloud?.enableDeviceSensorPublish ?? cloud?.enableSensorPublish ?? false,
			enableAnomalyDetection: cloud?.enableAnomalyDetection ?? false,
		};
	}

	/**
	 * Get interval settings
	 */
	public getIntervalConfig(): IntervalConfig {
		const cloud = this.targetConfig.intervals;
		const cloudDevice = (cloud as any)?.device;
		const cloudDiscovery = (cloud as any)?.discovery;

		return {
			discoveryFullIntervalMs: cloudDiscovery?.fullIntervalMs ?? (cloud as any)?.discoveryFullIntervalMs ?? 86400000,
			discoveryLightIntervalMs: cloudDiscovery?.lightIntervalMs ?? (cloud as any)?.discoveryLightIntervalMs ?? 14400000,
			targetStatePollIntervalMs: cloudDevice?.targetStatePollIntervalMs ?? (cloud as any)?.targetStatePollIntervalMs ?? 60000,
			deviceReportIntervalMs: cloudDevice?.reportIntervalMs ?? (cloud as any)?.deviceReportIntervalMs ?? 60000,
			metricsIntervalMs: cloudDevice?.metricsIntervalMs ?? (cloud as any)?.metricsIntervalMs ?? 300000,
			reconciliationIntervalMs: cloudDevice?.reconciliationIntervalMs ?? (cloud as any)?.reconciliationIntervalMs ?? 30000,
		};
	}

	/**
	 * Get cloud API endpoint
	 */
	public getCloudApiEndpoint(): string {
		const env = process.env.CLOUD_API_ENDPOINT;
		return env ?? 'http://localhost:4002';
	}

	/**
	 * Get device API port
	 */
	public getDeviceApiPort(): number {
		const env = process.env.DEVICE_API_PORT;
		const port = env ? parseInt(env, 10) : 48484;
		return isNaN(port) ? 48484 : port;
	}

	// ==================== NORMALIZATION ====================

	/**
	 * Normalize device property names (camelCase → snake_case)
	 * Handles both API and SQLite conventions
	 * CRITICAL: Cloud API sends 'id' field, we map it to 'uuid' for database
	 */
	public normalizeDevice(device: ProtocolAdapterDevice): any {
		const deviceAny = device as any;
		
		// Cloud API uses 'id', database uses 'uuid' - map between them
		const uuid = device.uuid || deviceAny.id;
		
		if (!uuid) {
			this.logger?.warnSync('Device missing both uuid and id fields', {
				component: LogComponents.configManager,
				operation: 'normalizeDevice',
				deviceName: device.name,
				deviceProtocol: device.protocol,
				reason: 'This should not happen - check cloud API response'
			});
		}
		
		return {
			uuid,
			name: device.name,
			protocol: device.protocol,
			enabled: device.enabled !== undefined ? device.enabled : true,
			poll_interval: deviceAny.pollInterval || deviceAny.poll_interval || 5000,
			connection: deviceAny.connection,
			data_points: deviceAny.dataPoints || deviceAny.data_points || deviceAny.registers,
			metadata: deviceAny.metadata
		};
	}

	/**
	 * Main reconciliation logic
	 */
	public async reconcile(): Promise<ConfigReconciliationResult> {
		this.logger?.infoSync('Starting config reconciliation', {
			component: LogComponents.configManager,
			operation: 'reconcile',
		});

		// DETAILED DEBUG: Log target and current state before reconciliation
		this.logger?.debugSync('=== RECONCILIATION: TARGET STATE ===', {
			component: LogComponents.configManager,
			operation: 'reconcile',
			targetEndpointsCount: this.targetConfig.endpoints?.length || 0,
			targetEndpoints: this.targetConfig.endpoints?.map((e: any) => ({
				uuid: e.uuid,
				name: e.name,
				protocol: e.protocol,
				connection: e.connection,
				dataPointsCount: e.dataPoints?.length || 0
			}))
		});

		this.logger?.debugSync('=== RECONCILIATION: CURRENT STATE ===', {
			component: LogComponents.configManager,
			operation: 'reconcile',
			currentEndpointsCount: this.currentConfig.endpoints?.length || 0,
			currentEndpoints: this.currentConfig.endpoints?.map((e: any) => ({
				uuid: e.uuid,
				name: e.name,
				protocol: e.protocol,
				connection: e.connection,
				dataPointsCount: e.dataPoints?.length || 0
			}))
		});

		const result: ConfigReconciliationResult = {
			success: true,
			devicesRegistered: 0,
			devicesUpdated: 0,
			devicesUnregistered: 0,
			errors: [],
			timestamp: new Date(),
		};

			try {
			// First, copy all non-device fields from target to current config
			// This ensures logging, features, settings, etc. are always up-to-date
			const { endpoints: _targetEndpoints, ...otherTargetFields } = this.targetConfig;
			const { endpoints: currentEndpoints, ...otherCurrentFields } = this.currentConfig;
			
			// Detect feature changes before merging
			const oldFeatures = this.currentConfig.features;
			const newFeatures = otherTargetFields.features;
			
			// Merge non-device fields into current config
			Object.assign(this.currentConfig, otherTargetFields);
			
			// Restore endpoints array (will be reconciled separately)
			if (currentEndpoints) {
				this.currentConfig.endpoints = currentEndpoints;
			}
			
			// Emit feature change event if features changed OR if this is first-time config load
			if (newFeatures && (!oldFeatures || !_.isEqual(oldFeatures, newFeatures))) {
				this.emit('features-changed', { old: oldFeatures || {}, new: newFeatures });
				
				const changes = oldFeatures 
					? Object.keys(newFeatures).filter(key => oldFeatures[key] !== newFeatures[key])
					: Object.keys(newFeatures);
				
				this.logger?.infoSync('Feature configuration changed', {
					component: LogComponents.configManager,
					operation: 'reconcile',
					isFirstLoad: !oldFeatures,
					changes
				});
			}
			
			// Emit anomaly config change event if anomaly config changed
			const oldAnomalyConfig = otherCurrentFields.anomaly;
			const newAnomalyConfig = otherTargetFields.anomaly;
			if (oldAnomalyConfig && newAnomalyConfig && !_.isEqual(oldAnomalyConfig, newAnomalyConfig)) {
				this.emit('anomaly-config-changed', { old: oldAnomalyConfig, new: newAnomalyConfig });
				
				this.logger?.infoSync('Anomaly configuration changed', {
					component: LogComponents.configManager,
					operation: 'reconcile',
				});
			}
			
			// Sync endpoints to SQLite using UUID-based operations
			// This replaces the separate ProtocolAdaptersHandler logic
			await this.syncEndpointsToDatabase();
			
			// Calculate steps for sensor reconciliation
			const steps = this.calculateSteps();

			if (steps.length === 0) {
				this.logger?.infoSync('No device config changes needed', {
					component: LogComponents.configManager,
					operation: 'reconcile',
				});
				
				// Even if no sensor changes, save current config to persist other field updates
				await this.saveCurrentConfigToDB();
				
				return result;
			}

			this.logger?.infoSync('Generated config reconciliation steps', {
				component: LogComponents.configManager,
				operation: 'reconcile',
				stepsCount: steps.length,
			});
			// Execute steps
			for (const step of steps) {
				try {
					await this.executeStep(step);

					// Update result counters
					if (step.action === 'registerDevice') {
						result.devicesRegistered++;
					} else if (step.action === 'updateDevice') {
						result.devicesUpdated++;
					} else if (step.action === 'unregisterDevice') {
						result.devicesUnregistered++;
					}
				} catch (error: any) {
					this.logger?.errorSync(
						'Config step failed',
						error instanceof Error ? error : new Error(String(error)),
						{
							component: LogComponents.configManager,
							operation: 'reconcile',
							action: step.action,
							deviceId: step.device?.id || step.deviceId,
						}
					);
					
					result.success = false;
					result.errors.push({
						deviceId: step.device?.id || step.deviceId || 'unknown',
						error: error.message,
					});
					
					// Continue with remaining steps (K8s style)
				}
			}

		this.logger?.infoSync('Config reconciliation complete', {
			component: LogComponents.configManager,
			operation: 'reconcile',
			devicesRegistered: result.devicesRegistered,
			devicesUpdated: result.devicesUpdated,
			devicesUnregistered: result.devicesUnregistered,
			errors: result.errors.length,
		});

		// Save updated config to local database
		await this.saveCurrentConfigToDB();

		this.emit('config-applied');
	} catch (error) {
			this.logger?.errorSync(
				'Critical error during config reconciliation',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.configManager,
					operation: 'reconcile',
				}
			);
			result.success = false;
			throw error;
		}

		return result;
	}

	/**
	 * Sync endpoints to SQLite database using UUID-based operations
	 * Integrated from ProtocolAdaptersHandler for unified config management
	 */
	private async syncEndpointsToDatabase(): Promise<void> {
		const devices = this.targetConfig.endpoints || [];

		if (!devices || !Array.isArray(devices) || devices.length === 0) {
			this.logger?.warnSync('=== SYNC TO DB: NO ENDPOINTS TO SYNC ===', {
				component: LogComponents.configManager,
				operation: 'syncEndpointsToDatabase',
			});
			return;
		}

		this.logger?.debugSync('=== SYNCING ENDPOINTS TO DATABASE ===', {
			component: LogComponents.configManager,
			totalEndpoints: devices.length,
			endpoints: devices.map((d: any) => ({
				uuid: d.uuid,
				name: d.name,
				protocol: d.protocol,
				connection: d.connection,
				dataPointsCount: d.dataPoints?.length || 0
			}))
		});

		try {
			// Get current devices from SQLite to detect deletions
			const currentDevices = await DeviceEndpointModel.getAll();
			
			this.logger?.debugSync('=== CURRENT ENDPOINTS IN DB (BEFORE SYNC) ===', {
				component: LogComponents.configManager,
				operation: 'syncEndpointsToDatabase',
				currentCount: currentDevices.length,
				currentDevices: currentDevices.map(d => ({
					uuid: d.uuid,
					name: d.name,
					protocol: d.protocol,
					dataPointsCount: d.data_points?.length || 0
				}))
			});
			
		// CRITICAL: Cloud API sends 'id' field, not 'uuid'
		// Use d.id || d.uuid to match what normalizeDevice() does
		const targetDeviceUuids = new Set(
			devices.map((d: any) => d.id || d.uuid).filter(Boolean)
	);
		
		// For each device in target state
		for (const device of devices) {
			const deviceAny = device as any;
		let connection: any = deviceAny.connection;
		if (!connection && deviceAny.connectionString) {
			try {
				connection = JSON.parse(deviceAny.connectionString);
			} catch (err) {
				this.logger?.warnSync('Failed to parse connectionString', {
					component: LogComponents.configManager,
					deviceName: device.name,
					connectionString: deviceAny.connectionString,
					error: err instanceof Error ? err.message : String(err)
				});
				connection = null;
			}
		}
		
		// Check if this is a Modbus discovery target (has slaveRange)
		const hasSlaveRange = connection?.slaveRange !== undefined;
	
	if (device.protocol === 'modbus' && hasSlaveRange) {
		this.logger?.debugSync('Skipping discovery target device (has slaveRange)', {
			component: LogComponents.configManager,
			operation: 'syncEndpointsToDatabase',
			deviceUuid: device.uuid,
			deviceName: device.name,
			connection: connection,
			slaveRange: connection.slaveRange,
			reason: 'Discovery target - only discovered slaves should be in endpoints table'
		});
		continue; // Skip to next device
	}
	
	// Normalize property names from cloud API (camelCase) to SQLite (snake_case)
	const normalizedDevice = this.normalizeDevice(device as ProtocolAdapterDevice);

	// Use UUID for lookup if available, fallback to name for legacy devices
	let existing: any = null;
	try {
		existing = normalizedDevice.uuid 
			? await DeviceEndpointModel.getByUuid(normalizedDevice.uuid)
			: await DeviceEndpointModel.getByName(normalizedDevice.name);
	} catch (lookupError) {
		this.logger?.warnSync('Failed to lookup existing device, treating as new', {
			component: LogComponents.configManager,
			operation: 'syncEndpointsToDatabase',
			deviceUuid: normalizedDevice.uuid,
			deviceName: normalizedDevice.name,
			error: lookupError instanceof Error ? lookupError.message : String(lookupError)
		});
		// Continue as if device doesn't exist - will trigger CREATE path
	}

	if (existing) {
		this.logger?.infoSync('Found existing device in DB', {
			component: LogComponents.configManager,
			operation: 'syncEndpointsToDatabase',
			deviceUuid: existing.uuid,
			deviceName: existing.name,
			existingDataPointsCount: existing.data_points?.length || 0
		});
		
		// CRITICAL: Preserve discovered data_points if target state has empty array
		// This prevents reconciliation from overwriting discovery results
		// Flow: Discovery finds nodes → saves to DB → cloud syncs → reconcile runs
		// Without this check, reconcile would overwrite with cloud's empty array
		const shouldPreserveDataPoints = 
			existing.data_points && 
			existing.data_points.length > 0 && 
			(!normalizedDevice.data_points || normalizedDevice.data_points.length === 0);
		
		if (shouldPreserveDataPoints) {
			this.logger?.debugSync('✅ PRESERVING discovered data_points (UPDATE path)', {
				component: LogComponents.configManager,
				deviceUuid: normalizedDevice.uuid || existing.uuid,
				deviceName: normalizedDevice.name,
				existingDataPointsCount: existing.data_points?.length || 0,
				targetDataPointsCount: normalizedDevice.data_points?.length || 0,
				reason: 'DB has nodes, target state empty - keeping DB nodes'
			});
						normalizedDevice.data_points = existing.data_points;
					} else {
						this.logger?.infoSync('Will use target state data_points (UPDATE path)', {
							component: LogComponents.configManager,
							deviceUuid: normalizedDevice.uuid || existing.uuid,
							deviceName: normalizedDevice.name,
							existingDataPointsCount: existing.data_points?.length || 0,
							targetDataPointsCount: normalizedDevice.data_points?.length || 0,
							reason: shouldPreserveDataPoints ? 'n/a' : 'Target has nodes OR both empty'
						});
					}
					
					await DeviceEndpointModel.updateByUuid(
						normalizedDevice.uuid || existing.uuid!,
						normalizedDevice
					);
					this.logger?.infoSync('Updated endpoint in database', {
						component: LogComponents.configManager,
						deviceUuid: normalizedDevice.uuid || existing.uuid,
						deviceName: normalizedDevice.name,
						protocol: normalizedDevice.protocol,
						dataPointsCount: normalizedDevice.data_points?.length || 0
					});
				} else {
					this.logger?.infoSync('Device NOT found in DB (will CREATE)', {
						component: LogComponents.configManager,
						operation: 'syncEndpointsToDatabase',
						deviceUuid: normalizedDevice.uuid,
						deviceName: normalizedDevice.name,
						targetDataPointsCount: normalizedDevice.data_points?.length || 0
					});
					
					// CRITICAL: Check for discovered data_points in discovery cache
					// When a new device is created during reconciliation, the cloud doesn't have
					// the discovered nodes yet, so dataPoints will be empty. But discovery may have
					// just run and cached the results. Check cache before creating with empty array.
					const endpointUrl = normalizedDevice.connection?.endpointUrl;
					if (endpointUrl && this.discoveryService) {
						this.logger?.debugSync('Checking discovery cache for new device', {
							component: LogComponents.configManager,
							operation: 'syncEndpointsToDatabase',
							endpointUrl,
							hasDiscoveryService: !!this.discoveryService,
							hasGetMethod: !!this.discoveryService.getDiscoveredDevice
						});
						
						const discoveredDevice = this.discoveryService.getDiscoveredDevice?.(endpointUrl);
						if (discoveredDevice && discoveredDevice.dataPoints && discoveredDevice.dataPoints.length > 0) {
							this.logger?.debugSync('✅ USING cached discovered data_points (CREATE path)', {
								component: LogComponents.configManager,
								deviceUuid: normalizedDevice.uuid,
								deviceName: normalizedDevice.name,
								endpointUrl,
								cachedDataPointsCount: discoveredDevice.dataPoints.length,
								reason: 'Found in discovery cache - using cached nodes'
							});
							
							// Use discovered data_points instead of empty array from target state
							normalizedDevice.data_points = discoveredDevice.dataPoints;
						} else {
							this.logger?.debugSync('⚠️ Discovery cache MISS for new device', {
								component: LogComponents.configManager,
								deviceUuid: normalizedDevice.uuid,
								deviceName: normalizedDevice.name,
								endpointUrl,
								cacheHit: !!discoveredDevice,
								hasDataPoints: discoveredDevice?.dataPoints?.length || 0,
								reason: 'Will create with empty data_points - discovery may not have run yet'
							});
						}
					} else {
						const protocol = String(normalizedDevice.protocol || '').toLowerCase();
						const logFn = endpointUrl ? this.logger?.warnSync.bind(this.logger) : this.logger?.debugSync.bind(this.logger);

						logFn?.('⚠️ Cannot check discovery cache', {
							component: LogComponents.configManager,
							deviceUuid: normalizedDevice.uuid,
							deviceName: normalizedDevice.name,
							protocol,
							hasEndpointUrl: !!endpointUrl,
							hasDiscoveryService: !!this.discoveryService,
							reason: endpointUrl ? 'No discoveryService' : 'No endpointUrl (expected for some protocols like mqtt)'
						});
					}
					
					// Log full structure before INSERT to debug data_points issue
				this.logger?.debugSync('=== ABOUT TO INSERT INTO DB ===', {
						operation: 'syncEndpointsToDatabase - CREATE',
						deviceUuid: normalizedDevice.uuid,
						deviceName: normalizedDevice.name,
						protocol: normalizedDevice.protocol,
						dataPointsCount: normalizedDevice.data_points?.length || 0,
						firstDataPoint: normalizedDevice.data_points?.[0] || null,
						allDataPoints: normalizedDevice.data_points || []
					});
					
					await DeviceEndpointModel.create(normalizedDevice);
					
					// CRITICAL: Verify what was actually saved to DB
					// Use uuid if available, fallback to name for devices without uuid
					let verifyInsert: any = null;
					try {
						if (normalizedDevice.uuid) {
							verifyInsert = await DeviceEndpointModel.getByUuid(normalizedDevice.uuid);
						} else {
							verifyInsert = await DeviceEndpointModel.getByName(normalizedDevice.name);
						}
					} catch (verifyError) {
						this.logger?.warnSync('Failed to verify inserted endpoint', {
							component: LogComponents.configManager,
							deviceName: normalizedDevice.name,
							deviceUuid: normalizedDevice.uuid,
							error: verifyError instanceof Error ? verifyError.message : String(verifyError)
						});
					}
					
					this.logger?.infoSync('Added endpoint to database', {
						component: LogComponents.configManager,
						deviceUuid: normalizedDevice.uuid,
						deviceName: normalizedDevice.name,
						protocol: normalizedDevice.protocol,
						dataPointsCount: normalizedDevice.data_points?.length || 0,
						dbDataPointsCount: verifyInsert?.data_points?.length || 0,
						dbFirstDataPoint: verifyInsert?.data_points?.[0] || null,
						verificationMethod: normalizedDevice.uuid ? 'by-uuid' : 'by-name'
					});
				}
			}

			// Delete devices that are no longer in target state (by UUID)
			for (const currentDevice of currentDevices) {
				if (currentDevice.uuid && !targetDeviceUuids.has(currentDevice.uuid)) {
					await DeviceEndpointModel.deleteByUuid(currentDevice.uuid);
					this.logger?.infoSync('Removed endpoint from database', {
						component: LogComponents.configManager,
						deviceUuid: currentDevice.uuid,
						deviceName: currentDevice.name,
						protocol: currentDevice.protocol
					});
				}
			}

		} catch (error) {
			this.logger?.errorSync(
				'Failed to sync endpoints to database',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.configManager,
					operation: 'syncEndpointsToDatabase'
				}
			);
		}
	}

	/**
	 * Calculate what config changes are needed
	 */
	private calculateSteps(): ConfigStep[] {
		const steps: ConfigStep[] =[];
		
		const allTargetDevices = this.targetConfig.endpoints || [];
		const currentDevices = this.currentConfig.endpoints || [];
		
		// CRITICAL: Filter out discovery targets (devices with slaveRange)
		// Discovery targets should never be in reconciliation steps - they're config-only
		const targetDevices = allTargetDevices.filter((device: any) => {
			// Parse connection (same logic as syncEndpointsToDatabase and getDiscoveryTargets)
			let connection: any = device.connection;
			if (!connection && device.connectionString) {
				try {
					connection = JSON.parse(device.connectionString);
				} catch {
					connection = null;
				}
			}
			
			// Skip Modbus discovery targets (have slaveRange)
			if (device.protocol === 'modbus' && connection?.slaveRange) {
				this.logger?.infoSync('Filtered out discovery target from reconciliation steps', {
					component: LogComponents.configManager,
					operation: 'calculateSteps',
					deviceName: device.name,
					slaveRange: connection.slaveRange,
					reason: 'Discovery targets are config-only, not reconciled'
				});
				return false; // Exclude from targetDevices
			}
			
			return true; // Include in targetDevices
		});
		
		this.logger?.debugSync('Calculating reconciliation steps', {
			component: LogComponents.configManager,
			operation: 'calculateSteps',
			allTargetCount: allTargetDevices.length,
			filteredTargetCount: targetDevices.length,
			currentCount: currentDevices.length,
			filteredOut: allTargetDevices.length - targetDevices.length
		});
		
		// Build maps for easier comparison
		const targetMap = new Map(targetDevices.map(d => [d.id, d]));
		const currentMap = new Map(currentDevices.map(d => [d.id, d]));

		// Devices to add (in target but not in current)
		for (const device of targetDevices) {
			if (!currentMap.has(device.id)) {
				this.logger?.debugSync('Device needs to be registered', {
					component: LogComponents.configManager,
					operation: 'calculateSteps',
					deviceId: device.id,
					deviceName: device.name,
				});
				
				steps.push({
					action: 'registerDevice',
					device: device,
				});
			}
		}

		// Devices to remove (in current but not in target)
		for (const device of currentDevices) {
			if (!targetMap.has(device.id)) {
				this.logger?.debugSync('Device needs to be unregistered', {
					component: LogComponents.configManager,
					operation: 'calculateSteps',
					deviceId: device.id,
					deviceName: device.name,
				});
				
				steps.push({
					action: 'unregisterDevice',
					deviceId: device.id,
				});
			}
		}

		// Devices to update (config changed)
		for (const targetDevice of targetDevices) {
			const currentDevice = currentMap.get(targetDevice.id);
			if (currentDevice && !_.isEqual(targetDevice, currentDevice)) {
				this.logger?.debugSync('Device needs to be updated', {
					component: LogComponents.configManager,
					operation: 'calculateSteps',
					deviceId: targetDevice.id,
					deviceName: targetDevice.name,
				});
				
				steps.push({
					action: 'updateDevice',
					device: targetDevice,
				});
			}
		}

		return steps;
	}

	/**
	 * Execute a single config step
	 */
	private async executeStep(step: ConfigStep): Promise<void> {
		switch (step.action) {
			case 'registerDevice':
				if (step.device) {
					await this.registerEndpoint(step.device);
				}
				break;

			case 'updateDevice':
				if (step.device) {
					await this.updateEndpoint(step.device);
				}
				break;

			case 'unregisterDevice':
				if (step.deviceId) {
					await this.unregisterEndpoint(step.deviceId);
				}
				break;
		}
	}

	/**
	 * Register a protocol adapter device
	 */
	private async registerEndpoint(device: ProtocolAdapterDevice): Promise<void> {
		this.logger?.infoSync('Registering protocol adapter device', {
			component: LogComponents.configManager,
			operation: 'registerDevice',
			deviceId: device.id,
			deviceName: device.name,
			protocol: device.protocol,
		});

		// Save device to SQLite sensors table
		try {
			const { DeviceEndpointModel: DeviceSensorModel } = await import('../db/models/endpoint.model.js');
			
			// Handle both connectionString and connection formats
			let connection: Record<string, any> = {};
			if (device.connectionString) {
				// Legacy format: parse connection string
				try {
					const url = new URL(device.connectionString);
					connection = {
						host: url.hostname,
						port: parseInt(url.port) || 502,
					};
				} catch {
					connection = { connectionString: device.connectionString };
				}
			} else if ((device as any).connection) {
				// New format: connection object already provided
				connection = (device as any).connection;
			}
			
			// Extract protocol-specific metadata (preserve existing metadata from device)
			let metadata: Record<string, any> = (device as any).metadata || {};
			
			// Add protocol-specific metadata if needed
			if (device.protocol === 'modbus' && connection.unitId !== undefined) {
				// For Modbus: store unitId as slaveId in metadata
				metadata.slaveId = connection.unitId;
			}
			
			// Normalize property names (camelCase → snake_case)
			const normalizedEndpoint: Partial<DeviceEndpoint> = {
				name: device.name,
				protocol: device.protocol as any, // Accept any protocol string
				enabled: device.enabled !== undefined ? device.enabled : true,
				poll_interval: device.pollInterval || 5000,
				connection: connection,
				data_points: (device as any).dataPoints || (device as any).registers || [],
				metadata: metadata
			};
			
			// Use upsert to handle devices that may already exist (e.g., discovered devices)
			await DeviceSensorModel.upsert(normalizedEndpoint as DeviceEndpoint);
			
			this.logger?.infoSync('Device saved to sensors table', {
				component: LogComponents.configManager,
				operation: 'registerDevice',
				deviceName: device.name,
			});
		} catch (error) {
			this.logger?.errorSync('Failed to save device to sensors table', 
				error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.configManager,
				operation: 'registerDevice',
				deviceName: device.name,
			});
			throw error;
		}

		// Update current config to reflect the change
		if (!this.currentConfig.endpoints) {
			this.currentConfig.endpoints = [];
		}

		this.currentConfig.endpoints.push(_.cloneDeep(device));

		// Persist current config to database
		await this.saveCurrentConfigToDB();

		this.emit('device-registered', device);
		
		this.logger?.infoSync('Device registered successfully', {
			component: LogComponents.configManager,
			operation: 'registerDevice',
			deviceName: device.name,
		});
	}

	/**
	 * Update a protocol adapter device
	 */
	private async updateEndpoint(device: ProtocolAdapterDevice): Promise<void> {
		this.logger?.infoSync('Updating protocol adapter device', {
			component: LogComponents.configManager,
			operation: 'updateDevice',
			deviceId: device.id,
			deviceName: device.name,
		});

		// Update device in SQLite sensors table (or create if doesn't exist)
		try {
			const { DeviceEndpointModel: DeviceSensorModel } = await import('../db/models/endpoint.model.js');
			
			// Handle both connectionString and connection formats
			let connection: Record<string, any> = {};
			if (device.connectionString) {
				// Legacy format: parse connection string
				try {
					const url = new URL(device.connectionString);
					connection = {
						host: url.hostname,
						port: parseInt(url.port) || 502,
					};
				} catch {
					connection = { connectionString: device.connectionString };
				}
			} else if ((device as any).connection) {
				// New format: connection object already provided
				connection = (device as any).connection;
			}
			
			// Preserve existing metadata from device (includes connectionName, profile, etc.)
			let metadata: Record<string, any> = (device as any).metadata || {};
			
			// Add protocol-specific metadata if needed (preserve existing values)
			if (device.protocol === 'modbus' && connection.unitId !== undefined) {
				// For Modbus: store unitId as slaveId in metadata (only if not already set)
				if (!metadata.slaveId) {
					metadata.slaveId = connection.unitId;
				}
			}
			
		// Get existing device first to check for data_points preservation
		const existing = await DeviceSensorModel.getByName(device.name);
		
		// Prepare data_points with preservation logic
		let dataPoints = (device as any).dataPoints || (device as any).registers || [];
		
		// CRITICAL: Preserve discovered data_points if target state has empty array
		// Same logic as syncEndpointsToDatabase() - don't overwrite discovery results
		if (existing && existing.data_points && existing.data_points.length > 0 && 
				(!dataPoints || dataPoints.length === 0)) {
			this.logger?.debugSync('Preserving existing data_points in updateEndpoint', {
				component: LogComponents.configManager,
				deviceName: device.name,
				existingCount: existing.data_points.length
			});
			dataPoints = existing.data_points;
		}
		
		// Normalize property names (camelCase → snake_case)
		// Normalize property names (camelCase → snake_case)
const normalizedDevice = {
    protocol: device.protocol as 'modbus' | 'can' | 'opcua',
    enabled: device.enabled !== undefined ? device.enabled : true,
    poll_interval: device.pollInterval || 5000,
    connection: connection,
    data_points: dataPoints,
    metadata: metadata
};

if (existing) {
    // Device exists - update it
    await DeviceSensorModel.update(device.name, normalizedDevice);
    
    this.logger?.infoSync('Device updated in sensors table', {
        component: LogComponents.configManager,
        operation: 'updateDevice',
        deviceName: device.name,
    });
} else {
				// Device doesn't exist - create it (upsert behavior)
				await DeviceSensorModel.create({
					name: device.name,
					...normalizedDevice
				});
				
				this.logger?.infoSync('Device created in sensors table (was missing)', {
					component: LogComponents.configManager,
					operation: 'updateDevice',
					deviceName: device.name,
				});
			}
		} catch (error) {
			this.logger?.errorSync('Failed to update device in sensors table', 
				error instanceof Error ? error : new Error(String(error)), {
				component: LogComponents.configManager,
				operation: 'updateDevice',
				deviceName: device.name,
			});
			throw error;
		}

		// Update current config
		if (!this.currentConfig.endpoints) {
			this.currentConfig.endpoints = [];
		}

		const endpointIndex = this.currentConfig.endpoints.findIndex(
			(d) => d.id === device.id
		);

		if (endpointIndex !== -1) {
			this.currentConfig.endpoints[endpointIndex] = _.cloneDeep(device);
		}

		// Persist current config to database
		await this.saveCurrentConfigToDB();

		this.emit('device-updated', device);
		
		this.logger?.infoSync('Device updated successfully', {
			component: LogComponents.configManager,
			operation: 'updateDevice',
			deviceId: device.id,
		});
	}

	/**
	 * Unregister a protocol adapter device
	 */
	private async unregisterEndpoint(deviceId: string): Promise<void> {
		this.logger?.infoSync('Unregistering protocol adapter device', {
			component: LogComponents.configManager,
			operation: 'unregisterDevice',
			deviceId,
		});

		// Find device name from current config
		const device = this.currentConfig.endpoints?.find(d => d.id === deviceId);
		
		// Remove device from SQLite sensors table
		if (device) {
			try {
				const { DeviceEndpointModel: DeviceSensorModel } = await import('../db/models/endpoint.model.js');
				await DeviceSensorModel.delete(device.name);
				
				this.logger?.infoSync('Device removed from sensors table', {
					component: LogComponents.configManager,
					operation: 'unregisterDevice',
					deviceName: device.name,
				});
			} catch (error) {
				this.logger?.errorSync('Failed to remove device from sensors table', 
					error instanceof Error ? error : new Error(String(error)), {
					component: LogComponents.configManager,
					operation: 'unregisterDevice',
					deviceName: device.name,
				});
				throw error;
			}
		}

		// Update current config
		if (this.currentConfig.endpoints) {
			this.currentConfig.endpoints = 
				this.currentConfig.endpoints.filter(d => d.id !== deviceId);
		}

		// Persist current config to database
		await this.saveCurrentConfigToDB();

		this.emit('device-unregistered', deviceId);
		
		this.logger?.infoSync('Device unregistered successfully', {
			component: LogComponents.configManager,
			operation: 'unregisterDevice',
			deviceId,
		});
	}

	/**
	 * Load current config from database
	 * This restores the last reconciled state so we don't re-register devices on restart
	 */
	private async loadCurrentConfigFromDB(): Promise<void> {
		try {
			const snapshots = await db('stateSnapshot')
				.where({ type: 'config' })
				.orderBy('createdAt', 'desc')
				.limit(1);

			if (snapshots.length > 0) {
				this.currentConfig = JSON.parse(snapshots[0].state);

				// DETAILED DEBUG: Log what was loaded from database
				this.logger?.infoSync('=== LOADED CONFIG FROM DATABASE ===', {
					component: LogComponents.configManager,
					operation: 'loadCurrentConfig',
					deviceCount: this.currentConfig.endpoints?.length || 0,
					endpoints: this.currentConfig.endpoints?.map((e: any) => ({
						uuid: e.uuid,
						name: e.name,
						protocol: e.protocol,
						connection: e.connection,
						dataPointsCount: e.dataPoints?.length || 0
					})),
					createdAt: snapshots[0].createdAt
				});
			} else {
				this.logger?.debugSync('No current config in database, starting fresh', {
					component: LogComponents.configManager,
					operation: 'loadCurrentConfig',
				});
			}
		} catch (error) {
			this.logger?.errorSync(
				'Failed to load current config from DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.configManager,
					operation: 'loadCurrentConfig',
				}
			);
		}
	}

	/**
	 * Save current config to database
	 * This persists the reconciled state so we can restore it on restart
	 */
	private async saveCurrentConfigToDB(): Promise<void> {
		try {
			const configJson = JSON.stringify(this.currentConfig);
			
			// Delete old config snapshots and insert new
			await db('stateSnapshot')
				.where({ type: 'config' })
				.delete();

			await db('stateSnapshot').insert({
				type: 'config',
				state: configJson,
			});

			this.logger?.infoSync('Current config saved to database', {
				component: LogComponents.configManager,
				operation: 'saveCurrentConfig',
			});
		} catch (error) {
			this.logger?.errorSync(
				'Failed to save current config to DB',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.configManager,
					operation: 'saveCurrentConfig',
				}
			);
		}
	}

	// ==================== REACTIVE HANDLERS ====================

	/**
	 * Classify endpoint changes (added, removed, modified)
	 */
	private classifyEndpointChanges(oldEndpoints: any[], newEndpoints: any[]): {
		added: any[];
		removed: any[];
		modified: any[];
	} {
		const oldMap = new Map(oldEndpoints.map(e => [e.uuid || e.id, e]));
		const newMap = new Map(newEndpoints.map(e => [e.uuid || e.id, e]));

		const added = newEndpoints.filter(e => !oldMap.has(e.uuid || e.id));
		const removed = oldEndpoints.filter(e => !newMap.has(e.uuid || e.id));
		const modified = newEndpoints.filter(e => {
			const oldEndpoint = oldMap.get(e.uuid || e.id);
			return oldEndpoint && !_.isEqual(oldEndpoint, e);
		});

		return { added, removed, modified };
	}

	/**
	 * Handle logging configuration changes
	 */
	public handleLoggingConfigChanges(change: { old: any; new: any }): void {
		if (!this.logger) {
			return;
		}

		// Use change.new directly (targetConfig not updated yet when this event fires)
		const newLogLevel = (change.new?.level ?? process.env.LOG_LEVEL ?? "info") as LogLevel;
		
		// Update log level dynamically
		this.logger.setLogLevel(newLogLevel);
		
		this.logger.infoSync('Logging configuration updated from cloud - DYNAMIC UPDATE APPLIED', {
			component: LogComponents.configManager,
			oldLogLevel: change.old?.level,
			newLogLevel: newLogLevel,
			enableFilePersistence: change.new?.enableFilePersistence,
			enableCompression: change.new?.enableCompression,
			logBatchSize: change.new?.logBatchSize,
			logFlushIntervalMs: change.new?.logFlushIntervalMs,
		});
	}

	/**
	 * Handle intervals configuration changes
	 */
	public handleIntervalsChanges(change: { old: any; new: any }): void {
		const intervals = this.getIntervalConfig();

		this.logger?.infoSync('Intervals configuration changed - APPLYING DYNAMIC UPDATES', {
			component: LogComponents.configManager,
			old: change.old,
			new: change.new,
			parsed: intervals,
		});

		if (this.discoveryService && (this.discoveryLightTimer || this.discoveryFullTimer)) {
			this.logger?.infoSync('Discovery intervals changed, restarting timers - DYNAMIC UPDATE', {
				component: LogComponents.configManager,
				lightIntervalHours: intervals.discoveryLightIntervalMs! / (60 * 60 * 1000),
				fullIntervalHours: intervals.discoveryFullIntervalMs! / (60 * 60 * 1000),
			});

			this.emit('restart-discovery-timers', intervals);
		}

		if (this.containerManager) {
			this.containerManager.stopAutoReconciliation();
			this.containerManager.startAutoReconciliation(intervals.reconciliationIntervalMs!);

			this.logger?.infoSync('Reconciliation interval updated from cloud - DYNAMIC UPDATE APPLIED', {
				component: LogComponents.configManager,
				oldIntervalMs: change.old?.device?.reconciliationIntervalMs || change.old?.reconciliationIntervalMs,
				newIntervalMs: intervals.reconciliationIntervalMs,
				intervalMinutes: intervals.reconciliationIntervalMs! / 60000,
			});
		}

		if (this.cloudSync) {
			this.cloudSync.updateIntervals({
				pollInterval: intervals.targetStatePollIntervalMs!,
				reportInterval: intervals.deviceReportIntervalMs!,
				metricsInterval: intervals.metricsIntervalMs!,
			});

			this.logger?.infoSync('CloudSync intervals updated from cloud', {
				component: LogComponents.configManager,
				pollIntervalMs: intervals.targetStatePollIntervalMs,
				reportIntervalMs: intervals.deviceReportIntervalMs,
				metricsIntervalMs: intervals.metricsIntervalMs,
			});
		}
	}

	/**
	 * Handle memory configuration changes
	 */
	public handleMemoryConfigChanges(change: { old: any; new: any }): void {
		const performanceConfig = this.getPerformanceConfig();
		const newInterval = performanceConfig.memoryCheckIntervalMs!;
		const newThreshold = performanceConfig.memoryThresholdMb! * 1024 * 1024;

		import('../system/memory.js').then(({ stopMemoryMonitoring, setMemoryLogger, startMemoryMonitoring }) => {
			stopMemoryMonitoring();
			
			setMemoryLogger(this.logger);
			startMemoryMonitoring(
				newInterval,
				newThreshold,
				() => {
					this.logger?.errorSync(
						'Memory threshold breached - agent may need restart',
						undefined,
						{
							component: LogComponents.configManager,
							thresholdMB: newThreshold / (1024 * 1024),
							action: 'Consider restarting agent or investigating memory leak'
						}
					);
				}
			);

			this.logger?.infoSync('Memory monitoring updated from cloud', {
				component: LogComponents.configManager,
				intervalMs: newInterval,
				thresholdMB: newThreshold / (1024 * 1024),
			});
		});
	}

	/**
	 * Handle scheduled restart configuration changes
	 */
	public handleScheduledRestartConfig(change: { old: any; new: any }): void {
		const restartConfig = change.new;

		if (this.scheduledRestartTimer) {
			clearTimeout(this.scheduledRestartTimer);
			this.scheduledRestartTimer = undefined;
			this.logger?.infoSync("Cleared existing scheduled restart timer", {
				component: LogComponents.configManager,
			});
		}

		if (!restartConfig || !restartConfig.enabled) {
			this.logger?.debugSync("Scheduled restart disabled or not configured", {
				component: LogComponents.configManager,
				config: restartConfig || "not set"
			});
			return;
		}

		const intervalDays = parseInt(restartConfig.intervalDays, 10);
		if (isNaN(intervalDays) || intervalDays < 1 || intervalDays > 90) {
			this.logger?.warnSync("Invalid scheduled restart intervalDays, must be 1-90", {
				component: LogComponents.configManager,
				providedValue: restartConfig.intervalDays,
				using: "disabled"
			});
			return;
		}

		const restartTimeMs = intervalDays * 24 * 60 * 60 * 1000;
		const restartAt = new Date(Date.now() + restartTimeMs);

		this.logger?.infoSync("Scheduled restart configured from cloud", {
			component: LogComponents.configManager,
			enabled: true,
			intervalDays,
			restartAtISO: restartAt.toISOString(),
			restartAtLocal: restartAt.toLocaleString(),
			reason: restartConfig.reason || "heap_fragmentation_cleanup",
			configSource: "cloud_target_state"
		});

		this.emit('schedule-restart', { restartTimeMs, restartConfig });
	}

	/**
	 * Handle endpoints configuration changes
	 * This is called when the cloud updates the endpoints config
	 */
	public async handleEndpointsChanges(change: { old: any; new: any }): Promise<void> {
		const newEndpoints = change.new || [];
		const oldEndpoints = change.old || [];

		// CRITICAL: Update targetConfig.endpoints immediately so getDiscoveryTargets() sees new endpoints
		// This prevents race condition where discovery runs before setTarget() is called
		this.targetConfig.endpoints = newEndpoints;

		// Classify changes (added, removed, modified)
		const changeType = this.classifyEndpointChanges(oldEndpoints, newEndpoints);

		this.logger?.infoSync('Endpoints configuration changed from cloud', {
			component: LogComponents.configManager,
			oldCount: oldEndpoints.length,
			newCount: newEndpoints.length,
			added: changeType.added.length,
			removed: changeType.removed.length,
			modified: changeType.modified.length,
		});

		// Determine which protocols were affected by changes (added or modified endpoints)
		const changedEndpoints = [...changeType.added, ...changeType.modified];
	
	// CRITICAL: Also include OPC UA endpoints with null/empty data_points for auto-discovery
	// This handles the case where device is synced from cloud without nodes
	const opcuaWithoutNodes = newEndpoints.filter((e: any) => 
		e.protocol === 'opcua' && 
		e.connection?.endpointUrl &&
		(!e.data_points || e.data_points.length === 0)
	);
	
	// Combine changed endpoints with OPC UA endpoints needing discovery
	const allEndpointsNeedingDiscovery = [...changedEndpoints, ...opcuaWithoutNodes];
	const affectedProtocols = [...new Set(allEndpointsNeedingDiscovery.map((e: any) => e.protocol))];

	if (affectedProtocols.length === 0) {
		this.logger?.debugSync('No protocols affected by endpoint changes, skipping discovery', {
			component: LogComponents.configManager,
		});
		return;
	}
	
	if (opcuaWithoutNodes.length > 0) {
		this.logger?.infoSync('Triggered auto-discovery for OPC UA devices without nodes', {
			component: LogComponents.configManager,
			deviceCount: opcuaWithoutNodes.length,
			devices: opcuaWithoutNodes.map((e: any) => e.name)
		});
	}

		// Filter endpoints that support discovery (only for affected protocols)
		// Discovery validates connectivity for:
		// - Modbus: slaveRange (scan multiple slaves) or slaveId (single slave)
		// - OPC-UA: discovery URLs
		// - SNMP: IP ranges or specific hosts
		// - MQTT: topic discovery
		// - BACnet: device discovery
		const discoverableEndpoints = allEndpointsNeedingDiscovery.filter((e: any) => {
				if (e.protocol === 'modbus' && (e.connection?.slaveId !== undefined || e.connection?.slaveRange)) return true;
				if (e.protocol === 'opcua' && e.connection?.endpointUrl) return true; // OPC UA discovery via endpoint
				if (e.protocol === 'snmp' && e.connection?.host) return true;
				if (e.protocol === 'mqtt' && e.connection?.discoveryRoots) return true;
				if (e.protocol === 'bacnet') return true; // BACnet uses broadcast discovery
				return false;
			});
	
		if (discoverableEndpoints.length > 0 && this.discoveryService) {
			const shouldAllowDiscoveryWrites = discoverableEndpoints.some(
				(e: any) => e.protocol === 'modbus' && e.connection?.slaveRange
			);

			// Get unique list of protocols that need discovery (from discoverable endpoints only)
			const discoveryProtocols = [...new Set(discoverableEndpoints.map((e: any) => e.protocol))];

			// Emit pre-discovery event to stop features and free IPC connection slots
			// This prevents "max clients reached" errors when discovery tries to validate connectivity
			this.discoveryService.emit('pre-discovery', {
				protocols: discoveryProtocols,
				trigger: 'config-change',
			});

			// Run discovery with skipDbWrites flag to avoid overwriting reconcile's changes
			// Discovery will emit discovery-complete event for batch reload
			this.discoveryService.runDiscovery({
				trigger: 'config-change',
				validate: true, // Full validation to ensure endpoints are reachable
				forceRun: true, // Bypass rate limiting (config-driven change)
				protocols: discoveryProtocols, // Only scan changed protocols
				skipDbWrites: !shouldAllowDiscoveryWrites, // Allow discovery to persist new slaves for modbus slaveRange targets
				traceId: `config-change-${Date.now()}` // Set traceId to enable batch mode
			}).catch((err: Error) => {
				this.logger?.errorSync('Discovery validation failed after endpoint change', err, {
					component: LogComponents.configManager,
					protocols: discoveryProtocols,
				});
			});
		}

		// Log removed endpoints (cleanup handled by reconcile())
		if (changeType.removed.length > 0) {
			this.logger?.infoSync('Endpoints removed, will be cleaned up during reconciliation', {
				component: LogComponents.configManager,
				removedCount: changeType.removed.length,
				removedNames: changeType.removed.map(e => e.name),
			});
		}

	}

	// ==================== TYPED EVENT EMITTER ====================

	// Typed event emitter methods
	public on<K extends keyof ConfigManagerEvents>(
		event: K,
		listener: ConfigManagerEvents[K],
	): this {
		return super.on(event, listener as any);
	}

	public emit<K extends keyof ConfigManagerEvents>(
		event: K,
		...args: Parameters<ConfigManagerEvents[K]>
	): boolean {
		return super.emit(event, ...args);
	}
}

