/**
 * Agent Configuration Access Layer
 * 
 * Provides centralized access to agent configuration with two-tier fallback:
 * 1. Cloud Config (from target state) - highest priority (runtime overrides)
 * 2. Hardcoded defaults - emergency fallbacks
 * 
 * This is a REACTIVE configuration layer that listens to StateReconciler events
 * and automatically applies configuration changes without Agent intervention.
 * 
 * Usage:
 *   const config = new AgentConfig(stateReconciler);
 *   await config.initialize(agentLogger, deviceManager, ...); // Setup reactive handlers
 *   const modbusHost = config.getModbusConfig().tcpHost;
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { StateReconciler } from '../device-manager/reconciler.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import type { LogLevel } from '../logging/types.js';
import { LogComponents } from '../logging/types.js';

export interface ModbusConnectionConfig {
  name?: string;                    // Connection identifier (e.g., 'gen-502')
  host: string;                     // IP address or hostname
  port: number;                     // Modbus TCP port (default 502)
  enabled?: boolean;                // Connection enabled flag (default: true)
  timeoutMs?: number;               // Connection timeout
  profile?: string;                 // Optional: Override root profile
  addressing?: {                    // Optional: Override root addressing
    slaveRange?: { start: number; end: number; };
  };
  points?: any;                     // Optional: Override root points
}

export interface ModbusConfig {
  enabled: boolean;
  connections?: ModbusConnectionConfig[];  // Multi-connection support (NEW)
  tcpHost?: string;                 // Legacy: Single connection host (optional)
  tcpPort?: number;                 // Legacy: Single connection port (optional)
  slaveRangeStart: number;
  slaveRangeEnd: number;
  timeout: number;
  profile?: string; // Optional: For logging/organization only (not operationally used)
  profileDataPoints?: any[]; // Data points from profile config (pushed via CloudSync)
  // RTU configuration (optional)
  rtuPort?: string;
  rtuBaudRate?: number;
  rtuParity?: string;
  rtuDataBits?: number;
  rtuStopBits?: number;
}

export interface OPCUAConfig {
  enabled?: boolean;
  connections?: string[]; // OPC UA server URLs (formerly discoveryUrls)
  discoveryUrls?: string[]; // @deprecated - use connections
}

export interface SNMPConfig {
  enabled?: boolean;
  /**
   * IP addresses/ranges for SNMP discovery (formerly ipRanges)
   * 
   * IMPORTANT: Always specify explicit IP ranges to prevent network flooding
   * 
   * Supported formats:
   * - Single IP: '192.168.1.100'
   * - CIDR notation: '192.168.1.0/24' (scans 254 IPs - use with caution!)
   * - IP range: '192.168.1.100-192.168.1.110'
   * - Hostname: 'snmp-device.local' (resolved via DNS)
   * - Multiple: ['192.168.1.100', '192.168.1.101', 'device.local']
   * 
   * Examples:
   * - Small network: ['192.168.1.100', '192.168.1.101']
   * - Subnet scan: ['192.168.1.0/24'] (WARNING: scans 254 IPs)
   * - Docker container: ['snmp-simulator-1', 'snmp-simulator-2']
   * 
   * Default: [] (empty - SNMP discovery disabled)
   * Environment variable: SNMP_IP_RANGES (comma-separated)
   */
  connections?: string[];
  ipRanges?: string[]; // @deprecated - use connections
  port?: number;
}

export interface MQTTConfig {
  enabled?: boolean;
  brokerUrl?: string;
  username?: string;
  password?: string;
  discoveryRoots?: string[];
  monitorDurationMs?: number;
  qos?: 0 | 1 | 2;
}

export interface BACnetConfig {
  enabled?: boolean;
  port?: number;
  broadcastAddress?: string;
  timeout?: number;
  maxDevices?: number;
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
  logBatchSize?: number;          // Number of logs per batch upload (default: 100)
  logFlushIntervalMs?: number;    // Milliseconds between log flushes (default: 30000)
  logDir?: string;                // Directory for log file storage (default: /app/data/logs)
  logLevel?: string;              // Log level: debug, info, warn, error (default: info)
}

