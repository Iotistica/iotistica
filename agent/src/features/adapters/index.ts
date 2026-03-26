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
import { MqttAdapter } from './mqtt/adapter.js';
import { MqttAdapterConfig } from './mqtt/types.js';
import { SocketServer } from './common/socket-server.js';
import { SensorDataPoint, SocketOutput } from './types.js';
import { EndpointOutputModel } from '../../db/models/endpoint-outputs.model.js';
import { DeviceEndpointModel } from '../../db/models/endpoint.model.js';

// Type imports only (no runtime loading)
import type { OPCUAAdapter } from './opcua/adapter.js';
import type { OPCUAAdapterConfig } from './opcua/types.js';

// SNMP imports
import { SNMPAdapter } from './snmp/adapter.js';

// BACnet imports
import { BACnetAdapter } from './bacnet/adapter.js';
import { BACnetAdapterConfig } from './bacnet/types.js';

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
  mqtt?: {
    enabled: boolean;
    config?: MqttAdapterConfig; // Optional: provide config directly, otherwise load from database
  };
  bacnet?: {
    enabled: boolean;
    config?: BACnetAdapterConfig; // Optional: provide config directly, otherwise load from database
  };
}

export class SensorsFeature extends BaseFeature {
  private adapters: Map<string, any> = new Map(); // Generic adapter storage
  private socketServers: Map<string, SocketServer> = new Map();

  private enrichWithEndpointUuid(
    dataPoints: SensorDataPoint[],
    endpointUuidByName: Map<string, string>
  ): SensorDataPoint[] {
    if (endpointUuidByName.size === 0 || dataPoints.length === 0) {
      return dataPoints;
    }

    return dataPoints.map((point) => {
      const endpointUuid = endpointUuidByName.get(point.deviceName);
      if (!endpointUuid) {
        return point;
      }

      // Each endpoint in the endpoints table is itself a device with a UUID.
      // Honour any asset-level device_uuid supplied by the source (e.g. a fleet
      // simulator that assigns its own UUIDs), otherwise the endpoint UUID is the
      // device identity for protocol adapters (OPC UA, Modbus, SNMP, MQTT).
      const device_uuid = point.device_uuid || endpointUuid;

      // Build a unique device display name: "{displayBase}-{first8ofDeviceUuid}"
      // - displayBase: protocol-discovered name (OPC-UA DisplayName, SNMP sysName, BACnet
      //   objectName) or config displayName override; falls back to the raw endpoint config name
      // - uuid suffix: first 8 hex chars of device_uuid make it globally unique across agents
      //   e.g. "opcua-4" (raw) → "Siemens S7-1500-eaaeff83" (discovered) or "opcua-4-eaaeff83"
      const displayBase = point.resolvedDisplayName || point.deviceName;
      const uuidSuffix = device_uuid.replace(/-/g, '').slice(0, 8);
      const deviceName = uuidSuffix.length === 8
        ? `${displayBase}-${uuidSuffix}`
        : displayBase;

      this.logger.debug('Built endpoint deviceName', {
        displayBase,
        device_uuid,
        endpointUuid,
        finalDeviceName: deviceName,
      });

      return {
        ...point,
        deviceName,
        endpoint_uuid: endpointUuid,
        device_uuid,
      };
    });
  }

