/**
 * Protocol Discovery Service
 * 
 * Auto-discovers sensors on Modbus, CAN, OPC-UA networks
 * Saves discovered devices directly to SQLite sensors table
 * 
 * Discovery is RATE-LIMITED to avoid slow operations:
 * - First boot: Full discovery with validation
 * - Manual trigger: Full discovery with validation
 * - Scheduled: Light discovery (ping only, no validation)
 * - Min interval: 1 hour between automatic discoveries
 * 
 * Two-Phase Architecture:
 * Phase 1 (Discovery): Fast scan to detect responding devices
 * Phase 2 (Validation): Optional deep inspection (slow, reads device info)
 * 
 * Usage:
 *   const discovery = new DiscoveryService(logger);
 *   
 *   // Manual full discovery
 *   await discovery.runDiscovery({ trigger: 'manual', validate: true });
 *   
 *   // Scheduled light discovery
 *   await discovery.runDiscovery({ trigger: 'scheduled', validate: false });
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { DeviceEndpointModel, DeviceEndpoint } from '../../db/models/endpoint.model';
import { MetadataModel } from '../../db/models';
import type { BaseDiscoveryPlugin, DiscoveredDevice } from './base.discovery';
import { ModbusDiscoveryPlugin } from './modbus.discovery';
import { OPCUADiscoveryPlugin } from './opcua.discovery';
import { CANDiscoveryPlugin } from './can.discovery';
import { SNMPDiscoveryPlugin } from './snmp.discovery';
import { autoDetectLocalSubnets } from '../../utils/network';
import type { AgentConfig } from '../../config/agent-config.js';

export type DiscoveryTrigger = 'first_boot' | 'manual' | 'scheduled';
export type DiscoveryProtocol = 'modbus' | 'opcua' | 'can' | 'snmp';

export interface DiscoveryOptions {
  trigger: DiscoveryTrigger;
  validate?: boolean; // Run validation phase (slow)
  forceRun?: boolean; // Override rate limiting
  protocols?: Array<DiscoveryProtocol>; // Only run specific protocols (default: all)
}

// Re-export for convenience
export type { DiscoveredDevice } from './base.discovery';

export interface DiscoveryMetadata {
  lastDiscoveryAt?: Date;
  lastFullDiscoveryAt?: Date; // With validation
  lastLightDiscoveryAt?: Date; // Ping only
  discoveryCount: number;
  lastTrigger?: DiscoveryTrigger;
}

export interface ModbusDiscoveryOptions {
  serialPort?: string; // e.g., '/dev/ttyUSB0' or 'COM3'
  tcpHost?: string;    // e.g., '192.168.1.100'
  tcpPort?: number;    // Default: 502
  slaveIdRange?: [number, number]; // Default: [1, 247]
  timeout?: number;    // ms per scan (discovery phase)
  baudRate?: number;   // Serial baud rate (default: 9600)
  validate?: boolean;  // Run validation phase (slower, reads device info)
  validationTimeout?: number; // ms per device validation
}

export interface OPCUADiscoveryOptions {
  discoveryUrls?: string[]; // e.g., ['opc.tcp://localhost:4840']
  scanForServers?: boolean; // Use LDS (Local Discovery Server)
  validate?: boolean; // Run validation phase (read ServerInfo, browse nodes)
  validationTimeout?: number; // ms per server validation
}

export interface CANDiscoveryOptions {
  interface?: string; // e.g., 'can0', 'vcan0'
  listenDuration?: number; // ms to listen for CAN messages (discovery phase)
  validate?: boolean; // Run validation phase (pattern analysis, heuristics)
  validationDuration?: number; // ms to collect messages for validation
}

export interface SNMPDiscoveryOptions {
  ipRanges?: string[];      // e.g., ['192.168.1.0/24', '10.0.0.1-10.0.0.50']
  port?: number;            // Default: 161
  community?: string;       // SNMPv1/v2c community (default: 'public')
  version?: 'v1' | 'v2c' | 'v3'; // SNMP version (default: 'v2c')
  timeout?: number;         // ms per device scan (default: 2000)
  retries?: number;         // Retry count (default: 1)
  concurrency?: number;     // Concurrent scans (default: 10)
  validate?: boolean;       // Run validation phase (read device info)
  validationTimeout?: number; // ms per device validation
  // SNMPv3 options (if version='v3')
  v3Username?: string;
  v3AuthProtocol?: 'MD5' | 'SHA';
  v3AuthKey?: string;
  v3PrivProtocol?: 'DES' | 'AES';
  v3PrivKey?: string;
}

/**
 * Discovery Service
 * Coordinates protocol-specific discovery plugins
 * 
 * Events:
 * - 'discovery-complete': Emitted after discovery completes and saves to database
 *   Payload: { trigger: DiscoveryTrigger, validate: boolean, deviceCount: number, traceId: string }
 * - 'endpoint-enabled': Emitted when a new enabled endpoint is saved to database
 *   Payload: { protocol: string, endpoint: DeviceEndpoint }
 */
