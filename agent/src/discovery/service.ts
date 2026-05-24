/** Discovery orchestration service for protocol plugins and persistence. */
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { EndpointModel } from '../db/models/endpoint.model';
import { MetadataModel } from '../db/models';
import type { IDiscovery, DiscoveredDevice } from '../plugins/types';
import { ModbusDiscovery } from '../plugins/modbus/discovery';
import { OPCUADiscovery } from '../plugins/opcua/discovery';
import { MqttDiscovery } from '../plugins/mqtt/discovery';
import { BACnetDiscovery } from '../plugins/bacnet/discovery';
import type { ConfigManager } from '../core/config.js';
import { DiscoveryOptionsBuilder } from './options.js';
import { DiscoveryStore } from './db.js';

export type DiscoveryTrigger = 'first_boot' | 'manual' | 'scheduled' | 'config-change';
export type DiscoveryProtocol = 'modbus' | 'opcua' | 'can' | 'snmp' | 'mqtt' | 'bacnet';

export interface DiscoveryOptions {
  trigger: DiscoveryTrigger;
	validate?: boolean;
	forceRun?: boolean;
	protocols?: Array<DiscoveryProtocol>;
	skipDbWrites?: boolean;
}

export type { DiscoveredDevice } from '../plugins/types';

export interface DiscoveryMetadata {
  lastDiscoveryAt?: Date;
	lastFullDiscoveryAt?: Date;
	lastLightDiscoveryAt?: Date;
  discoveryCount: number;
  lastTrigger?: DiscoveryTrigger;
}

export class DiscoveryService extends EventEmitter {
	private logger?: AgentLogger;
	private configManager?: ConfigManager;
	private metadata: DiscoveryMetadata;
	private readonly MIN_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000;
	private plugins: Map<string, IDiscovery>;
	private lightTimer?: NodeJS.Timeout;
	private fullTimer?: NodeJS.Timeout;
	private optionsBuilder: DiscoveryOptionsBuilder;
	private store: DiscoveryStore;

	private discoveredDevicesCache: Map<string, DiscoveredDevice> = new Map();

	private discoveryRunning: boolean = false;

	public isDiscoveryRunning(): boolean {
		return this.discoveryRunning;
	}

	constructor(logger?: AgentLogger, configManager?: ConfigManager) {
		super();
		this.logger = logger;
		this.configManager = configManager;
		this.metadata = { discoveryCount: 0 };
		this.plugins = this.initializePlugins();
		this.optionsBuilder = new DiscoveryOptionsBuilder(configManager, logger);
		this.store = new DiscoveryStore(logger, configManager, this.emit.bind(this));
	}

	public releasePluginClient(protocol: string): void {
		const plugin = this.plugins.get(protocol) as any;
		if (plugin && typeof plugin.close === 'function') {
			plugin.close();
		}
	}

	private initializePlugins(): Map<string, IDiscovery> {
		const plugins = new Map<string, IDiscovery>();
    
		plugins.set('modbus', new ModbusDiscovery(this.logger, this.configManager));
		plugins.set('opcua', new OPCUADiscovery(this.logger, this.configManager));
		plugins.set('mqtt', new MqttDiscovery(this.logger));
		plugins.set('bacnet', new BACnetDiscovery(this.logger));
    
		return plugins;
	}

