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
import { LogComponents } from '../logging/types.js';
import type {
	DeviceConfig,
	ConfigStep,
	ConfigReconciliationResult,
	ProtocolAdapterDevice,
} from '../drivers/types.js';

interface ConfigManagerEvents {
	'config-applied': () => void;
	'device-registered': (device: ProtocolAdapterDevice) => void;
	'device-updated': (device: ProtocolAdapterDevice) => void;
	'device-unregistered': (deviceId: string) => void;
}

export class ConfigManager extends EventEmitter {
	private targetConfig: DeviceConfig = {};
	private currentConfig: DeviceConfig = {};
	private logger?: AgentLogger;

	constructor(logger?: AgentLogger) {
		super();
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
	 * Set target configuration
	 */
	public async setTarget(config: DeviceConfig): Promise<void> {
		const devices = config.endpoints || [];
		
		this.logger?.infoSync('Setting target config', {
			component: LogComponents.configManager,
			operation: 'setTarget',
			deviceCount: devices.length,
			endpointNames: devices.map(s => s.name),
			hasDevices: devices.length > 0,
		});

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
		const allSensors = await DeviceEndpointModel.getAll();
		
		// Convert to ProtocolAdapterDevice format
		const endpointsConfig: ProtocolAdapterDevice[] = allSensors.map(sensor => ({
			id: sensor.uuid || sensor.name,  // Use UUID as id, fallback to name
			name: sensor.name,
			protocol: sensor.protocol,
			connectionString: JSON.stringify(sensor.connection), // Serialize connection object
			pollInterval: sensor.poll_interval,
			enabled: sensor.enabled,
			metadata: sensor.metadata
		}));
		
		const result: DeviceConfig = {
			..._.cloneDeep(this.currentConfig),
			endpoints: endpointsConfig
		};
		
		return result;
	}

	/**
	 * Main reconciliation logic
	 */
	public async reconcile(): Promise<ConfigReconciliationResult> {
		this.logger?.infoSync('Starting config reconciliation', {
			component: LogComponents.configManager,
			operation: 'reconcile',
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
			
			// Merge non-device fields into current config
			Object.assign(this.currentConfig, otherTargetFields);
			
			// Restore endpoints array (will be reconciled separately)
			if (currentEndpoints) {
				this.currentConfig.endpoints = currentEndpoints;
			}			// Calculate steps for sensor reconciliation
			const steps = this.calculateSteps();

			if (steps.length === 0) {
				this.logger?.infoSync('No sensor config changes needed', {
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
	 * Calculate what config changes are needed
	 */
	private calculateSteps(): ConfigStep[] {
		const steps: ConfigStep[] =[];
		
		const targetDevices = this.targetConfig.endpoints || [];
		const currentDevices = this.currentConfig.endpoints || [];
		
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
			
			// Extract protocol-specific metadata
			let metadata: Record<string, any> = {};
			if (device.protocol === 'modbus' && connection.unitId !== undefined) {
				// For Modbus: store unitId as slaveId in metadata
				metadata = { slaveId: connection.unitId };
			} else if (device.protocol === 'can') {
				// For CAN: add CAN-specific metadata here if needed
				metadata = {};
			} else if (device.protocol === 'opcua') {
				// For OPC-UA: add OPC-UA-specific metadata here if needed
				metadata = {};
			}
			
			// Normalize property names (camelCase → snake_case)
			const normalizedDevice = {
				protocol: device.protocol as 'modbus' | 'can' | 'opcua',
				enabled: device.enabled !== undefined ? device.enabled : true,
				poll_interval: device.pollInterval || 5000,
				connection: connection,
				data_points: (device as any).dataPoints || (device as any).registers || [],
				metadata: metadata
			};
			
			// Try to update first
			const existing = await DeviceSensorModel.getByName(device.name);
			
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

			this.logger?.infoSync('Loaded current config from database', {
				component: LogComponents.configManager,
				operation: 'loadCurrentConfig',
				deviceCount: this.currentConfig.endpoints?.length || 0,
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

