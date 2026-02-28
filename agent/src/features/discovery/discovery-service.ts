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
import { MqttDiscoveryPlugin, MqttDiscoveryOptions } from './mqtt.discovery';
import { BACnetDiscoveryPlugin } from './bacnet.discovery';
import { autoDetectLocalSubnets } from '../../utils/network';
import type { ConfigManager } from '../../device-manager/config.js';

export type DiscoveryTrigger = 'first_boot' | 'manual' | 'scheduled' | 'config-change';
export type DiscoveryProtocol = 'modbus' | 'opcua' | 'can' | 'snmp' | 'mqtt' | 'bacnet';

export interface DiscoveryOptions {
  trigger: DiscoveryTrigger;
  validate?: boolean; // Run validation phase (slow)
  forceRun?: boolean; // Override rate limiting
  protocols?: Array<DiscoveryProtocol>; // Only run specific protocols (default: all)
  skipDbWrites?: boolean; // Skip saving to database (when reconcile already synced from cloud)
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
  private configManager?: ConfigManager;
  private metadata: DiscoveryMetadata;
  private readonly MIN_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly VALIDATION_CONCURRENCY = 3; // Concurrent validations (avoid overwhelming network/CPU)
  private plugins: Map<string, BaseDiscoveryPlugin>;
  private lightTimer?: NodeJS.Timeout;
  private fullTimer?: NodeJS.Timeout;
  private mqttObserverData?: Array<{
    topic: string;
    firstSeen: Date;
    lastSeen: Date;
    messageCount: number;
    hasLiveMessages: boolean;
    retainedCount: number;
    liveCount: number;
    samplePayload?: string;
  }>; // HYBRID: Observer data from runtime MQTT adapter
  
  // CRITICAL: Cache discovered devices for reconciliation to access
  // When discovery runs with skipDbWrites, the discovered nodes aren't saved to DB
  // But reconciliation needs them when creating new device records
  // Map: endpointUrl → discovered device with data_points
  private discoveredDevicesCache: Map<string, DiscoveredDevice> = new Map();

  /**
   * Create discovery service
   * 
   * IMPORTANT: Call init() after construction to load persisted metadata:
   *   const discovery = new DiscoveryService(logger, configManager);
   *   await discovery.init();
   */
  constructor(logger?: AgentLogger, configManager?: ConfigManager) {
    super();
    this.logger = logger;
    this.configManager = configManager;
    this.metadata = this.loadMetadata();
    this.plugins = this.initializePlugins();
  }

  /**
   * Inject MQTT observer data (hybrid discovery pattern)
   * 
   * Call this before runDiscovery() to provide recently observed topics
   * from the runtime MQTT adapter. This solves the "no data during 30s window"
   * problem for low-frequency publishers.
   * 
   * @param observedTopics - Topics tracked by MQTT adapter during normal operation
   */
  public setMqttObserverData(observedTopics: Array<{
    topic: string;
    firstSeen: Date;
    lastSeen: Date;
    messageCount: number;
    hasLiveMessages: boolean;
    retainedCount: number;
    liveCount: number;
    samplePayload?: string;
  }>): void {
    this.mqttObserverData = observedTopics;
    this.logger?.debugSync(`🔄 DISCOVERY: Injected ${observedTopics.length} observer topics for next MQTT discovery`, {
      component: LogComponents.discovery,
      observerTopics: observedTopics.length,
      topics: observedTopics.map(t => ({ topic: t.topic, liveCount: t.liveCount, lastSeen: t.lastSeen }))
    });
  }

  /**
   * Initialize all discovery plugins
   */
  private initializePlugins(): Map<string, BaseDiscoveryPlugin> {
    const plugins = new Map<string, BaseDiscoveryPlugin>();
    
    plugins.set('modbus', new ModbusDiscoveryPlugin(this.logger, this.configManager));
    plugins.set('opcua', new OPCUADiscoveryPlugin(this.logger, this.configManager));
    plugins.set('can', new CANDiscoveryPlugin(this.logger));
    plugins.set('snmp', new SNMPDiscoveryPlugin(this.logger, this.configManager));
    plugins.set('mqtt', new MqttDiscoveryPlugin(this.logger));
    plugins.set('bacnet', new BACnetDiscoveryPlugin(this.logger));
    
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
      this.logger?.debugSync('Periodic discovery disabled', {
        component: LogComponents.discovery,
      });
      return;
    }
    
