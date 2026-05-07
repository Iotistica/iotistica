/**
 * Base Protocol Adapter
 * 
 * Generic adapter that handles common protocol patterns:
 * - Device lifecycle (connect, disconnect, reconnect)
 * - Polling with configurable intervals
 * - Error handling with exponential backoff
 * - Device status tracking
 * - Event emission (protocol-agnostic)
 * 
 * Protocol-specific implementations (Modbus, CAN, OPC-UA) extend this base
 * and implement abstract methods for protocol-specific behavior.
 */

import { EventEmitter } from 'events';
import { DeviceDataPoint, DeviceStatus, Logger } from './types.js';
import { Endpoint } from '../db/models/endpoint.model.js';
import { DeviceModel } from '../db/models/device.model.js';

/**
 * Generic device configuration (from database)
 */
export interface GenericDeviceConfig {
	name: string;
	/** Optional human-readable label. When set (via config metadata or auto-discovered from the
	 * protocol server) this overrides the raw config `name` as the display name in payloads. */
	displayName?: string;
	protocol: string;
	enabled: boolean;
	pollInterval: number;
	connection: Record<string, any>;
	dataPoints: any[];
	metadata?: Record<string, any>;
}

/**
 * Connection state for protocol devices
 */
export interface ProtocolConnection {
	connected: boolean;
	lastAttempt?: Date;
	errorCount: number;
	backoffDelay: number;
}

/**
 * Abstract base class for protocol adapters
 * 
 * Events emitted:
 * - 'started': Adapter started successfully
 * - 'stopped': Adapter stopped
 * - 'data': SensorDataPoint[] - Sensor data collected
 * - 'device-connected': string - Device name
 * - 'device-disconnected': string - Device name
 * - 'device-error': (string, Error) - Device name + error
 */
export abstract class BaseProtocolAdapter extends EventEmitter {
	protected logger: Logger;
	protected devices: Map<string, GenericDeviceConfig> = new Map();
	protected connections: Map<string, ProtocolConnection> = new Map();
	protected pollTimers: Map<string, NodeJS.Timeout> = new Map();
	protected deviceStatuses: Map<string, DeviceStatus> = new Map();
	protected running = false;
	
	// Performance tracking
	protected pollHistory: Map<string, boolean[]> = new Map(); // Track last N poll results (true=success, false=fail)
	protected readonly pollHistorySize = 100; // Track last 100 polls for success rate
	
	// Configuration
	protected readonly maxBackoffDelay = 60000; // 60 seconds max
	protected readonly initialBackoffDelay = 1000; // 1 second
	protected readonly backoffMultiplier = 2;

	constructor(
		devices: GenericDeviceConfig[],
		logger: Logger
	) {
		super();
		this.logger = logger;
		
		// Initialize devices map
		for (const device of devices) {
			this.devices.set(device.name, device);
		}
		
		this.initializeDeviceStatuses();
	}

