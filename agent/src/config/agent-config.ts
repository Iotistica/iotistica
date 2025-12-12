/**
 * Agent Configuration Access Layer
 * 
 * Provides centralized access to agent configuration with three-tier fallback:
 * 1. Cloud Config (from target state) - highest priority (runtime overrides)
 * 2. device.json - baseline defaults (static configuration file)
 * 3. Hardcoded defaults - emergency fallbacks
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
 * Implements cloud → device.json → hardcoded defaults pattern for all agent settings.
 * Extends EventEmitter to react to StateReconciler events and apply changes automatically.
 */
export class AgentConfig extends EventEmitter {
  private stateReconciler: StateReconciler;
  private deviceJsonDefaults: any;
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
    this.deviceJsonDefaults = this.loadDeviceJson();
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
   * Load device.json configuration (one-time on construction)
   * 
   * Priority:
   * 1. DEVICE_CONFIG_PATH environment variable
   * 2. ./config/device.json (relative to agent root)
   * 3. /app/config/device.json (Docker container path)
   */
  private loadDeviceJson(): any {
    const configPath = process.env.DEVICE_CONFIG_PATH 
      || path.join(process.cwd(), 'config', 'device.json')
      || '/app/config/device.json';
    
    try {
      if (fs.existsSync(configPath)) {
        const content = fs.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(content);
        this.logger?.debugSync(`Loaded device.json from ${configPath}`, {
          component: LogComponents.agentConfig,
          configPath
        });
        return parsed;
      } else {
        this.logger?.warnSync(`device.json not found at ${configPath}, using hardcoded defaults`, {
          component: LogComponents.agentConfig,
          configPath
        });
      }
    } catch (error) {
      this.logger?.errorSync(
        `Failed to load device.json from ${configPath}`,
        error as Error,
        { component: LogComponents.agentConfig, configPath }
      );
    }
    
    return {}; // Empty object if file not found or parse error
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
   * Fallback: Cloud config.protocols.modbus → device.json protocols.modbus → hardcoded defaults
   */
  getModbusConfig(): ModbusConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.modbus;
    const deviceProtocol = this.deviceJsonDefaults.protocols?.modbus;

    return {
      enabled: cloudProtocol?.enabled ?? deviceProtocol?.enabled ?? false,
      tcpHost: cloudProtocol?.tcpHost ?? deviceProtocol?.tcpHost ?? 'localhost',
      tcpPort: cloudProtocol?.tcpPort ?? deviceProtocol?.tcpPort ?? 502,
      slaveRangeStart: cloudProtocol?.slaveRangeStart ?? deviceProtocol?.slaveRangeStart ?? 1,
      slaveRangeEnd: cloudProtocol?.slaveRangeEnd ?? deviceProtocol?.slaveRangeEnd ?? 10,
      timeout: cloudProtocol?.timeout ?? deviceProtocol?.timeout ?? 2000,
      vendor: cloudProtocol?.vendor ?? deviceProtocol?.vendor ?? 'Generic',
      // RTU configuration (all optional)
      rtuPort: cloudProtocol?.serialPort ?? deviceProtocol?.serialPort,
      rtuBaudRate: cloudProtocol?.baudRate ?? deviceProtocol?.baudRate ?? 9600,
    };
  }

  /**
   * Get OPC-UA protocol adapter configuration
   * 
   * Fallback: Cloud config.protocols.opcua → device.json protocols.opcua → hardcoded defaults
   */
  getOPCUAConfig(): OPCUAConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.opcua;
    const deviceProtocol = this.deviceJsonDefaults.protocols?.opcua;

