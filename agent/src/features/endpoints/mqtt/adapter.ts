import { EventEmitter } from 'events';
import * as mqtt from 'mqtt';
import { SensorDataPoint, DeviceStatus, Logger } from '../types.js';
import { MqttAdapterConfig, MqttDevice } from './types.js';

/**
 * MQTT Adapter
 * 
 * Architecture: This adapter is socket-agnostic. It subscribes to MQTT topics
 * from external publishers (ESP32, PLCs, IoT devices) publishing to the local
 * Mosquitto broker and emits 'data' events with sensor readings. The parent
 * SensorsFeature manages SocketServer and routes data to the appropriate socket.
 * 
 * Pattern: Mosquitto broker acts as the ENDPOINT (data aggregation point),
 *          just like a Modbus gateway or OPC-UA server.
 * 
 * Events:
 * - 'started': Adapter started successfully
 * - 'stopped': Adapter stopped
 * - 'data': Emitted with SensorDataPoint[] when data is collected
 * - 'device-connected': Emitted when broker connects
 * - 'device-disconnected': Emitted when broker disconnects
 * - 'device-error': Emitted when an error occurs
 */
export class MqttAdapter extends EventEmitter {
  private config: MqttAdapterConfig;
  private logger: Logger;
  private client: mqtt.MqttClient | null = null;
  private subscriptions: Map<string, MqttDevice> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private running = false;
  private connected = false;

  constructor(config: MqttAdapterConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    
    this.initializeDeviceStatuses();
  }

  /**
   * Start the MQTT adapter - connect to broker and subscribe to topics
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    try {
      this.logger.debug('Starting MQTT Adapter...');

      // Connect to broker (endpoint)
      await this.connect();

      // Subscribe to all enabled devices/topics
      for (const device of this.config.devices) {
        if (device.enabled) {
          await this.subscribeToDevice(device);
        }
      }

      this.running = true;
      this.emit('started');
      this.logger.info('MQTT Adapter started successfully');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to start MQTT Adapter: ${errorMessage}`);
      await this.stop();
      throw error;
    }
  }

  /**
   * Stop the MQTT adapter
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      this.logger.debug('Stopping MQTT Adapter...');

      if (this.client) {
        this.client.end();
        this.client = null;
        this.connected = false;
      }

      this.subscriptions.clear();
      this.running = false;
      
      this.logger.debug('MQTT Adapter stopped successfully');
      this.emit('stopped');

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Error stopping MQTT Adapter: ${errorMessage}`);
    }
  }

  /**
   * Get status of all devices
   */
  getDeviceStatuses(): DeviceStatus[] {
    return Array.from(this.deviceStatuses.values());
  }

  /**
   * Get status of a specific device
   */
  getDeviceStatus(deviceName: string): DeviceStatus | undefined {
    return this.deviceStatuses.get(deviceName);
  }

  /**
   * Connect to MQTT broker (endpoint)
   */
  private async connect(): Promise<void> {
    const brokerUrl = `mqtt://${this.config.broker.host}:${this.config.broker.port}`;
    
    this.logger.info(`Connecting to MQTT broker endpoint: ${brokerUrl}`);

    this.client = mqtt.connect(brokerUrl, {
      clientId: this.config.broker.clientId || `iotistic-agent-${Date.now()}`,
      username: this.config.broker.username,
      password: this.config.broker.password,
      reconnectPeriod: this.config.reconnect.period,
      clean: true
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('MQTT connection timeout'));
      }, 30000);

      this.client!.on('connect', () => {
        clearTimeout(timeout);
        this.connected = true;
        
        this.logger.info(`MQTT broker connected: ${brokerUrl}`);
        this.emit('device-connected', 'mqtt-broker');
        
        resolve();
      });

      this.client!.on('error', (err) => {
        this.logger.error(`MQTT connection error: ${err.message}`);
        this.emit('device-error', 'mqtt-broker', err);
      });

      this.client!.on('offline', () => {
        this.connected = false;
        this.logger.warn('MQTT broker offline');
        this.emit('device-disconnected', 'mqtt-broker');
      });

      this.client!.on('reconnect', () => {
        this.logger.info('MQTT reconnecting to broker...');
      });

