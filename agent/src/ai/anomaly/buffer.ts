/**
 * STATISTICAL BUFFER - CIRCULAR BUFFER WITH INCREMENTAL STATISTICS
 * ==================================================================
 * 
 * Efficient circular buffer for rolling statistics calculation.
 * Uses Welford's online algorithm for incremental mean/variance updates.
 * 
 * Memory efficient: O(n) where n = maxSize
 * Time efficient: O(1) per insert, O(n log n) for percentiles (lazy)
 */

import type { StatisticalBuffer } from './types';

/**
 * Create a new statistical buffer
 */
export function createBuffer(maxSize: number): StatisticalBuffer {
	return {
		values: new Array(maxSize).fill(0),
		timestamps: new Array(maxSize).fill(0),
		size: 0,
		maxSize,
		head: 0,
		sum: 0,
		sumSquares: 0,
		mean: 0,
		variance: 0,
		stdDev: 0,
		sortedDirty: true,
		reset: false, // Initialize reset flag
	};
}

/**
 * Reset buffer and mark for EWMA state clearing
 * Sets reset flag to trigger detector state cleanup
 */
export function resetBuffer(buffer: StatisticalBuffer): void {
	// Clear all values
	buffer.values.fill(0);
	buffer.timestamps.fill(0);
	buffer.size = 0;
	buffer.head = 0;
	
	// Reset statistics
	buffer.sum = 0;
	buffer.sumSquares = 0;
	buffer.mean = 0;
	buffer.variance = 0;
	buffer.stdDev = 0;
	
	// Mark for recalculation
	buffer.sortedDirty = true;
	buffer.sortedValues = undefined;
	
	// Set reset flag to trigger detector state cleanup (e.g., EWMA)
	buffer.reset = true;
}

/**
 * Add a value to the buffer (circular, overwrites oldest)
 * Uses Welford's online algorithm for incremental statistics
 */
export function addValue(buffer: StatisticalBuffer, value: number, timestamp: number): void {
	const index = buffer.head;
	const oldValue = buffer.values[index];
	const hadValue = buffer.size > index;

	// Store new value
	buffer.values[index] = value;
	buffer.timestamps[index] = timestamp;
	
	// Update size (up to maxSize)
	if (buffer.size < buffer.maxSize) {
		buffer.size++;
	}
	
	// Move head forward (circular)
	buffer.head = (buffer.head + 1) % buffer.maxSize;
	
	// Update incremental statistics
	if (hadValue) {
		// Replace old value with new value
		buffer.sum = buffer.sum - oldValue + value;
		buffer.sumSquares = buffer.sumSquares - (oldValue * oldValue) + (value * value);
	} else {
		// Add new value (buffer not full yet)
		buffer.sum += value;
		buffer.sumSquares += value * value;
	}
	
	// Recalculate mean and variance
	buffer.mean = buffer.sum / buffer.size;
	
	if (buffer.size > 1) {
		// Sample variance: sum((x - mean)^2) / (n - 1)
		// Using computational formula: (sumSquares - n*mean^2) / (n - 1)
		buffer.variance = (buffer.sumSquares - buffer.size * buffer.mean * buffer.mean) / (buffer.size - 1);
		buffer.stdDev = Math.sqrt(Math.max(0, buffer.variance)); // Ensure non-negative
	} else {
		buffer.variance = 0;
		buffer.stdDev = 0;
	}
	
	// Mark sorted values as dirty
	buffer.sortedDirty = true;
	
	// Clear reset flag after first value is added post-reset
	if (buffer.reset) {
		buffer.reset = false;
	}
}

/**
 * Get sorted values (lazy computation)
 */
export function getSortedValues(buffer: StatisticalBuffer): number[] {
	if (buffer.sortedDirty || !buffer.sortedValues) {
		// Only sort actual values (not unfilled portion)
		const actualValues = buffer.values.slice(0, buffer.size);
		buffer.sortedValues = actualValues.sort((a, b) => a - b);
		buffer.sortedDirty = false;
	}
	return buffer.sortedValues;
}

/**
 * Get median value
 */
export function getMedian(buffer: StatisticalBuffer): number {
	if (buffer.size === 0) return 0;
	
	const sorted = getSortedValues(buffer);
	const mid = Math.floor(sorted.length / 2);
	
	if (sorted.length % 2 === 0) {
		return (sorted[mid - 1] + sorted[mid]) / 2;
	} else {
		return sorted[mid];
	}
}

/**
 * Get percentile value (e.g., 0.25 for Q1, 0.75 for Q3)
 */
export function getPercentile(buffer: StatisticalBuffer, p: number): number {
	if (buffer.size === 0) return 0;
	
	const sorted = getSortedValues(buffer);
	const index = Math.floor((sorted.length - 1) * p);
	return sorted[index];
}

