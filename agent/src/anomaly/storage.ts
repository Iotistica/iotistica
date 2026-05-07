/**
 * ANOMALY STORAGE SERVICE
 * ========================
 * 
 * SQLite storage layer for anomaly detection alerts and baselines.
 * Uses the existing agent.sqlite database with dedicated tables.
 */

import type Database from 'better-sqlite3';
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

type AnomalyAlertRow = Omit<AnomalyAlertRecord, 'created_at'> & {
	created_at?: string | Date | null;
};

type AnomalyBaselineRow = Omit<AnomalyBaselineRecord, 'created_at' | 'updated_at'> & {
	created_at?: string | Date | null;
	updated_at?: string | Date | null;
};

export class AnomalyStorageService {
	private db: Database.Database;
	private logger?: AgentLogger;
	private retention: number;
	private cleanupIntervalMs: number = 86400000; // 24 hours
	private cleanupTimer?: NodeJS.Timeout;
	private readonly tableColumns = new Map<string, Set<string>>();

	constructor(db: Database.Database, retention: number, logger?: AgentLogger) {
		this.db = db;
		this.retention = retention;
		this.logger = logger;
	}

	private hasTable(tableName: 'anomaly_alerts' | 'anomaly_baselines'): boolean {
		const row = this.db
			.prepare(`
				SELECT name
				FROM sqlite_master
				WHERE type = 'table' AND name = ?
				LIMIT 1
			`)
			.get(tableName) as { name?: string } | undefined;

		return row?.name === tableName;
	}

	private getTableColumns(tableName: 'anomaly_alerts' | 'anomaly_baselines'): Set<string> {
		const cached = this.tableColumns.get(tableName);
		if (cached) {
			return cached;
		}

		const rows = this.db
			.prepare(`PRAGMA table_info(${tableName})`)
			.all() as Array<{ name: string }>;

		const columns = new Set(rows.map((row) => row.name));
		this.tableColumns.set(tableName, columns);
		return columns;
	}

	private hasColumn(tableName: 'anomaly_alerts' | 'anomaly_baselines', columnName: string): boolean {
		return this.getTableColumns(tableName).has(columnName);
	}

	private mapAlertRow(row: AnomalyAlertRow): AnomalyAlertRecord {
		return {
			...row,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
		};
	}

	private mapBaselineRow(row: AnomalyBaselineRow): AnomalyBaselineRecord {
		return {
			...row,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
			updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
		};
	}

	private buildInsertStatement(
		tableName: string,
		record: Record<string, unknown>,
		conflictColumns?: string[],
	): { sql: string; values: unknown[] } {
		const columns = Object.keys(record);
		const placeholders = columns.map(() => '?').join(', ');
		const values = columns.map((column) => record[column]);
		let sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

		if (conflictColumns && conflictColumns.length > 0) {
			const updateColumns = columns.filter((column) => !conflictColumns.includes(column));
			const updateClause = updateColumns
				.map((column) => `${column} = excluded.${column}`)
				.join(', ');
			sql += ` ON CONFLICT(${conflictColumns.join(', ')}) DO UPDATE SET ${updateClause}`;
		}

		return { sql, values };
	}

	private getBaselineSchema() {
		return {
			hasTimeSlot: this.hasColumn('anomaly_baselines', 'time_slot'),
			hasDeviceState: this.hasColumn('anomaly_baselines', 'device_state'),
			hasDeviceId: this.hasColumn('anomaly_baselines', 'device_id'),
		};
	}

	private buildMetricMatchClause(metrics: string[]): { clause: string; params: unknown[] } {
		const exactClause = metrics.map(() => '?').join(', ');
		const likeClause = metrics.map(() => 'metric LIKE ?').join(' OR ');
		return {
			clause: `(metric IN (${exactClause}) OR ${likeClause})`,
			params: [...metrics, ...metrics.map((metric) => `%_${metric}`)],
		};
	}

