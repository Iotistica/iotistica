import { z } from 'zod';

/**
 * Unix Socket Output Configuration Schema (Protocol-agnostic)
 */
export const SocketOutputSchema = z.object({
  socketPath: z.string().min(1),
  dataFormat: z.enum(['json', 'csv']).optional().default('json'),
  delimiter: z.string().optional().default('\n'),
  includeTimestamp: z.boolean().optional().default(true),
  includeDeviceName: z.boolean().optional().default(true)
});

export type SocketOutput = z.infer<typeof SocketOutputSchema>;

/**
 * Sensor Data Point interface
 * Quality model follows OPC UA standard (GOOD, BAD, UNCERTAIN)
 */
export interface SensorDataPoint {
  deviceName: string;
  device_uuid?: string;
  metric: string;  // Generic field name (Modbus register, OPC UA node, SNMP OID)
  value: number | boolean | string | null;  // null when quality is BAD
  unit: string;
  timestamp: string;
  quality: 'GOOD' | 'BAD' | 'UNCERTAIN';  // OPC UA quality codes
  qualityCode?: string;  // Error code when quality is BAD (e.g., 'ETIMEDOUT', 'DEVICE_OFFLINE')
  protocol?: string;  // Protocol context for enum namespacing (modbus, snmp, opcua, mqtt, bacnet)
  nodeType?: 'metric' | 'metadata';  // Node classification (OPC UA only)
  anomaly_score?: number;  // Edge AI anomaly score (0.0 = normal, 1.0 = max anomaly)
  anomaly_threshold?: number;  // Confidence threshold used for alerting (e.g., 0.7)
  baseline_samples?: number;  // Number of samples in baseline buffer
  detection_methods?: string[];  // Detection methods used (e.g., ["zscore", "mad"])
}

/**
 * Device Status interface
 * Contains both static metadata and dynamic health metrics
 * 
 * Generic across all protocols (Modbus, SNMP, OPC-UA, MQTT, BACnet)
 */
export interface DeviceStatus {
  // Basic identity
  deviceName: string;
  
  // Connection state
  connected: boolean;
  lastPoll: Date | null;
  lastSeen: Date | null;  // Last successful communication (different from lastPoll which can be failed attempt)
  
  // Error tracking
  errorCount: number;
  lastError: string | null;
  
  // Performance metrics (point-in-time)
  responseTimeMs: number | null;  // Last response time in milliseconds
  pollSuccessRate: number;  // Rolling success rate 0-1 (calculated from recent polls)
  
  // Data quality
  registersUpdated: number;  // How many registers/values changed in last poll
  
  // Overall health indicator
  communicationQuality: 'good' | 'degraded' | 'poor' | 'offline';
  
  // Time-series metrics (optional - for advanced monitoring)
  // Enables P95/P99 calculations, trending, and anomaly detection
  metrics?: {
    pollDurations: number[];        // Last N poll durations (ms) - for P95/P99
    pollSuccessCount: number;       // Total successful polls
    pollTotalCount: number;         // Total poll attempts
    dataPointsUpdated: number[];    // Last N data points changed per poll
    lastErrors: Array<{             // Last N errors with context
      timestamp: Date;
      type: string;                 // Error code (TIMEOUT, CONNECTION_REFUSED, etc.)
      message: string;
    }>;
  };
}

/**
 * Logger interface
 */
export interface Logger {
  debug(message: string, ...args: any[]): void;
  info(message: string, ...args: any[]): void;
  warn(message: string, ...args: any[]): void;
  error(message: string, ...args: any[]): void;
}
