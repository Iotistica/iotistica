
import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { EndpointModel } from '../../db/models/endpoint.model';
import { MetadataModel } from '../../db/models';
import type { BaseDiscoveryPlugin, DiscoveredDevice } from '../types';
import { ModbusDiscoveryPlugin } from '../modbus/discovery';
import { OPCUADiscoveryPlugin } from '../opcua/discovery';
import { CANDiscoveryPlugin } from '../can/discovery';
import { SNMPDiscoveryPlugin } from '../snmp/discovery';
import { LocalBrokerMqttDiscoveryPlugin } from '../mqtt/discovery';
import { BACnetDiscoveryPlugin } from '../bacnet/discovery';
import type { ConfigManager } from '../../agent/config.js';
import { DiscoveryOptionsBuilder } from './options.js';
import { DiscoveryStore } from './db.js';

export type DiscoveryTrigger = 'first_boot' | 'manual' | 'scheduled' | 'config-change';
export type DiscoveryProtocol = 'modbus' | 'opcua' | 'can' | 'snmp' | 'mqtt' | 'bacnet';

export interface DiscoveryOptions {
  trigger: DiscoveryTrigger;
  validate?: boolean; // Run validation phase (slow)
  forceRun?: boolean; // Override rate limiting
  protocols?: Array<DiscoveryProtocol>; // Only run specific protocols (default: all)
  skipDbWrites?: boolean; // Skip saving to database (when reconcile already synced from cloud)
}

// Re-export for convenience
export type { DiscoveredDevice } from '../types';

export interface DiscoveryMetadata {
  lastDiscoveryAt?: Date;
  lastFullDiscoveryAt?: Date; // With validation
  lastLightDiscoveryAt?: Date; // Ping only
  discoveryCount: number;
  lastTrigger?: DiscoveryTrigger;
}

/**
 * Discovery Service
 * Coordinates protocol-specific discovery plugins
 * 
 * Events:
 * - 'discovery-complete': Emitted after discovery completes and saves to database
 *   Payload: { trigger: DiscoveryTrigger, validate: boolean, deviceCount: number, traceId: string }
 * - 'endpoint-enabled': Emitted when a new enabled endpoint is saved to database
 *   Payload: { protocol: string, endpoint: DeviceEndpoint }
 */
export class DiscoveryService extends EventEmitter {
	private logger?: AgentLogger;
	private configManager?: ConfigManager;
	private metadata: DiscoveryMetadata;
	private readonly MIN_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
	private plugins: Map<string, BaseDiscoveryPlugin>;
	private lightTimer?: NodeJS.Timeout;
	private fullTimer?: NodeJS.Timeout;
	private optionsBuilder: DiscoveryOptionsBuilder;
	private store: DiscoveryStore;
  
	// CRITICAL: Cache discovered devices for reconciliation to access
	// When discovery runs with skipDbWrites, the discovered nodes aren't saved to DB
	// But reconciliation needs them when creating new device records
	// Map: endpointUrl → discovered device with data_points
	private discoveredDevicesCache: Map<string, DiscoveredDevice> = new Map();

	// Track whether a discovery run is currently in progress
	private discoveryRunning: boolean = false;

	/**
   * Returns true if a discovery run is currently in progress.
   * Used by the adapter reload logic to defer reloads until discovery writes
   * data_points to the database, avoiding the empty-dataPoints race condition.
   */
	public isDiscoveryRunning(): boolean {
		return this.discoveryRunning;
	}

	/**
   * Create discovery service
   * 
   * IMPORTANT: Call init() after construction to load persisted metadata:
   *   const discovery = new DiscoveryService(logger, configManager);
   *   await discovery.init();
   */
	constructor(logger?: AgentLogger, configManager?: ConfigManager) {
		super();
		this.logger = logger;
		this.configManager = configManager;
		this.metadata = { discoveryCount: 0 };
		this.plugins = this.initializePlugins();
		this.optionsBuilder = new DiscoveryOptionsBuilder(configManager, logger);
		this.store = new DiscoveryStore(logger, configManager, this.emit.bind(this));
	}

