/**
 * ANOMALY EVENT HANDLER - CLOUD CORRELATION
 * ==========================================
 * 
 * Receives anomaly events from edge devices via MQTT and performs:
 * - Deduplication by fingerprint
 * - Cross-device correlation into incidents
 * - Severity escalation
 * - Alert triggering
 */

import { randomUUID } from 'crypto';
import { query } from '../db/connection';
import logger from '../utils/logger';

/**
 * Anomaly event from edge device (matches agent schema)
 */
// Regex: metric names are stored as "{endpoint_uuid}_{metric_suffix}" for non-system metrics
const ENDPOINT_METRIC_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i;

/**
 * Extract the device/endpoint UUID from a metric name.
 * Returns the UUID prefix if metric matches "{uuid}_{suffix}", otherwise null.
 */
function extractDeviceUuidFromMetric(metric: string): string | null {
	const match = metric.match(ENDPOINT_METRIC_REGEX);
	return match ? match[1] : null;
}

/**
 * Extract just the metric suffix/name from a canonical metric.
 * Converts "{uuid}_{metric_name}" → "metric_name"
 * If no UUID prefix found, returns the input unchanged.
 */
function extractMetricSuffix(metric: string): string {
	const match = metric.match(ENDPOINT_METRIC_REGEX);
	if (match) {
		// Remove UUID prefix and underscore
		return metric.substring(match[0].length);
	}
	// No UUID prefix, return as-is (e.g., system metrics like "cpu_usage")
	return metric;
}

export interface AnomalyEvent {
	msgId?: string;
	agentUuid: string;          // Edge gateway UUID (infrastructure tracking)
	deviceName: string;         // Monitored device name (e.g., 'COMAP-Main-Controller')
	deviceUuid?: string;        // Per-sensor/endpoint UUID (extracted from metric name)
	deviceType: 'modbus' | 'opcua' | 'bacnet' | 'mqtt' | 'system'; // Protocol/source type
	deviceState?: 'running' | 'idle' | 'fault' | 'unknown'; // Canonical operational state
	metric: string;
	timestampMs: number;
	windowStartMs: number;
	windowEndMs: number;
	observedValue: number;
	baseline: {
		median: number;
		mean: number;
		stdDev: number;
		sampleCount: number;
		method: string;
		source: 'buffer' | 'database';
	};
	anomalyScore: number;
	confidence: number;
	severity: 'info' | 'warning' | 'critical';
	severityReason: string;
	triggeredBy: string[];
	suppressed: boolean;
	expectedRange: [number, number];
	deviation: number;
	fingerprint: string;
	cooldownSec: number;
	firstSeen: number;
	consecutiveCount: number;
	eventCount: number;
}

/**
 * Incident - aggregated anomaly events
 */
export interface Incident {
	incidentId: string;
	fingerprint: string;
	metric: string;
	severity: 'info' | 'warning' | 'critical';
	deviceName: string;         // Primary device name
	deviceUuid: string | null;  // Per-sensor/endpoint UUID (from metric name)
	deviceType: string;         // Protocol/source type
	affectedDevices: string[];  // Array of device names
	affectedAgents: string[];   // Array of agent UUIDs
	firstSeen: number;
	lastSeen: number;
	maxAnomalyScore: number;
	maxConfidence: number;
	eventCount: number;
	status: 'open' | 'active' | 'resolved';
}

/**
 * Alert routing configuration
 */
interface AlertRoute {
	severity: 'info' | 'warning' | 'critical';
	channels: ('database' | 'log')[];
	minAffectedDevices?: number;
}

/**
 * Anomaly Event Handler - Cloud Correlation
 */
export class AnomalyEventHandler {
	private redis: any;
	private readonly incidentTTL = 3600; // 1 hour TTL for incidents in Redis
	
	constructor() {
		// Redis client will be initialized on first use
	}
	
	/**
	 * Initialize Redis connection (lazy-loaded)
	 */
	private async getRedis() {
		if (!this.redis) {
			try {
				const module = await import('../redis/client');
				await module.redisClient.connect(); // Ensure connected
				this.redis = module.redisClient.getClient(); // Get actual Redis instance
			} catch (error) {
				logger.warn('Redis client not available for anomaly correlation caching', {
					error: error instanceof Error ? error.message : String(error)
				});
				return null;
			}
		}
		return this.redis;
	}
	
