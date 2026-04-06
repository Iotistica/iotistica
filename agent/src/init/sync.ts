import type { AgentInitContext } from './context.js';
import * as deviceActions from '../api/actions.js';
import { LogComponents } from '../logging/types.js';
import { CloudMqttClient } from '../mqtt/manager.js';
import { CloudSync } from '../managers/cloud-sync.js';
import { initAnomalyDetection } from './ai.js';

export async function initSync(ctx: AgentInitContext): Promise<void> {
	await initDeviceSync(ctx);
	// Skip if already initialized during features phase.
	if (!ctx.anomalyService) {
		await initAnomalyDetection(ctx);
	}

	deviceActions.initialize(
		ctx.containerManager,
		ctx.deviceManager,
		ctx.cloudSync,
		ctx.agentLogger,
		ctx.anomalyService,
		ctx.simulationOrchestrator
	);

	deviceActions.setAgent(ctx.agent);
	deviceActions.setDiscoveryService(ctx.discoveryService);

	ctx.configManager?.setReactiveHandlers({
		containerManager: ctx.containerManager,
		cloudSync: ctx.cloudSync,
		discoveryService: ctx.discoveryService,
	});
}

export async function initDeviceSync(ctx: AgentInitContext): Promise<void> {
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

	if (!ctx.deviceInfo?.provisioned || !ctx.deviceInfo?.deviceApiKey) {
		ctx.agentLogger?.warnSync('Device not provisioned - cloud sync disabled', {
			component: LogComponents.agent,
			note: 'Device must be provisioned with valid API key before enabling cloud features',
			provisioned: ctx.deviceInfo?.provisioned,
			hasApiKey: !!ctx.deviceInfo?.deviceApiKey,
		});
		return;
	}

	const intervals = ctx.configManager!.getIntervalConfig();
	const features = ctx.featureInitializer?.getFeatures() || {};

	ctx.cloudSync = new CloudSync(
		ctx.stateReconciler,
		ctx.deviceManager,
		{
			cloudApiEndpoint,
			pollInterval: intervals.targetStatePollIntervalMs!,
			reportInterval: intervals.deviceReportIntervalMs!,
			metricsInterval: intervals.metricsIntervalMs!,
		},
		ctx.agentLogger,
		undefined,
		features.sensors,
		CloudMqttClient.getInstance(),
		ctx.sharedHttpClient,
		ctx.updater
	);

	ctx.featureInitializer?.setCloudSync(ctx.cloudSync);
	await ctx.cloudSync.startPoll();

	// Root-cause fix for delayed cloud log flushes: when CloudSync confirms the cloud API
	// is online again, immediately nudge the CloudLogBackend to flush buffered logs.
	const cloudLogBackend = ctx.agentLogger?.getBackends?.().find((backend: any) =>
		backend && typeof backend.triggerFlush === 'function'
	) as { triggerFlush: (reason?: string) => void } | undefined;

	if (cloudLogBackend) {
		ctx.cloudSync.on('online', () => {
			cloudLogBackend.triggerFlush('cloudsync-online');
		});
	}

	ctx.agentLogger?.infoSync('Cloud sync initialized', {
		component: LogComponents.agent,
	});
}
