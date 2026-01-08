/**
 * ANOMALY DETECTORS - STATISTICAL & ML METHODS
 * ==============================================
 * 
 * Implements multiple detection algorithms optimized for edge devices
 */

import type { AnomalyDetector, DetectionResult, MetricConfig, StatisticalBuffer } from './types';
import { getMAD, getIQR, getPercentile, getRateOfChange } from './buffer';
import { sigmoid, binaryConfidence, exponentialConfidence } from './confidence';

/**
 * Z-Score Detector
 * Detects outliers based on standard deviations from mean
 */
export class ZScoreDetector implements AnomalyDetector {
	readonly method = 'zscore' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: { mean: number; std_dev: number; sample_count: number }): DetectionResult {
		// Z-score requires ~50 samples for Central Limit Theorem confidence
		// 50 samples = ~4 minutes @ 5sec intervals
		if (buffer.size < 50) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: `Collecting baseline data (${buffer.size}/50 samples)`,
			};
		}
		
		// If expectedRange configured, use it as absolute bounds (hard detector)
		// This prevents false positives from statistical detectors on stable metrics (e.g., grid frequency)
		if (config.expectedRange && config.expectedRange.length === 2) {
			const [min, max] = config.expectedRange;
			if (value >= min && value <= max) {
				return {
					method: this.method,
					isAnomaly: false,
					confidence: 0,
					deviation: 0,
					expectedRange: [min, max],
					message: `Value within expected range [${min.toFixed(2)}, ${max.toFixed(2)}]`,
				};
			}
		}
		
		// Prefer database baseline if available (more samples = more stable)
		const useDbBaseline = dbBaseline && dbBaseline.sample_count >= 100;
		const mean = useDbBaseline ? dbBaseline.mean : buffer.mean;
		const stdDev = useDbBaseline ? dbBaseline.std_dev : buffer.stdDev;
		const baselineSource = useDbBaseline ? 'database' as const : 'buffer' as const;
		
		// Use epsilon floor to prevent division blow-ups on flatlined signals
		// Avoids treating tiny deviations as critical anomalies when stdDev ≈ 0
		const STDDEV_EPSILON = config.stdDevEpsilon ?? 0.05;
		const effectiveStdDev = Math.max(stdDev, STDDEV_EPSILON);
		
		const threshold = config.threshold || 3.0;
		const zScore = Math.abs((value - mean) / effectiveStdDev);
		const isAnomaly = zScore > threshold;
		
		// Normalized confidence using sigmoid function
		// confidence = sigmoid(zScore / threshold)
		// This gives smooth scaling: zScore=threshold → 0.5, zScore>>threshold → 1.0
		const confidence = sigmoid(zScore, threshold);
		
		const expectedRange: [number, number] = [
			mean - threshold * effectiveStdDev,
			mean + threshold * effectiveStdDev,
		];
		
		return {
			method: this.method,
			isAnomaly,
			confidence,
			deviation: zScore,
			expectedRange,
			baselineSource,
			message: isAnomaly 
				? `Value ${value.toFixed(2)} is ${zScore.toFixed(2)}σ from mean ${mean.toFixed(2)} (${baselineSource})`
				: `Value within ${threshold}σ of mean (${baselineSource})`,
		};
	}
}

/**
 * MAD (Median Absolute Deviation) Detector
 * More robust to outliers than Z-score
 */
