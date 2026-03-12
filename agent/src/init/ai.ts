import { LogComponents } from '../logging/types.js';
import { loadConfigFromTargetState } from '../ai/anomaly/utils.js';
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

		const systemMetrics = config.systemMetrics || [];
		const endpointMetrics = buildDeviceMetrics(ctx, targetStateConfig, config.defaults);
		config.metrics = [...systemMetrics, ...endpointMetrics];

		ctx.agentLogger?.infoSync('Anomaly metrics configured (two-level inheritance)', {
			component: LogComponents.agent,
			systemMetrics: systemMetrics.length,
			endpointMetrics: endpointMetrics.length,
			totalMetrics: config.metrics.length,
			defaults: config.defaults,
		});

		const { AnomalyDetectionService } = await import('../ai/anomaly/index.js');
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

export function buildDeviceMetrics(ctx: AgentInitContext, targetStateConfig: any, defaults: any): any[] {
	const metrics: any[] = [];
	const endpoints = targetStateConfig?.endpoints || [];

	for (const endpoint of endpoints) {
		if (!endpoint.enabled || !endpoint.dataPoints) continue;

		for (const dp of endpoint.dataPoints) {
			const anomalyConfig = dp.anomalyDetection;
			if (!anomalyConfig?.enabled) continue;

			const metricName = `${ctx.deviceInfo.uuid}_${endpoint.name}_${dp.name}`;
			const metric: any = {
				name: metricName,
				enabled: true,
				methods: anomalyConfig.methods || defaults?.methods || ['mad'],
				threshold: anomalyConfig.threshold ?? defaults?.threshold ?? 3.0,
				windowSize: anomalyConfig.windowSize ?? defaults?.windowSize ?? 120,
				minConfidence: anomalyConfig.minConfidence ?? 0.7,
			};

			if (anomalyConfig.expectedRange) {
				const range = anomalyConfig.expectedRange;
				if (range.min !== undefined && range.max !== undefined) {
					metric.expectedRange = [range.min, range.max];
				}
			}

			metrics.push(metric);
		}
	}

	return metrics;
}

export async function configureAnomalyFeed(ctx: AgentInitContext): Promise<void> {
	if (!ctx.anomalyService) return;

	ctx.agentLogger?.infoSync('Configuring edge anomaly detection', {
		component: LogComponents.agent,
	});

	const { configureAnomalyFeed: configureSystemMetrics, getSystemMetrics } = await import('../system/metrics.js');
	configureSystemMetrics(ctx.anomalyService);

	const { configureAnomalyFeed: configureSensorAnomaly } = await import('../features/publish/manager.js');
	configureSensorAnomaly(ctx.anomalyService);

	ctx.agentLogger?.infoSync('Anomaly detection configured for system metrics and endpoints', {
		component: LogComponents.agent,
	});

	ctx.agentLogger?.debugSync('Collecting initial metrics for anomaly detection', {
		component: LogComponents.agent,
	});
	await getSystemMetrics();
}
