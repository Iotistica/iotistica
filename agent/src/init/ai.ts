import { LogComponents } from '../logging/types.js';
import { loadConfigFromTargetState } from '../anomaly/utils.js';
import { MqttManager } from '../mqtt/manager.js';
import type { AgentInitContext } from './context.js';

export async function initAnomalyDetection(ctx: AgentInitContext): Promise<void> {
	const targetConfig = ctx.stateReconciler.getTargetState()?.config;
	const targetConfigFeatures = targetConfig?.features;
	const managerFeatures = ctx.configManager!.getFeatures();
	const features = {
		...managerFeatures,
		enableAnomalyDetection: targetConfigFeatures?.enableAnomalyDetection ?? managerFeatures.enableAnomalyDetection,
		enableDeviceSensorPublish: targetConfigFeatures?.enableDeviceSensorPublish ?? managerFeatures.enableDeviceSensorPublish,
		enableSensorPublish: targetConfigFeatures?.enableDeviceSensorPublish ?? targetConfigFeatures?.enableSensorPublish ?? managerFeatures.enableSensorPublish,
		enableDeviceJobs: targetConfigFeatures?.enableDeviceJobs ?? managerFeatures.enableDeviceJobs,
		enableDeviceRemoteAccess: targetConfigFeatures?.enableDeviceRemoteAccess ?? managerFeatures.enableDeviceRemoteAccess,
	};

	ctx.agentLogger?.debugSync('Checking anomaly detection configuration', {
		component: LogComponents.agent,
		enableAnomalyDetection: features.enableAnomalyDetection,
		targetConfigFeatures,
		managerFeatures
	});

	// SIMULATION_MODE is an env var known at process start — no network round-trip needed.
	// If simulation is requested, anomaly detection must run regardless of the cloud feature
	// flag, which may be unavailable during the features phase (before the first cloud poll).
	const simulationForceEnabled = process.env.SIMULATION_MODE === 'true';

	if (!features.enableAnomalyDetection) {
		if (simulationForceEnabled) {
			ctx.agentLogger?.warnSync('Anomaly Detection force-enabled for simulation mode', {
				component: LogComponents.agent,
				note: 'SIMULATION_MODE=true requires anomaly detection regardless of cloud config',
			});
		} else {
			ctx.agentLogger?.infoSync('Anomaly Detection disabled by configuration', {
				component: LogComponents.agent,
				features
			});
			return;
		}
	}

	if (ctx.anomalyService) {
		ctx.agentLogger?.debugSync('Cleaning up existing Anomaly Detection Service before reinitializing', {
			component: LogComponents.agent,
		});
		ctx.anomalyService.stop();
		ctx.anomalyService = undefined;
	}

	try {
		const config = loadConfigFromTargetState(targetConfig);
		const enabledMetrics = config.metrics.filter((metric) => metric.enabled);

		const { getKnex } = await import('../db/connection.js');
		const dbInstance = getKnex();

		ctx.agentLogger?.debugSync('Anomaly metrics configured (single list)', {
			component: LogComponents.agent,
			totalMetrics: config.metrics.length,
			enabledMetrics: enabledMetrics.length,
			sampleMetrics: config.metrics.slice(0, 10).map((metric) => metric.name),
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

		await configureAnomalyFeed(ctx);

		ctx.agentLogger?.infoSync('Anomaly detection initialized', {
			component: LogComponents.agent,
			enabledMetrics: enabledMetrics.length,
			sampleMetrics: enabledMetrics.slice(0, 5).map((metric) => metric.name),
			defaults: config.defaults,
			systemMetricsEnabled: true,
			endpointFeedEnabled: true,
		});
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

	ctx.agentLogger?.debugSync('Configuring edge anomaly detection', {
		component: LogComponents.agent,
	});

	const { configureAnomalyFeed: configureSystemMetrics, getSystemMetrics } = await import('../system/metrics.js');
	configureSystemMetrics(ctx.anomalyService);

	ctx.featureInitializer?.setAnomalyService?.(ctx.anomalyService);
	ctx.featureInitializer?.getFeatures()?.sensorPublish?.setAnomalyService?.(ctx.anomalyService);

	ctx.agentLogger?.debugSync('Anomaly detection configured for system metrics and endpoints', {
		component: LogComponents.agent,
	});

	ctx.agentLogger?.debugSync('Collecting initial metrics for anomaly detection', {
		component: LogComponents.agent,
	});
	await getSystemMetrics();
}