export class DiscoveryService extends EventEmitter {
  private logger?: AgentLogger;
  private agentConfig?: AgentConfig;
  private metadata: DiscoveryMetadata;
  private readonly MIN_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly VALIDATION_CONCURRENCY = 3; // Concurrent validations (avoid overwhelming network/CPU)
  private plugins: Map<string, BaseDiscoveryPlugin>;
  private lightTimer?: NodeJS.Timeout;
  private fullTimer?: NodeJS.Timeout;

  /**
   * Create discovery service
   * 
   * IMPORTANT: Call init() after construction to load persisted metadata:
   *   const discovery = new DiscoveryService(logger, agentConfig);
   *   await discovery.init();
   */
  constructor(logger?: AgentLogger, agentConfig?: AgentConfig) {
    super();
    this.logger = logger;
    this.agentConfig = agentConfig;
    this.metadata = this.loadMetadata();
    this.plugins = this.initializePlugins();
  }

  /**
   * Initialize all discovery plugins
   */
  private initializePlugins(): Map<string, BaseDiscoveryPlugin> {
    const plugins = new Map<string, BaseDiscoveryPlugin>();
    
    plugins.set('modbus', new ModbusDiscoveryPlugin(this.logger, this.agentConfig));
    plugins.set('opcua', new OPCUADiscoveryPlugin(this.logger));
    plugins.set('can', new CANDiscoveryPlugin(this.logger));
    plugins.set('snmp', new SNMPDiscoveryPlugin(this.logger));
    
    return plugins;
  }

  /**
   * Start periodic discovery timers
   * - Light discovery: Fast scan (ping only) every 4 hours (default)
   * - Full discovery: Deep validation every 24 hours (default)
   */
  public startPeriodicDiscovery(): void {
    const enablePeriodicDiscovery = process.env.ENABLE_PERIODIC_DISCOVERY !== 'false'; // Default: enabled
    
    if (!enablePeriodicDiscovery) {
      this.logger?.infoSync('Periodic discovery disabled', {
        component: LogComponents.discovery,
      });
      return;
    }
    
    // Stop any existing timers first
    this.stopPeriodicDiscovery();
    
    const intervals = this.agentConfig?.getIntervalConfig();
    if (!intervals) {
      this.logger?.warnSync('Cannot start periodic discovery - agentConfig not available', {
        component: LogComponents.discovery,
      });
      return;
    }
    
    this.logger?.infoSync('Starting periodic discovery timers', {
      component: LogComponents.discovery,
      lightIntervalHours: intervals.discoveryLightIntervalMs! / (60 * 60 * 1000),
      fullIntervalHours: intervals.discoveryFullIntervalMs! / (60 * 60 * 1000),
    });
    
    // Light discovery: Fast scan (ping only)
    this.lightTimer = setInterval(() => {
      this.logger?.infoSync('Running scheduled light discovery', {
        component: LogComponents.discovery,
      });
      
      this.runDiscovery({
        trigger: 'scheduled',
        validate: false, // Ping only, no deep validation
      }).catch(error => {
        this.logger?.errorSync(
          'Scheduled light discovery failed',
          error as Error,
          { component: LogComponents.discovery }
        );
      });
    }, intervals.discoveryLightIntervalMs!);
    
    // Full discovery: Deep validation with device info reads
    this.fullTimer = setInterval(() => {
      this.logger?.infoSync('Running scheduled full discovery', {
        component: LogComponents.discovery,
      });
      
      this.runDiscovery({
        trigger: 'scheduled',
        validate: true, // Full validation with device info
      }).catch(error => {
        this.logger?.errorSync(
          'Scheduled full discovery failed',
          error as Error,
          { component: LogComponents.discovery }
        );
      });
    }, intervals.discoveryFullIntervalMs!);
  }

  /**
   * Stop periodic discovery timers
   */
  public stopPeriodicDiscovery(): void {
    if (this.lightTimer) {
      clearInterval(this.lightTimer);
      this.lightTimer = undefined;
    }
    if (this.fullTimer) {
      clearInterval(this.fullTimer);
      this.fullTimer = undefined;
    }
  }

