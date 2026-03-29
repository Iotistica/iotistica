/**
 * ANOMALY STORAGE SERVICE
 * ========================
 * 
 * SQLite storage layer for anomaly detection alerts and baselines.
 * Uses the existing agent.sqlite database with dedicated tables.
 */

type Knex = any;
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import type { AnomalyAlert, CanonicalDeviceState, StatisticalBuffer } from './types';
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
	// Suppression metadata
	cooldown_sec: number;
	first_seen: number;
	consecutive_count: number;
}

export interface AnomalyBaselineRecord {
	id?: number;
	metric: string;
	device_id: string;
	profile: string | null; // Profile config identifier (e.g., 'Generic', 'COMAP')
	time_slot: number; // -1 for overall, 0-1 for day/night, 0-23 for hourly, 0-167 for weekly
	device_state: CanonicalDeviceState;
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
			component: LogComponents.anomaly,
			retention: this.retention,
		});

		// Start periodic cleanup
		this.startPeriodicCleanup();
	}

	/**
	 * Store an anomaly alert
	 * Backward compatible: falls back to old schema if suppression columns don't exist
	 */
	async storeAlert(alert: AnomalyAlert): Promise<void> {
		try {
			const expectedRange = Array.isArray(alert.expectedRange)
				? alert.expectedRange
				: undefined;

			const record: AnomalyAlertRecord = {
				alert_id: alert.id,
				severity: alert.severity,
				metric: alert.metric,
				value: alert.value,
				expected_min: expectedRange?.[0] ?? null,
				expected_max: expectedRange?.[1] ?? null,
				deviation: alert.deviation,
				detection_method: alert.detectionMethod,
				timestamp: alert.timestamp,
				confidence: alert.confidence,
				context: JSON.stringify(alert.context),
				message: alert.message,
				fingerprint: alert.fingerprint,
				count: alert.count,
				// Suppression metadata
				cooldown_sec: alert.cooldownSec,
				first_seen: alert.firstSeen,
				consecutive_count: alert.consecutiveCount,
			};

			try {
				await this.db('anomaly_alerts').insert(record);
			} catch (insertError: any) {
				// Backward compatibility: if suppression columns don't exist, insert without them
				if (insertError?.message?.includes('no such column: cooldown_sec') ||
				    insertError?.message?.includes('no such column: first_seen') ||
				    insertError?.message?.includes('no such column: consecutive_count') ||
				    insertError?.message?.includes('has no column named cooldown_sec')) {
					this.logger?.debugSync('Inserting alert without suppression metadata (legacy schema)', {
						component: LogComponents.anomaly,
						alert_id: alert.id,
						note: 'Run migration 003_add_alert_suppression_metadata.sql to enable suppression tracking',
					});
					
					// Create record without suppression fields
					const { cooldown_sec, first_seen, consecutive_count, ...legacyRecord } = record;
					await this.db('anomaly_alerts').insert(legacyRecord);
				} else {
					throw insertError;
				}
			}

			this.logger?.debugSync('Stored anomaly alert', {
				component: LogComponents.anomaly,
				alert_id: alert.id,
				metric: alert.metric,
				severity: alert.severity,
			});
		} catch (error) {
			this.logger?.errorSync('Failed to store anomaly alert', error as Error, {
				component: LogComponents.anomaly,
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
		calculatedAt: number,
		timeSlot: number = -1, // -1 = overall baseline (default)
		profile: string | null = null, // Profile identifier (null for system metrics)
		deviceState: CanonicalDeviceState = 'unknown',
		deviceId: string = 'unknown-device'
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
				device_id: deviceId,
				profile,
				time_slot: timeSlot,
				device_state: deviceState,
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
				component: LogComponents.anomaly,
				metric,
				device_id: deviceId,
				device_state: deviceState,
				sample_count: buffer.size,
				mean: record.mean,
				median: record.median,
			});

		// Use INSERT OR REPLACE to handle updates (SQLite upsert)
		// MEMORY LEAK FIX: Use Knex query builder instead of raw() to avoid template string accumulation
		try {
			await this.db('anomaly_baselines')
				.insert(record)
				.onConflict(['metric', 'profile', 'time_slot', 'device_state', 'device_id'])
				.merge();
		} catch (insertError: any) {
			if (
				insertError?.message?.includes('no such column: device_state') ||
				insertError?.message?.includes('has no column named device_state') ||
				insertError?.message?.includes('no such column: device_id') ||
				insertError?.message?.includes('has no column named device_id')
			) {
				this.logger?.debugSync('Storing baseline without device_state/device_id (legacy schema)', {
					component: LogComponents.anomaly,
					metric,
					device_id: deviceId,
					device_state: deviceState,
					note: 'Run migration 20260316000000_add_anomaly_baseline_device_state.js to enable state-aware baselines',
				});

				const { device_state, device_id, ...legacyRecord } = record;
				await this.db('anomaly_baselines')
					.insert(legacyRecord)
					.onConflict(['metric', 'profile', 'time_slot'])
					.merge();
			} else {
				throw insertError;
			}
		}
	} catch (error) {
		this.logger?.errorSync('Failed to store anomaly baseline', error as Error, {
			component: LogComponents.anomaly,
			metric,
			device_id: deviceId,
			device_state: deviceState,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		// Don't re-throw - baseline storage failures shouldn't break anomaly detection
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
				component: LogComponents.anomaly,
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
				component: LogComponents.anomaly,
			});
			return [];
		}
	}

	/**
	 * Check if sufficient baselines exist for warm-up skip logic
	 * Returns true if baselines exist for at least minCoveragePercent of metrics with minSamples each
	 */
	async checkBaselineCoverage(
		metrics: string[],
		minSamples: number = 30,
		minCoveragePercent: number = 0.8
	): Promise<{ hasCoverage: boolean; coveragePercent: number; metricsWithBaselines: number }> {
		if (metrics.length === 0) {
			return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
		}

		try {
			// Find metrics with ANY baselines (have been collected at least once)
			// Support both exact matches (e.g., "temperature") and canonical keys (e.g., "8602805f-..._c11224a6-..._temperature")
			let anyBaselinesQuery = this.db('anomaly_baselines');
			
			// Build OR condition: exact match OR metric ends with "_<metricName>"
			anyBaselinesQuery = anyBaselinesQuery.where((qb: any) => {
				qb.whereIn('metric', metrics); // Exact match for short names
				for (const metric of metrics) {
					qb.orWhere('metric', 'like', `%_${metric}`); // Canonical key match
				}
			});
			
			const anyBaselines = await anyBaselinesQuery
				.select('metric')
				.groupBy('metric');
			
			const collectibleMetrics = anyBaselines.length;
			
			// If no metrics have ever been collected, can't skip warm-up
			if (collectibleMetrics === 0) {
				return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
			}
			
			// Find metrics with SUFFICIENT baselines (minSamples+)
			let sufficientBaselinesQuery = this.db('anomaly_baselines')
				.where('sample_count', '>=', minSamples);
		
			// Build OR condition: exact match OR metric ends with "_<metricName>"
			sufficientBaselinesQuery = sufficientBaselinesQuery.where((qb: any) => {
				qb.whereIn('metric', metrics); // Exact match for short names
				for (const metric of metrics) {
					qb.orWhere('metric', 'like', `%_${metric}`); // Canonical key match
				}
			});
		
			const sufficientBaselines = await sufficientBaselinesQuery
				.select('metric')
				.groupBy('metric');

			const metricsWithBaselines = sufficientBaselines.length;
			// Coverage = sufficient / collectible (excludes never-collected metrics like cpu_temp on Windows)
			const coveragePercent = metricsWithBaselines / collectibleMetrics;
			const hasCoverage = coveragePercent >= minCoveragePercent;

			return { hasCoverage, coveragePercent, metricsWithBaselines };
		} catch (error: any) {
			this.logger?.warnSync('Failed to check baseline coverage', {
				component: LogComponents.anomaly,
				error: error.message,
			});
			return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
		}
	}

	/**
	 * Get the latest baseline for a metric by metric name only, ignoring device_id and device_state.
	 * Used by live simulation interceptor to look up baselines using the full canonical metric key.
	 */
	async getBaselineForMetric(
		metric: string,
		minimumSamples: number = 10,
	): Promise<AnomalyBaselineRecord | null> {
		const result = await this.db('anomaly_baselines')
			.where({ metric })
			.where('sample_count', '>=', minimumSamples)
			.orderBy('calculated_at', 'desc')
			.first();
		return result ?? null;
	}

	/**
	 * Get latest baseline for a metric and time slot
	 * Falls back to overall baseline (-1) if seasonal baseline not found or has insufficient data
	 * Backward compatible: falls back to old schema if time_slot column doesn't exist
	 * Automatically retries with pool recovery on timeout
	 */
	async getLatestBaseline(
		metric: string,
		timeSlot: number = -1,
		minimumSamples: number = 10,
		profile: string | null = null, // Filter by profile (null for system metrics)
		deviceState: CanonicalDeviceState = 'unknown',
		deviceId: string = 'unknown-device'
	): Promise<AnomalyBaselineRecord | null> {
		const deviceCandidates = [deviceId];
		if (deviceId !== 'unknown-device') {
			deviceCandidates.push('unknown-device');
		}

		// Try to get seasonal baseline first
		if (timeSlot !== -1) {
			try {
				let seasonalBaseline: AnomalyBaselineRecord | null = null;
				for (const candidateDeviceId of deviceCandidates) {
					const query = this.db('anomaly_baselines')
						.where({
							metric,
							time_slot: timeSlot,
							device_state: deviceState,
							device_id: candidateDeviceId,
						});
					if (profile !== null) {
						query.where({ profile });
					}

					seasonalBaseline = await query
						.orderBy('calculated_at', 'desc')
						.first();

					if (!seasonalBaseline && deviceState !== 'unknown') {
						const unknownStateQuery = this.db('anomaly_baselines')
							.where({
								metric,
								time_slot: timeSlot,
								device_state: 'unknown',
								device_id: candidateDeviceId,
							});
						if (profile !== null) {
							unknownStateQuery.where({ profile });
						}
						seasonalBaseline = await unknownStateQuery
							.orderBy('calculated_at', 'desc')
							.first();
					}

					if (seasonalBaseline) {
						break;
					}
				}
				
				// Use seasonal baseline if it has enough samples
				if (seasonalBaseline && seasonalBaseline.sample_count >= minimumSamples) {
					return seasonalBaseline;
				}
				
				// Fall back to overall baseline if seasonal baseline insufficient
				this.logger?.debugSync('Seasonal baseline insufficient, falling back to overall', {
					component: LogComponents.anomaly,
					metric,
					deviceState,
					timeSlot,
					samples: seasonalBaseline?.sample_count || 0,
					minimumSamples,
				});
			} catch (seasonalError: any) {
				// Backward compatibility: if time_slot column doesn't exist, fall back to old schema
				if (seasonalError?.message?.includes('no such column: time_slot')) {
					this.logger?.debugSync('Seasonality not supported (time_slot column missing), using legacy baseline', {
						component: LogComponents.anomaly,
						metric,
						note: 'Run migration 002_add_seasonality_support.sql to enable seasonality',
					});
					// Fall through to overall baseline query without time_slot
				} else if (
					seasonalError?.message?.includes('no such column: device_state') ||
					seasonalError?.message?.includes('no such column: device_id')
				) {
					this.logger?.debugSync('State/device-aware baselines not supported (device_state/device_id column missing), using legacy baseline', {
						component: LogComponents.anomaly,
						metric,
						deviceState,
						deviceId,
						note: 'Run migration 20260316000000_add_anomaly_baseline_device_state.js to enable state-aware baselines',
					});
				} else {
					throw seasonalError;
				}
			}
		}
		
		// Get overall baseline (time_slot = -1) or legacy baseline (no time_slot)
		try {
			for (const candidateDeviceId of deviceCandidates) {
				const query = this.db('anomaly_baselines')
					.where({
						metric,
						time_slot: -1,
						device_state: deviceState,
						device_id: candidateDeviceId,
					});

				if (profile !== null) {
					query.where({ profile });
				}

				let baseline = await query
					.orderBy('calculated_at', 'desc')
					.first();

				if (!baseline && deviceState !== 'unknown') {
					const unknownStateQuery = this.db('anomaly_baselines')
						.where({
							metric,
							time_slot: -1,
							device_state: 'unknown',
							device_id: candidateDeviceId,
						});
					if (profile !== null) {
						unknownStateQuery.where({ profile });
					}
					baseline = await unknownStateQuery
						.orderBy('calculated_at', 'desc')
						.first();
				}

				if (baseline) {
					return baseline;
				}
			}

			return null;
		} catch (overallError: any) {
			// Backward compatibility: if time_slot column doesn't exist, query without it
			if (
				overallError?.message?.includes('no such column: time_slot') ||
				overallError?.message?.includes('no such column: device_state') ||
				overallError?.message?.includes('no such column: device_id')
			) {
				const legacyBaseline = await this.db('anomaly_baselines')
					.where({ metric })
					.orderBy('calculated_at', 'desc')
					.first();
				
				return legacyBaseline || null;
			}
			throw overallError;
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
				component: LogComponents.anomaly,
				metric,
			});
			return { total: 0, by_severity: {}, by_method: {} };
		}
	}

	/**
	 * Clear baselines for a specific profile (OPTIONAL - for manual cleanup only)
	 * Normally not needed - profile field automatically filters baselines
	 * Use only when permanently removing a profile config from system
	 * @param profile - Profile identifier (e.g., 'Generic', 'COMAP')
	 * @param metricPattern - Optional metric pattern (e.g., 'modbus_%' for all Modbus metrics)
	 */
	async clearBaselinesForProfile(profile: string, metricPattern?: string): Promise<number> {
		try {
			const query = this.db('anomaly_baselines').where({ profile });
			
			// Optional: filter by metric pattern (SQLite LIKE)
			if (metricPattern) {
				query.where('metric', 'like', metricPattern);
			}
			
			const deleted = await query.delete();
			
			if (deleted > 0) {
				this.logger?.infoSync('Cleared baselines after profile change', {
					component: LogComponents.anomaly,
					profile,
					metricPattern: metricPattern || 'all',
					deleted,
				});
			}
			
			return deleted;
		} catch (error) {
			this.logger?.errorSync('Failed to clear baselines for profile', error as Error, {
				component: LogComponents.anomaly,
				profile,
				metricPattern,
			});
			return 0;
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
					component: LogComponents.anomaly,
					deleted_alerts: deletedAlerts,
					deleted_baselines: deletedBaselines,
					retention_days: this.retention,
				});
			}
		} catch (error) {
			this.logger?.errorSync('Failed to cleanup old anomaly records', error as Error, {
				component: LogComponents.anomaly,
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
		this.cleanupTimer = (globalThis as any).setInterval(() => {
			this.cleanup();
		}, this.cleanupIntervalMs);

		this.logger?.infoSync('Started periodic anomaly cleanup', {
			component: LogComponents.anomaly,
			interval_hours: this.cleanupIntervalMs / (60 * 60 * 1000),
		});
	}

	/**
	 * Stop the storage service and cleanup timers
	 */
	stop(): void {
		if (this.cleanupTimer) {
			(globalThis as any).clearInterval(this.cleanupTimer);
			this.cleanupTimer = undefined;
		}

		this.logger?.infoSync('Anomaly storage service stopped', {
			component: LogComponents.anomaly,
		});
	}

	/**
	 * Update retention period
	 */
	updateRetention(days: number): void {
		this.retention = days;
		this.logger?.infoSync('Updated anomaly retention period', {
			component: LogComponents.anomaly,
			retention: days,
		});
	}
}
