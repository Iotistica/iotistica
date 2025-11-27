import * as net from 'net';
import { EventEmitter } from 'events';
import type { AnomalyDetectionService } from '../../ai/anomaly/index.js';
import {
  SensorConfig,
  SensorState,
  MqttConnection,
  Logger,
  SensorStats,
  MessageBatch
} from './types';

// ============================================================================
// EDGE AI ANOMALY DETECTION CONFIGURATION
// ============================================================================

let anomalyService: AnomalyDetectionService | undefined;

/**
 * Configure edge AI anomaly detection for sensor data
 * @param service - AnomalyDetectionService instance or undefined to disable
 */
export function configureAnomalyFeed(service: AnomalyDetectionService | undefined): void {
  anomalyService = service;
}

/**
 * Sensor - Manages connection to Unix domain socket and publishes sensor data
 */
export class Sensor extends EventEmitter {
  private config: SensorConfig;
  private mqttConnection: MqttConnection;
  private logger?: Logger;
  private deviceUuid: string;
  
  private state: SensorState = SensorState.DISCONNECTED;
  private socket: net.Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private bufferTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  
  private buffer: Buffer = Buffer.alloc(0);
  private messageBatch: MessageBatch = {
    messages: [],
    totalBytes: 0,
    firstMessageTime: new Date()
  };
  
  private stats: SensorStats = {
    messagesReceived: 0,
    messagesPublished: 0,
    bytesReceived: 0,
    bytesPublished: 0,
    reconnectAttempts: 0,
    lastError: undefined,
    lastErrorTime: undefined,
    lastConnectedTime: undefined
  };
  
  private delimiterRegex: RegExp;
  private needStop = false;

  constructor(
    config: SensorConfig,
    mqttConnection: MqttConnection,
    logger: Logger | undefined,
    deviceUuid: string
  ) {
    super();
    this.config = config;
    this.mqttConnection = mqttConnection;
    this.logger = logger;
    this.deviceUuid = deviceUuid;
    
    // Compile delimiter regex
    try {
      this.delimiterRegex = new RegExp(config.eomDelimiter, 'g');
    } catch (error) {
      throw new Error(`Invalid eom_delimiter regex: ${config.eomDelimiter}`);
    }
  }

  /**
   * Start the endpoint
   */
  public async start(): Promise<void> {
    if (!this.config.enabled) {
      this.logger?.info(`Endpoint '${this.getSensorName()}' is disabled`);
      return;
    }

    this.logger?.info(`Starting endpoint '${this.getSensorName()}'`);
    this.needStop = false;
    
    // Start heartbeat timer if configured
    if (this.config.mqttHeartbeatTopic) {
      this.startHeartbeatTimer();
    }
    
    // Initiate connection
    await this.connect();
  }

  /**
   * Stop the sensor
   */
  public async stop(): Promise<void> {
    this.logger?.info(`Stopping endpoint '${this.getSensorName()}'`);
    this.needStop = true;
    
    // Clear all timers
    this.clearReconnectTimer();
    this.clearBufferTimer();
    this.clearHeartbeatTimer();
    
    // Disconnect socket
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    
    // Publish remaining messages
    if (this.messageBatch.messages.length > 0) {
      await this.publishBatch();
    }
    
    this.state = SensorState.DISCONNECTED;
  }

  /**
   * Get sensor statistics
   */
  public getStats(): SensorStats {
    return { ...this.stats };
  }

  /**
   * Get current sensor state
   */
  public getState(): SensorState {
    return this.state;
  }

  /**
   * Update publish interval (for live configuration changes)
   */
  public updateInterval(intervalMs: number): void {
    if (intervalMs < 1000) {
      throw new Error(`Invalid interval: minimum 1000ms`);
    }

    this.config.publishInterval = intervalMs;
    this.logger?.info(`Updated interval for '${this.getSensorName()}': ${intervalMs}ms`);
    
    // Note: This updates the config but doesn't restart timers
    // The interval is used when batching, not for periodic publishing
    // For periodic publishing, you would need to restart buffer timer
  }

  /**
   * Get sensor name (from config or index-based)
   */
  private getSensorName(): string {
    return this.config.name || 'unknown';
  }

