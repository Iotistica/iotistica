/**
 * ALERT MANAGER - DEDUPLICATION & PRIORITIZATION
 * ================================================
 * 
 * Manages anomaly alerts with deduplication and rate limiting
 */

import type { AnomalyAlert, AlertManager as IAlertManager, AnomalySeverity } from './types';

function hash16(input: string): string {
	let h1 = 0xdeadbeef ^ input.length;
	let h2 = 0x41c6ce57 ^ input.length;

	for (let i = 0; i < input.length; i++) {
		const ch = input.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	const hex = ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0'));
	return hex.slice(0, 16);
}

export class AlertManager implements IAlertManager {
	private alerts: Map<string, AnomalyAlert> = new Map();
	private lastAlertTime: Map<string, number> = new Map();
	private consecutiveCounts: Map<string, number> = new Map();
	private readonly maxQueueSize: number;
	private readonly defaultCooldownMs: number;
	
	constructor(maxQueueSize: number = 1000, defaultCooldownMs: number = 300000) {
		this.maxQueueSize = maxQueueSize;
		this.defaultCooldownMs = defaultCooldownMs;
	}
	
	/**
	* Add an alert (with deduplication)
	*/
	addAlert(alert: AnomalyAlert): void {
		const fingerprint = this.calculateFingerprint(alert);
		alert.fingerprint = fingerprint;
		
		// Check cooldown period
		const lastTime = this.lastAlertTime.get(fingerprint);
		const now = Date.now();
		const cooldownMs = this.defaultCooldownMs;
		
		// Populate suppression metadata
		alert.cooldownSec = Math.floor(cooldownMs / 1000);
		
		if (lastTime && (now - lastTime) < cooldownMs) {
			// Within cooldown - increment count instead of creating new alert
			const existing = this.alerts.get(fingerprint);
			if (existing) {
				existing.count++;
				existing.consecutiveCount++;
				existing.timestamp = now;
				existing.context.recent_values.push(alert.value);
				existing.context.recent_values = existing.context.recent_values.slice(-10);
				
				// Update consecutive count tracker
				this.consecutiveCounts.set(fingerprint, existing.consecutiveCount);
			}
			return;
		}
		
		// Add new alert
		const existingConsecutive = this.consecutiveCounts.get(fingerprint) || 0;
		alert.count = 1;
		alert.firstSeen = now;
		alert.consecutiveCount = existingConsecutive + 1;
		
		this.alerts.set(fingerprint, alert);
		this.lastAlertTime.set(fingerprint, now);
		this.consecutiveCounts.set(fingerprint, alert.consecutiveCount);
		
		// Enforce max queue size (remove oldest alerts)
		if (this.alerts.size > this.maxQueueSize) {
			const oldestKey = this.getOldestAlertKey();
			if (oldestKey) {
				this.alerts.delete(oldestKey);
				this.lastAlertTime.delete(oldestKey);
			}
		}
	}
	
	/**
	* Get all alerts since a timestamp
	*/
	getAlerts(since?: number): AnomalyAlert[] {
		const alerts = Array.from(this.alerts.values());
		
		if (since !== undefined) {
			return alerts.filter(a => a.timestamp >= since);
		}
		
		// Sort by severity (critical > warning > info) then timestamp
		return alerts.sort((a, b) => {
			const severityOrder = { critical: 3, warning: 2, info: 1 };
			const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
			if (severityDiff !== 0) return severityDiff;
			return b.timestamp - a.timestamp;
		});
	}
	
	/**
	* Clear all alerts
	*/
	clearAlerts(): void {
		this.alerts.clear();
		this.lastAlertTime.clear();
		this.consecutiveCounts.clear();
	}
	
	/**
	* Reset consecutive count for a metric (e.g., after resolution)
	*/
	resetConsecutiveCount(fingerprint: string): void {
		this.consecutiveCounts.delete(fingerprint);
	}
	
	/**
	* Get current queue size
	*/
	getQueueSize(): number {
		return this.alerts.size;
	}
	
	/**
	* Get alerts by severity
	*/
	getAlertsBySeverity(severity: AnomalySeverity): AnomalyAlert[] {
		return Array.from(this.alerts.values())
			.filter(a => a.severity === severity)
			.sort((a, b) => b.timestamp - a.timestamp);
	}
	
	/**
	* Get alerts by metric
	*/
	getAlertsByMetric(metric: string): AnomalyAlert[] {
		return Array.from(this.alerts.values())
			.filter(a => a.metric === metric)
			.sort((a, b) => b.timestamp - a.timestamp);
	}
	
	/**
	* Calculate fingerprint for deduplication
	* Hash of: metric + state + method + severity
	*/
	private calculateFingerprint(alert: AnomalyAlert): string {
		const data = `${alert.metric}:${alert.deviceState || 'unknown'}:${alert.detectionMethod}:${alert.severity}`;
		return hash16(data);
	}
	
	/**
	* Get oldest alert key for eviction
	*/
	private getOldestAlertKey(): string | undefined {
		let oldestKey: string | undefined;
		let oldestTime = Infinity;
		
		for (const [key, alert] of this.alerts.entries()) {
			if (alert.timestamp < oldestTime) {
				oldestTime = alert.timestamp;
				oldestKey = key;
			}
		}
		
		return oldestKey;
	}
}
