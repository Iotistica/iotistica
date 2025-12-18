/**
 * ANOMALY DETECTION SERVICE - MAIN ORCHESTRATOR
 * ===============================================
 * 
 * Edge-appropriate anomaly detection for sensor data and system metrics
 */

import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type {
	DataPoint,
	AnomalyConfig,
	AnomalyAlert,
	MetricConfig,
	StatisticalBuffer,
	DetectionMethod,
	AnomalySeverity,
} from './types';
import { createBuffer, addValue, getRecentValues, getTrend } from './buffer';
import { getDetector } from './detectors';
import { AlertManager } from './alert-manager';
import { LinearPredictor } from './forecaster';
import type { Prediction } from './forecaster';
import { AnomalyStorageService } from './storage';

export class AnomalyDetectionService {
	private config: AnomalyConfig;
	private buffers = new Map<string, StatisticalBuffer>();
	private alertManager: AlertManager;
	private logger?: AgentLogger;
	private enabled: boolean = false;
	private predictor: LinearPredictor;
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
	
	constructor(config: AnomalyConfig, db?: Knex, logger?: AgentLogger) {
		this.config = config;
		this.logger = logger;
		this.enabled = true; // Controlled by features.enableAnomalyDetection
		
		this.alertManager = new AlertManager(
			config.alerts.maxQueueSize,
			config.alerts.cooldownMs
		);
		
		this.predictor = new LinearPredictor();
		
		// Initialize storage if database provided (use default 30 days if not configured)
		if (db) {
			const retention = config.storage?.retention || 30;
			this.storage = new AnomalyStorageService(
				db,
				retention,
				logger
			);
			
			// Initialize storage (verify tables exist, start cleanup)
			this.storage.initialize().catch(error => {
				this.logger?.errorSync('Failed to initialize anomaly storage', error as Error, {
					component: LogComponents.metrics,
				});
				this.storage = undefined; // Disable storage on error
			});
			
			// Start periodic baseline saving
			this.startPeriodicBaselineSave();
		}
		
		// Buffers are created lazily when data is first received (more efficient)
		// This ensures metricsTracked reflects only actively monitored metrics
		
		this.logger?.infoSync('Anomaly detection service initialized', {
			component: LogComponents.metrics,
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
		if (!this.enabled) return;
		
		// Skip BAD quality data
		if (dataPoint.quality === 'BAD') {
			this.logger?.debugSync('Skipping BAD quality data point', {
				component: LogComponents.metrics,
				metric: dataPoint.metric,
			});
			return;
		}
		
		const metricConfig = this.getMetricConfig(dataPoint.metric);
		if (!metricConfig || !metricConfig.enabled) {
			return; // Metric not configured for anomaly detection
		}
		
		// Get or create buffer
		let buffer = this.buffers.get(dataPoint.metric);
		if (!buffer) {
			buffer = createBuffer(metricConfig.windowSize);
			this.buffers.set(dataPoint.metric, buffer);
		}
		
		// Add value to buffer
		addValue(buffer, dataPoint.value, dataPoint.timestamp);
		
		// Run detection if buffer has enough samples (async, updates cache)
		if (buffer.size >= 10) {
			this.runDetection(dataPoint, buffer, metricConfig);
		} else {
			// Buffer still building, cache zero score for this metric
			this.anomalyScores.set(dataPoint.metric, 0.0);
			// Cache metadata even while building buffer
			this.anomalyMetadata.set(dataPoint.metric, {
				threshold: metricConfig.minConfidence || this.config.alerts.minConfidence,
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
		return this.anomalyScores.get(metricName);
	}
	
	/**
	 * Get anomaly metadata for a metric (threshold, methods, sample count)
	 * Used for ML training and debugging
	 */
	getAnomalyMetadata(metricName: string): { threshold: number; methods: string[]; samples: number } | undefined {
		return this.anomalyMetadata.get(metricName);
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
		
		// Load latest baseline from database if available
		let dbBaseline: any = null;
		if (this.storage) {
			try {
				dbBaseline = await this.storage.getLatestBaseline(dataPoint.metric);
			} catch (error) {
				this.logger?.debugSync('Failed to load baseline from database, using buffer stats', {
					component: LogComponents.metrics,
					metric: dataPoint.metric,
				});
			}
		}
		
		// Build list of methods to run
		const methodsToRun = [...metricConfig.methods];
		
		// Auto-add expected_range if expectedRange is configured but not in methods
		if (metricConfig.expectedRange && !methodsToRun.includes('expected_range')) {
			methodsToRun.unshift('expected_range'); // Add first for priority
		}
		
		// Run each configured detection method
		for (const method of methodsToRun) {
			const detector = getDetector(method);
			if (!detector) {
				this.logger?.warnSync(`Unknown detection method: ${method}`, {
					component: LogComponents.metrics,
				});
				continue;
			}
			
			const result = detector.detect(dataPoint.value, buffer, metricConfig, dbBaseline);
			
			// Track maximum confidence across all methods (for anomaly score)
			if (result.confidence > maxConfidence) {
				maxConfidence = result.confidence;
			}
			
			// Filter by confidence threshold for alerts
			const minConfidence = metricConfig.minConfidence || this.config.alerts.minConfidence;
			if (result.isAnomaly && result.confidence >= minConfidence) {
				const alert = this.createAlert(dataPoint, buffer, metricConfig, result);
				results.push(alert);
			}
		}
		
		// Cache the anomaly score for this metric (0.0-1.0 range)
		this.anomalyScores.set(dataPoint.metric, maxConfidence);
		
		// Cache metadata for ML training and debugging
		this.anomalyMetadata.set(dataPoint.metric, {
			threshold: metricConfig.minConfidence || this.config.alerts.minConfidence,
			methods: methodsToRun,
			samples: buffer.size
		});
		
		// Add alerts to manager
		for (const alert of results) {
			this.alertManager.addAlert(alert);
			
			// Store alert to database
			if (this.storage) {
				this.storage.storeAlert(alert).catch(error => {
					this.logger?.errorSync('Failed to store alert to database', error as Error, {
						component: LogComponents.metrics,
					});
				});
			}
			
			this.logger?.warnSync('Anomaly detected', {
				component: LogComponents.metrics,
				metric: alert.metric,
				value: alert.value,
				method: alert.detectionMethod,
				severity: alert.severity,
				confidence: alert.confidence,
				deviation: alert.deviation,
			});
		}
	}
	
	/**
	 * Create an anomaly alert from detection result
	 */
	private createAlert(
		dataPoint: DataPoint,
		buffer: StatisticalBuffer,
		metricConfig: MetricConfig,
		result: any
	): AnomalyAlert {
		const severity = this.calculateSeverity(result.confidence, result.deviation);
		
		return {
			id: randomUUID(),
			severity,
			metric: dataPoint.metric,
			value: dataPoint.value,
			expectedRange: result.expectedRange,
			deviation: result.deviation,
			detectionMethod: result.method,
			timestamp: dataPoint.timestamp,
			confidence: result.confidence,
			context: {
				recent_values: getRecentValues(buffer, 10),
				baseline: buffer.mean,
				trend: getTrend(buffer),
				windowSize: buffer.size,
			},
			message: result.message,
			fingerprint: '', // Set by AlertManager
			count: 1,
		};
	}
	
	/**
	 * Calculate severity based on confidence and deviation
	 */
	private calculateSeverity(confidence: number, deviation: number): AnomalySeverity {
		if (confidence >= 0.85 || deviation >= 5.0) {
			return 'critical';
		} else if (confidence >= 0.7 || deviation >= 3.0) {
			return 'warning';
		} else {
			return 'info';
		}
	}
	
	/**
	 * Get metric configuration by name
	 */
	private getMetricConfig(metricName: string): MetricConfig | undefined {
		return this.config.metrics.find(m => m.name === metricName);
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
	 * Get service statistics
	 */
	getStats() {
		return {
			enabled: this.enabled,
			metricsTracked: this.buffers.size,
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
				metricsTracked: this.buffers.size,
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
		
		for (const [metricName, buffer] of this.buffers.entries()) {
			const metricConfig = this.getMetricConfig(metricName);
			if (!metricConfig) continue;
			
			// Generate prediction using linear predictor
			const prediction = this.predictor.predict(buffer, 20); // Use 20-sample lookback window
			if (!prediction) continue;
			
			// Add time-to-threshold if expected range is configured
			if (metricConfig.expectedRange && metricConfig.expectedRange[1] !== undefined) {
				const threshold = metricConfig.expectedRange[1]; // Upper bound
				const samplingIntervalMs = 20000; // Default 20s interval (matches METRICS_INTERVAL_MS)
				
				const timeToThreshold = this.predictor.estimateTimeToThreshold(
					buffer,
					threshold,
					samplingIntervalMs
				);
				
				if (timeToThreshold) {
					prediction.time_to_threshold = {
						threshold,
						...timeToThreshold,
					};
				}
			}
			
			predictions[metricName] = prediction;
		}
		
		return Object.keys(predictions).length > 0 ? predictions : undefined;
	}
	
	/**
	 * Enable/disable detection
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.logger?.infoSync(`Anomaly detection ${enabled ? 'enabled' : 'disabled'}`, {
			component: LogComponents.metrics,
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
			clearInterval(this.baselineSaveTimer);
			this.baselineSaveTimer = undefined;
		}
		
		// Stop storage service
		if (this.storage) {
			this.storage.stop();
			this.storage = undefined;
		}
		
		this.logger?.infoSync('Anomaly detection service stopped and cleaned up', {
			component: LogComponents.metrics,
		});
	}
	
	/**
	 * Update configuration
	 */
	updateConfig(config: Partial<AnomalyConfig>): void {
		this.config = { ...this.config, ...config };
		
		// Update storage retention if changed (default to 30 if not specified)
		if (this.storage && config.storage?.retention !== undefined) {
			this.storage.updateRetention(config.storage.retention);
		}
		
		this.logger?.infoSync('Anomaly detection configuration updated', {
			component: LogComponents.metrics,
		});
	}
	
	/**
	 * Start periodic baseline saving
	 */
	private startPeriodicBaselineSave(): void {
		if (!this.storage) return;
		
		this.baselineSaveTimer = setInterval(() => {
			this.saveBaselines();
		}, this.baselineSaveIntervalMs);
		
		this.logger?.infoSync('Started periodic baseline saving', {
			component: LogComponents.metrics,
			interval_hours: this.baselineSaveIntervalMs / (60 * 60 * 1000),
		});
	}
	
	/**
	 * Save current statistical baselines to database
	 * Public for manual triggering and testing
	 */
	async saveBaselines(): Promise<void> {
		if (!this.storage) {
			this.logger?.warnSync('Cannot save baselines - storage not initialized', {
				component: LogComponents.metrics,
			});
			return;
		}
		
		const now = Date.now();
		let savedCount = 0;
		let skippedCount = 0;
		
		// Minimum samples required for statistical baseline (default: 5 samples = ~5 minutes at 60s interval)
		const minSamples = this.config.storage?.minSamples ?? 5;
		
		// Debug: Log buffer sizes before saving
		const bufferSizes: Record<string, number> = {};
		for (const [metricName, buffer] of this.buffers.entries()) {
			bufferSizes[metricName] = buffer.size;
		}
		
		this.logger?.infoSync('Baseline save starting', {
			component: LogComponents.metrics,
			minSamples,
			bufferSizes,
		});
		
		// Save all baselines in parallel
		const savePromises: Promise<void>[] = [];
		
		for (const [metricName, buffer] of this.buffers.entries()) {
			if (buffer.size >= minSamples) {
				savePromises.push(
					this.storage.storeBaseline(metricName, buffer, now).catch(error => {
						this.logger?.errorSync('Failed to save baseline', error as Error, {
							component: LogComponents.metrics,
							metric: metricName,
						});
					})
				);
				savedCount++;
			} else {
				this.logger?.infoSync('Skipping baseline save - insufficient samples', {
					component: LogComponents.metrics,
					metric: metricName,
					bufferSize: buffer.size,
					required: minSamples,
				});
				skippedCount++;
			}
		}
		
		// Wait for all saves to complete
		await Promise.all(savePromises);
		
		this.logger?.infoSync('Baseline save completed', {
			component: LogComponents.metrics,
			saved: savedCount,
			skipped: skippedCount,
			totalBuffers: this.buffers.size,
		});
	}
	
	/**
	 * Get storage service (for external queries)
	 */
	getStorage(): AnomalyStorageService | undefined {
		return this.storage;
	}
}
