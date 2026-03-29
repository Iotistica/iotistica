/**
 * ANOMALY DETECTION - TYPE DEFINITIONS
 * ======================================
 * 
 * Edge-appropriate anomaly detection for IoT sensor data and system metrics
 */

import type { AgentLogger } from '../logging/agent-logger';

/**
 * Protocol types for data sources
 */
export type Protocol = 'modbus' | 'opcua' | 'bacnet' | 'mqtt' | 'system';

/**
 * Canonical device operational states used across all protocols
 */
export type CanonicalDeviceState = 'running' | 'idle' | 'fault' | 'unknown';

/**
 * Metadata attached to data points injected by the simulation subsystem.
 * Presence of this field signals to detection that the anomaly is intentional.
 */
export interface SimulationMeta {
	simulatedAnomaly: boolean;
	scenarioId?: string;   // e.g. 'anomaly_injection'
	injectedAt?: number;   // Unix timestamp (ms)
	pattern?: string;      // Simulation pattern used (spike, drift, alert, etc.)
}

/**
 * Unified data point for all monitored values
 */
export interface DataPoint {
	source: 'device' | 'system' | 'container' | 'endpoint';
	protocol?: Protocol;      // Protocol/source type (modbus, opcua, system, etc.)
	deviceState?: CanonicalDeviceState; // Normalized operational state
	rawDeviceState?: unknown; // Protocol-specific raw state value (optional)
	metric: string;           // e.g., 'temperature', 'cpu_usage', 'memory_percent'
	value: number;
	unit: string;
	timestamp: number;        // Unix timestamp (ms)
	deviceId?: string;        // For multi-sensor scenarios
	quality?: 'GOOD' | 'BAD' | 'UNCERTAIN';
	tags?: Record<string, string>;  // Additional metadata
	simulationMeta?: SimulationMeta; // Present when data was injected by simulation
}

/**
 * Detection methods available
 */
export type DetectionMethod = 
	| 'expected_range' // Simple min/max range check
	| 'zscore'        // Z-score (standard deviations from mean)
	| 'mad'           // Median Absolute Deviation
	| 'iqr'           // Interquartile Range
	| 'rate_change'   // Rate of change (velocity/acceleration)
	| 'ewma'          // Exponentially Weighted Moving Average
	| 'correlation'   // Correlation between metrics
	| 'fusion'        // Ensemble detector combining multiple methods
	| 'simulation';   // Ground-truth fast-path for simulated anomalies

/**
 * Anomaly severity levels
 */
export type AnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * Simulation pattern types for anomaly injection scenarios
 */
export type SimulationPattern =
	| 'realistic'     // Mimics real-world behavior
	| 'spike'         // Sudden spikes/jumps
	| 'drift'         // Gradual drift over time
	| 'recovery'      // Return toward baseline after alert/fault
	| 'cyclic'        // Repeating cycles
	| 'noisy'         // Random noise added
	| 'faulty'        // Intermittent failures
	| 'alert'         // High-impact deviation intended to trigger anomaly detection quickly
	| 'extreme'       // Edge case values
	| 'random';       // Completely random

/**
 * Simulation severity for anomaly injection
 */
export type SimulationSeverity = AnomalySeverity;

/**
 * Anomaly injection simulation configuration
 */
export interface AnomalySimulationConfig {
	enabled: boolean;
	mode?: 'inject' | 'intercept';      // inject: synthetic points, intercept: mutate real endpoint data
	metrics: string[];                  // Which metrics to inject anomalies into
	pattern: SimulationPattern;         // How to generate anomalies
	intervalMs: number;                 // How often to inject
	burstCount?: number;                // Number of points injected per cycle
	alertDirection?: 'high' | 'low' | 'auto'; // Direction used by alert pattern
	severity: SimulationSeverity;       // Severity level
	magnitude: number;                  // Multiplier for deviation (1-10)
}

/**
 * Complete simulation configuration
 */
