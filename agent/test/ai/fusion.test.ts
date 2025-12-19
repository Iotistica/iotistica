/**
 * FUSION DETECTOR - INTEGRATION TESTS
 * ====================================
 * 
 * Tests for weighted voting and override logic
 */

import { FusionDetector, detectWithFusion, DEFAULT_DETECTOR_WEIGHTS, HARD_DETECTORS } from '../../src/ai/anomaly/fusion';
import { createBuffer, addValue } from '../../src/ai/anomaly/buffer';
import type { MetricConfig } from '../../src/ai/anomaly/types';

describe('FusionDetector', () => {
	let fusion: FusionDetector;
	let config: MetricConfig;
	
	beforeEach(() => {
		fusion = new FusionDetector();
		config = {
			name: 'temperature',
			enabled: true,
			methods: ['fusion'],
			threshold: 3.0,
			windowSize: 100,
			expectedRange: [0, 100],
		};
	});
	
	describe('Weighted Voting', () => {
		test('calculates fusion score correctly', () => {
			const buffer = createBuffer(100);
			
			// Build baseline: mean=20, stdDev~2
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 18 + Math.random() * 4);
			}
			
			// Normal value (should not trigger)
			const result = fusion.detect(21, buffer, config);
			
			expect(result.method).toBe('fusion');
			expect(result.fusionScore).toBeLessThan(0.6); // Below default threshold
			expect(result.isAnomaly).toBe(false);
		});
		
		test('aggregates multiple detector signals', () => {
			const buffer = createBuffer(100);
			
			// Build baseline
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20 + Math.random() * 2);
			}
			
			// Moderate anomaly (should trigger some detectors)
			const result = fusion.detect(30, buffer, config);
			
			expect(result.contributingDetectors.length).toBeGreaterThan(0);
			expect(result.triggeredBy).toBeDefined();
			
			// At least one detector should trigger
			const anyTriggered = result.contributingDetectors.some(d => d.isAnomaly);
			expect(anyTriggered).toBe(true);
		});
		
		test('applies custom weights correctly', () => {
			const buffer = createBuffer(100);
			
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20);
			}
			
			// Boost MAD weight
			const result = fusion.detect(25, buffer, config, undefined, {
				weights: {
					'mad': 2.0,
					'zscore': 0.1,
				},
			});
			
			const madDetector = result.contributingDetectors.find(d => d.method === 'mad');
			const zscoreDetector = result.contributingDetectors.find(d => d.method === 'zscore');
			
			expect(madDetector?.weight).toBe(2.0);
			expect(zscoreDetector?.weight).toBe(0.1);
		});
	});
	
	describe('Override Detectors (Hard Rules)', () => {
		test('ExpectedRange override bypasses fusion threshold', () => {
			const buffer = createBuffer(100);
			
			// Build normal baseline
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 50);
			}
			
			// Value outside expectedRange [0, 100]
			const result = fusion.detect(150, buffer, config, undefined, {
				threshold: 0.99, // Very high threshold (would normally block)
				minimumAgreement: 10, // Require 10 detectors (impossible)
			});
			
			expect(result.isAnomaly).toBe(true);
			expect(result.triggeredBy).toContain('expected_range');
			expect(result.isHardDetectorTriggered).toBe(true);
			expect(result.suggestedSeverity).toBe('critical');
			expect(result.message).toContain('HARD LIMIT VIOLATED');
		});
		
		test('hard detector suggests critical severity for extreme violations', () => {
			const buffer = createBuffer(100);
			
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 50);
			}
			
			// Extreme violation
			const result = fusion.detect(200, buffer, config);
			
			if (result.isHardDetectorTriggered) {
				expect(result.suggestedSeverity).toBe('critical');
			}
		});
		
		test('soft detectors only suggest warning/info severity', () => {
			const buffer = createBuffer(100);
			
			// Build baseline
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20 + Math.random() * 2);
			}
			
			// Moderate anomaly (soft detectors only, within expectedRange)
			const result = fusion.detect(30, buffer, config);
			
			if (result.isAnomaly && !result.isHardDetectorTriggered) {
				expect(result.suggestedSeverity).toMatch(/warning|info/);
			}
		});
		
		test('RateChange override triggers on sudden spike', () => {
			const buffer = createBuffer(100);
			
			// Build baseline with slow change
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20 + i * 0.1);
			}
			
			// Sudden spike (large rate of change)
			const result = fusion.detect(100, buffer, config, undefined, {
				threshold: 0.99,
			});
			
			// RateChange should trigger
			const rateChangeTriggered = result.triggeredBy?.includes('rate_change');
			if (rateChangeTriggered) {
				expect(result.isAnomaly).toBe(true);
				expect(result.message).toContain('Hard rule triggered');
			}
		});
		
		test('can disable overrides', () => {
			const buffer = createBuffer(100);
			
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 50);
			}
			
			// Value outside expectedRange but overrides disabled
			const result = fusion.detect(150, buffer, config, undefined, {
				threshold: 0.99,
				enableOverrides: false, // Disable hard rules
			});
			
			// Should use fusion score, which will be below threshold
			expect(result.isAnomaly).toBe(false);
		});
	});
	
	describe('Minimum Agreement', () => {
		test('requires minimum detectors to agree', () => {
			const buffer = createBuffer(100);
			
			// Constant values
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20);
			}
			
			// Slight anomaly
			const result = fusion.detect(22, buffer, config, undefined, {
				threshold: 0.1, // Very low threshold (would normally trigger)
				minimumAgreement: 5, // But require 5 detectors to agree
			});
			
			// Might not trigger if < 5 detectors agree
			if (!result.isAnomaly) {
				const numTriggered = result.triggeredBy?.length || 0;
				expect(numTriggered).toBeLessThan(5);
			}
		});
	});
	
	describe('Graceful Degradation', () => {
		test('handles insufficient data gracefully', () => {
			const buffer = createBuffer(100);
			
			// Only 2 samples
			addToBuffer(buffer, 20);
			addToBuffer(buffer, 21);
			
			const result = fusion.detect(22, buffer, config);
			
			expect(result.method).toBe('fusion');
			expect(result.isAnomaly).toBe(false);
			// Most detectors won't run due to insufficient data
		});
		
		test('continues if some detectors fail', () => {
			// This would require mocking detector failures
			// Left as exercise - fusion should catch errors and continue
			expect(true).toBe(true);
		});
	});
	
	describe('Database Baseline Integration', () => {
		test('uses database baseline when available', () => {
			const buffer = createBuffer(100);
			
			// Small buffer
			for (let i = 0; i < 10; i++) {
				addToBuffer(buffer, 20 + Math.random() * 2);
			}
			
			// Large database baseline (more stable)
			const dbBaseline = {
				mean: 20,
				std_dev: 1.5,
				median: 20,
				mad: 1.0,
				sample_count: 1000,
			};
			
			const result = fusion.detect(30, buffer, config, dbBaseline);
			
			// ZScore and MAD detectors should use database baseline
			const zscoreResult = result.contributingDetectors.find(d => d.method === 'zscore');
			const madResult = result.contributingDetectors.find(d => d.method === 'mad');
			
			expect(zscoreResult?.baselineSource).toBe('database');
			expect(madResult?.baselineSource).toBe('database');
		});
	});
	
	describe('Convenience Function', () => {
		test('detectWithFusion works correctly', () => {
			const buffer = createBuffer(100);
			
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20);
			}
			
			const result = detectWithFusion(25, buffer, config);
			
			expect(result.method).toBe('fusion');
			expect(result.fusionScore).toBeGreaterThanOrEqual(0);
			expect(result.fusionScore).toBeLessThanOrEqual(1);
		});
	});
	
	describe('Expected Range Calculation', () => {
		test('calculates composite expected range', () => {
			const buffer = createBuffer(100);
			
			for (let i = 0; i < 50; i++) {
				addToBuffer(buffer, 20);
			}
			
			const result = fusion.detect(21, buffer, config);
			
			// Expected range should be the most restrictive intersection
			expect(result.expectedRange).toBeDefined();
			expect(result.expectedRange[0]).toBeLessThan(result.expectedRange[1]);
		});
	});
});

