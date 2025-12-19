/**
 * SEASONALITY HELPERS - TEMPORAL BASELINE BUCKETING
 * ===================================================
 * 
 * Reduces false positives for non-stationary metrics by maintaining
 * separate baselines for different time periods (hour-of-day, day/night, etc.)
 */

import type { SeasonalityPattern, TimeSlot } from './types';

/**
 * Get time slot for given timestamp and seasonality pattern
 * Returns -1 for no seasonality (overall baseline)
 */
export function getTimeSlot(timestamp: number, pattern: SeasonalityPattern): TimeSlot {
	if (pattern === 'none') {
		return -1; // Overall baseline
	}
	
	const date = new Date(timestamp);
	const hour = date.getHours(); // 0-23
	
	if (pattern === 'day-night') {
		// Day: 6am-10pm (hour 6-21), Night: 10pm-6am (hour 22-23, 0-5)
		const isDaytime = hour >= 6 && hour < 22;
		return isDaytime ? 1 : 0; // 0=night, 1=day
	}
	
	if (pattern === 'hourly') {
		// 24 baselines (0-23)
		return hour;
	}
	
	if (pattern === 'weekly') {
		// 168 baselines: dayOfWeek * 24 + hour
		const dayOfWeek = date.getDay(); // 0-6 (Sunday-Saturday)
		return dayOfWeek * 24 + hour; // 0-167
	}
	
	return -1;
}

/**
 * Get baseline key for database storage
 * Format: {metricName}:{timeSlot}
 */
export function getBaselineKey(metricName: string, timestamp: number, pattern: SeasonalityPattern): string {
	const timeSlot = getTimeSlot(timestamp, pattern);
	return `${metricName}:${timeSlot}`;
}

/**
 * Get number of time slots for a seasonality pattern
 */
export function getTimeSlotCount(pattern: SeasonalityPattern): number {
	switch (pattern) {
		case 'none':
			return 1;
		case 'day-night':
			return 2;
		case 'hourly':
			return 24;
		case 'weekly':
			return 168; // 7 days * 24 hours
		default:
			return 1;
	}
}

/**
 * Get human-readable time slot description
 */
export function getTimeSlotDescription(timeSlot: TimeSlot, pattern: SeasonalityPattern): string {
	if (pattern === 'none' || timeSlot === -1) {
		return 'overall';
	}
	
	if (pattern === 'day-night') {
		return timeSlot === 1 ? 'daytime (6am-10pm)' : 'nighttime (10pm-6am)';
	}
	
	if (pattern === 'hourly') {
		const hour = timeSlot.toString().padStart(2, '0');
		return `${hour}:00-${hour}:59`;
	}
	
	if (pattern === 'weekly') {
		const day = Math.floor(timeSlot / 24);
		const hour = timeSlot % 24;
		const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
		const hourStr = hour.toString().padStart(2, '0');
		return `${dayNames[day]} ${hourStr}:00-${hourStr}:59`;
	}
	
	return 'unknown';
}

/**
 * Estimate storage overhead for seasonality pattern
 * Returns approximate bytes per metric
 */
export function estimateStorageOverhead(pattern: SeasonalityPattern): number {
	// Each baseline stores: mean, std_dev, median, mad, sample_count (~40 bytes)
	const bytesPerBaseline = 40;
	const slotCount = getTimeSlotCount(pattern);
	return slotCount * bytesPerBaseline;
}

/**
 * Calculate minimum samples needed before using seasonal baseline
 * Falls back to overall baseline if seasonal baseline has insufficient data
 */
export function getMinimumSamplesForSeasonalBaseline(pattern: SeasonalityPattern): number {
	// More granular patterns need more samples to be statistically significant
	switch (pattern) {
		case 'none':
			return 10; // Standard minimum
		case 'day-night':
			return 5; // Can establish pattern quickly
		case 'hourly':
			return 10; // Need more samples per hour
		case 'weekly':
			return 15; // Need even more for weekly patterns
		default:
			return 10;
	}
}