    // Stop any existing timers first
    this.stopPeriodicDiscovery();
    
    const intervals = this.configManager?.getIntervalConfig();
    if (!intervals) {
      this.logger?.warnSync('Cannot start periodic discovery - configManager not available', {
        component: LogComponents.discovery,
      });
      return;
    }
    
    this.logger?.debugSync('Starting periodic discovery timers', {
      component: LogComponents.discovery,
      lightIntervalHours: intervals.discoveryLightIntervalMs! / (60 * 60 * 1000),
      fullIntervalHours: intervals.discoveryFullIntervalMs! / (60 * 60 * 1000),
    });
    
    // Light discovery: Fast scan (ping only)
    this.lightTimer = setInterval(() => {
      this.logger?.debugSync('Running scheduled light discovery', {
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
      this.logger?.debugSync('Running scheduled full discovery', {
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
   * Clean up discovery service resources and break reference chains
   * Call this when shutting down or to force garbage collection
   */
  public cleanup(): void {
    this.stopPeriodicDiscovery();
    this.mqttObserverData = undefined;
    this.removeAllListeners(); // Clear EventEmitter listeners
    
    // Note: plugins Map is intentionally NOT cleared - it's needed for service lifetime
    // Only transient data (observer data, listeners) is cleared
  }

  /**
   * Get discovered device data from cache
   * Used by ConfigManager to retrieve data_points for new devices during reconciliation
   * 
   * @param endpointUrl - The OPC UA/Modbus/SNMP endpoint URL
   * @returns Discovered device with data_points, or undefined if not found
   */
  public getDiscoveredDevice(endpointUrl: string): DiscoveredDevice | undefined {
    const device = this.discoveredDevicesCache.get(endpointUrl);
    if (device) {
      this.logger?.debugSync('Retrieved discovered device from cache', {
        component: LogComponents.discovery,
        endpointUrl,
        dataPointsCount: device.dataPoints?.length || 0,
        cacheSize: this.discoveredDevicesCache.size
      });
    }
    return device;
  }

  /**
   * Main entry point: Run discovery with rate limiting
   */
  async runDiscovery(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
    const { trigger, validate = false, forceRun = false, protocols } = options;
    const traceId = crypto.randomUUID();

    this.logger?.infoSync('Discovery runDiscovery called', {
      component: LogComponents.discovery,
      trigger,
      validate,
      forceRun,
      protocols: protocols || 'all'
    });

    // Check rate limiting
    if (!forceRun && !this.shouldRunDiscovery(trigger)) {
      this.logger?.debugSync('Discovery skipped due to rate limiting', {
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
      this.logger?.infoSync('Running device discovery scan with full validation', {
        component: LogComponents.discovery,
        traceId,
        validate,
        protocols: protocols || 'all'
      });
    } else {
      this.logger?.debugSync('Starting discovery', {
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
        
        // Skip protocol if no configuration provided (prevents unwanted network scans)
        if (pluginOptions === undefined) {
          this.logger?.debugSync(`No configuration for ${protocol}, skipping discovery`, {
            component: LogComponents.discovery,
            protocol,
            traceId
          });
          continue;
        }
        
        // MQTT-specific: Log observer suggestions if available
        if (protocol === 'mqtt') {
          this.logMqttObserverSuggestions();
        }
        
        const discovered = await plugin.discover(pluginOptions);
     
        allDiscovered.push(...discovered);

        // Log discovered devices and data info
        if (discovered.length > 0) {
          this.logger?.infoSync(`${protocol.toUpperCase()} found ${discovered.length} device(s)`, {
            component: LogComponents.discovery,
            protocol,
            devices: discovered.map(d => ({
              name: d.name,
              dataPoints: d.dataPoints?.length || 0,
              confidence: d.confidence
            }))
          });
        }

        

        // Log warning if enabled protocol found zero devices (helps catch simulator/server issues)
        if (discovered.length === 0) {
          this.logger?.warnSync(`${protocol.toUpperCase()} discovery found 0 devices`, {
            component: LogComponents.discovery,
            protocol,
            note: `Check if ${protocol} server/devices are running and reachable`,
            config: JSON.stringify(pluginOptions)
          });
        }

        // Phase 2: Validation (optional)
        if (validate && discovered.length > 0) {
          this.logger?.debugSync(`Validating ${discovered.length} ${protocol} devices`, {
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

                // Check data point validation results (Modbus-specific)
                if (validationData.dataPointValidation) {
                  const pv = validationData.dataPointValidation;
                  
                  if (pv.result === 'config_mismatch') {
                    this.logger?.warnSync(`⚠️  Data point config mismatch detected for ${device.name}`, {
                      component: LogComponents.discovery,
                      traceId,
                      slaveId: device.metadata?.slaveId,
                      result: pv.result,
                      responseConfidence: pv.responseConfidence.toFixed(2),
                      dataConfidence: pv.dataConfidence.toFixed(2),
                      readableCount: pv.readableCount,
                      errorCount: pv.errorCount,
                      details: pv.details,
                      guidance: pv.guidance || 'Check profile configuration in dashboard',
                      meiVendor: pv.meiVendor,
                      meiModel: pv.meiModel
                    });
                  }
                  
                  // Update validation results in database (for both new and existing devices)
                  try {
                    await DeviceEndpointModel.update(device.name, {
                      metadata: {
                        ...device.metadata,
                        dataPointValidation: pv,
                        validated: true,
                        confidence: device.confidence
                      }
                    });
                    this.logger?.debugSync(`Updated validation results for ${device.name}`, {
                      component: LogComponents.discovery,
                      result: pv.result,
                      state: pv.state
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

    this.logger?.debugSync(`Discovery complete: ${allDiscovered.length} devices found`, {
      component: LogComponents.discovery,
      traceId,
      duration,
      validated: validate,
      protocols: selectedProtocols,
      deviceNames: allDiscovered.map(d => d.name)
    });

    // Save to database
    // skipDbWrites: true = update existing records only, don't create new
    // skipDbWrites: false = full save (create + update)
    const saveResults = await this.saveToDatabase(allDiscovered, traceId, options.skipDbWrites || false);

    // CRITICAL: Cache discovered devices for reconciliation to access
    // When skipDbWrites is true, new devices don't get saved to DB yet
    // But reconciliation needs the discovered data_points when creating records
		for (const device of allDiscovered) {
			const endpointUrl = device.connection?.endpointUrl || device.metadata?.endpointUrl;
			if (endpointUrl) {
				this.discoveredDevicesCache.set(endpointUrl, device);
			}
		}
		
		this.logger?.debugSync('Cached discovered devices for reconciliation', {
			component: LogComponents.discovery,
			traceId,
			cachedCount: this.discoveredDevicesCache.size
		});

    if (options.skipDbWrites) {
      this.logger?.debugSync('Discovery in update-only mode (reconcile creates records)', {
        component: LogComponents.discovery,
        traceId,
        devicesValidated: allDiscovered.length,
        updatedCount: saveResults.saved,
        skippedCount: saveResults.skipped,
        protocols: selectedProtocols,
        cachedDevices: this.discoveredDevicesCache.size
      });
    }

    // Update metadata
    this.updateMetadata(trigger, validate);

    // Emit discovery-complete event (triggers sensor publish reload on first boot)
    this.emit('discovery-complete', {
      trigger,
      validate,
      deviceCount: allDiscovered.length,
      savedCount: saveResults.saved,
      skippedCount: saveResults.skipped,
      traceId
    });

    // Clear observer data after use to prevent memory accumulation
    this.mqttObserverData = undefined;

    // Return discovered devices to caller
    return allDiscovered;
  }

  /**
   * Check if discovery should run based on trigger and last run time
   */
  private shouldRunDiscovery(trigger: DiscoveryTrigger): boolean {
    // Always run on first boot, manual trigger, or scheduled discovery
    // Scheduled discoveries have their own timers, so trust them
    if (trigger === 'first_boot' || trigger === 'manual' || trigger === 'scheduled') {
      return true;
    }

    // For other triggers (if any), check interval
    if (!this.metadata.lastDiscoveryAt) {
      return true; // Never run before
    }

    const timeSinceLastDiscovery = Date.now() - this.metadata.lastDiscoveryAt.getTime();
    return timeSinceLastDiscovery >= this.MIN_DISCOVERY_INTERVAL_MS;
  }

  /**
   * Get list of enabled protocols from agent configuration
   * If no config available, returns all available protocols
   */
  private getEnabledProtocols(): DiscoveryProtocol[] {
    if (!this.configManager) {
      // No config available, return all protocols
      return Array.from(this.plugins.keys()) as DiscoveryProtocol[];
    }

    const enabledProtocols: DiscoveryProtocol[] = [];

    // Check Modbus
    const modbusConfig = this.configManager.getModbusConfig();
    if (modbusConfig.enabled) {
      enabledProtocols.push('modbus');
    }

    // Check OPC-UA
    const opcuaConfig = this.configManager.getOPCUAConfig();
    if (opcuaConfig.enabled) {
      enabledProtocols.push('opcua');
    }

    // Check SNMP
    const snmpConfig = this.configManager.getSNMPConfig();
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
   * 
   * Default behavior: Save devices as DISABLED (DISCOVERY_SAVE_DISABLED=true by default)
   * This prevents OOM from loading all devices at once during startup.
   * Set DISCOVERY_SAVE_DISABLED=false to restore old behavior (auto-enable discovered devices).
   */
  private isProtocolEnabled(protocol: string): boolean {
    // Default: Save all discovered devices as disabled
    
    if (!this.configManager) {
      // No config available, default to enabled
      return true;
    }

    switch (protocol) {
      case 'modbus':
        return this.configManager.getModbusConfig().enabled ?? false;
      case 'opcua':
        return this.configManager.getOPCUAConfig().enabled ?? false;
      case 'snmp':
        return this.configManager.getSNMPConfig().enabled ?? false;
      case 'bacnet':
        return this.configManager.getBACnetConfig().enabled ?? false;
      case 'can':
        // TODO: Add getCANConfig() when available
        return !!process.env.CAN_INTERFACE;
      case 'mqtt':
        // MQTT is enabled if broker URL is configured
        return !!(process.env.MQTT_BROKER_URL || 'mqtt://mosquitto:1883');
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
      case 'mqtt':
        return this.getMqttOptions();
      case 'bacnet':
        return this.getBACnetOptions();
      default:
        return undefined;
    }
  }

  /**
   * Get Modbus discovery options from configuration
   * Returns empty object to let plugin query discovery targets dynamically
   */
  private getModbusOptions(): ModbusDiscoveryOptions | undefined {
    if (!this.configManager) {
      return undefined;
    }

    // Return empty object - plugin will query getDiscoveryTargets() for dynamic targets
    // This allows discovery to run when endpoints are added via cloud config
    return {};
  }

  /**
   * Get OPC-UA discovery options from configuration
   * Returns empty object to let plugin query discovery targets dynamically
   */
  private getOPCUAOptions(): OPCUADiscoveryOptions | undefined {
    if (!this.configManager) {
      return undefined;
    }

    // Return empty object - plugin will query getDiscoveryTargets() for dynamic targets
    // This allows discovery to run when endpoints are added via cloud config
    return {};
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
   * Returns empty object to let plugin query discovery targets dynamically
   */
  private getSNMPOptions(): SNMPDiscoveryOptions | undefined {
    if (!this.configManager) {
      return undefined;
    }

    // Return empty object - plugin will query getDiscoveryTargets() for dynamic targets
    // This allows discovery to run when endpoints are added via cloud config
    return {};
  }

  /**
   * Get MQTT discovery options from configuration
   * Uses ConfigManager if available, otherwise falls back to direct env reads
   */
  private getMqttOptions(): MqttDiscoveryOptions | undefined {
    // Use config accessor if available (cloud → env fallback)
    if (this.configManager) {
      const config = this.configManager.getMqttConfig();
      
      // MQTT not enabled or no broker URL
      if (!config.enabled || !config.brokerUrl) {
        return undefined;
      }

      const options: MqttDiscoveryOptions = {
        brokerUrl: config.brokerUrl,
        topics: []  // Will be populated below
      };

      // Optional authentication
      if (config.username) {
        options.username = config.username;
      }

      if (config.password) {
        options.password = config.password;
      }

      // Topics to validate (renamed from discoveryRoots for simplified model)
      if (config.discoveryRoots && config.discoveryRoots.length > 0) {
        options.topics = config.discoveryRoots;
      }

      // Sampling duration (renamed from monitorDurationMs)
      if (config.monitorDurationMs) {
        options.samplingDurationMs = config.monitorDurationMs;
      }

      // QoS
      if (config.qos !== undefined) {
        options.qos = config.qos;
      }
      
      // Observer data no longer used - discoveryRoots handle subscriptions

      return options;
    }

    // Legacy: Direct env var reads (backward compatibility)
    const brokerUrl = process.env.MQTT_BROKER_URL;
    
    if (!brokerUrl) {
      return undefined; // Use plugin defaults
    }

    const options: MqttDiscoveryOptions = { 
      brokerUrl,
      topics: []  // Will be populated below
    };

    // Optional authentication
    if (process.env.MQTT_USERNAME) {
      options.username = process.env.MQTT_USERNAME;
    }

    if (process.env.MQTT_PASSWORD) {
      options.password = process.env.MQTT_PASSWORD;
    }

    // Topics to validate (from env var - JSON array)
    // Example: MQTT_DISCOVERY_ROOTS='["edge/device01/temperature","devices/sensor/data"]'
    if (process.env.MQTT_DISCOVERY_ROOTS) {
      try {
        options.topics = JSON.parse(process.env.MQTT_DISCOVERY_ROOTS);
      } catch (err) {
        this.logger?.warnSync(
          `Failed to parse MQTT_DISCOVERY_ROOTS - expected JSON array (e.g., ["topic1", "topic2"]): ${(err as Error).message}`,
          { component: LogComponents.discovery }
        );
      }
    }

    if (process.env.MQTT_DISCOVERY_DURATION_MS) {
      options.samplingDurationMs = parseInt(process.env.MQTT_DISCOVERY_DURATION_MS, 10);
    }

    if (process.env.MQTT_DISCOVERY_QOS) {
      options.qos = parseInt(process.env.MQTT_DISCOVERY_QOS, 10) as 0 | 1 | 2;
    }
    
    // Observer data no longer used - discoveryRoots handle subscriptions

    return options;
  }

  /**
   * Get BACnet discovery options from configuration
   */
  private getBACnetOptions(): any {
    if (!this.configManager) {
      return undefined;
    }

    const config = this.configManager.getBACnetConfig();
    
    // BACnet not enabled
    if (!config.enabled) {
      return undefined;
    }

    // Return configuration for BACnet discovery
    // discoveryTargets: Unicast mode (preferred for Docker/containers)
    // broadcastAddress: undefined allows plugin to auto-detect subnet broadcast
    return {
      ...(config.discoveryTargets && config.discoveryTargets.length > 0 && { discoveryTargets: config.discoveryTargets }),
      ...(config.broadcastAddress && { broadcastAddress: config.broadcastAddress }),
      port: config.port || 47808,
      timeout: config.timeout || 5000,
      maxDevices: config.maxDevices || 100
    };
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
  private async saveToDatabase(discovered: DiscoveredDevice[], traceId: string, updateOnly: boolean = false): Promise<{ saved: number; skipped: number }> {
    if (discovered.length === 0) {
      this.logger?.debugSync('No discovered endpoints to save', {
        component: LogComponents.discovery,
        traceId
      });
      return { saved: 0, skipped: 0 };
    }
    
    if (updateOnly) {
      this.logger?.debugSync('Discovery running in update-only mode', {
        component: LogComponents.discovery,
        traceId,
        discoveredCount: discovered.length,
        mode: 'update-existing-only'
      });
    }


    // Fetch existing sensors ONCE before loop (avoid O(N²) performance)
    const existingSensors = await DeviceEndpointModel.getAll();

    const targetEndpoints = this.configManager?.getTargetConfig().endpoints || [];
    const targetEndpointByName = new Map(
      targetEndpoints.map((endpoint: any) => [endpoint.name, endpoint])
    );

    this.logger?.infoSync('Checking for existing endpoints in database', {
      component: LogComponents.discovery,
      existingCount: existingSensors.length,
      discoveredCount: discovered.length,
      existingNames: existingSensors.map(s => s.name)
    });

    let saved = 0;
    let skipped = 0;
    const savedDevices: Array<{ name: string; protocol: string; confidence: string }> = [];
    const skippedDevices: Array<{ name: string; protocol: string; reason: string }> = [];

    for (const sensor of discovered) {
      try {
        // Check if sensor already exists by fingerprint OR name OR endpointUrl (OPC UA)
        // Fingerprint match: Same device (even if moved)
        // Name match: Device rediscovered (fingerprint may change due to dynamic register values)
        // EndpointUrl match (OPC UA): Custom-named device at same endpoint (e.g., "MyPLC" at opc.tcp://10.0.0.60:4840)
        const existingByFingerprint = existingSensors.find(s => 
          s.metadata?.fingerprint === sensor.fingerprint
        );
        const existingByName = existingSensors.find(s => 
          s.name === sensor.name
        );
        const existingByEndpointUrl = sensor.protocol === 'opcua' 
          ? existingSensors.find(s => 
              s.protocol === 'opcua' && 
              s.connection?.endpointUrl === sensor.connection?.endpointUrl
            )
          : undefined;
        
        const existing = existingByFingerprint || existingByName || existingByEndpointUrl;
        
        if (existing) {
          // Log match type for debugging
          const matchType = existingByFingerprint ? 'fingerprint' : 
                           existingByName ? 'name' : 
                           existingByEndpointUrl ? 'endpointUrl' : 'unknown';
          if (matchType === 'endpointUrl') {
            this.logger?.infoSync(`Matched discovered device to existing by endpointUrl`, {
              component: LogComponents.discovery,
              traceId,
              existingName: existing.name,
              discoveredName: sensor.name,
              endpointUrl: sensor.connection?.endpointUrl,
              willUpdate: true
            });
          }
          
          // Check if config changed
          const configChanged = JSON.stringify(existing.connection) !== JSON.stringify(sensor.connection);
          const fingerprintChanged = existing.metadata?.fingerprint !== sensor.fingerprint;
          // Treat undefined profile as "Generic" (backward compatibility)
          const existingProfile = existing.metadata?.profile || 'Generic';
          const newProfile = sensor.metadata?.profile || 'Generic';
          const profileChanged = existingProfile !== newProfile;
          
          // CRITICAL: Also check if data points changed (profile same, but points different)
          const dataPointsChanged = JSON.stringify(existing.data_points) !== JSON.stringify(sensor.dataPoints);
          
          // DEBUG: Log configuration comparison (profile is metadata only, not operationally used)
          this.logger?.debugSync(`Configuration comparison for "${sensor.name}"`, {
            component: LogComponents.discovery,
            traceId,
            configChanged: profileChanged || dataPointsChanged,
            dataPointsCount: sensor.dataPoints?.length || 0,
            dataPointsChanged
          });
          
          if (profileChanged || dataPointsChanged) {
            // CRITICAL: Profile or data points changed - must update and revalidate
            const reason = profileChanged ? 'Profile changed' : 'Data points changed (same profile)';
            this.logger?.warnSync(`${reason} for "${existing.name}" - updating configuration`, {
              component: LogComponents.discovery,
              traceId,
              existingName: existing.name,
              discoveredName: sensor.name,
              oldProfile: existingProfile,
              newProfile: newProfile,
              oldDataPoints: existing.data_points?.length || 0,
              newDataPoints: sensor.dataPoints?.length || 0,
              profileChanged,
              dataPointsChanged
            });
            
            // Log discovered dataPoints before saving
            this.logger?.infoSync(`Updating device with discovered nodes`, {
              component: LogComponents.discovery,
              traceId,
              deviceName: existing.name,
              protocol: sensor.protocol,
              dataPointsCount: sensor.dataPoints?.length || 0,
              sampleNodes: sensor.dataPoints?.slice(0, 3).map(dp => ({
                nodeId: dp.nodeId,
                name: dp.name || dp.address
              }))
            });
            
            // Update device with new profile config and data points
            await DeviceEndpointModel.update(existing.name, {
              data_points: sensor.dataPoints || [],
              metadata: {
                ...existing.metadata,
                // Clear old validation data - will be revalidated
                dataPointValidation: undefined
              },
              lastSeenAt: new Date()
            });
            
            // Verify the update was successful
            this.logger?.infoSync(`Database update complete`, {
              component: LogComponents.discovery,
              traceId,
              deviceName: existing.name,
              updatedDataPoints: sensor.dataPoints?.length || 0,
              operation: 'DeviceEndpointModel.update'
            });
            
            // Read back from database to verify persistence
            const updatedDevice = await DeviceEndpointModel.getByName(existing.name);
            if (updatedDevice) {
              this.logger?.infoSync(`Verified data persisted to database`, {
                component: LogComponents.discovery,
                traceId,
                deviceName: existing.name,
                persistedDataPoints: updatedDevice.data_points?.length || 0,
                samplePersistedNodes: updatedDevice.data_points?.slice(0, 3).map(dp => ({
                  nodeId: dp.nodeId,
                  name: dp.name || dp.address
                }))
              });
            } else {
              this.logger?.errorSync(`Failed to verify database update - device not found`, new Error('Device not found after update'), {
                component: LogComponents.discovery,
                traceId,
                deviceName: existing.name
              });
            }
            
            // CRITICAL: Force Sensor Publish to reload endpoints (profile changed)
            // This ensures polling uses the new COMAP addresses immediately
            if (existing.enabled) {
              this.emit('endpoint-enabled', {
                protocol: sensor.protocol,
                endpoint: {
                  ...existing,
                  data_points: sensor.dataPoints || [],
                  metadata: {
                    ...existing.metadata,
                    profile: sensor.metadata?.profile
                  }
                },
                isBatchDiscovery: !!traceId,
                profileChanged: true // Flag to indicate this is a profile change
              });
            }
            
            saved++; // Count as saved (updated)
            savedDevices.push({
              name: existing.name, // Use existing name, not auto-generated one
              protocol: sensor.protocol,
              confidence: sensor.confidence || 'updated'
            });
            continue; // Move to next device (don't fall through to create)
            
          } else {
            // No profile change - just update lastSeenAt and skip
            await DeviceEndpointModel.updateLastSeen(sensor.fingerprint);
            
            if (configChanged) {
              this.logger?.debugSync(`Device "${sensor.name}" moved/reconfigured`, {
                component: LogComponents.discovery,
                traceId,
                oldConnection: existing.connection,
                newConnection: sensor.connection
              });
            } else if (fingerprintChanged) {
              this.logger?.debugSync(`Device "${sensor.name}" fingerprint changed (dynamic data)`, {
                component: LogComponents.discovery,
                traceId,
                oldFingerprint: existing.metadata?.fingerprint,
                newFingerprint: sensor.fingerprint
              });
            } else {
              this.logger?.debugSync(`Device "${sensor.name}" already known - skipping`, {
                component: LogComponents.discovery,
                traceId,
                protocol: sensor.protocol,
                lastSeen: existing.lastSeenAt
              });
            }
            skipped++;
            skippedDevices.push({
              name: sensor.name,
              protocol: sensor.protocol,
              reason: configChanged ? 'moved' : (fingerprintChanged ? 'fingerprint_changed' : 'already_exists')
            });
            continue;
          }
        }

        // When updateOnly mode is enabled, skip creating new devices
        // Reconcile is responsible for creating records from cloud sync
        if (updateOnly) {
          this.logger?.debugSync(`Skipping new device creation (update-only mode)`, {
            component: LogComponents.discovery,
            traceId,
            deviceName: sensor.name,
            protocol: sensor.protocol,
            endpointUrl: sensor.connection?.endpointUrl,
            reason: 'reconcile-creates-records'
          });
          skipped++;
          skippedDevices.push({
            name: sensor.name,
            protocol: sensor.protocol,
            reason: 'update_only_mode'
          });
          continue;
        }

        // Convert to DeviceEndpoint format and save
        // Get enabled state from parent connection (if available)
        let endpointEnabled = false;
        const targetEndpoint = sensor.metadata?.connectionName
          ? targetEndpointByName.get(sensor.metadata.connectionName)
          : targetEndpointByName.get(sensor.name);

        if (targetEndpoint?.enabled !== undefined) {
          endpointEnabled = Boolean(targetEndpoint.enabled);
        } else if (sensor.metadata?.connectionName && this.configManager) {
          const modbusConfig = this.configManager.getModbusConfig();
          const parentConn = modbusConfig.connections?.find(c => c.name === sensor.metadata?.connectionName);
          endpointEnabled = parentConn?.enabled ?? false;
        }

        const deviceSensor: DeviceEndpoint = {
          name: sensor.name,
          protocol: sensor.protocol as 'modbus' | 'can' | 'opcua' | 'mqtt',
          enabled: endpointEnabled, // Inherit enabled state from parent connection
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
            // Track parent discovery target for automatic cleanup
            // API will delete the parent when this discovered device arrives
            ...(targetEndpoint?.id && { discoveryParentId: targetEndpoint.id }),
            // Include validation data (manufacturer, model, firmware, capabilities)
            ...(sensor.validationData && {
              manufacturer: sensor.validationData.manufacturer,
              modelNumber: sensor.validationData.modelNumber,
              firmwareVersion: sensor.validationData.firmwareVersion,
              capabilities: sensor.validationData.capabilities,
              deviceInfo: sensor.validationData.deviceInfo,
              // Data point validation results (Modbus)
              dataPointValidation: sensor.validationData.dataPointValidation
            })
          }
        };

        // Log parent ID tracking for debugging
        if (targetEndpoint?.id) {
          this.logger?.infoSync(`Discovered device linked to parent`, {
            component: LogComponents.discovery,
            traceId,
            deviceName: sensor.name,
            parentId: targetEndpoint.id,
            parentName: targetEndpoint.name,
            connectionName: sensor.metadata?.connectionName
          });
        } else {
          this.logger?.warnSync(`Discovered device has no parent tracking - parent endpoint not found`, {
            component: LogComponents.discovery,
            traceId,
            deviceName: sensor.name,
            protocol: sensor.protocol,
            connectionName: sensor.metadata?.connectionName,
            availableTargetEndpoints: Array.from(targetEndpointByName.entries()).map(([name, ep]: [string, any]) => ({
              name,
              id: ep?.id,
              protocol: ep?.protocol
            }))
          });
        }

        await DeviceEndpointModel.create(deviceSensor);
        saved++;
        savedDevices.push({
          name: sensor.name,
          protocol: sensor.protocol,
          confidence: sensor.confidence || 'unknown'
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

    // Log single summary with all discovered devices
    this.logger?.debugSync(
      `Discovery complete: ${saved} new, ${skipped} existing`,
      {
        component: LogComponents.discovery,
        traceId,
        saved: savedDevices.length > 0 ? savedDevices : undefined,
        skipped: skippedDevices.length > 0 ? skippedDevices : undefined,
      }
    );

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

  /**
   * Log MQTT observer suggestions (hybrid discovery pattern)
   * 
   * The MQTT adapter continuously tracks observed topics during normal operation.
   * This provides "free" discovery suggestions without dedicated 30s scan windows.
   * 
   * Hybrid Pattern:
   * 1. Runtime observation: Adapter tracks all topics seen (bounded, LRU)
   * 2. Active discovery: User-triggered 30s sampling window
   * 3. Deferred validation: Per-topic validation after discovery
   * 
   * This bridges continuous awareness with discrete discovery snapshots.
   */
  private logMqttObserverSuggestions(): void {
    // Log observer stats if data was injected
    if (this.mqttObserverData && this.mqttObserverData.length > 0) {
      const liveTopics = this.mqttObserverData.filter(t => t.hasLiveMessages).length;
      const retainedOnly = this.mqttObserverData.length - liveTopics;
      
      this.logger?.debugSync(`MQTT Observer: ${this.mqttObserverData.length} topics tracked (${liveTopics} with live messages)`, {
        component: LogComponents.discovery,
        totalObserved: this.mqttObserverData.length,
        liveTopics,
        retainedOnlyTopics: retainedOnly,
        recentTopics: this.mqttObserverData.slice(0, 10).map(t => ({
          topic: t.topic,
          lastSeen: t.lastSeen,
          liveCount: t.liveCount
        }))
      });
    } else {
      this.logger?.debugSync('MQTT Observer: No observer data available (adapter may not be started yet)', {
        component: LogComponents.discovery,
        note: 'Observer tracks topics during runtime - run discovery after MQTT adapter starts'
      });
    }
  }
}