	private queryBaseline(
		metric: string,
		options: {
			timeSlot?: number;
			profile?: string | null;
			deviceState?: CanonicalDeviceState;
			deviceId?: string;
			minimumSamples?: number;
		},
	): AnomalyBaselineRecord | null {
		const whereParts = ['metric = ?'];
		const params: unknown[] = [metric];
		const schema = this.getBaselineSchema();

		if (typeof options.minimumSamples === 'number') {
			whereParts.push('sample_count >= ?');
			params.push(options.minimumSamples);
		}

		if (schema.hasTimeSlot && typeof options.timeSlot === 'number') {
			whereParts.push('time_slot = ?');
			params.push(options.timeSlot);
		}

		if (options.profile !== null && options.profile !== undefined) {
			whereParts.push('profile = ?');
			params.push(options.profile);
		}

		if (schema.hasDeviceState && options.deviceState) {
			whereParts.push('device_state = ?');
			params.push(options.deviceState);
		}

		if (schema.hasDeviceId && options.deviceId) {
			whereParts.push('device_id = ?');
			params.push(options.deviceId);
		}

		const row = this.db
			.prepare(`
				SELECT *
				FROM anomaly_baselines
				WHERE ${whereParts.join(' AND ')}
				ORDER BY calculated_at DESC
				LIMIT 1
			`)
			.get(...params) as AnomalyBaselineRow | undefined;

		return row ? this.mapBaselineRow(row) : null;
	}

