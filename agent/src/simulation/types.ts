/**
 * SIMULATION MODE - TYPE DEFINITIONS
 * ===================================
 * 
 * Unified simulation framework for testing agent capabilities
 * without physical hardware or real production scenarios.
 */

import type { AgentLogger } from '../logging/agent-logger';
import type { AnomalyDetectionService } from '../anomaly';

/**
 * Simulation pattern types
 */
export type SimulationPattern = 
	| 'realistic'     // Mimics real-world behavior
	| 'spike'         // Sudden spikes/jumps
	| 'drift'         // Gradual drift over time
	| 'cyclic'        // Repeating cycles
	| 'noisy'         // Random noise added
	| 'faulty'        // Intermittent failures
	| 'alert'         // High-impact deviation intended to trigger anomaly detection quickly
	| 'extreme'       // Edge case values
	| 'random';       // Completely random

export type SimulationProtocol = 'modbus' | 'opcua' | 'snmp' | 'can' | 'mqtt' | 'system';

/**
 * Simulation severity for anomalies
 */
export type SimulationSeverity = 'info' | 'warning' | 'critical';

/**
 * Memory leak simulation configuration
 */
export interface MemoryLeakSimulationConfig {
	enabled: boolean;
	type: 'gradual' | 'sudden' | 'cyclic';
	rateMB: number;           // MB to leak per interval
	intervalMs: number;       // Interval between leaks
	maxMB: number;           // Maximum MB to leak before stopping
}

/**
 * Anomaly injection simulation configuration
 */
export interface AnomalySimulationConfig {
	enabled: boolean;
	mode?: 'inject' | 'intercept';      // inject: synthetic points, intercept: mutate real endpoint data
	metrics: string[];                    // Which metrics to inject anomalies into
	pattern: SimulationPattern;           // How to generate anomalies
	intervalMs: number;                   // How often to inject
	severity: SimulationSeverity;         // Severity level
	magnitude: number;                    // Multiplier for deviation (1-10)
	valueSource?: 'static' | 'baseline';  // Use hardcoded bases or learned anomaly baselines
	strictBaseline?: boolean;             // If true, skip injection when baseline is unavailable
	baselineMinSamples?: number;          // Minimum samples required for baseline usage
	baselineDeviceId?: string;            // Optional device scope for baseline lookup
	baselineDeviceState?: 'running' | 'idle' | 'fault' | 'unknown'; // Optional state scope for lookup
}

/**
 * Sensor data simulation configuration
 */
export interface SensorDataSimulationConfig {
	enabled: boolean;
	devices: Array<{
		endpointTopic: string;             // Explicit MQTT/device-publish endpoint topic to route through
		metric: string;                   // e.g., 'temperature', 'humidity'
		protocol: SimulationProtocol;     // Explicit protocol payload shape to generate
		unit: string;                     // e.g., '°C', '%'
		baseValue: number;                // Normal baseline value
		variance: number;                 // Normal variance range
		min?: number;                     // Minimum possible value
		max?: number;                     // Maximum possible value
	}>;
	pattern: SimulationPattern;           // Data generation pattern
	publishIntervalMs: number;            // How often to publish
}

/**
 * Network degradation simulation configuration (future)
 */
export interface NetworkSimulationConfig {
	enabled: boolean;
	latencyMs: number;                    // Added latency
	packetLoss: number;                   // Packet loss rate (0-1)
	jitter: number;                       // Latency variance
}

/**
 * Container failure simulation configuration (future)
 */
export interface ContainerFailureSimulationConfig {
	enabled: boolean;
	failureRate: number;                  // Failures per hour
	recoveryTimeMs: number;               // Time to recover
	affectedServices: string[];           // Which services to affect
}

/**
 * Complete simulation configuration
 */
export interface SimulationConfig {
	enabled: boolean;                     // Master enable flag
	scenarios: {
		memory_leak?: MemoryLeakSimulationConfig;
		anomaly_injection?: AnomalySimulationConfig;
		sensor_data?: SensorDataSimulationConfig;
		network_degradation?: NetworkSimulationConfig;
		container_failure?: ContainerFailureSimulationConfig;
	};
	logLevel?: 'debug' | 'info' | 'warn'; // Simulation logging verbosity
	warningInterval?: number;             // How often to log simulation warning (ms)
}

/**
 * Simulation scenario interface
 */
export interface SimulationScenario {
	name: string;
	description: string;
	enabled: boolean;
	
	/**
	 * Start the simulation scenario
	 */
	start(): Promise<void>;
	
	/**
	 * Stop the simulation scenario
	 */
	stop(): Promise<void>;
	
	/**
	 * Get current scenario status
	 */
	getStatus(): SimulationScenarioStatus;
	
	/**
	 * Update scenario configuration at runtime
	 */
	updateConfig?(config: any): Promise<void>;
}

/**
 * Simulation scenario status
 */
export interface SimulationScenarioStatus {
	name: string;
	enabled: boolean;
	running: boolean;
	startedAt?: number;
	stats?: Record<string, any>;
	error?: string;
}

/**
 * Simulation orchestrator dependencies
 */
export interface SimulationDependencies {
	logger?: AgentLogger;
	anomalyService?: AnomalyDetectionService;
	publishToDeviceFeature?: (endpointTopic: string, message: Record<string, any>) => Promise<boolean> | boolean;
}

/**
 * Default simulation configuration
 */
export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
	enabled: false,
	scenarios: {},
	logLevel: 'info',
	warningInterval: 300000, // 5 minutes
};

/**
 * Default memory leak simulation
 */
export const DEFAULT_MEMORY_LEAK_CONFIG: MemoryLeakSimulationConfig = {
	enabled: false,
	type: 'gradual',
	rateMB: 1,
	intervalMs: 5000,
	maxMB: 50,
};

/**
 * Default anomaly simulation
 */
export const DEFAULT_ANOMALY_CONFIG: AnomalySimulationConfig = {
	enabled: false,
	mode: 'inject',
	metrics: ['cpu_usage', 'memory_percent', 'cpu_temp'],
	pattern: 'spike',
	intervalMs: 60000,
	severity: 'warning',
	magnitude: 3,
	valueSource: 'static',
	strictBaseline: false,
	baselineMinSamples: 10,
	baselineDeviceId: 'unknown-device',
	baselineDeviceState: 'unknown',
};

/**
 * Default sensor data simulation
 */
export const DEFAULT_SENSOR_DATA_CONFIG: SensorDataSimulationConfig = {
	enabled: false,
	devices: [
		{ endpointTopic: 'modbus', metric: 'temperature', protocol: 'modbus', unit: '°C', baseValue: 23.0, variance: 2.0, min: 15, max: 35 },
		{ endpointTopic: 'snmp', metric: 'humidity', protocol: 'snmp', unit: '%', baseValue: 55.0, variance: 10.0, min: 30, max: 80 },
		{ endpointTopic: 'opcua', metric: 'pressure', protocol: 'opcua', unit: 'hPa', baseValue: 1013.25, variance: 5.0, min: 980, max: 1050 },
	],
	pattern: 'realistic',
	publishIntervalMs: 10000,
};
