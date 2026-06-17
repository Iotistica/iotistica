/**
 * Adapter Initializer
 *
 * Handles initialization and lifecycle management of protocol adapters
 * (Modbus, OPC-UA, MQTT, SNMP, CAN) and the event listeners that reload
 * them when discovery or reconciliation changes endpoint configuration.
 *
 * Extracted from features.ts to keep feature orchestration focused.
 */

import { LogComponents } from '../logging/types.js';
import { AdapterManager, type AdapterConfig } from '../plugins/index.js';
import type { FeatureContext } from './features.js';

export interface AdapterFeatures {
	devices?: AdapterManager;
}

/**
 * AdapterInitializer
 *
 * Responsibilities:
 * - Create and start AdapterManager based on database-enabled endpoints
 * - Wire the rediscovery-needed listener (OPC-UA stale-node detection)
 * - Set up endpoint auto-reload listeners (pre-discovery, endpoint-enabled,
 *   discovery-complete, reconciliation-complete)
 */
export class AdapterInitializer {
	private features: AdapterFeatures = {};
	// Serializes all adapter reload operations so concurrent reconciliation-complete
	// events cannot create multiple DevicePublish instances simultaneously.
	private reloadQueue: Promise<void> = Promise.resolve();
	// Set to true when pre-discovery stops DevicePublish, so the discovery-complete
	// else branch knows it needs to restart it. Without this flag, scheduled rule
	// runs (which do NOT emit pre-discovery) would also stop+restart DevicePublish
	// on every tick, causing spurious external MQTT reconnects.
	private pendingDevicePublishRestart = false;

	private scheduleReload(label: string, fn: () => Promise<void>): void {
		this.reloadQueue = this.reloadQueue.then(() => fn()).catch((err) => {
			this.context.logger?.errorSync(`Adapter reload failed (${label})`, err as Error, {
				component: LogComponents.agent,
			});
		});
	}

	constructor(
    private context: FeatureContext,
    private onAdaptersReady: () => Promise<void>,  // called after (re)init to start DevicePublish
    private onAdaptersStopping: () => Promise<void>,  // called before stop to tear down DevicePublish
    private getCloudSync: () => any
	) {}

	getFeatures(): AdapterFeatures {
		return this.features;
	}

	// ============================================================================
	// PUBLIC INIT / RELOAD
	// ============================================================================

	async initProtocolAdapters(): Promise<void> {
		const { logger, deviceInfo } = this.context;

		try {
			const devicesConfig: AdapterConfig & Record<string, any> = {
				modbus: { enabled: false },
				opcua:  { enabled: false },
				snmp:   { enabled: false },
				can:    { enabled: false },
				mqtt:   { enabled: false }
			};

			const { EndpointModel } = await import('../db/models/endpoint.model.js');
			const enabledProtocols: string[] = [];

			for (const protocol of ['modbus', 'opcua', 'snmp', 'can', 'mqtt', 'bacnet']) {
				const devices = await EndpointModel.getEnabled(protocol);
				const validDevices = devices.filter((d: any) => !!d.uuid);

				if (validDevices.length > 0) {
					enabledProtocols.push(protocol);
					devicesConfig[protocol] = { enabled: true };
				} else if (devices.length > 0) {
					logger.warnSync('Ignoring enabled endpoints without UUID for protocol startup', {
						component: LogComponents.agent,
						protocol,
						invalidCount: devices.length
					});
				}
			}

			// MQTT adapter starts whenever MQTT_BROKER_URL is set, even with zero DB endpoints.
			if (!enabledProtocols.includes('mqtt') && process.env.MQTT_BROKER_URL) {
				enabledProtocols.push('mqtt');
				devicesConfig.mqtt = { enabled: true };
				logger.infoSync('Enabling MQTT adapter via MQTT_BROKER_URL (no DB endpoints required)', {
					component: LogComponents.agent,
					brokerUrl: process.env.MQTT_BROKER_URL
				});
			}

			// Always create AdapterManager so health reporting works before any endpoints are enabled.
			this.features.devices = new AdapterManager(devicesConfig, logger, deviceInfo.uuid);

			if (enabledProtocols.length === 0) {
				logger.debugSync('No protocols enabled initially, AdapterManager created but not started', {
					component: LogComponents.agent,
					note: 'Will be started when endpoints are enabled via discovery or config'
				});
			} else {
				await this.features.devices.start();
			}

			const { setAdapterManager } = await import('../api/actions.js');
			setAdapterManager(this.features.devices);

			this._wireRediscoveryListener();

		} catch (error) {
			logger.errorSync('Failed to initialize Protocol Adapters', error as Error, {
				component: LogComponents.agent,
				note: 'Continuing without Protocol Adapters'
			});
			this.features.devices = undefined;
		}
	}