  /**
   * Main entry point: Run discovery with rate limiting
   */
  async runDiscovery(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
    const { trigger, validate = false, forceRun = false, protocols } = options;
    const traceId = crypto.randomUUID();

    // Check rate limiting
    if (!forceRun && !this.shouldRunDiscovery(trigger)) {
      this.logger?.infoSync('Discovery skipped due to rate limiting', {
        component: LogComponents.discovery,
        traceId,
        trigger,
        lastDiscoveryAt: this.metadata.lastDiscoveryAt,
        minIntervalMs: this.MIN_DISCOVERY_INTERVAL_MS
      });
      return [];
    }

    // Log special message for first boot discovery
    if (trigger === 'first_boot') {
      this.logger?.infoSync('FIRST BOOT DISCOVERY: Running comprehensive device discovery scan with full validation', {
        component: LogComponents.discovery,
        traceId,
        validate,
        protocols: protocols || 'all'
      });
    } else {
      this.logger?.infoSync('Starting discovery', {
        component: LogComponents.discovery,
        traceId,
        trigger,
        validate,
        forceRun,
        protocols: protocols || 'all'
      });
    }

    const startTime = Date.now();

    // Filter plugins by requested protocols
    const selectedProtocols = protocols || Array.from(this.plugins.keys());
    const allDiscovered: DiscoveredDevice[] = [];

    // Run discovery on each plugin
    for (const protocol of selectedProtocols) {
      const plugin = this.plugins.get(protocol);
      if (!plugin) {
        this.logger?.warnSync(`Unknown protocol: ${protocol}`, {
          component: LogComponents.discovery,
          traceId
        });
        continue;
      }

      // Check if plugin is available on this platform
      if (!(await plugin.isAvailable())) {
        this.logger?.debugSync(`Plugin ${protocol} not available`, {
          component: LogComponents.discovery,
          traceId
        });
        continue;
      }

      try {
        // Phase 1: Discovery
        // Build protocol-specific options from environment variables
        const pluginOptions = this.getPluginOptions(protocol);
        const discovered = await plugin.discover(pluginOptions);
        
        this.logger?.infoSync(`${protocol} plugin returned ${discovered.length} devices`, {
          component: LogComponents.discovery,
          traceId,
          protocol,
          deviceCount: discovered.length
        });
        
        allDiscovered.push(...discovered);

        // Phase 2: Validation (optional)
        if (validate && discovered.length > 0) {
          this.logger?.infoSync(`Validating ${discovered.length} ${protocol} devices`, {
            component: LogComponents.discovery,
            traceId,
            protocol,
            phase: 'validation'
          });

          // Sequential validation for clean logging (slaves appear in order)
          for (const device of discovered) {
            try {
              const validationData = await plugin.validate(device);
              if (validationData) {
                device.validated = true;
                device.validationData = validationData;
                device.confidence = 'high';

                // Update name if manufacturer/model detected
                if (validationData.manufacturer || validationData.modelNumber) {
                  device.name = `${validationData.manufacturer || protocol}_${validationData.modelNumber || device.name}`.toLowerCase().replace(/\s+/g, '_');
                }

                // Check vendor validation results (Modbus-specific)
                if (validationData.vendorValidation) {
                  const vv = validationData.vendorValidation;
                  
                  if (vv.result === 'vendor_mismatch') {
                    this.logger?.warnSync(`⚠️  Vendor mismatch detected for ${device.name}`, {
                      component: LogComponents.discovery,
                      traceId,
                      slaveId: device.metadata?.slaveId,
                      result: vv.result,
                      responseConfidence: vv.responseConfidence.toFixed(2),
                      dataConfidence: vv.dataConfidence.toFixed(2),
                      readableCount: vv.readableCount,
                      errorCount: vv.errorCount,
                      details: vv.details,
                      guidance: vv.guidance || 'Check vendor configuration in dashboard',
                      meiVendor: vv.meiVendor,
                      meiModel: vv.meiModel
                    });
                  }
                  
                  // Update validation results in database (for both new and existing devices)
                  try {
                    await DeviceEndpointModel.update(device.name, {
                      metadata: {
                        ...device.metadata,
                        vendorValidation: vv,
                        validated: true,
                        confidence: device.confidence
                      }
                    });
                    this.logger?.debugSync(`Updated validation results for ${device.name}`, {
                      component: LogComponents.discovery,
                      result: vv.result,
                      state: vv.state
                    });
                  } catch (updateError) {
                    this.logger?.warnSync(`Failed to update validation results for ${device.name}`, {
                      component: LogComponents.discovery,
                      error: (updateError as Error).message
                    });
                  }
                }
              }
            } catch (error) {
              this.logger?.warnSync(`Validation failed for ${device.name}`, {
                component: LogComponents.discovery,
                traceId,
                error: (error as Error).message
              });
            }
          }
        }
      } catch (error) {
        this.logger?.errorSync(
          `Discovery failed for protocol ${protocol}`,
          error as Error,
          { component: LogComponents.discovery, traceId }
        );
      }
    }

    const duration = Date.now() - startTime;

    this.logger?.infoSync(`Discovery complete: ${allDiscovered.length} devices found`, {
      component: LogComponents.discovery,
      traceId,
      duration,
      validated: validate,
      protocols: selectedProtocols,
      deviceNames: allDiscovered.map(d => d.name)
    });

    // Save to database
    await this.saveToDatabase(allDiscovered, traceId);

    // Update metadata
    this.updateMetadata(trigger, validate);

    // Emit discovery-complete event (triggers sensor publish reload on first boot)
    this.emit('discovery-complete', {
      trigger,
      validate,
      deviceCount: allDiscovered.length,
      traceId
    });

    return allDiscovered;
  }

