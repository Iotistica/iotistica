/** Base protocol adapter for common device lifecycle, polling, and status behavior. */

import { EventEmitter } from 'events';
import { type DeviceDataPoint, type IDeviceStatus, type Logger, type IProtocolAdapter } from './types.js';
import { type Endpoint } from '../db/models/endpoint.model.js';
import { DeviceModel } from '../db/models/device.model.js';
import type { AgentLogger } from "../logging/agent-logger";
import { type IDiscovery, type DiscoveredDevice, type PluginInfo} from './types.js';


export interface GenericDeviceConfig {
	name: string;
	displayName?: string;
	protocol: string;
	enabled: boolean;
	pollInterval: number;
	connection: Record<string, any>;
	dataPoints: any[];
	metadata?: Record<string, any>;
}

export interface ProtocolConnection {
	connected: boolean;
	lastAttempt?: Date;
	errorCount: number;
	backoffDelay: number;
}

export abstract class BaseProtocolAdapter extends EventEmitter implements IProtocolAdapter {
	protected logger: Logger;
	protected devices: Map<string, GenericDeviceConfig> = new Map();
	protected connections: Map<string, ProtocolConnection> = new Map();
	protected pollTimers: Map<string, NodeJS.Timeout> = new Map();
	protected deviceStatuses: Map<string, IDeviceStatus> = new Map();
	protected running = false;
	
	protected pollHistory: Map<string, boolean[]> = new Map();
	protected readonly pollHistorySize = 100;
	
	protected readonly maxBackoffDelay = 60000;
	protected readonly initialBackoffDelay = 1000;
	protected readonly backoffMultiplier = 2;

