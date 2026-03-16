/**
 * SIMULATION MODE - TYPE DEFINITIONS
 * ===================================
 * 
 * Unified simulation framework for testing agent capabilities
 * without physical hardware or real production scenarios.
 */

import type { AgentLogger } from '../logging/agent-logger';
import type { AnomalyDetectionService } from '../anomaly';
import type { MqttManager } from '../mqtt/manager';

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
	| 'extreme'       // Edge case values
	| 'random';       // Completely random

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
	metrics: string[];                    // Which metrics to inject anomalies into
	pattern: SimulationPattern;           // How to generate anomalies
	intervalMs: number;                   // How often to inject
	severity: SimulationSeverity;         // Severity level
	magnitude: number;                    // Multiplier for deviation (1-10)
}

/**
 * Sensor data simulation configuration
 */
export interface SensorDataSimulationConfig {
	enabled: boolean;
	sensors: Array<{
		metric: string;                   // e.g., 'temperature', 'humidity'
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
	mqttManager?: MqttManager;
	deviceUuid?: string;
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
	metrics: ['cpu_usage', 'memory_percent', 'cpu_temp'],
	pattern: 'spike',
	intervalMs: 60000,
	severity: 'warning',
	magnitude: 3,
};

/**
 * Default sensor data simulation
 */
export const DEFAULT_SENSOR_DATA_CONFIG: SensorDataSimulationConfig = {
	enabled: false,
	sensors: [
		{ metric: 'temperature', unit: '°C', baseValue: 23.0, variance: 2.0, min: 15, max: 35 },
		{ metric: 'humidity', unit: '%', baseValue: 55.0, variance: 10.0, min: 30, max: 80 },
		{ metric: 'pressure', unit: 'hPa', baseValue: 1013.25, variance: 5.0, min: 980, max: 1050 },
	],
	pattern: 'realistic',
	publishIntervalMs: 10000,
};
