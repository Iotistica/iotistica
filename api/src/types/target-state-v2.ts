/**
 * Target State V2 Type Definitions
 * 
 * This represents the restructured target state configuration format.
 * Better organized into logical sections: anomaly, logging, features, runtime, intervals, protocols.
 * 
 * Key changes from V1:
 * - Anomaly detection consolidated into single section
 * - Logging settings grouped together (including maxLogs, logMaxAge, maxLogFileSize)
 * - Runtime section (renamed from "settings") for memory/restart policies
 * - Intervals extracted into dedicated section
 * - Modbus vendor points as object instead of array (keyed by point name)
 */

// ============================================================================
// Anomaly Detection
// ============================================================================

export interface AnomalyAlerts {
  cooldownMs: number;      // Min time between duplicate alerts (agent-side deduplication)
  maxQueueSize: number;    // Max alerts in memory queue (agent-side)
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

export interface AnomalyDetectionConfig {
  alerts: AnomalyAlerts;
  metrics: AnomalyMetric[];
  storage: AnomalyStorage;
  sensitivity: number;
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
}

export interface SNMPProtocolConfig {
  enabled: boolean;
  port: number;
  ipRanges: string[];
}

export interface OPCUAProtocolConfig {
  enabled: boolean;
  discoveryUrls: string[];
}

export interface ModbusConnection {
  host: string;
  port: number;
  timeoutMs: number;
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
}

export interface ModbusProtocolConfig {
  enabled: boolean;
  vendor: string;
  connection: ModbusConnection;
  addressing: ModbusAddressing;
  points: Record<string, ModbusDataPoint>;  // Object keyed by point name (e.g., "temperature", "humidity")
}

export interface ProtocolsConfig {
  can: CANProtocolConfig;
  snmp: SNMPProtocolConfig;
  opcua: OPCUAProtocolConfig;
  modbus: ModbusProtocolConfig;
}

// ============================================================================
// Complete Target State V2
// ============================================================================

export interface TargetStateV2 {
  anomalyDetection: AnomalyDetectionConfig;
  logging: LoggingConfig;
  features: FeaturesConfig;
  runtime: RuntimeConfig;
  intervals: IntervalsConfig;
  protocols: ProtocolsConfig;
}

// ============================================================================
// Helper Types for Migration
// ============================================================================

/**
 * Legacy V1 format (flat structure with vendorDataPoints as array)
 */
export interface ModbusVendorDataPoint {
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
 * Transform vendorDataPoints array → points object
 */
export function vendorDataPointsToPointsObject(
  vendorDataPoints: ModbusVendorDataPoint[]
): Record<string, ModbusDataPoint> {
  const points: Record<string, ModbusDataPoint> = {};
  
  for (const point of vendorDataPoints) {
    const { name, ...rest } = point;
    points[name] = rest;
  }
  
  return points;
}

/**
 * Transform points object → vendorDataPoints array (for backward compatibility)
 */
export function pointsObjectToVendorDataPoints(
  points: Record<string, ModbusDataPoint>
): ModbusVendorDataPoint[] {
  return Object.entries(points).map(([name, point]) => ({
    name,
    ...point
  }));
}

// ============================================================================
// Validation Helpers
// ============================================================================

export function isTargetStateV2(config: any): config is TargetStateV2 {
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