export interface FeatureToggles {
  enableSensorPublish: boolean;
  enableAnomalyDetection: boolean;
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
 * Agent Configuration Accessor (Reactive)
 * 
 * Implements cloud → hardcoded defaults pattern for all agent settings.
 * Extends EventEmitter to react to StateReconciler events and apply changes automatically.
 */
export class AgentConfig extends EventEmitter {
  private stateReconciler: StateReconciler;
  private logger?: AgentLogger;
  
  // References to agent components (initialized via initialize())
  private containerManager?: any;
  private cloudSync?: any;
  private discoveryLightTimer?: NodeJS.Timeout;
  private discoveryFullTimer?: NodeJS.Timeout;
  private scheduledRestartTimer?: NodeJS.Timeout;
  private discoveryService?: any;

  constructor(stateReconciler: StateReconciler) {
    super();
    this.stateReconciler = stateReconciler;
  }

  /**
   * Initialize reactive configuration layer
   * Sets up event listeners and passes component references for reactive updates
   */
  public initialize(dependencies: {
    logger?: AgentLogger;
    containerManager?: any;
    cloudSync?: any;
    discoveryService?: any;
    discoveryLightTimer?: NodeJS.Timeout;
    discoveryFullTimer?: NodeJS.Timeout;
  }): void {
    this.logger = dependencies.logger;
    this.containerManager = dependencies.containerManager;
    this.cloudSync = dependencies.cloudSync;
    this.discoveryService = dependencies.discoveryService;
    this.discoveryLightTimer = dependencies.discoveryLightTimer;
    this.discoveryFullTimer = dependencies.discoveryFullTimer;

    // Listen to StateReconciler events
    this.stateReconciler.on('logging-config-changed', this.handleLoggingConfigChanges.bind(this));
    this.stateReconciler.on('protocol-config-changed', this.handleProtocolConfigChanges.bind(this));
    this.stateReconciler.on('intervals-changed', this.handleIntervalsChanges.bind(this));
    this.stateReconciler.on('memory-config-changed', this.handleMemoryConfigChanges.bind(this));
    this.stateReconciler.on('scheduled-restart-changed', this.handleScheduledRestartConfig.bind(this));

  }

  /**
   * Get target config from cloud (via StateReconciler)
   */
  private getTargetConfig(): any {
    const state = this.stateReconciler.getTargetState();
    return state?.config || {};
  }

  /**
   * Get Modbus protocol adapter configuration
   * 
   * Supports multiple connection formats:
   * - Legacy: Single connection via connection.host/port or tcpHost/tcpPort
   * - Modern: Multiple connections via connections[] array
   * - Points: V1 (profileDataPoints array) or V2 (points object)
   * 
   * Fallback: Cloud config.protocols.modbus → hardcoded defaults
   */
  getModbusConfig(): ModbusConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.modbus;

    // Transform V2 points object → V1 profileDataPoints array if needed
    let profileDataPoints = cloudProtocol?.profileDataPoints;
    
    // Check if V2 format (points object exists)
    if (cloudProtocol?.points && typeof cloudProtocol.points === 'object') {
      // Transform points object → profileDataPoints array
      profileDataPoints = Object.entries(cloudProtocol.points).map(([name, point]: [string, any]) => ({
        name,
        ...point
      }));
    }

    // V2 format uses connection.host/port, V1 uses tcpHost/tcpPort
    const cloudConnection = cloudProtocol?.connection;
    const cloudAddressing = cloudProtocol?.addressing;
    const cloudConnections = cloudProtocol?.connections;

