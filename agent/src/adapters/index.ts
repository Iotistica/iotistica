/**
 * Protocol Adapter Manager
 *
 * Manages industrial protocol adapters (Modbus, OPC-UA, SNMP, MQTT, BACnet, CAN).
 * Each adapter polls devices and emits 'data' events.
 * AdapterManager creates one SocketServer per protocol and routes adapter data
 * to sockets for consumption by the publish pipeline.
 *
 * Architecture:
 * - Protocol Adapters: Socket-agnostic, emit data events
 * - AdapterManager: Creates SocketServers, routes adapter data to sockets
 * - Publish pipeline: Reads from sockets, publishes to MQTT
 */

import { EventEmitter } from 'events';
import { AgentLogger } from '../logging/agent-logger.js';
import { ModbusAdapter } from './modbus/adapter.js';
import { ModbusAdapterConfig } from './modbus/types.js';
import { LocalBrokerMqttAdapter } from './mqtt/adapter.js';
import { MqttAdapterConfig } from './mqtt/types.js';
import { SocketServer } from './common/socket-server.js';
import { DeviceDataPoint, SocketOutput } from './types.js';
import { EndpointOutputModel } from '../db/models/endpoint-outputs.model.js';
import { EndpointModel } from '../db/models/endpoint.model.js';
import { encodeIfUuid } from '../mqtt/codec.js';

// Type imports only (no runtime loading)
import type { OPCUAAdapter } from './opcua/adapter.js';
import type { OPCUAAdapterConfig } from './opcua/types.js';

// SNMP imports
import { SNMPAdapter } from './snmp/adapter.js';

// BACnet imports
import { BACnetAdapter } from './bacnet/adapter.js';
import { BACnetAdapterConfig } from './bacnet/types.js';

export interface AdapterConfig {
  modbus?: { enabled: boolean; config?: ModbusAdapterConfig };
  can?: { enabled: boolean };
  opcua?: { enabled: boolean; config?: OPCUAAdapterConfig };
  snmp?: { enabled: boolean };
  mqtt?: { enabled: boolean; config?: MqttAdapterConfig };
  bacnet?: { enabled: boolean; config?: BACnetAdapterConfig };
}

export class AdapterManager extends EventEmitter {
  private adapters: Map<string, any> = new Map();
  private socketServers: Map<string, SocketServer> = new Map();
  // Shared endpoint-UUID lookup used by the MQTT data handler; updated in-place on hot-reload
  // so the event-handler closure always sees the latest device→UUID mappings.
  private mqttEndpointUuidByName: Map<string, string> = new Map();
  private config: AdapterConfig;
  private deviceUuid: string;
  private running = false;
  private readonly logger: { info(m: string): void; warn(m: string): void; error(m: string, ...a: any[]): void; debug(m: string, ...a: any[]): void };

