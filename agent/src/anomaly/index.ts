/**
 * ANOMALY DETECTION SERVICE - MAIN ORCHESTRATOR
 * ===============================================
 * 
 * Edge-appropriate anomaly detection for device data and system metrics
 */

import type Database from 'better-sqlite3';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { CloudMqttClient } from '../mqtt/manager';
import { createJsonPayload } from '../mqtt/manager';
import { agentTopic } from '../mqtt/topics.js';
import { ExternalMqttClient, createExternalMqttClientFromDestination } from '../publish/plugins/mqtt.js';
import { PublishDestinationsModel } from '../db/models/publish-destinations.model.js';
import type {
	DataPoint,
	AnomalyConfig,
	AnomalyAlert,
	CompositeBaseline,
	DetectorBaseline,
	MetricConfig,
	StatisticalBuffer,
	DetectionMethod,
	AnomalySeverity,
	Protocol,
	CanonicalDeviceState,
	BaselineInfo,
	AnomalyEvent,
} from './types';
import { createBuffer, addValue, getMedian } from './buffer';
import { AlertManager } from './alerts';
import { LINEAR_PREDICTOR_LOOKBACK, LinearPredictor, MIN_TIME_TO_THRESHOLD_CONFIDENCE, recordForecastResult, shouldPublishForecast, shouldRunForecast } from './forecaster';
import type { ForecastCadenceConfig, ForecastCadenceState, Prediction } from './forecaster';
import { AnomalyStorageService, type AnomalyBaselineRecord } from './storage';
import { getTimeSlot, getMinimumSamplesForSeasonalBaseline } from './seasonality';
import { runDetectionMethods } from './detection-runner';
import {
	calculateConfidence,
	createAnomalyAlert,
	generateSeverityReason,
} from './alert-factory';
import {
	getMetricConfig as selectMetricConfig,
	resolveDeviceState as resolveDataPointDeviceState,
	resolveDeviceId as resolveDataPointDeviceId,
	resolveEventDeviceType as resolveDataPointEventDeviceType,
	getBufferKey as buildBufferKey,
	parseBufferKey as decodeBufferKey,
} from './metric-router';

function mapDbBaselineToDetectorBaseline(
	baseline: AnomalyBaselineRecord,
): DetectorBaseline {
	const domainBaseline: CompositeBaseline = {
		kind: 'composite',
		sampleCount: baseline.sample_count,
	};

	if (baseline.mean !== null) {
		domainBaseline.mean = baseline.mean;
	}

	if (baseline.std_dev !== null) {
		domainBaseline.stdDev = baseline.std_dev;
	}

	if (baseline.median !== null) {
		domainBaseline.median = baseline.median;
	}

	if (baseline.mad !== null) {
		domainBaseline.mad = baseline.mad;
	}

	return domainBaseline;
}

export class AnomalyDetectionService {
	private config: AnomalyConfig;
	private buffers = new Map<string, StatisticalBuffer>();
	private alertManager: AlertManager;
	private logger?: AgentLogger;
	private mqttManager?: CloudMqttClient;
	private alertMqttClient?: ExternalMqttClient;
	private alertDestinationId?: number;
	private deviceUuid?: string;
	private deviceName?: string;     // Monitored device name (e.g., 'COMAP-Main-Controller')
	private deviceType?: Protocol; // Default protocol (overridden by dataPoint.protocol per metric)
	private enabled: boolean = false;
	private predictor: LinearPredictor;
	private predictionCadence: ForecastCadenceConfig;
	private predictionCadenceState = new Map<string, ForecastCadenceState>();
	private storage?: AnomalyStorageService;
	private baselineSaveTimer?: NodeJS.Timeout;
	private baselineSaveIntervalMs: number = 300000; // 5 minutes
	// Cache of latest anomaly scores for each metric (0.0-1.0 range)
	private anomalyScores = new Map<string, number>();
	// Cache of anomaly metadata for ML training and debugging
	private anomalyMetadata = new Map<string, {
		threshold: number;
		methods: string[];
		samples: number;
	}>();
	// Profile tracking: Map metric prefix to profile (e.g., 'modbus_slave_1' → 'Generic')
	private metricProfiles = new Map<string, string>();
	// Throttle repetitive logs for metrics that are fed but not configured.
	private unconfiguredMetricLogCounts = new Map<string, number>();
	// Startup timestamp for warm-up period (prevents false positives on new agents)
	private startupTimestamp: number = Date.now();
	private warmupPeriodMs: number;
	// Raw db reference used for the metric catalog (independent of anomaly storage)
	private db?: Database.Database;
	// Catalog of every metric name ever observed by this agent, keyed by metric name.
	// Persisted to observed_metrics table; survives restarts.
	private observedMetrics = new Map<string, {
		name: string;
		source: string;
		protocol?: string;
		unit?: string;
		lastSeenAt: number;
		pendingCount: number; // in-memory tally since last DB flush
	}>();

	constructor(config: AnomalyConfig, db?: Database.Database, logger?: AgentLogger, mqttManager?: CloudMqttClient, deviceUuid?: string, deviceName?: string, deviceType?: Protocol) {
		this.config = config;
		this.logger = logger;
		this.mqttManager = mqttManager;
		this.deviceUuid = deviceUuid;
		this.deviceName = deviceName || 'Agent System'; // Default to 'Agent System' for system metrics
		this.deviceType = deviceType || 'system';  // Default device type
		this.enabled = true; // Controlled by features.enableAnomalyDetection
		
		// Set warm-up period from config (default: 15 minutes if not specified)
		this.warmupPeriodMs = config.warmupPeriodMs ?? 15 * 60 * 1000;
		
		this.alertManager = new AlertManager(
			config.alerts.maxQueueSize,
			config.alerts.cooldownMs
		);
		
		this.predictor = new LinearPredictor();
		this.predictionCadence = {
			minIntervalMs: 60000,
			minSamples: 15,
			minTrendChange: 0.1,
			minConfidenceDelta: 0.1,
			minPredictionDelta: 0.05,
			...(config.predictions?.cadence || {})
		};
		
		// Initialize storage if database provided (use default 30 days if not configured)
		if (db) {
			this.db = db;

			const retention = config.storage?.retention || 30;
			this.storage = new AnomalyStorageService(
				db,
				retention,
				logger
			);

			// Initialize storage and check for existing baselines
			this.storage.initialize()
				.then(() => this.checkAndSkipWarmupIfBaselinesExist())
				.catch(error => {
					this.logger?.errorSync('Failed to initialize anomaly storage', error as Error, {
						component: LogComponents.anomaly,
					});
					this.storage = undefined; // Disable storage on error
				});

			// Load metric catalog independently — the table may exist even if anomaly
			// storage init fails, and we want the catalog regardless.
			this.loadObservedMetricsFromDb().catch(() => { /* non-fatal — first run */ });

			// Start periodic baseline saving (also flushes the metric catalog)
			this.startPeriodicBaselineSave();
		}
		
		// Connect alert MQTT destination if configured
		if (config.alerts.alertDestinationId) {
			this.initAlertMqttClient(config.alerts.alertDestinationId).catch((err: unknown) => {
				this.logger?.errorSync('Failed to init alert MQTT client', err as Error, {
					component: LogComponents.anomaly,
				});
			});
		}

		// Buffers are created lazily when data is first received (more efficient)
		// This ensures metricsTracked reflects only actively monitored metrics

		this.logger?.debugSync('Anomaly detection service initialized', {
			component: LogComponents.anomaly,
			metricsConfigured: config.metrics.filter(m => m.enabled).length,
			methods: this.getUniqueDetectionMethods(),
			storageEnabled: !!this.storage,
			configuredMetrics: config.metrics.filter(m => m.enabled).map(m => m.name),
		});
	}
	