	/**
	 * Main handler - process anomaly event
	 */
	async handleEvent(event: AnomalyEvent): Promise<void> {
		try {
			// TEMPORARY: Store all events for testing (remove in production)
			// 1. Skip suppressed events (already handled at edge)
			if (event.suppressed) {
				logger.info('⏭️ Suppressed event - storing anyway for testing', {
					agentUuid: event.agentUuid,
					deviceName: event.deviceName,
					metric: event.metric,
					fingerprint: event.fingerprint,
				});
				// Don't return - continue to store
			}
			
			// 2. Store raw event to database
			await this.storeEvent(event);
			logger.info('✅ Event stored, starting correlation', {
				agentUuid: event.agentUuid,
				deviceName: event.deviceName,
				metric: event.metric,
				fingerprint: event.fingerprint
			});
			
			// 3. Get or create incident
			const incident = await this.correlateEvent(event);
			logger.info('✅ Correlation complete', {
				incidentId: incident.incidentId,
				eventCount: incident.eventCount,
				affectedDevices: incident.affectedDevices.length
			});
			
			// 4. Check if alert should be triggered
			if (this.shouldTriggerAlert(incident, event)) {
				await this.triggerAlert(incident, event);
				logger.info('🚨 Alert triggered');
			}
			
			logger.info('Processed anomaly event', {
				agentUuid: event.agentUuid,
				deviceName: event.deviceName,
				deviceType: event.deviceType,
				metric: event.metric,
				severity: event.severity,
				incidentId: incident.incidentId,
				affectedDevices: incident.affectedDevices.length,
			});
			
		} catch (error) {
			logger.error('Failed to process anomaly event', {
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
				agentUuid: event.agentUuid,
				deviceName: event.deviceName,
				metric: event.metric,
			});
			throw error; // Re-throw to see in outer handler
		}
	}
	
	/**
	 * Store event to database
	 */
	private async storeEvent(event: AnomalyEvent): Promise<void> {
		// Log the actual values being inserted
		logger.info('Storing anomaly event to database', {
			msgId: event.msgId,
			agentUuid: event.agentUuid,
			deviceName: event.deviceName,
			deviceType: event.deviceType,
			metric: event.metric,
			timestampMs: event.timestampMs,
			hasTimestampMs: event.timestampMs !== undefined,
			timestampMsType: typeof event.timestampMs
		});
		
		// Calculate deviation if missing (deviation from expected range)
		let deviation = event.deviation;
		if (deviation === null || deviation === undefined) {
			const [min, max] = event.expectedRange;
			const value = event.observedValue;
			
			// Calculate how far outside the expected range
			if (value < min) {
				deviation = min - value;
			} else if (value > max) {
				deviation = value - max;
			} else {
				// Value is within range, deviation is 0
				deviation = 0;
			}
			
			logger.warn('Deviation was missing, calculated from expected range', {
				agentUuid: event.agentUuid,
				deviceName: event.deviceName,
				metric: event.metric,
				observedValue: value,
				expectedRange: event.expectedRange,
				calculatedDeviation: deviation
			});
		}
		
		await query(
			`INSERT INTO anomaly_events (
				msg_id,
				agent_uuid,
				device_name,
				device_uuid,
				device_type,
				metric,
				timestamp_ms,
				window_start_ms,
				window_end_ms,
				observed_value,
				anomaly_score,
				confidence,
				severity,
				severity_reason,
				fingerprint,
				consecutive_count,
				event_count,
				triggered_by,
				baseline,
				expected_range,
				deviation,
				cooldown_sec,
				first_seen,
				created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, NOW())`,
			[
				event.msgId || randomUUID(),
				event.agentUuid,
				event.deviceName,
				extractDeviceUuidFromMetric(event.metric),
				event.deviceType,
				extractMetricSuffix(event.metric),
				event.timestampMs,
				event.windowStartMs,
				event.windowEndMs,
				event.observedValue,
				event.anomalyScore,
				event.confidence,
				event.severity,
				event.severityReason,
				event.fingerprint,
				event.consecutiveCount,
				event.eventCount,
				JSON.stringify(event.triggeredBy),
				JSON.stringify({
					...event.baseline,
					deviceState: event.deviceState || 'unknown',
				}),
				JSON.stringify(event.expectedRange),
				deviation,
				event.cooldownSec,
				event.firstSeen,
			]
		);
	}
	
