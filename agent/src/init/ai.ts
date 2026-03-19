import { LogComponents } from '../logging/types.js';
import { loadConfigFromTargetState } from '../anomaly/utils.js';
import { MqttManager } from '../mqtt/manager.js';
import type { AgentInitContext } from './context.js';

export async function initAnomalyDetection(ctx: AgentInitContext): Promise<void> {
	const features = ctx.configManager!.getFeatures();

	ctx.agentLogger?.debugSync('Checking anomaly detection configuration', {
		component: LogComponents.agent,
		enableAnomalyDetection: features.enableAnomalyDetection,
		targetConfigFeatures: ctx.configManager!.getTargetConfig().features
	});

	if (!features.enableAnomalyDetection) {
		ctx.agentLogger?.infoSync('Anomaly Detection disabled by configuration', {
			component: LogComponents.agent,
			features
		});
		return;
	}

	if (ctx.anomalyService) {
		ctx.agentLogger?.infoSync('Cleaning up existing Anomaly Detection Service before reinitializing', {
			component: LogComponents.agent,
		});
		ctx.anomalyService.stop();
		ctx.anomalyService = undefined;
	}

	ctx.agentLogger?.infoSync('Initializing Anomaly Detection Service', {
		component: LogComponents.agent,
	});

	try {
		const targetStateConfig = ctx.stateReconciler.getTargetState()?.config;
		const config = loadConfigFromTargetState(targetStateConfig);

		const { getKnex } = await import('../db/connection.js');
		const dbInstance = getKnex();

		ctx.agentLogger?.infoSync('Anomaly metrics configured (single list)', {
			component: LogComponents.agent,
			totalMetrics: config.metrics.length,
			enabledMetrics: config.metrics.filter((m: any) => m.enabled).length,
			sampleMetrics: config.metrics.slice(0, 10).map((m: any) => m.name),
			defaults: config.defaults,
		});

		const { AnomalyDetectionService } = await import('../anomaly/index.js');
		ctx.anomalyService = new AnomalyDetectionService(
			config,
			dbInstance,
			ctx.agentLogger,
			MqttManager.getInstance(),
			ctx.deviceInfo.uuid,
			ctx.deviceInfo.deviceName,
			'system'
		);

		ctx.agentLogger?.infoSync('Anomaly detection initialized with inheritance support', {
			component: LogComponents.agent,
			enabledMetrics: config.metrics.filter((m: any) => m.enabled).length,
		});

		await configureAnomalyFeed(ctx);
	} catch (error) {
		ctx.agentLogger?.errorSync(
			'Failed to initialize Anomaly Detection Service',
			error as Error,
			{ component: LogComponents.agent }
		);
		ctx.anomalyService = undefined;
	}
}

export async function configureAnomalyFeed(ctx: AgentInitContext): Promise<void> {
	if (!ctx.anomalyService) return;

	ctx.agentLogger?.infoSync('Configuring edge anomaly detection', {
		component: LogComponents.agent,
	});

	const { configureAnomalyFeed: configureSystemMetrics, getSystemMetrics } = await import('../system/metrics.js');
	configureSystemMetrics(ctx.anomalyService);

	ctx.featureInitializer?.getFeatures()?.sensorPublish?.setAnomalyService?.(ctx.anomalyService);

	ctx.agentLogger?.infoSync('Anomaly detection configured for system metrics and endpoints', {
		component: LogComponents.agent,
	});

	ctx.agentLogger?.debugSync('Collecting initial metrics for anomaly detection', {
		component: LogComponents.agent,
	});
	await getSystemMetrics();
}
