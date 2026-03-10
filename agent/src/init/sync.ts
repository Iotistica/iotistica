import type { AgentInitContext } from './core.js';
import * as deviceActions from '../api/actions.js';
import { LogComponents } from '../logging/types.js';
import { MqttManager } from '../mqtt/manager.js';
import { CloudSync } from '../device-manager/sync.js';

export async function initSync(ctx: AgentInitContext): Promise<void> {
	await initDeviceSync(ctx.self);
	await ctx.sync.initAnomalyDetection();

	deviceActions.initialize(
		ctx.sync.getContainerManager(),
		ctx.sync.getDeviceManager(),
		ctx.sync.getCloudSync(),
		ctx.sync.getAgentLogger(),
		ctx.sync.getAnomalyService(),
		ctx.sync.getSimulationOrchestrator()
	);

	ctx.sync.setAgent(ctx.self);
	deviceActions.setDiscoveryService(ctx.sync.getDiscoveryService());

	ctx.sync.setReactiveHandlers({
		containerManager: ctx.sync.getContainerManager(),
		cloudSync: ctx.sync.getCloudSync(),
		discoveryService: ctx.sync.getDiscoveryService(),
	});
}

export async function initDeviceSync(agent: any): Promise<void> {
	const cloudApiEndpoint = agent.configManager.getCloudApiEndpoint();

	if (!cloudApiEndpoint) {
		agent.agentLogger?.warnSync(
			'Cloud API endpoint not configured - running in standalone mode',
			{
				component: LogComponents.agent,
				note: 'Set CLOUD_API_ENDPOINT env var to enable cloud features',
			}
		);
		return;
	}

	if (!agent.deviceInfo.provisioned || !agent.deviceInfo.deviceApiKey) {
		agent.agentLogger?.warnSync('Device not provisioned - cloud sync disabled', {
			component: LogComponents.agent,
			note: 'Device must be provisioned with valid API key before enabling cloud features',
			provisioned: agent.deviceInfo.provisioned,
			hasApiKey: !!agent.deviceInfo.deviceApiKey,
		});
		return;
	}

	const intervals = agent.configManager.getIntervalConfig();
	const features = agent.featureInitializer?.getFeatures() || {};

	agent.cloudSync = new CloudSync(
		agent.stateReconciler,
		agent.deviceManager,
		{
			cloudApiEndpoint,
			pollInterval: intervals.targetStatePollIntervalMs!,
			reportInterval: intervals.deviceReportIntervalMs!,
			metricsInterval: intervals.metricsIntervalMs!,
		},
		agent.agentLogger,
		undefined,
		features.sensors,
		MqttManager.getInstance(),
		agent.sharedHttpClient,
		agent.updater
	);

	agent.featureInitializer?.setCloudSync(agent.cloudSync);
	await agent.cloudSync.startPoll();
}
