import { BaseFeature } from '../index.js';
import { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import {
  SensorPublishConfig,
  SensorConfig
} from './types.js';
import { Sensor } from './sensor.js';

/**
 * SensorPublishFeature - Manages multiple sensors and publishes data to MQTT
 * Ported from AWS IoT Device Client SensorPublishFeature.cpp
 */
export class SensorPublishFeature extends BaseFeature {
  private static readonly MAX_SENSORS = 10;
  
  private sensors: Sensor[] = [];

  constructor(
    config: SensorPublishConfig & { enabled: boolean },
    agentLogger: AgentLogger,
    deviceUuid: string
  ) {
    super(
      config,
      agentLogger,
      LogComponents.sensorPublish,
      deviceUuid,
      true, // Requires MQTT
      'SENSOR_PUBLISH_DEBUG'
    );
  }

  /**
   * Get feature name
   */
  public getName(): string {
    return 'SensorPublish';
  }

  /**
   * Validate configuration - override from BaseFeature
   */
  protected validateConfig(): void {
    const sensorConfig = this.config as SensorPublishConfig;
    
    if (!sensorConfig.endpoints || !Array.isArray(sensorConfig.endpoints)) {
      throw new Error('Sensor Publish configuration must include endpoints array');
    }

    // Check max sensors limit
    if (sensorConfig.endpoints.length > SensorPublishFeature.MAX_SENSORS) {
      throw new Error(`Maximum ${SensorPublishFeature.MAX_SENSORS} sensors supported, got ${sensorConfig.endpoints.length}`);
    }

    // Validate each sensor configuration
    sensorConfig.endpoints.forEach((config: SensorConfig) => {
      this.validateSensorConfig(config);
    });

    this.logger.debug(`Validated configuration for ${sensorConfig.endpoints.length} sensors`);
  }

  /**
   * Initialize - called by BaseFeature.start() before onStart()
   */
  protected async onInitialize(): Promise<void> {
    const sensorConfig = this.config as SensorPublishConfig;
    
    if (sensorConfig.endpoints.length === 0) {
      this.logger.warn('No sensors configured');
      return;
    }

    this.logger.info(`Starting Sensor Publish feature with ${sensorConfig.endpoints.length} sensors`);
  }

  /**
   * Start the sensor publish feature
   */
  protected async onStart(): Promise<void> {
    if (!this.mqttConnection) {
      throw new Error('MQTT connection required for Sensor Publish feature');
    }

    const sensorConfig = this.config as SensorPublishConfig;
    
    if (sensorConfig.endpoints.length === 0) {
      return;
    }
    
    // Create and start all sensors
    for (let i = 0; i < sensorConfig.endpoints.length; i++) {
      const config = sensorConfig.endpoints[i];
      
      // Set default name if not provided
      if (!config.name) {
        config.name = `sensor-${i + 1}`;
      }
      
      // Create sensor
      const sensor = new Sensor(
        config,
        this.mqttConnection,
        this.logger,
        this.deviceUuid
      );
      
      // Set up event handlers
      sensor.on('connected', () => {
        this.logger.info(`Sensor '${config.name}' connected`);
        this.emit('sensor-connected', config.name);
      });
      
      sensor.on('disconnected', () => {
        this.logger.info(`Sensor '${config.name}' disconnected`);
        this.emit('sensor-disconnected', config.name);
      });
      
      sensor.on('error', (error: Error) => {
        this.logger.error(`Sensor '${config.name}' error: ${error.message}`, error);
        this.emit('sensor-error', config.name, error);
      });
      
      this.sensors.push(sensor);
      
      // Start sensor
      await sensor.start();
    }
    
    this.emit('started');
  }

  /**
   * Stop the sensor publish feature
   */
  protected async onStop(): Promise<void> {
    // Stop all sensors
    await Promise.all(this.sensors.map(sensor => sensor.stop()));
    
    this.sensors = [];
    
    this.emit('stopped');
  }

  /**
   * Get statistics for all sensors (includes health status)
   */
  public getStats(): Record<string, any> {
    const stats: Record<string, any> = {};
    const now = Date.now();
    
    for (const sensor of this.sensors) {
      const config = this.config.sensors[this.sensors.indexOf(sensor)];
      const sensorStats = sensor.getStats();
      const sensorState = sensor.getState();
      
      // Smart health check: Connected AND receiving recent data
      // If no data in last 60 seconds, something is wrong upstream (protocol adapters)
      const hasRecentData = sensorStats.lastPublishTime && 
        (now - new Date(sensorStats.lastPublishTime).getTime()) < 60000; // 60 seconds
      
      // Healthy if: connected to pipe AND receiving data flow
      // This catches protocol adapter failures even when pipe connection is healthy
      const isHealthy = sensorState === 'CONNECTED' && 
        (hasRecentData || sensorStats.messagesReceived === 0); // Allow startup period
      
      stats[config.name!] = {
        state: sensorState,
        addr: config.addr,
        enabled: config.enabled !== false,
        healthy: isHealthy,
        lastError: sensorStats.lastError || null,
        lastErrorTime: sensorStats.lastErrorTime || null,
        ...sensorStats
      };
    }
    
    return stats;
  }

  /**
   * Get sensor by name
   */
  public getSensor(name: string): Sensor | undefined {
    const sensorConfig = this.config as SensorPublishConfig;
    const index = sensorConfig.endpoints.findIndex((s: SensorConfig) => s.name === name);
    return index >= 0 ? this.sensors[index] : undefined;
  }

  /**
   * Get all sensors with their configuration
   */
  public getSensors(): Array<{ name: string; enabled: boolean; addr: string; publishInterval: number }> {
    const sensorConfig = this.config as SensorPublishConfig;
    return sensorConfig.endpoints.map((config: SensorConfig, index: number) => {
      return {
        name: config.name || `sensor-${index + 1}`,
        enabled: config.enabled !== false,
        addr: config.addr,
        publishInterval: config.publishInterval || 30000
      };
    });
  }

  /**
   * Enable a sensor by name
   */
  public async enableSensor(sensorName: string): Promise<void> {
    const publishConfig = this.config as SensorPublishConfig;
    const index = publishConfig.endpoints.findIndex((s: SensorConfig) => s.name === sensorName);
    if (index < 0) {
      throw new Error(`Sensor not found: ${sensorName}`);
    }

    const sensorConfig = publishConfig.endpoints[index];
    const sensor = this.sensors[index];

    if (sensorConfig.enabled === false) {
      sensorConfig.enabled = true;
      
      if (sensor && this.isRunning) {
        await sensor.start();
      }
      
      this.logger.info(`Sensor '${sensorName}' enabled`);
      this.emit('sensor-enabled', sensorName);
    }
  }

  /**
   * Disable a sensor by name
   */
  public async disableSensor(sensorName: string): Promise<void> {
    const publishConfig = this.config as SensorPublishConfig;
    const index = publishConfig.endpoints.findIndex((s: SensorConfig) => s.name === sensorName);
    if (index < 0) {
      throw new Error(`Sensor not found: ${sensorName}`);
    }

    const sensorConfig = publishConfig.endpoints[index];
    const sensor = this.sensors[index];

    if (sensorConfig.enabled !== false) {
      sensorConfig.enabled = false;
      
      if (sensor && this.isRunning) {
        await sensor.stop();
      }
      
      this.logger.info(`Sensor '${sensorName}' disabled`);
      this.emit('sensor-disabled', sensorName);
    }
  }

  /**
   * Update publish interval for a sensor
   */
  public async updateInterval(sensorName: string, intervalMs: number): Promise<void> {
    const publishConfig = this.config as SensorPublishConfig;
    const index = publishConfig.endpoints.findIndex((s: SensorConfig) => s.name === sensorName);
    if (index < 0) {
      throw new Error(`Sensor not found: ${sensorName}`);
    }

    const sensorConfig = publishConfig.endpoints[index];
    const sensor = this.sensors[index];

    if (intervalMs < 1000) {
      throw new Error(`Invalid interval for ${sensorName}: minimum 1000ms`);
    }

    sensorConfig.publishInterval = intervalMs;
    
    // Update the sensor's interval if it's running
    if (sensor && this.isRunning && sensorConfig.enabled !== false) {
      sensor.updateInterval(intervalMs);
    }
    
    this.logger.info(`Updated interval for '${sensorName}': ${intervalMs}ms`);
    this.emit('sensor-interval-updated', sensorName, intervalMs);
  }

  /**
   * Check if MQTT is connected
   */
  public isMqttConnected(): boolean {
    return this.mqttConnection?.isConnected() ?? false;
  }



  /**
   * Validate individual sensor configuration
   */
  protected validateSensorConfig(config: SensorConfig): void {
    // Check required fields
    if (!config.addr) {
      throw new Error(`Sensor '${config.name}': 'addr' is required`);
    }

    if (!config.eomDelimiter) {
      throw new Error(`Sensor '${config.name}': 'eomDelimiter' is required`);
    }

    if (!config.mqttTopic) {
      throw new Error(`Sensor '${config.name}': 'mqttTopic' is required`);
    }

    // Validate buffer capacity
    if (config.bufferCapacity && config.bufferCapacity < 1024) {
      throw new Error(`Sensor '${config.name}': 'bufferCapacity' must be at least 1024 bytes`);
    }

    // Validate regex
    try {
      new RegExp(config.eomDelimiter);
    } catch (error) {
      throw new Error(`Sensor '${config.name}': Invalid 'eomDelimiter' regex: ${config.eomDelimiter}`);
    }

    this.logger.debug(`Validated configuration for sensor '${config.name}'`);
  }
}
