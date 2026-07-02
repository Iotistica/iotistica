/**
 * Feature Initializer
 * 
 * Handles initialization of optional agent features in a clean, modular way.
 * Separates feature orchestration from the main agent class.
 */

import type { AgentLogger } from '../logging/agent-logger';
import type { AgentInfo } from '../core/types.js';
import type { AgentInitContext } from './context.js';
import { LogComponents } from '../logging/types';
import { loadJobsFeature, loadShellHandler as loadShellHandlerPro } from '../pro/loader.js';
import { DiscoveryService } from '../discovery/service.js';
import { DiscoveryRulesScheduler } from '../discovery/rules-scheduler.js';
import { BackupScheduler } from '../db/backup-scheduler.js';

import { DevicePublish } from '../publish/index.js';
import type { AdapterManager } from '../plugins/index.js';
import type { PipelineService } from '../features/pipeline/index.js';
import { AdapterInitializer } from './adapters.js';
import { AgentUpdater } from '../updater.js';
import { AgentFirewall } from '../network/firewall.js';
import { setDevicePublish, setDiscoveryRulesScheduler } from '../api/actions.js';
import { type CloudMqttClient } from '../mqtt/manager.js';
import { MQTT_TOPIC_PATTERNS, agentTopic } from '../mqtt/topics.js';
import { type StateManager } from '../core/state.js';
import { isStandaloneMode } from '../utils/env.js';

export interface FeatureContext {
  logger: AgentLogger;
  deviceInfo: AgentInfo;
  mqttManager: CloudMqttClient;
  httpClient: any; // Shared HTTP client with connection pooling (singleton pattern)
  containerManager: any;
  deviceManager: any;
  stateReconciler: StateManager;
  configSettings: Record<string, any>;
  configFeatures: Record<string, any>;
  configProtocols?: Record<string, any>; // New: protocols section from target state
  cloudApiEndpoint: string;
  deviceApiPort: number;
  anomalyService?: any;
  discoveryService?: any; // Discovery service for endpoint auto-reload
  dictionaryManager?: any; // Dictionary manager for MQTT message key compaction
  pipelineService?: PipelineService; // Node-RED payload transform pipeline (optional)
  liveDataInterceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[];
}

export interface InitializedFeatures {
  jobs?: any;
  devicePublish?: DevicePublish;
	devices?: AdapterManager;
  updater?: AgentUpdater;
  firewall?: AgentFirewall;
  shellHandler?: any; // Shell handler for remote terminal access
  discoveryService?: any; // Discovery service (passed from Agent)
}

/**
 * FeatureInitializer - Orchestrates optional feature initialization
 * 
 * Responsibilities:
 * - Initialize optional features (jobs, device-publish, protocol adapters)
 * - Initialize supporting features (updater, firewall, device config handler)
 * - Handle errors gracefully (feature failures don't crash agent)
 * - Provide unified cleanup interface
 */
export class FeatureInitializer {
	private context: FeatureContext;
	private features: InitializedFeatures = {};
	private currentProtocols: Record<string, any> | null = null;
	private cloudSync?: any; // CloudSync reference for updating endpoints after auto-reload
	private adapterInitializer: AdapterInitializer;

	constructor(context: FeatureContext) {
		this.context = context;
		this.adapterInitializer = new AdapterInitializer(
			context,
			() => this.initDevicePublish(),
			async () => {
				if (this.features.devicePublish) {
					await this.features.devicePublish.stop();
					this.features.devicePublish = undefined;
				}
			},
			() => this.cloudSync
		);
	}

	/**
   * Initialize device features (can run in parallel)
   * - Protocol Adapters: Create Unix sockets for data output (Modbus, OPC-UA, etc.)
   * - DevicePublishFeature: Connect to Unix sockets and publish to MQTT
   */
	async initDeviceFeatures(): Promise<void> {
		// Initialize protocol adapters FIRST (they create the Unix sockets)
		await this.adapterInitializer.initProtocolAdapters();

		// Initialize Device Publish (connects to sockets created by protocol adapters)
		await this.initDevicePublish();

		// Store discoveryService reference if available
		if (this.context.discoveryService) {
			this.features.discoveryService = this.context.discoveryService;
		}

		// Watch for new enabled endpoints from discovery (auto-reload Device Publish)
		this.adapterInitializer.setupEndpointAutoReloadListener();
	}

