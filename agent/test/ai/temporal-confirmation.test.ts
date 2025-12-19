/**
 * TEMPORAL CONFIRMATION - TESTS
 * ==============================
 * 
 * Tests for N-of-M pattern and critical bypass
 */

import { 
	TemporalConfirmation, 
	createTemporalConfirmation,
	DEFAULT_TEMPORAL_CONFIG,
	STRICT_TEMPORAL_CONFIG,
	CONSECUTIVE_TEMPORAL_CONFIG,
	SENSITIVE_TEMPORAL_CONFIG,
} from '../../src/ai/anomaly/temporal-confirmation';
import type { DetectionResult } from '../../src/ai/anomaly/types';

// Helper to create mock detection result
function createMockResult(isAnomaly: boolean, confidence: number = 0.8, method: string = 'zscore'): DetectionResult {
	return {
		method: method as any,
		isAnomaly,
		confidence,
		deviation: confidence * 3,
		expectedRange: [0, 100],
		message: isAnomaly ? 'Anomaly detected' : 'Normal',
	};
}

describe('TemporalConfirmation', () => {
	let temporal: TemporalConfirmation;
	
	beforeEach(() => {
		temporal = new TemporalConfirmation();
	});
	
	describe('Basic N-of-M Pattern', () => {
		test('2-of-3 default: confirms after 2 anomalies', () => {
			const metric = 'temperature';
			
			// First anomaly - not confirmed
			let result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(false);
			expect(result.anomalyCount).toBe(1);
			expect(result.message).toContain('1 of 1');
			
			// Second anomaly - CONFIRMED
			result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(true);
			expect(result.anomalyCount).toBe(2);
			expect(result.message).toContain('Confirmed');
			
			// Third normal - still confirmed (2 of 3)
			result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(true);
			expect(result.anomalyCount).toBe(2);
		});
		
		test('2-of-3 default: rejects transient spike', () => {
			const metric = 'cpu_usage';
			
			// Normal
			let result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(false);
			
			// Transient spike
			result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(false);
			expect(result.anomalyCount).toBe(1);
			
			// Back to normal - anomaly count drops as window slides
			result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(false);
			expect(result.anomalyCount).toBe(1); // Still 1 anomaly in window
			
			// Another normal - window slides, anomaly falls off
			result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(false);
			expect(result.anomalyCount).toBe(0); // Anomaly fell out of window
		});
		
		test('maintains separate history per metric', () => {
			// Temperature: 2 anomalies
			temporal.confirm('temperature', createMockResult(true));
			temporal.confirm('temperature', createMockResult(true));
			
			// Humidity: 0 anomalies
			temporal.confirm('humidity', createMockResult(false));
			
			// Temperature should be confirmed
			const tempResult = temporal.confirm('temperature', createMockResult(false));
			expect(tempResult.isConfirmed).toBe(true);
			
			// Humidity should not be confirmed
			const humidityResult = temporal.confirm('humidity', createMockResult(false));
			expect(humidityResult.isConfirmed).toBe(false);
		});
	});
	
	describe('Critical Severity Bypass', () => {
		test('critical severity bypasses confirmation', () => {
			const metric = 'pressure';
			
			// Single critical anomaly - IMMEDIATE confirmation
			const result = temporal.confirm(metric, createMockResult(true), 'critical');
			
			expect(result.isConfirmed).toBe(true);
			expect(result.wasBypassed).toBe(true);
			expect(result.message).toContain('CRITICAL severity bypassed');
		});
		
		test('warning severity still requires confirmation', () => {
			const metric = 'pressure';
			
			// Single warning anomaly - NOT confirmed
			const result = temporal.confirm(metric, createMockResult(true), 'warning');
			
			expect(result.isConfirmed).toBe(false);
			expect(result.wasBypassed).toBe(false);
		});
		
		test('critical bypass can be disabled', () => {
			temporal = new TemporalConfirmation({ bypassOnCritical: false });
			const metric = 'pressure';
			
			// Critical anomaly with bypass disabled - NOT confirmed
			const result = temporal.confirm(metric, createMockResult(true), 'critical');
			
			expect(result.isConfirmed).toBe(false);
			expect(result.wasBypassed).toBe(false);
		});
		
		test('critical normal value does not bypass', () => {
			const metric = 'pressure';
			
			// Critical severity but NOT an anomaly - no bypass
			const result = temporal.confirm(metric, createMockResult(false), 'critical');
			
			expect(result.isConfirmed).toBe(false);
			expect(result.wasBypassed).toBe(false);
		});
	});
	
	describe('Consecutive Mode', () => {
		test('requires consecutive anomalies', () => {
			temporal = new TemporalConfirmation({ 
				required: 2, 
				windowSize: 3, 
				requireConsecutive: true 
			});
			const metric = 'memory';
			
			// Anomaly
			let result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(false);
			
			// Normal (breaks consecutive chain)
			result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(false);
			
			// Anomaly (restart chain)
			result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(false);
			
			// Anomaly (2 consecutive) - CONFIRMED
			result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(true);
			expect(result.message).toContain('2 consecutive');
		});
		
		test('non-consecutive mode allows gaps', () => {
			temporal = new TemporalConfirmation({ 
				required: 2, 
				windowSize: 3, 
				requireConsecutive: false // Default
			});
			const metric = 'disk';
			
			// Anomaly
			temporal.confirm(metric, createMockResult(true));
			
			// Normal (gap)
			temporal.confirm(metric, createMockResult(false));
			
			// Anomaly - CONFIRMED (2 of 3, non-consecutive)
			const result = temporal.confirm(metric, createMockResult(true));
			expect(result.isConfirmed).toBe(true);
		});
	});
	
	describe('Window Sliding', () => {
		test('ring buffer maintains window size', () => {
			temporal = new TemporalConfirmation({ required: 2, windowSize: 3 });
			const metric = 'network';
			
			// Fill window with anomalies
			temporal.confirm(metric, createMockResult(true));
			temporal.confirm(metric, createMockResult(true));
			let result = temporal.confirm(metric, createMockResult(true));
			
			expect(result.windowSize).toBe(3);
			expect(result.anomalyCount).toBe(3);
			
			// Add more - window should stay at 3
			result = temporal.confirm(metric, createMockResult(false));
			expect(result.windowSize).toBe(3);
			expect(result.anomalyCount).toBe(2); // Oldest anomaly fell off
		});
		
		test('old anomalies fall out of window', () => {
			temporal = new TemporalConfirmation({ required: 2, windowSize: 3 });
			const metric = 'io';
			
			// 2 anomalies (confirmed)
			temporal.confirm(metric, createMockResult(true));
			temporal.confirm(metric, createMockResult(true));
			
			// Add 2 normals - window slides
			temporal.confirm(metric, createMockResult(false));
			temporal.confirm(metric, createMockResult(false));
			
			// Window: [anomaly, normal, normal] - only 1 anomaly now
			const result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(false);
			expect(result.anomalyCount).toBe(0); // All anomalies fell out
		});
	});
	
	describe('History Management', () => {
		test('getHistory returns decision entries', () => {
			const metric = 'test';
			
			temporal.confirm(metric, createMockResult(true));
			temporal.confirm(metric, createMockResult(false));
			
			const history = temporal.getHistory(metric);
			expect(history.length).toBe(2);
			expect(history[0].isAnomaly).toBe(true);
			expect(history[1].isAnomaly).toBe(false);
		});
		
		test('clearHistory removes metric history', () => {
			const metric = 'test';
			
			temporal.confirm(metric, createMockResult(true));
			temporal.confirm(metric, createMockResult(true));
			
			temporal.clearHistory(metric);
			
			const history = temporal.getHistory(metric);
			expect(history.length).toBe(0);
		});
		
		test('clearAllHistory removes all metrics', () => {
			temporal.confirm('metric1', createMockResult(true));
			temporal.confirm('metric2', createMockResult(true));
			
			temporal.clearAllHistory();
			
			expect(temporal.getHistory('metric1').length).toBe(0);
			expect(temporal.getHistory('metric2').length).toBe(0);
		});
	});
	
	describe('Configuration', () => {
		test('updateConfig changes behavior', () => {
			const metric = 'test';
			
			// Start with 2-of-3
			temporal.confirm(metric, createMockResult(true));
			temporal.confirm(metric, createMockResult(true));
			let result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(true);
			
			// Change to 3-of-3 (all must be anomalies)
			temporal.updateConfig({ required: 3 });
			temporal.clearHistory(metric); // Reset
			
			temporal.confirm(metric, createMockResult(true));
			temporal.confirm(metric, createMockResult(true));
			result = temporal.confirm(metric, createMockResult(false));
			expect(result.isConfirmed).toBe(false); // Only 2 of 3
		});
		
		test('getConfig returns current config', () => {
			const config = temporal.getConfig();
			expect(config.required).toBe(2);
			expect(config.windowSize).toBe(3);
		});
	});
});