  private enrichWithEndpointUuid(
    dataPoints: DeviceDataPoint[],
    endpointUuidByName: Map<string, string>
  ): DeviceDataPoint[] {
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

  /** Build a device-name → endpoint-UUID lookup from a list of device configs */
  private buildUuidMap(devices: any[]): Map<string, string> {
    const map = new Map<string, string>();
    for (const device of devices) {
      const endpointUuid =
        (typeof device.uuid === 'string' && device.uuid.trim()) ||
        (typeof device.metadata?.uuid === 'string' && device.metadata.uuid.trim()) ||
        (typeof device.metadata?.device_uuid === 'string' && device.metadata.device_uuid.trim());
      if (endpointUuid && typeof device.name === 'string') {
        map.set(device.name, endpointUuid);
      }
    }
    return map;
  }

  /** Load output config from DB, create and start a SocketServer for the given protocol */
  private async createSocketServer(protocol: string): Promise<SocketServer> {
    const dbOutput = await EndpointOutputModel.getOutput(protocol);
    if (!dbOutput) throw new Error(`${protocol} output configuration not found in database`);
    const outputConfig: SocketOutput = {
      socketPath: dbOutput.socket_path,
      dataFormat: dbOutput.data_format as 'json' | 'csv',
      delimiter: dbOutput.delimiter,
      includeTimestamp: dbOutput.include_timestamp,
      includeDeviceName: dbOutput.include_device_name,
    };
    const socket = new SocketServer(outputConfig, this.logger);
    await socket.start();
    this.socketServers.set(protocol, socket);
    return socket;
  }

  /** Wire the four standard adapter events (started, data, device-connected, device-disconnected) */
  private wireAdapterEvents(
    protocol: string,
    adapter: EventEmitter,
    socket: SocketServer,
    uuidMap: Map<string, string>
  ): void {
    const label = protocol.toUpperCase();
    adapter.on('started',             ()                       => this.logger.info(`${label} adapter started`));
    adapter.on('data',                (dps: DeviceDataPoint[]) => socket.sendData(this.enrichWithEndpointUuid(dps, uuidMap)));
    adapter.on('device-connected',    (name: string)           => this.logger.info(`${label} device connected: ${name}`));
    adapter.on('device-disconnected', (name: string)           => this.logger.warn(`${label} device disconnected: ${name}`));
    adapter.on('device-error',        (name: string, err: Error | string) => this.logger.error(`${label} device error [${name}]: ${err instanceof Error ? err.message : err}`));
  }

  constructor(config: AdapterConfig, agentLogger: AgentLogger, deviceUuid: string) {
    super();
    this.config = config;
    this.deviceUuid = deviceUuid;
    this.logger = {
      info:  (m) => agentLogger.infoSync(m,  { component: 'Adapters' }),
      warn:  (m) => agentLogger.warnSync(m,  { component: 'Adapters' }),
      error: (m, ...a) => agentLogger.errorSync(m, a[0] instanceof Error ? a[0] : undefined, { component: 'Adapters' }),
      debug: (m, ...a) => { if (process.env.PROTOCOL_ADAPTERS_DEBUG === 'true') agentLogger.debugSync(m, { component: 'Adapters', args: a }); },
    };
  }

  /** Start all enabled protocol adapters */
  async start(): Promise<void> {
    if (this.running) return;
    if (this.config.modbus?.enabled)  await this.startModbusAdapter();
    if (this.config.opcua?.enabled)   await this.startOPCUAAdapter();
    if (this.config.snmp?.enabled)    await this.startSNMPAdapter();
    if (this.config.mqtt?.enabled)    await this.startMQTTAdapter();
    if (this.config.bacnet?.enabled)  await this.startBACnetAdapter();
    if (this.config.can?.enabled)     this.logger.warn('CAN adapter not yet implemented');
    this.running = true;
    this.emit('started');
  }

  /** Stop all running protocol adapters and socket servers */
  async stop(): Promise<void> {
    if (!this.running) return;
    for (const [, adapter] of this.adapters) {
      if (adapter && typeof adapter.stop === 'function') await adapter.stop();
    }
    this.adapters.clear();
    for (const [, server] of this.socketServers) await server.stop();
    this.socketServers.clear();
    this.running = false;
    this.emit('stopped');
  }

  isRunning(): boolean { return this.running; }

  /**
   * Start Modbus adapter
   */
  private async startModbusAdapter(): Promise<void> {
    try {
      let modbusConfig: ModbusAdapterConfig;

      if (this.config.modbus?.config) {
        modbusConfig = this.config.modbus.config;
      } else {
        const dbDevices = await EndpointModel.getEnabled('modbus');
        modbusConfig = {
          devices: dbDevices.map(d => ({
            uuid: d.uuid,
            name: d.name,
            enabled: d.enabled,
            slaveId: d.connection.slaveId || 1,
            connection: d.connection as any,
            pollInterval: d.poll_interval,
            registers: (d.data_points || []).map((dp: any) => {
              let functionCode = dp.functionCode;
              if (!functionCode && dp.type) {
                const typeMap: Record<string, number> = { coil: 1, discrete: 2, holding: 3, input: 4 };
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
            }),
          }) as any),
          logging: { level: 'info', enableConsole: false, enableFile: false },
        };
      }

      const uuidMap = this.buildUuidMap(modbusConfig.devices);
      const socket = await this.createSocketServer('modbus');
      const adapter = new ModbusAdapter(modbusConfig, this.logger);
      this.adapters.set('modbus', adapter);
      (adapter as any)._socketServer = socket;
      this.wireAdapterEvents('modbus', adapter, socket, uuidMap);
      await adapter.start();

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

      if (this.config.opcua?.config) {
        opcuaDevices = this.config.opcua.config.devices;
      } else {
        const dbDevices = await EndpointModel.getEnabled('opcua');
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
            offset: dp.offset || 0,
          })),
          metadata: d.metadata || {},
        }));
      }

      const uuidMap = this.buildUuidMap(opcuaDevices);
      const socket = await this.createSocketServer('opcua');
      const { OPCUAAdapter } = await import('./opcua/adapter.js');
      const adapter = new OPCUAAdapter(opcuaDevices, this.logger);
      this.adapters.set('opcua', adapter);
      this.wireAdapterEvents('opcua', adapter, socket, uuidMap);
      adapter.on('rediscovery-needed', (data: { deviceName: string; endpointUrl: string }) => {
        this.logger.warn(`OPC-UA adapter requesting rediscovery for ${data.deviceName} (high NodeID failure rate, endpointUrl: ${data.endpointUrl})`);
        this.emit('rediscovery-needed', data);
      });
      await adapter.start();

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
      const dbDevices = await EndpointModel.getEnabled('snmp');
      if (dbDevices.length === 0) {
        this.logger.info('No enabled SNMP devices found');
        return;
      }

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
          offset: dp.offset,
        })),
        metadata: d.metadata || {},
      }));

      const uuidMap = this.buildUuidMap(snmpDevices);
      const socket = await this.createSocketServer('snmp');
      const adapter = new SNMPAdapter(snmpDevices, this.logger);
      this.adapters.set('snmp', adapter);
      this.wireAdapterEvents('snmp', adapter, socket, uuidMap);
      await adapter.start();
      this.logger.info(`SNMP adapter started with ${dbDevices.length} device(s)`);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start SNMP adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Start MQTT adapter (or hot-reload devices if already running)
   */
  private async startMQTTAdapter(): Promise<void> {
    try {
      let mqttConfig: MqttAdapterConfig;

      if (this.config.mqtt?.config) {
        mqttConfig = this.config.mqtt.config;
      } else {
        const dbDevices = await EndpointModel.getEnabled('mqtt');
        const brokerUrl = process.env.MQTT_BROKER_URL;
        if (!brokerUrl) throw new Error('MQTT_BROKER_URL is required for MQTT adapter startup');
        let brokerHost: string;
        let brokerPort: number;
        try {
          const url = new URL(brokerUrl);
          brokerHost = url.hostname;
          brokerPort = parseInt(url.port) || 1883;
        } catch (error) {
          throw new Error(`Failed to parse MQTT broker URL '${brokerUrl}': ${error}`);
        }
        mqttConfig = {
          broker: {
            host: brokerHost,
            port: brokerPort,
            username: process.env.MQTT_USERNAME,
            password: process.env.MQTT_PASSWORD,
          },
          qos: 1,
          reconnect: { period: 1000, maxAttempts: 10, strategy: 'fixed', maxPeriod: 1000, jitterRatio: 0 },
          devices: dbDevices.map(d => ({
            uuid: d.uuid,
            name: d.name,
            enabled: d.enabled,
            topic: d.connection.topic ? `${d.connection.topic}/#` : encodeIfUuid(d.name),
            qos: d.connection.qos || 1,
            dataType: d.connection.dataType || 'float32',
            unit: d.connection.unit,
            precision: Number.isFinite((d.connection as any).precision) ? Number((d.connection as any).precision) : undefined,
            metric: d.connection.metric,
            deviceId: d.connection.deviceId,
            timestampField: d.connection.timestampField,
            metrics: Array.isArray((d.connection as any).metrics)
              ? (d.connection as any).metrics.map((metric: any) => ({
                  field: metric.field,
                  metric: metric.metric,
                  unit: metric.unit,
                  type: metric.type,
                  precision: Number.isFinite(metric.precision) ? Number(metric.precision) : undefined,
                }))
              : undefined,
            autoMetrics: Boolean((d.connection as any).autoMetrics),
            defaultUnits:
              (d.connection as any).defaultUnits && typeof (d.connection as any).defaultUnits === 'object'
                ? Object.entries((d.connection as any).defaultUnits).reduce<Record<string, string>>((acc, [key, value]) => {
                    if (typeof key === 'string' && key.trim() && typeof value === 'string' && value.trim()) acc[key] = value;
                    return acc;
                  }, {})
                : undefined,
            defaultPrecisions:
              (d.connection as any).defaultPrecisions && typeof (d.connection as any).defaultPrecisions === 'object'
                ? Object.entries((d.connection as any).defaultPrecisions).reduce<Record<string, number>>((acc, [key, value]) => {
                    if (typeof key === 'string' && key.trim() && Number.isFinite(value)) acc[key] = Number(value);
                    return acc;
                  }, {})
                : undefined,
            allowArrayMetrics: Boolean((d.connection as any).allowArrayMetrics),
          })),
          logging: { level: 'info', enableConsole: false, enableFile: false },
        };
      }

      // Rebuild the class-level UUID map (updated in-place; event handler closure always sees latest)
      const newMap = this.buildUuidMap(mqttConfig.devices);
      this.mqttEndpointUuidByName.clear();
      newMap.forEach((v, k) => this.mqttEndpointUuidByName.set(k, v));

      // Hot-update path: diff subscriptions in-place without reconnecting to the broker
      const existingAdapter = this.adapters.get('mqtt') as LocalBrokerMqttAdapter | undefined;
      if (existingAdapter) {
        this.logger.info('MQTT adapter already running — applying hot device update');
        await existingAdapter.updateDevices(mqttConfig.devices);
        return;
      }

      const socket = await this.createSocketServer('mqtt');
      const adapter = new LocalBrokerMqttAdapter(mqttConfig, this.logger, this.deviceUuid);
      this.adapters.set('mqtt', adapter);
      // Pass this.mqttEndpointUuidByName so the data handler always sees the latest map after hot-reloads
      this.wireAdapterEvents('mqtt', adapter, socket, this.mqttEndpointUuidByName);
      await adapter.start();

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start MQTT adapter: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Hot-reload MQTT adapter devices without disconnecting from the broker.
   * Safe to call from the reconciliation-complete handler instead of stop/reinit.
   */
  async reloadMQTTAdapter(): Promise<void> {
    if (this.config.mqtt?.enabled) {
      await this.startMQTTAdapter();
    }
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
      const allSensors = await EndpointModel.getAll();
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

      if (this.config.bacnet?.config) {
        bacnetConfig = this.config.bacnet.config;
      } else {
        const dbDevices = await EndpointModel.getEnabled('bacnet');
        if (dbDevices.length === 0) {
          this.logger.info('BACnet ADAPTER: No BACnet devices in database - skipping adapter start');
          return;
        }
        this.logger.info(`BACnet ADAPTER: Found ${dbDevices.length} BACnet devices in database`);
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
              propertyId: obj.propertyId || 85,
              unit: obj.unit || '',
              pollIntervalMs: obj.pollIntervalMs || 5000,
              enabled: obj.enabled !== false,
            })),
          })),
          globalPollIntervalMs: (this.config.bacnet as any)?.globalPollIntervalMs || 5000,
          maxConcurrentDevices: (this.config.bacnet as any)?.maxConcurrentDevices || 10,
        };
      }

      const uuidMap = this.buildUuidMap(bacnetConfig.devices);
      const socket = await this.createSocketServer('bacnet');
      const adapter = new BACnetAdapter(bacnetConfig, this.logger);
      this.adapters.set('bacnet', adapter);
      this.wireAdapterEvents('bacnet', adapter, socket, uuidMap);
      await adapter.start();
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