	/**
   * Initialize jobs feature (cloud job polling and execution)
   */
	async initJobsFeature(): Promise<void> {
		await this.initJobs();
	}

	/**
   * Initialize supporting features (can run in parallel)
   * Updater, Firewall, and Config Handler depend on optional features being initialized
   */
	async initSupportingFeatures(): Promise<void> {
		await Promise.all([
			this.initAgentUpdater(),
			this.initShellHandler(),
			this.initFirewall()
		]);
	}

	/**
   * Get initialized features
   */
	getFeatures(): InitializedFeatures {
		return {
			...this.features,
			devices: this.adapterInitializer.getFeatures().devices
		};
	}

	public setAnomalyService(anomalyService?: any): void {
		this.context.anomalyService = anomalyService;
		this.features.devicePublish?.setAnomalyService?.(anomalyService);
	}

	public setLiveDataInterceptor(interceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[]): void {
		this.context.liveDataInterceptor = interceptor;
		this.features.devicePublish?.setLiveDataInterceptor?.(interceptor);
	}

	private isDevicePublishEnabled(): boolean {
		const dynamicFeatures = this.context.stateReconciler?.getConfigManager?.().getFeatures?.();
		if (dynamicFeatures && typeof dynamicFeatures.enableDevicePublish === 'boolean') {
			return dynamicFeatures.enableDevicePublish;
		}

		return this.context.configFeatures?.enableDevicePublish ?? true;
	}

	private isDeviceRemoteAccessEnabled(): boolean {
		const dynamicFeatures = this.context.stateReconciler?.getConfigManager?.().getFeatures?.();
		if (dynamicFeatures && typeof dynamicFeatures.enableDeviceRemoteAccess === 'boolean') {
			return dynamicFeatures.enableDeviceRemoteAccess;
		}

		return this.context.configFeatures?.enableDeviceRemoteAccess ?? true;
	}

	/**
   * Set CloudSync reference for updating endpoints after auto-reload
   * Called from agent.ts after CloudSync creation
   */
	setCloudSync(cloudSync: any): void {
		this.cloudSync = cloudSync;
	}

	// ============================================================================
	// PRIVATE INITIALIZATION METHODS
	// ============================================================================

	private async initJobs(): Promise<void> {
		const { logger, deviceInfo, configSettings, cloudApiEndpoint, configFeatures } = this.context;

		const deviceJobsEnabled = configFeatures?.enableDeviceJobs !== false;
		const deviceApiKey = deviceInfo.apiKey;

		if (!deviceJobsEnabled) {
			logger.infoSync('Jobs Feature skipped by feature toggle', {
				component: LogComponents.agent,
				enableDeviceJobs: deviceJobsEnabled,
			});
			this.features.jobs = undefined;
			return;
		}

		if (!deviceInfo.provisioned || !deviceApiKey) {
			logger.infoSync('Jobs Feature skipped - device not provisioned', {
				component: LogComponents.agent,
				provisioned: deviceInfo.provisioned,
				hasDeviceApiKey: !!deviceApiKey,
			});
			this.features.jobs = undefined;
			return;
		}

		try {
			const pro = await loadJobsFeature();
			if (!pro) {
				logger.debugSync('Jobs Feature skipped — requires Iotistica Pro', {
					component: LogComponents.agent,
				});
				return;
			}

			const cloudApiUrl = process.env.CLOUD_API_URL || cloudApiEndpoint;
			const pollingIntervalMs =
        configSettings.cloudJobsPollingIntervalMs ||
        parseInt(process.env.CLOUD_JOBS_POLLING_INTERVAL || "30000", 10);

			this.features.jobs = new pro.JobsFeature(
				{
					enabled: deviceJobsEnabled,
					cloudApiUrl,
					deviceApiKey,
					pollingIntervalMs,
					maxRetries: 3,
					handlerDirectory: process.env.JOB_HANDLER_DIR || `${process.env.DATA_DIR || '/app/data'}/job-handlers`,
					maxConcurrentJobs: 1,
					defaultHandlerTimeout: 60000,
				},
				logger,
				deviceInfo.uuid,
				this.context.httpClient, // Use shared HTTP client for connection pooling
				{
					mqttClient: this.context.mqttManager,
					notifyTopic: agentTopic(deviceInfo.uuid, 'jobs', 'notify-next'),
					buildUpdateTopic: (jobId: string) => agentTopic(deviceInfo.uuid, 'jobs', jobId, 'update'),
				}
			);

			await this.features.jobs.start();

			logger.debugSync('Jobs Feature initialized', {
				component: LogComponents.agent,
				mode: this.features.jobs.getCurrentMode(),
				mqttActive: this.features.jobs.isMqttActive(),
				httpActive: this.features.jobs.isHttpActive(),
			});
		} catch (error) {
			logger.errorSync('Failed to initialize Jobs Feature', error as Error, {
				component: LogComponents.agent,
				note: 'Continuing without Jobs'
			});
			this.features.jobs = undefined;
		}
	}

