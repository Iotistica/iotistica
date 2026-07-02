import type { AgentInitContext } from './context.js';
import * as deviceActions from '../api/actions.js';
import { LogComponents } from '../logging/types.js';
import { CloudMqttClient } from '../mqtt/manager.js';
import { CloudSync } from '../sync/index.js';
import { initAnomalyDetection, configureAnomalyFeed } from './anomaly.js';
import { isStandaloneMode } from '../utils/env.js';

export async function initSync(ctx: AgentInitContext): Promise<void> {
	await initAgentSync(ctx);
	// Skip if already initialized during features phase.
	if (!ctx.anomalyService) {
		await initAnomalyDetection(ctx);
	}
	await configureAnomalyFeed(ctx);

	deviceActions.initialize(
		ctx.containerManager!,
		ctx.agentManager!,
		ctx.cloudSync,
		ctx.agentLogger,
		ctx.anomalyService,
		ctx.simulationOrchestrator
	);

	deviceActions.setAgent(ctx.agent);
	deviceActions.setDiscoveryService(ctx.discoveryService);
	deviceActions.setUpdater(ctx.updater);
	deviceActions.setConfigManager(ctx.configManager);
	deviceActions.setStateManager(ctx.stateReconciler);

	ctx.configManager?.setReactiveHandlers({
		containerManager: ctx.containerManager,
		cloudSync: ctx.cloudSync,
		discoveryService: ctx.discoveryService,
	});
}

export async function initAgentSync(ctx: AgentInitContext): Promise<void> {
	if (isStandaloneMode()) {
		ctx.agentLogger?.infoSync('Standalone mode — cloud sync disabled', {
			component: LogComponents.agent,
		});
		return;
	}

	const cloudApiEndpoint = ctx.configManager!.getCloudApiEndpoint();

	if (!cloudApiEndpoint) {
		ctx.agentLogger?.warnSync(
			'Cloud API endpoint not configured - running in standalone mode',
			{
				component: LogComponents.agent,
				note: 'Set IOTISTICA_API env var to enable cloud features',
			}
		);
		return;
	}

	if (!ctx.agentInfo?.provisioned || !ctx.agentInfo?.apiKey) {
		ctx.agentLogger?.warnSync('Device not provisioned - cloud sync disabled', {
			component: LogComponents.agent,
			note: 'Device must be provisioned with valid API key before enabling cloud features',
			provisioned: ctx.agentInfo?.provisioned,
			hasApiKey: !!ctx.agentInfo?.apiKey,
		});
		return;
	}

	const intervals = ctx.configManager!.getIntervalConfig();
	const features = ctx.featureInitializer?.getFeatures() || {};

	ctx.cloudSync = new CloudSync(
		ctx.stateReconciler!,
		ctx.agentManager!,
		{
			cloudApiEndpoint,
			pollInterval: intervals.targetStatePollIntervalMs!,
			reportInterval: intervals.reportIntervalMs!,
			metricsInterval: intervals.metricsIntervalMs!,
		},
		ctx.agentLogger,
		undefined,
		features.devices,
		CloudMqttClient.getInstance(),
		ctx.sharedHttpClient,
		ctx.updater
	);

	ctx.featureInitializer?.setCloudSync(ctx.cloudSync);

	const targetSyncEnabled = ctx.agentInfo?.targetSyncEnabled !== false;
	if (targetSyncEnabled) {
		await ctx.cloudSync!.startPoll();
	} else {
		await ctx.cloudSync!.startReportOnly();
	}

	// Root-cause fix for delayed cloud log flushes: when CloudSync confirms the cloud API
	// is online again, immediately nudge the CloudLogBackend to flush buffered logs.
	const cloudLogBackend = ctx.agentLogger?.getBackends?.().find((backend: any) =>
		backend && typeof backend.triggerFlush === 'function'
	) as { triggerFlush: (reason?: string) => void } | undefined;

	if (cloudLogBackend) {
		ctx.cloudSync!.on('online', () => {
			cloudLogBackend.triggerFlush('cloudsync-online');
		});
	}

	ctx.agentLogger?.infoSync('Cloud sync initialized', {
		component: LogComponents.agent,
	});
}
