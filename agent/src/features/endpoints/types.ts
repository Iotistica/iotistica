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
  registerName: string;
  value: number | boolean | string | null;  // null when quality is BAD
  unit: string;
  timestamp: string;
  quality: 'GOOD' | 'BAD' | 'UNCERTAIN';  // OPC UA quality codes
  qualityCode?: string;  // Error code when quality is BAD (e.g., 'ETIMEDOUT', 'DEVICE_OFFLINE')
  anomaly_score?: number;  // Edge AI anomaly score (0.0 = normal, 1.0 = max anomaly)
  anomaly_threshold?: number;  // Confidence threshold used for alerting (e.g., 0.7)
  baseline_samples?: number;  // Number of samples in baseline buffer
  detection_methods?: string[];  // Detection methods used (e.g., ["zscore", "mad"])
}

/**
 * Device Status interface
 * Contains both static metadata and dynamic health metrics
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
  
  // Performance metrics
  responseTimeMs: number | null;  // Last response time in milliseconds
  pollSuccessRate: number;  // Rolling success rate 0-1 (calculated from recent polls)
  
  // Data quality
  registersUpdated: number;  // How many registers/values changed in last poll
  
  // Overall health indicator
  communicationQuality: 'good' | 'degraded' | 'poor' | 'offline';
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