	/**
   * Initialize device publish feature (lightweight reload)
   * Reads endpoint configuration from database and starts device Publish
   */
	async initDevicePublish(): Promise<void> {
		const { logger, deviceInfo, anomalyService } = this.context;

		const devicePublishEnabled = this.isDevicePublishEnabled();
		if (!devicePublishEnabled) {
			const wasRunning = !!this.features.devicePublish;
			if (wasRunning) {
				try {
					await this.features.devicePublish!.stop();
				} catch (error) {
					logger.warnSync('Failed to stop Device Publish while disabled by feature toggle', {
						component: LogComponents.agent,
						error: error instanceof Error ? error.message : String(error)
					});
				}
				this.features.devicePublish = undefined;
				setDevicePublish(undefined);
				// Dynamic runtime disable — log at INFO so operators know it was explicitly turned off
				logger.infoSync('Device Publish Feature disabled by feature toggle', {
					component: LogComponents.agent,
					enableDevicePublish: devicePublishEnabled,
				});
			} else {
				// Feature is disabled in local state before cloud sync has delivered the real
				// target state — this fires on every startup and resolves after reconciliation.
				// Log at DEBUG only to avoid misleading the operator.
				logger.debugSync('Device Publish Feature skipped (disabled in current state, pending cloud sync)', {
					component: LogComponents.agent,
					enableDevicePublish: devicePublishEnabled,
				});
			}
			return;
		}


		try {
			// Stop any existing DevicePublish before creating a new one.  This is a
			// defense-in-depth guard: onAdaptersStopping() should already have cleared
			// features.devicePublish, but if two concurrent callers both pass the
			// enabled-check above before either assigns the new instance, the second
			// caller can silently orphan the first instance — creating a zombie MQTT
			// client that fights the new one for the same clientId.
			if (this.features.devicePublish) {
				try {
					await this.features.devicePublish.stop();
				} catch (stopErr) {
					logger.warnSync('Failed to stop previous Device Publish instance before reinit', {
						component: LogComponents.agent,
						error: stopErr instanceof Error ? stopErr.message : String(stopErr),
					});
				}
				this.features.devicePublish = undefined;
				setDevicePublish(undefined);
			}

			// Load device output configurations from database
			const { EndpointOutputModel: DeviceOutputModel } = await import('../db/models/endpoint-outputs.model.js');
			const { EndpointModel: EndpointModel } = await import('../db/models/endpoint.model.js');
      
			const deviceOutputs = await DeviceOutputModel.getAll();

			if (deviceOutputs.length === 0) {
				logger.infoSync('No device outputs configured in database', {
					component: LogComponents.agent,
					note: 'Run migrations to create default endpoint_outputs entries'
				});
				return;
			}

			// Get all enabled protocols
			const allDevices = await EndpointModel.getAll();
			const validDevices = allDevices.filter((s: any) => !!s.uuid);
			const invalidDevices = allDevices.length - validDevices.length;

			if (invalidDevices > 0) {
				logger.warnSync('Ignoring endpoints without UUID during Device Publish initialization', {
					component: LogComponents.agent,
					invalidCount: invalidDevices,
					totalCount: allDevices.length
				});
			}

			const enabledDevices = new Set(
				validDevices.filter((s: any) => s.enabled).map((s: any) => s.protocol)
			);

			if (enabledDevices.size === 0) {
				logger.infoSync('No enabled devices found', {
					component: LogComponents.agent,
					note: 'Enable devices in database before starting Device Publish'
				});
				return;
			}

			// Build device configs only for enabled protocols
			// bufferCapacity is configured per-protocol in endpoint_outputs table:
			// - OPC UA: 1MB (large discovery messages with many nodes)
			// - Modbus: 128KB (standard register responses)
			// - CAN: 64KB (bus messages)
			// - SNMP: 128KB (trap messages)
			const devices = deviceOutputs
				.filter(output => enabledDevices.has(output.protocol))
				.map((output) => ({
					name: `${output.protocol}-pipe`,
					protocol: output.protocol,
					addr: output.socket_path,
					eomDelimiter: output.delimiter || '\n',
					mqttTopic: output.protocol,
					bufferCapacity: output.buffer_capacity || 1024 * 1024,
					bufferSize: 12,
					bufferTimeMs: 60000,
					enabled: true,
					driftOptions: output.drift_options ?? undefined,
				}));

			if (devices.length === 0) {
				logger.infoSync('No pipes to read from', {
					component: LogComponents.agent,
					enabledProtocols: Array.from(enabledDevices)
				});
				return;
			}

			const AdapterConfig = {
				enabled: true,
				endpoints: devices,
			};

			// Read compression flags from environment (configured at agent startup)
			const useMsgpackPoc = process.env.USE_MSGPACK_POC === 'true';
			const useKeyCompactionPoc = process.env.USE_KEY_COMPACTION_POC === 'true';
			const useDeflatePoc = process.env.USE_DEFLATE_COMPRESSION === 'true';

			this.features.devicePublish = new DevicePublish(
        AdapterConfig as any,
        logger,
        deviceInfo.uuid,
        this.context.dictionaryManager,
        useMsgpackPoc,
        useKeyCompactionPoc,
        useDeflatePoc,
        anomalyService,
			);

			if (this.context.liveDataInterceptor) {
				this.features.devicePublish.setLiveDataInterceptor(this.context.liveDataInterceptor);
			}

			await this.features.devicePublish.start();
			setDevicePublish(this.features.devicePublish);

			logger.debugSync('Device Publish Feature initialized', {
				component: LogComponents.agent,
				pipeCount: devices.length,
				enabledProtocols: Array.from(enabledDevices),
				pipes: devices.map(s => s.addr),
				mqttTopicPattern: MQTT_TOPIC_PATTERNS.tenantScopedEndpoints
			});
		} catch (error) {
			logger.errorSync('Failed to initialize Device Publish Feature', error as Error, {
				component: LogComponents.agent,
				note: 'Continuing without Device Publish'
			});
			this.features.devicePublish = undefined;
			setDevicePublish(undefined);
		}
	}

