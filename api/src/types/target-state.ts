/**
 * Target State Type Definitions
 * 
 * This represents the target state configuration format sent to agents.
 * Organized into logical sections: anomaly, logging, features, runtime, intervals, protocols.
 */

// ============================================================================
// Anomaly Detection
// ============================================================================

export interface AnomalyAlerts {
  cooldownMs: number;      // Min time between duplicate alerts (agent-side deduplication)
  maxQueueSize: number;    // Max alerts in memory queue (agent-side)
  minConfidence: number;   // Minimum confidence threshold to generate alerts (0-1, default 0.7)
}

export interface AnomalyMetric {
  name: string;
  enabled: boolean;
  methods: string[];
  threshold: number;
  windowSize: number;
  expectedRange?: [number, number];
}

export interface AnomalyStorage {
  retention: number;      // days
  minSamples: number;
}

/**
 * Default anomaly detection settings
 * Inherited by all metrics unless overridden at metric or data point level
 */
export interface AnomalyDetectionDefaults {
  methods: string[];       // Default detection methods (e.g., ['zscore', 'mad'])
  threshold: number;       // Default sensitivity threshold (e.g., 3.0)
  windowSize: number;      // Default rolling window size (e.g., 120)
  minSamples: number;      // Minimum samples before detection starts (e.g., 5)
}

export interface AnomalyDetectionConfig {
  enabled: boolean;        // Global anomaly detection enable/disable toggle
  defaults: AnomalyDetectionDefaults;  // Shared default settings
  alerts: AnomalyAlerts;
  systemMetrics: AnomalyMetric[];  // System/agent health metrics (cpu, memory, temp)
  storage: AnomalyStorage;
  sensitivity: number;
  warmupPeriodMs: number;  // Suppress alerts during agent initialization (default: 900000 = 15 min)
}

/**
 * Per-Data-Point Anomaly Detection Configuration
 * Stored in device_sensors.data_points JSONB field
 * Used by API to build AnomalyMetric[] array in target state
 */
export interface AnomalyDetectionDataPointConfig {
  enabled: boolean;
  methods?: ('zscore' | 'mad' | 'iqr' | 'roc' | 'ewma')[];
  threshold?: number;
  expectedRange?: {
    min: number;
    max: number;
  };
}

// ============================================================================
// Logging
// ============================================================================

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  enableCompression: boolean;
  enableRemoteLogging: boolean;
  enableFilePersistence: boolean;
  maxLogs: number;
  logMaxAge: number;        // milliseconds
  maxLogFileSize: number;   // bytes
}

// ============================================================================
// Features
// ============================================================================

export interface FeaturesConfig {
  enableDeviceJobs: boolean;
  enableAnomalyDetection: boolean;
  enableDeviceRemoteAccess: boolean;
  enableDeviceSensorPublish: boolean;
}

// ============================================================================
// Runtime
// ============================================================================

export interface ScheduledRestart {
  reason: string;
  enabled: boolean;
  intervalDays: number;
}

export interface MemoryConfig {
  thresholdMb: number;
  checkIntervalMs: number;
}

export interface RuntimeConfig {
  scheduledRestart: ScheduledRestart;
  memory: MemoryConfig;
}

// ============================================================================
// Agent Update (Reconciliation-based)
// ============================================================================

export interface AgentUpdateConfig {
  version?: string;                  // Required/desired agent version
  update_scheduled_at?: string;      // ISO 8601 timestamp for scheduled updates
  update_force?: boolean;            // Override downgrade protection
  update_signature?: string;         // HMAC-SHA256 signature for verification
}

// ============================================================================
// Intervals
// ============================================================================

export interface DeviceIntervalsConfig {
  metricsIntervalMs: number;
  reportIntervalMs: number;  // Renamed from deviceReportIntervalMs for clarity
  reconciliationIntervalMs: number;
  targetStatePollIntervalMs: number;
}

export interface DiscoveryIntervalsConfig {
  fullIntervalMs: number;  // Renamed from discoveryFullIntervalMs
  lightIntervalMs: number;  // Renamed from discoveryLightIntervalMs
}

export interface IntervalsConfig {
  device: DeviceIntervalsConfig;
  discovery: DiscoveryIntervalsConfig;
}

// ============================================================================
// Protocols
// ============================================================================

export interface CANProtocolConfig {
  enabled: boolean;
  bufferCapacity?: number; // Buffer size in bytes for CAN bus messages
}

export interface SNMPProtocolConfig {
  enabled: boolean;
  port: number;
  connections: string[]; // IP addresses/ranges (formerly ipRanges)
  ipRanges?: string[]; // @deprecated - use connections
  bufferCapacity?: number; // Buffer size in bytes for SNMP trap messages
}

export interface OPCUAProtocolConfig {
  enabled: boolean;
  connections: string[]; // OPC UA server URLs (formerly discoveryUrls)
  discoveryUrls?: string[]; // @deprecated - use connections
  bufferCapacity?: number; // Buffer size in bytes for OPC UA messages
}

