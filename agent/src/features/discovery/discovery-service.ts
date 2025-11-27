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
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import { DeviceSensorModel, DeviceSensor } from '../../db/models/sensors.model';
import { MetadataModel } from '../../db/models';
import type { BaseDiscoveryPlugin, DiscoveredDevice } from './base.discovery';
import { ModbusDiscoveryPlugin } from './modbus.discovery';
import { OPCUADiscoveryPlugin } from './opcua.discovery';
import { CANDiscoveryPlugin } from './can.discovery';
import { SNMPDiscoveryPlugin } from './snmp.discovery';

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

export class DiscoveryService {
  private logger?: AgentLogger;
  private metadata: DiscoveryMetadata;
  private readonly MIN_DISCOVERY_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  private readonly VALIDATION_CONCURRENCY = 3; // Concurrent validations (avoid overwhelming network/CPU)
  private plugins: Map<string, BaseDiscoveryPlugin>;

  /**
   * Create discovery service
   * 
   * IMPORTANT: Call init() after construction to load persisted metadata:
   *   const discovery = new DiscoveryService(logger);
   *   await discovery.init();
   */
  constructor(logger?: AgentLogger) {
    this.logger = logger;
    this.metadata = this.loadMetadata();
    this.plugins = this.initializePlugins();
  }