	private async initAgentUpdater(): Promise<void> {
		const { logger, deviceInfo } = this.context;

		if (!deviceInfo.provisioned) {
			logger.debugSync('Agent Updater skipped — device not yet provisioned', {
				component: LogComponents.agent,
			});
			return;
		}

		try {
			this.features.updater = new AgentUpdater({
				deviceUuid: deviceInfo.uuid,
				logger
			});

			await this.features.updater.initialize();

			logger.debugSync('Agent Updater initialized', {
				component: LogComponents.agent
			});
		} catch (error) {
			logger.errorSync('Failed to initialize Agent Updater', error as Error, {
				component: LogComponents.agent,
				note: 'Remote agent updates will not be available'
			});
			this.features.updater = undefined;
		}
	}

	async initShellHandler(): Promise<void> {
		const { logger, deviceInfo, mqttManager } = this.context;

		if (isStandaloneMode() || !deviceInfo.provisioned) {
			logger.debugSync('Shell handler skipped — requires cloud MQTT', {
				component: LogComponents.agent,
			});
			return;
		}

		const deviceRemoteAccessEnabled = this.isDeviceRemoteAccessEnabled();
		if (!deviceRemoteAccessEnabled) {
			if (this.features.shellHandler) {
				try {
					await this.features.shellHandler.cleanup();
				} catch (error) {
					logger.warnSync('Failed to stop Shell Handler while disabled by feature toggle', {
						component: LogComponents.agent,
						error: error instanceof Error ? error.message : String(error)
					});
				}
			}

			this.features.shellHandler = undefined;
			logger.infoSync('Shell handler skipped by feature toggle', {
				component: LogComponents.agent,
				enableDeviceRemoteAccess: deviceRemoteAccessEnabled,
			});
			return;
		}

		try {
			const pro = await loadShellHandlerPro();
			if (!pro) {
				logger.debugSync('Shell handler skipped — requires Iotistica Pro', {
					component: LogComponents.agent,
				});
				return;
			}
			const { ShellHandler } = pro;
			const { agentTopic } = await import('../mqtt/topics.js');

			this.features.shellHandler = new ShellHandler(
				deviceInfo.uuid,
				mqttManager,
				logger,
				{
					commandTopic: agentTopic(deviceInfo.uuid, 'agent', 'shell'),
					outputTopic: agentTopic(deviceInfo.uuid, 'agent', 'shell-output'),
				}
			);

			await this.features.shellHandler.initialize();

			logger.infoSync('Shell handler initialized (remote terminal access enabled)', {
				component: LogComponents.agent
			});
		} catch (error) {
			logger.errorSync('Failed to initialize Shell Handler', error as Error, {
				component: LogComponents.agent,
				note: 'Remote terminal access will not be available'
			});
			this.features.shellHandler = undefined;
		}
	}