    // Multi-connection mode: Parse connections[] array
    let connections: ModbusConnectionConfig[] | undefined;
    if (Array.isArray(cloudConnections) && cloudConnections.length > 0) {
      connections = cloudConnections.map((conn: any) => {
        // Per-connection profile resolution
        const connProfile = conn.profile || cloudProtocol?.profile || 'Generic';
        
        // Per-connection points override (connection > root points)
        let connPoints: any[] | undefined;
        if (conn.points && typeof conn.points === 'object') {
          connPoints = Object.entries(conn.points).map(([name, point]: [string, any]) => ({
            name,
            ...point
          }));
        } else if (!conn.points && profileDataPoints) {
          connPoints = profileDataPoints;  // Inherit root points
        }

        return {
          name: conn.name,
          host: conn.host,
          port: conn.port ?? 502,
          enabled: conn.enabled ?? false, // Connection-level enabled flag
          timeoutMs: conn.timeoutMs ?? cloudConnection?.timeoutMs ?? 2000,
          profile: connProfile,
          addressing: conn.addressing,  // Optional override
          points: connPoints
        };
      });
    }

    return {
      enabled: cloudProtocol?.enabled ?? true,
      connections,  // NEW: Multi-connection array
      tcpHost: cloudConnection?.host ?? cloudProtocol?.tcpHost ?? 'localhost',
      tcpPort: cloudConnection?.port ?? cloudProtocol?.tcpPort ?? 502,
      timeout: cloudConnection?.timeoutMs ?? cloudProtocol?.timeout ?? 2000,
      slaveRangeStart: cloudAddressing?.slaveRange?.start ?? cloudProtocol?.slaveRangeStart ?? 1,
      slaveRangeEnd: cloudAddressing?.slaveRange?.end ?? cloudProtocol?.slaveRangeEnd ?? 10,
      profileDataPoints: profileDataPoints,
      // RTU configuration (all optional)
      rtuPort: cloudProtocol?.serialPort,
      rtuBaudRate: cloudProtocol?.baudRate ?? 9600,
    };
  }

  /**
   * Get OPC-UA protocol adapter configuration
   * 
   * Fallback: Cloud config.protocols.opcua → hardcoded defaults
   */
  getOPCUAConfig(): OPCUAConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.opcua;