	/**
	* Process a new data point
	*/
	processDataPoint(dataPoint: DataPoint): void {
		this.recordMetricObservation(dataPoint);

		if (!this.enabled) return;
		if (!this.isMetricConfigured(dataPoint.metric)) return;

		const normalizedState = this.resolveDeviceState(dataPoint);
		const normalizedDeviceId = this.resolveDeviceId(dataPoint);
		dataPoint.deviceState = normalizedState;
		dataPoint.deviceId = normalizedDeviceId;
		
		// Skip BAD quality data
		if (dataPoint.quality === 'BAD') {
			this.logger?.debugSync('Skipping BAD quality data point', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
			});
			return;
		}
		
		if (dataPoint.simulationMeta?.simulatedAnomaly) {
			this.logger?.infoSync('Simulation data point received', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				value: dataPoint.value,
				pattern: dataPoint.simulationMeta.pattern,
			});
		}

		const metricConfig = this.getMetricConfig(dataPoint.metric);
		if (!metricConfig?.enabled) {
			const missingCount = (this.unconfiguredMetricLogCounts.get(dataPoint.metric) || 0) + 1;
			this.unconfiguredMetricLogCounts.set(dataPoint.metric, missingCount);

			if (missingCount <= 3 || missingCount % 50 === 0) {
				const sampleConfiguredMetrics = this.config.metrics
					.filter(m => m.enabled)
					.slice(0, 12)
					.map(m => m.name);

				this.logger?.debugSync('Ignoring datapoint - metric not configured', {
					component: LogComponents.anomaly,
					metric: dataPoint.metric,
					source: dataPoint.source,
					quality: dataPoint.quality,
					seenCount: missingCount,
					totalConfiguredMetrics: this.config.metrics.filter(m => m.enabled).length,
					sampleConfiguredMetrics,
				});
			}

			return; // Metric not configured for anomaly detection
		}
		
		// LOG: Entry point - new data point received
		this.logger?.debugSync('Processing data point', {
			component: LogComponents.anomaly,
			metric: dataPoint.metric,
			value: dataPoint.value,
			quality: dataPoint.quality,
			configuredMethods: metricConfig.methods.join(','),
			expectedRange: metricConfig.expectedRange,
		});
		
		// Get or create buffer
		const bufferKey = this.getBufferKey(dataPoint.metric, normalizedState, normalizedDeviceId);
		let buffer = this.buffers.get(bufferKey);
		if (!buffer) {
			buffer = createBuffer(metricConfig.windowSize);
			this.buffers.set(bufferKey, buffer);
			this.logger?.infoSync('Created new buffer', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				deviceState: normalizedState,
				windowSize: metricConfig.windowSize,
			});
		}
		
		addValue(buffer, dataPoint.value, dataPoint.timestamp);
		
		// Run detection if buffer has enough samples (async, updates cache)
		if (buffer.size >= 10) {
			if (!dataPoint.simulationMeta?.simulatedAnomaly) {
				this.logger?.debugSync('Buffer sufficient for detection', {
					component: LogComponents.anomaly,
					metric: dataPoint.metric,
					deviceState: normalizedState,
					bufferSize: buffer.size,
					mean: isNaN(buffer.mean) ? 'NaN' : buffer.mean.toFixed(3),
					stdDev: isNaN(buffer.stdDev) ? 'NaN' : buffer.stdDev.toFixed(3),
				});
			}
			this.runDetection(dataPoint, buffer, metricConfig);
		} else {
			// Buffer still building, cache zero score for this metric
			this.logger?.debugSync('Buffer building', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				deviceState: normalizedState,
				bufferSize: buffer.size,
				required: 10,
			});
			this.anomalyScores.set(bufferKey, 0.0);
			// Cache metadata even while building buffer
			this.anomalyMetadata.set(bufferKey, {
				threshold: metricConfig.minConfidence || this.config.alerts.minConfidence || 0.7,
				methods: metricConfig.methods,
				samples: buffer.size
			});
		}
	}
	
	/**
	* Get the latest anomaly score for a metric
	* Returns undefined if metric has never been scored
	* Returns 0.0 if metric is normal or buffer is still building
	* Returns 0.0-1.0 based on maximum confidence from all detectors
	*/
	getAnomalyScore(metricName: string): number | undefined {
		if (this.anomalyScores.has(metricName)) {
			return this.anomalyScores.get(metricName);
		}

		let maxScore: number | undefined;
		for (const [bufferKey, score] of this.anomalyScores.entries()) {
			if (this.parseBufferKey(bufferKey).metricName !== metricName) {
				continue;
			}
			if (maxScore === undefined || score > maxScore) {
				maxScore = score;
			}
		}

		return maxScore;
	}
	
	/**
	* Get anomaly metadata for a metric (threshold, methods, sample count)
	* Used for ML training and debugging
	*/
	getAnomalyMetadata(metricName: string): { threshold: number; methods: string[]; samples: number } | undefined {
		if (this.anomalyMetadata.has(metricName)) {
			return this.anomalyMetadata.get(metricName);
		}

		let latest: { threshold: number; methods: string[]; samples: number } | undefined;
		for (const [bufferKey, metadata] of this.anomalyMetadata.entries()) {
			if (this.parseBufferKey(bufferKey).metricName === metricName) {
				latest = metadata;
			}
		}

		return latest;
	}

	/**
	* Get predictions for all tracked metrics
	* Returns forecast data including trend, predictedNext, confidence, and timeToThreshold
	*/
	getPredictions(): Record<string, Prediction> | undefined {
		return this.generatePredictions();
	}
	
	/**
	* Run all configured detection methods on a data point
	*/
	private async runDetection(
		dataPoint: DataPoint,
		buffer: StatisticalBuffer,
		metricConfig: MetricConfig
	): Promise<void> {
		const results: AnomalyAlert[] = [];
		let maxConfidence = 0.0; // Track max confidence across all detectors
		
		// WARM-UP PERIOD: Suppress alerts for first 15 minutes after agent startup
		// Prevents false positives from:
		// - Initial data collection noise
		// - Simulator/test environment static data
		// - Insufficient baseline samples
		const agentUptimeMs = Date.now() - this.startupTimestamp;
		if (agentUptimeMs < this.warmupPeriodMs) {
			const remainingMinutes = Math.ceil((this.warmupPeriodMs - agentUptimeMs) / 60000);
			this.logger?.debugSync(`Anomaly detection in warm-up mode (${remainingMinutes} min remaining)`, {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				uptimeMs: agentUptimeMs,
				warmupMs: this.warmupPeriodMs,
			});
			// Still update buffers and calculate scores for learning, just don't alert
			const warmupKey = this.getBufferKey(
				dataPoint.metric,
				this.resolveDeviceState(dataPoint),
				this.resolveDeviceId(dataPoint)
			);
			this.anomalyScores.set(warmupKey, 0.0);
			return;
		}
		
		// Get time slot for seasonal baseline lookup
		const seasonalityPattern = metricConfig.seasonality || 'none';
		const timeSlot = getTimeSlot(dataPoint.timestamp, seasonalityPattern);
		const minimumSamples = getMinimumSamplesForSeasonalBaseline(seasonalityPattern);
		
		// Load latest baseline from database if available (with seasonality support)
		// CRITICAL: Pass null profile to avoid filtering - we removed profile dependency
		// This means baselines are shared across all scenarios (intentional since profile is metadata)
		// If you need scenario isolation, clear anomaly_baselines table when changing scenarios
		let dbBaseline: AnomalyBaselineRecord | null = null;
		const deviceState = this.resolveDeviceState(dataPoint);
		const deviceId = this.resolveDeviceId(dataPoint);
		if (this.storage) {
			try {
				dbBaseline = await this.storage.getLatestBaseline(
					dataPoint.metric,
					timeSlot,
					minimumSamples,
					null, // Profile filter disabled - baselines shared across scenarios
					deviceState,
					deviceId
				);
				if (dbBaseline) {
					this.logger?.debugSync('Loaded baseline from database', {
						component: LogComponents.anomaly,
						metric: dataPoint.metric,
						deviceState,
						timeSlot,
						seasonalityPattern,
						mean: dbBaseline.mean?.toFixed(3),
						stdDev: dbBaseline.std_dev?.toFixed(3),
						sampleCount: dbBaseline.sample_count,
					});
				}
			} catch (_error) {
				this.logger?.debugSync('Failed to load baseline from database, using buffer stats', {
					component: LogComponents.anomaly,
					metric: dataPoint.metric,
					deviceState,
					timeSlot,
					seasonalityPattern,
				});
			}
		}

		// Validate baseline before using it for detection.
		// Protects against stale data, state mismatches, metric identity drift, and insufficient samples.
		if (dbBaseline && !this.isBaselineValid(dbBaseline, dataPoint, metricConfig, timeSlot, minimumSamples)) {
			this.logger?.debugSync('Baseline failed validation -- falling back to buffer stats', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				deviceState,
				timeSlot,
			});
			dbBaseline = null;
		}

		const detectorBaseline = dbBaseline ? mapDbBaselineToDetectorBaseline(dbBaseline) : undefined;
		
		const minConfidence = metricConfig.minConfidence || this.config.alerts.minConfidence || 0.7;
		const detectionResult = runDetectionMethods({
			metric: dataPoint.metric,
			value: dataPoint.value,
			buffer,
			metricConfig,
			detectorBaseline,
			minConfidence,
			logger: this.logger,
			createAlert: (method, baselineSource, confidence, deviation, expectedRange, message) =>
				createAnomalyAlert(dataPoint, buffer, metricConfig, {
					method,
					isAnomaly: true,
					baselineSource,
					confidence,
					deviation,
					expectedRange,
					message,
				}, deviceState),
		});

		const methodsToRun = detectionResult.methodsToRun;
		maxConfidence = detectionResult.maxConfidence;
		results.push(...detectionResult.alerts);
		
		// Cache the anomaly score for this metric (0.0-1.0 range)
		this.anomalyScores.set(this.getBufferKey(dataPoint.metric, deviceState, deviceId), maxConfidence);
		
		this.logger?.debugSync('Detection complete', {
			component: LogComponents.anomaly,
			metric: dataPoint.metric,
			maxConfidence: maxConfidence?.toFixed(3) ?? '0.000',
			alertsCreated: results.length,
			methodsRun: methodsToRun.join(','),
		});
		
		// Cache metadata for ML training and debugging
		this.anomalyMetadata.set(this.getBufferKey(dataPoint.metric, deviceState, deviceId), {
			threshold: metricConfig.minConfidence || this.config.alerts.minConfidence || 0.7,
			methods: methodsToRun,
			samples: buffer.size
		});
		
		// Add alerts to manager first (calculates fingerprints)
		for (const alert of results) {
			this.alertManager.addAlert(alert);
			
			// Store alert to database
			if (this.storage) {
				this.storage.storeAlert(alert).catch(error => {
					this.logger?.errorSync('Failed to store alert to database', error as Error, {
						component: LogComponents.anomaly,
					});
				});
			}
			
			this.logger?.warnSync('Anomaly detected', {
				component: LogComponents.anomaly,
				metric: alert.metric,
				deviceState: alert.deviceState || 'unknown',
				value: alert.value,
				method: alert.detectionMethod,
				severity: alert.severity,
				confidence: alert.confidence,
				deviation: alert.deviation,
			});
		}
		
		// Emit single canonical anomaly event (MQTT-friendly) after fingerprints calculated
		if (results.length > 0) {
			this.emitAnomalyEvent(dataPoint, results, maxConfidence, metricConfig, buffer);
		}
	}
	
	/**
	* Emit single canonical anomaly event (MQTT-friendly)
	*/
	private emitAnomalyEvent(
		dataPoint: DataPoint,
		alerts: AnomalyAlert[],
		anomalyScore: number,
		metricConfig: MetricConfig,
		buffer: StatisticalBuffer
	): void {
		// Find highest-confidence alert for expected range and deviation
		const primaryAlert = alerts.reduce((max, alert) => 
			alert.confidence > max.confidence ? alert : max
		);
		
		// Determine which detectors triggered
		const triggeredBy = alerts.map(a => a.detectionMethod);
		
		// Get fingerprint from alert manager (already calculated)
		const fingerprint = primaryAlert.fingerprint || '';
		
		// Check if suppressed (within cooldown)
		const lastAlertTime = this.alertManager['lastAlertTime']?.get(fingerprint);
		const cooldownMs = metricConfig.cooldownMs || 300000;
		const suppressed = lastAlertTime 
			? (Date.now() - lastAlertTime) < cooldownMs
			: false;
		
		// Calculate window boundaries from buffer
		// Buffer timestamps are in circular order, so we need to find min/max
		const windowTimestamps = buffer.timestamps.slice(0, buffer.size);
		const windowStartMs = buffer.size > 0 ? Math.min(...windowTimestamps) : dataPoint.timestamp;
		const windowEndMs = buffer.size > 0 ? Math.max(...windowTimestamps) : dataPoint.timestamp;
		
		// Build baseline info for explainability
		const baseline: BaselineInfo = {
			median: getMedian(buffer),
			mean: buffer.mean,
			stdDev: buffer.stdDev,
			sampleCount: buffer.size,
			method: primaryAlert.detectionMethod,
			source: (primaryAlert as any).baselineSource || 'buffer', // From detection result if available
		};
		
		// Generate severity reason for auditability
		const severityReason = generateSeverityReason(
			anomalyScore,
			primaryAlert.deviation,
			primaryAlert.severity
		);
		
		// Calculate confidence (post-fusion certainty adjusted for baseline quality)
		const confidence = calculateConfidence(anomalyScore, baseline);
		
		// Determine device type: Prefer protocol from data point, fall back to constructor value
		// This allows per-metric protocol specification (modbus, opcua, system, etc.)
		const deviceType = this.resolveEventDeviceType(dataPoint);
		const deviceState = this.resolveDeviceState(dataPoint);
		
		const event: AnomalyEvent = {
			agentUuid: this.deviceUuid || 'unknown', // Infrastructure tracking (edge gateway)
			deviceName: this.deviceName || 'Agent System', // Monitored device name (what users care about)
			deviceType, // Protocol/source type (modbus, opcua, bacnet, mqtt, system)
			deviceState,
			metric: dataPoint.metric,
			timestampMs: dataPoint.timestamp,
			windowStartMs,
			windowEndMs,
			observedValue: dataPoint.value,
			baseline,
			anomalyScore,
			confidence,
			severity: primaryAlert.severity,
			severityReason,
			triggeredBy,
			suppressed,
			expectedRange: primaryAlert.expectedRange,
			deviation: primaryAlert.deviation,
			fingerprint,
			cooldownSec: Math.floor(cooldownMs / 1000),
			firstSeen: primaryAlert.firstSeen,
			consecutiveCount: primaryAlert.consecutiveCount,
			eventCount: primaryAlert.count,
		};
		
		// Log canonical event
		this.logger?.warnSync('Anomaly event', {
			component: LogComponents.anomaly,
			deviceName: event.deviceName,
			deviceType: event.deviceType,
			deviceState: event.deviceState,
			metric: event.metric,
			anomalyScore: event.anomalyScore?.toFixed(3) ?? '0.000',
			severity: event.severity,
			triggeredBy: event.triggeredBy.join('+'),
			suppressed: event.suppressed,
		});
		
		// Publish to MQTT destination (alerts.mqtt toggle + alertDestinationId)
		if (this.config.alerts.mqtt && this.alertMqttClient?.isConnected()) {
			const alertTopic = this.config.alerts.alertTopic || 'iotistica/alerts/anomaly';
			const alertPayload = Buffer.from(JSON.stringify(event));
			this.alertMqttClient.publish(alertTopic, alertPayload, { qos: 1, destinationTopic: alertTopic })
				.then(() => {
					this.logger?.infoSync('Published anomaly event to MQTT destination', {
						component: LogComponents.anomaly,
						metric: event.metric,
						topic: alertTopic,
						destinationId: this.alertDestinationId,
					});
				})
				.catch((error: unknown) => {
					this.logger?.errorSync('Failed to publish anomaly event to MQTT destination', error as Error, {
						component: LogComponents.anomaly,
						metric: event.metric,
						topic: alertTopic,
					});
				});
		}

		// Publish to cloud MQTT (alerts.cloud toggle)
		if (this.config.alerts.cloud && this.mqttManager?.isConnected() && this.deviceUuid) {
			const topic = agentTopic(this.deviceUuid, 'events', 'anomaly');
			const msgIdGen = this.mqttManager.getMessageIdGenerator();
			const payload = createJsonPayload(event, msgIdGen);
			this.mqttManager.publish(topic, payload, { qos: 1, retain: false })
				.then(() => {
					this.logger?.infoSync('Published anomaly event to cloud MQTT', {
						component: LogComponents.anomaly,
						metric: event.metric,
						topic,
					});
				})
				.catch((error: unknown) => {
					this.logger?.errorSync('Failed to publish anomaly event to cloud MQTT', error as Error, {
						component: LogComponents.anomaly,
						metric: event.metric,
						topic,
					});
				});
		}
	}
	
	/**
	* Get metric configuration by name.
	*
	* Matching priority:
	*  1. Exact match on `m.name` (handles system metrics like "cpu_usage" and
	*     legacy pre-qualified names like "endpointUuid_level").
	*  2. Device-scoped match: a config entry with both `name` and `deviceName` set
	*     matches an incoming metric whose name is `"${deviceName}_${name}"`.
	*     e.g., { name: "level", deviceName: "Zone A-abc12345" } matches "Zone A-abc12345_level".
	*  3. Canonical metric fallback: strip the runtime prefixes from endpoint/system
	*     metric keys and retry with the bare metric name so env/default configs like
	*     "temperature" still apply to canonical keys.
	*/
	private getMetricConfig(metricName: string): MetricConfig | undefined {
		return selectMetricConfig(this.config.metrics, metricName);
	}
	
	/**
	* Get effective config for a metric by merging defaults with overrides
	* Used for per-datapoint anomaly detection with inheritance
	* 
	* @param metricName - Metric identifier (e.g., "device_uuid_endpoint_datapoint")
	* @param override - Per-datapoint anomaly config (optional, can be partial)
	* @returns Effective MetricConfig with all fields populated
	*/
	public getEffectiveConfig(
		metricName: string,
		override?: Partial<{
			enabled: boolean;
			methods: DetectionMethod[];
			threshold: number;
			expectedRange: [number, number];
			windowSize: number;
			minConfidence: number;
		}>
	): MetricConfig {
		const defaults = this.config.defaults || {
			methods: ['mad'] as DetectionMethod[],
			threshold: 3.0,
			windowSize: 120,
			minSamples: 5
		};
		
		// Build effective config by merging defaults with overrides
		const effectiveConfig: MetricConfig = {
			name: metricName,
			enabled: override?.enabled !== undefined ? override.enabled : true,
			methods: override?.methods || defaults.methods,
			threshold: override?.threshold ?? defaults.threshold,
			windowSize: override?.windowSize ?? defaults.windowSize,
			expectedRange: override?.expectedRange,
			minConfidence: override?.minConfidence ?? 0.7,
		};
		
		return effectiveConfig;
	}
	
	/** Returns true when at least one metric is enabled for anomaly detection. */
	hasConfiguredMetrics(): boolean {
		return this.enabled && this.config.metrics.some(m => m.enabled);
	}

	/** Returns the current agent/device UUID used for canonical metric keys. */
	getDeviceUuid(): string | undefined {
		return this.deviceUuid;
	}

	getPreferredBufferContext(metricName: string): { deviceId: string; deviceState: CanonicalDeviceState } | undefined {
		let preferred:
			| { deviceId: string; deviceState: CanonicalDeviceState; sampleCount: number }
			| undefined;

		for (const [bufferKey, buffer] of this.buffers.entries()) {
			const parsed = this.parseBufferKey(bufferKey);
			if (parsed.metricName !== metricName) {
				continue;
			}

			if (!preferred || buffer.size > preferred.sampleCount) {
				preferred = {
					deviceId: parsed.deviceId,
					deviceState: parsed.deviceState,
					sampleCount: buffer.size,
				};
			}
		}

		if (!preferred) {
			return undefined;
		}

		return {
			deviceId: preferred.deviceId,
			deviceState: preferred.deviceState,
		};
	}

	/** Returns true when the given canonical metric key is configured and enabled. */
	isMetricConfigured(metricName: string): boolean {
		const cfg = this.getMetricConfig(metricName);
		return !!(cfg?.enabled);
	}

	/**
	* Get all unique detection methods across metrics
	*/
	private getUniqueDetectionMethods(): DetectionMethod[] {
		const methods = new Set<DetectionMethod>();
		for (const metric of this.config.metrics) {
			if (metric.enabled) {
				metric.methods.forEach(m => methods.add(m));
			}
		}
		return Array.from(methods);
	}
	
	/**
	* Get all alerts
	*/
	getAlerts(since?: number): AnomalyAlert[] {
		return this.alertManager.getAlerts(since);
	}
	
	/**
	* Get alerts by severity
	*/
	getAlertsBySeverity(severity: AnomalySeverity): AnomalyAlert[] {
		return this.alertManager.getAlertsBySeverity(severity);
	}
	
	/**
	* Get alerts by metric
	*/
	getAlertsByMetric(metric: string): AnomalyAlert[] {
		return this.alertManager.getAlertsByMetric(metric);
	}
	
	/**
	* Clear all alerts
	*/
	clearAlerts(): void {
		this.alertManager.clearAlerts();
	}
	
	/**
	* Get all currently tracked metrics with their live anomaly scores.
	* Uses the internal parseBufferKey so callers don't need to know the key format.
	*/
	getTrackedMetrics(): Array<{ metricName: string; deviceState: CanonicalDeviceState; deviceId: string; score: number }> {
		const results: Array<{ metricName: string; deviceState: CanonicalDeviceState; deviceId: string; score: number }> = [];
		for (const [bufferKey, score] of this.anomalyScores.entries()) {
			const parsed = this.parseBufferKey(bufferKey);
			results.push({ ...parsed, score });
		}
		return results;
	}

	/**
	* Record a data point in the local metric catalog.
	* Called for EVERY data point — before any anomaly filtering — so the catalog
	* reflects all metrics flowing through the agent, not just configured ones.
	*/
	private recordMetricObservation(dataPoint: DataPoint): void {
		if (!dataPoint.metric?.trim()) return;
		const existing = this.observedMetrics.get(dataPoint.metric);
		if (existing) {
			existing.lastSeenAt = dataPoint.timestamp;
			existing.pendingCount++;
			if (!existing.protocol && dataPoint.protocol) existing.protocol = dataPoint.protocol;
			if (!existing.unit && dataPoint.unit) existing.unit = dataPoint.unit;
		} else {
			this.observedMetrics.set(dataPoint.metric, {
				name: dataPoint.metric,
				source: dataPoint.source,
				protocol: dataPoint.protocol,
				unit: dataPoint.unit || undefined,
				lastSeenAt: dataPoint.timestamp,
				pendingCount: 1,
			});
		}
	}

	/**
	* Load the metric catalog from SQLite on startup.
	*/
	private async loadObservedMetricsFromDb(): Promise<void> {
		if (!this.db) return;
		try {
			const rows = this.db.prepare(
				`SELECT name, source, protocol, unit, last_seen_at
				   FROM observed_metrics
				  ORDER BY last_seen_at DESC
				  LIMIT 5000`,
			).all() as Array<{ name: string; source: string; protocol: string | null; unit: string | null; last_seen_at: number }>;

			for (const row of rows) {
				// Only seed if not already observed since startup
				if (!this.observedMetrics.has(row.name)) {
					this.observedMetrics.set(row.name, {
						name: row.name,
						source: row.source,
						protocol: row.protocol ?? undefined,
						unit: row.unit ?? undefined,
						lastSeenAt: row.last_seen_at,
						pendingCount: 0,
					});
				}
			}
			this.logger?.debugSync('Loaded metric catalog from DB', {
				component: LogComponents.anomaly,
				count: rows.length,
			});
		} catch {
			// Table may not exist yet on first run before migration
		}
	}

	/**
	* Flush in-memory metric catalog observations to SQLite.
	* Runs on the same 5-minute cycle as baseline saves.
	*/
	private async saveObservedMetrics(): Promise<void> {
		if (!this.db || this.observedMetrics.size === 0) return;
		try {
			const upsert = this.db.prepare(`
				INSERT INTO observed_metrics (name, source, protocol, unit, last_seen_at, observation_count, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET
					last_seen_at      = MAX(last_seen_at, excluded.last_seen_at),
					observation_count = observation_count + excluded.observation_count,
					protocol          = COALESCE(protocol, excluded.protocol),
					unit              = COALESCE(unit, excluded.unit)
			`);
			const flush = this.db.transaction(() => {
				for (const entry of this.observedMetrics.values()) {
					if (entry.pendingCount === 0) continue; // nothing new since last flush
					upsert.run(
						entry.name,
						entry.source,
						entry.protocol ?? null,
						entry.unit ?? null,
						entry.lastSeenAt,
						entry.pendingCount,
						entry.lastSeenAt,
					);
					entry.pendingCount = 0; // reset after persisting
				}
			});
			flush();
		} catch (err) {
			this.logger?.debugSync('Failed to flush metric catalog', {
				component: LogComponents.anomaly,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	/**
	* Return all metrics ever observed by this agent (loaded from SQLite on startup,
	* updated in-memory as data flows through).
	* Used by the admin UI metric picker and GET /v1/anomaly/metrics.
	*/
	getObservedMetrics(): Array<{
		name: string;
		source: string;
		protocol?: string;
		unit?: string;
		lastSeenAt: number;
	}> {
		return Array.from(this.observedMetrics.values()).map(({ pendingCount: _, ...rest }) => rest);
	}

	/**
	* Get current configuration
	*/
	getConfig(): AnomalyConfig {
		return this.config;
	}

	/**
	* Get all tracked anomaly scores keyed by buffer key (metric::state::deviceId)
	*/
	getAllAnomalyScores(): Record<string, number> {
		const result: Record<string, number> = {};
		for (const [key, score] of this.anomalyScores.entries()) {
			result[key] = score;
		}
		return result;
	}

	/**
	* Get service statistics
	*/
	getStats() {
		const uniqueMetrics = new Set(
			Array.from(this.buffers.keys()).map(k => this.parseBufferKey(k).metricName)
		);
		return {
			enabled: this.enabled,
			metricsTracked: uniqueMetrics.size,
			stateBucketsTracked: this.buffers.size,
			alertQueueSize: this.alertManager.getQueueSize(),
			criticalAlerts: this.alertManager.getAlertsBySeverity('critical').length,
			warningAlerts: this.alertManager.getAlertsBySeverity('warning').length,
			infoAlerts: this.alertManager.getAlertsBySeverity('info').length,
		};
	}
	
	/**
	* Get summary for cloud reporting (lightweight)
	* Includes recent alerts, statistics, and predictions
	*/
	getSummaryForReport(maxRecentAlerts: number = 10) {
		if (!this.enabled) {
			return undefined;
		}
		
		const allAlerts = this.alertManager.getAlerts();
		const recentAlerts = allAlerts.slice(0, maxRecentAlerts);
		
		// Lightweight alert format for reporting
		const alertsForReport = recentAlerts.map(alert => ({
			id: alert.id,
			severity: alert.severity,
			deviceState: alert.deviceState || 'unknown',
			metric: alert.metric,
			value: alert.value,
			deviation: alert.deviation,
			method: alert.detectionMethod,
			timestamp: alert.timestamp,
			confidence: alert.confidence,
			count: alert.count,
		}));
		
		// Generate predictions for all tracked metrics
		const predictions = this.generatePredictions();
		
		return {
			enabled: true,
			stats: {
				metricsTracked: new Set(Array.from(this.buffers.keys()).map(k => this.parseBufferKey(k).metricName)).size,
				stateBucketsTracked: this.buffers.size,
				totalAlerts: allAlerts.length,
				criticalCount: this.alertManager.getAlertsBySeverity('critical').length,
				warningCount: this.alertManager.getAlertsBySeverity('warning').length,
				infoCount: this.alertManager.getAlertsBySeverity('info').length,
			},
			recentAlerts: alertsForReport,
			predictions,
		};
	}
	
	/**
	* Generate predictions for all tracked metrics
	*/
	private generatePredictions(): Record<string, Prediction> | undefined {
		if (this.buffers.size === 0) {
			return undefined;
		}
		
		const predictions: Record<string, Prediction> = {};
		const now = Date.now();
		
		for (const [bufferKey, buffer] of this.buffers.entries()) {
			const { metricName } = this.parseBufferKey(bufferKey);
			const metricConfig = this.getMetricConfig(metricName);
			if (!metricConfig) continue;

			const cadenceState: ForecastCadenceState = this.predictionCadenceState.get(bufferKey) || {};
			this.predictionCadenceState.set(bufferKey, cadenceState);

			if (!shouldRunForecast(buffer, cadenceState, this.predictionCadence, now)) {
				continue;
			}
			
			this.logger?.debugSync('Generating forecast', {
				component: LogComponents.anomaly,
				metric: metricName,
				bufferSize: buffer.size,
				lookback: LINEAR_PREDICTOR_LOOKBACK,
			});
			
			// Generate prediction using linear predictor (standardized lookback)
			const predictionResult = this.predictor.predictResult(buffer, LINEAR_PREDICTOR_LOOKBACK);
			recordForecastResult(cadenceState, null, now); // Track run even if no publish
			if (!predictionResult.success) {
				this.logger?.debugSync('Forecast generation failed', {
					component: LogComponents.anomaly,
					metric: metricName,
					reason: predictionResult.reason,
				});
				continue;
			}
			const prediction = predictionResult.prediction;
			
			this.logger?.debugSync('Forecast generated', {
				component: LogComponents.anomaly,
				metric: metricName,
				current: prediction.current?.toFixed(3) ?? 'N/A',
				predictedNext: prediction.predictedNext?.toFixed(3) ?? 'N/A',
				trend: prediction.trend,
				trendStrength: prediction.trendStrength?.toFixed(3) ?? 'N/A',
				confidence: prediction.confidence?.toFixed(3) ?? 'N/A',
			});
			
			// Add time-to-threshold only when prediction confidence is solid
			if (
				prediction.confidence >= MIN_TIME_TO_THRESHOLD_CONFIDENCE &&
				metricConfig.expectedRange?.[1] !== undefined
			) {
				const threshold = metricConfig.expectedRange[1]; // Upper bound
				const samplingIntervalMs = 20000; // Default 20s interval (matches METRICS_INTERVAL_MS)
				
				const timeToThresholdResult = this.predictor.estimateTimeToThresholdResult(
					buffer,
					threshold,
					samplingIntervalMs
				);

				if (!timeToThresholdResult.success) {
					this.logger?.debugSync('Time-to-threshold estimation skipped', {
						component: LogComponents.anomaly,
						metric: metricName,
						reason: timeToThresholdResult.reason,
					});
				} else if (timeToThresholdResult.estimate.confidence >= 0.3) { // Guard: never attach <0.3
					prediction.timeToThreshold = {
						threshold,
						...timeToThresholdResult.estimate,
					};
				}
			}
			
			const shouldPublish = shouldPublishForecast(prediction, cadenceState, this.predictionCadence);
			if (!shouldPublish) {
				this.logger?.debugSync('Forecast not published (cadence control)', {
					component: LogComponents.anomaly,
					metric: metricName,
					reason: 'No significant change from last forecast',
				});
				continue;
			}

			this.logger?.infoSync('Publishing forecast', {
				component: LogComponents.anomaly,
				metric: metricName,
				predictedNext: prediction.predictedNext?.toFixed(3) ?? 'N/A',
				trend: prediction.trend,
				confidence: prediction.confidence?.toFixed(3) ?? 'N/A',
				timeToThreshold: prediction.timeToThreshold?.estimatedSeconds
					? `${(prediction.timeToThreshold.estimatedSeconds / 3600).toFixed(1)}h`
					: 'N/A',
			});

			recordForecastResult(cadenceState, prediction, now);
			predictions[bufferKey] = prediction;
			const existingMetricPrediction = predictions[metricName];
			if (!existingMetricPrediction || prediction.confidence >= existingMetricPrediction.confidence) {
				predictions[metricName] = prediction;
			}
		}
		
		return Object.keys(predictions).length > 0 ? predictions : undefined;
	}
	
	/**
	* Enable/disable detection
	*/
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.logger?.infoSync(`Anomaly detection ${enabled ? 'enabled' : 'disabled'}`, {
			component: LogComponents.anomaly,
		});
	}
	
	/**
	 * Initialize (or reinitialize) the alert MQTT client from a destination record.
	 */
	private async initAlertMqttClient(destinationId: number): Promise<void> {
		if (this.alertMqttClient) {
			await this.alertMqttClient.disconnect().catch(() => undefined);
			this.alertMqttClient = undefined;
		}

		const record = PublishDestinationsModel.getById(destinationId);
		if (!record || record.type !== 'mqtt') {
			this.logger?.warnSync('Alert destination not found or not MQTT type', {
				component: LogComponents.anomaly,
				destinationId,
			});
			return;
		}

		const client = createExternalMqttClientFromDestination(
			record.config_json,
			this.deviceUuid,
			'anomaly-alerts',
			this.logger,
		);
		if (!client) {
			this.logger?.warnSync('Failed to create alert MQTT client — invalid destination config', {
				component: LogComponents.anomaly,
				destinationId,
			});
			return;
		}

		this.alertMqttClient = client;
		this.alertDestinationId = destinationId;

		await client.connect();
		this.logger?.infoSync('Alert MQTT client connected', {
			component: LogComponents.anomaly,
			destinationId,
			destination: record.name,
		});
	}

	/**
	* Stop and cleanup anomaly detection service
	*/
	stop(): void {
		this.enabled = false;
		this.buffers.clear();
		this.alertManager = new AlertManager(
			this.config.alerts.maxQueueSize,
			this.config.alerts.cooldownMs
		);
		
		// Stop baseline save timer
		if (this.baselineSaveTimer) {
			(globalThis as any).clearInterval(this.baselineSaveTimer);
			this.baselineSaveTimer = undefined;
		}
		
		// Stop storage service
		if (this.storage) {
			this.storage.stop();
			this.storage = undefined;
		}

		// Disconnect alert MQTT client if active
		if (this.alertMqttClient) {
			this.alertMqttClient.disconnect().catch(() => undefined);
			this.alertMqttClient = undefined;
		}

		this.logger?.infoSync('Anomaly detection service stopped and cleaned up', {
			component: LogComponents.anomaly,
		});
	}
	
	/**
	* Update configuration
	*/
	updateConfig(config: Partial<AnomalyConfig>): void {
		this.config = { ...this.config, ...config };

		// Reconnect alert MQTT client if the destination changed
		const newDestId = config.alerts?.alertDestinationId;
		if (newDestId !== undefined && newDestId !== this.alertDestinationId) {
			if (newDestId) {
				this.initAlertMqttClient(newDestId).catch((err: unknown) => {
					this.logger?.errorSync('Failed to reinit alert MQTT client', err as Error, {
						component: LogComponents.anomaly,
					});
				});
			} else {
				this.alertMqttClient?.disconnect().catch(() => undefined);
				this.alertMqttClient = undefined;
				this.alertDestinationId = undefined;
			}
		}

		// Sync runtime detection flag so the UI "Enabled" toggle takes effect immediately.
		// Without this, processDataPoint() always checks this.enabled (not this.config.enabled)
		// and the toggle would save to DB but never change runtime behaviour.
		if (config.enabled !== undefined) {
			this.enabled = config.enabled;
			this.logger?.infoSync(`Anomaly detection ${config.enabled ? 'enabled' : 'disabled'} via config update`, {
				component: LogComponents.anomaly,
			});
		}

		// Remove in-memory state for metrics no longer present in configuration.
		// This avoids stale buffers/scores after dashboard metric deletions.
		// IMPORTANT: use getMetricConfig() (same fuzzy matching as processDataPoint) rather
		// than a plain Set lookup. Buffer keys always carry the canonical incoming name
		// (e.g. "{agentUuid}_{endpointUuid}_temperature") while config entries may store
		// bare names ("temperature"). A Set check would falsely prune those buffers every
		// time the config is saved, wiping accumulated samples needlessly.
		let prunedMetrics = 0;
		for (const bufferKey of Array.from(this.buffers.keys())) {
			const { metricName } = this.parseBufferKey(bufferKey);
			if (!this.getMetricConfig(metricName)) {
				this.buffers.delete(bufferKey);
				this.anomalyScores.delete(bufferKey);
				this.anomalyMetadata.delete(bufferKey);
				this.predictionCadenceState.delete(bufferKey);
				this.unconfiguredMetricLogCounts.delete(metricName);
				prunedMetrics++;
			}
		}
		
		// Update storage retention if changed (default to 30 if not specified)
		if (this.storage && config.storage?.retention !== undefined) {
			this.storage.updateRetention(config.storage.retention);
		}

		if (config.predictions?.cadence) {
			this.predictionCadence = {
				...this.predictionCadence,
				...config.predictions.cadence,
			};
		}
		
		this.logger?.infoSync('Anomaly detection configuration updated', {
			component: LogComponents.anomaly,
			prunedMetrics,
		});
	}
	
	/**
	* Start periodic baseline saving
	*/
	private startPeriodicBaselineSave(): void {
		if (!this.storage) return;
		
		this.baselineSaveTimer = (globalThis as any).setInterval(() => {
			this.saveBaselines();
		}, this.baselineSaveIntervalMs);
		
		this.logger?.infoSync('Started periodic baseline saving', {
			component: LogComponents.anomaly,
			interval_hours: this.baselineSaveIntervalMs / (60 * 60 * 1000),
		});
	}

	/**
	* Check if sufficient baselines exist and skip warm-up if so
	* This prevents repeated 15-minute alert blackouts after agent restarts
	*/
	private async checkAndSkipWarmupIfBaselinesExist(): Promise<void> {
		if (!this.storage) return;

		// Get list of enabled metrics from config
		const enabledMetrics = this.config.metrics
			.filter(m => m.enabled)
			.map(m => m.name);

		if (enabledMetrics.length === 0) return;

		// Check if baselines exist for most metrics (80% coverage with 30+ samples each)
		// Coverage calculation automatically excludes never-collected metrics (e.g., cpu_temp on Windows)
		const { hasCoverage, coveragePercent, metricsWithBaselines } = await this.storage.checkBaselineCoverage(
			enabledMetrics,
			30, // minSamples (30 samples = ~2.5 min at 5sec intervals)
			0.8  // minCoveragePercent (80% of collectible metrics must have baselines)
		);

		if (hasCoverage) {
			// Sufficient baselines exist - skip warm-up by backdating startup timestamp
			this.startupTimestamp = Date.now() - this.warmupPeriodMs;
			this.logger?.infoSync('Skipping warm-up period - sufficient baselines exist', {
				component: LogComponents.anomaly,
				coveragePercent: (coveragePercent * 100).toFixed(1) + '%',
				metricsWithBaselines,
				totalMetrics: enabledMetrics.length,
				warmupPeriodMs: this.warmupPeriodMs,
			});
		} else {
			this.logger?.infoSync('Warm-up period active - insufficient baseline coverage', {
				component: LogComponents.anomaly,
				coveragePercent: (coveragePercent * 100).toFixed(1) + '%',
				metricsWithBaselines,
				totalMetrics: enabledMetrics.length,
				warmupPeriodMs: this.warmupPeriodMs,
				remainingMinutes: Math.ceil(this.warmupPeriodMs / 60000),
			});
		}
	}
	
	/**
	* Save current statistical baselines to database
	* Public for manual triggering and testing
	*/
	async saveBaselines(): Promise<void> {
		await this.saveObservedMetrics();

		if (!this.storage) {
			this.logger?.warnSync('Cannot save baselines - storage not initialized', {
				component: LogComponents.anomaly,
			});
			return;
		}
		
		const now = Date.now();
		let attemptedCount = 0;
		let persistedCount = 0;
		let failedCount = 0;
		let skippedCount = 0;
		const persistedMetricSamples: string[] = [];
		
		// Minimum samples required for statistical baseline (default: 5 samples = ~5 minutes at 60s interval)
		const minSamples = this.config.storage?.minSamples ?? 5;
		
		// Debug: Log buffer sizes before saving
		const bufferSizes: Record<string, number> = {};
		for (const [metricName, buffer] of this.buffers.entries()) {
			bufferSizes[metricName] = buffer.size;
		}
		
		this.logger?.debugSync('Baseline save starting', {
			component: LogComponents.anomaly,
			minSamples,
			bufferSizes,
		});
		
		// Save all baselines in parallel
		const savePromises: Promise<void>[] = [];
		
		for (const [bufferKey, buffer] of this.buffers.entries()) {
			const { metricName, deviceState, deviceId } = this.parseBufferKey(bufferKey);
			if (buffer.size >= minSamples) {
				const profile = this.getProfileForMetric(metricName);
				savePromises.push(
					this.storage
						.storeBaseline(metricName, buffer, now, -1, profile, deviceState, deviceId)
						.then(() => {
							persistedCount++;
							if (persistedMetricSamples.length < 12) {
								persistedMetricSamples.push(metricName);
							}
						})
						.catch(error => {
							failedCount++;
							this.logger?.errorSync('Failed to save baseline', error as Error, {
								component: LogComponents.anomaly,
								metric: metricName,
								deviceState,
								deviceId,
								profile,
							});
						})
				);
				attemptedCount++;
			} else {
				this.logger?.infoSync('Skipping baseline save - insufficient samples', {
					component: LogComponents.anomaly,
					metric: metricName,
					deviceState,
					deviceId,
					bufferSize: buffer.size,
					required: minSamples,
				});
				skippedCount++;
			}
		}
		
		// Wait for all saves to complete
		await Promise.all(savePromises);
		
		this.logger?.infoSync('Baseline persistence summary', {
			component: LogComponents.anomaly,
			attempted: attemptedCount,
			persisted: persistedCount,
			failed: failedCount,
			skipped: skippedCount,
			totalBuffers: this.buffers.size,
			minSamples,
			samplePersistedMetrics: persistedMetricSamples,
		});
	}
	
	/**
	* Get storage service (for external queries)
	*/
	getStorage(): AnomalyStorageService | undefined {
		return this.storage;
	}
	
	/**
	* Set profile for a metric pattern (e.g., set 'Generic' for 'modbus_slave_%' metrics)
	* @param metricPattern - Metric pattern (e.g., 'modbus_slave_1', 'modbus_slave_%')
	* @param profile - Profile identifier (e.g., 'Generic', 'COMAP')
	*/
	setProfileForMetrics(metricPattern: string, profile: string): void {
		this.metricProfiles.set(metricPattern, profile);
		
		this.logger?.infoSync('Profile set for metric pattern', {
			component: LogComponents.anomaly,
			metricPattern,
			profile,
		});
	}
	
	/**
	* Handle profile change - reset in-memory buffers for fresh baseline learning
	* 
	* NOTE: Database baselines are NOT filtered by profile (profile is metadata only)
	* If you change simulator scenarios, manually clear anomaly_baselines table to avoid
	* mixing baselines from different data distributions:
	*   DELETE FROM anomaly_baselines WHERE metric LIKE 'modbus_%';
	* 
	* @param newProfile - New profile identifier (metadata only)
	* @param metricPattern - Pattern to match metrics (e.g., 'modbus_slave_%')
	*/
	handleProfileChange(newProfile: string, metricPattern: string = 'modbus_%'): void {
		this.logger?.infoSync('Handling profile change', {
			component: LogComponents.anomaly,
			newProfile,
			metricPattern,
		});
		
		// Clear in-memory buffers to start fresh learning for new profile
		// (Database baselines are preserved, filtered by profile when queried)
		const clearedBuffers: string[] = [];
		const regex = new RegExp(metricPattern.replace(/%/g, '.*'));
		
		for (const [bufferKey, buffer] of this.buffers.entries()) {
			const { metricName } = this.parseBufferKey(bufferKey);
			if (metricName.match(regex)) {
				buffer.size = 0; // Reset buffer
				buffer.sum = 0;
				buffer.sumSquares = 0;
				buffer.mean = 0;
				buffer.variance = 0;
				this.anomalyScores.delete(bufferKey);
				this.anomalyMetadata.delete(bufferKey);
				clearedBuffers.push(bufferKey);
			}
		}
		
		this.logger?.infoSync('Reset in-memory buffers for new profile', {
			component: LogComponents.anomaly,
			newProfile,
			clearedBuffers,
			count: clearedBuffers.length,
			note: 'Historical baselines preserved in database',
		});
		
		// Update profile mapping
		this.metricProfiles.set(metricPattern, newProfile);
	}
	
	/**
	* Get profile for a metric (extracts from metric name prefix)
	* Returns profile from cache or null for system metrics
	*/
	private getProfileForMetric(metricName: string): string | null {
		// Check cached profile mappings
		for (const [pattern, profile] of this.metricProfiles.entries()) {
			const regex = new RegExp(pattern.replace(/%/g, '.*'));
			if (metricName.match(regex)) {
				return profile;
			}
		}
		
		// System metrics (cpu_usage, memory_percent, etc.) don't have profile
		if (metricName.startsWith('modbus_') || metricName.startsWith('opcua_') || metricName.startsWith('snmp_')) {
			this.logger?.debugSync('Protocol metric without profile mapping', {
				component: LogComponents.anomaly,
				metric: metricName,
				note: 'Consider calling setProfileForMetrics()',
			});
		}
		
		return null; // System metric or no profile mapping
	}

	/**
	* Validate a baseline loaded from storage before using it for anomaly detection.
	*
	* Checks (all must pass):
	*   1. metric        — must match the current data point metric
	*   2. device_state  — must match the resolved device state
	*   3. sample_count  — must meet the minimum samples requirement
	*   4. calculated_at — must not exceed max age (default: 7 days, configurable via storage.baselineMaxAgeDays)
	*   5. profile       — must match current profile when both sides are non-null
	*   6. time_slot     — must match current time slot when seasonality is active
	*
	* Returns false if any check fails; the caller should set dbBaseline = null and rely on buffer stats.
	*/
	private isBaselineValid(
		baseline: AnomalyBaselineRecord,
		dataPoint: DataPoint,
		config: MetricConfig,
		timeSlot: number,
		minimumSamples: number
	): boolean {
		// 1. Metric identity
		if (baseline.metric !== dataPoint.metric) {
			this.logger?.warnSync('Baseline metric mismatch — discarding', {
				component: LogComponents.anomaly,
				baselineMetric: baseline.metric,
				currentMetric: dataPoint.metric,
			});
			return false;
		}

		// 2. Device state
		const currentState = this.resolveDeviceState(dataPoint);
		if (baseline.device_state !== currentState) {
			this.logger?.debugSync('Baseline device_state mismatch — discarding', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				baselineState: baseline.device_state,
				currentState,
			});
			return false;
		}

		// 3. Minimum samples
		if (baseline.sample_count < minimumSamples) {
			this.logger?.debugSync('Baseline sample_count below minimum — discarding', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				baselineSamples: baseline.sample_count,
				minimumSamples,
			});
			return false;
		}

		// 4. Baseline age
		const maxAgeDays = this.config.storage?.baselineMaxAgeDays ?? 7;
		const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
		const ageMs = Date.now() - baseline.calculated_at;
		if (ageMs > maxAgeMs) {
			this.logger?.warnSync('Baseline is stale — discarding', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				ageHours: Math.round(ageMs / 3600000),
				maxAgeDays,
			});
			return false;
		}

		// 5. Profile — only reject when both sides explicitly specify a profile and they differ
		const currentProfile = this.getProfileForMetric(dataPoint.metric);
		if (currentProfile !== null && baseline.profile !== null && baseline.profile !== currentProfile) {
			this.logger?.debugSync('Baseline profile mismatch — discarding', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				baselineProfile: baseline.profile,
				currentProfile,
			});
			return false;
		}

		// 6. Time slot — only check when seasonality is active and the baseline is not an overall (-1) slot
		const seasonality = config.seasonality || 'none';
		if (seasonality !== 'none' && baseline.time_slot !== -1 && baseline.time_slot !== timeSlot) {
			this.logger?.debugSync('Baseline time_slot mismatch — discarding', {
				component: LogComponents.anomaly,
				metric: dataPoint.metric,
				baselineTimeSlot: baseline.time_slot,
				currentTimeSlot: timeSlot,
				seasonality,
			});
			return false;
		}

		return true;
	}

	private getBufferKey(metricName: string, deviceState: CanonicalDeviceState, deviceId: string): string {
		return buildBufferKey(metricName, deviceState, deviceId);
	}

	private parseBufferKey(bufferKey: string): { metricName: string; deviceState: CanonicalDeviceState; deviceId: string } {
		return decodeBufferKey(bufferKey);
	}

	private resolveDeviceState(dataPoint: DataPoint): CanonicalDeviceState {
		return resolveDataPointDeviceState(dataPoint, this.deviceType);
	}

	private resolveEventDeviceType(dataPoint: DataPoint): Protocol {
		return resolveDataPointEventDeviceType(dataPoint, this.deviceType, this.logger);
	}

	/**
	* Get MQTT manager for publishing data (used by simulator)
	*/
	getMqttManager(): CloudMqttClient | undefined {
		return this.mqttManager;
	}

	private resolveDeviceId(dataPoint: DataPoint): string {
		return resolveDataPointDeviceId(dataPoint);
	}
}