  /**
   * Check if discovery should run based on trigger and last run time
   */
  private shouldRunDiscovery(trigger: DiscoveryTrigger): boolean {
    // Always run on first boot or manual trigger
    if (trigger === 'first_boot' || trigger === 'manual') {
      return true;
    }

    // For scheduled discovery, check interval
    if (trigger === 'scheduled') {
      if (!this.metadata.lastDiscoveryAt) {
        return true; // Never run before
      }

      const timeSinceLastDiscovery = Date.now() - this.metadata.lastDiscoveryAt.getTime();
      return timeSinceLastDiscovery >= this.MIN_DISCOVERY_INTERVAL_MS;
    }

    return false;
  }

  /**
   * Get list of enabled protocols from agent configuration
   * If no config available, returns all available protocols
   */
  private getEnabledProtocols(): DiscoveryProtocol[] {
    if (!this.agentConfig) {
      // No config available, return all protocols
      return Array.from(this.plugins.keys()) as DiscoveryProtocol[];
    }

    const enabledProtocols: DiscoveryProtocol[] = [];

    // Check Modbus
    const modbusConfig = this.agentConfig.getModbusConfig();
    if (modbusConfig.enabled) {
      enabledProtocols.push('modbus');
    }

    // Check OPC-UA
    const opcuaConfig = this.agentConfig.getOPCUAConfig();
    if (opcuaConfig.enabled) {
      enabledProtocols.push('opcua');
    }

    // Check SNMP
    const snmpConfig = this.agentConfig.getSNMPConfig();
    if (snmpConfig.enabled) {
      enabledProtocols.push('snmp');
    }

    // TODO: Add CAN and COMAP when config methods are available
    // For now, check environment variables directly for these protocols
    if (process.env.CAN_INTERFACE) {
      enabledProtocols.push('can');
    }

    return enabledProtocols;
  }

  /**
   * Check if a specific protocol is enabled in agent configuration
   * Used to set the 'enabled' flag when saving discovered devices
   */
  private isProtocolEnabled(protocol: string): boolean {
    if (!this.agentConfig) {
      // No config available, default to enabled
      return true;
    }

    switch (protocol) {
      case 'modbus':
        return this.agentConfig.getModbusConfig().enabled ?? false;
      case 'opcua':
        return this.agentConfig.getOPCUAConfig().enabled ?? false;
      case 'snmp':
        return this.agentConfig.getSNMPConfig().enabled ?? false;
      case 'can':
        // TODO: Add getCANConfig() when available
        return !!process.env.CAN_INTERFACE;
      default:
        return false;
    }
  }

  /**
   * Get protocol-specific options from environment variables
   */
  private getPluginOptions(protocol: string): any {
    switch (protocol) {
      case 'modbus':
        return this.getModbusOptions();
      case 'opcua':
        return this.getOPCUAOptions();
      case 'can':
        return this.getCANOptions();
      case 'snmp':
        return this.getSNMPOptions();
      default:
        return undefined;
    }
  }