	/**
	* Initialize storage service and start cleanup job
	*/
	async initialize(): Promise<void> {
		// Verify tables exist
		const alertsTableExists = this.hasTable('anomaly_alerts');
		const baselinesTableExists = this.hasTable('anomaly_baselines');

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

			const hasSuppressionMetadata =
				this.hasColumn('anomaly_alerts', 'cooldown_sec') &&
				this.hasColumn('anomaly_alerts', 'first_seen') &&
				this.hasColumn('anomaly_alerts', 'consecutive_count');

			const insertRecord = hasSuppressionMetadata
				? record
				: (() => {
					this.logger?.debugSync('Inserting alert without suppression metadata (legacy schema)', {
						component: LogComponents.anomaly,
						alert_id: alert.id,
						note: 'Run migration 003_add_alert_suppression_metadata.sql to enable suppression tracking',
					});
					const {
						cooldown_sec: _cooldown_sec,
						first_seen: _first_seen,
						consecutive_count: _consecutive_count,
						...legacyRecord
					} = record;
					return legacyRecord;
				})();

			const { sql, values } = this.buildInsertStatement('anomaly_alerts', insertRecord as unknown as Record<string, unknown>);
			this.db.prepare(sql).run(...values);

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
			const schema = this.getBaselineSchema();
			// Calculate percentiles for IQR
			const sortedValues = [...buffer.values].slice(0, buffer.size).sort((a, b) => a - b);
			const q1Index = Math.floor(buffer.size * 0.25);
			const q3Index = Math.floor(buffer.size * 0.75);
			const q1 = sortedValues[q1Index] || null;
			const q3 = sortedValues[q3Index] || null;
			const iqr = q1 !== null && q3 !== null ? q3 - q1 : null;

			const record: Record<string, unknown> = {
				metric,
				profile,
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

			if (schema.hasTimeSlot) {
				record.time_slot = timeSlot;
			}
			if (schema.hasDeviceState) {
				record.device_state = deviceState;
			}
			if (schema.hasDeviceId) {
				record.device_id = deviceId;
			}

			this.logger?.debugSync('Inserting baseline record', {
				component: LogComponents.anomaly,
				metric,
				device_id: deviceId,
				device_state: deviceState,
				sample_count: buffer.size,
				mean: record.mean,
				median: record.median,
			});

			if (!schema.hasDeviceState || !schema.hasDeviceId) {
				this.logger?.debugSync('Storing baseline without full state/device schema', {
					component: LogComponents.anomaly,
					metric,
					device_id: deviceId,
					device_state: deviceState,
					note: 'Run anomaly baseline schema migrations to enable full state-aware baselines',
				});
			}

			const conflictColumns = ['metric', 'profile'];
			if (schema.hasTimeSlot) {
				conflictColumns.push('time_slot');
			}
			if (schema.hasDeviceState) {
				conflictColumns.push('device_state');
			}
			if (schema.hasDeviceId) {
				conflictColumns.push('device_id');
			}

			const { sql, values } = this.buildInsertStatement('anomaly_baselines', record, conflictColumns);
			this.db.prepare(sql).run(...values);
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
			const alerts = this.db
				.prepare(`
					SELECT *
					FROM anomaly_alerts
					WHERE metric = ?
					ORDER BY timestamp DESC
					LIMIT ?
				`)
				.all(metric, limit) as AnomalyAlertRow[];

			return alerts.map((alert) => this.mapAlertRow(alert));
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
			const whereParts = ['timestamp BETWEEN ? AND ?'];
			const params: unknown[] = [startTimestamp, endTimestamp];

			if (metric) {
				whereParts.push('metric = ?');
				params.push(metric);
			}

			const alerts = this.db
				.prepare(`
					SELECT *
					FROM anomaly_alerts
					WHERE ${whereParts.join(' AND ')}
					ORDER BY timestamp DESC
				`)
				.all(...params) as AnomalyAlertRow[];

			return alerts.map((alert) => this.mapAlertRow(alert));
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
			const { clause, params } = this.buildMetricMatchClause(metrics);
			// Find metrics with ANY baselines (have been collected at least once)
			// Support both exact matches (e.g., "temperature") and canonical keys (e.g., "8602805f-..._c11224a6-..._temperature")
			const anyBaselines = this.db
				.prepare(`
					SELECT metric
					FROM anomaly_baselines
					WHERE ${clause}
					GROUP BY metric
				`)
				.all(...params) as Array<{ metric: string }>;
			
			const collectibleMetrics = anyBaselines.length;
			
			// If no metrics have ever been collected, can't skip warm-up
			if (collectibleMetrics === 0) {
				return { hasCoverage: false, coveragePercent: 0, metricsWithBaselines: 0 };
			}
			
			// Find metrics with SUFFICIENT baselines (minSamples+)
			const sufficientBaselines = this.db
				.prepare(`
					SELECT metric
					FROM anomaly_baselines
					WHERE sample_count >= ?
					AND ${clause}
					GROUP BY metric
				`)
				.all(minSamples, ...params) as Array<{ metric: string }>;

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
		return this.queryBaseline(metric, { minimumSamples });
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
		const schema = this.getBaselineSchema();
		const deviceCandidates = [deviceId];
		if (schema.hasDeviceId && deviceId !== 'unknown-device') {
			deviceCandidates.push('unknown-device');
		}

		// Try to get seasonal baseline first
		if (schema.hasTimeSlot && timeSlot !== -1) {
			let seasonalBaseline: AnomalyBaselineRecord | null = null;
			for (const candidateDeviceId of deviceCandidates) {
				seasonalBaseline = this.queryBaseline(metric, {
					timeSlot,
					profile,
					deviceState: schema.hasDeviceState ? deviceState : undefined,
					deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
				});

				if (!seasonalBaseline && schema.hasDeviceState && deviceState !== 'unknown') {
					seasonalBaseline = this.queryBaseline(metric, {
						timeSlot,
						profile,
						deviceState: 'unknown',
						deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
					});
				}

				if (seasonalBaseline) {
					break;
				}
			}

			if (seasonalBaseline && seasonalBaseline.sample_count >= minimumSamples) {
				return seasonalBaseline;
			}

			this.logger?.debugSync('Seasonal baseline insufficient, falling back to overall', {
				component: LogComponents.anomaly,
				metric,
				deviceState,
				timeSlot,
				samples: seasonalBaseline?.sample_count || 0,
				minimumSamples,
			});
		}
		
		// Get overall baseline (time_slot = -1) or legacy baseline (no time_slot)
		if (schema.hasTimeSlot) {
			for (const candidateDeviceId of deviceCandidates) {
				let baseline = this.queryBaseline(metric, {
					timeSlot: -1,
					profile,
					deviceState: schema.hasDeviceState ? deviceState : undefined,
					deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
				});

				if (!baseline && schema.hasDeviceState && deviceState !== 'unknown') {
					baseline = this.queryBaseline(metric, {
						timeSlot: -1,
						profile,
						deviceState: 'unknown',
						deviceId: schema.hasDeviceId ? candidateDeviceId : undefined,
					});
				}

				if (baseline) {
					return baseline;
				}
			}
			return null;
		}

		return this.queryBaseline(metric, { minimumSamples: undefined });
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

			const alerts = this.db
				.prepare(`
					SELECT severity, detection_method
					FROM anomaly_alerts
					WHERE metric = ? AND timestamp >= ?
				`)
				.all(metric, cutoffTimestamp) as Array<{ severity: string; detection_method: string }>;

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
			const whereParts = ['profile = ?'];
			const params: unknown[] = [profile];

			if (metricPattern) {
				whereParts.push('metric LIKE ?');
				params.push(metricPattern);
			}

			const deleted = this.db
				.prepare(`DELETE FROM anomaly_baselines WHERE ${whereParts.join(' AND ')}`)
				.run(...params).changes;
			
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
			const deletedAlerts = this.db
				.prepare('DELETE FROM anomaly_alerts WHERE timestamp < ?')
				.run(cutoffTimestamp).changes;

			// Delete old baselines
			const deletedBaselines = this.db
				.prepare('DELETE FROM anomaly_baselines WHERE calculated_at < ?')
				.run(cutoffTimestamp).changes;

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
