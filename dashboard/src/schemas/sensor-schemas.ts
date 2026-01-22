/**
 * Sensor Configuration Type Definitions
 * 
 * TypeScript types for protocol device configuration.
 * Derived from agent types for frontend usage.
 */

// ============================================================================
// Anomaly Detection Types
// ============================================================================

/**
 * Anomaly detection methods
 */
export interface AnomalyDetectionMethods {
  zscore?: boolean;    // Z-Score (Standard Deviation)
  mad?: boolean;       // Median Absolute Deviation
  iqr?: boolean;       // Interquartile Range
  roc?: boolean;       // Rate of Change
  ewma?: boolean;      // Exponentially Weighted Moving Average
}

/**
 * Expected range for anomaly detection
 */
export interface AnomalyExpectedRange {
  min?: number;
  max?: number;
}

/**
 * Anomaly detection configuration for a data point
 */
export interface AnomalyDetectionConfig {
  enabled?: boolean;
  methods?: AnomalyDetectionMethods;
  threshold?: number;
  expectedRange?: AnomalyExpectedRange;
}

// ============================================================================
// Modbus Types
// ============================================================================

/**
 * Modbus connection types
 */
export type ModbusConnectionType = 'tcp' | 'rtu' | 'ascii';

/**
 * Modbus register types (maps to function codes)
 */
export type ModbusRegisterType = 'coil' | 'discrete' | 'holding' | 'input';

/**
 * Modbus data types
 */
export type ModbusDataType = 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'boolean' | 'string';

/**
 * Byte order for 32-bit values
 */
export type ByteOrder = 'ABCD' | 'CDAB' | 'BADC' | 'DCBA';

/**
 * Modbus TCP connection configuration
 */
export interface ModbusTCPConnection {
  type: 'tcp';
  host: string;
  port: number;
  slaveId?: number; // Unit ID (1-247) for operational devices
  slaveRange?: { start: number; end: number }; // For discovery targets
  timeout: number;
}

/**
 * Modbus RTU connection configuration
 */
export interface ModbusRTUConnection {
  type: 'rtu';
  serialPort: string;
  baudRate: number;
  dataBits: number;
  stopBits: number;
  parity: 'none' | 'even' | 'odd';
  slaveId?: number; // Unit ID (1-247) for operational devices
  slaveRange?: { start: number; end: number }; // For discovery targets
  timeout: number;
}

/**
 * Combined Modbus connection type
 */
export type ModbusConnection = ModbusTCPConnection | ModbusRTUConnection;

/**
 * Modbus data point (register) configuration
 */
export interface ModbusDataPoint {
  name: string;
  address: number;
  type: ModbusRegisterType;
  dataType: ModbusDataType;
  count?: number;
  byteOrder?: ByteOrder;
  scale?: number;
  offset?: number;
  unit?: string;
  encoding?: 'ascii' | 'utf8' | 'utf-8' | 'latin1';
  description?: string;
  anomalyDetection?: AnomalyDetectionConfig;
}

/**
 * Complete Modbus device configuration
 */
export interface ModbusDeviceConfig {
  name: string;
  protocol: 'modbus';
  enabled: boolean;
  pollInterval: number;
  connection: ModbusConnection;
  dataPoints: ModbusDataPoint[];
}

// ============================================================================
// OPC-UA Types
// ============================================================================

/**
 * OPC-UA security modes
 */
export type OPCUASecurityMode = 'None' | 'Sign' | 'SignAndEncrypt';

/**
 * OPC-UA security policies
 */
export type OPCUASecurityPolicy = 
  | 'None'
  | 'Basic128Rsa15'
  | 'Basic256'
  | 'Basic256Sha256'
  | 'Aes128_Sha256_RsaOaep'
  | 'Aes256_Sha256_RsaPss';

/**
 * OPC-UA data types
 */
export type OPCUADataType = 
  | 'Boolean'
  | 'SByte'
  | 'Byte'
  | 'Int16'
  | 'UInt16'
  | 'Int32'
  | 'UInt32'
  | 'Int64'
  | 'UInt64'
  | 'Float'
  | 'Double'
  | 'String'
  | 'DateTime'
  | 'ByteString';

