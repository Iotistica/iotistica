/**
 * Virtual Device Types
 * 
 * Type definitions for virtual device management system.
 * Virtual agents are protocol simulators (Modbus, OPC UA) that run as
 * sidecar containers alongside agents, accessed via localhost.
 * 
 * Architecture:
 * Database: endpoints table stores full config + deployment metadata
 * - Target State: agent receives only connection settings (no K8s metadata)
 * - Deployment: K8s sidecar containers or Docker Compose services
 */

/**
 * Supported virtual device protocols
 */
export type VirtualDeviceProtocol = 'modbus' | 'opcua' | 'mqtt' | 'can';

/**
 * Input configuration for creating a virtual device
 */
export interface VirtualDeviceConfig {
  /** Parent agent UUID */
  deviceUuid: string;
  
  /** Display name (e.g., "Virtual PLC 1") */
  name: string;
  
  /** Protocol type */
  protocol: VirtualDeviceProtocol;
  
  /** Profile name from profile_configs table (e.g., "PM556x", "TestFactory") */
  profile: string;
  
  /** Container image (defaults to iotistic/{protocol}-simulator:latest) */
  image?: string;
  
  /** Number of slave IDs (Modbus) or endpoints (OPC UA) */
  slaveCount?: number;
}

/**
 * Modbus connection configuration
 */
export interface ModbusConnection {
  host: string;
  port: number;
  type: 'tcp' | 'rtu';
  timeout: number;
  slaveRange?: {
    start: number;
    end: number;
  };
}

/**
 * OPC UA connection configuration
 */
export interface OPCUAConnection {
  endpointUrl: string;
  securityMode: 'None' | 'Sign' | 'SignAndEncrypt';
  securityPolicy: 'None' | 'Basic128Rsa15' | 'Basic256' | 'Basic256Sha256' | 'Aes128_Sha256_RsaOaep' | 'Aes256_Sha256_RsaPss';
  certificateTrustMode?: 'strict' | 'trust-on-first-use';
  expectedServerThumbprint?: string;
  username?: string;
  password?: string;
  connectionTimeout?: number;
  sessionTimeout?: number;
  keepAliveInterval?: number;
}

/**
 * Generic connection configuration (supports multiple protocols)
 */
export type VirtualDeviceConnection = ModbusConnection | OPCUAConnection;

/**
 * Virtual device deployment metadata (stored in database, not in target state)
 */
export interface VirtualDeviceMetadata {
  /** Indicates this is a sidecar device */
  sidecar: boolean;
  
  /** Profile name from profile_configs */
  profile: string;
  
  /** Container image */
  image: string;
  
  /** Container environment variables */
  containerConfig: {
    env: Record<string, string>;
  };
  
  /** Creation timestamp */
  createdAt?: string;
  
  /** Created by user/service */
  createdBy?: string;
}

/**
 * Complete virtual device record (from database)
 */
export interface VirtualDeviceSensor {
  /** Device sensor UUID */
  uuid: string;
  
  /** Parent agent UUID */
  agent_uuid: string;
  
  /** Display name */
  name: string;
  
  /** Protocol type */
  protocol: VirtualDeviceProtocol;
  
  /** Connection configuration (protocol-specific) */
  connection: VirtualDeviceConnection;
  
  /** Data points from profile (stored in DB, may be omitted from target state for OPC UA) */
  data_points?: any[];
  
  /** Deployment metadata (K8s-specific, not sent to agent) */
  metadata: VirtualDeviceMetadata;
  
  /** Whether device is enabled */
  enabled?: boolean;
  
  /** Poll interval in milliseconds */
  poll_interval?: number;
  
  /** Database timestamps */
  created_at?: Date;
  updated_at?: Date;
  
  /** Audit fields */
  created_by?: string;
  updated_by?: string;
  
  /** Deployment tracking */
  deployment_status?: 'draft' | 'pending' | 'deployed' | 'failed';
  config_version?: number;
  synced_to_config?: boolean;
}

/**
 * Virtual device creation result
 */
export interface VirtualDeviceCreateResult {
  /** Created sensor record */
  sensor: VirtualDeviceSensor;
  
  /** Target state version after creation */
  version: number;
  
  /** Whether K8s deployment was patched */
  deploymentPatched?: boolean;
}

/**
 * Container environment variables for different protocols
 */
export interface ModbusSimulatorEnv {
  LOG_LEVEL: string;
  TRANSPORT: 'tcp' | 'rtu';
  MODBUS_PROFILE: string;
  MODBUS_PORT: string;
  MODBUS_SLAVES: string;
  MODBUS_API_URL: string;
  GUI_PORT: string;
}

export interface OPCUASimulatorEnv {
  LOG_LEVEL: string;
  OPCUA_PROFILE: string;
  OPCUA_PORT: string;
  OPCUA_ENDPOINT_COUNT: string;
  OPCUA_API_URL: string;
}

/**
 * K8s sidecar container specification
 */
export interface VirtualDeviceSidecarSpec {
  name: string;
  image: string;
  env: Array<{ name: string; value: string }>;
  ports: Array<{ containerPort: number }>;
  resources: {
    limits: {
      cpu: string;
      memory: string;
    };
    requests: {
      cpu: string;
      memory: string;
    };
  };
}

/**
 * Profile data point configuration (from profile_configs table)
 */
export interface ProfileDataPoint {
  /** Sensor name or nodeId */
  name?: string;
  
  /** OPC UA node ID (e.g., "ns=2;s=Temperature") */
  nodeId?: string;
  
  /** Unit of measurement */
  unit?: string;
  
  /** Data type */
  dataType?: string;
  
  /** Scaling factor */
  scalingFactor?: number;
  
  /** Modbus register address */
  address?: number;
  
  /** Modbus function code */
  functionCode?: number;
}

/**
 * OPC UA sensor group (for profile generation)
 */
export interface OPCUASensorGroup {
  /** Folder/namespace in OPC UA server */
  folder: string;
  
  /** Sensor name prefix */
  prefix: string;
  
  /** Sensor model/type (e.g., "temperature", "pressure") */
  model: string;
  
  /** Number of sensors to generate */
  count: number;
  
  /** Unit of measurement */
  unit: string;
  
  /** Model-specific configuration */
  config?: {
    min?: number;
    max?: number;
    [key: string]: any;
  };
}

/**
 * Type guards for connection types
 */
export function isModbusConnection(conn: VirtualDeviceConnection): conn is ModbusConnection {
  return 'host' in conn && 'port' in conn && 'type' in conn;
}

export function isOPCUAConnection(conn: VirtualDeviceConnection): conn is OPCUAConnection {
  return 'endpointUrl' in conn && 'securityMode' in conn;
}

/**
 * Port assignment helpers
 */
export const VIRTUAL_DEVICE_BASE_PORTS: Record<VirtualDeviceProtocol, number> = {
  modbus: 502,
  opcua: 4840,
  mqtt: 1883,
  can: 11898
};

/**
 * Default resource limits for sidecar containers
 */
export const SIDECAR_RESOURCE_DEFAULTS = {
  limits: {
    cpu: '500m',
    memory: '512Mi'
  },
  requests: {
    cpu: '100m',
    memory: '128Mi'
  }
};
