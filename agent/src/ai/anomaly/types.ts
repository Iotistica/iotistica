/**
 * ANOMALY DETECTION - TYPE DEFINITIONS
 * ======================================
 * 
 * Edge-appropriate anomaly detection for IoT sensor data and system metrics
 */

/**
 * Unified data point for all monitored values
 */
export interface DataPoint {
	source: 'sensor' | 'system' | 'container' | 'endpoint';
	metric: string;           // e.g., 'temperature', 'cpu_usage', 'memory_percent'
	value: number;
	unit: string;
	timestamp: number;        // Unix timestamp (ms)
	deviceId?: string;        // For multi-sensor scenarios
	quality?: 'GOOD' | 'BAD' | 'UNCERTAIN';
	tags?: Record<string, string>;  // Additional metadata
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
	| 'correlation';  // Correlation between metrics

/**
 * Anomaly severity levels
 */
export type AnomalySeverity = 'info' | 'warning' | 'critical';

/**
 * Trend direction
 */
export type Trend = 'increasing' | 'decreasing' | 'stable';

/**
 * Anomaly alert structure
 */
export interface AnomalyAlert {
	id: string;                      // Unique alert ID
	severity: AnomalySeverity;
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
}

/**
 * Metric-specific configuration
 */
export interface MetricConfig {
	name: string;                    // Metric name (e.g., 'temperature')
	enabled: boolean;
	methods: DetectionMethod[];      // Which detection methods to use
	threshold: number;               // Threshold for detection (σ or MAD multiplier)
	windowSize: number;              // Number of samples for rolling statistics
	expectedRange?: [number, number]; // Optional expected range [min, max]
	minConfidence?: number;          // Minimum confidence to alert (default: 0.7)
	cooldownMs?: number;             // Min time between alerts (default: 5 min)
}

/**
 * Anomaly detection configuration
 */
export interface AnomalyConfig {
	sensitivity: number;             // 1-10 (higher = more sensitive)
	metrics: MetricConfig[];
	alerts: {
		mqtt: boolean;
		cloud: boolean;
		minConfidence: number;
		cooldownMs: number;
		maxQueueSize: number;
	};
	storage?: {
		retention: number;       // Days to retain anomaly history
		dbPath?: string;  // Optional - db connection takes precedence
		minSamples?: number; // Minimum samples required before saving baseline (default: 5)
	};
	ml?: {
		enabled: boolean;
		trainingIntervalMs: number;
		confidenceThreshold: number;
	};
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
