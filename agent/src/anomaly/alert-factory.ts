import { getRecentValues, getTrend } from './buffer';
import type {
	AnomalyAlert,
	AnomalySeverity,
	BaselineInfo,
	CanonicalDeviceState,
	DataPoint,
	DetectionResult,
	MetricConfig,
	StatisticalBuffer,
} from './types';

function createId(): string {
	const now = Date.now().toString(36);
	const rand = Math.random().toString(36).slice(2, 12);
	return `${now}-${rand}`;
}

export function calculateSeverity(
	confidence: number,
	deviation: number,
	method?: string,
): AnomalySeverity {
	if (method === 'simulation') {
		return 'critical';
	}

	if (method === 'mad') {
		if (confidence >= 0.7 || deviation >= 3.0) {
			return 'warning';
		}
		return 'info';
	}

	if (confidence >= 0.85 || deviation >= 5.0) {
		return 'critical';
	}
	if (confidence >= 0.7 || deviation >= 3.0) {
		return 'warning';
	}
	return 'info';
}

export function generateSeverityReason(
	score: number,
	deviation: number,
	severity: AnomalySeverity,
): string {
	const reasons: string[] = [];

	if (score >= 0.85) {
		reasons.push('score>=0.85');
	} else if (score >= 0.7) {
		reasons.push('score>=0.7');
	}

	if (deviation >= 5.0) {
		reasons.push('deviation>=5.0');
	} else if (deviation >= 3.0) {
		reasons.push('deviation>=3.0');
	}

	if (reasons.length === 0) {
		reasons.push('score<0.7');
	}

	return `${severity}: ${reasons.join(' || ')}`;
}

export function calculateConfidence(
	anomalyScore: number,
	baseline: BaselineInfo,
): number {
	let confidence = anomalyScore;

	if (baseline.sampleCount < 30) {
		const samplePenalty = baseline.sampleCount / 30;
		confidence *= (0.7 + 0.3 * samplePenalty);
	}

	if (baseline.source === 'database') {
		confidence = Math.min(1.0, confidence * 1.05);
	}

	if (baseline.stdDev > baseline.mean * 0.5) {
		confidence *= 0.9;
	}

	return Math.min(1.0, Math.max(0.0, confidence));
}

export function createAnomalyAlert(
	dataPoint: DataPoint,
	buffer: StatisticalBuffer,
	metricConfig: MetricConfig,
	result: DetectionResult,
	deviceState: CanonicalDeviceState,
): AnomalyAlert {
	const severity = calculateSeverity(result.confidence, result.deviation, result.method);

	return {
		id: createId(),
		severity,
		deviceState,
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
		message: `${result.message} (state: ${deviceState})`,
		fingerprint: '',
		count: 1,
		cooldownSec: Math.floor((metricConfig.cooldownMs || 30000) / 1000),
		firstSeen: dataPoint.timestamp,
		consecutiveCount: 1,
	};
}