	/**
   * Initialize all discovery plugins
   */
	private initializePlugins(): Map<string, BaseDiscoveryPlugin> {
		const plugins = new Map<string, BaseDiscoveryPlugin>();
    
		plugins.set('modbus', new ModbusDiscoveryPlugin(this.logger, this.configManager));
		plugins.set('opcua', new OPCUADiscoveryPlugin(this.logger, this.configManager));
		plugins.set('can', new CANDiscoveryPlugin(this.logger));
		plugins.set('snmp', new SNMPDiscoveryPlugin(this.logger, this.configManager));
		plugins.set('mqtt', new LocalBrokerMqttDiscoveryPlugin(this.logger));
		plugins.set('bacnet', new BACnetDiscoveryPlugin(this.logger));
    
		return plugins;
	}

	/**
   * Start periodic discovery timers
   * - Light discovery: Fast scan (ping only) every 4 hours (default)
   * - Full discovery: Deep validation every 24 hours (default)
   */
	public startPeriodicDiscovery(): void {
		const enablePeriodicDiscovery = process.env.ENABLE_PERIODIC_DISCOVERY !== 'false'; // Default: enabled
    
		if (!enablePeriodicDiscovery) {
			this.logger?.debugSync('Periodic discovery disabled', {
				component: LogComponents.discovery,
			});
			return;
		}
    
		// Stop any existing timers first
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
    
		// Light discovery: Fast scan (ping only)
		this.lightTimer = setInterval(() => {
			this.logger?.debugSync('Running scheduled light discovery', {
				component: LogComponents.discovery,
			});
      
			this.runDiscovery({
				trigger: 'scheduled',
				validate: false, // Ping only, no deep validation
			}).catch(error => {
				this.logger?.errorSync(
					'Scheduled light discovery failed',
          error as Error,
          { component: LogComponents.discovery }
				);
			});
		}, intervals.discoveryLightIntervalMs);
    
		// Full discovery: Deep validation with device info reads
		this.fullTimer = setInterval(() => {
			this.logger?.debugSync('Running scheduled full discovery', {
				component: LogComponents.discovery,
			});
      
			this.runDiscovery({
				trigger: 'scheduled',
				validate: true, // Full validation with device info
			}).catch(error => {
				this.logger?.errorSync(
					'Scheduled full discovery failed',
          error as Error,
          { component: LogComponents.discovery }
				);
			});
		}, intervals.discoveryFullIntervalMs);
	}

	/**
   * Stop periodic discovery timers
   */
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

	/**
   * Clean up discovery service resources and break reference chains
   * Call this when shutting down or to force garbage collection
   */
	public cleanup(): void {
		this.stopPeriodicDiscovery();
		this.removeAllListeners(); // Clear EventEmitter listeners
    
		// Note: plugins Map is intentionally NOT cleared - it's needed for service lifetime
	}

	/**
   * Get discovered device data from cache
   * Used by ConfigManager to retrieve data_points for new devices during reconciliation
   * 
   * @param endpointUrl - The OPC UA/Modbus/SNMP endpoint URL
   * @returns Discovered device with data_points, or undefined if not found
   */
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

	/**
   * Main entry point: Run discovery with rate limiting
   */
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

		// Check rate limiting
		if (!forceRun && !this.shouldRunDiscovery(trigger)) {
			this.logger?.debugSync('Discovery skipped due to rate limiting', {
				component: LogComponents.discovery,
				traceId,
				trigger,
				lastDiscoveryAt: this.metadata.lastDiscoveryAt
			});
			return [];
		}

		// Log special message for first boot discovery
		if (trigger === 'first_boot') {
			this.logger?.infoSync('Running device discovery scan with full validation', {
				component: LogComponents.discovery,
				traceId,
				validate,
				protocols: protocols || 'all'
			});
		} else {
			this.logger?.debugSync('Starting discovery', {
				component: LogComponents.discovery,
				traceId,
				trigger,
				validate,
				forceRun,
				protocols: protocols || 'all'
			});
		}

		const startTime = Date.now();

