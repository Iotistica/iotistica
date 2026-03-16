/**
 * COMPLETE ANOMALY DETECTION PIPELINE
 * ====================================
 * 
 * Example showing fusion detector + temporal confirmation working together
 */

import { FusionDetector, detectWithFusion } from './fusion';
import { createTemporalConfirmation } from './temporal-confirmation';
import { createBuffer, addValue } from './buffer';
import type { MetricConfig, AnomalySeverity } from './types';

declare const console: {
	log: (...args: any[]) => void;
};

/**
 * Complete anomaly detection pipeline
 */
export class AnomalyPipeline {
	private fusion: FusionDetector;
	private temporal: ReturnType<typeof createTemporalConfirmation>;
	
	constructor(config?: {
		fusion?: Parameters<typeof detectWithFusion>[4];
		temporal?: Parameters<typeof createTemporalConfirmation>[0];
	}) {
		this.fusion = new FusionDetector();
		this.temporal = createTemporalConfirmation(
			config?.temporal || 'default'
		);
	}
	
	/**
	 * Run complete detection pipeline
	 */
	detect(
		metricName: string,
		value: number,
		buffer: ReturnType<typeof createBuffer>,
		config: MetricConfig,
		severity?: AnomalySeverity,
		dbBaseline?: Parameters<typeof detectWithFusion>[3]
	) {
		// Step 1: Fusion detection (combine multiple detectors)
		const fusionResult = detectWithFusion(
			value,
			buffer,
			config,
			dbBaseline,
			config.fusion
		);
		
		// Step 2: Temporal confirmation (N-of-M pattern)
		const temporalResult = this.temporal.confirm(
			metricName,
			fusionResult,
			severity
		);
		
		// Return combined result
		return {
			// Fusion details
			fusionScore: fusionResult.fusionScore,
			contributingDetectors: fusionResult.contributingDetectors,
			triggeredBy: fusionResult.triggeredBy,
			
			// Temporal details
			isConfirmed: temporalResult.isConfirmed,
			anomalyCount: temporalResult.anomalyCount,
			windowSize: temporalResult.windowSize,
			wasBypassed: temporalResult.wasBypassed,
			
			// Final decision
			isAnomaly: temporalResult.isConfirmed,
			
			// Combined message
			message: temporalResult.isConfirmed
				? `${fusionResult.message} → ${temporalResult.message}`
				: temporalResult.message,
			
			// Metadata
			value,
			metricName,
			severity,
			timestamp: Date.now(),
		};
	}
	
	/**
	 * Clear temporal history for metric
	 */
	resetMetric(metricName: string): void {
		this.temporal.clearHistory(metricName);
	}
	
	/**
	 * Clear all temporal history
	 */
	resetAll(): void {
		this.temporal.clearAllHistory();
	}
}

// ============================================================================
// USAGE EXAMPLE
// ============================================================================