export class MADDetector implements AnomalyDetector {
	readonly method = 'mad' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: { median?: number; mad?: number; sample_count: number }): DetectionResult {
		// MAD requires ~50 samples for robust median/MAD calculation
		// 50 samples = ~4 minutes @ 5sec intervals
		if (buffer.size < 50 && (!dbBaseline || dbBaseline.sample_count < 50)) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: `Collecting baseline data (${buffer.size}/50 samples)`,
			};
		}
		
		// If expectedRange configured, use it as absolute bounds (hard detector)
		// This prevents false positives from statistical detectors on stable metrics (e.g., grid frequency)
		if (config.expectedRange && config.expectedRange.length === 2) {
			const [min, max] = config.expectedRange;
			if (value >= min && value <= max) {
				return {
					method: this.method,
					isAnomaly: false,
					confidence: 0,
					deviation: 0,
					expectedRange: [min, max],
					message: `Value within expected range [${min.toFixed(2)}, ${max.toFixed(2)}]`,
				};
			}
		}
		
		// Prefer database baseline if available (more samples = more stable)
		const useDbBaseline = dbBaseline && dbBaseline.sample_count >= 100 &&
			dbBaseline.median !== null && dbBaseline.median !== undefined &&
			dbBaseline.mad !== null && dbBaseline.mad !== undefined;
		const mad = useDbBaseline ? dbBaseline.mad! : getMAD(buffer);
		const median = useDbBaseline ? dbBaseline.median! : buffer.values.slice(0, buffer.size).sort((a, b) => a - b)[Math.floor(buffer.size / 2)];
		const baselineSource = useDbBaseline ? 'database' as const : 'buffer' as const;
		
		// Use epsilon floor to prevent division blow-ups on flatlined signals
		// Avoids treating tiny deviations as critical anomalies when MAD ≈ 0
		const MAD_EPSILON = config.madEpsilon ?? 0.05;
		const effectiveMAD = Math.max(mad, MAD_EPSILON);
		
		// Scale MAD to make it comparable to standard deviation (1.4826 ≈ 1/Φ⁻¹(3/4))
		// This makes threshold = 3 behave like 3σ (Z-score) but with robust statistics
		const MAD_SCALE = 1.4826;
		const scaledMAD = effectiveMAD * MAD_SCALE;
		
		const threshold = config.threshold || 3.0;
		const madScore = Math.abs((value - median) / scaledMAD);
		const isAnomaly = madScore > threshold;
		
		// Normalized confidence using sigmoid function
		const confidence = sigmoid(madScore, threshold);
		
		const expectedRange: [number, number] = [
			median - threshold * scaledMAD,
			median + threshold * scaledMAD,
		];
		
		return {
			method: this.method,
			isAnomaly,
			confidence,
			deviation: madScore,
			expectedRange,
			baselineSource,
			message: isAnomaly 
				? `Value ${value.toFixed(2)} is ${madScore.toFixed(2)} MADs from median ${median.toFixed(2)} (${baselineSource})`
				: `Value within ${threshold} MADs of median (${baselineSource})`,
		};
	}
}

/**
 * IQR (Interquartile Range) Detector
 * Detects outliers using quartiles (Tukey's method)
 */
export class IQRDetector implements AnomalyDetector {
	readonly method = 'iqr' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig): DetectionResult {
		// IQR requires ~50 samples for meaningful quartile calculation
		// 50 samples = ~4 minutes @ 5sec intervals
		if (buffer.size < 50) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: `Collecting baseline data (${buffer.size}/50 samples)`,
			};
		}
		
		const q1 = getPercentile(buffer, 0.25);
		const q3 = getPercentile(buffer, 0.75);
		const iqr = getIQR(buffer);
		
		// Tukey's fences: [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
		const multiplier = config.threshold || 1.5;
		const lowerFence = q1 - multiplier * iqr;
		const upperFence = q3 + multiplier * iqr;
		
		const isAnomaly = value < lowerFence || value > upperFence;
		
		// Distance from nearest fence
		let distance = 0;
		if (value < lowerFence) {
			distance = lowerFence - value;
		} else if (value > upperFence) {
			distance = value - upperFence;
		}
		
		// Normalized confidence using sigmoid function
		// Use IQR as threshold for normalization
		const deviation = iqr > 0 ? distance / iqr : 0;
		const confidence = sigmoid(deviation, 1.0); // threshold=1.0 since already normalized
		
		return {
			method: this.method,
			isAnomaly,
			confidence,
			deviation: iqr > 0 ? distance / iqr : 0,
			expectedRange: [lowerFence, upperFence],
			message: isAnomaly 
				? `Value ${value.toFixed(2)} outside IQR fences [${lowerFence.toFixed(2)}, ${upperFence.toFixed(2)}]`
				: `Value within IQR fences`,
		};
	}
}

