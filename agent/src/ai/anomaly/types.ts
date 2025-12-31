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
	| 'correlation'   // Correlation between metrics
	| 'fusion';       // Ensemble detector combining multiple methods

/**
 * Anomaly severity levels
 */
export type AnomalySeverity = 'info' | 'warning' | 'critical';

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
 */
export interface AnomalyEvent {
	deviceId: string;                // Device UUID (self-contained, don't rely on topic parsing)
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
	fingerprint: string;             // For deduplication
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
	name: string;                    // Metric name (e.g., 'temperature')
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
