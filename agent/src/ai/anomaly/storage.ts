/**
 * ANOMALY STORAGE SERVICE
 * ========================
 * 
 * SQLite storage layer for anomaly detection alerts and baselines.
 * Uses the existing device.sqlite database with dedicated tables.
 */

import type { Knex } from 'knex';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type { AnomalyAlert, StatisticalBuffer } from './types';
import { getMedian, getMAD } from './buffer';

export interface AnomalyAlertRecord {
	id?: number;
	alert_id: string;
	severity: string;
	metric: string;
	value: number;
	expected_min: number | null;
	expected_max: number | null;
	deviation: number;
	detection_method: string;
	timestamp: number;
	confidence: number;
	context: string; // JSON string
	message: string | null;
	fingerprint: string;
	count: number;
	created_at?: Date;
}

export interface AnomalyBaselineRecord {
	id?: number;
	metric: string;
	mean: number | null;
	median: number | null;
	std_dev: number | null;
	mad: number | null;
	min: number | null;
	max: number | null;
	q1: number | null;
	q3: number | null;
	iqr: number | null;
	sample_count: number;
	calculated_at: number;
	window_start: number | null;
	window_end: number | null;
	created_at?: Date;
	updated_at?: Date;
}

export class AnomalyStorageService {
	private db: Knex;
	private logger?: AgentLogger;
	private retention: number;
	private cleanupIntervalMs: number = 86400000; // 24 hours
	private cleanupTimer?: NodeJS.Timeout;

	constructor(db: Knex, retention: number, logger?: AgentLogger) {
		this.db = db;
		this.retention = retention;
		this.logger = logger;
	}

	/**
	 * Initialize storage service and start cleanup job
	 */
	async initialize(): Promise<void> {
		// Verify tables exist
		const alertsTableExists = await this.db.schema.hasTable('anomaly_alerts');
		const baselinesTableExists = await this.db.schema.hasTable('anomaly_baselines');

		if (!alertsTableExists || !baselinesTableExists) {
			throw new Error(
				'Anomaly detection tables not found. Run database migrations first.'
			);
		}

		this.logger?.infoSync('Anomaly storage service initialized', {
			component: LogComponents.metrics,
			retention: this.retention,
		});

		// Start periodic cleanup
		this.startPeriodicCleanup();
	}

	/**
	 * Store an anomaly alert
	 */
	async storeAlert(alert: AnomalyAlert): Promise<void> {
		try {
			const record: AnomalyAlertRecord = {
				alert_id: alert.id,
				severity: alert.severity,
				metric: alert.metric,
				value: alert.value,
				expected_min: alert.expectedRange[0],
				expected_max: alert.expectedRange[1],
				deviation: alert.deviation,
				detection_method: alert.detectionMethod,
				timestamp: alert.timestamp,
				confidence: alert.confidence,
				context: JSON.stringify(alert.context),
				message: alert.message,
				fingerprint: alert.fingerprint,
				count: alert.count,
			};

			await this.db('anomaly_alerts').insert(record);

			this.logger?.debugSync('Stored anomaly alert', {
				component: LogComponents.metrics,
				alert_id: alert.id,
				metric: alert.metric,
				severity: alert.severity,
			});
		} catch (error) {
			this.logger?.errorSync('Failed to store anomaly alert', error as Error, {
				component: LogComponents.metrics,
				alert_id: alert.id,
			});
		}
	}