	/**
	 * Correlate event into incident
	 */
	private async correlateEvent(event: AnomalyEvent): Promise<Incident> {
		const redis = await this.getRedis();
		const incidentKey = `incident:${event.fingerprint}`;
		
		// Check database for resolved incidents (defensive check)
		// Prevents reopening incidents that were manually resolved
		const dbCheck = await query(
			`SELECT incident_id, status, fingerprint 
			 FROM anomaly_incidents 
			 WHERE fingerprint = $1 
			 ORDER BY created_at DESC 
			 LIMIT 1`,
			[event.fingerprint]
		);
		
		if (dbCheck.rows.length > 0 && dbCheck.rows[0].status === 'resolved') {
			logger.info('Previous incident was resolved, creating new incident', {
				fingerprint: event.fingerprint,
				oldIncidentId: dbCheck.rows[0].incident_id,
				oldStatus: 'resolved',
			});
			
			// Clear stale Redis cache and create fresh incident
			if (redis) {
				await redis.del(incidentKey);
			}
			// Fall through to create new incident below
		}
		
		// Try to get existing incident from Redis
		const existingData = redis ? await redis.get(incidentKey) : null;
		
		// Create new incident if:
		// 1. No Redis cache exists (first event with this fingerprint)
		// 2. Previous incident was resolved (defensive check above cleared cache)
		if (!existingData) {
			// Create new incident
			const incident: Incident = {
				incidentId: randomUUID(),
				fingerprint: event.fingerprint,
				metric: extractMetricSuffix(event.metric),
				severity: event.severity,
				deviceName: event.deviceName,
				deviceUuid: extractDeviceUuidFromMetric(event.metric),
				deviceType: event.deviceType,
				affectedDevices: [event.deviceName],
				affectedAgents: [event.agentUuid],
				firstSeen: event.timestampMs,
				lastSeen: event.timestampMs,
				maxAnomalyScore: event.anomalyScore,
				maxConfidence: event.confidence,
				eventCount: 1,
				status: 'open',
			};
			
			// Store in Redis
			await redis.setex(incidentKey, this.incidentTTL, JSON.stringify(incident));
			
			// Store in database
			await this.storeIncident(incident);
			
			return incident;
		}
		
		// Update existing incident
		const incident: Incident = JSON.parse(existingData);
		
		// Ensure new fields exist (backward compatibility)
		if (!incident.deviceName) {
			incident.deviceName = event.deviceName;
		}
		if (!incident.deviceType) {
			incident.deviceType = event.deviceType;
		}
		if (incident.deviceUuid === undefined) {
			incident.deviceUuid = extractDeviceUuidFromMetric(event.metric);
		}
		if (!incident.affectedAgents) {
			incident.affectedAgents = [event.agentUuid];
		}
		
		// Add device name if not already affected
		if (!incident.affectedDevices.includes(event.deviceName)) {
			incident.affectedDevices.push(event.deviceName);
		}
		
		// Add agent UUID if not already tracked
		if (!incident.affectedAgents.includes(event.agentUuid)) {
			incident.affectedAgents.push(event.agentUuid);
		}
		
		// Update metrics
		incident.eventCount++;
		incident.lastSeen = event.timestampMs;
		incident.maxAnomalyScore = Math.max(incident.maxAnomalyScore, event.anomalyScore);
		incident.maxConfidence = Math.max(incident.maxConfidence, event.confidence);
		
		// Escalate severity if needed
		const oldSeverity = incident.severity;
		if (incident.maxAnomalyScore >= 0.9 && incident.severity !== 'critical') {
			incident.severity = 'critical';
		} else if (incident.maxAnomalyScore >= 0.7 && incident.severity === 'info') {
			incident.severity = 'warning';
		}
		
		// Update status
		if (incident.status === 'open') {
			incident.status = 'active';
		}
		
		// Store back to Redis
		await redis.setex(incidentKey, this.incidentTTL, JSON.stringify(incident));
		
		// Update database
		await this.updateIncident(incident);
		
		// Log severity escalation
		if (oldSeverity !== incident.severity) {
			logger.warn('Incident severity escalated', {
				incidentId: incident.incidentId,
				fingerprint: incident.fingerprint,
				oldSeverity,
				newSeverity: incident.severity,
				maxAnomalyScore: incident.maxAnomalyScore,
			});
		}
		
		return incident;
	}
	
