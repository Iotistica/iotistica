/**
 * RATE-CHANGE DETECTOR FIX TESTS
 * ================================
 * 
 * Tests for rate-change detector fix addressing:
 * - Division by near-zero mean
 * - Epsilon protection
 * - Previous value vs mean comparison
 */

import { createBuffer, addValue } from '../../src/ai/anomaly/buffer';
import { RateChangeDetector } from '../../src/ai/anomaly/detectors';
import type { MetricConfig } from '../../src/ai/anomaly/types';

describe('Rate-Change Detector Fix', () => {
	
	let detector: RateChangeDetector;
	
	const baseConfig: MetricConfig = {
		metricName: 'test_metric',
		detectors: ['rate_change'],
		threshold: 10.0, // 10% change threshold
		windowSize: 50,
	};
	
	beforeEach(() => {
		detector = new RateChangeDetector();
	});
	
	describe('Division by Near-Zero Mean', () => {
		
		it('should handle low-magnitude metrics without inflating percentages', () => {
			const buffer = createBuffer(50);
			
			// Low-magnitude metric (CPU busy %, normally 0.5-0.6%)
			const now = Date.now();
			addValue(buffer, 0.5, now - 5000);
			addValue(buffer, 0.6, now - 4000);
			addValue(buffer, 0.5, now - 3000);
			addValue(buffer, 0.55, now - 2000);
			addValue(buffer, 0.52, now - 1000);
			
			// Mean is very low (~0.53)
			expect(buffer.mean).toBeLessThan(1.0);
			
			// Spike to 1.0 (about 2x previous value)
			const result = detector.detect(1.0, buffer, baseConfig);
			
			// Should detect anomaly (92% increase from 0.52)
			expect(result.isAnomaly).toBe(true);
			
			// Percentage should be reasonable (not 10,000%)
			expect(result.deviation).toBeGreaterThan(50); // At least 50% change
			expect(result.deviation).toBeLessThan(200); // But not absurdly high
		});
		
		it('should use epsilon protection for near-zero previous values', () => {
			const buffer = createBuffer(50);
			
			// Very low values near zero
			const now = Date.now();
			addValue(buffer, 0.001, now - 2000);
			addValue(buffer, 0.0005, now - 1000); // Previous value very close to zero
			
			// Spike to 0.1
			const result = detector.detect(0.1, buffer, baseConfig);
			
			// Should not throw or return Infinity
			expect(result.deviation).toBeDefined();
			expect(Number.isFinite(result.deviation)).toBe(true);
			expect(result.confidence).toBeDefined();
			expect(Number.isFinite(result.confidence)).toBe(true);
			
			// Should detect as anomaly (large spike from near-zero)
			expect(result.isAnomaly).toBe(true);
		});
		
		it('should handle zero-to-nonzero transition', () => {
			const buffer = createBuffer(50);
			
			const now = Date.now();
			addValue(buffer, 0.0, now - 2000);
			addValue(buffer, 0.0, now - 1000); // Previous value is exactly zero
			
			// Spike from 0 to 5
			const result = detector.detect(5.0, buffer, baseConfig);
			
			// Should use epsilon (0.001) as denominator
			// percentChange = |5.0 - 0| / max(|0|, 0.001) * 100 = 5.0 / 0.001 * 100 = 500,000%
			
			// Should detect anomaly without division by zero
			expect(result.isAnomaly).toBe(true);
			expect(Number.isFinite(result.deviation)).toBe(true);
			expect(result.deviation).toBeGreaterThan(1000); // Very large change
		});
		
	});
	
	describe('Previous Value vs Mean Comparison', () => {
		
		it('should compare to previous value, not mean', () => {
			const buffer = createBuffer(50);
			
			// Create scenario where mean != previous value
			const now = Date.now();
			addValue(buffer, 50, now - 5000);
			addValue(buffer, 55, now - 4000);
			addValue(buffer, 60, now - 3000);
			addValue(buffer, 65, now - 2000);
			addValue(buffer, 70, now - 1000); // Previous value = 70
			
			// Mean = 60, Previous = 70
			expect(buffer.mean).toBeCloseTo(60, 0);
			
			// New value = 85 (21.4% increase from 70, but 41.7% from mean)
			const result = detector.detect(85, buffer, baseConfig);
			
			// Should calculate based on previous value (70), not mean (60)
			// percentChange = |85 - 70| / 70 * 100 = 21.4%
			expect(result.deviation).toBeCloseTo(21.4, 0);
			
			// Should detect as anomaly (21.4% > 10% threshold)
			expect(result.isAnomaly).toBe(true);
		});
		
		it('should detect sudden drops correctly', () => {
			const buffer = createBuffer(50);
			
			const now = Date.now();
			addValue(buffer, 100, now - 2000);
			addValue(buffer, 95, now - 1000); // Previous value = 95
			
			// Sudden drop to 50 (47.4% decrease from 95)
			const result = detector.detect(50, buffer, baseConfig);
			
			// percentChange = |50 - 95| / 95 * 100 = 47.4%
			expect(result.deviation).toBeCloseTo(47.4, 0);
			expect(result.isAnomaly).toBe(true);
		});
		
		it('should handle gradual increases as normal', () => {
			const buffer = createBuffer(50);
			
			const now = Date.now();
			addValue(buffer, 50, now - 2000);
			addValue(buffer, 52, now - 1000); // Previous value = 52
			
			// Small increase to 54 (3.8% from 52)
			const result = detector.detect(54, buffer, baseConfig);
			
			// percentChange = |54 - 52| / 52 * 100 = 3.8%
			expect(result.deviation).toBeCloseTo(3.8, 0);
			
			// Should NOT detect as anomaly (3.8% < 10% threshold)
			expect(result.isAnomaly).toBe(false);
		});
		
	});
	
	describe('Epsilon Protection Validation', () => {
		
		it('should never return Infinity or NaN', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			// Test various edge cases
			const testCases = [
				{ prev: 0.0, current: 0.0 },      // Zero to zero
				{ prev: 0.0, current: 100.0 },    // Zero to large
				{ prev: 0.0001, current: 0.0 },   // Small to zero
				{ prev: -0.01, current: 0.01 },   // Negative to positive
				{ prev: 0.0005, current: 0.001 }, // Tiny values
			];
			
			testCases.forEach(({ prev, current }) => {
				// Reset buffer
				const testBuffer = createBuffer(50);
				addValue(testBuffer, prev - 0.001, now - 2000);
				addValue(testBuffer, prev, now - 1000);
				
				const result = detector.detect(current, testBuffer, baseConfig);
				
				// Must be finite
				expect(Number.isFinite(result.deviation)).toBe(true);
				expect(Number.isFinite(result.confidence)).toBe(true);
				expect(Number.isNaN(result.deviation)).toBe(false);
				expect(Number.isNaN(result.confidence)).toBe(false);
				
				// Must be non-negative
				expect(result.deviation).toBeGreaterThanOrEqual(0);
				expect(result.confidence).toBeGreaterThanOrEqual(0);
			});
		});
		
		it('should apply epsilon = 0.001 as minimum denominator', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			addValue(buffer, 0.0, now - 2000);
			addValue(buffer, 0.0, now - 1000); // Previous = 0
			
			// Change from 0 to 0.01
			const result = detector.detect(0.01, buffer, baseConfig);
			
			// percentChange = |0.01 - 0| / max(0, 0.001) * 100 = 0.01 / 0.001 * 100 = 1000%
			expect(result.deviation).toBeCloseTo(1000, -1); // Allow some rounding
			expect(result.isAnomaly).toBe(true); // 1000% >> 10% threshold
		});
		
	});
	
	describe('Expected Range Calculation', () => {
		
		it('should base expected range on previous value, not mean', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			addValue(buffer, 50, now - 2000);
			addValue(buffer, 100, now - 1000); // Previous value = 100
			
			// Threshold = 10%
			const result = detector.detect(105, buffer, baseConfig);
			
			// Expected range should be previousValue ± 10%
			// 100 ± 10 = [90, 110]
			expect(result.expectedRange[0]).toBeCloseTo(90, 0);
			expect(result.expectedRange[1]).toBeCloseTo(110, 0);
		});
		
		it('should handle negative values in expected range', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			addValue(buffer, -50, now - 2000);
			addValue(buffer, -100, now - 1000); // Previous value = -100
			
			const result = detector.detect(-105, buffer, baseConfig);
			
			// Expected range: -100 ± 10% of |-100| = -100 ± 10 = [-110, -90]
			expect(result.expectedRange[0]).toBeCloseTo(-110, 0);
			expect(result.expectedRange[1]).toBeCloseTo(-90, 0);
		});
		
	});
	
	describe('Real-World Scenarios', () => {
		
		it('should detect CPU spike on low-usage server', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			// Server normally idle (1-2% CPU)
			for (let i = 10; i > 0; i--) {
				addValue(buffer, 1.0 + Math.random() * 1.0, now - i * 1000);
			}
			
			// Sudden spike to 50% CPU
			const result = detector.detect(50, buffer, { ...baseConfig, threshold: 20.0 });
			
			// Should detect as anomaly (massive % increase from ~2%)
			expect(result.isAnomaly).toBe(true);
			expect(result.deviation).toBeGreaterThan(500); // At least 500% increase
		});
		
		it('should NOT false-positive on percentage metrics near 100%', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			// Disk usage normally 95-99%
			addValue(buffer, 95, now - 3000);
			addValue(buffer, 97, now - 2000);
			addValue(buffer, 98, now - 1000); // Previous = 98%
			
			// Slight increase to 99%
			const result = detector.detect(99, buffer, baseConfig);
			
			// percentChange = |99 - 98| / 98 * 100 = 1.02%
			expect(result.deviation).toBeLessThan(2);
			
			// Should NOT detect as anomaly (1.02% < 10% threshold)
			expect(result.isAnomaly).toBe(false);
		});
		
		it('should detect network traffic spike', () => {
			const buffer = createBuffer(50);
			const now = Date.now();
			
			// Normal traffic: 10-12 Mbps
			addValue(buffer, 10, now - 3000);
			addValue(buffer, 11, now - 2000);
			addValue(buffer, 12, now - 1000); // Previous = 12 Mbps
			
			// Sudden spike to 50 Mbps
			const result = detector.detect(50, buffer, { ...baseConfig, threshold: 50.0 });
			
			// percentChange = |50 - 12| / 12 * 100 = 316.7%
			expect(result.deviation).toBeGreaterThan(300);
			
			// Should detect as anomaly
			expect(result.isAnomaly).toBe(true);
			expect(result.confidence).toBeGreaterThan(0.8); // High confidence
		});
		
	});
	
});