	public startPeriodicDiscovery(): void {
			const enablePeriodicDiscovery = process.env.ENABLE_PERIODIC_DISCOVERY !== 'false';
    
		if (!enablePeriodicDiscovery) {
			this.logger?.debugSync('Periodic discovery disabled', {
				component: LogComponents.discovery,
			});
			return;
		}
		this.stopPeriodicDiscovery();
    
		const intervals = this.configManager?.getIntervalConfig();
		if (!intervals) {
			this.logger?.warnSync('Cannot start periodic discovery - configManager not available', {
				component: LogComponents.discovery,
			});
			return;
		}
    
		this.logger?.debugSync('Starting periodic discovery timers', {
			component: LogComponents.discovery,
			lightIntervalHours: intervals.discoveryLightIntervalMs! / (60 * 60 * 1000),
			fullIntervalHours: intervals.discoveryFullIntervalMs! / (60 * 60 * 1000),
		});
    
		this.lightTimer = setInterval(() => {
			this.logger?.debugSync('Running scheduled light discovery', {
				component: LogComponents.discovery,
			});
      
			this.runDiscovery({
				trigger: 'scheduled',
				validate: false,
			}).catch(error => {
				this.logger?.errorSync(
					'Scheduled light discovery failed',
          error as Error,
          { component: LogComponents.discovery }
				);
			});
		}, intervals.discoveryLightIntervalMs);

		this.fullTimer = setInterval(() => {
			this.logger?.debugSync('Running scheduled full discovery', {
				component: LogComponents.discovery,
			});
      
			this.runDiscovery({
				trigger: 'scheduled',
				validate: true,
			}).catch(error => {
				this.logger?.errorSync(
					'Scheduled full discovery failed',
          error as Error,
          { component: LogComponents.discovery }
				);
			});
		}, intervals.discoveryFullIntervalMs);
	}

	public stopPeriodicDiscovery(): void {
		if (this.lightTimer) {
			clearInterval(this.lightTimer);
			this.lightTimer = undefined;
		}
		if (this.fullTimer) {
			clearInterval(this.fullTimer);
			this.fullTimer = undefined;
		}
	}

	public cleanup(): void {
		this.stopPeriodicDiscovery();
		this.removeAllListeners();
	}

	public getDiscoveredDevice(endpointUrl: string): DiscoveredDevice | undefined {
		const device = this.discoveredDevicesCache.get(endpointUrl);
		if (device) {
			this.logger?.debugSync('Retrieved discovered device from cache', {
				component: LogComponents.discovery,
				endpointUrl,
				dataPointsCount: device.dataPoints?.length || 0,
				cacheSize: this.discoveredDevicesCache.size
			});
		}
		return device;
	}

	async runDiscovery(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
		const {
			trigger: _trigger,
			validate: _validate = false,
			forceRun: _forceRun = false,
			protocols: _protocols,
		} = options;
		const traceId = crypto.randomUUID();

		this.discoveryRunning = true;
		try {
			return await this._runDiscovery(options, traceId);
		} finally {
			this.discoveryRunning = false;
		}
	}

