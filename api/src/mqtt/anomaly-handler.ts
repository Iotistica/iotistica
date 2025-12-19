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
export interface AnomalyEvent {
	msgId?: string;
	deviceId: string;
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
	affectedDevices: string[];
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
				this.redis = module.redisClient;
			} catch (error) {
				logger.warn('Redis client not available for anomaly correlation caching');
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
			// 1. Skip suppressed events (already handled at edge)
			if (event.suppressed) {
				logger.debug('Skipping suppressed anomaly event', {
					deviceId: event.deviceId,
					metric: event.metric,
					fingerprint: event.fingerprint,
				});
				return;
			}
			
			// 2. Store raw event to database
			await this.storeEvent(event);
			
			// 3. Get or create incident
			const incident = await this.correlateEvent(event);
			
			// 4. Check if alert should be triggered
			if (this.shouldTriggerAlert(incident, event)) {
				await this.triggerAlert(incident, event);
			}
			
			logger.info('Processed anomaly event', {
				deviceId: event.deviceId,
				metric: event.metric,
				severity: event.severity,
				incidentId: incident.incidentId,
				affectedDevices: incident.affectedDevices.length,
			});
			
		} catch (error) {
			logger.error('Failed to process anomaly event', {
				error: error instanceof Error ? error.message : String(error),
				deviceId: event.deviceId,
				metric: event.metric,
			});
		}
	}
	
	/**
	 * Store event to database
	 */
	private async storeEvent(event: AnomalyEvent): Promise<void> {
		// Log the actual values being inserted
		logger.info('Storing anomaly event to database', {
			msgId: event.msgId,
			deviceId: event.deviceId,
			metric: event.metric,
			timestampMs: event.timestampMs,
			hasTimestampMs: event.timestampMs !== undefined,
			timestampMsType: typeof event.timestampMs
		});
		
		await query(
			`INSERT INTO anomaly_events (
				msg_id,
				device_id,
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
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, NOW())`,
			[
				event.msgId || randomUUID(),
				event.deviceId,
				event.metric,
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
				JSON.stringify(event.baseline),
				JSON.stringify(event.expectedRange),
				event.deviation,
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
		
		// Try to get existing incident
		const existingData = await redis.get(incidentKey);
		
		if (!existingData) {
			// Create new incident
			const incident: Incident = {
				incidentId: randomUUID(),
				fingerprint: event.fingerprint,
				metric: event.metric,
				severity: event.severity,
				affectedDevices: [event.deviceId],
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
		
		// Add device if not already affected
		if (!incident.affectedDevices.includes(event.deviceId)) {
			incident.affectedDevices.push(event.deviceId);
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
				affected_devices,
				first_seen,
				last_seen,
				max_anomaly_score,
				max_confidence,
				event_count,
				status,
				created_at,
				updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
			[
				incident.incidentId,
				incident.fingerprint,
				incident.metric,
				incident.severity,
				JSON.stringify(incident.affectedDevices),
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
				affected_devices = $3,
				last_seen = $4,
				max_anomaly_score = $5,
				max_confidence = $6,
				event_count = $7,
				status = $8,
				updated_at = NOW()
			WHERE incident_id = $1`,
			[
				incident.incidentId,
				incident.severity,
				JSON.stringify(incident.affectedDevices),
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
				affected_devices,
				max_anomaly_score,
				message,
				created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
			[
				randomUUID(),
				incident.incidentId,
				incident.severity,
				incident.metric,
				JSON.stringify(incident.affectedDevices),
				incident.maxAnomalyScore,
				`Anomaly detected: ${incident.metric} on ${incident.affectedDevices.length} device(s). Score: ${incident.maxAnomalyScore.toFixed(3)}`,
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