      // Handle incoming messages
      this.client!.on('message', (topic, payload) => {
        this.handleMessage(topic, payload);
      });
    });
  }

  /**
   * Subscribe to a device's topics
   */
  private async subscribeToDevice(device: MqttDevice): Promise<void> {
    if (!this.client || !this.connected) {
      throw new Error('MQTT client not connected');
    }

    const topic = device.topic;
    const qos = device.qos || this.config.qos;

    return new Promise((resolve, reject) => {
      this.client!.subscribe(topic, { qos }, (err) => {
        if (err) {
          this.logger.error(`Failed to subscribe to topic: ${topic} - ${err.message}`);
          reject(err);
          return;
        }

        this.subscriptions.set(topic, device);
        
        this.logger.info(`Subscribed to MQTT topic: ${topic} (QoS ${qos})`);
        resolve();
      });
    });
  }

  /**
   * Handle incoming MQTT message
   */
  private handleMessage(topic: string, payload: Buffer): void {
    const device = this.subscriptions.get(topic);
    if (!device) {
      this.logger.debug(`Received message for untracked topic: ${topic}`);
      return;
    }

    try {
      const value = this.parsePayload(payload, device.dataType);
      const now = new Date().toISOString();
      
      // Create sensor data point
      const dataPoint: SensorDataPoint = {
        deviceName: device.name,
        registerName: device.metric || topic,
        value,
        unit: device.unit || '',
        timestamp: now,
        quality: 'GOOD'
      };

      // Emit data event
      this.emit('data', [dataPoint]);

      // Update device status
      this.updateDeviceStatus(device.name, true);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to parse MQTT message from topic ${topic}: ${errorMessage}`);
      
      // Emit BAD quality data point
      const dataPoint: SensorDataPoint = {
        deviceName: device.name,
        registerName: device.metric || topic,
        value: null,
        unit: device.unit || '',
        timestamp: new Date().toISOString(),
        quality: 'BAD',
        qualityCode: 'PARSE_ERROR'
      };
      
      this.emit('data', [dataPoint]);
      this.updateDeviceStatus(device.name, false, errorMessage);
    }
  }

  /**
   * Parse MQTT payload based on dataType
   */
  private parsePayload(payload: Buffer, dataType: string): number | boolean | string {
    const str = payload.toString();

    // Try JSON first
    try {
      const json = JSON.parse(str);
      
      // If JSON object with 'value' key, extract it
      if (typeof json === 'object' && json.value !== undefined) {
        return this.coerceType(json.value, dataType);
      }
      
      return this.coerceType(json, dataType);
    } catch {
      // Not JSON, parse as plain text
      return this.coerceType(str, dataType);
    }
  }

  /**
   * Coerce value to expected dataType
   */
  private coerceType(value: any, dataType: string): number | boolean | string {
    switch (dataType) {
      case 'float':
      case 'float32':
      case 'double':
        return parseFloat(value);
      case 'int':
      case 'int16':
      case 'int32':
      case 'integer':
        return parseInt(value, 10);
      case 'uint16':
      case 'uint32':
        return Math.abs(parseInt(value, 10));
      case 'boolean':
        return value === 'true' || value === '1' || value === 1 || value === true;
      case 'string':
        return String(value);
      default:
        return value;
    }
  }

  /**
   * Initialize device statuses
   */
  private initializeDeviceStatuses(): void {
    for (const device of this.config.devices) {
      this.deviceStatuses.set(device.name, {
        deviceName: device.name,
        connected: false,
        lastPoll: null,
        lastSeen: null,
        errorCount: 0,
        lastError: null,
        responseTimeMs: null,
        pollSuccessRate: 0,
        registersUpdated: 0,
        communicationQuality: 'offline'
      });
    }
  }

  /**
   * Update device status
   */
  private updateDeviceStatus(deviceName: string, success: boolean, error?: string): void {
    const status = this.deviceStatuses.get(deviceName);
    if (!status) {
      return;
    }

    const now = new Date();
    status.lastPoll = now;

    if (success) {
      status.lastSeen = now;
      status.errorCount = 0;
      status.lastError = null;
      status.connected = true;
      status.communicationQuality = 'good';
      status.registersUpdated = 1;
      status.pollSuccessRate = 1.0;
    } else {
      status.errorCount++;
      status.lastError = error || 'Unknown error';
      status.connected = false;
      status.communicationQuality = 'poor';
      status.pollSuccessRate = 0;
    }
  }
}