  constructor(
    config: SensorConfig,
    agentLogger: AgentLogger,
    deviceUuid: string
  ) {
    super(config, agentLogger, 'Adapters', deviceUuid, false, 'PROTOCOL_ADAPTERS_DEBUG');
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

     // Start MQTT adapter if enabled
    if ((this.config as SensorConfig).mqtt?.enabled) {
      await this.startMQTTAdapter();
    }

    // Start BACnet adapter if enabled
    if ((this.config as SensorConfig).bacnet?.enabled) {
      await this.startBACnetAdapter();
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
      if (adapter && typeof adapter.stop === 'function') {
        await adapter.stop();
      }
    }
    this.adapters.clear();

    // Stop all socket servers
    for (const [protocol, server] of this.socketServers) {
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
            uuid: d.uuid,
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

      const modbusEndpointUuidByName = new Map<string, string>();
      modbusConfig.devices.forEach((device: any) => {
        const endpointUuid =
          (typeof device.uuid === 'string' && device.uuid.trim()) ||
          (typeof device.metadata?.uuid === 'string' && device.metadata.uuid.trim()) ||
          (typeof device.metadata?.device_uuid === 'string' && device.metadata.device_uuid.trim());

        if (endpointUuid && typeof device.name === 'string') {
          modbusEndpointUuidByName.set(device.name, endpointUuid);
        }
      });

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
    
      // Create Modbus adapter (socket-agnostic)
      const modbusAdapter = new ModbusAdapter(modbusConfig, this.logger);
      this.adapters.set('modbus', modbusAdapter);
      
      // Pass socket server reference for backpressure checking
      (modbusAdapter as any)._socketServer = modbusSocket;

      // Wire up event handlers
      modbusAdapter.on('started', () => {
        this.logger.info('Modbus adapter started');
      });

      modbusAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        modbusSocket.sendData(this.enrichWithEndpointUuid(dataPoints, modbusEndpointUuidByName));
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
          uuid: d.uuid,
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

      const opcuaEndpointUuidByName = new Map<string, string>();
      opcuaDevices.forEach((device: any) => {
        const endpointUuid =
          (typeof device.uuid === 'string' && device.uuid.trim()) ||
          (typeof device.metadata?.uuid === 'string' && device.metadata.uuid.trim()) ||
          (typeof device.metadata?.device_uuid === 'string' && device.metadata.device_uuid.trim());

        if (endpointUuid && typeof device.name === 'string') {
          opcuaEndpointUuidByName.set(device.name, endpointUuid);
        }
      });

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
   
      // Dynamically import OPC-UA adapter (only loads node-opcua-client when needed)
      const { OPCUAAdapter } = await import('./opcua/adapter.js');
      
      // Create OPC-UA adapter (constructor takes device array, not config object)
      const opcuaAdapter = new OPCUAAdapter(opcuaDevices, this.logger);
      this.adapters.set('opcua', opcuaAdapter);

      // Wire up event handlers
      opcuaAdapter.on('started', () => {
        this.logger.debug('OPC-UA adapter started');
      });

      opcuaAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        opcuaSocket.sendData(this.enrichWithEndpointUuid(dataPoints, opcuaEndpointUuidByName));
      });

      opcuaAdapter.on('device-connected', (deviceName: string) => {
        this.logger.debug(`OPC-UA device connected: ${deviceName}`);
      });

      opcuaAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`OPC-UA device disconnected: ${deviceName}`);
      });

      opcuaAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`OPC-UA device error [${deviceName}]: ${error.message}`);
      });

      opcuaAdapter.on('rediscovery-needed', (data: { deviceName: string; endpointUrl: string }) => {
        this.logger.warn(`OPC-UA adapter requesting rediscovery for ${data.deviceName} (high NodeID failure rate, endpointUrl: ${data.endpointUrl})`);
        this.emit('rediscovery-needed', data);
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
    
      // Map database devices to SNMPDeviceConfig format
      const snmpDevices = dbDevices.map(d => ({
        uuid: d.uuid,
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

      const snmpEndpointUuidByName = new Map<string, string>();
      snmpDevices.forEach((device: any) => {
        const endpointUuid =
          (typeof device.uuid === 'string' && device.uuid.trim()) ||
          (typeof device.metadata?.uuid === 'string' && device.metadata.uuid.trim()) ||
          (typeof device.metadata?.device_uuid === 'string' && device.metadata.device_uuid.trim());

        if (endpointUuid && typeof device.name === 'string') {
          snmpEndpointUuidByName.set(device.name, endpointUuid);
        }
      });

      // Create SNMP adapter (socket-agnostic)
      const snmpAdapter = new SNMPAdapter(snmpDevices, this.logger);
      this.adapters.set('snmp', snmpAdapter);

      // Wire up event handlers
      snmpAdapter.on('started', () => {
        this.logger.info('SNMP adapter started');
      });

      snmpAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        snmpSocket.sendData(this.enrichWithEndpointUuid(dataPoints, snmpEndpointUuidByName));
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
   * Start MQTT adapter
   */
  private async startMQTTAdapter(): Promise<void> {
    try {
      let mqttConfig: MqttAdapterConfig;
      let outputConfig: SocketOutput;

      // Load config from provided config object or database
      if (this.config.mqtt!.config) {
        mqttConfig = this.config.mqtt!.config;
      } else {
        // Load devices from database
        const dbDevices = await DeviceEndpointModel.getEnabled('mqtt');
        
        // Start adapter even with no devices (needed for observer + discovery)
        if (dbDevices.length === 0) {
          this.logger.info('MQTT ADAPTER: No MQTT devices in database - relying on observerRoots for continuous discovery');
        } else {
          this.logger.info(`MQTT ADAPTER: Found ${dbDevices.length} MQTT devices in database`);
        }
        
        // MQTT broker is infrastructure-level config (not per-endpoint target-state config).
        // Require explicit environment configuration to avoid implicit fallbacks.
        const brokerUrl = process.env.MQTT_BROKER_URL;
        if (!brokerUrl) {
          throw new Error('MQTT_BROKER_URL is required for MQTT adapter startup');
        }

        let brokerHost: string;
        let brokerPort: number;
        
        try {
          const url = new URL(brokerUrl);
          brokerHost = url.hostname;
          brokerPort = parseInt(url.port) || 1883;
          this.logger.info(`MQTT ADAPTER: Using broker ${brokerHost}:${brokerPort} from MQTT_BROKER_URL`);
        } catch (error) {
          throw new Error(`Failed to parse MQTT broker URL '${brokerUrl}': ${error}`);
        }
        
        // Convert database format to MqttAdapterConfig
        mqttConfig = {
          broker: {
            host: brokerHost,
            port: brokerPort,
            username: process.env.MQTT_USERNAME,
            password: process.env.MQTT_PASSWORD
          },
          qos: 1,
          reconnect: {
            period: 1000,
            maxAttempts: 10
          },
          devices: dbDevices.map(d => ({
            uuid: d.uuid,
            name: d.name,
            enabled: d.enabled,
            topic: d.connection.topic || d.name,
            qos: d.connection.qos || 1,
            dataType: d.connection.dataType || 'float32',
            unit: d.connection.unit,
            metric: d.connection.metric,
            deviceId: d.connection.deviceId,
            timestampField: d.connection.timestampField,
            metrics: Array.isArray((d.connection as any).metrics)
              ? (d.connection as any).metrics.map((metric: any) => ({
                  field: metric.field,
                  metric: metric.metric,
                  unit: metric.unit,
                  type: metric.type,
                }))
              : undefined,
            autoMetrics: Boolean((d.connection as any).autoMetrics),
            allowArrayMetrics: Boolean((d.connection as any).allowArrayMetrics)
          })),

          logging: {
            level: 'info',
            enableConsole: false,
            enableFile: false
          }
        };
      }

      const mqttEndpointUuidByName = new Map<string, string>();
      mqttConfig.devices.forEach((device: any) => {
        const endpointUuid =
          (typeof device.uuid === 'string' && device.uuid.trim()) ||
          (typeof device.metadata?.uuid === 'string' && device.metadata.uuid.trim()) ||
          (typeof device.metadata?.device_uuid === 'string' && device.metadata.device_uuid.trim());

        if (endpointUuid && typeof device.name === 'string') {
          mqttEndpointUuidByName.set(device.name, endpointUuid);
        }
      });

      // Load output config from database
      const dbOutput = await EndpointOutputModel.getOutput('mqtt');
      if (!dbOutput) {
        throw new Error('MQTT output configuration not found in database');
      }
      outputConfig = {
        socketPath: dbOutput.socket_path,
        dataFormat: dbOutput.data_format as 'json' | 'csv',
        delimiter: dbOutput.delimiter,
        includeTimestamp: dbOutput.include_timestamp,
        includeDeviceName: dbOutput.include_device_name
      };

      // Create socket server for MQTT protocol
      const mqttSocket = new SocketServer(outputConfig, this.logger);
      await mqttSocket.start();
      this.socketServers.set('mqtt', mqttSocket);
   
      // Create MQTT adapter (socket-agnostic)
      const mqttAdapter = new MqttAdapter(mqttConfig, this.logger, this.deviceUuid);
      this.adapters.set('mqtt', mqttAdapter);

      // Wire up event handlers
      mqttAdapter.on('started', () => {
        this.logger.info('MQTT adapter started');
      });

      mqttAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        mqttSocket.sendData(this.enrichWithEndpointUuid(dataPoints, mqttEndpointUuidByName));
      });

      mqttAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`MQTT broker connected: ${deviceName}`);
      });

      mqttAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`MQTT broker disconnected: ${deviceName}`);
      });

      mqttAdapter.on('device-error', (deviceName: string, error: Error) => {
        this.logger.error(`MQTT error [${deviceName}]: ${error.message}`);
      });

      // Start adapter
      await mqttAdapter.start();
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start MQTT adapter: ${errorMessage}`);
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
   * Get MQTT adapter instance (for testing/debugging)
   */
  getMQTTAdapter(): MqttAdapter | undefined {
    return this.adapters.get('mqtt') as MqttAdapter | undefined;
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
      const stalenessThresholdMs = 24 * 60 * 60 * 1000; // 24 hours
      
      this.logger.debug(`Found ${allSensors.length} sensors in database`);
      
      // Build health status for each sensor
      for (const sensor of allSensors) {
        
        // Determine online/offline based on lastSeenAt timestamp
        // Use 24-hour threshold for discovered devices (discovery runs periodically)
        // Adapter overlay will provide real-time status for actively polled devices
        const lastSeen = sensor.lastSeenAt ? new Date(sensor.lastSeenAt) : null;
        const now = Date.now();
        const isOnline = lastSeen && (now - lastSeen.getTime()) < stalenessThresholdMs;
        
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
                  // Overlay runtime status and derive effective status from fresh runtime timestamps.
                  // This prevents stale DB status from forcing MQTT endpoints to appear offline
                  // when messages are actively arriving.
                  const now = Date.now();
                  const runtimeLastSeenMs = device.lastSeen ? new Date(device.lastSeen).getTime() : null;
                  const runtimeLastPollMs = device.lastPoll ? new Date(device.lastPoll).getTime() : null;
                  const hasFreshRuntimeSignal = Boolean(
                    (runtimeLastSeenMs && (now - runtimeLastSeenMs) < stalenessThresholdMs) ||
                    (runtimeLastPollMs && (now - runtimeLastPollMs) < stalenessThresholdMs)
                  );

                  const isEnabled = health[device.deviceName].status !== 'disabled';
                  const explicitlyOffline = device.communicationQuality === 'offline';
                  // Derive connectivity from fresh activity, not adapter connected flag.
                  // Some adapters (e.g., MQTT) intentionally do not toggle `connected`
                  // on every message and rely on staleness/LWT semantics.
                  const runtimeOnline = Boolean(hasFreshRuntimeSignal && !explicitlyOffline);
                  const effectiveStatus = !isEnabled
                    ? 'disabled'
                    : (runtimeOnline ? 'online' : health[device.deviceName].status);

                  health[device.deviceName] = {
                    protocol,
                    status: effectiveStatus,
                    connected: isEnabled && runtimeOnline,
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
  
  /**
   * Start BACnet adapter
   */
  private async startBACnetAdapter(): Promise<void> {
    try {
      let bacnetConfig: BACnetAdapterConfig;
      let outputConfig: SocketOutput;

      // Load config from provided config object or database
      if (this.config.bacnet!.config) {
        bacnetConfig = this.config.bacnet!.config;
      } else {
        // Load devices from database
        const dbDevices = await DeviceEndpointModel.getEnabled('bacnet');
        
        if (dbDevices.length === 0) {
          this.logger.info('BACnet ADAPTER: No BACnet devices in database - skipping adapter start');
          return;
        }
        
        this.logger.info(`BACnet ADAPTER: Found ${dbDevices.length} BACnet devices in database`);
        
        // Convert database format to BACnetAdapterConfig
        bacnetConfig = {
          enabled: true,
          port: (this.config.bacnet as any)?.port || 47809,
          devices: dbDevices.map(d => ({
            uuid: d.uuid,
            name: d.name,
            enabled: d.enabled,
            ipAddress: d.connection.ipAddress || d.connection.host,
            port: d.connection.port || 47808,
            deviceInstance: d.connection.deviceInstance || 0,
            pollIntervalMs: d.poll_interval || 5000,
            maxConcurrentReads: d.connection.maxConcurrentReads || 5,
            connectionTimeoutMs: d.connection.connectionTimeoutMs || 5000,
            retryAttempts: d.connection.retryAttempts || 3,
            retryDelayMs: d.connection.retryDelayMs || 1000,
            objects: (d.connection.objects || []).map((obj: any) => ({
              name: obj.name,
              objectType: obj.objectType,
              objectInstance: obj.objectInstance,
              propertyId: obj.propertyId || 85, // 85 = PRESENT_VALUE
              unit: obj.unit || '',
              pollIntervalMs: obj.pollIntervalMs || 5000,
              enabled: obj.enabled !== false,
            })),
          })),
          globalPollIntervalMs: (this.config.bacnet as any)?.globalPollIntervalMs || 5000,
          maxConcurrentDevices: (this.config.bacnet as any)?.maxConcurrentDevices || 10,
        };
      }

      const bacnetEndpointUuidByName = new Map<string, string>();
      bacnetConfig.devices.forEach((device: any) => {
        const endpointUuid =
          (typeof device.uuid === 'string' && device.uuid.trim()) ||
          (typeof device.metadata?.uuid === 'string' && device.metadata.uuid.trim()) ||
          (typeof device.metadata?.device_uuid === 'string' && device.metadata.device_uuid.trim());

        if (endpointUuid && typeof device.name === 'string') {
          bacnetEndpointUuidByName.set(device.name, endpointUuid);
        }
      });

      // Load output config from database
      const dbOutput = await EndpointOutputModel.getOutput('bacnet');
      if (!dbOutput) {
        throw new Error('BACnet output configuration not found in database');
      }
      outputConfig = {
        socketPath: dbOutput.socket_path,
        dataFormat: dbOutput.data_format as 'json' | 'csv',
        delimiter: dbOutput.delimiter,
        includeTimestamp: dbOutput.include_timestamp,
        includeDeviceName: dbOutput.include_device_name
      };

      // Create socket server for BACnet protocol
      const bacnetSocket = new SocketServer(outputConfig, this.logger);
      await bacnetSocket.start();
      this.socketServers.set('bacnet', bacnetSocket);

      // Create BACnet adapter (socket-agnostic)
      const bacnetAdapter = new BACnetAdapter(bacnetConfig, this.logger);
      this.adapters.set('bacnet', bacnetAdapter);

      // Wire up event handlers
      bacnetAdapter.on('started', () => {
        this.logger.info('BACnet adapter started');
      });

      bacnetAdapter.on('data', (dataPoints: SensorDataPoint[]) => {
        // Route data from adapter to socket server
        bacnetSocket.sendData(this.enrichWithEndpointUuid(dataPoints, bacnetEndpointUuidByName));
      });

      bacnetAdapter.on('device-connected', (deviceName: string) => {
        this.logger.info(`BACnet device connected: ${deviceName}`);
      });

      bacnetAdapter.on('device-disconnected', (deviceName: string) => {
        this.logger.warn(`BACnet device disconnected: ${deviceName}`);
      });

      bacnetAdapter.on('device-error', ({ deviceName, error }: { deviceName: string; error: string }) => {
        this.logger.error(`BACnet error [${deviceName}]: ${error}`);
      });

      // Start adapter
      await bacnetAdapter.start();
      
      this.logger.info(`BACnet adapter started with ${bacnetConfig.devices.length} device(s)`);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start BACnet adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Get a specific protocol adapter
   * @param protocol - Protocol name ('modbus', 'opcua', 'snmp', 'mqtt', 'bacnet')
   * @returns The adapter instance or undefined if not running
   */
  getAdapter(protocol: string): any | undefined {
    return this.adapters.get(protocol);
  }
  
  /**
   * Get all running adapters
   * @returns Map of protocol name to adapter instance
   */
  getAllAdapters(): Map<string, any> {
    return new Map(this.adapters);
  }
}