    return {
      enabled: cloudProtocol?.enabled ?? deviceProtocol?.enabled ?? false,
      discoveryUrls: cloudProtocol?.discoveryUrls ?? deviceProtocol?.discoveryUrls ?? []
    };
  }

  /**
   * Get SNMP protocol adapter configuration
   * 
   * Fallback: Cloud config.protocols.snmp → device.json protocols.snmp → hardcoded defaults
   */
  getSNMPConfig(): SNMPConfig {
    const cloudProtocol = this.getTargetConfig().protocols?.snmp;
    const deviceProtocol = this.deviceJsonDefaults.protocols?.snmp;

    return {
      enabled: cloudProtocol?.enabled ?? deviceProtocol?.enabled ?? false,
      ipRanges: cloudProtocol?.ipRanges ?? deviceProtocol?.ipRanges ?? [],
      port: cloudProtocol?.port ?? deviceProtocol?.port ?? 161,
    };
  }

  /**
   * Get performance settings (memory monitoring)
   * 
   * Fallback: Cloud config.settings → device.json settings → hardcoded defaults
   */
  getPerformanceConfig(): PerformanceConfig {
    const cloud = this.getTargetConfig().settings;
    const device = this.deviceJsonDefaults.settings;

    return {
      memoryCheckIntervalMs: cloud?.memoryCheckIntervalMs ?? device?.memoryCheckIntervalMs ?? 30000,
      memoryThresholdMb: cloud?.memoryThresholdMb ?? device?.memoryThresholdMb ?? 15,
    };
  }

  /**
   * Get logging configuration
   * 
   * Fallback: Cloud config → device.json → hardcoded defaults
   */
  getLoggingConfig(): LoggingConfig {
    const cloudSettings = this.getTargetConfig().settings;
    const cloudLogging = this.getTargetConfig().logging;
    const deviceSettings = this.deviceJsonDefaults.settings;
    const deviceLogging = this.deviceJsonDefaults.logging;

    return {
      logMaxAge: cloudSettings?.logMaxAge ?? deviceSettings?.logMaxAge ?? 86400000, // 24 hours
      maxLogFileSize: cloudSettings?.maxLogFileSize ?? deviceSettings?.maxLogFileSize ?? 5242880, // 5MB
      maxLogs: cloudSettings?.maxLogs ?? deviceSettings?.maxLogs ?? 1000,
      enableFilePersistence: cloudLogging?.enableFilePersistence ?? deviceLogging?.enableFilePersistence ?? false,
      enableCompression: cloudLogging?.enableCompression ?? deviceLogging?.enableCompression ?? true,
      logBatchSize: cloudLogging?.logBatchSize ?? deviceLogging?.logBatchSize ?? 500,
      logFlushIntervalMs: cloudLogging?.logFlushIntervalMs ?? deviceLogging?.logFlushIntervalMs ?? 30000,
      logDir: process.env.LOG_DIR ?? deviceSettings?.logDir ?? "/app/data/logs",
      logLevel: process.env.LOG_LEVEL ?? deviceLogging?.level ?? "info",
    };
  }

  /**
   * Get feature toggles
   * 
   * Fallback: Cloud config.features → device.json features → hardcoded defaults
   */
  getFeatures(): FeatureToggles {
    const cloud = this.getTargetConfig().features;
    const device = this.deviceJsonDefaults.features;

    return {
      enableSensorPublish: cloud?.enableSensorPublish ?? device?.enableDeviceSensorPublish ?? false,
      enableAnomalyDetection: cloud?.enableAnomalyDetection ?? device?.enableAnomalyDetection ?? false,
    };
  }

  /**
   * Get interval settings for CloudSync and discovery
   * 
   * Controls agent ↔ cloud communication frequency and discovery schedules.
   * 
   * Fallback: Cloud config.intervals → device.json intervals → hardcoded defaults
   */
  getIntervalConfig(): IntervalConfig {
    const cloud = this.getTargetConfig().intervals;
    const device = this.deviceJsonDefaults.intervals;

    return {
      discoveryFullIntervalMs: cloud?.discoveryFullIntervalMs ?? device?.discoveryFullIntervalMs ?? 86400000, // 24 hours
      discoveryLightIntervalMs: cloud?.discoveryLightIntervalMs ?? device?.discoveryLightIntervalMs ?? 14400000, // 4 hours
      targetStatePollIntervalMs: cloud?.targetStatePollIntervalMs ?? device?.targetStatePollIntervalMs ?? 60000, // 1 minute
      deviceReportIntervalMs: cloud?.deviceReportIntervalMs ?? device?.deviceReportIntervalMs ?? 60000, // 1 minute
      metricsIntervalMs: cloud?.metricsIntervalMs ?? device?.metricsIntervalMs ?? 300000, // 5 minutes
      reconciliationIntervalMs: cloud?.reconciliationIntervalMs ?? device?.reconciliationIntervalMs ?? 30000, // 30 seconds
    };
  }

  /**
   * Get cloud API endpoint
   * 
   * Fallback: Environment variable → device.json settings.cloudApiEndpoint → hardcoded default
   * Note: Environment takes priority for deployment-specific overrides (e.g., different cloud regions)
   */
  getCloudApiEndpoint(): string {
    const env = process.env.CLOUD_API_ENDPOINT;
    const device = this.deviceJsonDefaults.settings?.cloudApiEndpoint;
    
    return env ?? device ?? 'http://localhost:4002';
  }

  /**
   * Get device API port (local REST API for device management)
   * 
   * Fallback: Environment variable → device.json settings.deviceApiPort → hardcoded default
   * Note: Environment takes priority for deployment-specific overrides (e.g., port conflicts)
   */
  getDeviceApiPort(): number {
    const env = process.env.DEVICE_API_PORT;
    const device = this.deviceJsonDefaults.settings?.deviceApiPort;
    
    const port = env ? parseInt(env, 10) : device ?? 48484;
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
   * Updates endpoint enabled status in database
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
          case 'modbus':
            shouldBeEnabled = modbusConfig.enabled ?? false;
            break;
          case 'opcua':
            shouldBeEnabled = opcuaConfig.enabled ?? false;
            break;
          case 'snmp':
            shouldBeEnabled = snmpConfig.enabled ?? false;
            break;
          case 'can':
            // TODO: Add getCANConfig() when available
            shouldBeEnabled = !!process.env.CAN_INTERFACE;
            break;
        }

        // Update if status changed
        if (shouldBeEnabled !== undefined && endpoint.enabled !== shouldBeEnabled) {
          await DeviceEndpointModel.update(endpoint.name, { enabled: shouldBeEnabled });
          updatedCount++;

          this.logger?.infoSync(`Updated endpoint "${endpoint.name}" enabled status`, {
            component: LogComponents.agent,
            protocol: endpoint.protocol,
            enabled: shouldBeEnabled,
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