	/**
	 * Store statistical baseline for a metric
	 */
	async storeBaseline(
		metric: string,
		buffer: StatisticalBuffer,
		calculatedAt: number
	): Promise<void> {
		try {
			// Calculate percentiles for IQR
			const sortedValues = [...buffer.values].slice(0, buffer.size).sort((a, b) => a - b);
			const q1Index = Math.floor(buffer.size * 0.25);
			const q3Index = Math.floor(buffer.size * 0.75);
			const q1 = sortedValues[q1Index] || null;
			const q3 = sortedValues[q3Index] || null;
			const iqr = q1 !== null && q3 !== null ? q3 - q1 : null;

			const record: AnomalyBaselineRecord = {
				metric,
				mean: buffer.mean,
				median: getMedian(buffer),
				std_dev: Math.sqrt(buffer.variance),
				mad: getMAD(buffer),
				min: Math.min(...buffer.values.slice(0, buffer.size)),
				max: Math.max(...buffer.values.slice(0, buffer.size)),
				q1,
				q3,
				iqr,
				sample_count: buffer.size,
				calculated_at: calculatedAt,
				window_start: buffer.timestamps[0] || null,
				window_end: buffer.timestamps[buffer.size - 1] || null,
			};

		this.logger?.debugSync('Inserting baseline record', {
			component: LogComponents.metrics,
			metric,
			sample_count: buffer.size,
			mean: record.mean,
			median: record.median,
		});

			await this.db('anomaly_baselines').insert(record);

			this.logger?.infoSync('Stored anomaly baseline', {
				component: LogComponents.metrics,
				metric,
				sample_count: buffer.size,
				mean: record.mean,
				median: record.median,
			});
		} catch (error) {
			this.logger?.errorSync('Failed to store anomaly baseline', error as Error, {
				component: LogComponents.metrics,
				metric,
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
			// Re-throw to propagate error
			throw error;
		}
	}

	/**
	 * Get recent alerts for a metric
	 */
	async getRecentAlerts(
		metric: string,
		limit: number = 100
	): Promise<AnomalyAlertRecord[]> {
		try {
			const alerts = await this.db('anomaly_alerts')
				.where({ metric })
				.orderBy('timestamp', 'desc')
				.limit(limit);

			return alerts;
		} catch (error) {
			this.logger?.errorSync('Failed to fetch recent alerts', error as Error, {
				component: LogComponents.metrics,
				metric,
			});
			return [];
		}
	}

	/**
	 * Get alerts within a time range
	 */
	async getAlertsByTimeRange(
		startTimestamp: number,
		endTimestamp: number,
		metric?: string
	): Promise<AnomalyAlertRecord[]> {
		try {
			let query = this.db('anomaly_alerts')
				.whereBetween('timestamp', [startTimestamp, endTimestamp])
				.orderBy('timestamp', 'desc');

			if (metric) {
				query = query.where({ metric });
			}

			return await query;
		} catch (error) {
			this.logger?.errorSync('Failed to fetch alerts by time range', error as Error, {
				component: LogComponents.metrics,
			});
			return [];
		}
	}

	/**
	 * Get latest baseline for a metric
	 */
	async getLatestBaseline(metric: string): Promise<AnomalyBaselineRecord | null> {
		try {
			const baseline = await this.db('anomaly_baselines')
				.where({ metric })
				.orderBy('calculated_at', 'desc')
				.first();

			return baseline || null;
		} catch (error) {
			this.logger?.errorSync('Failed to fetch latest baseline', error as Error, {
				component: LogComponents.metrics,
				metric,
			});
			return null;
		}
	}

	/**
	 * Get alert statistics for a metric
	 */
	async getAlertStats(metric: string, days: number = 7): Promise<{
		total: number;
		by_severity: Record<string, number>;
		by_method: Record<string, number>;
	}> {
		try {
			const cutoffTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

			const alerts = await this.db('anomaly_alerts')
				.where({ metric })
				.where('timestamp', '>=', cutoffTimestamp);

			const stats = {
				total: alerts.length,
				by_severity: {} as Record<string, number>,
				by_method: {} as Record<string, number>,
			};

			for (const alert of alerts) {
				// Count by severity
				stats.by_severity[alert.severity] = (stats.by_severity[alert.severity] || 0) + 1;
				
				// Count by detection method
				stats.by_method[alert.detection_method] =
					(stats.by_method[alert.detection_method] || 0) + 1;
			}

			return stats;
		} catch (error) {
			this.logger?.errorSync('Failed to calculate alert stats', error as Error, {
				component: LogComponents.metrics,
				metric,
			});
			return { total: 0, by_severity: {}, by_method: {} };
		}
	}

	/**
	 * Clean up old records based on historyDays configuration
	 */
	async cleanup(): Promise<void> {
		try {
			const cutoffTimestamp = Date.now() - this.retention * 24 * 60 * 60 * 1000;

			// Delete old alerts
			const deletedAlerts = await this.db('anomaly_alerts')
				.where('timestamp', '<', cutoffTimestamp)
				.delete();

			// Delete old baselines
			const deletedBaselines = await this.db('anomaly_baselines')
				.where('calculated_at', '<', cutoffTimestamp)
				.delete();

			if (deletedAlerts > 0 || deletedBaselines > 0) {
				this.logger?.infoSync('Cleaned up old anomaly records', {
					component: LogComponents.metrics,
					deleted_alerts: deletedAlerts,
					deleted_baselines: deletedBaselines,
					retention_days: this.retention,
				});
			}
		} catch (error) {
			this.logger?.errorSync('Failed to cleanup old anomaly records', error as Error, {
				component: LogComponents.metrics,
			});
		}
	}

	/**
	 * Start periodic cleanup job
	 */
	private startPeriodicCleanup(): void {
		// Run cleanup immediately
		this.cleanup();

		// Schedule periodic cleanup (every 24 hours)
		this.cleanupTimer = setInterval(() => {
			this.cleanup();
		}, this.cleanupIntervalMs);

		this.logger?.infoSync('Started periodic anomaly cleanup', {
			component: LogComponents.metrics,
			interval_hours: this.cleanupIntervalMs / (60 * 60 * 1000),
		});
	}

	/**
	 * Stop the storage service and cleanup timers
	 */
	stop(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}

		this.logger?.infoSync('Anomaly storage service stopped', {
			component: LogComponents.metrics,
		});
	}

	/**
	 * Update retention period
	 */
	updateRetention(days: number): void {
		this.retention = days;
		this.logger?.infoSync('Updated anomaly retention period', {
			component: LogComponents.metrics,
			retention: days,
		});
	}
}