  /**
   * Feed sensor messages to anomaly detection
   * Extracts numeric values from all messages and feeds to AnomalyService
   */
  private feedMessagesToAnomaly(messages: any[]): void {
    if (!anomalyService) return;

    const timestamp = new Date();
    const sensorName = this.getSensorName();

    for (const message of messages) {
      try {
        // Parse message if it's a string
        const data = typeof message === 'string' ? JSON.parse(message) : message;

        // Extract all numeric fields and feed to anomaly detection
        this.extractNumericFields(data, sensorName, timestamp);
      } catch (error) {
        // Skip unparseable messages silently
        this.logger?.debug(
          `Could not parse sensor message for anomaly feed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Recursively extract numeric fields from sensor data
   * Handles nested objects and arrays
   */
  private extractNumericFields(
    data: any,
    sensorName: string,
    timestamp: Date,
    prefix = ''
  ): void {
    if (!anomalyService) return;

    const timestampMs = timestamp.getTime();

    if (typeof data === 'number') {
      // Direct numeric value
      const metricName = prefix || 'value';
      anomalyService.processDataPoint({
        source: 'endpoint',
        metric: `${sensorName}_${metricName}`,
        value: data,
        unit: this.inferUnit(metricName),
        timestamp: timestampMs,
        quality: 'GOOD',
        deviceId: this.deviceUuid,
        tags: {
          sensorName,
          field: metricName,
        },
      });
    } else if (typeof data === 'object' && data !== null) {
      // Object or array - recurse into nested fields
      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') {
          // Feed numeric field
          const metricName = prefix ? `${prefix}_${key}` : key;
          anomalyService.processDataPoint({
            source: 'sensor',
            metric: `${sensorName}_${metricName}`,
            value: value,
            unit: this.inferUnit(key),
            timestamp: timestampMs,
            quality: 'GOOD',
            deviceId: this.deviceUuid,
            tags: {
              sensorName,
              field: metricName,
            },
          });
        } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          // Recurse into nested object (max depth 2 to avoid deep nesting)
          if (!prefix) {
            this.extractNumericFields(value, sensorName, timestamp, key);
          }
        }
      }
    }
  }

  /**
   * Infer measurement unit from field name
   * Returns common units based on field name patterns
   */
  private inferUnit(fieldName: string): string {
    const lower = fieldName.toLowerCase();

    // Temperature
    if (lower.includes('temp') || lower.includes('temperature')) {
      return '°C';
    }

    // Humidity
    if (lower.includes('humid') || lower.includes('moisture')) {
      return '%';
    }

    // Pressure
    if (lower.includes('pressure') || lower.includes('baro')) {
      return 'hPa';
    }

    // Electrical
    if (lower.includes('voltage') || lower.includes('volt')) {
      return 'V';
    }
    if (lower.includes('current') || lower.includes('ampere') || lower.includes('amp')) {
      return 'A';
    }
    if (lower.includes('power') || lower.includes('watt')) {
      return 'W';
    }
    if (lower.includes('resistance') || lower.includes('ohm')) {
      return 'Ω';
    }

    // Gas/Air Quality
    if (lower.includes('co2') || lower.includes('carbon')) {
      return 'ppm';
    }
    if (lower.includes('gas') || lower.includes('voc') || lower.includes('iaq')) {
      return 'index';
    }

    // Light
    if (lower.includes('light') || lower.includes('lux') || lower.includes('illumin')) {
      return 'lux';
    }

    // Distance
    if (lower.includes('distance') || lower.includes('range')) {
      return 'cm';
    }

    // Speed
    if (lower.includes('speed') || lower.includes('velocity')) {
      return 'm/s';
    }

    // Percentage
    if (lower.includes('percent') || lower.includes('level') || lower.includes('battery')) {
      return '%';
    }

    // Default
    return 'value';
  }

  /**
   * Connect to Unix domain socket
   */
  private async connect(): Promise<void> {
    if (this.needStop) {
      return;
    }

    this.state = SensorState.CONNECTING;
    this.logger?.debug(`Connecting to endpoint '${this.getSensorName()}' at ${this.config.addr}`);
    
    try {
      this.socket = net.createConnection(this.config.addr);
      
      this.socket.on('connect', () => {
        this.onConnect();
      });
      
      this.socket.on('data', (data: Buffer) => {
        this.onData(data);
      });
      
      this.socket.on('error', (error: Error) => {
        this.onError(error);
      });
      
      this.socket.on('close', () => {
        this.onClose();
      });
      
    } catch (error) {
      this.logger?.error('Failed to create socket connection', error);
      this.scheduleReconnect();
    }
  }

  /**
   * Handle socket connection
   */
  private onConnect(): void {
    this.logger?.info(`Connected to endpoint '${this.getSensorName()}'`);
    this.state = SensorState.CONNECTED;
    this.stats.reconnectAttempts = 0;
    this.stats.lastConnectedTime = new Date();
    // Keep lastError for debugging - don't clear it on successful connection
    // This allows us to see what errors occurred before connection succeeded
    
    // Start buffer timer if configured
    if (this.config.bufferTimeMs > 0) {
      this.startBufferTimer();
    }
    
    this.emit('connected');
  }

  /**
   * Handle incoming data from socket
   */
  private onData(data: Buffer): void {
    this.stats.bytesReceived += data.length;
    this.logger?.info(`Received ${data.length} bytes from endpoint '${this.getSensorName()}'`);
    
    // Append to buffer
    this.buffer = Buffer.concat([this.buffer, data]);
    
    // Check if buffer capacity exceeded
    if (this.buffer.length > this.config.bufferCapacity) {
      this.logger?.warn(`Buffer capacity exceeded for endpoint '${this.getSensorName()}', publishing batch`);
      this.publishBatch();
      return;
    }
    
    // Parse messages from buffer
    this.parseMessages();
  }

  /**
   * Parse messages from buffer using delimiter
   */
  private parseMessages(): void {
    const bufferStr = this.buffer.toString('utf8');
    const parts = bufferStr.split(this.delimiterRegex);
    
    // Keep the last part (incomplete message) in buffer
    if (parts.length > 0) {
      const lastPart = parts[parts.length - 1];
      this.buffer = Buffer.from(lastPart, 'utf8');
      
      // Process complete messages (all except last)
      for (let i = 0; i < parts.length - 1; i++) {
        const message = parts[i];
        if (message.length > 0) {
          this.addMessageToBatch(message);
        }
      }
    }
  }

  /**
   * Add message to batch
   */
  private addMessageToBatch(message: string): void {
    // Check if message exceeds buffer capacity
    if (Buffer.byteLength(message, 'utf8') > this.config.bufferCapacity) {
      this.logger?.error('Message size exceeds buffer capacity, discarding message');
      return;
    }
    
    // Initialize batch timestamp if first message
    if (this.messageBatch.messages.length === 0) {
      this.messageBatch.firstMessageTime = new Date();
    }
    
    this.messageBatch.messages.push(message);
    this.messageBatch.totalBytes += Buffer.byteLength(message, 'utf8');
    this.stats.messagesReceived++;
    
    // Check if should publish batch immediately (buffer size reached)
    // Timer will handle time-based publishing (bufferTimeMs)
    const bufferSize = this.config.bufferSize ?? 0;
    const shouldPublish = bufferSize > 0 && this.messageBatch.messages.length >= bufferSize;
    
    if (shouldPublish) {
      this.publishBatch();
    }
  }

  /**
   * Publish message batch to MQTT
   */
  private async publishBatch(): Promise<void> {
    if (this.messageBatch.messages.length === 0) {
      return;
    }
    
    if (!this.mqttConnection.isConnected()) {
      this.logger?.warn(`MQTT not connected, cannot publish batch from endpoint '${this.getSensorName()}'`);
      return;
    }
    
    try {
      // Build topic with device UUID (no leading $ - reserved for broker system topics)
      const topic = `iot/device/${this.deviceUuid}/endpoints/${this.config.mqttTopic}`;
      
      // Publish as JSON array
      const payload = JSON.stringify({
        sensor: this.getSensorName(),
        timestamp: new Date().toISOString(),
        messages: this.messageBatch.messages
      });
      
      await this.mqttConnection.publish(topic, payload, { qos: 1 });
      
      // Feed to edge AI anomaly detection if configured
      // Device processes all sensor data locally with ML
      if (anomalyService) {
        this.feedMessagesToAnomaly(this.messageBatch.messages);
      }
      
      this.stats.messagesPublished += this.messageBatch.messages.length;
      this.stats.bytesPublished += this.messageBatch.totalBytes;
      this.stats.lastPublishTime = new Date();
      
      this.logger?.debug(
        `Published ${this.messageBatch.messages.length} messages (${this.messageBatch.totalBytes} bytes) from sensor '${this.getSensorName()}'`
      );
      
      // Reset batch
      this.messageBatch = {
        messages: [],
        totalBytes: 0,
        firstMessageTime: new Date()
      };
      
    } catch (error) {
      this.logger?.error(`Failed to publish batch from endpoint '${this.getSensorName()}'`, error);
    }
  }

  /**
   * Handle socket error
   */
  private onError(error: Error): void {
    this.logger?.error(`Socket error for endpoint '${this.getSensorName()}'`, error);
    this.state = SensorState.ERROR;
    this.stats.lastError = error.message;
    this.stats.lastErrorTime = new Date();
    this.emit('error', error);
    // Note: Don't schedule reconnect here - onClose() will be called next and handle reconnection
  }

  /**
   * Handle socket close
   */
  private onClose(): void {
    this.logger?.info(`Connection closed for endpoint '${this.getSensorName()}'`);
    this.state = SensorState.DISCONNECTED;
    this.socket = null;
    
    // Publish remaining messages
    if (this.messageBatch.messages.length > 0) {
      this.publishBatch();
    }
    
    // Schedule reconnect if not stopping
    if (!this.needStop) {
      this.scheduleReconnect();
    }
    
    this.emit('disconnected');
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    
    const pollInterval = this.config.addrPollSec * 1000;
    this.logger?.debug(`Scheduling reconnect for endpoint '${this.getSensorName()}' in ${this.config.addrPollSec}s`);
    
    this.reconnectTimer = setTimeout(() => {
      this.stats.reconnectAttempts++;
      this.connect();
    }, pollInterval);
  }

  /**
   * Start buffer timer
   */
  private startBufferTimer(): void {
    this.clearBufferTimer();
    
    this.bufferTimer = setInterval(() => {
      if (this.messageBatch.messages.length > 0) {
        this.publishBatch();
      }
    }, this.config.bufferTimeMs);
  }

  /**
   * Start heartbeat timer
   */
  private startHeartbeatTimer(): void {
    this.clearHeartbeatTimer();
    
    this.heartbeatTimer = setInterval(() => {
      this.publishHeartbeat();
    }, this.config.heartbeatTimeSec * 1000);
    
    // Send initial heartbeat
    this.publishHeartbeat();
  }

  /**
   * Publish heartbeat message
   */
  private async publishHeartbeat(): Promise<void> {
    if (!this.config.mqttHeartbeatTopic) {
      return;
    }
    
    // Only send heartbeat if connected to sensor
    if (this.state !== SensorState.CONNECTED) {
      return;
    }
    
    if (!this.mqttConnection.isConnected()) {
      return;
    }
    
    try {
      const topic = `iot/device/${this.deviceUuid}/endpoints/${this.config.mqttHeartbeatTopic}`;
      const payload = JSON.stringify({
        sensor: this.getSensorName(),
        timestamp: new Date().toISOString(),
        state: this.state,
        stats: this.stats
      });
      
      await this.mqttConnection.publish(topic, payload, { qos: 0 });
      
      this.stats.lastHeartbeatTime = new Date();
      this.logger?.debug(`Published heartbeat for endpoint '${this.getSensorName()}'`);
      
    } catch (error) {
      this.logger?.error(`Failed to publish heartbeat for endpoint '${this.getSensorName()}'`, error);
    }
  }

  /**
   * Clear reconnect timer
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Clear buffer timer
   */
  private clearBufferTimer(): void {
    if (this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  /**
   * Clear heartbeat timer
   */
  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