/**
 * OPC-UA connection configuration
 */
export interface OPCUAConnection {
  endpointUrl: string;
  username?: string;
  password?: string;
  securityMode: OPCUASecurityMode;
  securityPolicy: OPCUASecurityPolicy;
  connectionTimeout: number;
  sessionTimeout: number;
  keepAliveInterval: number;
  useSubscription: boolean;
  publishingInterval: number;
  samplingInterval: number;
  maxMonitoredItemsPerSubscription: number;
}

/**
 * OPC-UA data point configuration
 */
export interface OPCUADataPoint {
  name: string;
  nodeId: string;
  dataType: OPCUADataType;
  namespace: number;
  scale?: number;
  offset?: number;
  unit?: string;
  anomalyDetection?: AnomalyDetectionConfig;
}

/**
 * Complete OPC-UA device configuration
 */
export interface OPCUADeviceConfig {
  name: string;
  protocol: 'opcua';
  enabled: boolean;
  pollInterval: number;
  connection: OPCUAConnection;
  dataPoints: OPCUADataPoint[];
}

// ============================================================================
// Protocol Adapter Device (Union Type)
// ============================================================================

/**
 * Union type for all protocol device configurations
 */
export type ProtocolDeviceConfig = ModbusDeviceConfig | OPCUADeviceConfig;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get default connection config for a protocol
 */
export function getDefaultConnection(protocol: 'modbus' | 'opcua'): ModbusConnection | OPCUAConnection {
  if (protocol === 'modbus') {
    return {
      type: 'tcp',
      host: '192.168.1.100',
      port: 502,
      slaveId: 1,
      timeout: 5000,
    };
  } else {
    return {
      endpointUrl: 'opc.tcp://192.168.1.100:4840',
      securityMode: 'None',
      securityPolicy: 'None',
      connectionTimeout: 10000,
      sessionTimeout: 60000,
      keepAliveInterval: 5000,
      useSubscription: false,
      publishingInterval: 1000,
      samplingInterval: 500,
      maxMonitoredItemsPerSubscription: 100,
    };
  }
}

/**
 * Get default data point for a protocol
 */
export function getDefaultDataPoint(protocol: 'modbus' | 'opcua'): ModbusDataPoint | OPCUADataPoint {
  if (protocol === 'modbus') {
    return {
      name: 'register_0',
      address: 0,
      type: 'holding',
      dataType: 'uint16',
      count: 1,
      byteOrder: 'ABCD',
      scale: 1,
      offset: 0,
      unit: '',
      encoding: 'ascii',
      description: '',
    };
  } else {
    return {
      name: 'data_point',
      nodeId: 'ns=2;s=Temperature',
      dataType: 'Double',
      namespace: 2,
      scale: 1,
      offset: 0,
      unit: '',
    };
  }
}

/**
 * Calculate register count based on data type
 */
export function getRegisterCount(dataType: ModbusDataType): number {
  switch (dataType) {
    case 'int16':
    case 'uint16':
    case 'boolean':
      return 1;
    case 'int32':
    case 'uint32':
    case 'float32':
      return 2;
    case 'string':
      return 1; // User must specify count for strings
    default:
      return 1;
  }
}

/**
 * Check if data type requires byte order
 */
export function requiresByteOrder(dataType: ModbusDataType): boolean {
  return ['int32', 'uint32', 'float32'].includes(dataType);
}

/**
 * Get function code from register type
 */
export function getFunctionCodeInfo(type: ModbusRegisterType): { read: number; write?: number; readonly: boolean } {
  switch (type) {
    case 'coil':
      return { read: 1, write: 5, readonly: false };
    case 'discrete':
      return { read: 2, readonly: true };
    case 'holding':
      return { read: 3, write: 16, readonly: false };
    case 'input':
      return { read: 4, readonly: true };
    default:
      return { read: 3, readonly: false };
  }
}
