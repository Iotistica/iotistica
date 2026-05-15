/**
 * ANOMALY DETECTORS - STATISTICAL & ML METHODS
 * ==============================================
 * 
 * Implements multiple detection algorithms optimized for edge devices
 */

import type {
	AnomalyDetector,
	CompositeBaseline,
	DetectionResult,
	DetectorBaseline,
	MADBaseline,
	MetricConfig,
	StatisticalBuffer,
	ZScoreBaseline,
} from './types';
import { getMAD, getIQR, getMedian, getPercentile } from './buffer';
import { sigmoid, binaryConfidence, exponentialConfidence } from './confidence';

const MIN_STATISTICAL_BASELINE_SAMPLES = 50;
const MIN_RANGE_BASELINE_SAMPLES = 30;
const MIN_DB_BASELINE_SAMPLES = 100;
const MIN_RATE_CHANGE_SAMPLES = 2;
const MIN_EWMA_SAMPLES = 5;

const DEFAULT_STDDEV_EPSILON = 0.05;
const DEFAULT_MAD_EPSILON = 0.05;
const DEFAULT_ZSCORE_THRESHOLD = 3.0;
const DEFAULT_MAD_THRESHOLD = 3.0;
const DEFAULT_IQR_MULTIPLIER = 1.5;
const DEFAULT_RATE_CHANGE_THRESHOLD_PERCENT = 10.0;
const DEFAULT_EWMA_THRESHOLD = 2.0;
const DEFAULT_EWMA_ALPHA = 0.3;

const MAD_SCALE_FACTOR = 1.4826;
const SIGMOID_NORMALIZED_THRESHOLD = 1.0;
const PERCENT_SCALE = 100;
const RATE_CHANGE_EPSILON = 0.001;

const EWMA_CACHE_MAX_SIZE = 1000;
const EWMA_EVICTION_THRESHOLD = 0.9;
const EWMA_EVICTION_FRACTION = 0.1;

type CompositeWithMAD = CompositeBaseline & { median: number; mad: number };
type CompositeWithZScore = CompositeBaseline & { mean: number; stdDev: number };

function createNoDetectionResult(
	method: DetectionResult['method'],
	value: number,
	message: string,
	expectedRange: [number, number] = [value, value],
): DetectionResult {
	return {
		method,
		isAnomaly: false,
		confidence: 0,
		deviation: 0,
		expectedRange,
		message,
	};
}

function createExpectedRangeOverrideResult(
	method: DetectionResult['method'],
	value: number,
	config: MetricConfig,
	detectorLabel: string,
): DetectionResult | undefined {
	if (config.expectedRange?.length !== 2) {
		return undefined;
	}

	const [min, max] = config.expectedRange;
	if (value < min || value > max) {
		return undefined;
	}

	return {
		method,
		isAnomaly: false,
		confidence: 0,
		deviation: 0,
		expectedRange: [min, max],
		message: `[OVERRIDE] Value within expected range [${min.toFixed(2)}, ${max.toFixed(2)}] - skipping ${detectorLabel} checks`,
	};
}

abstract class BaseDetector implements AnomalyDetector {
	abstract readonly method: AnomalyDetector['method'];

	protected noDetection(
		value: number,
		message: string,
		expectedRange?: [number, number],
	): DetectionResult {
		return createNoDetectionResult(this.method, value, message, expectedRange ?? [value, value]);
	}

	protected invalidNumericInput(value: number): DetectionResult {
		return this.noDetection(value, 'Invalid numeric input');
	}

	protected expectedRangeOverride(
		value: number,
		config: MetricConfig,
		detectorLabel: string,
	): DetectionResult | undefined {
		return createExpectedRangeOverrideResult(this.method, value, config, detectorLabel);
	}

	abstract detect(
		value: number,
		buffer: StatisticalBuffer,
		config: MetricConfig,
		dbBaseline?: DetectorBaseline,
	): DetectionResult;
}

function hasMadBaseline(
	baseline?: DetectorBaseline | CompositeBaseline,
): baseline is MADBaseline | CompositeWithMAD {
	return !!baseline
		&& 'median' in baseline
		&& 'mad' in baseline
		&& typeof baseline.median === 'number'
		&& typeof baseline.mad === 'number';
}

