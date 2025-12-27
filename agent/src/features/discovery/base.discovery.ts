/**
 * Base Discovery Plugin Interface
 * 
 * All protocol discovery plugins extend this base
 * Makes adding new protocols (BACnet, PROFINET, MQTT, SNMP, etc.) trivial
 */

import type { AgentLogger } from '../../logging/agent-logger';

/**
 * Validation result from Phase 2 deep inspection
 */
export interface ValidationResult {
  deviceInfo?: any;
  manufacturer?: string;
  modelNumber?: string;
  firmwareVersion?: string;
  capabilities?: string[];
  
  // Profile validation (Modbus-specific)
  profileValidation?: {
    result: 'profile_match' | 'profile_mismatch' | 'degraded' | 'unknown';
    state: 'idle' | 'active' | 'unknown';  // Device activity state
    responseConfidence: number;  // How confident addresses are correct (readable ratio)
    dataConfidence: number;      // How confident data is meaningful (variance)
    readableCount: number;
    errorCount: number;
    zeroCount: number;
    totalPoints: number;
    details?: string;
    guidance?: string;      // Specific guidance based on pattern
    meiVendor?: string;     // MEI vendor name (if available)
    meiModel?: string;      // MEI model name (if available)
  };
}

/**
 * Discovered device (returned by Phase 1)
 * 
 * CRITICAL: All required fields MUST be set by plugins to ensure data consistency
 */
export interface DiscoveredDevice {
  // Identity (REQUIRED)
  protocol: 'modbus' | 'opcua' | 'can' | 'snmp' | 'mqtt'; // Strongly typed protocol
  name: string; // Human-readable name
  fingerprint: string; // Cryptographic hash (survives moves/reconfigs)
  
  // Connection (REQUIRED)
  connection: Record<string, any>; // Protocol-specific connection config
  
  // Data points (REQUIRED - can be empty array)
  dataPoints: any[]; // Registers, nodes, messages, etc.
  
  // Discovery metadata (REQUIRED)
  confidence: 'low' | 'medium' | 'high'; // Detection confidence
  discoveredAt: string; // ISO timestamp
  
  // Validation (REQUIRED flags, optional data)
  validated: boolean; // Whether Phase 2 validation ran
  validationData?: ValidationResult; // Only present if validated=true
  
  // Optional metadata
  metadata?: Record<string, any>; // Additional protocol-specific data
}

export interface DiscoveryResult {
  devices: DiscoveredDevice[];
  duration: number; // ms
  errors?: string[];
}

/**
 * Base class for all protocol discovery plugins
 */
export abstract class BaseDiscoveryPlugin {
  protected logger?: AgentLogger;
  readonly protocol: string;

  constructor(protocol: string, logger?: AgentLogger) {
    this.protocol = protocol;
    this.logger = logger;
  }

  /**
   * Phase 1: Quick discovery (detect responding devices)
   * Should be fast - minimal network traffic
   */
  abstract discover(options?: any): Promise<DiscoveredDevice[]>;

  /**
   * Phase 2: Validation (optional deep inspection)
   * Can be slow - reads device info, browses capabilities
   */
  abstract validate(device: DiscoveredDevice, timeout?: number): Promise<any>;

  /**
   * Check if this plugin can run on current platform
   * e.g., CAN requires socketcan, Modbus might need serial ports
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Get plugin metadata
   */
  getInfo(): PluginInfo {
    return {
      protocol: this.protocol,
      version: '1.0.0',
      description: `Discovery plugin for ${this.protocol}`
    };
  }
}

export interface PluginInfo {
  protocol: string;
  version: string;
  description: string;
  capabilities?: string[];
}