	private async initFirewall(): Promise<void> {
		const { logger, configSettings, deviceApiPort } = this.context;

		// Get firewall configuration from config or environment
		const firewallMode =
      configSettings.firewallMode ||
      process.env.FIREWALL_MODE ||
      'auto';

		if (firewallMode === 'disabled') {
			logger.debugSync('Firewall disabled by configuration', {
				component: LogComponents.agent,
			});
			return;
		}
    
		// Check if running as root (required for iptables)
		const hasGetuid = typeof process.getuid === 'function';
    
		if (!hasGetuid) {
			logger.warnSync('Firewall disabled - cannot detect root privileges', {
				component: LogComponents.agent,
				note: 'Firewall requires root privileges to manage iptables',
			});
			return;
		}
    
		const uid = process.getuid!();
		if (uid !== 0) {
			logger.warnSync('Firewall disabled - requires root privileges', {
				component: LogComponents.agent,
				note: 'Run container with --privileged or set FIREWALL_MODE=disabled',
				uid,
			});
			return;
		}

		// Determine MQTT port (if Mosquitto is running locally)
		const mqttPort = process.env.MQTT_LOCAL_PORT 
			? parseInt(process.env.MQTT_LOCAL_PORT) 
			: undefined;

		this.features.firewall = new AgentFirewall(
			{
				enabled: true,
				mode: firewallMode as 'on' | 'off' | 'auto' | 'disabled',
				deviceApiPort,
				mqttPort,
			},
			logger
		);

		await this.features.firewall.initialize();

		logger.debugSync('Firewall initialized', {
			component: LogComponents.agent,
			mode: firewallMode
		});
	}

	/**
   * Cleanup all initialized features
   */
	/**
   * Cleanup all features
   * @param preserveShell - If true, skip shell handler cleanup (for restarts)
   */
	async cleanup(preserveShell: boolean = false): Promise<void> {
		const { logger } = this.context;

		// Stop Device Publish
		if (this.features.devicePublish) {
			await this.features.devicePublish.stop();
			logger.debugSync('Device Publish stopped', {
				component: LogComponents.agent,
			});
		}

		// Stop pipeline (after devicePublish so no in-flight transforms at shutdown)
		if (this.context.pipelineService) {
			await this.context.pipelineService.stop();
			logger.debugSync('Pipeline stopped', {
				component: LogComponents.agent,
			});
		}

		// Stop Protocol Adapters
		const currentDevices = this.adapterInitializer.getFeatures().devices;
		if (currentDevices) {
			await currentDevices.stop();
			logger.debugSync('Protocol Adapters stopped', {
				component: LogComponents.agent,
			});
		}

		// Stop Jobs Feature
		if (this.features.jobs) {
			await this.features.jobs.stop();
			logger.debugSync('Jobs Feature stopped', {
				component: LogComponents.agent,
			});
		}

		// Stop Agent Updater
		if (this.features.updater) {
			// No explicit stop method
			logger.debugSync('Agent Updater cleanup', {
				component: LogComponents.agent,
			});
		}

		// Stop Shell Handler (skip during restart to preserve remote sessions)
		if (this.features.shellHandler && !preserveShell) {
			await this.features.shellHandler.cleanup();
			logger.debugSync('Shell Handler stopped', {
				component: LogComponents.agent,
			});
		} else if (preserveShell) {
			logger.debugSync('Shell Handler preserved (restart mode)', {
				component: LogComponents.agent,
			});
		}

		// Stop Firewall
		if (this.features.firewall) {
			// Firewall has no explicit cleanup method
			logger.debugSync('Firewall cleanup', {
				component: LogComponents.agent,
			});
		}
	}
}