/**
 * Expected Range Detector
 * Simple range check against configured min/max values
 */
export class ExpectedRangeDetector implements AnomalyDetector {
	readonly method = 'expected_range' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: { median?: number; mad?: number; sample_count: number }): DetectionResult {
		// Must have expectedRange configured
		if (!config.expectedRange || config.expectedRange.length !== 2) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: 'No expected range configured',
			};
		}
		
		// Require minimum baseline samples before alerting to avoid false positives during initial collection
		// 30 samples = ~2.5 minutes @ 5sec intervals (sufficient for basic range validation)
		const MIN_SAMPLES_FOR_RANGE_DETECTION = 30;
		if (buffer.size < MIN_SAMPLES_FOR_RANGE_DETECTION) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: config.expectedRange,
				message: `Collecting baseline data (${buffer.size}/${MIN_SAMPLES_FOR_RANGE_DETECTION} samples)`,
			};
		}
		
		const [min, max] = config.expectedRange;
		const isAnomaly = value < min || value > max;
		
		// Calculate deviation as percentage outside range
		let deviation = 0;
		if (value < min) {
			deviation = (min - value) / (max - min);
		} else if (value > max) {
			deviation = (value - max) / (max - min);
		}
		
		// Binary confidence for hard detector (no gray area)
		// Use binary: 1.0 for violations, 0.0 for within range
		const confidence = binaryConfidence(Math.abs(deviation), 0.0);
		
		return {
			method: this.method,
			isAnomaly,
			confidence,
			deviation: Math.abs(deviation),
			expectedRange: [min, max],
			message: isAnomaly
				? `Value ${value.toFixed(2)} outside expected range [${min}, ${max}]`
				: `Value within expected range [${min}, ${max}]`,
		};
	}
}

/**
 * Rate of Change Detector
 * Detects sudden spikes/drops based on velocity
 */
export class RateChangeDetector implements AnomalyDetector {
	readonly method = 'rate_change' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: { median?: number; mad?: number; sample_count: number }): DetectionResult {
		if (buffer.size < 2) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: 'Insufficient data for rate change detection (need at least 2 samples)',
			};
		}
		
		// Get previous value from buffer (most recent sample before current)
		const previousIndex = (buffer.head - 2 + buffer.maxSize) % buffer.maxSize;
		const previousValue = buffer.size >= 2 ? buffer.values[previousIndex] : buffer.mean;
		
		const threshold = config.threshold || 10.0; // % change threshold
		
		// Epsilon to prevent division by zero
		const epsilon = 0.001;
		
		// Calculate percentage change relative to previous value (more accurate than mean)
		// Uses epsilon protection to handle near-zero values
		const percentChange = Math.abs(value - previousValue) / 
			Math.max(Math.abs(previousValue), epsilon) * 100;
		
		const isAnomaly = percentChange > threshold;
		
		// Exponential confidence for rate changes (emphasize large spikes)
		// Sudden spikes are more critical than gradual changes
		const confidence = exponentialConfidence(percentChange, threshold);
		
		// Expected range based on previous value ± threshold%
		const margin = Math.abs(previousValue) * (threshold / 100);
		const expectedRange: [number, number] = [
			previousValue - margin,
			previousValue + margin,
		];
		
		return {
			method: this.method,
			isAnomaly,
			confidence,
			deviation: percentChange,
			expectedRange,
			message: isAnomaly 
				? `Rate of change ${percentChange.toFixed(2)}%/s exceeds threshold ${threshold}%/s`
				: `Rate of change within threshold`,
		};
	}
}