/**
 * Get MAD (Median Absolute Deviation)
 * MAD = median(|x - median(x)|)
 */
export function getMAD(buffer: StatisticalBuffer): number {
	if (buffer.size === 0) return 0;
	
	const median = getMedian(buffer);
	const deviations = buffer.values.slice(0, buffer.size).map(v => Math.abs(v - median));
	
	// Calculate median of deviations
	deviations.sort((a, b) => a - b);
	const mid = Math.floor(deviations.length / 2);
	
	if (deviations.length % 2 === 0) {
		return (deviations[mid - 1] + deviations[mid]) / 2;
	} else {
		return deviations[mid];
	}
}

/**
 * Get IQR (Interquartile Range)
 * IQR = Q3 - Q1
 */
export function getIQR(buffer: StatisticalBuffer): number {
	const q1 = getPercentile(buffer, 0.25);
	const q3 = getPercentile(buffer, 0.75);
	return q3 - q1;
}

/**
 * Get recent values (last n)
 */
export function getRecentValues(buffer: StatisticalBuffer, count: number): number[] {
	if (buffer.size === 0) return [];
	
	const result: number[] = [];
	const actualCount = Math.min(count, buffer.size);
	
	// Read backwards from head
	for (let i = 0; i < actualCount; i++) {
		const index = (buffer.head - 1 - i + buffer.maxSize) % buffer.maxSize;
		result.unshift(buffer.values[index]);
	}
	
	return result;
}

/**
 * Get trend direction based on linear regression
 */
export function getTrend(buffer: StatisticalBuffer): 'increasing' | 'decreasing' | 'stable' {
	if (buffer.size < 3) return 'stable';
	
	// Simple linear regression: y = mx + b
	// Slope m = (n*sum(xy) - sum(x)*sum(y)) / (n*sum(x^2) - sum(x)^2)
	
	let sumX = 0;
	let sumY = 0;
	let sumXY = 0;
	let sumX2 = 0;
	
	const recentValues = getRecentValues(buffer, Math.min(20, buffer.size));
	const n = recentValues.length;
	
	for (let i = 0; i < n; i++) {
		const x = i;
		const y = recentValues[i];
		sumX += x;
		sumY += y;
		sumXY += x * y;
		sumX2 += x * x;
	}
	
	const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
	
	// Threshold for "stable" (< 0.1% of mean per sample)
	const threshold = Math.abs(buffer.mean) * 0.001;
	
	if (Math.abs(slope) < threshold) return 'stable';
	return slope > 0 ? 'increasing' : 'decreasing';
}

/**
 * Calculate rate of change (derivative)
 */
export function getRateOfChange(buffer: StatisticalBuffer): number {
	if (buffer.size < 2) return 0;
	
	// Get last two values
	const recent = getRecentValues(buffer, 2);
	const index1 = (buffer.head - 2 + buffer.maxSize) % buffer.maxSize;
	const index2 = (buffer.head - 1 + buffer.maxSize) % buffer.maxSize;
	
	const value1 = recent[0];
	const value2 = recent[1];
	const time1 = buffer.timestamps[index1];
	const time2 = buffer.timestamps[index2];
	
	const timeDiff = (time2 - time1) / 1000; // Convert ms to seconds
	
	if (timeDiff === 0) return 0;
	return (value2 - value1) / timeDiff;
}

/**
 * Clear buffer
 */
export function clearBuffer(buffer: StatisticalBuffer): void {
	buffer.values.fill(0);
	buffer.timestamps.fill(0);
	buffer.size = 0;
	buffer.head = 0;
	buffer.sum = 0;
	buffer.sumSquares = 0;
	buffer.mean = 0;
	buffer.variance = 0;
	buffer.stdDev = 0;
	buffer.sortedDirty = true;
	buffer.sortedValues = undefined;
}

/**
 * Get buffer statistics summary
 */
export function getBufferStats(buffer: StatisticalBuffer) {
	return {
		size: buffer.size,
		maxSize: buffer.maxSize,
		mean: buffer.mean,
		stdDev: buffer.stdDev,
		variance: buffer.variance,
		median: getMedian(buffer),
		mad: getMAD(buffer),
		iqr: getIQR(buffer),
		min: Math.min(...buffer.values.slice(0, buffer.size)),
		max: Math.max(...buffer.values.slice(0, buffer.size)),
		trend: getTrend(buffer),
		rateOfChange: getRateOfChange(buffer),
	};
}

/**
 * Helper function for tests: add value with auto-generated timestamp
 * @deprecated Use addValue() with explicit timestamp in production code
 */
export function addToBuffer(buffer: StatisticalBuffer, value: number): void {
	addValue(buffer, value, Date.now());
}
