import { LogComponents } from '../logging/types.js';
import { DatabaseModel } from '../db/models/index.js';
import { loadAnomalyDetection } from '../pro/loader.js';
import { CloudMqttClient } from '../mqtt/manager.js';
import { agentTopic } from '../mqtt/topics.js';
import { PublishDestinationsModel } from '../db/models/publish-destinations.model.js';
import { createExternalMqttClientFromDestination } from '../publish/plugins/mqtt.js';
import { IncidentCorrelator } from '../anomaly/incident-correlator.js';
import type { AnomalyEventPayload } from '../db/models/anomaly-event.model.js';
import type { AgentInitContext } from './context.js';

export async function initAnomalyDetection(ctx: AgentInitContext): Promise<void> {
	const targetConfig = ctx.stateReconciler!.getTargetState()?.config;
	const targetConfigFeatures = targetConfig?.features;
	const managerFeatures = ctx.configManager!.getFeatures();
	const features = {
		...managerFeatures,
		enableAnomalyDetection: targetConfigFeatures?.enableAnomalyDetection ?? managerFeatures.enableAnomalyDetection,
		enableDevicePublish: targetConfigFeatures?.enableDevicePublish ?? managerFeatures.enableDevicePublish,
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

	const detectionEnabled = features.enableAnomalyDetection || simulationForceEnabled;

	if (simulationForceEnabled && !features.enableAnomalyDetection) {
		ctx.agentLogger?.warnSync('Anomaly Detection force-enabled for simulation mode', {
			component: LogComponents.agent,
			note: 'SIMULATION_MODE=true requires anomaly detection regardless of cloud config',
		});
	}

	if (ctx.anomalyService) {
		ctx.agentLogger?.debugSync('Cleaning up existing Anomaly Detection Service before reinitializing', {
			component: LogComponents.agent,
		});
		ctx.anomalyService.stop();
		ctx.anomalyService = undefined;
	}

	// Start the edge incident correlator (runs regardless of Pro license).
	if (!ctx.correlator) {
		ctx.correlator = new IncidentCorrelator();
		ctx.correlator.start();
	}

	try {
		const pro = await loadAnomalyDetection();
		if (!pro) {
			ctx.agentLogger?.debugSync('Anomaly detection skipped — requires Iotistica Pro', {
				component: LogComponents.agent,
			});
			return;
		}

		const config = pro.loadConfigFromTargetState(targetConfig);
		const enabledMetrics = config.metrics.filter((metric: any) => metric.enabled);

		const dbInstance = DatabaseModel.getConnection();

		ctx.agentLogger?.debugSync('Anomaly metrics configured (single list)', {
			component: LogComponents.agent,
			totalMetrics: config.metrics.length,
			enabledMetrics: enabledMetrics.length,
			sampleMetrics: config.metrics.slice(0, 10).map((metric: any) => metric.name),
			defaults: config.defaults,
		});

		const { AnomalyDetectionService } = pro;
		const correlator = ctx.correlator;
		ctx.anomalyService = new AnomalyDetectionService(
			config,
			dbInstance,
			ctx.agentLogger,
			CloudMqttClient.getInstance(),
			ctx.agentInfo!.uuid,
			ctx.agentInfo!.name ?? 'device',
			'system',
			{
				buildTopic: (deviceUuid: string, ...segments: string[]) =>
					agentTopic(deviceUuid, ...segments),
				getAlertDestination: (id: number) =>
					PublishDestinationsModel.getById(id) ?? null,
				createAlertMqttClient: (config: Record<string, unknown> | null | undefined, deviceId?: string, name?: string, logger?: any) =>
					createExternalMqttClientFromDestination(config, deviceId, name, logger),
				onAnomalyDetected: (event: any) =>
					correlator?.processEvent({
						metric:            event.metric,
						fingerprint:       event.fingerprint,
						timestamp_ms:      event.timestampMs,
						observed_value:    event.observedValue,
						anomaly_score:     event.anomalyScore,
						confidence:        event.confidence,
						severity:          event.severity,
						severity_reason:   event.severityReason,
						consecutive_count: event.consecutiveCount,
						triggered_by:      event.triggeredBy,
						baseline:          event.baseline,
						expected_range:    event.expectedRange,
						deviation:         event.deviation,
						device_name:       event.deviceName,
						device_type:       event.deviceType,
						device_uuid:       event.agentUuid,
					} satisfies AnomalyEventPayload),
			}
		);

		// Keep the service in catalog-only mode when detection is disabled.
		// It still observes every metric that flows through for the admin UI picker.
		if (!detectionEnabled) {
			ctx.anomalyService!.setEnabled(false);
		}

		ctx.agentLogger?.infoSync('Anomaly detection initialized', {
			component: LogComponents.agent,
			detectionEnabled,
			enabledMetrics: enabledMetrics.length,
			sampleMetrics: enabledMetrics.slice(0, 5).map((metric: any) => metric.name),
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
	ctx.featureInitializer?.getFeatures()?.devicePublish?.setAnomalyService?.(ctx.anomalyService);

	ctx.agentLogger?.debugSync('Anomaly detection configured for system metrics and endpoints', {
		component: LogComponents.agent,
	});

	ctx.agentLogger?.debugSync('Collecting initial metrics for anomaly detection', {
		component: LogComponents.agent,
	});
	await getSystemMetrics();
}