export interface SimulationConfig {
	enabled: boolean;                   // Master enable flag
	scenarios: {
		anomaly_injection?: AnomalySimulationConfig;
	};
	logLevel?: 'debug' | 'info' | 'warn'; // Simulation logging verbosity
	warningInterval?: number;             // How often to log simulation warning (ms)
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
 * Simulation scenario interface
 */
export interface SimulationScenario {
	name: string;
	description: string;
	enabled: boolean;
	start(): Promise<void>;
	stop(): Promise<void>;
	getStatus(): SimulationScenarioStatus;
	updateConfig?(config: any): Promise<void>;
}

/**
 * Anomaly service contract used by simulation components
 */
export interface AnomalySimulationService {
	processDataPoint(dataPoint: DataPoint): void;
	getStorage?(): any;
	getPreferredBufferContext?(metric: string): { deviceId: string; deviceState: CanonicalDeviceState } | undefined;
}

/**
 * Simulation orchestrator dependencies
 */
export interface SimulationDependencies {
	logger?: AgentLogger;
	anomalyService?: AnomalySimulationService;
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
 * Default anomaly simulation
 */
export const DEFAULT_ANOMALY_CONFIG: AnomalySimulationConfig = {
	enabled: false,
	mode: 'inject',
	metrics: ['cpu_usage', 'memory_percent', 'cpu_temp'],
	pattern: 'spike',
	intervalMs: 60000,
	burstCount: 1,
	alertDirection: 'high',
	severity: 'warning',
	magnitude: 30,
};

/**
 * Trend direction
 */
export type Trend = 'increasing' | 'decreasing' | 'stable';

/**
 * Seasonality patterns for baseline bucketing
 * - none: Single baseline (default)
 * - day-night: 2 baselines (daytime 6am-10pm, nighttime 10pm-6am)
 * - hourly: 24 baselines (one per hour)
 * - weekly: 168 baselines (24 hours × 7 days)
 */
export type SeasonalityPattern = 'none' | 'day-night' | 'hourly' | 'weekly';

/**
 * Time slot identifier for seasonal baselines
 * - -1: Overall baseline (no seasonality)
 * - 0-1: Day/night (0=night, 1=day)
 * - 0-23: Hourly
 * - 0-167: Weekly (day*24 + hour)
 */
export type TimeSlot = number;

/**
 * Baseline information for explainability
 */
export interface BaselineInfo {
	median: number;                  // Baseline median value
	mean: number;                    // Baseline mean value
	stdDev: number;                  // Baseline standard deviation
	sampleCount: number;             // Number of samples in baseline
	method: DetectionMethod;         // Which detector's baseline was used
	source: 'buffer' | 'database';   // Where baseline came from
}

/**
 * Canonical anomaly event (single event per metric, published to MQTT)
 * CRITICAL: Tracks MONITORED DEVICES (e.g., 'COMAP-Main-Controller', 'Temp-Sensor-01'),
 * not agent/gateway info. The agent UUID is kept for infrastructure tracking.
 */
export interface AnomalyEvent {
	agentUuid: string;               // Edge gateway/agent UUID (infrastructure tracking)
	deviceName: string;              // Monitored device name (e.g., 'COMAP-Main-Controller', 'Agent System')
	deviceType: Protocol;            // Protocol/source type (modbus, opcua, system, etc.)
	deviceState: CanonicalDeviceState; // Canonical operational state during detection
	metric: string;
	timestampMs: number;             // When the anomalous measurement occurred (explicit units)
	windowStartMs: number;           // Start of statistical window used for detection
	windowEndMs: number;             // End of statistical window used for detection
	observedValue: number;           // The actual measured value (explicit naming)
	baseline: BaselineInfo;          // Baseline statistics for explainability
	anomalyScore: number;            // 0.0-1.0 raw detector output (max across all methods)
	confidence: number;              // 0.0-1.0 post-fusion certainty (adjusted for baseline quality)
	severity: AnomalySeverity;       // Derived from anomalyScore
	severityReason: string;          // How severity was determined (for auditing/tuning)
	triggeredBy: DetectionMethod[];  // Which detectors fired
	suppressed: boolean;             // Within cooldown period
	expectedRange: [number, number]; // From highest-confidence detector
	deviation: number;               // From highest-confidence detector
	fingerprint: string;             // For deduplication (hash of device+metric+method+severity)
	// Suppression metadata
	cooldownSec: number;
	firstSeen: number;
	consecutiveCount: number;
	eventCount: number;              // Total occurrences of this anomaly type
}

/**
 * Anomaly alert structure
 */
export interface AnomalyAlert {
	id: string;                      // Unique alert ID
	severity: AnomalySeverity;
	deviceState?: CanonicalDeviceState; // Canonical operational state during detection
	metric: string;
	value: number;
	expectedRange: [number, number]; // [min, max]
	deviation: number;               // How far from normal (in standard deviations or MADs)
	detectionMethod: DetectionMethod;
	timestamp: number;
	confidence: number;              // 0-1 (1 = very confident)
	context: {
		recent_values: number[];     // Last 10 values
		baseline: number;            // Mean or median
		trend: Trend;
		windowSize: number;
	};
	message: string;                 // Human-readable description
	fingerprint: string;             // For deduplication: hash(metric, method, severity)
	count: number;                   // Number of times this alert fired (deduplicated)
	
	// Alert suppression metadata (for cloud-side deduplication)
	cooldownSec: number;             // Cooldown period in seconds
	firstSeen: number;               // Unix timestamp (ms) when first detected
	consecutiveCount: number;        // Consecutive detections without reset
}

/**
 * Metric-specific configuration
 */
export interface MetricConfig {
	name: string;                    // Metric name field (e.g., 'level', 'temperature')
	deviceName?: string;             // Optional: scope this config to a specific device (e.g., 'Zone A-uuid123')
	                                 // When set, matches incoming metric "deviceName_name" (e.g., 'Zone A-uuid123_level')
	enabled: boolean;
	methods: DetectionMethod[];      // Which detection methods to use
	threshold: number;               // Threshold for detection (σ or MAD multiplier)
	windowSize: number;              // Number of samples for rolling statistics
	expectedRange?: [number, number]; // Optional expected range [min, max]
	minConfidence?: number;          // Minimum confidence to alert (default: 0.7)
	cooldownMs?: number;             // Min time between alerts (default: 5 min)
	