  /**
   * Get Modbus discovery options from configuration
   * Uses AgentConfig if available, otherwise falls back to direct env reads
   */
  private getModbusOptions(): ModbusDiscoveryOptions | undefined {
    // Use config accessor if available (cloud → env fallback)
    if (this.agentConfig) {
      const config = this.agentConfig.getModbusConfig();
      
      // No connection configured
      if (!config.tcpHost && !config.rtuPort) {
        return undefined;
      }

      const options: ModbusDiscoveryOptions = {};

      // TCP configuration
      if (config.tcpHost) {
        options.tcpHost = config.tcpHost;
        options.tcpPort = config.tcpPort ?? 502;
      }

      // Serial/RTU configuration
      if (config.rtuPort) {
        options.serialPort = config.rtuPort;
        options.baudRate = config.rtuBaudRate ?? 9600;
      }

      // Slave ID range
      if (config.slaveRangeStart !== undefined && config.slaveRangeEnd !== undefined) {
        options.slaveIdRange = [config.slaveRangeStart, config.slaveRangeEnd];
      }

      // Timeout
      if (config.timeout !== undefined) {
        options.timeout = config.timeout;
      }

      return options;
    }

    // Legacy: Direct env var reads (backward compatibility)
    const tcpHost = process.env.MODBUS_TCP_HOST;
    const serialPort = process.env.MODBUS_SERIAL_PORT;

    // No connection configured
    if (!tcpHost && !serialPort) {
      return undefined;
    }

    const options: ModbusDiscoveryOptions = {};

    // TCP configuration
    if (tcpHost) {
      options.tcpHost = tcpHost;
      options.tcpPort = process.env.MODBUS_TCP_PORT 
        ? parseInt(process.env.MODBUS_TCP_PORT, 10) 
        : 502;
    }

    // Serial configuration
    if (serialPort) {
      options.serialPort = serialPort;
      options.baudRate = process.env.MODBUS_BAUD_RATE
        ? parseInt(process.env.MODBUS_BAUD_RATE, 10)
        : 9600;
    }

    // Slave ID range
    const rangeStart = process.env.MODBUS_SLAVE_RANGE_START
      ? parseInt(process.env.MODBUS_SLAVE_RANGE_START, 10)
      : 1;
    const rangeEnd = process.env.MODBUS_SLAVE_RANGE_END
      ? parseInt(process.env.MODBUS_SLAVE_RANGE_END, 10)
      : 10;
    options.slaveIdRange = [rangeStart, rangeEnd];

    // Timeout
    if (process.env.MODBUS_TIMEOUT) {
      options.timeout = parseInt(process.env.MODBUS_TIMEOUT, 10);
    }

    return options;
  }

  /**
   * Get OPC-UA discovery options from configuration
   * Uses AgentConfig if available, otherwise falls back to direct env reads
   */
  private getOPCUAOptions(): OPCUADiscoveryOptions | undefined {
    // Use config accessor if available (cloud → env fallback)
    if (this.agentConfig) {
      const config = this.agentConfig.getOPCUAConfig();
      
      if (!config.discoveryUrls || config.discoveryUrls.length === 0) {
        return undefined; // Use plugin defaults
      }

      return {
        discoveryUrls: config.discoveryUrls
      };
    }

    // Legacy: Direct env var reads (backward compatibility)
    const urls = process.env.OPCUA_DISCOVERY_URLS;
    
    if (!urls) {
      return undefined; // Use plugin defaults
    }

    return {
      discoveryUrls: urls.split(',').map(url => url.trim())
    };
  }

  /**
   * Get CAN discovery options from environment
   */
  private getCANOptions(): CANDiscoveryOptions | undefined {
    const canInterface = process.env.CAN_INTERFACE;
    
    if (!canInterface) {
      return undefined; // Use plugin defaults
    }

    return {
      interface: canInterface,
      listenDuration: process.env.CAN_LISTEN_DURATION
        ? parseInt(process.env.CAN_LISTEN_DURATION, 10)
        : undefined
    };
  }

