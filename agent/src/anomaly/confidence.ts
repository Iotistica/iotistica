/**
 * CONFIDENCE NORMALIZATION
 * ========================
 * 
 * Normalizes detector confidence scores to probability-like values in [0, 1].
 * 
 * Problem:
 * - Different detectors use different confidence semantics
 * - ExpectedRange: binary (0 or 1)
 * - ZScore: linear scaling (zScore / threshold * 2)
 * - MAD: relative deviation
 * 
 * Solution:
 * - Normalize all to [0, 1] using sigmoid function
 * - confidence = sigmoid(deviation / threshold)
 * 
 * Benefits:
 * - Comparable scores across detectors
 * - Smooth scaling (no hard cutoffs)
 * - Better fusion math (weighted averaging)
 */

/**
 * Sigmoid function for confidence normalization
 * 
 * Formula: 1 / (1 + e^(-k*x))
 * 
 * Where:
 * - x = normalized deviation (deviation / threshold)
 * - k = steepness parameter (default: 2.0)
 * 
 * Properties:
 * - x = 0 → confidence = 0.5 (at threshold)
 * - x > 0 → confidence > 0.5 (anomaly likely)
 * - x >> 0 → confidence → 1.0 (strong anomaly)
 * - x < 0 → confidence < 0.5 (normal)
 * - x << 0 → confidence → 0.0 (very normal)
 * 
 * @param deviation - Raw deviation value (e.g., z-score, MAD score)
 * @param threshold - Detection threshold
 * @param steepness - Controls how quickly confidence increases (default: 2.0)
 * @returns Normalized confidence in [0, 1]
 */
export function sigmoid(deviation: number, threshold: number, steepness: number = 2.0): number {
	if (threshold === 0) return 0.5; // Edge case: no threshold
	
	// Normalize deviation by threshold
	const x = deviation / threshold;
	
	// Apply sigmoid: 1 / (1 + e^(-k*x))
	const confidence = 1 / (1 + Math.exp(-steepness * x));
	
	return confidence;
}

/**
 * Alternative: Tanh-based normalization (centered at 0)
 * 
 * Formula: (tanh(k * x) + 1) / 2
 * 
 * Properties similar to sigmoid but centered at 0.
 * Slightly sharper transition around threshold.
 * 
 * @param deviation - Raw deviation value
 * @param threshold - Detection threshold
 * @param steepness - Controls transition sharpness (default: 2.0)
 * @returns Normalized confidence in [0, 1]
 */
export function tanhNormalize(deviation: number, threshold: number, steepness: number = 2.0): number {
	if (threshold === 0) return 0.5;
	
	const x = deviation / threshold;
	const confidence = (Math.tanh(steepness * x) + 1) / 2;
	
	return confidence;
}

/**
 * Binary confidence (hard threshold)
 * 
 * Returns 1.0 if deviation exceeds threshold, 0.0 otherwise.
 * Use for hard detectors (ExpectedRange) where there's no gray area.
 * 
 * @param deviation - Raw deviation value
 * @param threshold - Detection threshold
 * @returns 0.0 or 1.0
 */
export function binaryConfidence(deviation: number, threshold: number): number {
	return deviation > threshold ? 1.0 : 0.0;
}

/**
 * Linear confidence scaling
 * 
 * Scales confidence linearly from 0 to 1 based on deviation.
 * Caps at 1.0 for deviations exceeding maxDeviation.
 * 
 * @param deviation - Raw deviation value
 * @param threshold - Detection threshold (where confidence should be ~0.5)
 * @param maxDeviation - Maximum deviation for confidence = 1.0 (default: threshold * 3)
 * @returns Confidence in [0, 1]
 */
export function linearConfidence(deviation: number, threshold: number, maxDeviation?: number): number {
	const max = maxDeviation ?? threshold * 3;
	
	if (deviation <= 0) return 0.0;
	if (deviation >= max) return 1.0;
	
	return deviation / max;
}

/**
 * Exponential confidence (for extreme deviations)
 * 
 * Grows exponentially with deviation, giving more weight to large anomalies.
 * 
 * Formula: 1 - e^(-k * deviation / threshold)
 * 
 * @param deviation - Raw deviation value
 * @param threshold - Detection threshold
 * @param steepness - Growth rate (default: 1.0)
 * @returns Confidence in [0, 1]
 */
export function exponentialConfidence(deviation: number, threshold: number, steepness: number = 1.0): number {
	if (threshold === 0) return 0.0;
	
	const x = deviation / threshold;
	const confidence = 1 - Math.exp(-steepness * x);
	
	return Math.max(0, Math.min(1, confidence));
}

/**
 * Recommended confidence normalization strategy per detector type
 */
export const CONFIDENCE_STRATEGY = {
	// Hard detectors: binary (0 or 1, no gray area)
	expected_range: binaryConfidence,
	
	// Statistical detectors: sigmoid (smooth scaling)
	zscore: sigmoid,
	mad: sigmoid,
	iqr: sigmoid,
	
	// Rate-based: exponential (emphasize large spikes)
	rate_change: exponentialConfidence,
	
	// Trend-based: sigmoid (smooth)
	ewma: sigmoid,
} as const;

/**
 * Get recommended confidence for a detector
 * 
 * @param method - Detector method name
 * @param deviation - Raw deviation value
 * @param threshold - Detection threshold
 * @returns Normalized confidence in [0, 1]
 */
export function getConfidence(
	method: string,
	deviation: number,
	threshold: number
): number {
	const strategy = CONFIDENCE_STRATEGY[method as keyof typeof CONFIDENCE_STRATEGY];
	
	if (strategy) {
		return strategy(deviation, threshold);
	}
	
	// Default: sigmoid
	return sigmoid(deviation, threshold);
}
