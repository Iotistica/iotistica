// agent/src/features/endpoints/snmp/types.ts
import { GenericDeviceConfig } from '../base.js';

export interface SNMPConnection {
  host: string;
  port?: number; // Default: 161
  version: 'v1' | 'v2c' | 'v3'; // SNMP version
  
  // v1/v2c authentication
  community?: string; // Default: 'public'
  
  // v3 authentication
  username?: string;
  securityLevel?: 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
  authProtocol?: 'md5' | 'sha';
  authKey?: string;
  privProtocol?: 'des' | 'aes';
  privKey?: string;
  
  // Connection settings
  timeout?: number; // ms (default: 5000)
  retries?: number; // Default: 1
  retryDelay?: number; // ms (default: 5000)
}

export interface SNMPDataPoint {
  name: string; // Human-readable name (e.g., 'cpu_usage')
  oid: string; // SNMP OID (e.g., '1.3.6.1.4.1.2021.11.9.0')
  unit?: string; // Unit of measurement (e.g., '%', 'bytes', 'packets')
  dataType?: 'integer' | 'counter32' | 'counter64' | 'gauge' | 'timeticks' | 'string';
  scalingFactor?: number; // Multiply by this value
  offset?: number; // Add this value
}

export interface SNMPDeviceConfig extends GenericDeviceConfig {
  protocol: 'snmp';
  connection: SNMPConnection;
  dataPoints: SNMPDataPoint[];
}
