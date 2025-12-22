/**
 * ENDPOINT ANOMALY SYNC
 * ======================
 * 
 * Auto-discovers anomaly metrics from endpoints table and merges with cloud config.
 * 
 * Strategy:
 * 1. Read endpoints table and extract data_points
 * 2. Generate MetricConfig for each numeric data point
 * 3. Merge with cloud config (cloud config takes priority)
 * 
 * Metric naming: {endpoint_name}_{data_point_name}
 * Example: modbus_slave_1_temperature, modbus_slave_2_humidity
 */

import type { Knex } from 'knex';
import type { MetricConfig, DetectionMethod } from './types';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';

interface EndpointRow {
	id: number;
	uuid: string;
	name: string;
	protocol: string;
	enabled: number;
	data_points: string; // JSON string
}

interface DataPoint {
	name: string;
	address: number;
	type: string;
	dataType: string;
	base?: number;
	noise_pct?: number;
	unit?: string;
}

/**
 * Auto-discover anomaly metrics from endpoints table
 */
export async function discoverEndpointMetrics(
	db: Knex,
	logger?: AgentLogger
): Promise<MetricConfig[]> {
	try {
		// Read all enabled endpoints
		const endpoints = await db<EndpointRow>('endpoints')
			.where('enabled', 1)
			.select('id', 'uuid', 'name', 'protocol', 'data_points');
		
		if (endpoints.length === 0) {
			logger?.debugSync('No enabled endpoints found for anomaly discovery', {
				component: LogComponents.metrics,
			});
			return [];
		}
		
		const metrics: MetricConfig[] = [];
		
		for (const endpoint of endpoints) {
			// Parse data_points JSON
			let dataPoints: DataPoint[] = [];
			try {
				dataPoints = JSON.parse(endpoint.data_points);
			} catch (error) {
				logger?.warnSync(`Failed to parse data_points for endpoint ${endpoint.name}`, {
					component: LogComponents.metrics,
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			
			// Generate metrics for numeric data points
			for (const dp of dataPoints) {
				// Skip non-numeric types (boolean, string)
				if (dp.dataType === 'boolean' || dp.dataType === 'string') {
					continue;
				}
				
				// Generate metric name: {endpoint_name}_{data_point_name}
				const metricName = `${endpoint.name}_${dp.name}`;
				
				// Infer expectedRange from base value and noise
				let expectedRange: [number, number] | undefined;
				if (dp.base !== undefined && dp.noise_pct !== undefined) {
				// Use 4x noise margin for wider tolerance (e.g., 5% noise → ±20% range)
				// This accommodates normal variance without flooding alerts
				const marginMultiplier = 4;
				
				// Handle special case: base = 0 (e.g., unused registers)
				if (dp.base === 0) {
					// For constant zero values, set small range to allow zero
					expectedRange = [-1, 1];
				} else {
					const lowerBound = Math.floor(dp.base * (1 - dp.noise_pct * marginMultiplier));
					const upperBound = Math.ceil(dp.base * (1 + dp.noise_pct * marginMultiplier));
					expectedRange = [lowerBound, upperBound];
				}
			}
			
			// Choose detection methods based on data point type
			// Only use statistical methods - no expected_range (user must configure via cloud)
			const methods: DetectionMethod[] = ['zscore', 'mad'];
				metrics.push({
					name: metricName,
				enabled: true, // Auto-enabled for discovered metrics (can be disabled via cloud config)
					methods,
					threshold: 3.0,
					windowSize: 100,
					expectedRange: undefined, // User must specify via cloud config
					minConfidence: 0.7,
				});
			}
		}
		
		logger?.debugSync(`Discovered ${metrics.length} endpoint metrics for anomaly detection`, {
			component: LogComponents.metrics,
			endpointCount: endpoints.length,
			metricNames: metrics.map(m => m.name),
		});
		
		return metrics;
	} catch (error) {
		logger?.errorSync('Failed to discover endpoint metrics', error as Error, {
			component: LogComponents.metrics,
		});
		return [];
	}
}

/**
 * Merge cloud config with discovered endpoint metrics
 * 
 * Strategy:
 * - Cloud config takes priority (overrides discovered)
 * - If metric exists in cloud config, use cloud config
 * - Add discovered metrics not in cloud config
 * 
 * @param cloudMetrics - Metrics from cloud target state (priority)
 * @param discoveredMetrics - Auto-discovered from endpoints table
 * @returns Merged metric configuration
 */
export function mergeMetricConfigs(
	cloudMetrics: MetricConfig[],
	discoveredMetrics: MetricConfig[]
): MetricConfig[] {
	const merged = new Map<string, MetricConfig>();
	
	// First, add all cloud metrics (priority)
	for (const metric of cloudMetrics) {
		merged.set(metric.name, metric);
	}
	
	// Add discovered metrics if not already in cloud config
	for (const metric of discoveredMetrics) {
		if (!merged.has(metric.name)) {
			merged.set(metric.name, metric);
		}
	}
	
	return Array.from(merged.values());
}
