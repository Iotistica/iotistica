/**
 * CONFIDENCE NORMALIZATION TESTS
 * ===============================
 * 
 * Tests for confidence score normalization across all detectors
 */

import { createBuffer, addValue } from '../../src/ai/anomaly/buffer';
import { ZScoreDetector, MADDetector, IQRDetector, ExpectedRangeDetector, RateChangeDetector, EWMADetector } from '../../src/ai/anomaly/detectors';
import { sigmoid, binaryConfidence, exponentialConfidence } from '../../src/ai/anomaly/confidence';
import type { MetricConfig, StatisticalBuffer } from '../../src/ai/anomaly/types';

describe('Confidence Normalization', () => {
	
	describe('Sigmoid Function', () => {
		
		it('should return 0.5 at threshold', () => {
			const threshold = 3.0;
			const result = sigmoid(threshold, threshold);
			expect(result).toBeCloseTo(0.5, 2);
		});
		
		it('should approach 1.0 for large deviations', () => {
			const threshold = 3.0;
			const largeDeviation = threshold * 5;
			const result = sigmoid(largeDeviation, threshold);
			expect(result).toBeGreaterThan(0.9);
		});
		
		it('should approach 0.0 for small deviations', () => {
			const threshold = 3.0;
			const smallDeviation = threshold * 0.1;
			const result = sigmoid(smallDeviation, threshold);
			expect(result).toBeLessThan(0.1);
		});
		
		it('should scale smoothly (no discontinuities)', () => {
			const threshold = 3.0;
			const deviations = [0.5, 1.0, 2.0, 3.0, 4.0, 5.0];
			const confidences = deviations.map(d => sigmoid(d, threshold));
			
			// Each confidence should be higher than the previous
			for (let i = 1; i < confidences.length; i++) {
				expect(confidences[i]).toBeGreaterThan(confidences[i - 1]);
			}
		});
		
		it('should be steeper with higher steepness parameter', () => {
			const threshold = 3.0;
			const deviation = threshold;
			
			const normalSteepness = sigmoid(deviation, threshold, 2.0);
			const highSteepness = sigmoid(deviation, threshold, 5.0);
			
			// Both should be around 0.5 at threshold
			expect(normalSteepness).toBeCloseTo(0.5, 1);
			expect(highSteepness).toBeCloseTo(0.5, 1);
			
			// But high steepness should reach extremes faster
			const largeDeviation = threshold * 2;
			const normalLarge = sigmoid(largeDeviation, threshold, 2.0);
			const highLarge = sigmoid(largeDeviation, threshold, 5.0);
			
			expect(highLarge).toBeGreaterThan(normalLarge);
		});
		
	});
	
	describe('Binary Confidence', () => {
		
		it('should return 1.0 for positive deviation', () => {
			expect(binaryConfidence(0.1, 0.0)).toBe(1.0);
			expect(binaryConfidence(5.0, 0.0)).toBe(1.0);
		});
		
		it('should return 0.0 for zero deviation', () => {
			expect(binaryConfidence(0.0, 0.0)).toBe(0.0);
		});
		
		it('should have no gradual scaling', () => {
			const deviations = [0.0, 0.1, 0.5, 1.0, 5.0];
			const confidences = deviations.map(d => binaryConfidence(d, 0.0));
			
			expect(confidences[0]).toBe(0.0);
			for (let i = 1; i < confidences.length; i++) {
				expect(confidences[i]).toBe(1.0);
			}
		});
		
	});
	
	describe('Exponential Confidence', () => {
		
		it('should emphasize large deviations', () => {
			const threshold = 10.0;
			
			const small = exponentialConfidence(threshold * 0.5, threshold);
			const medium = exponentialConfidence(threshold * 1.0, threshold);
			const large = exponentialConfidence(threshold * 2.0, threshold);
			
			// Exponential should grow faster than linear
			const linearSmall = 0.5;
			const linearMedium = 1.0;
			const linearLarge = 2.0;
			
			// Exponential should be relatively smaller for small deviations
			expect(small).toBeLessThan(linearSmall);
			
			// But grow much faster for large deviations
			expect(large).toBeGreaterThan(linearLarge / 2);
		});
		
		it('should always be in [0, 1] range', () => {
			const threshold = 10.0;
			const testCases = [0, 1, 5, 10, 50, 100];
			
			testCases.forEach(deviation => {
				const confidence = exponentialConfidence(deviation, threshold);
				expect(confidence).toBeGreaterThanOrEqual(0);
				expect(confidence).toBeLessThanOrEqual(1);
			});
		});
		
	});
	
	describe('Detector Confidence Normalization', () => {
		
		let buffer: StatisticalBuffer;
		const config: MetricConfig = {
			metricName: 'test_metric',
			detectors: ['zscore', 'mad', 'iqr', 'expected_range', 'rate_change', 'ewma'],
			threshold: 3.0,
			windowSize: 50,
		};
		
		beforeEach(() => {
			buffer = createBuffer(50);
			// Add baseline data (normal distribution around 50)
			for (let i = 0; i < 50; i++) {
				addValue(buffer, 50 + Math.random() * 10, Date.now() + i * 1000);
			}
		});
		
		it('ZScore should use sigmoid confidence', () => {
			const detector = new ZScoreDetector();
			
			// Normal value (close to mean)
			const normal = detector.detect(buffer, 52, config);
			expect(normal.confidence).toBeLessThan(0.2);
			
			// Anomalous value (3+ std devs)
			const anomaly = detector.detect(buffer, 100, config);
			expect(anomaly.confidence).toBeGreaterThan(0.5);
			expect(anomaly.confidence).toBeLessThanOrEqual(1.0);
		});
		
		it('MAD should use sigmoid confidence', () => {
			const detector = new MADDetector();
			
			// Normal value
			const normal = detector.detect(buffer, 52, config);
			expect(normal.confidence).toBeLessThan(0.2);
			
			// Anomalous value
			const anomaly = detector.detect(buffer, 100, config);
			expect(anomaly.confidence).toBeGreaterThan(0.5);
			expect(anomaly.confidence).toBeLessThanOrEqual(1.0);
		});
		
		it('IQR should use sigmoid confidence', () => {
			const detector = new IQRDetector();
			
			// Normal value (within IQR)
			const normal = detector.detect(buffer, 52, { ...config, threshold: 1.5 });
			expect(normal.confidence).toBeLessThan(0.2);
			
			// Anomalous value (outside fences)
			const anomaly = detector.detect(buffer, 100, { ...config, threshold: 1.5 });
			expect(anomaly.confidence).toBeGreaterThan(0.5);
			expect(anomaly.confidence).toBeLessThanOrEqual(1.0);
		});
		
		it('ExpectedRange should use binary confidence', () => {
			const rangeConfig: MetricConfig = {
				...config,
				detectors: ['expected_range'],
				expectedRange: { min: 40, max: 60 },
			};
			
			const detector = new ExpectedRangeDetector();
			
			// Within range → confidence should be 0
			const withinRange = detector.detect(buffer, 50, rangeConfig);
			expect(withinRange.confidence).toBe(0.0);
			
			// Outside range → confidence should be 1.0
			const outsideRange = detector.detect(buffer, 100, rangeConfig);
			expect(outsideRange.confidence).toBe(1.0);
			
			// No gradual scaling
			const slightlyOutside = detector.detect(buffer, 61, rangeConfig);
			expect(slightlyOutside.confidence).toBe(1.0);
		});
		
		it('RateChange should use exponential confidence', () => {
			const rateConfig: MetricConfig = {
				...config,
				detectors: ['rate_change'],
				threshold: 10.0, // 10% change threshold
			};
			
			const detector = new RateChangeDetector();
			
			// Small rate change
			const small = detector.detect(buffer, 52, rateConfig);
			expect(small.confidence).toBeLessThan(0.3);
			
			// Large spike (emphasize sudden changes)
			const spike = detector.detect(buffer, 200, rateConfig);
			expect(spike.confidence).toBeGreaterThan(0.7);
			expect(spike.confidence).toBeLessThanOrEqual(1.0);
		});
		
		it('EWMA should use sigmoid confidence', () => {
			const ewmaConfig: MetricConfig = {
				...config,
				detectors: ['ewma'],
				threshold: 2.0,
			};
			
			const detector = new EWMADetector();
			
			// Normal value
			const normal = detector.detect(buffer, 52, ewmaConfig);
			expect(normal.confidence).toBeLessThan(0.2);
			
			// Anomalous value
			const anomaly = detector.detect(buffer, 100, ewmaConfig);
			expect(anomaly.confidence).toBeGreaterThan(0.5);
			expect(anomaly.confidence).toBeLessThanOrEqual(1.0);
		});
		
		it('All detectors should produce comparable confidence scores', () => {
			// Test with same anomalous value across all detectors
			const anomalousValue = 100;
			
			const zscore = new ZScoreDetector().detect(buffer, anomalousValue, config);
			const mad = new MADDetector().detect(buffer, anomalousValue, config);
			const iqr = new IQRDetector().detect(buffer, anomalousValue, { ...config, threshold: 1.5 });
			const range = new ExpectedRangeDetector().detect(buffer, anomalousValue, {
				...config,
				detectors: ['expected_range'],
				expectedRange: { min: 40, max: 60 },
			});
			const rate = new RateChangeDetector().detect(buffer, anomalousValue, { ...config, threshold: 10.0 });
			const ewma = new EWMADetector().detect(buffer, anomalousValue, { ...config, threshold: 2.0 });
			
			// All confidences should be high (>0.5) for this obvious anomaly
			expect(zscore.confidence).toBeGreaterThan(0.5);
			expect(mad.confidence).toBeGreaterThan(0.5);
			expect(iqr.confidence).toBeGreaterThan(0.5);
			expect(range.confidence).toBe(1.0); // Binary: always 1.0 for violations
			expect(rate.confidence).toBeGreaterThan(0.5);
			expect(ewma.confidence).toBeGreaterThan(0.5);
			
			// All should be ≤ 1.0
			expect(zscore.confidence).toBeLessThanOrEqual(1.0);
			expect(mad.confidence).toBeLessThanOrEqual(1.0);
			expect(iqr.confidence).toBeLessThanOrEqual(1.0);
			expect(range.confidence).toBeLessThanOrEqual(1.0);
			expect(rate.confidence).toBeLessThanOrEqual(1.0);
			expect(ewma.confidence).toBeLessThanOrEqual(1.0);
			
			// Soft detectors should have similar confidence ranges (within 0.3)
			const softConfidences = [zscore.confidence, mad.confidence, iqr.confidence, ewma.confidence];
			const min = Math.min(...softConfidences);
			const max = Math.max(...softConfidences);
			
			expect(max - min).toBeLessThan(0.3);
		});
		
		it('All detectors should return 0 confidence for normal values', () => {
			const normalValue = 52; // Close to mean
			
			const zscore = new ZScoreDetector().detect(buffer, normalValue, config);
			const mad = new MADDetector().detect(buffer, normalValue, config);
			const iqr = new IQRDetector().detect(buffer, normalValue, { ...config, threshold: 1.5 });
			const range = new ExpectedRangeDetector().detect(buffer, normalValue, {
				...config,
				detectors: ['expected_range'],
				expectedRange: { min: 40, max: 60 },
			});
			const rate = new RateChangeDetector().detect(buffer, normalValue, { ...config, threshold: 10.0 });
			const ewma = new EWMADetector().detect(buffer, normalValue, { ...config, threshold: 2.0 });
			
			// All confidences should be low (<0.2) for normal values
			expect(zscore.confidence).toBeLessThan(0.2);
			expect(mad.confidence).toBeLessThan(0.2);
			expect(iqr.confidence).toBeLessThan(0.2);
			expect(range.confidence).toBe(0.0); // Binary: always 0.0 for normal
			expect(rate.confidence).toBeLessThan(0.3); // Rate change may have slight variance
			expect(ewma.confidence).toBeLessThan(0.2);
		});
		
	});
	
	describe('Confidence Range Validation', () => {
		
		it('should ensure all detector confidences are in [0, 1]', () => {
			const buffer = createBuffer(50);
			
			// Add baseline data
			for (let i = 0; i < 50; i++) {
				addValue(buffer, 50 + Math.random() * 10, Date.now() + i * 1000);
			}
			
			const config: MetricConfig = {
				metricName: 'test_metric',
				detectors: ['zscore', 'mad', 'iqr', 'expected_range', 'rate_change', 'ewma'],
				threshold: 3.0,
				windowSize: 50,
				expectedRange: { min: 40, max: 60 },
			};
			
			const detectors = [
				new ZScoreDetector(),
				new MADDetector(),
				new IQRDetector(),
				new ExpectedRangeDetector(),
				new RateChangeDetector(),
				new EWMADetector(),
			];
			
			// Test with various values (normal, anomalous, extreme)
			const testValues = [50, 52, 60, 70, 100, 200];
			
			testValues.forEach(value => {
				detectors.forEach(detector => {
					const result = detector.detect(buffer, value, config);
					
					expect(result.confidence).toBeGreaterThanOrEqual(0);
					expect(result.confidence).toBeLessThanOrEqual(1);
					expect(Number.isFinite(result.confidence)).toBe(true);
				});
			});
		});
		
	});
	
});
