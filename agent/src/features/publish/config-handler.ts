import { SensorPublishFeature } from './sensor-publish-feature';
import { Logger } from './types';

export interface SensorConfig {
  enabled: boolean;
  addr: string;
  publishInterval: number;
}

export interface SensorConfigUpdate {
  sensors: {
    [sensorName: string]: Partial<SensorConfig>;
  };
}

/**
 * Handles sensor configuration updates from Shadow
 * 
 * Listens for delta events from Shadow feature and applies
 * sensor configuration changes (enable/disable, intervals)
 */
export class SensorConfigHandler {
  private logger?: Logger;

  constructor(
    private sensorPublishFeature: SensorPublishFeature,
    logger?: Logger
  ) {
    this.logger = logger;
  }
  
  /**
   * Start listening for delta events
   */
  public start(): void {

    
    this.logger?.info('Started listening for sensor config updates');
  }
  
  /**
   * Handle delta from cloud
   */
  private async handleDelta(delta: any): Promise<void> {
    this.logger?.info('Received configuration update from cloud');
    
    try {
      if (!delta.sensors) {
        this.logger?.debug('No sensor configuration changes in delta');
        return;
      }
      
      this.logger?.debug('Delta contains sensor updates');
      
      // Validate configuration before applying
      this.validateSensorConfig(delta.sensors);
      
      // Apply changes
      await this.applySensorConfig(delta.sensors);
      
      // Report back actual state
      const currentConfig = await this.getCurrentSensorConfig();
      
      this.logger?.info('Sensor configuration applied and reported');
      
    } catch (error) {
      this.logger?.error('Failed to apply sensor configuration', error);
      
    }
  }
  
  /**
   * Validate sensor configuration
   */
  private validateSensorConfig(sensors: any): void {
    for (const [sensorName, config] of Object.entries(sensors)) {
      if (typeof config !== 'object' || config === null) {
        throw new Error(`Invalid configuration for ${sensorName}: must be an object`);
      }
      
      const sensorConfig = config as any;
      
      // Validate interval
      if (sensorConfig.publishInterval !== undefined) {
        if (typeof sensorConfig.publishInterval !== 'number') {
          throw new Error(`Invalid publishInterval for ${sensorName}: must be a number`);
        }
        
        if (sensorConfig.publishInterval < 1000) {
          throw new Error(`Invalid publishInterval for ${sensorName}: minimum 1000ms (1 second)`);
        }
        
        if (sensorConfig.publishInterval > 3600000) {
          throw new Error(`Invalid publishInterval for ${sensorName}: maximum 3600000ms (1 hour)`);
        }
      }
      
      // Validate enabled flag
      if (sensorConfig.enabled !== undefined && typeof sensorConfig.enabled !== 'boolean') {
        throw new Error(`Invalid enabled flag for ${sensorName}: must be boolean`);
      }
    }
    
    this.logger?.debug('Configuration validation passed');
  }
  
  /**
   * Apply sensor configuration changes
   */
  private async applySensorConfig(sensors: any): Promise<void> {
    for (const [sensorName, config] of Object.entries(sensors)) {
      if (typeof config !== 'object' || config === null) continue;
      
      const sensorConfig = config as Partial<SensorConfig>;
      
      // Enable/disable sensor
      if (sensorConfig.enabled !== undefined) {
        if (sensorConfig.enabled) {
          await this.sensorPublishFeature.enableSensor(sensorName);
          this.logger?.info(`Enabled sensor: ${sensorName}`);
        } else {
          await this.sensorPublishFeature.disableSensor(sensorName);
          this.logger?.info(`Disabled sensor: ${sensorName}`);
        }
      }
      
      // Update publish interval
      if (sensorConfig.publishInterval !== undefined) {
        await this.sensorPublishFeature.updateInterval(sensorName, sensorConfig.publishInterval);
        this.logger?.info(`Updated interval for ${sensorName}: ${sensorConfig.publishInterval}ms`);
      }
    }
  }
  
  /**
   * Get current sensor configuration for reporting
   */
  private async getCurrentSensorConfig(): Promise<any> {
    const sensors = this.sensorPublishFeature.getSensors();
    const stats = this.sensorPublishFeature.getStats();
    
    const sensorConfig: any = {};
    
    for (const sensor of sensors) {
      const sensorStats = stats[sensor.name] || {};
      
      sensorConfig[sensor.name] = {
        enabled: sensor.enabled,
        addr: sensor.addr,
        publishInterval: sensor.publishInterval,
        status: sensor.enabled ? (sensorStats.connected ? 'connected' : 'disconnected') : 'disabled',
        lastPublish: sensorStats.lastPublishTime || null,
        metrics: {
          publishCount: sensorStats.publishCount || 0,
          errorCount: sensorStats.errorCount || 0,
          lastError: sensorStats.lastError || null
        }
      };
    }
    
    return {
      sensors: sensorConfig,
      mqtt: {
        broker: process.env.MQTT_BROKER || 'mqtt://mosquitto:1883',
        connected: this.sensorPublishFeature.isMqttConnected(),
      },
      system: {
        uptime: process.uptime(),
        version: process.env.npm_package_version || '1.0.0',
        timestamp: new Date().toISOString()
      }
    };
  }
}