	setupEndpointAutoReloadListener(): void {
		const { logger } = this.context;

		if (!this.context.discoveryService) {
			logger.debugSync('Discovery service not available, skipping endpoint auto-reload setup', {
				component: LogComponents.agent
			});
			return;
		}

		this.context.discoveryService.on('pre-discovery', async (data: any) => {
			logger.infoSync('Preparing for discovery - stopping Device Publish to free connection slots', {
				component: LogComponents.agent,
				protocols: data.protocols,
				trigger: data.trigger
			});
			try {
				this.pendingDevicePublishRestart = true;
				await this.onAdaptersStopping();
			} catch (error) {
				logger.errorSync('Failed to stop Device Publish before discovery', error as Error, {
					component: LogComponents.agent
				});
			}
		});

		this.context.discoveryService.on('endpoint-enabled', async (data: any) => {
			if (data.isBatchDiscovery) {
				logger.debugSync('Skipping individual reload during batch discovery', {
					component: LogComponents.agent,
					protocol: data.protocol,
					endpoint: data.name,
					note: 'Will reload after discovery completes'
				});
				return;
			}

			logger.infoSync('New enabled endpoint discovered, reloading Device Publish', {
				component: LogComponents.agent,
				protocol: data.protocol,
				endpoint: data.name,
				source: data.source
			});

			try {
				await this.onAdaptersStopping();
				await this.onAdaptersReady();
				logger.infoSync('Device Publish reloaded successfully', {
					component: LogComponents.agent,
					newEndpoint: data.name
				});
			} catch (error) {
				logger.errorSync('Failed to reload Device Publish', error as Error, {
					component: LogComponents.agent,
					endpoint: data.name
				});
			}
		});

		this.context.discoveryService.on('discovery-complete', async (data: any) => {
			const shouldReload = data.savedCount > 0;

			if (shouldReload) {
				try {
					logger.infoSync('Reloading protocol adapters and Device Publish after endpoint changes', {
						component: LogComponents.agent,
						trigger: data.trigger,
						savedCount: data.savedCount,
						skippedCount: data.skippedCount,
						reason: data.trigger === 'config-change' ? 'DB already synced by reconcile' : 'new devices discovered'
					});

					await this._fullReload();

				} catch (error) {
					logger.errorSync('Failed to reload protocol adapters after discovery', error as Error, {
						component: LogComponents.agent
					});
				}
			} else {
				logger.debugSync('Skipping reload - no new devices discovered', {
					component: LogComponents.agent,
					trigger: data.trigger,
					savedCount: data.savedCount,
					skippedCount: data.skippedCount
				});

				// Only restart DevicePublish if pre-discovery actually stopped it.
				// Scheduled rule runs do NOT emit pre-discovery, so DevicePublish keeps
				// running and must not be torn down here (doing so causes a spurious
				// external MQTT reconnect on every scheduler tick).
				if (this.pendingDevicePublishRestart) {
					this.pendingDevicePublishRestart = false;
					try {
						await this.onAdaptersReady();
						this._updateCloudSync();
						logger.infoSync('Restarted Device Publish after discovery (no new devices)', {
							component: LogComponents.agent,
							trigger: data.trigger
						});
					} catch (error) {
						logger.errorSync('Failed to restart Device Publish after discovery', error as Error, {
							component: LogComponents.agent
						});
					}
				} else {
					this._updateCloudSync();
				}
			}
		});

		logger.infoSync('Endpoint auto-reload watcher initialized', {
			component: LogComponents.agent,
			note: 'Device Publish will reload automatically when discovery finds new enabled endpoints'
		});

		if (this.context.stateReconciler) {
			this.context.stateReconciler.on('reconciliation-complete', (hasEndpointChanges: boolean) => {
				if (!hasEndpointChanges) {
					logger.debugSync('Skipping adapter reload on reconciliation-complete — no endpoint changes', {
						component: LogComponents.agent
					});
					return;
				}

				if (this.context.discoveryService?.isDiscoveryRunning()) {
					logger.infoSync('Skipping adapter reload on reconciliation-complete — discovery in progress; will reload on discovery-complete', {
						component: LogComponents.agent
					});
					return;
				}

				// Queue the reload so rapid back-to-back reconciliation events (e.g. user adds
				// multiple endpoints in quick succession) execute one at a time.  Without this,
				// concurrent async handlers each call onAdaptersReady() concurrently and create
				// duplicate DevicePublish instances with the same MQTT clientId.
				this.scheduleReload('reconciliation-complete', async () => {
					// Hot-update path: MQTT adapter already connected — diff subscriptions in-place,
					// but only if no new non-MQTT protocol was added that needs a socket server.
					if (this.features.devices?.getAdapter('mqtt')) {
						const { EndpointModel } = await import('../db/models/endpoint.model.js');
						let hasNewProtocol = false;
						for (const protocol of ['modbus', 'opcua', 'snmp', 'can', 'bacnet']) {
							const devices = await EndpointModel.getEnabled(protocol);
							const valid = devices.filter((d: any) => !!d.uuid);
							if (valid.length > 0 && !this.features.devices.getAdapter(protocol)) {
								hasNewProtocol = true;
								logger.infoSync('New protocol requires socket server — falling back to full reload', {
									component: LogComponents.agent,
									protocol,
									trigger: 'reconciliation-complete'
								});
								break;
							}
						}

						if (!hasNewProtocol) {
							logger.infoSync('Hot-reloading MQTT adapter after endpoint changes (no reconnect)', {
								component: LogComponents.agent,
								trigger: 'reconciliation-complete'
							});

							await this.features.devices.reloadMQTTAdapter();
							await this.onAdaptersStopping();
							await this.onAdaptersReady();
							this._updateCloudSync();

							logger.infoSync('MQTT adapter hot-reloaded after reconciliation', {
								component: LogComponents.agent
							});
							return;
						}
					}

					// Full reinit path: no adapter running, or non-MQTT protocol changes.
					logger.infoSync('Reloading protocol adapters after reconciliation complete', {
						component: LogComponents.agent,
						trigger: 'reconciliation-complete'
					});

					await this._fullReload();

					logger.infoSync('Protocol adapters reloaded after reconciliation', {
						component: LogComponents.agent
					});
				});
			});

			logger.infoSync('Reconciliation reload watcher initialized', {
				component: LogComponents.agent,
				note: 'Protocol adapters reload after reconciliation completes (not during discovery)'
			});
		}
	}