describe('Preset Configurations', () => {
	test('DEFAULT: 2-of-3', () => {
		expect(DEFAULT_TEMPORAL_CONFIG.required).toBe(2);
		expect(DEFAULT_TEMPORAL_CONFIG.windowSize).toBe(3);
	});
	
	test('STRICT: 3-of-5', () => {
		expect(STRICT_TEMPORAL_CONFIG.required).toBe(3);
		expect(STRICT_TEMPORAL_CONFIG.windowSize).toBe(5);
	});
	
	test('CONSECUTIVE: requires consecutive', () => {
		expect(CONSECUTIVE_TEMPORAL_CONFIG.requireConsecutive).toBe(true);
	});
	
	test('SENSITIVE: 1-of-2', () => {
		expect(SENSITIVE_TEMPORAL_CONFIG.required).toBe(1);
		expect(SENSITIVE_TEMPORAL_CONFIG.windowSize).toBe(2);
	});
});

describe('Factory Function', () => {
	test('createTemporalConfirmation with default preset', () => {
		const temporal = createTemporalConfirmation();
		const config = temporal.getConfig();
		
		expect(config.required).toBe(2);
		expect(config.windowSize).toBe(3);
	});
	
	test('createTemporalConfirmation with strict preset', () => {
		const temporal = createTemporalConfirmation('strict');
		const config = temporal.getConfig();
		
		expect(config.required).toBe(3);
		expect(config.windowSize).toBe(5);
	});
	
	test('createTemporalConfirmation with overrides', () => {
		const temporal = createTemporalConfirmation('default', { 
			required: 4,
			bypassOnCritical: false 
		});
		const config = temporal.getConfig();
		
		expect(config.required).toBe(4); // Override
		expect(config.windowSize).toBe(3); // From preset
		expect(config.bypassOnCritical).toBe(false); // Override
	});
});