	/**
	 * Start the adapter - connects all enabled devices
	 */
	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		try {
			this.logger.debug(`Starting ${this.getProtocolName()} adapter...`);

			// Initialize all enabled devices
			for (const [_name, device] of this.devices) {
				if (device.enabled) {
					await this.initializeDevice(device);
				}
			}

			this.running = true;
			this.logger.debug(`${this.getProtocolName()} adapter started successfully`);
			this.emit('started');

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start ${this.getProtocolName()} adapter: ${errorMessage}`);
			await this.stop();
			throw error;
		}
	}

	/**
	 * Stop the adapter - disconnects all devices
	 */
	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		try {
			this.logger.debug(`Stopping ${this.getProtocolName()} adapter...`);

			// Stop all polling timers
			for (const [deviceName, timer] of this.pollTimers) {
				clearTimeout(timer);
				this.pollTimers.delete(deviceName);
			}

			// Disconnect all devices
			const disconnectPromises = Array.from(this.devices.keys()).map(deviceName =>
				this.disconnectDevice(deviceName).catch(error =>
					this.logger.warn(`Error disconnecting device ${deviceName}: ${error}`)
				)
			);
			await Promise.all(disconnectPromises);

			this.connections.clear();
			this.running = false;
			this.logger.debug(`${this.getProtocolName()} adapter stopped successfully`);
			this.emit('stopped');

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Error stopping ${this.getProtocolName()} adapter: ${errorMessage}`);
		}
	}

	/**
	 * Get device statuses
	 */
	getDeviceStatuses(): DeviceStatus[] {
		return Array.from(this.deviceStatuses.values());
	}

	/**
	 * Check if adapter is running
	 */
	isRunning(): boolean {
		return this.running;
	}

	// ============================================================================
	// ABSTRACT METHODS - Implement in protocol-specific adapters
	// ============================================================================

	/**
	 * Get protocol name (e.g., "Modbus", "CAN", "OPC-UA")
	 */
	protected abstract getProtocolName(): string;

	/**
	 * Connect to a device using protocol-specific logic
	 * @param device Device configuration
	 * @returns Protocol-specific connection handle
	 */
	protected abstract connectDevice(device: GenericDeviceConfig): Promise<any>;

	/**
	 * Disconnect from a device
	 * @param deviceName Device name
	 */
	protected abstract disconnectDevice(deviceName: string): Promise<void>;

	/**
	 * Read data from a device using protocol-specific logic
	 * @param deviceName Device name
	 * @param device Device configuration
	 * @returns Array of sensor data points
	 */
	protected abstract readDeviceData(
		deviceName: string,
		device: GenericDeviceConfig
	): Promise<DeviceDataPoint[]>;

	/**
	 * Validate device configuration (protocol-specific)
	 * @param device Device configuration
	 * @throws Error if configuration is invalid
	 */
	protected abstract validateDeviceConfig(device: GenericDeviceConfig): void;

	// ============================================================================
	// COMMON IMPLEMENTATION - Shared across all protocols
	// ============================================================================

	/**
	 * Initialize a device (connect and start polling)
	 */
	protected async initializeDevice(device: GenericDeviceConfig): Promise<void> {
		try {
		// Validate configuration
			this.validateDeviceConfig(device);

			// Initialize connection state
			this.connections.set(device.name, {
				connected: false,
				errorCount: 0,
				backoffDelay: this.initialBackoffDelay
			});

			// Connect to device
			await this.connectDevice(device);

			const connection = this.connections.get(device.name)!;
			connection.connected = true;
			connection.errorCount = 0;
			connection.backoffDelay = this.initialBackoffDelay;

			// Update status
			const status = this.deviceStatuses.get(device.name)!;
			status.connected = true;

			this.logger.debug(`Device initialized: ${device.name}`);
			this.emit('device-connected', device.name);

			// Start polling
			this.startPolling(device);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to initialize device ${device.name}: ${errorMessage}`);
			
			// Schedule retry with backoff
			this.scheduleDeviceRetry(device);
		}
	}

	/**
	 * Start polling a device
	 */
	protected startPolling(device: GenericDeviceConfig): void {
		const pollDevice = async () => {
			try {
			// Check if device is connected
				const connection = this.connections.get(device.name);
				if (!connection || !connection.connected) {
				// Send BAD quality data points
					const badDataPoints = this.createBadQualityDataPoints(
						device,
						'DEVICE_OFFLINE'
					);
					this.emit('data', badDataPoints);
					return;
				}

				// Read device data (protocol-specific)
				const dataPoints = await this.readDeviceData(device.name, device);

				// Update device status
				const status = this.deviceStatuses.get(device.name)!;
				status.lastPoll = new Date();

				// Emit data event
				if (dataPoints.length > 0) {
					this.emit('data', dataPoints);
					this.emit('data-received', device.name, dataPoints);
				}

				// Reset backoff on success
				const conn = this.connections.get(device.name)!;
				conn.errorCount = 0;
				conn.backoffDelay = this.initialBackoffDelay;

			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.error(`Error polling device ${device.name}: ${errorMessage}`);

				// Update device status
				const status = this.deviceStatuses.get(device.name)!;
				status.errorCount++;
				status.lastError = errorMessage;

				this.emit('device-error', device.name, error);

				// Send BAD quality data points
				const qualityCode = this.extractQualityCode(errorMessage);
				const badDataPoints = this.createBadQualityDataPoints(device, qualityCode);
				this.emit('data', badDataPoints);

				// Try to reconnect
				this.scheduleDeviceRetry(device);
				return;
			}

			// Schedule next poll
			const timer = setTimeout(pollDevice, device.pollInterval);
			this.pollTimers.set(device.name, timer);
		};

		// Start polling immediately
		pollDevice();
	}

	/**
	 * Schedule device retry with exponential backoff
	 */
	protected scheduleDeviceRetry(device: GenericDeviceConfig): void {
		const connection = this.connections.get(device.name);
		if (!connection) return;

		// Mark as disconnected
		connection.connected = false;
		const status = this.deviceStatuses.get(device.name)!;
		status.connected = false;
		this.emit('device-disconnected', device.name);

		// Calculate backoff delay
		const delay = Math.min(connection.backoffDelay, this.maxBackoffDelay);
		connection.backoffDelay *= this.backoffMultiplier;
		connection.errorCount++;

		this.logger.info(
			`Retrying device ${device.name} in ${delay}ms (attempt ${connection.errorCount})`
		);

		// Schedule reconnection
		setTimeout(() => {
			this.initializeDevice(device);
		}, delay);
	}

	/**
	 * Create BAD quality data points for offline/error devices
	 */
	protected createBadQualityDataPoints(
		device: GenericDeviceConfig,
		qualityCode: string
	): DeviceDataPoint[] {
		const timestamp = new Date().toISOString();
		
		return device.dataPoints.map((dataPoint: any) => ({
			deviceName: device.name,
			metric: dataPoint.name || dataPoint.signal || dataPoint.tag || 'unknown',
			value: null,
			unit: dataPoint.unit || '',
			timestamp,
			quality: 'BAD' as const,
			qualityCode
		}));
	}

	/**
	 * Extract quality code from error message
	 */
	protected extractQualityCode(errorMessage: string): string {
		if (errorMessage.includes('timeout')) return 'TIMEOUT';
		if (errorMessage.includes('connection')) return 'CONNECTION_ERROR';
		if (errorMessage.includes('not open')) return 'DEVICE_OFFLINE';
		if (errorMessage.includes('permission')) return 'PERMISSION_DENIED';
		return 'UNKNOWN_ERROR';
	}

	/**
	 * Initialize device statuses
	 */
	protected initializeDeviceStatuses(): void {
		for (const [name, _device] of this.devices) {
			this.deviceStatuses.set(name, {
				deviceName: name,
				connected: false,
				lastPoll: null,
				lastSeen: null,
				errorCount: 0,
				lastError: null,
				responseTimeMs: null,
				pollSuccessRate: 1.0, // Start optimistic
				registersUpdated: 0,
				communicationQuality: 'offline'
			});
			
			// Initialize poll history
			this.pollHistory.set(name, []);
		}
	}

	/**
	 * Record poll result and update metrics
	 */
	protected recordPollResult(
		deviceName: string, 
		success: boolean, 
		responseTimeMs?: number,
		registersUpdated?: number
	): void {
		const status = this.deviceStatuses.get(deviceName);
		if (!status) return;

		const now = new Date();
		status.lastPoll = now;

		// Update success/failure tracking
		const history = this.pollHistory.get(deviceName) || [];
		history.push(success);
		
		// Keep only last N results
		if (history.length > this.pollHistorySize) {
			history.shift();
		}
		this.pollHistory.set(deviceName, history);

		// Calculate success rate
		const successCount = history.filter(r => r).length;
		status.pollSuccessRate = history.length > 0 ? successCount / history.length : 1.0;

		if (success) {
			status.lastSeen = now;
			status.responseTimeMs = responseTimeMs ?? null;
			status.registersUpdated = registersUpdated ?? 0;
			status.errorCount = 0; // Reset on success
			status.lastError = null;
			DeviceModel.updateLastSeenByEndpointName(deviceName).catch(err => {
				this.logger.warn(`Failed to update device lastSeenAt for ${deviceName}: ${err.message}`);
			});
		} else {
			status.errorCount++;
		}

		// Update communication quality based on success rate and connection state
		status.communicationQuality = this.calculateCommunicationQuality(status);
	}

	/**
	 * Calculate communication quality based on metrics
	 */
	protected calculateCommunicationQuality(status: DeviceStatus): 'good' | 'degraded' | 'poor' | 'offline' {
		if (!status.connected) {
			return 'offline';
		}

		const successRate = status.pollSuccessRate;
		
		if (successRate >= 0.95) {
			return 'good';
		} else if (successRate >= 0.75) {
			return 'degraded';
		} else {
			return 'poor';
		}
	}

	/**
	 * Load devices from database for a protocol
	 */
	static async loadDevicesFromDatabase(protocol: string): Promise<GenericDeviceConfig[]> {
		const { EndpointModel: EndpointModel } = await import('../db/models/endpoint.model.js');
		const dbDevices = await EndpointModel.getEnabled(protocol);

		return dbDevices.map((db: Endpoint) => ({
			name: db.name,
			protocol: db.protocol,
			enabled: db.enabled,
			pollInterval: db.poll_interval,
			connection: typeof db.connection === 'string' 
				? JSON.parse(db.connection) 
				: db.connection,
			dataPoints: db.data_points 
				? (typeof db.data_points === 'string' 
					? JSON.parse(db.data_points) 
					: db.data_points)
				: [],
			metadata: db.metadata 
				? (typeof db.metadata === 'string' 
					? JSON.parse(db.metadata) 
					: db.metadata)
				: undefined
		}));
	}
}