	// ============================================================================
	// PRIVATE HELPERS
	// ============================================================================

	/** Wire the rediscovery-needed listener on the current AdapterManager instance. */
	private _wireRediscoveryListener(): void {
		const { logger } = this.context;
		if (!this.context.discoveryService || !this.features.devices) return;

		this.features.devices.on('rediscovery-needed', async (data: { deviceName: string; endpointUrl: string }) => {
			logger.warnSync('OPC-UA adapter detected stale NodeIDs - triggering targeted rediscovery', {
				component: LogComponents.agent,
				deviceName: data.deviceName,
				endpointUrl: data.endpointUrl,
				note: 'Server may have switched profiles; will re-browse after brief stabilization delay'
			});
			try {
				await new Promise<void>(resolve => setTimeout(resolve, 3000));
				await this.context.discoveryService!.runDiscovery({
					trigger: 'manual',
					protocols: ['opcua'],
					validate: true,
					forceRun: true
				});
			} catch (error) {
				logger.errorSync('Rediscovery triggered by OPC-UA adapter failed', error as Error, {
					component: LogComponents.agent,
					deviceName: data.deviceName
				});
			}
		});
	}

	/** Stop adapters, reinit, restart DevicePublish, update CloudSync. */
	private async _fullReload(): Promise<void> {
		// _fullReload handles its own stop+restart cycle; clear the flag so
		// discovery-complete's else branch doesn't attempt a second restart.
		this.pendingDevicePublishRestart = false;

		// Release the BACnet discovery plugin's socket so the adapter can bind
		// to the same port without conflict (both use port 47809 by default).
		this.context.discoveryService?.releasePluginClient('bacnet');

		if (this.features.devices) {
			await this.features.devices.stop();
			this.features.devices = undefined;
		}

		await this.onAdaptersStopping();
		await this.initProtocolAdapters();
		await this.onAdaptersReady();
		this._updateCloudSync();
	}

	/** Push the current AdapterManager reference into CloudSync. */
	private _updateCloudSync(): void {
		const cloudSync = this.getCloudSync();
		if (cloudSync && this.features.devices) {
			cloudSync.setDevices(this.features.devices);
		}
	}
}