describe('Real-World Scenarios', () => {
	test('Scenario: CPU spike during garbage collection (transient)', () => {
		const temporal = createTemporalConfirmation('default');
		const metric = 'cpu_usage';
		
		// Normal operation
		temporal.confirm(metric, createMockResult(false, 0.2));
		temporal.confirm(metric, createMockResult(false, 0.3));
		
		// GC spike (single anomaly)
		const spikeResult = temporal.confirm(metric, createMockResult(true, 0.9));
		expect(spikeResult.isConfirmed).toBe(false); // Correctly filtered out
		
		// Back to normal
		const afterResult = temporal.confirm(metric, createMockResult(false, 0.2));
		expect(afterResult.isConfirmed).toBe(false);
	});
	
	test('Scenario: Sustained memory leak (real issue)', () => {
		const temporal = createTemporalConfirmation('default');
		const metric = 'memory_percent';
		
		// Memory gradually increasing (all anomalies)
		temporal.confirm(metric, createMockResult(true, 0.7));
		const result = temporal.confirm(metric, createMockResult(true, 0.8));
		
		expect(result.isConfirmed).toBe(true); // Correctly detected
		expect(result.message).toContain('Confirmed');
	});
	
	test('Scenario: Critical temperature spike (immediate alert)', () => {
		const temporal = createTemporalConfirmation('default');
		const metric = 'temperature';
		
		// Sudden critical temperature
		const result = temporal.confirm(
			metric, 
			createMockResult(true, 1.0), 
			'critical'
		);
		
		expect(result.isConfirmed).toBe(true); // Bypassed confirmation
		expect(result.wasBypassed).toBe(true);
	});
	
	test('Scenario: Noisy sensor (requires strict confirmation)', () => {
		const temporal = createTemporalConfirmation('strict'); // 3-of-5
		const metric = 'noisy_sensor';
		
		// Intermittent noise: A, N, A, N, A (3 anomalies in 5)
		temporal.confirm(metric, createMockResult(true));
		temporal.confirm(metric, createMockResult(false));
		temporal.confirm(metric, createMockResult(true));
		temporal.confirm(metric, createMockResult(false));
		const result = temporal.confirm(metric, createMockResult(true));
		
		expect(result.isConfirmed).toBe(true); // 3 of 5 met
	});
});
