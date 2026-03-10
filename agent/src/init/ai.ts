import { LogComponents } from '../logging/types.js';
import { loadConfigFromTargetState } from '../ai/anomaly/utils.js';
import { MqttManager } from '../mqtt/manager.js';

export async function initAnomalyDetection(agent: any): Promise<void> {
	const features = agent.configManager.getFeatures();

	agent.agentLogger?.debugSync('Checking anomaly detection configuration', {
		component: LogComponents.agent,
		enableAnomalyDetection: features.enableAnomalyDetection,
		targetConfigFeatures: agent.configManager.getTargetConfig().features
	});

	if (!features.enableAnomalyDetection) {
		agent.agentLogger?.infoSync('Anomaly Detection disabled by configuration', {
			component: LogComponents.agent,
			features
		});
		return;
	}

	if (agent.anomalyService) {
		agent.agentLogger?.infoSync('Cleaning up existing Anomaly Detection Service before reinitializing', {
			component: LogComponents.agent,
		});
		agent.anomalyService.stop();
		agent.anomalyService = undefined;
	}

	agent.agentLogger?.infoSync('Initializing Anomaly Detection Service', {
		component: LogComponents.agent,
	});

	try {
		const targetStateConfig = agent.stateReconciler.getTargetState()?.config;
		const config = loadConfigFromTargetState(targetStateConfig);

		const { getKnex } = await import('../db/connection.js');
		const dbInstance = getKnex();

		const systemMetrics = config.systemMetrics || [];
		const endpointMetrics = buildDeviceMetrics(agent, targetStateConfig, config.defaults);
		config.metrics = [...systemMetrics, ...endpointMetrics];

		agent.agentLogger?.infoSync('Anomaly metrics configured (two-level inheritance)', {
			component: LogComponents.agent,
			systemMetrics: systemMetrics.length,
			endpointMetrics: endpointMetrics.length,
			totalMetrics: config.metrics.length,
			defaults: config.defaults,
		});

		const { AnomalyDetectionService } = await import('../ai/anomaly/index.js');
		agent.anomalyService = new AnomalyDetectionService(
			config,
			dbInstance,
			agent.agentLogger,
			MqttManager.getInstance(),
			agent.deviceInfo.uuid,
			agent.deviceInfo.deviceName,
			'system'
		);

		agent.agentLogger?.infoSync('Anomaly detection initialized with inheritance support', {
			component: LogComponents.agent,
			enabledMetrics: config.metrics.filter((m: any) => m.enabled).length,
		});

		await configureAnomalyFeed(agent);
	} catch (error) {
		agent.agentLogger?.errorSync(
			'Failed to initialize Anomaly Detection Service',
			error as Error,
			{ component: LogComponents.agent }
		);
		agent.anomalyService = undefined;
	}
}

export function buildDeviceMetrics(agent: any, targetStateConfig: any, defaults: any): any[] {
	const metrics: any[] = [];
	const endpoints = targetStateConfig?.endpoints || [];

	for (const endpoint of endpoints) {
		if (!endpoint.enabled || !endpoint.dataPoints) continue;

		for (const dp of endpoint.dataPoints) {
			const anomalyConfig = dp.anomalyDetection;
			if (!anomalyConfig?.enabled) continue;

			const metricName = `${agent.deviceInfo.uuid}_${endpoint.name}_${dp.name}`;
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

export async function configureAnomalyFeed(agent: any): Promise<void> {
	if (!agent.anomalyService) return;

	agent.agentLogger?.infoSync('Configuring edge anomaly detection', {
		component: LogComponents.agent,
	});

	const { configureAnomalyFeed: configureSystemMetrics, getSystemMetrics } = await import('../system/metrics.js');
	configureSystemMetrics(agent.anomalyService);

	const { configureAnomalyFeed: configureSensorAnomaly } = await import('../features/publish/manager.js');
	configureSensorAnomaly(agent.anomalyService);

	agent.agentLogger?.infoSync('Anomaly detection configured for system metrics and endpoints', {
		component: LogComponents.agent,
	});

	agent.agentLogger?.debugSync('Collecting initial metrics for anomaly detection', {
		component: LogComponents.agent,
	});
	await getSystemMetrics();
}
