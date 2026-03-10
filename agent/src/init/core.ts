import { initDatabase } from './database.js';
import type { DeviceState } from '../managers/reconciler.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import type { FeatureInitializer } from './features.js';
import type { DiscoveryService } from '../features/discovery/discovery-service.js';
import type { AgentUpdater } from '../updater.js';
import type { AgentFirewall } from '../network/firewall.js';
import type { ConfigManager } from '../managers/config.js';
import { LogComponents } from '../logging/types.js';

export interface AgentInitContext {
	self: any;
	core: {
		initDatabase: () => Promise<void>;
		initializeStateReconciler: () => Promise<void>;
		setupConfigEventListeners: () => void;
	};
	logging: {
		getLoggingConfig: () => ReturnType<ConfigManager['getLoggingConfig']>;
		setAgentLogger: (logger: AgentLogger) => void;
		setStateReconcilerLogger: (logger: AgentLogger) => void;
	};
	device: {
		getCloudApiEndpoint: () => string;
		setSharedHttpClient: (httpClient: ReturnType<typeof import('../lib/http-client.js').createHttpClient>) => void;
		initializeDeviceManager: () => Promise<void>;
		initializeVpnReconnection: () => Promise<void>;
		initializeCloudLogging: () => Promise<void>;
	};
	runtime: {
		initializeMqttManager: () => Promise<void>;
		initContainerManager: () => Promise<void>;
		initDeviceAPI: () => Promise<void>;
	};
	features: {
		getAgentLogger: () => AgentLogger;
		getStateReconciler: () => any;
		getTargetState: () => DeviceState;
		getConfigManagerFeatures: () => ReturnType<ConfigManager['getFeatures']>;
		getDeviceInfo: () => any;
		getDeviceManager: () => any;
		getContainerManager: () => any;
		getSharedHttpClient: () => any;
		getCloudApiEndpoint: () => string;
		getDeviceApiPort: () => number;
		getAnomalyService: () => any;
		getDictionaryManager: () => any;
		setFeatureInitializer: (initializer: FeatureInitializer) => void;
		getFeatureInitializer: () => FeatureInitializer | undefined;
		initDiscoveryService: () => Promise<void>;
		getDiscoveryService: () => DiscoveryService | undefined;
		initializeSimulationMode: () => Promise<void>;
		setUpdater: (updater: AgentUpdater | undefined) => void;
		setFirewall: (firewall: AgentFirewall | undefined) => void;
		setStateReconcilerUpdater: (updater: AgentUpdater) => void;
	};
	sync: {
		initDeviceSync: () => Promise<void>;
		initAnomalyDetection: () => Promise<void>;
		getContainerManager: () => any;
		getDeviceManager: () => any;
		getCloudSync: () => any;
		getAgentLogger: () => AgentLogger;
		getAnomalyService: () => any;
		getSimulationOrchestrator: () => any;
		getDiscoveryService: () => any;
		setAgent: (agent: any) => void;
		setReactiveHandlers: (args: {
			containerManager: any;
			cloudSync: any;
			discoveryService: any;
		}) => void;
	};
	services: {
		start: () => Promise<void> | void;
		logStartupSummary: () => void;
	};
}

export async function initCore(ctx: AgentInitContext): Promise<void> {
	await initDatabase(ctx);
	await initializeStateReconciler(ctx.self);
	setupConfigEventListeners(ctx.self);
}

export async function initializeStateReconciler(agent: any): Promise<void> {
	const { StateReconciler } = await import('../managers/reconciler.js');
	agent.stateReconciler = new StateReconciler();
	await agent.stateReconciler.init();
	agent.configManager = agent.stateReconciler.getConfigManager();
}

export function setupConfigEventListeners(agent: any): void {
	agent.stateReconciler.on('features-changed', async (change: { old: any; new: any }) => {
		const logger = agent.agentLogger;
		logger?.infoSync('Features configuration changed', {
			component: LogComponents.agent,
			changes: Object.keys(change.new).filter(key => change.old[key] !== change.new[key])
		});

		if (change.old.enableAnomalyDetection !== change.new.enableAnomalyDetection) {
			if (change.new.enableAnomalyDetection && !agent.anomalyService) {
				logger?.infoSync('Starting Anomaly Detection Service (dynamically enabled)', {
					component: LogComponents.agent
				});
				await agent.initAnomalyDetection();
			} else if (!change.new.enableAnomalyDetection && agent.anomalyService) {
				logger?.infoSync('Stopping Anomaly Detection Service (dynamically disabled)', {
					component: LogComponents.agent
				});
				agent.anomalyService.stop();
				agent.anomalyService = undefined;
			}
		}
	});

	agent.stateReconciler.on('anomaly-config-changed', (change: { old: any; new: any }) => {
		const logger = agent.agentLogger;
		logger?.infoSync('Anomaly configuration changed from cloud', {
			component: LogComponents.agent
		});

		if (agent.anomalyService && change.new) {
			logger?.infoSync('Reloading anomaly detection configuration', {
				component: LogComponents.agent,
				metricsCount: change.new.metrics?.filter((m: any) => m.enabled).length
			});
			agent.anomalyService.updateConfig(change.new);
		}
	});

	agent.configManager.on('restart-discovery-timers', () => {
		agent.discoveryService?.startPeriodicDiscovery();
	});

	agent.configManager.on('schedule-restart', ({ restartTimeMs, restartConfig }: any) => {
		const logger = agent.agentLogger;
		agent.scheduledRestartTimer = setTimeout(async () => {
			logger?.infoSync('Initiating scheduled restart', {
				component: LogComponents.agent,
				trigger: 'scheduled_timer',
				reason: restartConfig.reason || 'heap_fragmentation_cleanup',
				memoryUsage: process.memoryUsage(),
				timestamp: new Date().toISOString()
			});

			try {
				await agent.stop();
				logger?.infoSync('Graceful shutdown complete, exiting for restart', {
					component: LogComponents.agent,
					exitCode: 0
				});
				process.exit(0);
			} catch (error) {
				logger?.errorSync(
					'Error during scheduled restart shutdown',
					error instanceof Error ? error : new Error(String(error)),
					{ component: LogComponents.agent, action: 'forcing_exit' }
				);
				process.exit(1);
			}
		}, restartTimeMs);

		agent.scheduledRestartTimer.unref();
	});
}