export interface ModbusConnection {
  name?: string;  // Connection identifier (e.g., 'comap-gen-502')
  host: string;
  port: number;
  enabled?: boolean; // Enable/disable per-connection (default: false until user enables after discovery)
  timeoutMs: number;
  profile?: string;  // Optional: Override root profile
  addressing?: ModbusAddressing;  // Optional: Override root addressing
  points?: Record<string, ModbusDataPoint>;  // Optional: Override root points
}

export interface ModbusAddressing {
  slaveRange: {
    start: number;
    end: number;
  };
}

export interface ModbusDataPoint {
  base?: number;
  address: number;
  type: 'holding' | 'input' | 'coil' | 'discrete';
  dataType: 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'boolean';
  unit?: string;
  scale?: number;
  noisePct?: number;
  description?: string;
  anomalyDetection?: AnomalyDetectionDataPointConfig;  // Per-data-point anomaly config
}

/**
 * OPC-UA Data Point Configuration
 * Stored in device_sensors.data_points JSONB field
 */
export interface OPCUADataPoint {
  name: string;
  nodeId: string;
  semantic?: 'metric' | 'metadata';
  nodeType?: 'metric' | 'metadata';
  dataType?: 'number' | 'string' | 'boolean' | 'object';
  unit?: string;
  scalingFactor?: number;
  offset?: number;
  anomalyDetection?: AnomalyDetectionDataPointConfig;  // Per-data-point anomaly config
}

export interface ModbusProtocolConfig {
  enabled: boolean;
  profile?: string; // Optional: Metadata only (not used operationally)
  bufferCapacity?: number; // Buffer size in bytes for Modbus responses
  connection?: ModbusConnection;  // Legacy: Single connection (optional for backward compat)
  connections?: ModbusConnection[];  // Modern: Multiple connections (optional)
  addressing?: ModbusAddressing;  // Optional: Global addressing (legacy, prefer per-connection)
  points?: Record<string, ModbusDataPoint>;  // Optional: Global points (legacy, prefer per-connection)
}

export interface MQTTConnection {
  brokerUrl: string;  // e.g., 'mqtt://mosquitto:1883'
  username?: string;  // Optional authentication
  password?: string;  // Optional authentication
}

export interface MQTTProtocolConfig {
  enabled: boolean;
  connection: MQTTConnection;
  discoveryRoots?: string[];   // REQUIRED: Explicit topic roots (e.g., ['edge/+', 'devices/+/telemetry'])
  monitorDurationMs?: number;  // How long to listen for topics during discovery (default: 30000)
  qos?: 0 | 1 | 2;             // QoS for discovery subscription (default: 0)
  bufferCapacity?: number;     // Buffer size in bytes for MQTT messages
}

export interface ProtocolsConfig {
  can: CANProtocolConfig;
  snmp: SNMPProtocolConfig;
  opcua: OPCUAProtocolConfig;
  modbus: ModbusProtocolConfig;
  mqtt: MQTTProtocolConfig;
}

// ============================================================================
// Complete Target State 
// ============================================================================

export interface TargetState {
  anomalyDetection: AnomalyDetectionConfig;
  logging: LoggingConfig;
  features: FeaturesConfig;
  runtime: RuntimeConfig;
  agent?: AgentUpdateConfig;  // Cloud-controlled agent version policy
  intervals: IntervalsConfig;
  //protocols: ProtocolsConfig;
}

// ============================================================================
// Helper Types for Migration
// ============================================================================

/**
 * Legacy V1 format (flat structure with profileDataPoints as array)
 */
export interface ModbusProfileDataPoint {
  name: string;
  base?: number;
  address: number;
  type: 'holding' | 'input' | 'coil' | 'discrete';
  dataType: 'uint16' | 'int16' | 'uint32' | 'int32' | 'float32' | 'boolean';
  unit?: string;
  scale?: number;
  noisePct?: number;
  description?: string;
}

/**
 * Transform profileDataPoints array → points object
 */
export function profileDataPointsToPointsObject(
  profileDataPoints: ModbusProfileDataPoint[]
): Record<string, ModbusDataPoint> {
  const points: Record<string, ModbusDataPoint> = {};
  
  for (const point of profileDataPoints) {
    const { name, ...rest } = point;
    points[name] = rest;
  }
  
  return points;
}

/**
 * Transform points object → profileDataPoints array (for backward compatibility)
 */
export function pointsObjectToProfileDataPoints(
  points: Record<string, ModbusDataPoint>
): ModbusProfileDataPoint[] {
  return Object.entries(points).map(([name, point]) => ({
    name,
    ...point
  }));
}

// ============================================================================
// Validation Helpers
// ============================================================================

export function isTargetState(config: any): config is TargetState {
  return (
    config &&
    typeof config === 'object' &&
    'anomaly' in config &&
    'logging' in config &&
    'features' in config &&
    'runtime' in config &&
    'intervals' in config &&
    'protocols' in config
  );
}

export function isLegacyTargetState(config: any): boolean {
  return (
    config &&
    typeof config === 'object' &&
    ('settings' in config || 'anomalyEnabled' in config || 'logLevel' in config)
  );
}