// ============================================================================
// BOOTSTRAP PHASE HELPERS
// ============================================================================

export async function initFeatures(ctx: AgentInitContext): Promise<void> {
	const agentLogger = ctx.agentLogger!;

	const targetState = ctx.stateReconciler!.getTargetState();

	const featureContext: FeatureContext = {
		logger: agentLogger,
		deviceInfo: ctx.agentInfo!,
		deviceManager: ctx.agentManager!,
		stateReconciler: ctx.stateReconciler!,
		mqttManager: (await import('../mqtt/manager.js')).CloudMqttClient.getInstance(),
		httpClient: ctx.sharedHttpClient,
		containerManager: ctx.containerManager!,
		configSettings: targetState?.config?.settings || {},
		configFeatures: ctx.configManager!.getFeatures(),
		configProtocols: targetState?.config?.protocols || {},
		cloudApiEndpoint: ctx.configManager!.getCloudApiEndpoint(),
		deviceApiPort: ctx.configManager!.getAgentApiPort(),
		anomalyService: ctx.anomalyService,
		dictionaryManager: ctx.dictionaryManager,
		pipelineService: ctx.pipelineService,
	};

	const initializer = new FeatureInitializer(featureContext);
	ctx.featureInitializer = initializer;

	await initDiscoveryService(ctx);
	featureContext.discoveryService = ctx.discoveryService;

	initBackupScheduler(ctx);

	await initializer.initDeviceFeatures();
	await initializer.initJobsFeature();

	// Anomaly detection must be initialized before simulation so producer-mode scenarios can feed the shared pipeline.
	const { initAnomalyDetection, configureAnomalyFeed } = await import('./anomaly.js');
	await initAnomalyDetection(ctx);
	await configureAnomalyFeed(ctx);

	const { initSimulationMode } = await import('./simulation.js');
	await initSimulationMode(ctx);

	await initializer.initSupportingFeatures();

	const initializedFeatures = initializer.getFeatures();
	agentLogger?.infoSync('Feature initialization complete', {
		component: LogComponents.agent,
		jobs: !!initializedFeatures.jobs,
		devices: !!initializedFeatures.devices,
		devicePublish: !!initializedFeatures.devicePublish,
		updater: !!initializedFeatures.updater,
		firewall: !!initializedFeatures.firewall,
		discovery: !!ctx.discoveryService,
	});

	ctx.updater = initializedFeatures.updater;
	ctx.firewall = initializedFeatures.firewall;

	if (initializedFeatures.updater) {
		ctx.stateReconciler?.setAgentUpdater(initializedFeatures.updater);
	} else {
		agentLogger?.warnSync('AgentUpdater not initialized, version reconciliation unavailable', {
			component: LogComponents.agent
		});
	}
}

export function initBackupScheduler(ctx: AgentInitContext): void {
	try {
		const scheduler = new BackupScheduler(ctx.agentLogger);
		scheduler.start();
		ctx.backupScheduler = scheduler;
	} catch (error) {
		ctx.agentLogger?.warnSync('Failed to start backup scheduler (non-fatal)', {
			component: LogComponents.agent,
			error: (error as Error).message,
		});
	}
}

export async function initDiscoveryService(ctx: AgentInitContext): Promise<void> {

	try {
		ctx.discoveryService = new DiscoveryService(ctx.agentLogger, ctx.configManager);
		await ctx.discoveryService.init();

		ctx.discoveryRulesScheduler = new DiscoveryRulesScheduler(ctx.discoveryService, ctx.agentLogger);
		ctx.discoveryRulesScheduler.start();
		setDiscoveryRulesScheduler(ctx.discoveryRulesScheduler);
	} catch (error) {
		ctx.agentLogger?.errorSync('Failed to initialize Discovery Service', error as Error, {
			component: LogComponents.agent,
		});
		ctx.discoveryService = undefined;
		ctx.discoveryRulesScheduler = undefined;
		setDiscoveryRulesScheduler(undefined);
	}
}


