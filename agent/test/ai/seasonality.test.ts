/**
 * SEASONALITY TESTS - TEMPORAL BASELINE BUCKETING
 * =================================================
 * 
 * Tests for seasonality-aware baseline selection to reduce false positives
 */

import { getTimeSlot, getBaselineKey, getTimeSlotCount, getTimeSlotDescription, estimateStorageOverhead, getMinimumSamplesForSeasonalBaseline } from '../../src/ai/anomaly/seasonality';
import type { SeasonalityPattern } from '../../src/ai/anomaly/types';

describe('Seasonality Helpers', () => {
	
	describe('getTimeSlot', () => {
		
		it('should return -1 for none seasonality', () => {
			const timestamp = new Date('2025-12-18T14:30:00Z').getTime();
			const timeSlot = getTimeSlot(timestamp, 'none');
			expect(timeSlot).toBe(-1);
		});
		
		it('should return day/night slots correctly', () => {
			// Daytime: 6am-10pm (hour 6-21) → slot 1
			const daytimeHours = [6, 7, 8, 12, 15, 18, 21];
			daytimeHours.forEach(hour => {
				const timestamp = new Date(`2025-12-18T${hour.toString().padStart(2, '0')}:30:00Z`).getTime();
				const timeSlot = getTimeSlot(timestamp, 'day-night');
				expect(timeSlot).toBe(1);
			});
			
			// Nighttime: 10pm-6am (hour 22-23, 0-5) → slot 0
			const nighttimeHours = [22, 23, 0, 1, 2, 3, 4, 5];
			nighttimeHours.forEach(hour => {
				const timestamp = new Date(`2025-12-18T${hour.toString().padStart(2, '0')}:30:00Z`).getTime();
				const timeSlot = getTimeSlot(timestamp, 'day-night');
				expect(timeSlot).toBe(0);
			});
		});
		
		it('should return hourly slots correctly', () => {
			for (let hour = 0; hour < 24; hour++) {
				const timestamp = new Date(`2025-12-18T${hour.toString().padStart(2, '0')}:30:00Z`).getTime();
				const timeSlot = getTimeSlot(timestamp, 'hourly');
				expect(timeSlot).toBe(hour);
			}
		});
		
		it('should return weekly slots correctly', () => {
			// Sunday Dec 14, 2025 at 14:00 (hour 14, day 0)
			const sunday = new Date('2025-12-14T14:00:00Z').getTime();
			expect(getTimeSlot(sunday, 'weekly')).toBe(0 * 24 + 14); // 14
			
			// Monday Dec 15, 2025 at 10:00 (hour 10, day 1)
			const monday = new Date('2025-12-15T10:00:00Z').getTime();
			expect(getTimeSlot(monday, 'weekly')).toBe(1 * 24 + 10); // 34
			
			// Saturday Dec 20, 2025 at 23:00 (hour 23, day 6)
			const saturday = new Date('2025-12-20T23:00:00Z').getTime();
			expect(getTimeSlot(saturday, 'weekly')).toBe(6 * 24 + 23); // 167
		});
		
	});
	
	describe('getBaselineKey', () => {
		
		it('should generate correct key for overall baseline', () => {
			const timestamp = Date.now();
			const key = getBaselineKey('cpu.usage', timestamp, 'none');
			expect(key).toBe('cpu.usage:-1');
		});
		
		it('should generate correct key for day/night', () => {
			const daytime = new Date('2025-12-18T14:00:00Z').getTime();
			const nighttime = new Date('2025-12-18T02:00:00Z').getTime();
			
			expect(getBaselineKey('cpu.usage', daytime, 'day-night')).toBe('cpu.usage:1');
			expect(getBaselineKey('cpu.usage', nighttime, 'day-night')).toBe('cpu.usage:0');
		});
		
		it('should generate correct key for hourly', () => {
			const timestamp = new Date('2025-12-18T14:30:00Z').getTime();
			const key = getBaselineKey('cpu.usage', timestamp, 'hourly');
			expect(key).toBe('cpu.usage:14');
		});
		
		it('should generate correct key for weekly', () => {
			// Monday 10am
			const timestamp = new Date('2025-12-15T10:00:00Z').getTime();
			const key = getBaselineKey('cpu.usage', timestamp, 'weekly');
			expect(key).toBe('cpu.usage:34'); // 1*24+10
		});
		
	});
	
	describe('getTimeSlotCount', () => {
		
		it('should return correct slot counts', () => {
			expect(getTimeSlotCount('none')).toBe(1);
			expect(getTimeSlotCount('day-night')).toBe(2);
			expect(getTimeSlotCount('hourly')).toBe(24);
			expect(getTimeSlotCount('weekly')).toBe(168);
		});
		
	});
	
	describe('getTimeSlotDescription', () => {
		
		it('should describe none pattern', () => {
			expect(getTimeSlotDescription(-1, 'none')).toBe('overall');
		});
		
		it('should describe day/night pattern', () => {
			expect(getTimeSlotDescription(1, 'day-night')).toBe('daytime (6am-10pm)');
			expect(getTimeSlotDescription(0, 'day-night')).toBe('nighttime (10pm-6am)');
		});
		
		it('should describe hourly pattern', () => {
			expect(getTimeSlotDescription(0, 'hourly')).toBe('00:00-00:59');
			expect(getTimeSlotDescription(14, 'hourly')).toBe('14:00-14:59');
			expect(getTimeSlotDescription(23, 'hourly')).toBe('23:00-23:59');
		});
		
		it('should describe weekly pattern', () => {
			expect(getTimeSlotDescription(0, 'weekly')).toBe('Sunday 00:00-00:59');
			expect(getTimeSlotDescription(34, 'weekly')).toBe('Monday 10:00-10:59');
			expect(getTimeSlotDescription(167, 'weekly')).toBe('Saturday 23:00-23:59');
		});
		
	});
	
	describe('estimateStorageOverhead', () => {
		
		it('should estimate storage correctly', () => {
			expect(estimateStorageOverhead('none')).toBe(40); // 1 * 40
			expect(estimateStorageOverhead('day-night')).toBe(80); // 2 * 40
			expect(estimateStorageOverhead('hourly')).toBe(960); // 24 * 40
			expect(estimateStorageOverhead('weekly')).toBe(6720); // 168 * 40
		});
		
		it('should show storage is reasonable for 1000 metrics', () => {
			const metricCount = 1000;
			
			// None: 40 KB total
			expect(estimateStorageOverhead('none') * metricCount).toBeLessThan(50 * 1024);
			
			// Day/night: 80 KB total (very reasonable)
			expect(estimateStorageOverhead('day-night') * metricCount).toBeLessThan(100 * 1024);
			
			// Hourly: 960 KB = ~1 MB (acceptable)
			expect(estimateStorageOverhead('hourly') * metricCount).toBeLessThan(1024 * 1024);
			
			// Weekly: 6.7 MB (manageable for critical metrics)
			expect(estimateStorageOverhead('weekly') * metricCount).toBeLessThan(10 * 1024 * 1024);
		});
		
	});
	
	describe('getMinimumSamplesForSeasonalBaseline', () => {
		
		it('should require more samples for granular patterns', () => {
			const noneMin = getMinimumSamplesForSeasonalBaseline('none');
			const dayNightMin = getMinimumSamplesForSeasonalBaseline('day-night');
			const hourlyMin = getMinimumSamplesForSeasonalBaseline('hourly');
			const weeklyMin = getMinimumSamplesForSeasonalBaseline('weekly');
			
			// More granular patterns need more samples
			expect(dayNightMin).toBeLessThan(hourlyMin);
			expect(hourlyMin).toBeLessThan(weeklyMin);
			
			// All should be reasonable (5-15 samples)
			expect(dayNightMin).toBeGreaterThanOrEqual(5);
			expect(weeklyMin).toBeLessThanOrEqual(20);
		});
		
	});
	
	describe('Real-World Scenarios', () => {
		
		it('should handle CPU usage pattern (high during day, low at night)', () => {
			// Scenario: Office computer
			// Day (9am-6pm): 60-80% CPU
			// Night (6pm-9am): 10-20% CPU
			
			const pattern: SeasonalityPattern = 'day-night';
			
			// 9am (daytime)
			const morning = new Date('2025-12-18T09:00:00Z').getTime();
			const morningKey = getBaselineKey('cpu.usage', morning, pattern);
			expect(morningKey).toBe('cpu.usage:1'); // Daytime slot
			
			// 2am (nighttime)
			const lateNight = new Date('2025-12-18T02:00:00Z').getTime();
			const nightKey = getBaselineKey('cpu.usage', lateNight, pattern);
			expect(nightKey).toBe('cpu.usage:0'); // Nighttime slot
			
			// Different baselines prevent false positives:
			// - 25% CPU at 2am → Normal (nighttime baseline = 15%)
			// - 25% CPU at 9am → Anomaly! (daytime baseline = 70%)
		});
		
		it('should handle network traffic pattern (weekday vs weekend)', () => {
			// Scenario: Office network
			// Weekday 9am: High traffic
			// Weekend 9am: Low traffic
			
			const pattern: SeasonalityPattern = 'weekly';
			
			// Monday 9am
			const monday9am = new Date('2025-12-15T09:00:00Z').getTime();
			const mondaySlot = getTimeSlot(monday9am, pattern);
			expect(mondaySlot).toBe(1 * 24 + 9); // 33
			
			// Sunday 9am
			const sunday9am = new Date('2025-12-14T09:00:00Z').getTime();
			const sundaySlot = getTimeSlot(sunday9am, pattern);
			expect(sundaySlot).toBe(0 * 24 + 9); // 9
			
			// Different slots → different baselines
			expect(mondaySlot).not.toBe(sundaySlot);
		});
		
		it('should handle temperature pattern (hourly variations)', () => {
			// Scenario: Data center temperature
			// Varies by hour due to external temp, AC cycles
			
			const pattern: SeasonalityPattern = 'hourly';
			
			// 2pm (peak heat)
			const afternoon = new Date('2025-12-18T14:00:00Z').getTime();
			expect(getTimeSlot(afternoon, pattern)).toBe(14);
			
			// 4am (coolest)
			const earlyMorning = new Date('2025-12-18T04:00:00Z').getTime();
			expect(getTimeSlot(earlyMorning, pattern)).toBe(4);
			
			// Each hour gets its own baseline
			for (let hour = 0; hour < 24; hour++) {
				const timestamp = new Date(`2025-12-18T${hour.toString().padStart(2, '0')}:00:00Z`).getTime();
				const slot = getTimeSlot(timestamp, pattern);
				expect(slot).toBe(hour);
			}
		});
		
		it('should demonstrate false positive reduction', () => {
			// Scenario: 30% CPU usage at different times
			const cpuValue = 30;
			
			// Without seasonality (single baseline at 50%)
			// → 30% flagged as low (false negative for daytime)
			const overallBaseline = 50;
			const deviationOverall = Math.abs(cpuValue - overallBaseline);
			// deviation = 20 (significant, but normal at night)
			
			// With day/night seasonality
			// Daytime baseline: 70%
			// Nighttime baseline: 15%
			const daytimeBaseline = 70;
			const nighttimeBaseline = 15;
			
			const deviationDaytime = Math.abs(cpuValue - daytimeBaseline);
			const deviationNighttime = Math.abs(cpuValue - nighttimeBaseline);
			
			// 30% CPU at 2pm → deviation = 40 (ANOMALY, correct!)
			expect(deviationDaytime).toBeGreaterThan(deviationOverall);
			
			// 30% CPU at 2am → deviation = 15 (normal, correct!)
			expect(deviationNighttime).toBeLessThan(deviationOverall);
			
			// False positive reduction: Nighttime correctly identified as normal
		});
		
	});
	
});
