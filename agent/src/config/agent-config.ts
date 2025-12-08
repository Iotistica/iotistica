/**
 * Agent Configuration Access Layer
 * 
 * Provides centralized access to agent configuration with two-tier fallback:
 * 1. Cloud Config (from target state) - highest priority
 * 2. Environment Variables - fallback
 * 
 * This allows dashboard-controlled configuration while maintaining backward
 * compatibility with environment variable-based deployments.
 * 
 * Usage:
 *   const config = new AgentConfig(stateReconciler);
 *   const modbusHost = config.getModbusConfig().tcpHost;
 */

import type { StateReconciler } from '../device-manager/reconciler.js';

export interface ModbusConfig {
  enabled?: boolean;
  tcpHost?: string;
  tcpPort?: number;
  slaveRangeStart?: number;
  slaveRangeEnd?: number;
  timeout?: number;
  vendor?: string;
  // RTU configuration (optional)
  rtuPort?: string;
  rtuBaudRate?: number;
  rtuParity?: string;
  rtuDataBits?: number;
  rtuStopBits?: number;
}

export interface OPCUAConfig {
  enabled?: boolean;
  discoveryUrls?: string[];
}

export interface SNMPConfig {
  enabled?: boolean;
  ipRanges?: string[];
  port?: number;
}

export interface PerformanceConfig {
  memoryCheckIntervalMs?: number;
  memoryThresholdMb?: number;
}

export interface LoggingConfig {
  logMaxAge?: number;
  maxLogFileSize?: number;
  maxLogs?: number;
  enableFilePersistence?: boolean;
  enableCompression?: boolean;
}

export interface FeatureToggles {
  enableProtocolAdapters?: boolean;
  enableSensorPublish?: boolean;
  enableFirstBootDiscovery?: boolean;
  enableAnomalyDetection?: boolean;
  enableFirewall?: boolean;
}

export interface IntervalConfig {
  discoveryFullIntervalMs?: number;
  discoveryLightIntervalMs?: number;
  targetStatePollIntervalMs?: number;
  deviceReportIntervalMs?: number;
  metricsIntervalMs?: number;
  reconciliationIntervalMs?: number;
}

/**
 * Agent Configuration Accessor
 * 
 * Implements cloud-first, environment-fallback pattern for all agent settings.
 */
export class AgentConfig {
  private stateReconciler: StateReconciler;

  constructor(stateReconciler: StateReconciler) {
    this.stateReconciler = stateReconciler;
  }

  /**
   * Get target config from cloud (via StateReconciler)
   */
  private getTargetConfig(): any {
    return this.stateReconciler.getTargetState()?.config || {};
  }

  /**
   * Get Modbus protocol adapter configuration
   * 
   * Fallback: Cloud config → Environment variables
   */
  getModbusConfig(): ModbusConfig {
    const cloud = this.getTargetConfig().protocolAdapters?.modbus;
    const env = process.env;

    return {
      enabled: cloud?.enabled ?? (env.ENABLE_PROTOCOL_ADAPTERS === 'true'),
      tcpHost: cloud?.tcpHost || env.MODBUS_TCP_HOST,
      tcpPort: cloud?.tcpPort ?? (env.MODBUS_TCP_PORT ? parseInt(env.MODBUS_TCP_PORT, 10) : undefined),
      slaveRangeStart: cloud?.slaveRangeStart ?? (env.MODBUS_SLAVE_RANGE_START ? parseInt(env.MODBUS_SLAVE_RANGE_START, 10) : undefined),
      slaveRangeEnd: cloud?.slaveRangeEnd ?? (env.MODBUS_SLAVE_RANGE_END ? parseInt(env.MODBUS_SLAVE_RANGE_END, 10) : undefined),
      timeout: cloud?.timeout ?? (env.MODBUS_TIMEOUT ? parseInt(env.MODBUS_TIMEOUT, 10) : undefined),
      vendor: cloud?.vendor || env.MODBUS_VENDOR,
      // RTU configuration (all optional)
      rtuPort: cloud?.rtuPort || env.MODBUS_SERIAL_PORT,
      rtuBaudRate: cloud?.rtuBaudRate ?? (env.MODBUS_BAUD_RATE ? parseInt(env.MODBUS_BAUD_RATE, 10) : undefined),
      rtuParity: cloud?.rtuParity || env.MODBUS_PARITY,
      rtuDataBits: cloud?.rtuDataBits ?? (env.MODBUS_DATA_BITS ? parseInt(env.MODBUS_DATA_BITS, 10) : undefined),
      rtuStopBits: cloud?.rtuStopBits ?? (env.MODBUS_STOP_BITS ? parseInt(env.MODBUS_STOP_BITS, 10) : undefined),
    };
  }

  /**
   * Get OPC-UA protocol adapter configuration
   * 
   * Fallback: Cloud config → Environment variables
   */
  getOPCUAConfig(): OPCUAConfig {
    const cloud = this.getTargetConfig().protocolAdapters?.opcua;
    const env = process.env;

    return {
      enabled: cloud?.enabled ?? false,
      discoveryUrls: cloud?.discoveryUrls || (env.OPCUA_DISCOVERY_URLS 
        ? env.OPCUA_DISCOVERY_URLS.split(',').map(u => u.trim()).filter(u => u) 
        : undefined)
    };
  }