    return {
      enabled: cloudProtocol?.enabled ?? false,
      connections: cloudProtocol?.connections ?? cloudProtocol?.discoveryUrls ?? [],
      discoveryUrls: cloudProtocol?.discoveryUrls // Keep for backward compatibility
    };
  }

  /**
   * Get SNMP protocol adapter configuration
   * 
   * Fallback: Cloud config.protocols.snmp → hardcoded defaults
   */
  getSNMPConfig(): SNMPConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.snmp;

    return {
      enabled: cloudProtocol?.enabled ?? false,
      connections: cloudProtocol?.connections ?? cloudProtocol?.ipRanges ?? [],
      ipRanges: cloudProtocol?.ipRanges, // Keep for backward compatibility
      port: cloudProtocol?.port ?? 161,
    };
  }

  /**
   * Get MQTT protocol adapter configuration
   * 
   * Fallback: Cloud config.protocols.mqtt → env vars → hardcoded defaults
   */
  getMqttConfig(): MQTTConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.mqtt;

    return {
      enabled: cloudProtocol?.enabled ?? false,
      brokerUrl: cloudProtocol?.connection?.brokerUrl ?? process.env.MQTT_BROKER_URL ?? 'mqtt://mosquitto:1883',
      username: cloudProtocol?.connection?.username ?? process.env.MQTT_USERNAME,
      password: cloudProtocol?.connection?.password ?? process.env.MQTT_PASSWORD,
      discoveryRoots: cloudProtocol?.discoveryRoots ?? [],
      monitorDurationMs: cloudProtocol?.monitorDurationMs ?? 30000,
      qos: (cloudProtocol?.qos ?? 0) as 0 | 1 | 2,
    };
  }

  /**
   * Get BACnet protocol adapter configuration
   * 
   * Fallback: Cloud config.protocols.bacnet → hardcoded defaults
   */
  getBACnetConfig(): BACnetConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.bacnet;

    return {
      enabled: cloudProtocol?.enabled ?? false,
      port: cloudProtocol?.port ?? 47808,
      broadcastAddress: cloudProtocol?.broadcastAddress ?? '255.255.255.255',
      timeout: cloudProtocol?.timeout ?? 5000,
      maxDevices: cloudProtocol?.maxDevices ?? 100,
    };
  }

  /**
   * Get performance settings (memory monitoring)
   * 
   * Supports V2 format (runtime.memory.*) and V1 format (runtime.memory* or settings.memory*)
   * 
   * Fallback: Cloud config.runtime.memory → config.runtime → config.settings → hardcoded defaults
   */
  getPerformanceConfig(): PerformanceConfig {
    const cloudRuntime = this.getTargetConfig().runtime;
    const cloudSettings = this.getTargetConfig().settings;

    // V2 nested memory section support
    const cloudMemory = (cloudRuntime as any)?.memory;

    return {
      memoryCheckIntervalMs: cloudMemory?.checkIntervalMs ?? cloudRuntime?.memoryCheckIntervalMs ?? cloudSettings?.memoryCheckIntervalMs ?? 30000,
      memoryThresholdMb: cloudMemory?.thresholdMb ?? cloudRuntime?.memoryThresholdMb ?? cloudSettings?.memoryThresholdMb ?? 15,
    };
  }

  /**
   * Get logging configuration
   * 
   * Supports V2 format (logging.maxLogs/logMaxAge/maxLogFileSize) and V1 format (settings.*)
   * 
   * Fallback: Cloud config.logging → config.settings → hardcoded defaults
   */
  getLoggingConfig(): LoggingConfig {
    const cloudLogging = this.getTargetConfig().logging;
    const cloudSettings = this.getTargetConfig().settings;

    return {
      // V2: logging.maxLogs, V1: settings.maxLogs
      maxLogs: cloudLogging?.maxLogs ?? cloudSettings?.maxLogs ?? 1000,
      
      // V2: logging.logMaxAge, V1: settings.logMaxAge
      logMaxAge: cloudLogging?.logMaxAge ?? cloudSettings?.logMaxAge ?? 86400000, // 24 hours
      
      // V2: logging.maxLogFileSize, V1: settings.maxLogFileSize
      maxLogFileSize: cloudLogging?.maxLogFileSize ?? cloudSettings?.maxLogFileSize ?? 5242880, // 5MB
      
      // V2: logging.enableFilePersistence, V1: logging.enableFilePersistence (same path)
      enableFilePersistence: cloudLogging?.enableFilePersistence ?? false,
      
      // V2: logging.enableCompression, V1: logging.enableCompression (same path)
      enableCompression: cloudLogging?.enableCompression ?? true,
      
      logBatchSize: cloudLogging?.logBatchSize ?? 500,
      logFlushIntervalMs: cloudLogging?.logFlushIntervalMs ?? 30000,
      logDir: process.env.LOG_DIR ?? cloudSettings?.logDir ?? `${process.env.DATA_DIR || '/app/data'}/logs`,
      
      // Log level: Cloud config → LOG_LEVEL env var → default "info"
      // This allows dynamic log level control via dashboard while supporting env var override
      logLevel: (cloudLogging?.level ?? process.env.LOG_LEVEL ?? "info") as 'error' | 'warn' | 'info' | 'debug',
    };
  }

  /**
   * Get feature toggles
   * 
   * Supports both V2 format (features.enableDeviceSensorPublish) and V1 format (features.enableSensorPublish)
   * 
   * Fallback: Cloud config.features → hardcoded defaults
   */
  getFeatures(): FeatureToggles {
    const cloud = this.getTargetConfig().features;

    return {
      // V2: enableDeviceSensorPublish, V1: enableSensorPublish
      enableSensorPublish: cloud?.enableDeviceSensorPublish ?? cloud?.enableSensorPublish ?? false,
      
      // V2: enableAnomalyDetection, V1: enableAnomalyDetection (same)
      enableAnomalyDetection: cloud?.enableAnomalyDetection ?? false,
    };
  }

  /**
   * Get interval settings for CloudSync and discovery
   * 
   * Controls agent ↔ cloud communication frequency and discovery schedules.
   * 
   * Fallback: Cloud config.intervals → hardcoded defaults
   */
  getIntervalConfig(): IntervalConfig {
    const cloud = this.getTargetConfig().intervals;

    // V2 nested structure support (intervals.device.* and intervals.discovery.*)
    const cloudDevice = (cloud as any)?.device;
    const cloudDiscovery = (cloud as any)?.discovery;

    return {
      // Discovery intervals - check nested first, then flat
      discoveryFullIntervalMs: cloudDiscovery?.fullIntervalMs ?? (cloud as any)?.discoveryFullIntervalMs ?? 86400000, // 24 hours
      discoveryLightIntervalMs: cloudDiscovery?.lightIntervalMs ?? (cloud as any)?.discoveryLightIntervalMs ?? 14400000, // 4 hours
      
      // Device intervals - check nested first, then flat
      targetStatePollIntervalMs: cloudDevice?.targetStatePollIntervalMs ?? (cloud as any)?.targetStatePollIntervalMs ?? 60000, // 1 minute
      deviceReportIntervalMs: cloudDevice?.reportIntervalMs ?? (cloud as any)?.deviceReportIntervalMs ?? 60000, // 1 minute
      metricsIntervalMs: cloudDevice?.metricsIntervalMs ?? (cloud as any)?.metricsIntervalMs ?? 300000, // 5 minutes
      reconciliationIntervalMs: cloudDevice?.reconciliationIntervalMs ?? (cloud as any)?.reconciliationIntervalMs ?? 30000, // 30 seconds
    };
  }

  /**
   * Get cloud API endpoint
   * 
   * Fallback: Environment variable → hardcoded default
   * Note: Environment takes priority for deployment-specific overrides (e.g., different cloud regions)
   */
  getCloudApiEndpoint(): string {
    const env = process.env.CLOUD_API_ENDPOINT;
    
    return env ?? 'http://localhost:4002';
  }

  /**
   * Get device API port (local REST API for device management)
   * 
   * Fallback: Environment variable → hardcoded default
   * Note: Environment takes priority for deployment-specific overrides (e.g., port conflicts)
   */
  getDeviceApiPort(): number {
    const env = process.env.DEVICE_API_PORT;
    
    const port = env ? parseInt(env, 10) : 48484;
    return isNaN(port) ? 48484 : port;
  }

  // ==================== REACTIVE HANDLERS ====================
  // These handlers respond to StateReconciler events and apply config changes

  /**
   * Handle logging configuration changes
   */
  private handleLoggingConfigChanges(change: { old: any; new: any }): void {
    if (!this.logger) {
      return;
    }

    const loggingConfig = this.getLoggingConfig();
    
    // Update log level dynamically (hot-reloadable)
    this.logger.setLogLevel(loggingConfig.logLevel as LogLevel);
    
    this.logger.infoSync('Logging configuration updated from cloud', {
      component: LogComponents.agent,
      logLevel: loggingConfig.logLevel,
      enableFilePersistence: loggingConfig.enableFilePersistence,
      enableCompression: loggingConfig.enableCompression,
      logBatchSize: loggingConfig.logBatchSize,
      logFlushIntervalMs: loggingConfig.logFlushIntervalMs,
    });
  }

  /**
   * Handle protocol configuration changes
   * Updates endpoint enabled status in database based on connection-level enabled flags
   */
  private async handleProtocolConfigChanges(change: { old: any; new: any }): Promise<void> {
    try {
      const { DeviceEndpointModel } = await import('../db/models/endpoint.model.js');
      const endpoints = await DeviceEndpointModel.getAll();

      const modbusConfig = this.getModbusConfig();
      const opcuaConfig = this.getOPCUAConfig();
      const snmpConfig = this.getSNMPConfig();

      let updatedCount = 0;

      for (const endpoint of endpoints) {
        let shouldBeEnabled: boolean | undefined;

        switch (endpoint.protocol) {
          case 'modbus': {
            // Check connection-level enabled flag
            const connectionName = this.getConnectionNameFromEndpoint(endpoint.name);
            const connection = modbusConfig.connections?.find(c => c.name === connectionName);
            shouldBeEnabled = connection?.enabled ?? false;
            break;
          }
          case 'opcua': {
            // OPC UA uses protocol-level enabled (no per-connection enabled yet)
            shouldBeEnabled = opcuaConfig.enabled ?? false;
            break;
          }
          case 'snmp': {
            // SNMP uses protocol-level enabled (no per-connection enabled yet)
            shouldBeEnabled = snmpConfig.enabled ?? false;
            break;
          }
          case 'can':
            // TODO: Add getCANConfig() when available
            shouldBeEnabled = !!process.env.CAN_INTERFACE;
            break;
        }

        // Update if status changed (convert to boolean for comparison since SQLite stores as 0/1)
        if (shouldBeEnabled !== undefined && !!endpoint.enabled !== shouldBeEnabled) {
          await DeviceEndpointModel.update(endpoint.name, { enabled: shouldBeEnabled });
          updatedCount++;

          this.logger?.infoSync(`Updated endpoint "${endpoint.name}" enabled status`, {
            component: LogComponents.agent,
            protocol: endpoint.protocol,
            oldEnabled: !!endpoint.enabled,
            newEnabled: shouldBeEnabled,
          });
        }
      }

      if (updatedCount > 0) {
        this.logger?.infoSync('Protocol configuration changes applied to endpoints', {
          component: LogComponents.agent,
          updatedEndpoints: updatedCount,
        });
      }
    } catch (error) {
      this.logger?.errorSync(
        'Failed to update endpoint enabled status',
        error as Error,
        { component: LogComponents.agent }
      );
    }
  }

  /**
   * Extract connection name from endpoint name
   * Examples:
   *   "modbus-sim-1_slave_2" -> "modbus-sim-1"
   *   "opcua-server-1_node_123" -> "opcua-server-1"
   *   "snmp-host-1" -> "snmp-host-1"
   */
  private getConnectionNameFromEndpoint(endpointName: string): string {
    // Split on underscore and take everything before _slave_, _node_, etc.
    const parts = endpointName.split('_');
    
    // For Modbus: "modbus-sim-1_slave_2" -> "modbus-sim-1"
    // For OPC UA: "opcua-server-1_node_123" -> "opcua-server-1"  
    // For SNMP: "snmp-host-1" -> "snmp-host-1" (no suffix)
    
    // Find index of protocol-specific suffixes
    const suffixIndex = parts.findIndex(part => 
      part === 'slave' || part === 'node' || part === 'oid'
    );
    
    if (suffixIndex !== -1) {
      return parts.slice(0, suffixIndex).join('_');
    }
    
    // No suffix found, return full name
    return endpointName;
  }

  /**
   * Handle intervals configuration changes
   * Restarts discovery timers, reconciliation, and CloudSync with new intervals
   */
  private handleIntervalsChanges(change: { old: any; new: any }): void {
    const intervals = this.getIntervalConfig();

    // Restart discovery timers if changed
    if (this.discoveryService && (this.discoveryLightTimer || this.discoveryFullTimer)) {
      this.logger?.infoSync('Discovery intervals changed, restarting timers', {
        component: LogComponents.agent,
        lightIntervalHours: intervals.discoveryLightIntervalMs! / (60 * 60 * 1000),
        fullIntervalHours: intervals.discoveryFullIntervalMs! / (60 * 60 * 1000),
      });

      // Signal Agent to restart discovery (emit event)
      this.emit('restart-discovery-timers', intervals);
    }

    // Restart reconciliation with new interval
    if (this.containerManager) {
      this.containerManager.stopAutoReconciliation();
      this.containerManager.startAutoReconciliation(intervals.reconciliationIntervalMs!);

      this.logger?.infoSync('Reconciliation interval updated from cloud', {
        component: LogComponents.agent,
        intervalMs: intervals.reconciliationIntervalMs,
        intervalMinutes: intervals.reconciliationIntervalMs! / 60000,
      });
    }

    // Update CloudSync intervals
    if (this.cloudSync) {
      this.cloudSync.updateIntervals({
        pollInterval: intervals.targetStatePollIntervalMs!,
        reportInterval: intervals.deviceReportIntervalMs!,
        metricsInterval: intervals.metricsIntervalMs!,
      });

      this.logger?.infoSync('CloudSync intervals updated from cloud', {
        component: LogComponents.agent,
        pollIntervalMs: intervals.targetStatePollIntervalMs,
        reportIntervalMs: intervals.deviceReportIntervalMs,
        metricsIntervalMs: intervals.metricsIntervalMs,
      });
    }
  }

  /**
   * Handle memory configuration changes
   * Restarts memory monitoring with new threshold and interval
   */
  private handleMemoryConfigChanges(change: { old: any; new: any }): void {
    const performanceConfig = this.getPerformanceConfig();
    const newInterval = performanceConfig.memoryCheckIntervalMs!;
    const newThreshold = performanceConfig.memoryThresholdMb! * 1024 * 1024;

    // Import memory monitoring functions
    import('../system/memory.js').then(({ stopMemoryMonitoring, setMemoryLogger, startMemoryMonitoring }) => {
      // Restart memory monitoring with new settings
      stopMemoryMonitoring();
      
      setMemoryLogger(this.logger);
      startMemoryMonitoring(
        newInterval,
        newThreshold,
        () => {
          this.logger?.errorSync(
            'Memory threshold breached - agent may need restart',
            undefined,
            {
              component: LogComponents.agent,
              thresholdMB: newThreshold / (1024 * 1024),
              action: 'Consider restarting agent or investigating memory leak'
            }
          );
        }
      );

      this.logger?.infoSync('Memory monitoring updated from cloud', {
        component: LogComponents.agent,
        intervalMs: newInterval,
        thresholdMB: newThreshold / (1024 * 1024),
      });
    });
  }

  /**
   * Handle scheduled restart configuration changes
   */
  private handleScheduledRestartConfig(change: { old: any; new: any }): void {
    const restartConfig = change.new;

    // Clear existing timer if present
    if (this.scheduledRestartTimer) {
      clearTimeout(this.scheduledRestartTimer);
      this.scheduledRestartTimer = undefined;
      this.logger?.infoSync("Cleared existing scheduled restart timer", {
        component: LogComponents.agent,
      });
    }

    // Check if scheduled restart is enabled
    if (!restartConfig || !restartConfig.enabled) {
      this.logger?.debugSync("Scheduled restart disabled or not configured", {
        component: LogComponents.agent,
        config: restartConfig || "not set"
      });
      return;
    }

    // Validate configuration
    const intervalDays = parseInt(restartConfig.intervalDays, 10);
    if (isNaN(intervalDays) || intervalDays < 1 || intervalDays > 90) {
      this.logger?.warnSync("Invalid scheduled restart intervalDays, must be 1-90", {
        component: LogComponents.agent,
        providedValue: restartConfig.intervalDays,
        using: "disabled"
      });
      return;
    }

    // Calculate restart time
    const restartTimeMs = intervalDays * 24 * 60 * 60 * 1000;
    const restartAt = new Date(Date.now() + restartTimeMs);

    this.logger?.infoSync("Scheduled restart configured from cloud", {
      component: LogComponents.agent,
      enabled: true,
      intervalDays,
      restartAtISO: restartAt.toISOString(),
      restartAtLocal: restartAt.toLocaleString(),
      reason: restartConfig.reason || "heap_fragmentation_cleanup",
      configSource: "cloud_target_state"
    });

    // Schedule the restart - emit event for Agent to handle
    this.emit('schedule-restart', { restartTimeMs, restartConfig });
  }
}
