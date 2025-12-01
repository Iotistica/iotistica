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
}

export class SensorsFeature extends BaseFeature {
  private modbusAdapter?: ModbusAdapter;
  private opcuaAdapter?: OPCUAAdapter;
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
    // Stop Modbus adapter
    if (this.modbusAdapter) {
      await this.modbusAdapter.stop();
      this.modbusAdapter = undefined;
    }

    // Stop OPC-UA adapter
    if (this.opcuaAdapter) {
      await this.opcuaAdapter.stop();
      this.opcuaAdapter = undefined;
    }

    // Stop all socket servers
    for (const [protocol, server] of this.socketServers) {
      this.logger.info(`Stopping ${protocol} socket server`);
      await server.stop();
    }
    this.socketServers.clear();

    // TODO: Stop other adapters (CAN, etc.)

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
        if (dbDevices.length === 0) {
          this.logger.warn('No Modbus devices found in database');
          return;
        }
        
        // Convert database format to ModbusAdapterConfig
        // Database stores the full ModbusDevice config in connection and data_points fields
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
      this.modbusAdapter = new ModbusAdapter(modbusConfig, this.logger);

      // Wire up event handlers
      this.modbusAdapter.on('started', () => {
        this.logger.info('Modbus adapter started');
      });

      this.modbusAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        modbusSocket.sendData(dataPoints);
      });

      this.modbusAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`Modbus device connected: ${deviceName}`);
      });

      this.modbusAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`Modbus device disconnected: ${deviceName}`);
      });

      this.modbusAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`Modbus device error [${deviceName}]: ${error.message}`);
      });

      // Start adapter
      await this.modbusAdapter.start();
      
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
        if (dbDevices.length === 0) {
          this.logger.warn('No OPC-UA devices found in database');
          return;
        }
        
        // Convert database format to OPCUADeviceConfig array
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
      this.opcuaAdapter = new OPCUAAdapter(opcuaDevices);

      // Wire up event handlers
      this.opcuaAdapter.on('started', () => {
        this.logger.info('OPC-UA adapter started');
      });

      this.opcuaAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        opcuaSocket.sendData(dataPoints);
      });

      this.opcuaAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`OPC-UA device connected: ${deviceName}`);
      });

      this.opcuaAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`OPC-UA device disconnected: ${deviceName}`);
      });

      this.opcuaAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`OPC-UA device error [${deviceName}]: ${error.message}`);
      });

      // Start adapter
      await this.opcuaAdapter.start();
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start OPC-UA adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Get Modbus adapter instance (for testing/debugging)
   */
  getModbusAdapter(): ModbusAdapter | undefined {
    return this.modbusAdapter;
  }

  /**
   * Get OPC-UA adapter instance (for testing/debugging)
   */
  getOPCUAAdapter(): OPCUAAdapter | undefined {
    return this.opcuaAdapter;
  }

  /**
   * Get device statuses from all enabled protocol adapters
   * Returns a map of protocol type to array of device statuses
   */
  getAllDeviceStatuses(): Map<string, any[]> {
    const statuses = new Map<string, any[]>();

    // Collect Modbus device statuses
    if (this.modbusAdapter) {
      const modbusStatuses = this.modbusAdapter.getDeviceStatuses();
      if (modbusStatuses.length > 0) {
        statuses.set('modbus', modbusStatuses);
      }
    }

    // Collect OPC-UA device statuses
    if (this.opcuaAdapter) {
      const opcuaStatuses = this.opcuaAdapter.getDeviceStatuses();
      if (opcuaStatuses.length > 0) {
        statuses.set('opcua', opcuaStatuses);
      }
    }

    // TODO: Add CAN device statuses when implemented

    return statuses;
  }
}