  /**
   * Initialize all discovery plugins
   */
  private initializePlugins(): Map<string, BaseDiscoveryPlugin> {
    const plugins = new Map<string, BaseDiscoveryPlugin>();
    
    plugins.set('modbus', new ModbusDiscoveryPlugin(this.logger));
    plugins.set('opcua', new OPCUADiscoveryPlugin(this.logger));
    plugins.set('can', new CANDiscoveryPlugin(this.logger));
    plugins.set('snmp', new SNMPDiscoveryPlugin(this.logger));
    
    return plugins;
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
        component: LogComponents.agent,
        traceId,
        trigger,
        lastDiscoveryAt: this.metadata.lastDiscoveryAt,
        minIntervalMs: this.MIN_DISCOVERY_INTERVAL_MS
      });
      return [];
    }

    this.logger?.infoSync('Starting discovery', {
      component: LogComponents.agent,
      traceId,
      trigger,
      validate,
      forceRun,
      protocols: protocols || 'all'
    });

    const startTime = Date.now();

    // Filter plugins by requested protocols
    const selectedProtocols = protocols || Array.from(this.plugins.keys());
    const allDiscovered: DiscoveredDevice[] = [];

    // Run discovery on each plugin
    for (const protocol of selectedProtocols) {
      const plugin = this.plugins.get(protocol);
      if (!plugin) {
        this.logger?.warnSync(`Unknown protocol: ${protocol}`, {
          component: LogComponents.agent,
          traceId
        });
        continue;
      }

      // Check if plugin is available on this platform
      if (!(await plugin.isAvailable())) {
        this.logger?.debugSync(`Plugin ${protocol} not available`, {
          component: LogComponents.agent,
          traceId
        });
        continue;
      }

      try {
        // Phase 1: Discovery
        // Build protocol-specific options from environment variables
        const pluginOptions = this.getPluginOptions(protocol);
        const discovered = await plugin.discover(pluginOptions);
        allDiscovered.push(...discovered);

        // Phase 2: Validation (optional)
        if (validate && discovered.length > 0) {
          this.logger?.infoSync(`Validating ${discovered.length} ${protocol} devices`, {
            component: LogComponents.agent,
            traceId,
            protocol,
            phase: 'validation',
            concurrency: this.VALIDATION_CONCURRENCY
          });

          // Concurrent validation with pooling to avoid overwhelming resources
          const { default: pLimit } = await import('p-limit');
          const limit = pLimit(this.VALIDATION_CONCURRENCY);
          
          await Promise.all(discovered.map(device => 
            limit(async () => {
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
                }
              } catch (error) {
                this.logger?.warnSync(`Validation failed for ${device.name}`, {
                  component: LogComponents.agent,
                  traceId,
                  error: (error as Error).message
                });
              }
            })
          ));
        }
      } catch (error) {
        this.logger?.errorSync(
          `Discovery failed for protocol ${protocol}`,
          error as Error,
          { component: LogComponents.agent, traceId }
        );
      }
    }

    const duration = Date.now() - startTime;

    this.logger?.infoSync(`Discovery complete: ${allDiscovered.length} devices found`, {
      component: LogComponents.agent,
      traceId,
      duration,
      validated: validate,
      protocols: selectedProtocols
    });

    // Save to database
    await this.saveToDatabase(allDiscovered, traceId);

    // Update metadata
    this.updateMetadata(trigger, validate);

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
   * Get Modbus discovery options from environment
   */
  private getModbusOptions(): ModbusDiscoveryOptions | undefined {
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
   * Get OPC-UA discovery options from environment
   */
  private getOPCUAOptions(): OPCUADiscoveryOptions | undefined {
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
   * Get SNMP discovery options from environment
   */
  private getSNMPOptions(): SNMPDiscoveryOptions | undefined {
    const ipRanges = process.env.SNMP_IP_RANGES;
    
    if (!ipRanges) {
      return undefined; // Use plugin defaults (auto-detect local network)
    }

    const options: SNMPDiscoveryOptions = {
      ipRanges: ipRanges.split(',').map(r => r.trim())
    };

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
        component: LogComponents.agent,
        metadata: this.metadata
      });
    } catch (error) {
      this.logger?.warnSync('Failed to load discovery metadata, using defaults', {
        component: LogComponents.agent,
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
        component: LogComponents.agent,
        trigger,
        validated,
        discoveryCount: this.metadata.discoveryCount
      });
    } catch (error) {
      this.logger?.warnSync('Failed to persist discovery metadata', {
        component: LogComponents.agent,
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
      this.logger?.infoSync('No discovered sensors to save', {
        component: LogComponents.agent,
        traceId
      });
      return { saved: 0, skipped: 0 };
    }

    this.logger?.infoSync(`Saving ${discovered.length} discovered sensors to database`, {
      component: LogComponents.agent,
      traceId,
      operation: 'saveToDatabase'
    });

    // Fetch existing sensors ONCE before loop (avoid O(N²) performance)
    const existingSensors = await DeviceSensorModel.getAll();

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
          // Device already known - update lastSeenAt
          await DeviceSensorModel.updateLastSeen(sensor.fingerprint);
          
          // Check if config changed
          const configChanged = JSON.stringify(existing.connection) !== JSON.stringify(sensor.connection);
          const fingerprintChanged = existing.metadata?.fingerprint !== sensor.fingerprint;
          
          if (configChanged) {
            this.logger?.infoSync(`Device "${sensor.name}" moved/reconfigured`, {
              component: LogComponents.agent,
              traceId,
              oldConnection: existing.connection,
              newConnection: sensor.connection
            });
            // Could update connection here if desired
          } else if (fingerprintChanged) {
            this.logger?.debugSync(`Device "${sensor.name}" fingerprint changed (dynamic data)`, {
              component: LogComponents.agent,
              traceId,
              oldFingerprint: existing.metadata?.fingerprint,
              newFingerprint: sensor.fingerprint
            });
          } else {
            this.logger?.debugSync(`Device "${sensor.name}" already known`, {
              component: LogComponents.agent,
              traceId
            });
          }
          skipped++;
          continue;
        }

        // Convert to DeviceSensor format and save
        const deviceSensor: DeviceSensor = {
          name: sensor.name,
          protocol: sensor.protocol as 'modbus' | 'can' | 'opcua',
          enabled: false, // IMPORTANT: Disabled by default, user must enable
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
              deviceInfo: sensor.validationData.deviceInfo
            })
          }
        };

        await DeviceSensorModel.create(deviceSensor);
        saved++;

        this.logger?.infoSync(`Saved discovered sensor "${sensor.name}" (${sensor.protocol})`, {
          component: LogComponents.agent,
          traceId,
          confidence: sensor.confidence
        });
      } catch (error) {
        this.logger?.errorSync(
          `Failed to save sensor "${sensor.name}"`,
          error as Error,
          { component: LogComponents.agent, traceId }
        );
      }
    }

    this.logger?.infoSync(`Discovery save complete: ${saved} saved, ${skipped} skipped`, {
      component: LogComponents.agent,
      traceId
    });

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
      const staleDevices = await DeviceSensorModel.getStaleDevices(daysThreshold);
      
      if (staleDevices.length > 0) {
        this.logger?.warnSync(`Found ${staleDevices.length} stale devices (not seen in ${daysThreshold}+ days)`, {
          component: LogComponents.agent,
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
        component: LogComponents.agent,
        traceId,
        error: (error as Error).message
      });
    }
  }
}
