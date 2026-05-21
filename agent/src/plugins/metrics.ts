/**
 * Protocol-agnostic metrics utilities
 * 
 * Provides standardized metrics collection and statistical analysis
 * for all protocol adapters (Modbus, SNMP, OPC-UA, MQTT, BACnet)
 */

import { type IDeviceStatus } from './types.js';

/**
 * Metrics configuration
 */
export interface MetricsConfig {
  maxHistorySize?: number;      // Max samples to keep (default: 1000)
  maxErrorHistory?: number;     // Max errors to keep (default: 100)
  enablePercentiles?: boolean;  // Calculate P95/P99 (default: true)
}

/**
 * Metrics summary with statistical analysis
 */
export interface MetricsSummary {
  // Poll latency statistics
  avgPollMs: number;
  minPollMs: number;
  maxPollMs: number;
  p50PollMs: number;  // Median
  p95PollMs: number;
  p99PollMs: number;
  
  // Success rate
  successRate: number;
  totalPolls: number;
  successfulPolls: number;
  failedPolls: number;
  
  // Data quality
  avgDataPointsUpdated: number;
  totalDataPointsUpdated: number;
  
  // Error analysis
  errorRate: number;
  topErrors: Array<{ type: string; count: number; lastSeen: Date }>;
  
  // Time range
  firstPoll?: Date;
  lastPoll?: Date;
}

/**
 * DeviceMetrics class - manages time-series metrics for a single device
 * 
 * Usage:
 *   const metrics = new DeviceMetrics(deviceName);
 *   metrics.recordPoll(duration, success, dataPointsUpdated);
 *   metrics.recordError(errorType, errorMessage);
 *   const summary = metrics.getSummary();
 */
export class DeviceMetrics {
	private pollDurations: number[] = [];
	private pollSuccessCount = 0;
	private pollTotalCount = 0;
	private dataPointsUpdated: number[] = [];
	private errors: Array<{ timestamp: Date; type: string; message: string }> = [];
  
	private readonly maxHistorySize: number;
	private readonly maxErrorHistory: number;
	private readonly enablePercentiles: boolean;

	constructor(
    public readonly deviceName: string,
    config: MetricsConfig = {}
	) {
		this.maxHistorySize = config.maxHistorySize || 1000;
		this.maxErrorHistory = config.maxErrorHistory || 100;
		this.enablePercentiles = config.enablePercentiles !== false;
	}

	/**
   * Record a poll cycle
   */
	recordPoll(durationMs: number, success: boolean, dataPointsChanged: number = 0): void {
		this.pollTotalCount++;
    
		if (success) {
			this.pollSuccessCount++;
		}
    
		// Add to history with size limit
		this.pollDurations.push(durationMs);
		if (this.pollDurations.length > this.maxHistorySize) {
			this.pollDurations.shift();
		}
    
		this.dataPointsUpdated.push(dataPointsChanged);
		if (this.dataPointsUpdated.length > this.maxHistorySize) {
			this.dataPointsUpdated.shift();
		}
	}

	/**
   * Record an error
   */
	recordError(type: string, message: string): void {
		this.errors.push({
			timestamp: new Date(),
			type,
			message
		});
    
		// Limit error history size
		if (this.errors.length > this.maxErrorHistory) {
			this.errors.shift();
		}
	}

	/**
   * Get current metrics summary with statistical analysis
   */
	getSummary(): MetricsSummary {
		const avgPoll = this.average(this.pollDurations);
		const minPoll = this.pollDurations.length > 0 ? Math.min(...this.pollDurations) : 0;
		const maxPoll = this.pollDurations.length > 0 ? Math.max(...this.pollDurations) : 0;
    
		return {
			// Latency stats
			avgPollMs: avgPoll,
			minPollMs: minPoll,
			maxPollMs: maxPoll,
			p50PollMs: this.enablePercentiles ? this.percentile(this.pollDurations, 50) : avgPoll,
			p95PollMs: this.enablePercentiles ? this.percentile(this.pollDurations, 95) : maxPoll,
			p99PollMs: this.enablePercentiles ? this.percentile(this.pollDurations, 99) : maxPoll,
      
			// Success metrics
			successRate: this.pollTotalCount > 0 ? this.pollSuccessCount / this.pollTotalCount : 1.0,
			totalPolls: this.pollTotalCount,
			successfulPolls: this.pollSuccessCount,
			failedPolls: this.pollTotalCount - this.pollSuccessCount,
      
			// Data quality
			avgDataPointsUpdated: this.average(this.dataPointsUpdated),
			totalDataPointsUpdated: this.dataPointsUpdated.reduce((sum, val) => sum + val, 0),
      
			// Error analysis
			errorRate: this.pollTotalCount > 0 
				? (this.pollTotalCount - this.pollSuccessCount) / this.pollTotalCount 
				: 0,
			topErrors: this.getTopErrors(),
      
			// Time range
			firstPoll: this.errors.length > 0 ? this.errors[0].timestamp : undefined,
			lastPoll: this.errors.length > 0 ? this.errors[this.errors.length - 1].timestamp : undefined
		};
	}

	/**
   * Export to DeviceStatus.metrics format
   */
	toDeviceStatusMetrics(): IDeviceStatus['metrics'] {
		return {
			pollDurations: [...this.pollDurations],
			pollSuccessCount: this.pollSuccessCount,
			pollTotalCount: this.pollTotalCount,
			dataPointsUpdated: [...this.dataPointsUpdated],
			lastErrors: [...this.errors]
		};
	}

	/**
   * Reset metrics (useful for testing or periodic resets)
   */
	reset(): void {
		this.pollDurations = [];
		this.pollSuccessCount = 0;
		this.pollTotalCount = 0;
		this.dataPointsUpdated = [];
		this.errors = [];
	}

	/**
   * Calculate average of array
   */
	private average(arr: number[]): number {
		if (arr.length === 0) return 0;
		return arr.reduce((sum, val) => sum + val, 0) / arr.length;
	}

	/**
   * Calculate percentile (P50 = median, P95, P99, etc.)
   */
	private percentile(arr: number[], p: number): number {
		if (arr.length === 0) return 0;
    
		const sorted = [...arr].sort((a, b) => a - b);
		const index = Math.ceil((p / 100) * sorted.length) - 1;
    
		return sorted[Math.max(0, index)];
	}

	/**
   * Get top error types by frequency
   */
	private getTopErrors(): Array<{ type: string; count: number; lastSeen: Date }> {
		const errorCounts = new Map<string, { count: number; lastSeen: Date }>();
    
		for (const error of this.errors) {
			const existing = errorCounts.get(error.type);
			if (existing) {
				existing.count++;
				existing.lastSeen = error.timestamp;
			} else {
				errorCounts.set(error.type, { count: 1, lastSeen: error.timestamp });
			}
		}
    
		return Array.from(errorCounts.entries())
			.map(([type, data]) => ({ type, ...data }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10); // Top 10 errors
	}
}