function hasZScoreBaseline(
	baseline?: DetectorBaseline,
): baseline is ZScoreBaseline | CompositeWithZScore {
	return !!baseline
		&& 'mean' in baseline
		&& 'stdDev' in baseline
		&& typeof baseline.mean === 'number'
		&& typeof baseline.stdDev === 'number';
}

function toCompositeBaseline(
	baseline: DetectorBaseline | undefined,
	sampleCountFallback: number,
): CompositeBaseline {
	if (!baseline) {
		return { kind: 'composite', sampleCount: sampleCountFallback };
	}

	if (baseline.kind === 'composite') {
		return baseline;
	}

	if (baseline.kind === 'zscore') {
		return {
			kind: 'composite',
			sampleCount: baseline.sampleCount,
			mean: baseline.mean,
			stdDev: baseline.stdDev,
		};
	}

	return {
		kind: 'composite',
		sampleCount: baseline.sampleCount,
		median: baseline.median,
		mad: baseline.mad,
	};
}

/**
 * Z-Score Detector
 * Detects outliers based on standard deviations from mean
 */
export class ZScoreDetector extends BaseDetector {
	readonly method = 'zscore' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: DetectorBaseline): DetectionResult {
		if (!Number.isFinite(value)) {
			return this.invalidNumericInput(value);
		}

		// Z-score requires ~50 samples for Central Limit Theorem confidence
		// 50 samples = ~4 minutes @ 5sec intervals
		if (buffer.size < MIN_STATISTICAL_BASELINE_SAMPLES) {
			return this.noDetection(
				value,
				`Collecting baseline data (${buffer.size}/${MIN_STATISTICAL_BASELINE_SAMPLES} samples)`,
			);
		}
		
		// If expectedRange configured, use it as absolute bounds (hard detector)
		// This prevents false positives from statistical detectors on stable metrics (e.g., grid frequency)
		const expectedRangeOverride = this.expectedRangeOverride(value, config, 'Z-score');
		if (expectedRangeOverride) {
			return expectedRangeOverride;
		}
		
		// Prefer database baseline if available (more samples = more stable)
		const useDbBaseline = !!dbBaseline && dbBaseline.sampleCount >= MIN_DB_BASELINE_SAMPLES && hasZScoreBaseline(dbBaseline);
		const mean = useDbBaseline ? dbBaseline.mean : buffer.mean;
		const stdDev = useDbBaseline ? dbBaseline.stdDev : buffer.stdDev;
		const baselineSource = useDbBaseline ? 'database' as const : 'buffer' as const;
		
		// Use epsilon floor to prevent division blow-ups on flatlined signals
		// Avoids treating tiny deviations as critical anomalies when stdDev ≈ 0
		const STDDEV_EPSILON = config.stdDevEpsilon ?? DEFAULT_STDDEV_EPSILON;
		const effectiveStdDev = Math.max(stdDev, STDDEV_EPSILON);
		
		const threshold = config.threshold ?? DEFAULT_ZSCORE_THRESHOLD;
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
export class MADDetector extends BaseDetector {
	readonly method = 'mad' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, dbBaseline?: DetectorBaseline): DetectionResult {
		if (!Number.isFinite(value)) {
			return this.invalidNumericInput(value);
		}

		const baseline = toCompositeBaseline(dbBaseline, buffer.size);
		// MAD requires ~50 samples for robust median/MAD calculation
		// 50 samples = ~4 minutes @ 5sec intervals
		if (
			buffer.size < MIN_STATISTICAL_BASELINE_SAMPLES
			&& baseline.sampleCount < MIN_STATISTICAL_BASELINE_SAMPLES
		) {
			return this.noDetection(
				value,
				`Collecting baseline data (${buffer.size}/${MIN_STATISTICAL_BASELINE_SAMPLES} samples)`,
			);
		}
		
		// If expectedRange configured, use it as absolute bounds (hard detector)
		// This prevents false positives from statistical detectors on stable metrics (e.g., grid frequency)
		const expectedRangeOverride = this.expectedRangeOverride(value, config, 'MAD');
		if (expectedRangeOverride) {
			return expectedRangeOverride;
		}
		
		// Prefer database baseline if available (more samples = more stable)
		const useDbBaseline = baseline.sampleCount >= MIN_DB_BASELINE_SAMPLES && hasMadBaseline(baseline);
		const mad = useDbBaseline ? baseline.mad : getMAD(buffer);
		const median = useDbBaseline
			? baseline.median
			: getMedian(buffer);
		const baselineSource = useDbBaseline ? 'database' as const : 'buffer' as const;
		
		// Use epsilon floor to prevent division blow-ups on flatlined signals
		// Avoids treating tiny deviations as critical anomalies when MAD ≈ 0
		const MAD_EPSILON = config.madEpsilon ?? DEFAULT_MAD_EPSILON;
		const effectiveMAD = Math.max(mad, MAD_EPSILON);
		
		// Scale MAD to make it comparable to standard deviation (1.4826 ≈ 1/Φ⁻¹(3/4))
		// This makes threshold = 3 behave like 3σ (Z-score) but with robust statistics
		const MAD_SCALE = MAD_SCALE_FACTOR;
		const scaledMAD = effectiveMAD * MAD_SCALE;
		
		const threshold = config.threshold ?? DEFAULT_MAD_THRESHOLD;
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
export class IQRDetector extends BaseDetector {
	readonly method = 'iqr' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig): DetectionResult {
		if (!Number.isFinite(value)) {
			return this.invalidNumericInput(value);
		}

		// IQR requires ~50 samples for meaningful quartile calculation
		// 50 samples = ~4 minutes @ 5sec intervals
		if (buffer.size < MIN_STATISTICAL_BASELINE_SAMPLES) {
			return this.noDetection(
				value,
				`Collecting baseline data (${buffer.size}/${MIN_STATISTICAL_BASELINE_SAMPLES} samples)`,
			);
		}
		
		const q1 = getPercentile(buffer, 0.25);
		const q3 = getPercentile(buffer, 0.75);
		const iqr = getIQR(buffer);
		
		// Tukey's fences: [Q1 - 1.5*IQR, Q3 + 1.5*IQR]
		const multiplier = config.threshold ?? DEFAULT_IQR_MULTIPLIER;
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
		const confidence = sigmoid(deviation, SIGMOID_NORMALIZED_THRESHOLD); // threshold=1.0 since already normalized
		
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
export class ExpectedRangeDetector extends BaseDetector {
	readonly method = 'expected_range' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, _dbBaseline?: DetectorBaseline): DetectionResult {
		if (!Number.isFinite(value)) {
			return this.invalidNumericInput(value);
		}

		// Must have expectedRange configured
		if (config.expectedRange?.length !== 2) {
			return this.noDetection(
				value,
				'No expected range configured',
			);
		}
		
		// Require minimum baseline samples before alerting to avoid false positives during initial collection
		// 30 samples = ~2.5 minutes @ 5sec intervals (sufficient for basic range validation)
		if (buffer.size < MIN_RANGE_BASELINE_SAMPLES) {
			return this.noDetection(
				value,
				`Collecting baseline data (${buffer.size}/${MIN_RANGE_BASELINE_SAMPLES} samples)`,
				config.expectedRange,
			);
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
export class RateChangeDetector extends BaseDetector {
	readonly method = 'rate_change' as const;
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, _dbBaseline?: DetectorBaseline): DetectionResult {
		if (!Number.isFinite(value)) {
			return this.invalidNumericInput(value);
		}

		if (buffer.size < MIN_RATE_CHANGE_SAMPLES) {
			return this.noDetection(
				value,
				`Insufficient data for rate change detection (need at least ${MIN_RATE_CHANGE_SAMPLES} samples)`,
			);
		}
		
		// Get previous value from buffer (most recent sample before current)
		const previousIndex = (buffer.head - 2 + buffer.maxSize) % buffer.maxSize;
		const previousValue = buffer.size >= 2 ? buffer.values[previousIndex] : buffer.mean;
		
		const threshold = config.threshold ?? DEFAULT_RATE_CHANGE_THRESHOLD_PERCENT; // % change threshold
		
		// Epsilon to prevent division by zero
		const epsilon = RATE_CHANGE_EPSILON;
		
		// Calculate percentage change relative to previous value (more accurate than mean)
		// Uses epsilon protection to handle near-zero values
		const percentChange = Math.abs(value - previousValue) / 
			Math.max(Math.abs(previousValue), epsilon) * PERCENT_SCALE;
		
		const isAnomaly = percentChange > threshold;
		
		// Exponential confidence for rate changes (emphasize large spikes)
		// Sudden spikes are more critical than gradual changes
		const confidence = exponentialConfidence(percentChange, threshold);
		
		// Expected range based on previous value ± threshold%
		const margin = Math.abs(previousValue) * (threshold / PERCENT_SCALE);
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
export class EWMADetector extends BaseDetector {
	readonly method = 'ewma' as const;
	private ewmaValues = new Map<string, { value: number; lastUsed: number }>(); // metric -> {EWMA value, timestamp}
	private readonly MAX_CACHE_SIZE = EWMA_CACHE_MAX_SIZE; // Prevent unbounded growth
	private readonly EVICTION_THRESHOLD = EWMA_EVICTION_THRESHOLD; // Evict when 90% full

	/**
	 * Clear all cached EWMA state.
	 * Useful for deterministic tests and explicit lifecycle cleanup.
	 */
	clear(): void {
		this.ewmaValues.clear();
	}
	
	detect(value: number, buffer: StatisticalBuffer, config: MetricConfig, _dbBaseline?: DetectorBaseline): DetectionResult {
		if (!Number.isFinite(value)) {
			return this.invalidNumericInput(value);
		}

		if (buffer.size < MIN_EWMA_SAMPLES) {
			return this.noDetection(
				value,
				`Insufficient data for EWMA detection (need at least ${MIN_EWMA_SAMPLES} samples)`,
			);
		}
		
		// Smoothing factor (alpha): higher = more weight to recent values
		const alpha = DEFAULT_EWMA_ALPHA;
		
		const metricKey = config.name;
		const now = Date.now();
		
		// Reset EWMA on baseline change (buffer.reset flag)
		if (buffer.reset) {
			this.ewmaValues.delete(metricKey);
		}
		
		const ewmaState = this.ewmaValues.get(metricKey);
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
		const thresholdBase = config.threshold ?? DEFAULT_EWMA_THRESHOLD;
		const threshold = thresholdBase * buffer.stdDev;
		
		const isAnomaly = deviation > threshold;
		
		// Normalized confidence using sigmoid function
		const normalizedDeviation = buffer.stdDev > 0 ? deviation / buffer.stdDev : 0;
		const confidence = sigmoid(normalizedDeviation, thresholdBase);
		
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
		const removeCount = Math.floor(this.MAX_CACHE_SIZE * EWMA_EVICTION_FRACTION);
		for (let i = 0; i < removeCount && i < entries.length; i++) {
			this.ewmaValues.delete(entries[i][0]);
		}
	}
}

const DETECTORS: readonly AnomalyDetector[] = [
	new ExpectedRangeDetector(),
	new ZScoreDetector(),
	new MADDetector(),
	new IQRDetector(),
	new RateChangeDetector(),
	new EWMADetector(),
];

/**
 * Get all available detectors
 */
export function getAllDetectors(): readonly AnomalyDetector[] {
	return DETECTORS;
}

/**
 * Get detector by method name
 */
export function getDetector(method: AnomalyDetector['method']): AnomalyDetector | undefined {
	const detectors = getAllDetectors();
	return detectors.find(d => d.method === method);
}

/**
 * Clear detector internal state (for testing/lifecycle cleanup).
 * Stateless detectors are unaffected.
 */
export function clearDetectorsState(method?: AnomalyDetector['method']): void {
	const detectors = method ? [getDetector(method)].filter(Boolean) : getAllDetectors();
	for (const detector of detectors) {
		if (detector && 'clear' in detector && typeof detector.clear === 'function') {
			detector.clear();
		}
	}
}