		// Filter plugins by requested protocols
		const selectedProtocols = protocols || Array.from(this.plugins.keys());
		const allDiscovered: DiscoveredDevice[] = [];

		// Run discovery on each plugin
		for (const protocol of selectedProtocols) {
			const plugin = this.plugins.get(protocol);
			if (!plugin) {
				this.logger?.warnSync(`Unknown protocol: ${protocol}`, {
					component: LogComponents.discovery,
					traceId
				});
				continue;
			}

			// Check if plugin is available on this platform
			if (!(await plugin.isAvailable())) {
				this.logger?.debugSync(`Plugin '${protocol}' not available on this platform`, {
					component: LogComponents.discovery,
					traceId
				});
				continue;
			}

			try {
				// Phase 1: Discovery
				// Build protocol-specific options from environment variables
				const pluginOptions = this.optionsBuilder.build(protocol);
        
				// Skip protocol if no configuration provided (prevents unwanted network scans)
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

				// Log per-protocol result only when devices were actually found
				if (discovered.length > 0) {
					this.logger?.infoSync(`${protocol.toUpperCase()} found ${discovered.length} device(s)`, {
						component: LogComponents.discovery,
						protocol,
						traceId
					});
				}

				// Phase 2: Validation (optional)
				if (validate && discovered.length > 0) {
					this.logger?.debugSync(`Validating ${discovered.length} ${protocol} devices`, {
						component: LogComponents.discovery,
						traceId,
						protocol,
						phase: 'validation'
					});

					// Sequential validation for clean logging (slaves appear in order)
					for (const device of discovered) {
						try {
							const validationData = await plugin.validate(device);
							if (validationData) {
								device.validated = true;
								device.validationData = validationData;
								device.confidence = 'high';

								// Update name if manufacturer/model detected
								if (validationData.manufacturer || validationData.modelNumber) {
									device.name = `${validationData.manufacturer || protocol}_${validationData.modelNumber || device.name}`.toLowerCase().replace(/\s+/g, '_');
								}

								// Check data point validation results (Modbus-specific)
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
                  
									// Update validation results in database (for both new and existing devices)
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
			validated: validate,
			protocols: selectedProtocols
		});

		// Save to database
		// skipDbWrites: true = update existing records only, don't create new
		// skipDbWrites: false = full save (create + update)
		const saveResults = await this.store.save(allDiscovered, traceId, options.skipDbWrites || false);

		// CRITICAL: Cache discovered devices for reconciliation to access
		// When skipDbWrites is true, new devices don't get saved to DB yet
		// But reconciliation needs the discovered data_points when creating records
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

		// Update metadata
		this.updateMetadata(trigger, validate);

		// Emit discovery-complete event (triggers sensor publish reload on first boot)
		this.emit('discovery-complete', {
			trigger,
			validate,
			deviceCount: allDiscovered.length,
			savedCount: saveResults.saved,
			skippedCount: saveResults.skipped,
			traceId
		});

		// Return discovered devices to caller
		return allDiscovered;
	}

	/**
   * Check if discovery should run based on trigger and last run time
   */
	private shouldRunDiscovery(trigger: DiscoveryTrigger): boolean {
		// Always run on first boot, manual trigger, or scheduled discovery
		// Scheduled discoveries have their own timers, so trust them
		if (trigger === 'first_boot' || trigger === 'manual' || trigger === 'scheduled') {
			return true;
		}

		// For other triggers (if any), check interval
		if (!this.metadata.lastDiscoveryAt) {
			return true; // Never run before
		}

		const timeSinceLastDiscovery = Date.now() - this.metadata.lastDiscoveryAt.getTime();
		return timeSinceLastDiscovery >= this.MIN_DISCOVERY_INTERVAL_MS;
	}

	/**
   * Initialize metadata from database (async)
   */
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

	/**
   * Update discovery metadata after successful run
   */
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

		// Persist to SQLite metadata table
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

	/**
   * Get current discovery metadata
   */
	getMetadata(): DiscoveryMetadata {
		return { ...this.metadata };
	}
}