  /**
   * Get SNMP discovery options from configuration
   * Uses AgentConfig if available, otherwise falls back to direct env reads
   */
  private getSNMPOptions(): SNMPDiscoveryOptions | undefined {
    // Use config accessor if available (cloud → env fallback)
    if (this.agentConfig) {
      const config = this.agentConfig.getSNMPConfig();
      
      // CRITICAL: Only run SNMP discovery if explicitly configured
      // Don't auto-detect subnets (causes massive IP scans)
      if (!config.ipRanges || config.ipRanges.length === 0) {
        this.logger?.debugSync('SNMP IP ranges not configured, skipping SNMP discovery', {
          component: LogComponents.discovery,
          note: 'Configure via dashboard or set SNMP_IP_RANGES env var'
        });
        return undefined;
      }

      const options: SNMPDiscoveryOptions = { ipRanges: config.ipRanges };

      // Optional: Port
      if (config.port !== undefined) {
        options.port = config.port;
      }
      
      // Note: SNMPv3 auth not yet in cloud config schema (future enhancement)
      // For now, v3 auth still comes from env vars
      if (process.env.SNMP_COMMUNITY) {
        options.community = process.env.SNMP_COMMUNITY;
      }
      
      if (process.env.SNMP_VERSION) {
        options.version = process.env.SNMP_VERSION as 'v1' | 'v2c' | 'v3';
      }
      
      if (process.env.SNMP_TIMEOUT) {
        options.timeout = parseInt(process.env.SNMP_TIMEOUT, 10);
      }
      
      if (process.env.SNMP_RETRIES) {
        options.retries = parseInt(process.env.SNMP_RETRIES, 10);
      }
      
      if (process.env.SNMP_CONCURRENCY) {
        options.concurrency = parseInt(process.env.SNMP_CONCURRENCY, 10);
      }

      // SNMPv3 authentication (env vars only for now)
      if (options.version === 'v3') {
        options.v3Username = process.env.SNMP_V3_USERNAME;
        options.v3AuthProtocol = process.env.SNMP_V3_AUTH_PROTOCOL as 'MD5' | 'SHA';
        options.v3AuthKey = process.env.SNMP_V3_AUTH_KEY;
        options.v3PrivProtocol = process.env.SNMP_V3_PRIV_PROTOCOL as 'DES' | 'AES';
        options.v3PrivKey = process.env.SNMP_V3_PRIV_KEY;
      }

      return options;
    }

    // Legacy: Direct env var reads (backward compatibility)
    const ipRanges = process.env.SNMP_IP_RANGES;
    
    // CRITICAL: Only run SNMP discovery if explicitly configured
    // Don't auto-detect subnets (causes massive IP scans)
    if (!ipRanges) {
      this.logger?.debugSync('SNMP_IP_RANGES not configured, skipping SNMP discovery', {
        component: LogComponents.discovery,
        note: 'Set SNMP_IP_RANGES env var to enable (e.g., "snmp-simulator-1,192.168.1.100")'
      });
      return undefined;
    }

    const ranges = ipRanges.split(',').map(r => r.trim());
    const options: SNMPDiscoveryOptions = { ipRanges: ranges };

    // Optional: Port, community, version
    if (process.env.SNMP_PORT) {
      options.port = parseInt(process.env.SNMP_PORT, 10);
    }
    
    if (process.env.SNMP_COMMUNITY) {
      options.community = process.env.SNMP_COMMUNITY;
    }
    
    if (process.env.SNMP_VERSION) {
      options.version = process.env.SNMP_VERSION as 'v1' | 'v2c' | 'v3';
    }
    
    if (process.env.SNMP_TIMEOUT) {
      options.timeout = parseInt(process.env.SNMP_TIMEOUT, 10);
    }
    
    if (process.env.SNMP_RETRIES) {
      options.retries = parseInt(process.env.SNMP_RETRIES, 10);
    }
    
    if (process.env.SNMP_CONCURRENCY) {
      options.concurrency = parseInt(process.env.SNMP_CONCURRENCY, 10);
    }

    // SNMPv3 authentication
    if (options.version === 'v3') {
      options.v3Username = process.env.SNMP_V3_USERNAME;
      options.v3AuthProtocol = process.env.SNMP_V3_AUTH_PROTOCOL as 'MD5' | 'SHA';
      options.v3AuthKey = process.env.SNMP_V3_AUTH_KEY;
      options.v3PrivProtocol = process.env.SNMP_V3_PRIV_PROTOCOL as 'DES' | 'AES';
      options.v3PrivKey = process.env.SNMP_V3_PRIV_KEY;
    }

    return options;
  }

  /**
   * Load discovery metadata from persistent storage
   */
  private loadMetadata(): DiscoveryMetadata {
    // Metadata loaded asynchronously in constructor via init()
    return {
      discoveryCount: 0
    };
  }

  /**
   * Initialize metadata from database (async)
   */
  async init(): Promise<void> {
    try {
      const data = await MetadataModel.getByPrefix('discovery.');
      
      this.metadata = {
        lastDiscoveryAt: data['discovery.lastDiscoveryAt'] ? new Date(data['discovery.lastDiscoveryAt']) : undefined,
        lastFullDiscoveryAt: data['discovery.lastFullDiscoveryAt'] ? new Date(data['discovery.lastFullDiscoveryAt']) : undefined,
        lastLightDiscoveryAt: data['discovery.lastLightDiscoveryAt'] ? new Date(data['discovery.lastLightDiscoveryAt']) : undefined,
        discoveryCount: data['discovery.discoveryCount'] ? parseInt(data['discovery.discoveryCount'], 10) : 0,
        lastTrigger: data['discovery.lastTrigger'] as DiscoveryTrigger | undefined
      };

      this.logger?.debugSync('Discovery metadata loaded from database', {
        component: LogComponents.discovery,
        metadata: this.metadata
      });
    } catch (error) {
      this.logger?.warnSync('Failed to load discovery metadata, using defaults', {
        component: LogComponents.discovery,
        error: (error as Error).message
      });
    }
  }

  /**
   * Update discovery metadata after successful run
   */
  private async updateMetadata(trigger: DiscoveryTrigger, validated: boolean): Promise<void> {
    const now = new Date();
    
    this.metadata.lastDiscoveryAt = now;
    this.metadata.lastTrigger = trigger;
    this.metadata.discoveryCount++;

    if (validated) {
      this.metadata.lastFullDiscoveryAt = now;
    } else {
      this.metadata.lastLightDiscoveryAt = now;
    }

    // Persist to SQLite metadata table
    try {
      await MetadataModel.set('discovery.lastDiscoveryAt', now.toISOString());
      await MetadataModel.set('discovery.lastTrigger', trigger);
      await MetadataModel.set('discovery.discoveryCount', this.metadata.discoveryCount.toString());
      
      if (validated) {
        await MetadataModel.set('discovery.lastFullDiscoveryAt', now.toISOString());
      } else {
        await MetadataModel.set('discovery.lastLightDiscoveryAt', now.toISOString());
      }

      this.logger?.debugSync('Discovery metadata persisted', {
        component: LogComponents.discovery,
        trigger,
        validated,
        discoveryCount: this.metadata.discoveryCount
      });
    } catch (error) {
      this.logger?.warnSync('Failed to persist discovery metadata', {
        component: LogComponents.discovery,
        error: (error as Error).message
      });
    }
  }