	/**
	 * Store new incident to database
	 */
	private async storeIncident(incident: Incident): Promise<void> {
		await query(
			`INSERT INTO anomaly_incidents (
				incident_id,
				fingerprint,
				metric,
				severity,
				device_name,
				device_uuid,
				device_type,
				affected_devices,
				affected_agents,
				first_seen,
				last_seen,
				max_anomaly_score,
				max_confidence,
				event_count,
				status,
				created_at,
				updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), NOW())`,
			[
				incident.incidentId,
				incident.fingerprint,
				incident.metric,
				incident.severity,
				incident.deviceName,
				incident.deviceUuid,
				incident.deviceType,
				JSON.stringify(incident.affectedDevices),
				JSON.stringify(incident.affectedAgents),
				incident.firstSeen,
				incident.lastSeen,
				incident.maxAnomalyScore,
				incident.maxConfidence,
				incident.eventCount,
				incident.status,
			]
		);
	}
	
	/**
	 * Update existing incident in database
	 */
	private async updateIncident(incident: Incident): Promise<void> {
		await query(
			`UPDATE anomaly_incidents SET
				severity = $2,
				device_name = $3,
				device_uuid = $4,
				device_type = $5,
				affected_devices = $6,
				affected_agents = $7,
				last_seen = $8,
				max_anomaly_score = $9,
				max_confidence = $10,
				event_count = $11,
				status = $12,
				updated_at = NOW()
			WHERE incident_id = $1`,
			[
				incident.incidentId,
				incident.severity,
				incident.deviceName,
				incident.deviceUuid,
				incident.deviceType,
				JSON.stringify(incident.affectedDevices),
				JSON.stringify(incident.affectedAgents),
				incident.lastSeen,
				incident.maxAnomalyScore,
				incident.maxConfidence,
				incident.eventCount,
				incident.status,
			]
		);
	}
	
	/**
	 * Determine if alert should be triggered
	 */
	private shouldTriggerAlert(incident: Incident, event: AnomalyEvent): boolean {
		// Only alert on new incidents or severity escalations
		if (incident.status === 'open') {
			return incident.severity === 'critical' || incident.severity === 'warning';
		}
		
		// Alert on escalation to critical
		if (event.severity === 'critical' && incident.eventCount === 1) {
			return true;
		}
		
		return false;
	}
	
	/**
	 * Trigger alert
	 */
	private async triggerAlert(incident: Incident, event: AnomalyEvent): Promise<void> {
		// For now, just log and store to alerts table
		// TODO: Add Slack, PagerDuty, email integrations
		
		logger.warn('🚨 ANOMALY ALERT', {
			incidentId: incident.incidentId,
			metric: incident.metric,
			deviceState: event.deviceState || 'unknown',
			severity: incident.severity,
			affectedDevices: incident.affectedDevices,
			maxAnomalyScore: incident.maxAnomalyScore,
			eventCount: incident.eventCount,
		});
		
		// Store alert to database
		await query(
			`INSERT INTO anomaly_alerts (
				alert_id,
				incident_id,
				severity,
				metric,
				device_uuid,
				affected_devices,
				max_anomaly_score,
				message,
				created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
			[
				randomUUID(),
				incident.incidentId,
				incident.severity,
				incident.metric,
				incident.deviceUuid,
				JSON.stringify(incident.affectedDevices),
				incident.maxAnomalyScore,
				`Anomaly detected: ${incident.metric} in state ${event.deviceState || 'unknown'} on ${incident.affectedDevices.length} device(s). Score: ${incident.maxAnomalyScore.toFixed(3)}`,
			]
		);
	}
}

/**
 * Singleton instance
 */
let handlerInstance: AnomalyEventHandler | null = null;

/**
 * Get handler instance
 */
export function getAnomalyEventHandler(): AnomalyEventHandler {
	if (!handlerInstance) {
		handlerInstance = new AnomalyEventHandler();
	}
	return handlerInstance;
}
