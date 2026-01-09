/**
 * ANOMALY DETECTION UTILITIES
 * ============================
 * 
 * Helper functions for configuration loading and data point creation
 */

import type { AnomalyConfig, MetricConfig, DataPoint, DetectionMethod } from './types';

/**
 * Load configuration from cloud target state (preferred) or environment variables (fallback)
 * 
 * Supports V2 format (anomalyDetection), V1.5 format (anomaly), and V1 format (config.anomaly)
 */
export function loadConfigFromTargetState(targetStateConfig?: any): AnomalyConfig {
	// V2 format: Top-level anomalyDetection section
	if (targetStateConfig?.anomalyDetection) {
		const config = targetStateConfig.anomalyDetection as AnomalyConfig;
		// Ensure warmupPeriodMs has default if not specified
		if (config.warmupPeriodMs === undefined) {
			config.warmupPeriodMs = 15 * 60 * 1000; // 15 minutes default
		}
		return config;
	}
	
	// V1.5 format: Top-level anomaly section (backward compat)
	if (targetStateConfig?.anomaly) {
		const config = targetStateConfig.anomaly as AnomalyConfig;
		if (config.warmupPeriodMs === undefined) {
			config.warmupPeriodMs = 15 * 60 * 1000;
		}
		return config;
	}
	
	// V1 format: config.anomaly (legacy)
	if (targetStateConfig?.config?.anomaly) {
		const config = targetStateConfig.config.anomaly as AnomalyConfig;
		if (config.warmupPeriodMs === undefined) {
			config.warmupPeriodMs = 15 * 60 * 1000;
		}
		return config;
	}
	
	// Fallback to environment variables
	return loadConfigFromEnv();
}

/**
 * Load configuration from environment variables (fallback)
 */
export function loadConfigFromEnv(): AnomalyConfig {
	const enabled = process.env.ANOMALY_DETECTION_ENABLED === 'true';
	const sensitivity = parseInt(process.env.ANOMALY_SENSITIVITY || '5', 10);
	
	// Parse detection methods
	const methodsStr = process.env.ANOMALY_METHODS || 'zscore,mad,ewma';
	const methods = methodsStr.split(',').map(m => m.trim()) as DetectionMethod[];
	
	// Statistical parameters
	const windowSize = parseInt(process.env.ANOMALY_WINDOW_SIZE || '500', 10);
	const zscoreThreshold = parseFloat(process.env.ANOMALY_ZSCORE_THRESHOLD || '3.0');
	const madThreshold = parseFloat(process.env.ANOMALY_MAD_THRESHOLD || '3.0');
	const rateThreshold = parseFloat(process.env.ANOMALY_RATE_THRESHOLD || '10.0');
	
	// ML parameters
	const mlEnabled = process.env.ANOMALY_ML_ENABLED === 'true';
	const mlTrainingInterval = parseInt(process.env.ANOMALY_ML_TRAINING_INTERVAL || '3600000', 10);
	const mlConfidenceThreshold = parseFloat(process.env.ANOMALY_ML_CONFIDENCE_THRESHOLD || '0.7');
	
	// Alert configuration
	const alertMinConfidence = parseFloat(process.env.ANOMALY_ALERT_MIN_CONFIDENCE || '0.7');
	const alertCooldown = parseInt(process.env.ANOMALY_ALERT_COOLDOWN_MS || '300000', 10);
	const alertMaxQueue = parseInt(process.env.ANOMALY_ALERT_MAX_QUEUE || '1000', 10);
	
	// Storage
	const historyDays = parseInt(process.env.ANOMALY_HISTORY_DAYS || '30', 10);
	const dbPath = process.env.ANOMALY_DB_PATH || `${process.env.DATA_DIR || '/app/data'}/anomaly.db`;
	
	// MQTT
	const mqttEnabled = process.env.ANOMALY_MQTT_ENABLED !== 'false';
	
	// Cloud sync
	const cloudSync = process.env.ANOMALY_CLOUD_SYNC !== 'false';
	
	// Default metrics to monitor
	const metrics: MetricConfig[] = [
		{
			name: 'cpu_usage',
			enabled: true,
			methods: ['expected_range', 'zscore', 'ewma'],
			threshold: zscoreThreshold,
			windowSize: 100,
			expectedRange: [0, 85],
		},
		{
			name: 'memory_percent',
			enabled: true,
			methods: ['expected_range', 'zscore', 'ewma', 'rate_change'],
			threshold: zscoreThreshold,
			windowSize: 200,
			expectedRange: [0, 85],
		},
		{
			name: 'cpu_temp',
			enabled: true,
			methods: ['expected_range', 'zscore', 'mad'],
			threshold: madThreshold,
			windowSize: 300,
			expectedRange: [30, 80],
		},
		{
			name: 'temperature',
			enabled: true,
			methods: ['zscore', 'mad', 'ewma'],
			threshold: zscoreThreshold,
			windowSize: 500,
		},
		{
			name: 'humidity',
			enabled: true,
			methods: ['zscore', 'mad'],
			threshold: zscoreThreshold,
			windowSize: 500,
		},
		{
			name: 'pressure',
			enabled: true,
			methods: ['zscore', 'mad'],
			threshold: zscoreThreshold,
			windowSize: 500,
		},
	];
	
	return {
		sensitivity,
		metrics,
		alerts: {
			mqtt: mqttEnabled,
			cloud: cloudSync,
			minConfidence: alertMinConfidence,
			cooldownMs: alertCooldown,
			maxQueueSize: alertMaxQueue,
		},
		storage: {
			retention: historyDays,
			dbPath,
		},
		ml: mlEnabled ? {
			enabled: mlEnabled,
			trainingIntervalMs: mlTrainingInterval,
			confidenceThreshold: mlConfidenceThreshold,
		} : undefined,
	};
}

