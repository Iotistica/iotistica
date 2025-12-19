/**
 * EWMA STATE MANAGEMENT TESTS
 * ============================
 * 
 * Tests for EWMA detector state handling:
 * - Reset on baseline change
 * - LRU eviction for bounded storage
 * - State persistence across detections
 */

import { createBuffer, addValue, resetBuffer } from '../../src/ai/anomaly/buffer';
import { EWMADetector } from '../../src/ai/anomaly/detectors';
import type { MetricConfig, StatisticalBuffer } from '../../src/ai/anomaly/types';

describe('EWMA State Management', () => {
	
	let detector: EWMADetector;
	let buffer: StatisticalBuffer;
	
	const baseConfig: MetricConfig = {
		name: 'test.metric',
		metricName: 'test_metric',
		detectors: ['ewma'],
		threshold: 2.0,
		windowSize: 50,
	};
	
	beforeEach(() => {
		detector = new EWMADetector();
		buffer = createBuffer(50);
		
		// Add baseline data (normal distribution around 50)
		for (let i = 0; i < 50; i++) {
			addValue(buffer, 50 + Math.random() * 10, Date.now() + i * 1000);
		}
	});
	
	describe('State Reset on Buffer Reset', () => {
		
		it('should reset EWMA state when buffer is reset', () => {
			// First detection to initialize EWMA
			const result1 = detector.detect(60, buffer, baseConfig);
			expect(result1.confidence).toBeGreaterThan(0);
			
			// Reset buffer (sets reset flag)
			resetBuffer(buffer);
			expect(buffer.reset).toBe(true);
			
			// Add new baseline data
			for (let i = 0; i < 50; i++) {
				addValue(buffer, 100 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			// EWMA should be reinitialized with new buffer mean
			const result2 = detector.detect(105, buffer, baseConfig);
			
			// Confidence should be low since value is close to new baseline (100)
			expect(result2.confidence).toBeLessThan(0.3);
			
			// Reset flag should be cleared after first addValue
			expect(buffer.reset).toBe(false);
		});
		
		it('should handle multiple resets correctly', () => {
			// First baseline
			detector.detect(55, buffer, baseConfig);
			
			// Reset 1
			resetBuffer(buffer);
			for (let i = 0; i < 50; i++) {
				addValue(buffer, 100 + Math.random() * 5, Date.now() + i * 1000);
			}
			detector.detect(105, buffer, baseConfig);
			
			// Reset 2
			resetBuffer(buffer);
			for (let i = 0; i < 50; i++) {
				addValue(buffer, 200 + Math.random() * 5, Date.now() + i * 1000);
			}
			const result = detector.detect(205, buffer, baseConfig);
			
			// Should adapt to new baseline (200)
			expect(result.confidence).toBeLessThan(0.3);
		});
		
		it('should not affect other metrics when resetting one', () => {
			const config1 = { ...baseConfig, name: 'metric1' };
			const config2 = { ...baseConfig, name: 'metric2' };
			
			const buffer1 = createBuffer(50);
			const buffer2 = createBuffer(50);
			
			// Initialize both metrics
			for (let i = 0; i < 50; i++) {
				addValue(buffer1, 50 + Math.random() * 10, Date.now() + i * 1000);
				addValue(buffer2, 100 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			detector.detect(55, buffer1, config1);
			detector.detect(105, buffer2, config2);
			
			// Reset only metric1
			resetBuffer(buffer1);
			for (let i = 0; i < 50; i++) {
				addValue(buffer1, 200 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			const result1 = detector.detect(205, buffer1, config1);
			const result2 = detector.detect(105, buffer2, config2);
			
			// Metric1 should adapt to new baseline (200)
			expect(result1.confidence).toBeLessThan(0.3);
			
			// Metric2 should still use old baseline (100)
			expect(result2.confidence).toBeLessThan(0.3);
		});
		
	});
	
	describe('LRU Eviction for Bounded Storage', () => {
		
		it('should not grow unbounded with many metrics', () => {
			// Access private field for testing
			const ewmaValues = (detector as any).ewmaValues as Map<string, { value: number; lastUsed: number }>;
			const maxSize = (detector as any).MAX_CACHE_SIZE as number;
			
			// Create buffer for testing
			const testBuffer = createBuffer(50);
			for (let i = 0; i < 50; i++) {
				addValue(testBuffer, 50 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			// Add metrics until eviction should trigger (90% threshold)
			const numMetrics = Math.floor(maxSize * 0.95);
			for (let i = 0; i < numMetrics; i++) {
				const config = { ...baseConfig, name: `metric${i}` };
				detector.detect(52, testBuffer, config);
			}
			
			// Cache should be bounded (not exceeding maxSize)
			expect(ewmaValues.size).toBeLessThanOrEqual(maxSize);
			
			// Should have evicted old entries
			expect(ewmaValues.size).toBeLessThan(numMetrics);
		});
		
		it('should evict least recently used entries first', () => {
			const testBuffer = createBuffer(50);
			for (let i = 0; i < 50; i++) {
				addValue(testBuffer, 50 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			// Access metrics in specific order
			const configs = [
				{ ...baseConfig, name: 'old_metric_1' },
				{ ...baseConfig, name: 'old_metric_2' },
				{ ...baseConfig, name: 'recent_metric' },
			];
			
			// Access old metrics first
			detector.detect(52, testBuffer, configs[0]);
			detector.detect(52, testBuffer, configs[1]);
			
			// Wait a bit
			const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
			
			return delay(10).then(() => {
				// Access recent metric
				detector.detect(52, testBuffer, configs[2]);
				
				// Trigger eviction by adding many metrics
				const ewmaValues = (detector as any).ewmaValues as Map<string, { value: number; lastUsed: number }>;
				const maxSize = (detector as any).MAX_CACHE_SIZE as number;
				
				for (let i = 0; i < Math.floor(maxSize * 0.95); i++) {
					detector.detect(52, testBuffer, { ...baseConfig, name: `filler${i}` });
				}
				
				// Recent metric should still be in cache
				expect(ewmaValues.has('recent_metric')).toBe(true);
			});
		});
		
		it('should update lastUsed timestamp on each access', async () => {
			const testBuffer = createBuffer(50);
			for (let i = 0; i < 50; i++) {
				addValue(testBuffer, 50 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			const config = { ...baseConfig, name: 'test_metric' };
			
			// First access
			detector.detect(52, testBuffer, config);
			const ewmaValues = (detector as any).ewmaValues as Map<string, { value: number; lastUsed: number }>;
			const firstTimestamp = ewmaValues.get('test_metric')?.lastUsed;
			
			expect(firstTimestamp).toBeDefined();
			
			// Wait 10ms
			await new Promise(resolve => setTimeout(resolve, 10));
			
			// Second access
			detector.detect(53, testBuffer, config);
			const secondTimestamp = ewmaValues.get('test_metric')?.lastUsed;
			
			expect(secondTimestamp).toBeDefined();
			expect(secondTimestamp!).toBeGreaterThan(firstTimestamp!);
		});
		
	});
	
	describe('State Persistence Across Detections', () => {
		
		it('should maintain EWMA state across multiple detections', () => {
			const config = { ...baseConfig, name: 'persistent_metric' };
			
			// First detection initializes EWMA
			const result1 = detector.detect(55, buffer, config);
			
			// Subsequent detections should use updated EWMA
			const result2 = detector.detect(60, buffer, config);
			const result3 = detector.detect(65, buffer, config);
			
			// All should succeed (not re-initialize)
			expect(result1.isAnomaly).toBeDefined();
			expect(result2.isAnomaly).toBeDefined();
			expect(result3.isAnomaly).toBeDefined();
			
			// EWMA should smooth out gradual changes
			// (confidence should increase gradually, not spike immediately)
			expect(result1.confidence).toBeLessThan(result3.confidence);
		});
		
		it('should handle different metrics independently', () => {
			const config1 = { ...baseConfig, name: 'metric_a' };
			const config2 = { ...baseConfig, name: 'metric_b' };
			
			const buffer1 = createBuffer(50);
			const buffer2 = createBuffer(50);
			
			// Different baselines
			for (let i = 0; i < 50; i++) {
				addValue(buffer1, 50 + Math.random() * 10, Date.now() + i * 1000);
				addValue(buffer2, 100 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			// Detect with same value but different baselines
			const result1 = detector.detect(75, buffer1, config1);
			const result2 = detector.detect(75, buffer2, config2);
			
			// Result1 should show anomaly (75 >> 50)
			expect(result1.isAnomaly).toBe(true);
			
			// Result2 should be normal (75 close to 100)
			expect(result2.isAnomaly).toBe(false);
		});
		
	});
	
	describe('Edge Cases', () => {
		
		it('should handle buffer reset with no prior state', () => {
			const freshBuffer = createBuffer(50);
			
			// Reset before any data
			resetBuffer(freshBuffer);
			expect(freshBuffer.reset).toBe(true);
			
			// Add data
			for (let i = 0; i < 50; i++) {
				addValue(freshBuffer, 50 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			// Should not crash
			const result = detector.detect(55, freshBuffer, baseConfig);
			expect(result).toBeDefined();
			expect(freshBuffer.reset).toBe(false);
		});
		
		it('should handle empty metric name gracefully', () => {
			const config = { ...baseConfig, name: '' };
			
			// Should not crash with empty name
			const result = detector.detect(55, buffer, config);
			expect(result).toBeDefined();
		});
		
		it('should handle very long metric names', () => {
			const longName = 'a'.repeat(1000);
			const config = { ...baseConfig, name: longName };
			
			// Should handle long names without issues
			const result = detector.detect(55, buffer, config);
			expect(result).toBeDefined();
		});
		
	});
	
});
