import crypto from 'node:crypto';
import { AnomalyEventModel } from '../db/models/anomaly-event.model.js';
import { AnomalyIncidentModel } from '../db/models/anomaly-incident.model.js';
import { AnomalyAlertModel } from '../db/models/anomaly-alert.model.js';
import type { AnomalyEventPayload } from '../db/models/anomaly-event.model.js';

export type { AnomalyEventPayload };

const ACTIVE_THRESHOLD   = 3;
const SILENCE_WINDOW_MS  = 30 * 60 * 1000;  // 30 min without events → auto-resolve
const ALERT_COOLDOWN_MS  = 60 * 60 * 1000;  // 1 h between alerts per incident
const STALE_CHECK_MS     = 5  * 60 * 1000;  // run stale check every 5 min

const ALERT_THRESHOLDS: Record<string, number> = {
	critical: 1,
	warning:  3,
	info:     5,
};

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

function escalateSeverity(
	current: 'info' | 'warning' | 'critical',
	incoming: 'info' | 'warning' | 'critical',
): 'info' | 'warning' | 'critical' {
	return (SEVERITY_RANK[incoming] ?? 0) > (SEVERITY_RANK[current] ?? 0) ? incoming : current;
}

export class IncidentCorrelator {
	private timer?: ReturnType<typeof setInterval>;

	start(): void {
		this.timer = setInterval(() => this.checkSilentResolutions(), STALE_CHECK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	processEvent(payload: AnomalyEventPayload): void {
		if (!payload?.metric || !payload?.fingerprint) return;

		// 1. Persist the raw event
		AnomalyEventModel.insert(payload);

		// 2. Find or create the active incident for this fingerprint
		let incident = AnomalyIncidentModel.findActiveByFingerprint(payload.fingerprint);

		if (!incident) {
			incident = AnomalyIncidentModel.create({
				incident_id:       crypto.randomUUID(),
				fingerprint:       payload.fingerprint,
				metric:            payload.metric,
				severity:          payload.severity,
				device_name:       payload.device_name ?? 'Unknown',
				device_type:       payload.device_type ?? null,
				first_seen:        payload.timestamp_ms,
				last_seen:         payload.timestamp_ms,
				max_anomaly_score: payload.anomaly_score,
				max_confidence:    payload.confidence,
				event_count:       1,
				status:            'open',
			});
		} else {
			const newCount    = incident.event_count + 1;
			const newSeverity = escalateSeverity(incident.severity, payload.severity);
			const newScore    = Math.max(incident.max_anomaly_score, payload.anomaly_score);
			const newConf     = Math.max(incident.max_confidence, payload.confidence);
			const newStatus   = newCount >= ACTIVE_THRESHOLD ? 'active' : incident.status;

			AnomalyIncidentModel.updateByEvent(incident.incident_id, {
				last_seen:         payload.timestamp_ms,
				event_count:       newCount,
				max_anomaly_score: newScore,
				max_confidence:    newConf,
				severity:          newSeverity,
				status:            newStatus,
			});

			incident = {
				...incident,
				event_count:       newCount,
				max_anomaly_score: newScore,
				max_confidence:    newConf,
				severity:          newSeverity,
				status:            newStatus,
			};
		}

		// 3. Maybe promote to an alert
		this.maybePromote(incident, payload);
	}

	private maybePromote(
		incident: ReturnType<typeof AnomalyIncidentModel.findActiveByFingerprint> & object,
		payload: AnomalyEventPayload,
	): void {
		if (!incident) return;

		const threshold = ALERT_THRESHOLDS[incident.severity] ?? 3;
		if (incident.event_count < threshold) return;

		const now = Date.now();
		if (incident.last_alert_at && (now - incident.last_alert_at) < ALERT_COOLDOWN_MS) return;

		AnomalyAlertModel.insert({
			alert_id:          crypto.randomUUID(),
			incident_id:       incident.incident_id,
			severity:          incident.severity,
			metric:            incident.metric,
			device_name:       incident.device_name,
			max_anomaly_score: incident.max_anomaly_score,
			message:           this.buildMessage(incident, payload),
		});

		AnomalyIncidentModel.setLastAlertAt(incident.incident_id, now);
	}

	private buildMessage(
		incident: NonNullable<ReturnType<typeof AnomalyIncidentModel.findActiveByFingerprint>>,
		payload: AnomalyEventPayload,
	): string {
		return (
			`${incident.severity.toUpperCase()}: Anomaly in "${incident.metric}"` +
			` on ${incident.device_name}.` +
			` Score: ${incident.max_anomaly_score.toFixed(2)},` +
			` observed: ${payload.observed_value},` +
			` events: ${incident.event_count}.`
		);
	}

	private checkSilentResolutions(): void {
		const cutoff = Date.now() - SILENCE_WINDOW_MS;
		const resolved = AnomalyIncidentModel.autoResolveStale(cutoff);
		if (resolved > 0) {
			// silent — no logger dep in correlator
		}
	}
}