/**
 * EWMA (Exponentially Weighted Moving Average) Detector
 * Detects deviations from smoothed trend
 */
export class EWMADetector implements AnomalyDetector {
	readonly method = 'ewma' as const;
	private ewmaValues = new Map<string, { value: number; lastUsed: number }>(); // metric -> {EWMA value, timestamp}
	private readonly MAX_CACHE_SIZE = 1000; // Prevent unbounded growth
	private readonly EVICTION_THRESHOLD = 0.9; // Evict when 90% full
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: { median?: number; mad?: number; sample_count: number }): DetectionResult {
		if (buffer.size < 5) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: 'Insufficient data for EWMA detection (need at least 5 samples)',
			};
		}
		
		// Smoothing factor (alpha): higher = more weight to recent values
		const alpha = 0.3;
		
		const metricKey = config.name;
		const now = Date.now();
		
		// Reset EWMA on baseline change (buffer.reset flag)
		if (buffer.reset) {
			this.ewmaValues.delete(metricKey);
		}
		
		let ewmaState = this.ewmaValues.get(metricKey);
		let ewma: number;
		
		// Initialize EWMA with buffer mean
		if (ewmaState === undefined) {
			ewma = buffer.mean;
		} else {
			ewma = ewmaState.value;
		}
		
		// Update EWMA: EWMA_t = alpha * value_t + (1 - alpha) * EWMA_(t-1)
		ewma = alpha * value + (1 - alpha) * ewma;
		
		// Store EWMA with timestamp for LRU eviction
		this.ewmaValues.set(metricKey, { value: ewma, lastUsed: now });
		
		// Evict old entries when cache is 90% full (LRU)
		if (this.ewmaValues.size >= this.MAX_CACHE_SIZE * this.EVICTION_THRESHOLD) {
			this.evictLRU();
		}
		
		// Calculate deviation from EWMA
		const deviation = Math.abs(value - ewma);
		const threshold = (config.threshold || 2.0) * buffer.stdDev;
		
		const isAnomaly = deviation > threshold;
		
		// Normalized confidence using sigmoid function
		const normalizedDeviation = buffer.stdDev > 0 ? deviation / buffer.stdDev : 0;
		const confidence = sigmoid(normalizedDeviation, config.threshold || 2.0);
		
		const expectedRange: [number, number] = [
			ewma - threshold,
			ewma + threshold,
		];
		
		return {
			method: this.method,
			isAnomaly,
			confidence,
			deviation: buffer.stdDev > 0 ? deviation / buffer.stdDev : 0,
			expectedRange,
			message: isAnomaly 
				? `Value ${value.toFixed(2)} deviates ${deviation.toFixed(2)} from EWMA ${ewma.toFixed(2)}`
				: `Value within EWMA band`,
		};
	}
	
	/**
	 * Evict least recently used EWMA values (LRU cache)
	 * Prevents unbounded memory growth
	 */
	private evictLRU(): void {
		const entries = Array.from(this.ewmaValues.entries());
		
		// Sort by lastUsed timestamp (oldest first)
		entries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
		
		// Remove oldest 10% of entries
		const removeCount = Math.floor(this.MAX_CACHE_SIZE * 0.1);
		for (let i = 0; i < removeCount && i < entries.length; i++) {
			this.ewmaValues.delete(entries[i][0]);
		}
	}
}

/**
 * Get all available detectors
 */
export function getAllDetectors(): AnomalyDetector[] {
	return [
		new ExpectedRangeDetector(),
		new ZScoreDetector(),
		new MADDetector(),
		new IQRDetector(),
		new RateChangeDetector(),
		new EWMADetector(),
	];
}

/**
 * Get detector by method name
 */
export function getDetector(method: string): AnomalyDetector | undefined {
	const detectors = getAllDetectors();
	return detectors.find(d => d.method === method);
}
