import { type AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { Protocol } from '../anomaly/types.js';
import type { AnomalyDetectionService } from '../anomaly/index.js';
import type { PipelineService } from '../features/pipeline/index.js';
import {
	type DevicePublishConfig,
	type DeviceConfig,
	type MqttConnection,
	type Logger,
} from './core/types.js';
import { PublishManager } from './core/manager.js';
import { MessageBufferSync } from './core/buffer.js';
import type { IPublishClient as BufferSyncPublishClient } from './core/buffer.js';
import { CloudMqttClient } from '../mqtt/manager.js';
import type { DictionaryManager } from '../mqtt/dictionary.js';
import { EventEmitter } from 'events';
import { AzurePublishPlugin } from './plugins/azure.js';
import { AwsPublishPlugin } from './plugins/aws.js';
import { GcpPublishPlugin } from './plugins/gcp.js';
import { MqttPublishPlugin } from './plugins/mqtt.js';
import { InfluxDbPublishPlugin } from './plugins/influxdb.js';
import { BasePublishPlugin } from './core/base-plugin.js';
import type { IPublishPlugin, IPublishClient } from './core/types.js';

/**
 * DevicePublish - Manages multiple devices and publishes data to MQTT

 */
export class DevicePublish extends EventEmitter {
	private devices: PublishManager[] = [];
	private config: DevicePublishConfig & { enabled: boolean };
	private agentLogger: AgentLogger;
	private logger: {
		info: (message: string, context?: Record<string, any>) => void;
		warn: (message: string, context?: Record<string, any>) => void;
		error: (message: string, error?: unknown, context?: Record<string, any>) => void;
		debug: (message: string, context?: Record<string, any>) => void;
	};
	private mqttConnection?: MqttConnection;
	private readonly deviceUuid: string;
	private isRunning = false;
	private dictionaryManager?: DictionaryManager; // Dictionary manager for MQTT message key compaction
	private readonly useMsgpackPoc: boolean;
	private readonly useKeyCompactionPoc: boolean;
	private readonly useDeflatePoc: boolean;
	private anomalyService?: AnomalyDetectionService;
	private liveDataInterceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[];

	constructor(
		config: DevicePublishConfig & { enabled: boolean },
		agentLogger: AgentLogger,
		deviceUuid: string,
		dictionaryManager?: DictionaryManager, // Optional dictionary manager
		useMsgpackPoc: boolean = false, // Enable MessagePack compression POC
		useKeyCompactionPoc: boolean = false, // Enable dictionary key compaction POC
		useDeflatePoc: boolean = false, // Enable DEFLATE compression POC
		anomalyService?: AnomalyDetectionService,
	) {
		super();
		this.config = config;
		this.agentLogger = agentLogger;
		this.deviceUuid = deviceUuid;
		this.mqttConnection = CloudMqttClient.getInstance();
		this.logger = {
			info: (message: string, context?: Record<string, any>) =>
				this.agentLogger.infoSync(message, {
					component: LogComponents.devicePublish,
					...(context || {}),
				}),
			warn: (message: string, context?: Record<string, any>) =>
				this.agentLogger.warnSync(message, {
					component: LogComponents.devicePublish,
					...(context || {}),
				}),
			error: (message: string, error?: unknown, context?: Record<string, any>) =>
				this.agentLogger.errorSync(
					message,
					error instanceof Error ? error : undefined,
					{
						component: LogComponents.devicePublish,
						...(context || {}),
					}
				),
			debug: (message: string, context?: Record<string, any>) =>
				this.agentLogger.debugSync(message, {
					component: LogComponents.devicePublish,
					...(context || {}),
				}),
		};
		this.dictionaryManager = dictionaryManager;
		this.useMsgpackPoc = useMsgpackPoc;
		this.useKeyCompactionPoc = useKeyCompactionPoc;
		this.useDeflatePoc = useDeflatePoc;
		this.anomalyService = anomalyService;
	}

	public setAnomalyService(anomalyService?: AnomalyDetectionService): void {
		this.anomalyService = anomalyService;
		for (const device of this.devices) {
			device.setAnomalyService(anomalyService);
		}

		this.logger.debug('Updated anomaly service binding for Device Publish Feature', {
			hasAnomalyService: !!anomalyService,
			deviceCount: this.devices.length,
		});
	}

	public setLiveDataInterceptor(interceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[]): void {
		this.liveDataInterceptor = interceptor;
		for (const device of this.devices) {
			device.setLiveDataInterceptor(interceptor);
		}

		this.logger.debug('Updated live data interceptor for Device Publish Feature', {
			hasInterceptor: !!interceptor,
			deviceCount: this.devices.length,
		});
	}

	/**
   * Get feature name
   */
	public getName(): string {
		return 'DevicePublish';
	}

	private validateConfig(): void {
		const deviceConfig = this.config as DevicePublishConfig;
    
		if (!deviceConfig.endpoints || !Array.isArray(deviceConfig.endpoints)) {
			throw new Error('Device Publish configuration must include endpoints array');
		}

		// Validate each Device configuration
		deviceConfig.endpoints.forEach((config: DeviceConfig) => {
			this.validateDeviceConfig(config);
		});
	}

	private async onInitialize(): Promise<void> {
		const deviceConfig = this.config as DevicePublishConfig;
    
		if (deviceConfig.endpoints.length === 0) {
			this.logger.warn('No devices configured');
			return;
		}

		this.logger.debug(`Starting Device Publish feature with ${deviceConfig.endpoints.length} devices`);
	}

	private async onStart(): Promise<void> {
		if (!this.config.enabled) {
			this.logger.info('Device Publish disabled by config');
			return;
		}

		if (!this.mqttConnection) {
			throw new Error('MQTT connection required for Device Publish feature');
		}

		const deviceConfig = this.config as DevicePublishConfig;

		if (deviceConfig.endpoints.length === 0) {
			return;
		}

		// Create and start all devices
		for (let i = 0; i < deviceConfig.endpoints.length; i++) {
			const config = deviceConfig.endpoints[i];

			const device = this.createDeviceManager(config, i, deviceConfig.endpoints.length);
			if (this.liveDataInterceptor) device.setLiveDataInterceptor(this.liveDataInterceptor);
			this.attachDeviceEventHandlers(device, config.name!);
			this.devices.push(device);
			await this.startDeviceManager(device, config);
		}
	}

	private async onStop(): Promise<void> {
		// Stop all devices
		await Promise.all(this.devices.map(device => device.stop()));
    
		this.devices = [];
	}

	public async start(): Promise<void> {
		if (this.isRunning) {
			return;
		}

		if (!this.config.enabled) {
			this.logger.info('Device Publish disabled by config');
			return;
		}

		this.validateConfig();
		await this.onInitialize();
		await this.onStart();
		this.isRunning = true;
	}

	public async stop(): Promise<void> {
		if (!this.isRunning) {
			return;
		}

		await this.onStop();
		this.isRunning = false;
	}

	/**
	 * Get statistics for all devices (includes health status)
	 */
	public getStats(): Record<string, any> {
		const stats: Record<string, any> = {};
		const publishConfig = this.config as DevicePublishConfig;

		for (let i = 0; i < this.devices.length; i++) {
			const device = this.devices[i];
			const config = publishConfig.endpoints[i];
			const name = config?.name || `device-${i + 1}`;
			stats[name] = device.getRuntimeSnapshot(60000);
		}

		return stats;
	}

	/**
   * Inject one simulated message into a specific endpoint topic pipeline.
   * Returns true when a matching endpoint exists and message was routed.
   */
	public publishSimulationMessage(endpointTopic: string, message: Record<string, any>): boolean {
		const publishConfig = this.config as DevicePublishConfig;

		for (let i = 0; i < this.devices.length; i++) {
			const endpoint = publishConfig.endpoints[i];
			if (!endpoint) {
				continue;
			}

			if (endpoint.mqttTopic === endpointTopic) {
				this.devices[i].injectSimulationMessage(message);
				return true;
			}
		}

		return false;
	}

	private createDeviceManager(config: DeviceConfig, index: number, total: number): PublishManager {
		config.name = config.name || `device-${index + 1}`;
		this.logger.debug(`Creating device '${config.name}' (${index + 1}/${total})`);
		const protocolName = config.protocol || config.name.split('-')[0];
		if (!this.isValidProtocol(protocolName)) {
			throw new Error(`Unknown protocol '${protocolName}' for endpoint '${config.name}'`);
		}
		const protocol = protocolName as Protocol;

		const protocolLogger = {
			debug: (message: string, ...args: any[]) => {
				this.agentLogger.debugSync(message, {
					component: LogComponents.devicePublish,
					protocol,
					...args[0]
				});
			},
			info: (message: string, ...args: any[]) => {
				this.agentLogger.infoSync(message, {
					component: LogComponents.devicePublish,
					protocol,
					...args[0]
				});
			},
			warn: (message: string, ...args: any[]) => {
				this.agentLogger.warnSync(message, {
					component: LogComponents.devicePublish,
					protocol,
					...args[0]
				});
			},
			error: (message: string, ...args: any[]) => {
				this.agentLogger.errorSync(message, args[0] instanceof Error ? args[0] : undefined, {
					component: LogComponents.devicePublish,
					protocol,
					...(args[0] instanceof Error ? args[1] : args[0])
				});
			}
		};

		return new PublishManager(
			config,
			this.mqttConnection!,
			protocol,
			config.name,
			this.mqttConnection!,
			(publisher, client, logger, endpointName) => this.createPublishPlugin(publisher, client, logger, endpointName),
			protocolLogger,
			this.deviceUuid,
			this.dictionaryManager,
			this.useMsgpackPoc,
			this.useKeyCompactionPoc,
			this.useDeflatePoc,
			this.anomalyService,
		);
	}

	private createPublishPlugin(
		publisher: { type: string; config_json?: Record<string, unknown> | null; id?: number },
		client: IPublishClient,
		logger?: Logger,
		endpointName?: string,
	): IPublishPlugin {
		const target = publisher.type.trim().toLowerCase();
		const config = publisher.config_json ?? null;
		switch (target) {
			case 'iotistica': return new BasePublishPlugin(client, logger);
			case 'azure': return AzurePublishPlugin.fromEnv(this.agentLogger, logger);
			case 'aws': return AwsPublishPlugin.fromEnv(this.agentLogger, logger);
			case 'gcp': return GcpPublishPlugin.fromEnv(this.agentLogger, logger);
			case 'mqtt': return MqttPublishPlugin.fromConfig(config, this.agentLogger, logger, this.deviceUuid, endpointName, publisher.id);
			case 'influxdb': return InfluxDbPublishPlugin.fromConfig(config, logger);
			default: throw new Error(`Publish destination type not found: ${target}`);
		}
	}

	private isValidProtocol(value: string): boolean {
		const validProtocols = ['modbus', 'opcua', 'bacnet', 'mqtt', 'system'];
		return validProtocols.includes(value.toLowerCase());
	}

	private attachDeviceEventHandlers(device: PublishManager, deviceName: string): void {
		device.on('connected', () => {
			this.logger.debug(`Device '${deviceName}' connected`);
		});

		device.on('disconnected', () => {
			this.logger.debug(`Device '${deviceName}' disconnected`);
		});

		device.on('error', (error: Error) => {
			const isNotReady = (error as NodeJS.ErrnoException).code === 'ENOENT';
			if (!isNotReady) {
				this.logger.error(`Device '${deviceName}' error: ${error.message}`, error);
			}
		});
	}

	private async startDeviceManager(device: PublishManager, config: DeviceConfig): Promise<void> {
		try {
			this.logger.debug(`Starting Device '${config.name}'...`);
			await device.start();
			this.logger.debug(`Device '${config.name}' started successfully`);
		} catch (error) {
			this.logger.error(`Failed to create/start Device '${config.name}' at ${config.addr}`, error);
			throw error;
		}
	}

	/**
   * Get Device by name
   */
	public getDevice(name: string): PublishManager | undefined {
		const deviceConfig = this.config as DevicePublishConfig;
		const index = deviceConfig.endpoints.findIndex((s: DeviceConfig) => s.name === name);
		return index >= 0 ? this.devices[index] : undefined;
	}

	/**
   * Get all devices with their configuration
   */
	public getDevices(): Array<{ name: string; enabled: boolean; addr: string; publishInterval: number }> {
		const deviceConfig = this.config as DevicePublishConfig;
		return deviceConfig.endpoints.map((config: DeviceConfig, index: number) => {
			return {
				name: config.name || `device-${index + 1}`,
				enabled: config.enabled !== false,
				addr: config.addr,
				publishInterval: config.publishInterval || 30000
			};
		});
	}

	/**
   * Enable a Device by name
   */
	public async enableDevice(deviceName: string): Promise<void> {
		const publishConfig = this.config as DevicePublishConfig;
		const index = publishConfig.endpoints.findIndex((s: DeviceConfig) => s.name === deviceName);
		if (index < 0) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		const deviceConfig = publishConfig.endpoints[index];
		const device = this.devices[index];

		if (deviceConfig.enabled === false) {
			deviceConfig.enabled = true;
      
			if (device && this.isRunning) {
				await device.start();
			}
      
			this.logger.debug(`Device '${deviceName}' enabled`);
		}
	}

	/**
   * Disable a Device by name
   */
	public async disableDevice(deviceName: string): Promise<void> {
		const publishConfig = this.config as DevicePublishConfig;
		const index = publishConfig.endpoints.findIndex((s: DeviceConfig) => s.name === deviceName);
		if (index < 0) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		const deviceConfig = publishConfig.endpoints[index];
		const device = this.devices[index];

		if (deviceConfig.enabled !== false) {
			deviceConfig.enabled = false;
      
			if (device && this.isRunning) {
				await device.stop();
			}
      
			this.logger.debug(`Device '${deviceName}' disabled`);
		}
	}

	/**
   * Update publish interval for a device
   */
	public async updateInterval(deviceName: string, intervalMs: number): Promise<void> {
		const publishConfig = this.config as DevicePublishConfig;
		const index = publishConfig.endpoints.findIndex((s: DeviceConfig) => s.name === deviceName);
		if (index < 0) {
			throw new Error(`Device not found: ${deviceName}`);
		}

		const deviceConfig = publishConfig.endpoints[index];
		const device = this.devices[index];

		if (intervalMs < 1000) {
			throw new Error(`Invalid interval for ${deviceName}: minimum 1000ms`);
		}

		deviceConfig.publishInterval = intervalMs;
    
		// Update the device's interval if it's running
		if (device && this.isRunning && deviceConfig.enabled !== false) {
			device.updateInterval(intervalMs);
		}
    
		this.logger.debug(`Updated interval for '${deviceName}': ${intervalMs}ms`);
	}

	/**
	 * Reload publish bindings across all active device managers.
	 * Called after destinations or subscriptions are created/updated/deleted via admin UI.
	 */
	public async reloadAllBindings(): Promise<void> {
		await Promise.all(this.devices.map((device) => device.reloadBindings()));
		this.logger.info('Reloaded publish bindings for all endpoints', { deviceCount: this.devices.length });
	}

	/**
   * Check if MQTT is connected
   */
	public isMqttConnected(): boolean {
		return this.mqttConnection?.isConnected() ?? false;
	}



	/**
   * Validate individual Device configuration
   */
	protected validateDeviceConfig(config: DeviceConfig): void {
		// Check required fields
		if (!config.addr) {
			throw new Error(`Device '${config.name}': 'addr' is required`);
		}

		if (!config.eomDelimiter) {
			throw new Error(`Device '${config.name}': 'eomDelimiter' is required`);
		}

		if (!config.mqttTopic) {
			throw new Error(`Device '${config.name}': 'mqttTopic' is required`);
		}

		// Validate buffer capacity
		if (config.bufferCapacity && config.bufferCapacity < 1024) {
			throw new Error(`Device '${config.name}': 'bufferCapacity' must be at least 1024 bytes`);
		}

		// Validate regex
		try {
			new RegExp(config.eomDelimiter);
		} catch (_error) {
			throw new Error(`Device '${config.name}': Invalid 'eomDelimiter' regex: ${config.eomDelimiter}`);
		}

		this.logger.debug(`Validated configuration for Device '${config.name}'`);
	}
}