  /**
   * Get current discovery metadata
   */
  getMetadata(): DiscoveryMetadata {
    return { ...this.metadata };
  }

  /**
   * Save discovered sensors to SQLite with enabled=false
   * Devices are saved with enabled=false so they don't start polling until user approves
   */
  private async saveToDatabase(discovered: DiscoveredDevice[], traceId: string): Promise<{ saved: number; skipped: number }> {
    if (discovered.length === 0) {
      this.logger?.infoSync('No discovered endpoints to save', {
        component: LogComponents.discovery,
        traceId
      });
      return { saved: 0, skipped: 0 };
    }


    // Fetch existing sensors ONCE before loop (avoid O(N²) performance)
    const existingSensors = await DeviceEndpointModel.getAll();

    let saved = 0;
    let skipped = 0;

    for (const sensor of discovered) {
      try {
        // Check if sensor already exists by fingerprint OR name
        // Fingerprint match: Same device (even if moved)
        // Name match: Device rediscovered (fingerprint may change due to dynamic register values)
        const existingByFingerprint = existingSensors.find(s => 
          s.metadata?.fingerprint === sensor.fingerprint
        );
        const existingByName = existingSensors.find(s => 
          s.name === sensor.name
        );
        
        const existing = existingByFingerprint || existingByName;
        
        if (existing) {
          // Check if config changed
          const configChanged = JSON.stringify(existing.connection) !== JSON.stringify(sensor.connection);
          const fingerprintChanged = existing.metadata?.fingerprint !== sensor.fingerprint;
          // Treat undefined vendor as "Generic" (backward compatibility)
          const existingVendor = existing.metadata?.vendor || 'Generic';
          const newVendor = sensor.metadata?.vendor || 'Generic';
          const vendorChanged = existingVendor !== newVendor;
          
          // CRITICAL: Also check if data points changed (vendor same, but points different)
          const dataPointsChanged = JSON.stringify(existing.data_points) !== JSON.stringify(sensor.dataPoints);
          
          // DEBUG: Log vendor and data points comparison
          this.logger?.infoSync(`Vendor comparison for "${sensor.name}"`, {
            component: LogComponents.discovery,
            traceId,
            existingVendor,
            newVendor,
            vendorChanged,
            existingDataPointsCount: existing.data_points?.length || 0,
            newDataPointsCount: sensor.dataPoints?.length || 0,
            dataPointsChanged
          });
          
          if (vendorChanged || dataPointsChanged) {
            // CRITICAL: Vendor or data points changed - must update and revalidate
            const reason = vendorChanged ? 'Vendor changed' : 'Data points changed (same vendor)';
            this.logger?.warnSync(`${reason} for "${sensor.name}" - updating configuration`, {
              component: LogComponents.discovery,
              traceId,
              oldVendor: existingVendor,
              newVendor: newVendor,
              oldDataPoints: existing.data_points?.length || 0,
              newDataPoints: sensor.dataPoints?.length || 0,
              vendorChanged,
              dataPointsChanged
            });
            
            // Update device with new vendor config and data points
            await DeviceEndpointModel.update(existing.name, {
              data_points: sensor.dataPoints || [],
              metadata: {
                ...existing.metadata,
                vendor: sensor.metadata?.vendor,
                // Clear old validation data - will be revalidated
                vendorValidation: undefined
              },
              lastSeenAt: new Date()
            });
            
            // CRITICAL: Force Sensor Publish to reload endpoints (vendor changed)
            // This ensures polling uses the new COMAP addresses immediately
            if (existing.enabled) {
              this.emit('endpoint-enabled', {
                protocol: sensor.protocol,
                endpoint: {
                  ...existing,
                  data_points: sensor.dataPoints || [],
                  metadata: {
                    ...existing.metadata,
                    vendor: sensor.metadata?.vendor
                  }
                },
                isBatchDiscovery: !!traceId,
                vendorChanged: true // Flag to indicate this is a vendor change
              });
            }
            
            saved++; // Count as saved (updated)
            continue; // Move to next device (don't fall through to create)
            
          } else {
            // No vendor change - just update lastSeenAt and skip
            await DeviceEndpointModel.updateLastSeen(sensor.fingerprint);
            
            if (configChanged) {
              this.logger?.infoSync(`Device "${sensor.name}" moved/reconfigured`, {
                component: LogComponents.discovery,
                traceId,
                oldConnection: existing.connection,
                newConnection: sensor.connection
              });
            } else if (fingerprintChanged) {
              this.logger?.infoSync(`Device "${sensor.name}" fingerprint changed (dynamic data)`, {
                component: LogComponents.discovery,
                traceId,
                oldFingerprint: existing.metadata?.fingerprint,
                newFingerprint: sensor.fingerprint
              });
            } else {
              this.logger?.infoSync(`Device "${sensor.name}" already known - skipping`, {
                component: LogComponents.discovery,
                traceId,
                protocol: sensor.protocol,
                lastSeen: existing.lastSeenAt
              });
            }
            skipped++;
            continue;
          }
        }

        // Convert to DeviceEndpoint format and save
        const deviceSensor: DeviceEndpoint = {
          name: sensor.name,
          protocol: sensor.protocol as 'modbus' | 'can' | 'opcua',
          enabled: this.isProtocolEnabled(sensor.protocol), // Check if protocol is enabled in config
          poll_interval: 5000, // Default 5 seconds
          connection: sensor.connection,
          data_points: sensor.dataPoints || [],
          lastSeenAt: new Date(), // Mark as seen now (will be converted to ISO string by model)
          metadata: {
            ...sensor.metadata,
            fingerprint: sensor.fingerprint,
            confidence: sensor.confidence,
            validated: sensor.validated,
            discoveredAt: sensor.discoveredAt,
            // Include validation data (manufacturer, model, firmware, capabilities)
            ...(sensor.validationData && {
              manufacturer: sensor.validationData.manufacturer,
              modelNumber: sensor.validationData.modelNumber,
              firmwareVersion: sensor.validationData.firmwareVersion,
              capabilities: sensor.validationData.capabilities,
              deviceInfo: sensor.validationData.deviceInfo,
              // Vendor validation results (Modbus)
              vendorValidation: sensor.validationData.vendorValidation
            })
          }
        };

        await DeviceEndpointModel.create(deviceSensor);
        saved++;

        this.logger?.infoSync(`Saved discovered sensor "${sensor.name}" (${sensor.protocol})`, {
          component: LogComponents.discovery,
          traceId,
          confidence: sensor.confidence
        });

        // Emit event for enabled endpoints (triggers Sensor Publish reload)
        // During batch discovery, skip individual reloads (discovery-complete will reload all)
        if (deviceSensor.enabled) {
          this.emit('endpoint-enabled', {
            protocol: sensor.protocol,
            endpoint: deviceSensor,
            isBatchDiscovery: !!traceId // If traceId exists, this is from batch discovery
          });
        }
      } catch (error) {
        this.logger?.errorSync(
          `Failed to save sensor "${sensor.name}"`,
          error as Error,
          { component: LogComponents.discovery, traceId }
        );
      }
    }

    // Log detailed skip reasons if devices were skipped
    if (skipped > 0) {
      const skipReasons = discovered
        .filter(d => {
          const existing = existingSensors.find(s => 
            s.metadata?.fingerprint === d.fingerprint || s.name === d.name
          );
          return existing !== undefined;
        })
        .map(d => `${d.name} (${d.protocol})`);
      
      this.logger?.infoSync(`Discovery save complete: ${saved} saved, ${skipped} skipped (already exist)`, {
        component: LogComponents.discovery,
        traceId,
        skippedDevices: skipReasons
      });
    } else {
      this.logger?.infoSync(`Discovery save complete: ${saved} saved, ${skipped} skipped`, {
        component: LogComponents.discovery,
        traceId
      });
    }

    // Check for stale devices (not seen in 7+ days)
    await this.checkStaleDevices(traceId);

    return { saved, skipped };
  }

  /**
   * Check for stale devices and log warnings
   * Industry best practice: NEVER auto-delete, only warn
   */
  private async checkStaleDevices(traceId: string, daysThreshold = 7): Promise<void> {
    try {
      const staleDevices = await DeviceEndpointModel.getStaleDevices(daysThreshold);
      
      if (staleDevices.length > 0) {
        this.logger?.warnSync(`Found ${staleDevices.length} stale devices (not seen in ${daysThreshold}+ days)`, {
          component: LogComponents.discovery,
          traceId,
          staleCount: staleDevices.length,
          devices: staleDevices.map(d => ({
            name: d.name,
            protocol: d.protocol,
            lastSeenAt: d.lastSeenAt,
            fingerprint: d.metadata?.fingerprint
          }))
        });
      }
    } catch (error) {
      this.logger?.debugSync('Failed to check stale devices', {
        component: LogComponents.discovery,
        traceId,
        error: (error as Error).message
      });
    }
  }
}
