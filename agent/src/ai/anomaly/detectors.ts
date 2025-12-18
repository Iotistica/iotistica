/**
 * ANOMALY DETECTORS - STATISTICAL & ML METHODS
 * ==============================================
 * 
 * Implements multiple detection algorithms optimized for edge devices
 */

import type { AnomalyDetector, DetectionResult, MetricConfig, StatisticalBuffer } from './types';
import { getMAD, getIQR, getPercentile, getRateOfChange } from './buffer';

/**
 * Z-Score Detector
 * Detects outliers based on standard deviations from mean
 */
export class ZScoreDetector implements AnomalyDetector {
	readonly method = 'zscore' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: { mean: number; std_dev: number; sample_count: number }): DetectionResult {
		if (buffer.size < 10) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: 'Insufficient data for Z-score detection (need at least 10 samples)',
			};
		}
		
		// Prefer database baseline if available (more samples = more stable)
		const useDbBaseline = dbBaseline && dbBaseline.sample_count >= 100;
		const mean = useDbBaseline ? dbBaseline.mean : buffer.mean;
		const stdDev = useDbBaseline ? dbBaseline.std_dev : buffer.stdDev;
		const baselineSource = useDbBaseline ? 'database' as const : 'buffer' as const;
		
		// Handle zero stdDev (constant values)
		if (stdDev === 0) {
			const isAnomaly = value !== mean;
			return {
				method: this.method,
				isAnomaly,
				confidence: isAnomaly ? 1.0 : 0,
				deviation: isAnomaly ? Infinity : 0,
				expectedRange: [mean, mean],
				message: isAnomaly ? 'Value differs from constant baseline' : 'Value matches constant baseline',
			};
		}
		
		const threshold = config.threshold || 3.0;
		const zScore = Math.abs((value - mean) / stdDev);
		const isAnomaly = zScore > threshold;
		
		// Confidence increases with deviation
		const confidence = Math.min(1.0, zScore / (threshold * 2));
		
		const expectedRange: [number, number] = [
			mean - threshold * stdDev,
			mean + threshold * stdDev,
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
		if (buffer.size < 10 && (!dbBaseline || dbBaseline.sample_count < 10)) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: 'Insufficient data for MAD detection (need at least 10 samples)',
			};
		}
		
		// Prefer database baseline if available (more samples = more stable)
		const useDbBaseline = dbBaseline && dbBaseline.sample_count >= 100 &&
			dbBaseline.median !== null && dbBaseline.median !== undefined &&
			dbBaseline.mad !== null && dbBaseline.mad !== undefined;
		const mad = useDbBaseline ? dbBaseline.mad! : getMAD(buffer);
		const median = useDbBaseline ? dbBaseline.median! : buffer.values.slice(0, buffer.size).sort((a, b) => a - b)[Math.floor(buffer.size / 2)];
		const baselineSource = useDbBaseline ? 'database' as const : 'buffer' as const;
		
		// Handle zero MAD (constant values)
		if (mad === 0) {
			const isAnomaly = value !== median;
			return {
				method: this.method,
				isAnomaly,
				confidence: isAnomaly ? 1.0 : 0,
				deviation: isAnomaly ? Infinity : 0,
				expectedRange: [median, median],
				message: isAnomaly ? 'Value differs from constant median' : 'Value matches constant median',
			};
		}
		
		const threshold = config.threshold || 3.0;
		const madScore = Math.abs((value - median) / mad);
		const isAnomaly = madScore > threshold;
		
		// Confidence increases with deviation
		const confidence = Math.min(1.0, madScore / (threshold * 2));
		
		const expectedRange: [number, number] = [
			median - threshold * mad,
			median + threshold * mad,
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
		if (buffer.size < 10) {
			return {
				method: this.method,
				isAnomaly: false,
				confidence: 0,
				deviation: 0,
				expectedRange: [value, value],
				message: 'Insufficient data for IQR detection (need at least 10 samples)',
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
		
		// Confidence based on how far outside fences
		const confidence = iqr > 0 ? Math.min(1.0, distance / iqr) : 0;
		
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
		
		// Confidence is high for range violations (1.0 for values outside, 0 for inside)
		const confidence = isAnomaly ? 1.0 : 0;
		
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
		
		const rateOfChange = getRateOfChange(buffer);
		const threshold = config.threshold || 10.0; // % change per second
		
		// Calculate percentage change relative to current value
		const percentChange = buffer.mean !== 0 
			? Math.abs((rateOfChange / buffer.mean) * 100)
			: Math.abs(rateOfChange);
		
		const isAnomaly = percentChange > threshold;
		
		// Confidence based on how much threshold is exceeded
		const confidence = Math.min(1.0, percentChange / (threshold * 2));
		
		const expectedRange: [number, number] = [
			value - (buffer.mean * threshold / 100),
			value + (buffer.mean * threshold / 100),
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
	private ewmaValues = new Map<string, number>(); // metric -> EWMA value
	
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
		let ewma = this.ewmaValues.get(metricKey);
		
		// Initialize EWMA with buffer mean
		if (ewma === undefined) {
			ewma = buffer.mean;
		}
		
		// Update EWMA: EWMA_t = alpha * value_t + (1 - alpha) * EWMA_(t-1)
		ewma = alpha * value + (1 - alpha) * ewma;
		this.ewmaValues.set(metricKey, ewma);
		
		// Calculate deviation from EWMA
		const deviation = Math.abs(value - ewma);
		const threshold = (config.threshold || 2.0) * buffer.stdDev;
		
		const isAnomaly = deviation > threshold;
		
		// Confidence based on deviation magnitude
		const confidence = buffer.stdDev > 0 
			? Math.min(1.0, deviation / (threshold * 2))
			: 0;
		
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