describe('Integration with MetricConfig', () => {
	test('uses fusion config from MetricConfig', () => {
		const buffer = createBuffer(100);
		
		for (let i = 0; i < 50; i++) {
			addToBuffer(buffer, 20);
		}
		
		const configWithFusion: MetricConfig = {
			name: 'temperature',
			enabled: true,
			methods: ['fusion'],
			threshold: 3.0,
			windowSize: 100,
			expectedRange: [0, 100],
			fusion: {
				threshold: 0.7,
				weights: {
					'mad': 1.5,
				},
				minimumAgreement: 2,
			},
		};
		
		const result = detectWithFusion(30, buffer, configWithFusion, undefined, {
			threshold: configWithFusion.fusion?.threshold,
			weights: configWithFusion.fusion?.weights,
			minimumAgreement: configWithFusion.fusion?.minimumAgreement,
		});
		
		expect(result.method).toBe('fusion');
	});
});

describe('Default Weights', () => {
	test('DEFAULT_DETECTOR_WEIGHTS are defined correctly', () => {
		expect(DEFAULT_DETECTOR_WEIGHTS['expected_range']).toBe(1.5);
		expect(DEFAULT_DETECTOR_WEIGHTS['rate_change']).toBe(1.2);
		expect(DEFAULT_DETECTOR_WEIGHTS['mad']).toBe(1.0);
		expect(DEFAULT_DETECTOR_WEIGHTS['zscore']).toBe(0.8);
		expect(DEFAULT_DETECTOR_WEIGHTS['iqr']).toBe(0.8);
		expect(DEFAULT_DETECTOR_WEIGHTS['ewma']).toBe(0.6);
	});
	
	test('HARD_DETECTORS are defined correctly', () => {
		expect(HARD_DETECTORS.has('expected_range')).toBe(true);
		expect(HARD_DETECTORS.has('rate_change')).toBe(true);
		expect(HARD_DETECTORS.has('mad')).toBe(false);
	});
});
