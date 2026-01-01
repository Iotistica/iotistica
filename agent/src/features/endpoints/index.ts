/**
 * Protocol Adapters Feature
 * 
 * Manages industrial protocol adapters (Modbus, CAN, OPC-UA, etc.)
 * Each adapter reads sensor data and emits 'data' events.
 * SensorsFeature manages SocketServers (one per protocol) and routes
 * data from adapters to their respective sockets for consumption by
 * the sensor-publish system.
 * 
 * Architecture:
 * - Protocol Adapters: Socket-agnostic, emit data events
 * - SensorsFeature: Manages SocketServers, routes adapter data to sockets
 * - Sensor-Publish: Reads from sockets, publishes to MQTT
 */

import { BaseFeature, FeatureConfig } from '../index.js';
import { AgentLogger } from '../../logging/agent-logger.js';
import { ModbusAdapter } from './modbus/adapter.js';
import { ModbusAdapterConfig } from './modbus/types.js';
import { SocketServer } from './common/socket-server.js';
import { SensorDataPoint, SocketOutput } from './types.js';
import { EndpointOutputModel } from '../../db/models/endpoint-outputs.model.js';
import { DeviceEndpointModel } from '../../db/models/endpoint.model.js';

// Type imports only (no runtime loading)
import type { OPCUAAdapter } from './opcua/opcua-adapter.js';
import type { OPCUAAdapterConfig } from './opcua/types.js';

// SNMP imports
import { SNMPAdapter } from './snmp/adapter.js';

export interface SensorConfig extends FeatureConfig {
  modbus?: {
    enabled: boolean;
    config?: ModbusAdapterConfig; // Optional: provide config directly, otherwise load from database
  };
  can?: {
    enabled: boolean;
  };
  opcua?: {
    enabled: boolean;
    config?: OPCUAAdapterConfig; // Optional: provide config directly, otherwise load from database
  };
  snmp?: {
    enabled: boolean;
  };
}

export class SensorsFeature extends BaseFeature {
  private adapters: Map<string, any> = new Map(); // Generic adapter storage
  private socketServers: Map<string, SocketServer> = new Map();

  constructor(
    config: SensorConfig,
    agentLogger: AgentLogger,
    deviceUuid: string
  ) {
    super(config, agentLogger, 'ProtocolAdapters', deviceUuid, false, 'PROTOCOL_ADAPTERS_DEBUG');
  }

  /**
   * Initialize - called by BaseFeature.start() before onStart()
   */
  protected async onInitialize(): Promise<void> {
    // No initialization needed
  }

  /**
   * Start all enabled protocol adapters
   */
  protected async onStart(): Promise<void> {
    // Start Modbus adapter if enabled
    if ((this.config as SensorConfig).modbus?.enabled) {
      await this.startModbusAdapter();
    }

    // Start OPC-UA adapter if enabled
    if ((this.config as SensorConfig).opcua?.enabled) {
      await this.startOPCUAAdapter();
    }

    // Start SNMP adapter if enabled
    if ((this.config as SensorConfig).snmp?.enabled) {
      await this.startSNMPAdapter();
    }

    // TODO: Start CAN adapter when implemented
    if ((this.config as SensorConfig).can?.enabled) {
      this.logger.warn('CAN adapter not yet implemented');
    }

    this.emit('started');
  }

  /**
   * Stop all running protocol adapters and socket servers
   */
  protected async onStop(): Promise<void> {
    // Stop all adapters
    for (const [protocol, adapter] of this.adapters) {
      this.logger.info(`Stopping ${protocol} adapter`);
      if (adapter && typeof adapter.stop === 'function') {
        await adapter.stop();
      }
    }
    this.adapters.clear();

    // Stop all socket servers
    for (const [protocol, server] of this.socketServers) {
      this.logger.info(`Stopping ${protocol} socket server`);
      await server.stop();
    }
    this.socketServers.clear();

    this.emit('stopped');
  }