	// Epsilon floors to prevent division blow-ups on flatlined signals
	madEpsilon?: number;             // MAD epsilon floor (default: 0.05)
	stdDevEpsilon?: number;          // StdDev epsilon floor (default: 0.05)
	
	// Seasonality configuration (for non-stationary metrics)
	seasonality?: SeasonalityPattern; // Baseline bucketing pattern (default: 'none')
	
	// Fusion-specific configuration
	fusion?: {
		enabled?: boolean;           // Use fusion detector (default: true if methods.includes('fusion'))
		threshold?: number;          // Fusion score threshold 0-1 (default: 0.6)
		weights?: Record<string, number>; // Custom detector weights
		minimumAgreement?: number;   // Min detectors that must agree (default: 1)
		enableOverrides?: boolean;   // Allow hard rules to override (default: true)
	};
	
	// Temporal confirmation (N-of-M pattern)
	temporal?: {
		enabled?: boolean;           // Enable temporal confirmation (default: false)
		required?: number;           // N: Number of anomalies required (default: 2)
		windowSize?: number;         // M: Size of lookback window (default: 3)
		bypassOnCritical?: boolean;  // Allow critical severity to bypass (default: true)
		requireConsecutive?: boolean; // Require consecutive anomalies (default: false)
		preset?: 'default' | 'strict' | 'consecutive' | 'sensitive'; // Preset config
	};
}

export interface PredictionCadenceConfig {
	minIntervalMs?: number;
	minSamples?: number;
	minTrendChange?: number;
	minConfidenceDelta?: number;
	minPredictionDelta?: number;
}

/**
 * Default anomaly detection settings (inherited by all metrics)
 */
export interface AnomalyDefaults {
	methods: DetectionMethod[];      // Default detection methods (e.g., ['zscore', 'mad'])
	threshold: number;               // Default sensitivity threshold (e.g., 3.0)
	windowSize: number;              // Default rolling window size (e.g., 120)
	minSamples: number;              // Minimum samples before detection starts (e.g., 5)
}

/**
 * Anomaly detection configuration
 */
export interface AnomalyConfig {
	enabled?: boolean;               // Global anomaly detection toggle (default: true)
	defaults?: AnomalyDefaults;      // Shared default settings
	sensitivity: number;             // 1-10 (higher = more sensitive)
	metrics: MetricConfig[];         // Unified metric list for anomaly processing
	alerts: {
		mqtt: boolean;
		cloud: boolean;
		minConfidence: number;
		cooldownMs: number;
		maxQueueSize: number;
	};
	storage?: {
		retention: number;       // Days to retain anomaly history
		dbPath?: string;         // Optional - db connection takes precedence
		minSamples?: number;     // Minimum samples required before saving baseline (default: 5)
		baselineMaxAgeDays?: number; // Max age in days before a loaded baseline is discarded (default: 7)
	};
	ml?: {
		enabled: boolean;
		trainingIntervalMs: number;
		confidenceThreshold: number;
	};
	predictions?: {
		cadence?: PredictionCadenceConfig;
	};
	correlation?: {
		enabled?: boolean;
		requireSameState?: boolean;
	};
	warmupPeriodMs?: number;          // Suppress alerts during agent initialization (default: 900000 = 15 min)
}

/**
 * Statistical buffer for efficient incremental calculations
 */
export interface StatisticalBuffer {
	values: number[];                // Circular buffer of values
	timestamps: number[];            // Corresponding timestamps
	size: number;                    // Current size (≤ maxSize)
	maxSize: number;                 // Maximum capacity
	head: number;                    // Index of next insertion
	
	// Incremental statistics (updated on each insert)
	sum: number;
	sumSquares: number;
	mean: number;
	variance: number;
	stdDev: number;
	
	// Sorted values for median/percentile (updated lazily)
	sortedValues?: number[];
	sortedDirty: boolean;
	
	// Reset flag - set when baseline is recalculated or buffer is cleared
	reset?: boolean;
}

/**
 * Detection result from a single method
 */
export interface DetectionResult {
	method: DetectionMethod;
	isAnomaly: boolean;
	confidence: number;              // 0-1
	deviation: number;               // Distance from normal
	expectedRange: [number, number];
	message: string;
	baselineSource?: 'buffer' | 'database'; // Track source of baseline stats
}

/**
 * Detector interface - all detectors implement this
 */
export interface AnomalyDetector {
	readonly method: DetectionMethod;
	detect(
		value: number,
		buffer: StatisticalBuffer,
		config: MetricConfig,
		dbBaseline?: {
			mean?: number;
			median?: number;
			std_dev?: number;
			mad?: number;
			sample_count: number;
		}
	): DetectionResult;
}

/**
 * Alert manager interface
 */
export interface AlertManager {
	addAlert(alert: AnomalyAlert): void;
	getAlerts(since?: number): AnomalyAlert[];
	clearAlerts(): void;
	getQueueSize(): number;
}
