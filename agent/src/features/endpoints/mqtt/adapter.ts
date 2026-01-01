import { EventEmitter } from 'events';
import * as mqtt from 'mqtt';
import * as mqttPattern from 'mqtt-pattern';
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
  private static readonly MAX_QUEUE_DEPTH = 1000; // Backpressure threshold
  
  private config: MqttAdapterConfig;
  private logger: Logger;
  private client: mqtt.MqttClient | null = null;
  private subscriptions: Map<string, MqttDevice> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private running = false;
  private connected = false;
  private emitQueueDepth = 0;
  private droppedMessageCount = 0;

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
    
    // Generate stable clientId for persistent sessions (critical for edge agents)
    const stableClientId = this.config.broker.clientId || `iotistic-agent-${process.env.DEVICE_UUID || 'unknown'}`;
    
    this.logger.info(`Connecting to MQTT broker endpoint: ${brokerUrl}`, { clientId: stableClientId });

    this.client = mqtt.connect(brokerUrl, {
      clientId: stableClientId,
      username: this.config.broker.username,
      password: this.config.broker.password,
      reconnectPeriod: this.config.reconnect.period,
      clean: false, // Persistent session: survive reconnects, keep subscriptions, replay QoS 1 messages
      keepalive: 60,
      will: {
        topic: `device/${stableClientId}/status`,
        payload: Buffer.from('offline'),
        qos: 1,
        retain: true
      }
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
      // Note: MQTT callback signature includes packet metadata (retain flag, qos, etc.)
      this.client!.on('message', (topic, payload, packet) => {
        this.handleMessage(topic, payload, packet.retain);
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
   * Find device config for incoming topic (supports MQTT wildcards: +, #)
   * Uses mqtt-pattern library for proper wildcard matching
   */
  private findDeviceForTopic(topic: string): MqttDevice | undefined {
    for (const [filter, device] of this.subscriptions.entries()) {
      if (mqttPattern.matches(filter, topic)) {
        return device;
      }
    }
    return undefined;
  }

  /**
   * Handle incoming MQTT message
   * 
   * @param topic - MQTT topic
   * @param payload - Message payload
   * @param retain - Retained message flag (true = stale/historical data)
   */
  private handleMessage(topic: string, payload: Buffer, retain: boolean = false): void {
    // Backpressure guard: Drop messages if downstream can't keep up
    if (this.emitQueueDepth > MqttAdapter.MAX_QUEUE_DEPTH) {
      this.droppedMessageCount++;
      if (this.droppedMessageCount % 100 === 1) {
        this.logger.warn('Dropping MQTT messages due to backpressure', {
          queueDepth: this.emitQueueDepth,
          droppedTotal: this.droppedMessageCount,
          topic
        });
      }
      return;
    }

    const device = this.findDeviceForTopic(topic);
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
        // Retained messages are stale - mark as UNCERTAIN (age unknown)
        quality: retain ? 'UNCERTAIN' : 'GOOD',
        ...(retain && { qualityCode: 'RETAINED_MESSAGE' })
      };

      // Emit data event with backpressure tracking
      this.emitQueueDepth++;
      this.emit('data', [dataPoint]);
      setImmediate(() => this.emitQueueDepth--);

      // Only track message activity for fresh (non-retained) messages
      if (!retain) {
        this.trackMessageActivity(device.name);
      } else {
        this.logger.debug(`Retained message ignored for device health tracking`, {
          topic,
          deviceName: device.name
        });
      }

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
      // Note: Don't mark as "disconnected" - parsing errors don't mean device is offline
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
   * 
   * Supports both:
   * - Broad types from discovery: 'number', 'boolean', 'string', 'json'
   * - Specific types from manual config: 'int32', 'float32', 'uint32'
   * 
   * Note: Discovery returns broad types for safety. Users confirm specific types manually.
   */
  private coerceType(value: any, dataType: string): number | boolean | string {
    switch (dataType) {
      case 'number':  // Broad category from discovery
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
      case 'json':    // Broad category from discovery
      case 'string':
        return String(value);
      default:
        return value;
    }
  }

  /**
   * Initialize device statuses
   * 
   * Note: MQTT devices don't have persistent connections like Modbus/OPC-UA.
   * Connection state should be inferred from:
   * - lastSeen timestamp (message recency)
   * - Last Will and Testament (LWT) messages
   * - Application-specific staleness thresholds
   */
  private initializeDeviceStatuses(): void {
    for (const device of this.config.devices) {
      this.deviceStatuses.set(device.name, {
        deviceName: device.name,
        connected: false, // MQTT: Use LWT or staleness logic to determine this
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
   * Track message activity (not connection state)
   * 
   * For MQTT devices:
   * - Message arrival ≠ device connected
   * - Devices may publish once per hour and sleep
   * - "Connected" state should be inferred from lastSeen + staleness threshold
   * - Use Last Will and Testament (LWT) for definitive offline detection
   */
  private trackMessageActivity(deviceName: string): void {
    const status = this.deviceStatuses.get(deviceName);
    if (!status) {
      return;
    }

    const now = new Date();
    status.lastSeen = now;
    status.lastPoll = now;
    status.registersUpdated = (status.registersUpdated || 0) + 1;
    
    // Note: Don't set connected=true here
    // Let higher-level logic decide connectivity based on:
    // - Time since lastSeen (staleness)
    // - LWT messages
    // - Application requirements
  }
}
