import { BaseFeature } from '../index.js';
import { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import type { Protocol } from '../../anomaly/types.js';
import type { AnomalyDetectionService } from '../../anomaly/index.js';
import type { PipelineService } from '../pipeline/index.js';
import {
  DevicePublishConfig,
  DeviceConfig
} from './types.js';
import { PublishManager } from './manager.js';

/**
 * SensorPublishFeature - Manages multiple sensors and publishes data to MQTT
 * Ported from AWS IoT Device Client SensorPublishFeature.cpp
 */
export class DevicePublishFeature extends BaseFeature {
  private static readonly MAX_SENSORS = 10;
  
  private sensors: PublishManager[] = [];
  private agentLogger: AgentLogger;
  private dictionaryManager?: any; // Dictionary manager for MQTT message key compaction
  private readonly useMsgpackPoc: boolean;
  private readonly useKeyCompactionPoc: boolean;
  private readonly useDeflatePoc: boolean;
  private anomalyService?: AnomalyDetectionService;
  private pipelineService?: PipelineService;
  private liveDataInterceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[];

  constructor(
    config: DevicePublishConfig & { enabled: boolean },
    agentLogger: AgentLogger,
    deviceUuid: string,
    dictionaryManager?: any, // Optional dictionary manager
    useMsgpackPoc: boolean = false, // Enable MessagePack compression POC
    useKeyCompactionPoc: boolean = false, // Enable dictionary key compaction POC
    useDeflatePoc: boolean = false, // Enable DEFLATE compression POC
    anomalyService?: AnomalyDetectionService,
  ) {
    super(
      config,
      agentLogger,
      LogComponents.sensorPublish,
      deviceUuid,
      true, // Requires MQTT
      'SENSOR_PUBLISH_DEBUG'
    );
    this.agentLogger = agentLogger;
    this.dictionaryManager = dictionaryManager;
    this.useMsgpackPoc = useMsgpackPoc;
    this.useKeyCompactionPoc = useKeyCompactionPoc;
    this.useDeflatePoc = useDeflatePoc;
    this.anomalyService = anomalyService;
  }

  public setAnomalyService(anomalyService?: AnomalyDetectionService): void {
    this.anomalyService = anomalyService;
    for (const sensor of this.sensors) {
      sensor.setAnomalyService(anomalyService);
    }

    this.logger.debug('Updated anomaly service binding for Device Publish Feature', {
      hasAnomalyService: !!anomalyService,
      sensorCount: this.sensors.length,
    });
  }

  public setPipelineService(pipeline?: PipelineService): void {
    this.pipelineService = pipeline;
    for (const sensor of this.sensors) {
      sensor.setPipelineService(pipeline);
    }

    this.logger.debug('Updated pipeline service binding for Device Publish Feature', {
      hasPipelineService: !!pipeline,
      sensorCount: this.sensors.length,
    });
  }

  public setLiveDataInterceptor(interceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[]): void {
    this.liveDataInterceptor = interceptor;
    for (const sensor of this.sensors) {
      sensor.setLiveDataInterceptor(interceptor);
    }

    this.logger.debug('Updated live data interceptor for Device Publish Feature', {
      hasInterceptor: !!interceptor,
      sensorCount: this.sensors.length,
    });
  }

  /**
   * Get feature name
   */
  public getName(): string {
    return 'DevicePublish';
  }

  /**
   * Validate configuration - override from BaseFeature
   */
  protected validateConfig(): void {
    const sensorConfig = this.config as DevicePublishConfig;
    
    if (!sensorConfig.endpoints || !Array.isArray(sensorConfig.endpoints)) {
      throw new Error('Device Publish configuration must include endpoints array');
    }

    // Check max sensors limit
    if (sensorConfig.endpoints.length > DevicePublishFeature.MAX_SENSORS) {
      throw new Error(`Maximum ${DevicePublishFeature.MAX_SENSORS} devices supported, got ${sensorConfig.endpoints.length}`);
    }

    // Validate each Device configuration
    sensorConfig.endpoints.forEach((config: DeviceConfig) => {
      this.validateDeviceConfig(config);
    });

  }

  /**
   * Initialize - called by BaseFeature.start() before onStart()
   */
  protected async onInitialize(): Promise<void> {
    const sensorConfig = this.config as DevicePublishConfig;
    
    if (sensorConfig.endpoints.length === 0) {
      this.logger.warn('No devices configured');
      return;
    }

    this.logger.debug(`Starting Device Publish feature with ${sensorConfig.endpoints.length} sensors`);
  }

  /**
   * Start the Device publish feature
   */
  protected async onStart(): Promise<void> {
    if (!this.mqttConnection) {
      throw new Error('MQTT connection required for Device Publish feature');
    }

    const deviceConfig = this.config as DevicePublishConfig;
    
    if (deviceConfig.endpoints.length === 0) {
      return;
    }
    
    // Create and start all sensors
    for (let i = 0; i < deviceConfig.endpoints.length; i++) {
      const config = deviceConfig.endpoints[i];

      const device = this.createDeviceManager(config, i, deviceConfig.endpoints.length);
      if (this.pipelineService) device.setPipelineService(this.pipelineService);
      if (this.liveDataInterceptor) device.setLiveDataInterceptor(this.liveDataInterceptor);
      this.attachDeviceEventHandlers(device, config.name!);
      this.sensors.push(device);
      await this.startDeviceManager(device, config);
    }
    
    this.emit('started');
  }

  /**
   * Stop the Device publish feature
   */
  protected async onStop(): Promise<void> {
    // Stop all sensors
    await Promise.all(this.sensors.map(device => device.stop()));
    
    this.sensors = [];
    
    this.emit('stopped');
  }

  /**
   * Get statistics for all sensors (includes health status)
   */
  public getStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    const publishConfig = this.config as DevicePublishConfig;

    for (let i = 0; i < this.sensors.length; i++) {
      const device = this.sensors[i];
      const config = publishConfig.endpoints[i];
      const name = config?.name || `device-${i + 1}`;
      stats[name] = device.getRuntimeSnapshot(60000);
    }

    return stats;
  }

  /**
   * Inject one simulated message into a specific endpoint topic pipeline.
   * Returns true when a matching endpoint exists and message was routed.
   */
  public publishSimulationMessage(endpointTopic: string, message: Record<string, any>): boolean {
    const publishConfig = this.config as DevicePublishConfig;

    for (let i = 0; i < this.sensors.length; i++) {
      const endpoint = publishConfig.endpoints[i];
      if (!endpoint) {
        continue;
      }

      if (endpoint.mqttTopic === endpointTopic) {
        this.sensors[i].injectSimulationMessage(message);
        return true;
      }
    }

    return false;
  }

  private createDeviceManager(config: DeviceConfig, index: number, total: number): PublishManager {
    config.name = config.name || `device-${index + 1}`;
    this.logger.debug(`Creating device '${config.name}' (${index + 1}/${total})`);
    const protocolName = config.protocol || config.name.split('-')[0];
    if (!this.isValidProtocol(protocolName)) {
      throw new Error(`Unknown protocol '${protocolName}' for endpoint '${config.name}'`);
    }
    const protocol = protocolName as Protocol;

    const protocolLogger = {
      debug: (message: string, ...args: any[]) => {
        this.agentLogger.debugSync(message, {
          component: LogComponents.sensorPublish,
          protocol,
          ...args[0]
        });
      },
      info: (message: string, ...args: any[]) => {
        this.agentLogger.infoSync(message, {
          component: LogComponents.sensorPublish,
          protocol,
          ...args[0]
        });
      },
      warn: (message: string, ...args: any[]) => {
        this.agentLogger.warnSync(message, {
          component: LogComponents.sensorPublish,
          protocol,
          ...args[0]
        });
      },
      error: (message: string, ...args: any[]) => {
        this.agentLogger.errorSync(message, args[0] instanceof Error ? args[0] : undefined, {
          component: LogComponents.sensorPublish,
          protocol,
          ...(args[0] instanceof Error ? args[1] : args[0])
        });
      }
    };

    return new PublishManager(
      config,
      this.mqttConnection!,
      protocolLogger,
      this.deviceUuid,
      this.dictionaryManager,
      this.useMsgpackPoc,
      this.useKeyCompactionPoc,
      this.useDeflatePoc,
      protocol,
      this.anomalyService,
    );
  }

  private isValidProtocol(value: string): boolean {
    const validProtocols = ['modbus', 'opcua', 'bacnet', 'mqtt', 'system'];
    return validProtocols.includes(value.toLowerCase());
  }

  private attachDeviceEventHandlers(device: PublishManager, deviceName: string): void {
    device.on('connected', () => {
      this.logger.debug(`Device '${deviceName}' connected`);
      this.emit('sensor-connected', deviceName);
    });

    device.on('disconnected', () => {
      this.logger.debug(`Device '${deviceName}' disconnected`);
      this.emit('sensor-disconnected', deviceName);
    });

    device.on('error', (error: Error) => {
      this.logger.error(`Device '${deviceName}' error: ${error.message}`, error);
      this.emit('sensor-error', deviceName, error);
    });
  }

  private async startDeviceManager(device: PublishManager, config: DeviceConfig): Promise<void> {
    try {
      this.logger.debug(`Starting Device '${config.name}'...`);
      await device.start();
      this.logger.debug(`Device '${config.name}' started successfully`);
    } catch (error) {
      this.logger.error(`Failed to create/start Device '${config.name}' at ${config.addr}`, error);
      throw error;
    }
  }

  /**
   * Get Device by name
   */
  public getDevice(name: string): PublishManager | undefined {
    const sensorConfig = this.config as DevicePublishConfig;
    const index = sensorConfig.endpoints.findIndex((s: DeviceConfig) => s.name === name);
    return index >= 0 ? this.sensors[index] : undefined;
  }

  /**
   * Get all sensors with their configuration
   */
  public getDevices(): Array<{ name: string; enabled: boolean; addr: string; publishInterval: number }> {
    const deviceConfig = this.config as DevicePublishConfig;
    return deviceConfig.endpoints.map((config: DeviceConfig, index: number) => {
      return {
        name: config.name || `device-${index + 1}`,
        enabled: config.enabled !== false,
        addr: config.addr,
        publishInterval: config.publishInterval || 30000
      };
    });
  }

  /**
   * Enable a Device by name
   */
  public async enableDevice(deviceName: string): Promise<void> {
    const publishConfig = this.config as DevicePublishConfig;
    const index = publishConfig.endpoints.findIndex((s: DeviceConfig) => s.name === deviceName);
    if (index < 0) {
      throw new Error(`Device not found: ${deviceName}`);
    }

    const deviceConfig = publishConfig.endpoints[index];
    const device = this.sensors[index];

    if (deviceConfig.enabled === false) {
      deviceConfig.enabled = true;
      
      if (device && this.isRunning) {
        await device.start();
      }
      
      this.logger.debug(`Device '${deviceName}' enabled`);
      this.emit('sensor-enabled', deviceName);
    }
  }

  /**
   * Disable a Device by name
   */
  public async disableDevice(sensorName: string): Promise<void> {
    const publishConfig = this.config as DevicePublishConfig;
    const index = publishConfig.endpoints.findIndex((s: DeviceConfig) => s.name === sensorName);
    if (index < 0) {
      throw new Error(`Device not found: ${sensorName}`);
    }

    const sensorConfig = publishConfig.endpoints[index];
    const device = this.sensors[index];

    if (sensorConfig.enabled !== false) {
      sensorConfig.enabled = false;
      
      if (device && this.isRunning) {
        await device.stop();
      }
      
      this.logger.debug(`Device '${sensorName}' disabled`);
      this.emit('sensor-disabled', sensorName);
    }
  }

  /**
   * Update publish interval for a sensor
   */
  public async updateInterval(sensorName: string, intervalMs: number): Promise<void> {
    const publishConfig = this.config as DevicePublishConfig;
    const index = publishConfig.endpoints.findIndex((s: DeviceConfig) => s.name === sensorName);
    if (index < 0) {
      throw new Error(`Device not found: ${sensorName}`);
    }

    const sensorConfig = publishConfig.endpoints[index];
    const device = this.sensors[index];

    if (intervalMs < 1000) {
      throw new Error(`Invalid interval for ${sensorName}: minimum 1000ms`);
    }

    sensorConfig.publishInterval = intervalMs;
    
    // Update the sensor's interval if it's running
    if (device && this.isRunning && sensorConfig.enabled !== false) {
      device.updateInterval(intervalMs);
    }
    
    this.logger.debug(`Updated interval for '${sensorName}': ${intervalMs}ms`);
    this.emit('sensor-interval-updated', sensorName, intervalMs);
  }

  /**
   * Check if MQTT is connected
   */
  public isMqttConnected(): boolean {
    return this.mqttConnection?.isConnected() ?? false;
  }



  /**
   * Validate individual Device configuration
   */
  protected validateDeviceConfig(config: DeviceConfig): void {
    // Check required fields
    if (!config.addr) {
      throw new Error(`Device '${config.name}': 'addr' is required`);
    }

    if (!config.eomDelimiter) {
      throw new Error(`Device '${config.name}': 'eomDelimiter' is required`);
    }

    if (!config.mqttTopic) {
      throw new Error(`Device '${config.name}': 'mqttTopic' is required`);
    }

    // Validate buffer capacity
    if (config.bufferCapacity && config.bufferCapacity < 1024) {
      throw new Error(`Device '${config.name}': 'bufferCapacity' must be at least 1024 bytes`);
    }

    // Validate regex
    try {
      new RegExp(config.eomDelimiter);
    } catch (error) {
      throw new Error(`Device '${config.name}': Invalid 'eomDelimiter' regex: ${config.eomDelimiter}`);
    }

    this.logger.debug(`Validated configuration for Device '${config.name}'`);
  }
}