	constructor(
		devices: GenericDeviceConfig[] = [],
		logger?: Logger
	) {
		super();
		this.logger = logger!;
		
		for (const device of devices) {
			this.devices.set(device.name, device);
		}
		
		if (devices.length > 0) {
			this.initializeDeviceStatuses();
		}
	}

	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		try {
			this.logger.debug(`Starting ${this.getProtocolName()} adapter...`);

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

	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		try {
			this.logger.debug(`Stopping ${this.getProtocolName()} adapter...`);

			for (const [deviceName, timer] of this.pollTimers) {
				clearTimeout(timer);
				this.pollTimers.delete(deviceName);
			}

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

	getDeviceStatuses(): IDeviceStatus[] {
		return Array.from(this.deviceStatuses.values());
	}

	isRunning(): boolean {
		return this.running;
	}


	protected getProtocolName(): string { return this.constructor.name; }

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	protected async connectDevice(_device: GenericDeviceConfig): Promise<any> { return null; }

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	protected async disconnectDevice(_deviceName: string): Promise<void> { }

	protected async readDeviceData(
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_deviceName: string,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		_device: GenericDeviceConfig
	): Promise<DeviceDataPoint[]> { return []; }

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	protected validateDeviceConfig(_device: GenericDeviceConfig): void { }

	protected async initializeDevice(device: GenericDeviceConfig): Promise<void> {
		try {
			this.validateDeviceConfig(device);

			this.connections.set(device.name, {
				connected: false,
				errorCount: 0,
				backoffDelay: this.initialBackoffDelay
			});

			await this.connectDevice(device);

			const connection = this.connections.get(device.name)!;
			connection.connected = true;
			connection.errorCount = 0;
			connection.backoffDelay = this.initialBackoffDelay;

			const status = this.deviceStatuses.get(device.name)!;
			status.connected = true;

			this.logger.debug(`Device initialized: ${device.name}`);
			this.emit('device-connected', device.name);

			this.startPolling(device);

		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to initialize device ${device.name}: ${errorMessage}`);
			
			this.scheduleDeviceRetry(device);
		}
	}
	protected startPolling(device: GenericDeviceConfig): void {
		const pollDevice = async () => {
			try {
				const connection = this.connections.get(device.name);
				if (!connection?.connected) {
					const badDataPoints = this.createBadQualityDataPoints(
						device,
						'DEVICE_OFFLINE'
					);
					this.emit('data', badDataPoints);
					return;
				}

				const dataPoints = await this.readDeviceData(device.name, device);
				const status = this.deviceStatuses.get(device.name)!;
				status.lastPoll = new Date();

				if (dataPoints.length > 0) {
					this.emit('data', dataPoints);
					this.emit('data-received', device.name, dataPoints);
				}

				const conn = this.connections.get(device.name)!;
				conn.errorCount = 0;
				conn.backoffDelay = this.initialBackoffDelay;
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				this.logger.error(`Error polling device ${device.name}: ${errorMessage}`);

				const status = this.deviceStatuses.get(device.name)!;
				status.errorCount++;
				status.lastError = errorMessage;

				this.emit('device-error', device.name, error);

				const qualityCode = this.extractQualityCode(errorMessage);
				const badDataPoints = this.createBadQualityDataPoints(device, qualityCode);
				this.emit('data', badDataPoints);

				this.scheduleDeviceRetry(device);
				return;
			}

			const timer = setTimeout(pollDevice, device.pollInterval);
			this.pollTimers.set(device.name, timer);
		};

		pollDevice();
	}

	protected scheduleDeviceRetry(device: GenericDeviceConfig): void {
		const connection = this.connections.get(device.name);
		if (!connection) return;

		connection.connected = false;
		const status = this.deviceStatuses.get(device.name)!;
		status.connected = false;
		this.emit('device-disconnected', device.name);

		const delay = Math.min(connection.backoffDelay, this.maxBackoffDelay);
		connection.backoffDelay *= this.backoffMultiplier;
		connection.errorCount++;

		this.logger.info(
			`Retrying device ${device.name} in ${delay}ms (attempt ${connection.errorCount})`
		);

		setTimeout(() => {
			this.initializeDevice(device);
		}, delay);
	}

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

	protected extractQualityCode(errorMessage: string): string {
		if (errorMessage.includes('timeout')) return 'TIMEOUT';
		if (errorMessage.includes('connection')) return 'CONNECTION_ERROR';
		if (errorMessage.includes('not open')) return 'DEVICE_OFFLINE';
		if (errorMessage.includes('permission')) return 'PERMISSION_DENIED';
		return 'UNKNOWN_ERROR';
	}

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
				pollSuccessRate: 1.0,
				registersUpdated: 0,
				communicationQuality: 'offline'
			});
			
			this.pollHistory.set(name, []);
		}
	}

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

		const history = this.pollHistory.get(deviceName) || [];
		history.push(success);
		
		if (history.length > this.pollHistorySize) {
			history.shift();
		}
		this.pollHistory.set(deviceName, history);

		const successCount = history.filter(r => r).length;
		status.pollSuccessRate = history.length > 0 ? successCount / history.length : 1.0;

		if (success) {
			status.lastSeen = now;
			status.responseTimeMs = responseTimeMs ?? null;
			status.registersUpdated = registersUpdated ?? 0;
			status.errorCount = 0;
			status.lastError = null;
			DeviceModel.updateLastSeenByEndpointName(deviceName).catch(err => {
				this.logger.warn(`Failed to update device lastSeenAt for ${deviceName}: ${err.message}`);
			});
		} else {
			status.errorCount++;
		}

		status.communicationQuality = this.calculateCommunicationQuality(status);
	}

	protected calculateCommunicationQuality(status: IDeviceStatus): 'good' | 'degraded' | 'poor' | 'offline' {
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

export abstract class BaseDiscovery implements IDiscovery {
	protected logger?: AgentLogger;
	readonly protocol: string;

	constructor(protocol: string, logger?: AgentLogger) {
		this.protocol = protocol;
		this.logger = logger;
	}

	abstract discover(options?: any): Promise<DiscoveredDevice[]>;
	abstract validate(device: DiscoveredDevice, timeout?: number): Promise<any>;
	abstract isAvailable(): Promise<boolean>;
	abstract generateFingerprint(...args: any[]): string;

	getInfo(): PluginInfo {
		return {
			protocol: this.protocol,
			version: "1.0.0",
			description: `Discovery plugin for ${this.protocol}`,
		};
	}
}