  /**
   * Start Modbus adapter
   */
  private async startModbusAdapter(): Promise<void> {
    try {
      let modbusConfig: ModbusAdapterConfig;
      let outputConfig: SocketOutput;

      // Load config from provided config object or database
      if (this.config.modbus!.config) {
        // Use provided config
        modbusConfig = this.config.modbus!.config;
      } else {
        // Load devices from database
        const dbDevices = await DeviceEndpointModel.getEnabled('modbus');
        
        // Create config even if no devices (adapter can discover devices)
        modbusConfig = {
          devices: dbDevices.map(d => ({
            name: d.name,
            enabled: d.enabled,
            slaveId: d.connection.slaveId || 1,
            connection: d.connection as any, // Connection config stored in database
            pollInterval: d.poll_interval,
            registers: (d.data_points || []).map((dp: any) => {
              // Convert string type to numeric function code
              let functionCode = dp.functionCode;
              if (!functionCode && dp.type) {
                const typeMap: Record<string, number> = {
                  'coil': 1,           // READ_COILS
                  'discrete': 2,       // READ_DISCRETE_INPUTS
                  'holding': 3,        // READ_HOLDING_REGISTERS
                  'input': 4,          // READ_INPUT_REGISTERS
                };
                functionCode = typeMap[dp.type.toLowerCase()];
              }
              
              return {
                ...dp,
                functionCode,
                dataType: dp.dataType || 'float32',
                count: dp.count || (dp.dataType === 'float32' || dp.dataType === 'int32' || dp.dataType === 'uint32' ? 2 : 1),
                scale: dp.scale !== undefined ? dp.scale : 1,
                offset: dp.offset !== undefined ? dp.offset : 0,
              };
            })
          }) as any), // Type assertion - database stores full ModbusDevice config
          logging: {
            level: 'info',
            enableConsole: false,
            enableFile: false
          }
        };
      }

      // Load output config from database
      const dbOutput = await EndpointOutputModel.getOutput('modbus');
      if (!dbOutput) {
        throw new Error('Modbus output configuration not found in database');
      }
      outputConfig = {
        socketPath: dbOutput.socket_path,
        dataFormat: dbOutput.data_format as 'json' | 'csv',
        delimiter: dbOutput.delimiter,
        includeTimestamp: dbOutput.include_timestamp,
        includeDeviceName: dbOutput.include_device_name
      };

      // Create socket server for Modbus protocol
      const modbusSocket = new SocketServer(outputConfig, this.logger);
      await modbusSocket.start();
      this.socketServers.set('modbus', modbusSocket);
      this.logger.info(`Modbus socket server started at: ${outputConfig.socketPath}`);

      // Create Modbus adapter (socket-agnostic)
      const modbusAdapter = new ModbusAdapter(modbusConfig, this.logger);
      this.adapters.set('modbus', modbusAdapter);

      // Wire up event handlers
      modbusAdapter.on('started', () => {
        this.logger.info('Modbus adapter started');
      });

      modbusAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        modbusSocket.sendData(dataPoints);
      });

      modbusAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`Modbus device connected: ${deviceName}`);
      });

      modbusAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`Modbus device disconnected: ${deviceName}`);
      });

      modbusAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`Modbus device error [${deviceName}]: ${error.message}`);
      });

      // Start adapter
      await modbusAdapter.start();
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start Modbus adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Start OPC-UA adapter
   */
  private async startOPCUAAdapter(): Promise<void> {
    try {
      let opcuaDevices: any[];
      let outputConfig: SocketOutput;

      // Load config from provided config object or database
      if (this.config.opcua!.config) {
        // Use provided config
        opcuaDevices = this.config.opcua!.config.devices;
      } else {
        // Load devices from database
        const dbDevices = await DeviceEndpointModel.getEnabled('opcua');
        
        // Create config even if no devices (adapter can discover devices)
        opcuaDevices = dbDevices.map(d => ({
          name: d.name,
          protocol: 'opcua',
          enabled: d.enabled,
          connection: d.connection,
          pollInterval: d.poll_interval,
          dataPoints: (d.data_points || []).map((dp: any) => ({
            ...dp,
            dataType: dp.dataType || 'number',
            scalingFactor: dp.scalingFactor || dp.scale || 1,
            offset: dp.offset || 0
          })),
          metadata: d.metadata || {}
        }));
      }

      // Load output config from database
      const dbOutput = await EndpointOutputModel.getOutput('opcua');
      if (!dbOutput) {
        throw new Error('OPC-UA output configuration not found in database');
      }
      outputConfig = {
        socketPath: dbOutput.socket_path,
        dataFormat: dbOutput.data_format as 'json' | 'csv',
        delimiter: dbOutput.delimiter,
        includeTimestamp: dbOutput.include_timestamp,
        includeDeviceName: dbOutput.include_device_name
      };

      // Create socket server for OPC-UA protocol
      const opcuaSocket = new SocketServer(outputConfig, this.logger);
      await opcuaSocket.start();
      this.socketServers.set('opcua', opcuaSocket);
      this.logger.info(`OPC-UA socket server started at: ${outputConfig.socketPath}`);

      // Dynamically import OPC-UA adapter (only loads node-opcua-client when needed)
      const { OPCUAAdapter } = await import('./opcua/opcua-adapter.js');
      
      // Create OPC-UA adapter (constructor takes device array, not config object)
      const opcuaAdapter = new OPCUAAdapter(opcuaDevices, this.logger);
      this.adapters.set('opcua', opcuaAdapter);

      // Wire up event handlers
      opcuaAdapter.on('started', () => {
        this.logger.info('OPC-UA adapter started');
      });

      opcuaAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        opcuaSocket.sendData(dataPoints);
      });

      opcuaAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`OPC-UA device connected: ${deviceName}`);
      });

      opcuaAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`OPC-UA device disconnected: ${deviceName}`);
      });

      opcuaAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`OPC-UA device error [${deviceName}]: ${error.message}`);
      });

      // Start adapter
      await opcuaAdapter.start();
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start OPC-UA adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Start SNMP adapter
   */
  private async startSNMPAdapter(): Promise<void> {
    try {
      // Load devices from database
      const dbDevices = await DeviceEndpointModel.getEnabled('snmp');
      
      if (dbDevices.length === 0) {
        this.logger.info('No enabled SNMP devices found');
        return;
      }

      // Load output config from database
      const dbOutput = await EndpointOutputModel.getOutput('snmp');
      if (!dbOutput) {
        this.logger.error('SNMP output configuration not found in database');
        return;
      }

      const outputConfig: SocketOutput = {
        socketPath: dbOutput.socket_path,
        dataFormat: dbOutput.data_format as 'json' | 'csv',
        delimiter: dbOutput.delimiter,
        includeTimestamp: dbOutput.include_timestamp,
        includeDeviceName: dbOutput.include_device_name
      };

      // Create socket server for SNMP protocol
      const snmpSocket = new SocketServer(outputConfig, this.logger);
      await snmpSocket.start();
      this.socketServers.set('snmp', snmpSocket);
      this.logger.info(`SNMP socket server started at: ${outputConfig.socketPath}`);

      // Map database devices to SNMPDeviceConfig format
      const snmpDevices = dbDevices.map(d => ({
        name: d.name,
        protocol: 'snmp' as const,
        enabled: d.enabled,
        connection: d.connection,
        pollInterval: d.poll_interval,
        dataPoints: (d.data_points || []).map((dp: any) => ({
          name: dp.name,
          oid: dp.oid,
          unit: dp.unit || '',
          dataType: dp.dataType || 'integer',
          scalingFactor: dp.scalingFactor || dp.scale,
          offset: dp.offset
        })),
        metadata: d.metadata || {}
      }));

      // Create SNMP adapter (socket-agnostic)
      const snmpAdapter = new SNMPAdapter(snmpDevices, this.logger);
      this.adapters.set('snmp', snmpAdapter);

      // Wire up event handlers
      snmpAdapter.on('started', () => {
        this.logger.info('SNMP adapter started');
      });

      snmpAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        snmpSocket.sendData(dataPoints);
      });

      snmpAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`SNMP device connected: ${deviceName}`);
      });

      snmpAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`SNMP device disconnected: ${deviceName}`);
      });

      snmpAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`SNMP device error [${deviceName}]: ${error.message}`);
      });

      // Start adapter
      await snmpAdapter.start();
      
      this.logger.info(`SNMP adapter started with ${dbDevices.length} device(s)`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start SNMP adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Get Modbus adapter instance (for testing/debugging)
   */
  getModbusAdapter(): ModbusAdapter | undefined {
    return this.adapters.get('modbus') as ModbusAdapter | undefined;
  }

  /**
   * Get OPC-UA adapter instance (for testing/debugging)
   */
  getOPCUAAdapter(): OPCUAAdapter | undefined {
    return this.adapters.get('opcua') as OPCUAAdapter | undefined;
  }

  /**
   * Get SNMP adapter instance (for testing/debugging)
   */
  getSNMPAdapter(): SNMPAdapter | undefined {
    return this.adapters.get('snmp') as SNMPAdapter | undefined;
  }

  /**
   * Get endpoint health from all enabled protocol adapters
   * Returns health data for all configured endpoints (discovered + configured)
   * Works for ANY protocol adapter that implements getDeviceStatuses()
   */
  async getAllDeviceStatuses(): Promise<Record<string, any>> {
    const health: Record<string, any> = {};

    this.logger.debug(`getAllDeviceStatuses called - adapters.size: ${this.adapters.size}, keys: [${Array.from(this.adapters.keys()).join(', ')}]`);

    // Get all sensors directly from database (includes discovered devices)
    try {
      const allSensors = await DeviceEndpointModel.getAll();
      
      this.logger.debug(`Found ${allSensors.length} sensors in database`);
      
      // Build health status for each sensor
      for (const sensor of allSensors) {
        
        // Determine online/offline based on lastSeenAt timestamp
        // Use 24-hour threshold for discovered devices (discovery runs periodically)
        // Adapter overlay will provide real-time status for actively polled devices
        const lastSeen = sensor.lastSeenAt ? new Date(sensor.lastSeenAt) : null;
        const now = Date.now();
        const threshold = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
        const isOnline = lastSeen && (now - lastSeen.getTime()) < threshold;
        
        // Disabled endpoints show as 'disabled' regardless of lastSeen
        // SQLite stores booleans as 0/1, convert to boolean
        const isEnabled = Boolean(sensor.enabled);
        
        health[sensor.name] = {
          protocol: sensor.protocol,
          status: !isEnabled ? 'disabled' : (isOnline ? 'online' : 'offline'),
          connected: isEnabled && isOnline,
          lastPoll: null,
          lastSeen: lastSeen?.toISOString() || null,
          errorCount: 0,
          lastError: null,
          responseTimeMs: null,
          pollSuccessRate: isEnabled && isOnline ? 1.0 : 0,
          registersUpdated: 0,
          communicationQuality: !isEnabled ? ('disabled' as const) : (isOnline ? ('good' as const) : ('offline' as const))
        };
      }
      
      // Now overlay runtime status from adapters (if available)
      for (const [protocol, adapter] of this.adapters) {
        if (adapter && typeof adapter.getDeviceStatuses === 'function') {
          try {
            const statuses = adapter.getDeviceStatuses();
            
            this.logger.debug(`Adapter ${protocol} returned ${statuses?.length || 0} device statuses`);
            
            // Update health with runtime data from adapter
            if (Array.isArray(statuses)) {
              for (const device of statuses) {
                if (health[device.deviceName]) {
                  // Overlay runtime status (preserve status field from database)
                  const currentStatus = health[device.deviceName].status;
                  health[device.deviceName] = {
                    protocol,
                    status: currentStatus, // Preserve status from database
                    connected: device.connected,
                    lastPoll: device.lastPoll?.toISOString() || null,
                    lastSeen: device.lastSeen?.toISOString() || null,
                    errorCount: device.errorCount,
                    lastError: device.lastError,
                    responseTimeMs: device.responseTimeMs,
                    pollSuccessRate: device.pollSuccessRate,
                    registersUpdated: device.registersUpdated,
                    communicationQuality: device.communicationQuality
                  };
                }
              }
            }
          } catch (error) {
            this.logger.warn(`Failed to get device statuses from ${protocol} adapter: ${error}`);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Failed to get sensors from database: ${error}`);
    }

    return health;
  }
}