/**
 * Create a data point from sensor data
 */
export function createSensorDataPoint(
	metric: string,
	value: number,
	unit: string,
	deviceId?: string,
	quality?: 'GOOD' | 'BAD' | 'UNCERTAIN'
): DataPoint {
	return {
		source: 'sensor',
		metric,
		value,
		unit,
		timestamp: Date.now(),
		deviceId,
		quality: quality || 'GOOD',
	};
}

/**
 * Create a data point from system metrics
 */
export function createSystemDataPoint(
	metric: string,
	value: number,
	unit: string
): DataPoint {
	return {
		source: 'system',
		metric,
		value,
		unit,
		timestamp: Date.now(),
		quality: 'GOOD',
	};
}

/**
 * Create a data point from container metrics
 */
export function createContainerDataPoint(
	metric: string,
	value: number,
	unit: string,
	containerId?: string
): DataPoint {
	return {
		source: 'container',
		metric,
		value,
		unit,
		timestamp: Date.now(),
		deviceId: containerId,
		quality: 'GOOD',
	};
}

/**
 * Validate anomaly configuration
 */
export function validateConfig(config: AnomalyConfig): string[] {
	const errors: string[] = [];
	
	if (config.sensitivity < 1 || config.sensitivity > 10) {
		errors.push('Sensitivity must be between 1 and 10');
	}
	
	for (const metric of config.metrics) {
		if (metric.windowSize < 10) {
			errors.push(`${metric.name}: windowSize must be at least 10`);
		}
		
		if (metric.threshold <= 0) {
			errors.push(`${metric.name}: threshold must be positive`);
		}
		
		if (metric.methods.length === 0) {
			errors.push(`${metric.name}: at least one detection method required`);
		}
	}
	
	if (config.alerts.minConfidence < 0 || config.alerts.minConfidence > 1) {
		errors.push('minConfidence must be between 0 and 1');
	}
	
	if (config.alerts.cooldownMs < 0) {
		errors.push('cooldownMs must be non-negative');
	}
	
	if (config.alerts.maxQueueSize < 10) {
		errors.push('maxQueueSize must be at least 10');
	}
	
	return errors;
}

/**
 * Get human-readable configuration summary
 */
export function getConfigSummary(config: AnomalyConfig): string {
	const enabledMetrics = config.metrics.filter(m => m.enabled);
	const uniqueMethods = new Set<DetectionMethod>();
	enabledMetrics.forEach(m => m.methods.forEach(method => uniqueMethods.add(method)));
	
	return `
Anomaly Detection Configuration:
  Sensitivity: ${config.sensitivity}/10
  Metrics Tracked: ${enabledMetrics.length}
  Detection Methods: ${Array.from(uniqueMethods).join(', ')}
  Alert Confidence Threshold: ${(config.alerts.minConfidence * 100).toFixed(0)}%
  Alert Cooldown: ${config.alerts.cooldownMs / 1000}s
  Max Queue Size: ${config.alerts.maxQueueSize}
  ML Enabled: ${config.ml?.enabled ? 'Yes' : 'No'}
	`.trim();
}