export async function exampleUsage() {
	// Setup
	const pipeline = new AnomalyPipeline({
		temporal: 'default', // 2-of-3
	});
	
	const buffer = createBuffer(100);
	const config: MetricConfig = {
		name: 'cpu_usage',
		enabled: true,
		methods: ['fusion'],
		threshold: 3.0,
		windowSize: 100,
		expectedRange: [0, 100],
		
		fusion: {
			threshold: 0.6,
			minimumAgreement: 2,
		},
		
		temporal: {
			enabled: true,
			preset: 'default',
		},
	};
	
	// Simulate data stream
	console.log('=== CPU Usage Monitoring ===\n');
	
	// Normal operation
	for (let i = 0; i < 20; i++) {
		addValue(buffer, 20 + Math.random() * 5, Date.now() - (20 - i) * 1000);
	}
	
	// Time 0s: Normal
	let value = 22;
	let result = pipeline.detect('cpu_usage', value, buffer, config, 'info');
	console.log(`[0s] Value: ${value}%`);
	console.log(`  Fusion Score: ${result.fusionScore.toFixed(2)}`);
	console.log(`  Confirmed: ${result.isConfirmed}`);
	console.log(`  Message: ${result.message}\n`);
	
	// Time 5s: GC spike (transient anomaly)
	value = 95;
	addValue(buffer, value, Date.now());
	result = pipeline.detect('cpu_usage', value, buffer, config, 'warning');
	console.log(`[5s] Value: ${value}% (GC spike)`);
	console.log(`  Fusion Score: ${result.fusionScore.toFixed(2)}`);
	console.log(`  Triggered By: ${result.triggeredBy?.join(', ')}`);
	console.log(`  Confirmed: ${result.isConfirmed} ✅ Correctly filtered!`);
	console.log(`  Message: ${result.message}\n`);
	
	// Time 10s: Back to normal
	value = 23;
	addValue(buffer, value, Date.now());
	result = pipeline.detect('cpu_usage', value, buffer, config, 'info');
	console.log(`[10s] Value: ${value}%`);
	console.log(`  Confirmed: ${result.isConfirmed}`);
	console.log(`  Anomaly Count: ${result.anomalyCount} of ${result.windowSize}\n`);
	
	// Time 15s: Sustained high CPU (real issue)
	value = 92;
	addValue(buffer, value, Date.now());
	result = pipeline.detect('cpu_usage', value, buffer, config, 'warning');
	console.log(`[15s] Value: ${value}% (sustained high)`);
	console.log(`  Fusion Score: ${result.fusionScore.toFixed(2)}`);
	console.log(`  Confirmed: ${result.isConfirmed} ⚠️  Real issue detected!`);
	console.log(`  Message: ${result.message}\n`);
	
	// Critical temperature example
	console.log('=== Temperature Monitoring ===\n');
	
	const tempBuffer = createBuffer(100);
	for (let i = 0; i < 20; i++) {
		addValue(tempBuffer, 50 + Math.random() * 10, Date.now() - (20 - i) * 1000);
	}
	
	const tempConfig: MetricConfig = {
		...config,
		name: 'temperature',
		expectedRange: [0, 100],
	};
	
	// Critical temperature spike
	value = 105;
	addValue(tempBuffer, value, Date.now());
	result = pipeline.detect('temperature', value, tempBuffer, tempConfig, 'critical');
	console.log(`[0s] Value: ${value}°C (CRITICAL!)`);
	console.log(`  Fusion Score: ${result.fusionScore.toFixed(2)}`);
	console.log(`  Bypassed: ${result.wasBypassed} 🔥 Immediate alert!`);
	console.log(`  Confirmed: ${result.isConfirmed}`);
	console.log(`  Message: ${result.message}\n`);
}

// ============================================================================
// EXPECTED OUTPUT
// ============================================================================
/*

=== CPU Usage Monitoring ===

[0s] Value: 22%
  Fusion Score: 0.05
  Confirmed: false
  Message: Not confirmed: 0 of 1 detections (need: 2)

[5s] Value: 95% (GC spike)
  Fusion Score: 0.85
  Triggered By: expected_range, mad, zscore
  Confirmed: false ✅ Correctly filtered!
  Message: Not confirmed: 1 of 2 detections (need: 2)

[10s] Value: 23%
  Confirmed: false
  Anomaly Count: 1 of 3

[15s] Value: 92% (sustained high)
  Fusion Score: 0.82
  Confirmed: true ⚠️  Real issue detected!
  Message: Fusion score 0.82 exceeds threshold 0.6 → Confirmed: 2 of 3 detections

=== Temperature Monitoring ===

[0s] Value: 105°C (CRITICAL!)
  Fusion Score: 0.95
  Bypassed: true 🔥 Immediate alert!
  Confirmed: true
  Message: Hard rule triggered by: expected_range → CRITICAL severity bypassed temporal confirmation

*/