	private async _runDiscovery(options: DiscoveryOptions, traceId: string): Promise<DiscoveredDevice[]> {
		const { trigger, validate = false, forceRun = false, protocols } = options;

		const selectedProtocols = protocols || Array.from(this.plugins.keys());
		const autoValidateBacnet =
			trigger === 'manual' && !validate && selectedProtocols.includes('bacnet');
		const effectiveValidate = validate || autoValidateBacnet;

		if (!forceRun && !this.shouldRunDiscovery(trigger)) {
			this.logger?.debugSync('Discovery skipped due to rate limiting', {
				component: LogComponents.discovery,
				traceId,
				trigger,
				lastDiscoveryAt: this.metadata.lastDiscoveryAt
			});
			return [];
		}

		if (trigger === 'first_boot') {
			this.logger?.infoSync('Running device discovery scan with full validation', {
				component: LogComponents.discovery,
				traceId,
				validate: effectiveValidate,
				protocols: protocols || 'all'
			});
		} else {
			this.logger?.debugSync('Starting discovery', {
				component: LogComponents.discovery,
				traceId,
				trigger,
				validate: effectiveValidate,
				autoValidateBacnet,
				forceRun,
				protocols: protocols || 'all'
			});
		}

		const startTime = Date.now();

		const allDiscovered: DiscoveredDevice[] = [];

		for (const protocol of selectedProtocols) {
			const plugin = this.plugins.get(protocol);
			if (!plugin) {
				this.logger?.warnSync(`Unknown protocol: ${protocol}`, {
					component: LogComponents.discovery,
					traceId
				});
				continue;
			}

			if (!(await plugin.isAvailable())) {
				this.logger?.debugSync(`Plugin '${protocol}' not available on this platform`, {
					component: LogComponents.discovery,
					traceId
				});
				continue;
			}

			try {

				const pluginOptions = this.optionsBuilder.build(protocol);

				if (pluginOptions === undefined) {
					this.logger?.debugSync(`No configuration for ${protocol}, skipping discovery`, {
						component: LogComponents.discovery,
						protocol,
						traceId
					});
					continue;
				}
        
				const discovered = await plugin.discover(pluginOptions);
     
				allDiscovered.push(...discovered);

				if (discovered.length > 0) {
					this.logger?.infoSync(`${protocol.toUpperCase()} found ${discovered.length} device(s)`, {
						component: LogComponents.discovery,
						protocol,
						traceId
					});
				}

				if (effectiveValidate && discovered.length > 0) {
					this.logger?.debugSync(`Validating ${discovered.length} ${protocol} devices`, {
						component: LogComponents.discovery,
						traceId,
						protocol,
						phase: 'validation'
					});

					for (const device of discovered) {
						try {
							const validationData = await plugin.validate(device);
							if (validationData) {
								device.validated = true;
								device.validationData = validationData;
								device.confidence = 'high';

								if (validationData.manufacturer || validationData.modelNumber) {
									const baseName = `${validationData.manufacturer || protocol}_${validationData.modelNumber || device.name}`
										.toLowerCase()
										.replace(/\s+/g, '_');

									if (protocol === 'bacnet') {
										const deviceInstance = device.connection?.deviceInstance;
										const cleanedBaseName = baseName.replace(/^iotistica_+/, '');
										const nameWithPrefix = cleanedBaseName.startsWith('iotistica_') ? cleanedBaseName : `iotistica_${cleanedBaseName}`;
										device.name = typeof deviceInstance === 'number'
											? nameWithPrefix.endsWith(`_${deviceInstance}`) ? nameWithPrefix : `${nameWithPrefix}_${deviceInstance}`
											: nameWithPrefix;
									} else {
										device.name = baseName;
									}
								}

								if (validationData.dataPointValidation) {
									const pv = validationData.dataPointValidation;
                  
									if (pv.result === 'config_mismatch') {
										this.logger?.warnSync(`⚠️  Data point config mismatch detected for ${device.name}`, {
											component: LogComponents.discovery,
											traceId,
											slaveId: device.metadata?.slaveId,
											result: pv.result,
											responseConfidence: pv.responseConfidence.toFixed(2),
											dataConfidence: pv.dataConfidence.toFixed(2),
											readableCount: pv.readableCount,
											errorCount: pv.errorCount,
											details: pv.details,
											guidance: pv.guidance || 'Check profile configuration in dashboard',
											meiVendor: pv.meiVendor,
											meiModel: pv.meiModel
										});
									}

									try {
										await EndpointModel.update(device.name, {
											metadata: {
												...device.metadata,
												dataPointValidation: pv,
												validated: true,
												confidence: device.confidence
											}
										});
									} catch (updateError) {
										this.logger?.warnSync(`Failed to update validation results for ${device.name}`, {
											component: LogComponents.discovery,
											error: (updateError as Error).message
										});
									}
								}
							}
						} catch (error) {
							this.logger?.warnSync(`Validation failed for ${device.name}`, {
								component: LogComponents.discovery,
								traceId,
								error: (error as Error).message
							});
						}
					}
				}
			} catch (error) {
				this.logger?.errorSync(
					`Discovery failed for protocol ${protocol}`,
          error as Error,
          { component: LogComponents.discovery, traceId }
				);
			}
		}

		const duration = Date.now() - startTime;

		this.logger?.infoSync(`Discovery complete: ${allDiscovered.length} devices found in ${duration}ms`, {
			component: LogComponents.discovery,
			traceId,
			validated: effectiveValidate,
			autoValidateBacnet,
			protocols: selectedProtocols
		});

		const saveResults = await this.store.save(allDiscovered, traceId, options.skipDbWrites || false);

		for (const device of allDiscovered) {
			const endpointUrl = device.connection?.endpointUrl || device.metadata?.endpointUrl;
			if (endpointUrl) {
				this.discoveredDevicesCache.set(endpointUrl, device);
			}
		}

		if (options.skipDbWrites) {
			this.logger?.debugSync('Discovery in update-only mode (reconcile creates records)', {
				component: LogComponents.discovery,
				traceId,
				devicesValidated: allDiscovered.length,
				updatedCount: saveResults.saved,
				skippedCount: saveResults.skipped,
				protocols: selectedProtocols,
				cachedDevices: this.discoveredDevicesCache.size
			});
		}

		this.updateMetadata(trigger, effectiveValidate);

		this.emit('discovery-complete', {
			trigger,
			validate: effectiveValidate,
			deviceCount: allDiscovered.length,
			savedCount: saveResults.saved,
			skippedCount: saveResults.skipped,
			traceId
		});

		return allDiscovered;
	}