  /**
   * Get SNMP protocol adapter configuration
   * 
   * Fallback: Cloud config → Environment variables
   */
  getSNMPConfig(): SNMPConfig {
    const cloud = this.getTargetConfig().protocolAdapters?.snmp;
    const env = process.env;

    return {
      enabled: cloud?.enabled ?? false,
      ipRanges: cloud?.ipRanges || (env.SNMP_IP_RANGES 
        ? env.SNMP_IP_RANGES.split(',').map(r => r.trim()).filter(r => r) 
        : undefined),
      port: cloud?.port ?? (env.SNMP_PORT ? parseInt(env.SNMP_PORT, 10) : undefined),
    };
  }

  /**
   * Get performance settings (memory monitoring)
   * 
   * Fallback: Cloud config → Environment variables
   */
  getPerformanceConfig(): PerformanceConfig {
    const cloud = this.getTargetConfig();
    const env = process.env;

    return {
      memoryCheckIntervalMs: cloud.memoryCheckIntervalMs ?? (env.MEMORY_CHECK_INTERVAL_MS 
        ? parseInt(env.MEMORY_CHECK_INTERVAL_MS, 10) 
        : undefined),
      memoryThresholdMb: cloud.memoryThresholdMb ?? (env.MEMORY_THRESHOLD_MB 
        ? parseInt(env.MEMORY_THRESHOLD_MB, 10) 
        : undefined),
    };
  }

  /**
   * Get logging configuration
   * 
   * Fallback: Cloud config → Environment variables
   */
  getLoggingConfig(): LoggingConfig {
    const cloud = this.getTargetConfig();
    const env = process.env;

    return {
      logMaxAge: cloud.logMaxAge ?? (env.LOG_MAX_AGE 
        ? parseInt(env.LOG_MAX_AGE, 10) 
        : undefined),
      maxLogFileSize: cloud.maxLogFileSize ?? (env.MAX_LOG_FILE_SIZE 
        ? parseInt(env.MAX_LOG_FILE_SIZE, 10) 
        : undefined),
      maxLogs: cloud.maxLogs ?? (env.MAX_LOGS 
        ? parseInt(env.MAX_LOGS, 10) 
        : undefined),
      enableFilePersistence: cloud.logging?.enableFilePersistence ?? (env.LOG_FILE_PERSISTANCE === 'true'),
      enableCompression: cloud.logging?.enableCompression ?? (env.LOG_COMPRESSION === 'true'),
    };
  }

  /**
   * Get feature toggles
   * 
   * Fallback: Cloud config → Environment variables
   */
  getFeatures(): FeatureToggles {
    const cloud = this.getTargetConfig().features;
    const env = process.env;

    return {
      enableProtocolAdapters: cloud?.enableProtocolAdapters ?? (env.ENABLE_PROTOCOL_ADAPTERS === 'true'),
      enableSensorPublish: cloud?.enableSensorPublish ?? (env.ENABLE_SENSOR_PUBLISH === 'true'),
      enableFirstBootDiscovery: cloud?.enableFirstBootDiscovery ?? (env.ENABLE_FIRST_BOOT_DISCOVERY === 'true'),
      enableAnomalyDetection: cloud?.enableAnomalyDetection ?? (env.ANOMALY_DETECTION_ENABLED === 'true'),
      enableFirewall: cloud?.enableFirewall ?? (env.FIREWALL_ENABLED === 'true'),
    };
  }

  /**
   * Get interval settings for CloudSync and discovery
   * 
   * Controls agent ↔ cloud communication frequency and discovery schedules.
   * 
   * Fallback: Cloud config.intervals → Environment variables → hardcoded defaults
   */
  getIntervalConfig(): IntervalConfig {
    const cloud = this.getTargetConfig().intervals; // Intervals are in dedicated section
    const env = process.env;

    return {
      discoveryFullIntervalMs: cloud?.discoveryFullIntervalMs ?? (env.DISCOVERY_FULL_INTERVAL_MS 
        ? parseInt(env.DISCOVERY_FULL_INTERVAL_MS, 10) 
        : 86400000), // 24 hours default
      discoveryLightIntervalMs: cloud?.discoveryLightIntervalMs ?? (env.DISCOVERY_LIGHT_INTERVAL_MS 
        ? parseInt(env.DISCOVERY_LIGHT_INTERVAL_MS, 10) 
        : 14400000), // 4 hours default
      targetStatePollIntervalMs: cloud?.targetStatePollIntervalMs ?? (env.POLL_INTERVAL_MS 
        ? parseInt(env.POLL_INTERVAL_MS, 10) 
        : 60000), // 60 seconds default
      deviceReportIntervalMs: cloud?.deviceReportIntervalMs ?? (env.REPORT_INTERVAL_MS 
        ? parseInt(env.REPORT_INTERVAL_MS, 10) 
        : 60000), // 60 seconds default
      metricsIntervalMs: cloud?.metricsIntervalMs ?? (env.METRICS_INTERVAL_MS 
        ? parseInt(env.METRICS_INTERVAL_MS, 10) 
        : 300000), // 5 minutes default
      reconciliationIntervalMs: cloud?.reconciliationIntervalMs ?? (env.RECONCILIATION_INTERVAL_MS 
        ? parseInt(env.RECONCILIATION_INTERVAL_MS, 10) 
        : 30000), // 30 seconds default
    };
  }
}