	private shouldRunDiscovery(trigger: DiscoveryTrigger): boolean {

		if (trigger === 'first_boot' || trigger === 'manual' || trigger === 'scheduled') {
			return true;
		}

		if (!this.metadata.lastDiscoveryAt) {
			return true;
		}

		const timeSinceLastDiscovery = Date.now() - this.metadata.lastDiscoveryAt.getTime();
		return timeSinceLastDiscovery >= this.MIN_DISCOVERY_INTERVAL_MS;
	}

	async init(): Promise<void> {
		try {
			const data = await MetadataModel.getByPrefix('discovery.');
      
			this.metadata = {
				lastDiscoveryAt: data['discovery.lastDiscoveryAt'] ? new Date(data['discovery.lastDiscoveryAt']) : undefined,
				lastFullDiscoveryAt: data['discovery.lastFullDiscoveryAt'] ? new Date(data['discovery.lastFullDiscoveryAt']) : undefined,
				lastLightDiscoveryAt: data['discovery.lastLightDiscoveryAt'] ? new Date(data['discovery.lastLightDiscoveryAt']) : undefined,
				discoveryCount: data['discovery.discoveryCount'] ? parseInt(data['discovery.discoveryCount'], 10) : 0,
				lastTrigger: data['discovery.lastTrigger'] as DiscoveryTrigger | undefined
			};

		} catch (error) {
			this.logger?.warnSync('Failed to load discovery metadata, using defaults', {
				component: LogComponents.discovery,
				error: (error as Error).message
			});
		}
	}

	private async updateMetadata(trigger: DiscoveryTrigger, validated: boolean): Promise<void> {
		const now = new Date();
    
		this.metadata.lastDiscoveryAt = now;
		this.metadata.lastTrigger = trigger;
		this.metadata.discoveryCount++;

		if (validated) {
			this.metadata.lastFullDiscoveryAt = now;
		} else {
			this.metadata.lastLightDiscoveryAt = now;
		}

		try {
			await MetadataModel.set('discovery.lastDiscoveryAt', now.toISOString());
			await MetadataModel.set('discovery.lastTrigger', trigger);
			await MetadataModel.set('discovery.discoveryCount', this.metadata.discoveryCount.toString());
      
			if (validated) {
				await MetadataModel.set('discovery.lastFullDiscoveryAt', now.toISOString());
			} else {
				await MetadataModel.set('discovery.lastLightDiscoveryAt', now.toISOString());
			}
		} catch (error) {
			this.logger?.warnSync('Failed to persist discovery metadata', {
				component: LogComponents.discovery,
				error: (error as Error).message
			});
		}
	}

	getMetadata(): DiscoveryMetadata {
		return { ...this.metadata };
	}
}
