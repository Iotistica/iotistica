import * as net from 'net';
import { EventEmitter } from 'events';
import { createJsonPayload, createMsgpackPayload, serializePayload, logCompressionStats } from '../../mqtt/manager.js';
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
// MESSAGEPACK POC CONFIGURATION
// ============================================================================

/**
 * Enable MessagePack POC mode via environment variable
 * Set USE_MSGPACK_POC=true to test msgpack compression with logging
 */
const USE_MSGPACK_POC = process.env.USE_MSGPACK_POC === 'true';

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
  
  // Exponential backoff for initial connection attempts
  private readonly INITIAL_RETRY_DELAY_MS = 500;  // Start fast for startup race conditions
  private readonly MAX_FAST_RETRY_DELAY_MS = 8000; // Max 8s for fast retries
  private readonly FAST_RETRY_THRESHOLD = 5;       // After 5 attempts, use normal poll interval
  private currentRetryDelay: number;

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
    this.currentRetryDelay = this.INITIAL_RETRY_DELAY_MS;
    
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
    prefix = '',
    depth = 0,
    visited = new WeakSet()
  ): void {
    if (!anomalyService) return;

    // Prevent infinite recursion
    const MAX_DEPTH = 3;
    if (depth > MAX_DEPTH) {
      return;
    }

    // Prevent circular references
    if (typeof data === 'object' && data !== null) {
      if (visited.has(data)) {
        return;
      }
      visited.add(data);
    }

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
      // Handle individual reading objects (OPC-UA format)
      // Must check BEFORE Modbus array check to handle both formats
      if (
        !Array.isArray(data) &&
        data.deviceName &&
        (data.registerName || data.name) &&
        data.value !== undefined
      ) {
        const deviceName = data.deviceName;
        const fieldName = data.registerName || data.name;
        const value = data.value;
        const quality = data.quality || 'GOOD';
        
        // Feed if numeric value
        if (typeof value === 'number') {
          anomalyService.processDataPoint({
            source: 'endpoint',
            metric: `${deviceName}_${fieldName}`,
            value: value,
            unit: data.unit || this.inferUnit(fieldName),
            timestamp: timestampMs,
            quality: quality === 'GOOD' || quality === 'Good' ? 'GOOD' : 'BAD',
            deviceId: this.deviceUuid,
            tags: {
              sensorName,
              deviceName,
              fieldName,
            },
          });
        }
        return; // Don't recurse further into reading object
      }
      
      // Handle special case: Modbus "readings" array format
      if (Array.isArray(data) && prefix === 'readings') {
        // Process each reading in the array
        for (const reading of data) {
          if (typeof reading === 'object' && reading !== null) {
            const deviceName = reading.deviceName || sensorName;
            // Support both Modbus (registerName) and OPC-UA (name) formats
            const fieldName = reading.registerName || reading.name;
            const value = reading.value;
            const quality = reading.quality || 'GOOD';
            
            // Feed if we have both fieldName and numeric value
            if (fieldName && typeof value === 'number') {
              anomalyService.processDataPoint({
                source: 'endpoint',
                metric: `${deviceName}_${fieldName}`,
                value: value,
                unit: this.inferUnit(fieldName),
                timestamp: timestampMs,
                quality: quality === 'GOOD' || quality === 'Good' ? 'GOOD' : 'BAD',
                deviceId: this.deviceUuid,
                tags: {
                  sensorName,
                  deviceName,
                  fieldName,
                },
              });
            }
          }
        }
        return; // Don't recurse further into readings array
      }
      
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
        } else if (Array.isArray(value)) {
          // Handle arrays (e.g., "readings" array)
          this.extractNumericFields(value, sensorName, timestamp, key, depth + 1, visited);
        } else if (typeof value === 'object' && value !== null) {
          // Recurse into nested object (depth-limited)
          this.extractNumericFields(value, sensorName, timestamp, key, depth + 1, visited);
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
    this.currentRetryDelay = this.INITIAL_RETRY_DELAY_MS; // Reset for next disconnect
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
    
    // Check if appending data would exceed buffer capacity BEFORE concatenation
    // This prevents heap exhaustion from unbounded buffer growth
    if (this.buffer.length + data.length > this.config.bufferCapacity) {
      this.logger?.error(
        `Buffer capacity would be exceeded for endpoint '${this.getSensorName()}' ` +
        `(current: ${this.buffer.length}, incoming: ${data.length}, capacity: ${this.config.bufferCapacity}). ` +
        `Discarding buffer and starting fresh. This likely indicates missing/incorrect delimiter or extremely large messages.`
      );
      
      // Emergency: Clear buffer to prevent heap exhaustion
      // This is a hard reset - we lose unparsed data, but we prevent OOM crash
      this.buffer = Buffer.alloc(0);
      
      // Try to parse the new data alone (might contain complete messages)
      this.buffer = data;
      this.parseMessages();
      
      // If still too large after parsing, discard entirely
      if (this.buffer.length > this.config.bufferCapacity) {
        this.logger?.error(
          `Single chunk exceeds buffer capacity (${data.length} > ${this.config.bufferCapacity}), discarding`
        );
        this.buffer = Buffer.alloc(0);
      }
      return;
    }
    
    // Append to buffer (safe - we checked capacity above)
    this.buffer = Buffer.concat([this.buffer, data]);
    
    // Parse messages from buffer (this adds them to messageBatch)
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
      
      // Safety check: If incomplete message exceeds capacity, it's likely a delimiter mismatch
      // Discard it to prevent unbounded growth
      if (Buffer.byteLength(lastPart, 'utf8') > this.config.bufferCapacity) {
        this.logger?.error(
          `Incomplete message exceeds buffer capacity for endpoint '${this.getSensorName()}' ` +
          `(${Buffer.byteLength(lastPart, 'utf8')} > ${this.config.bufferCapacity}). ` +
          `This indicates incorrect delimiter or malformed data. Discarding incomplete message.`
        );
        this.buffer = Buffer.alloc(0);
      } else {
        this.buffer = Buffer.from(lastPart, 'utf8');
      }
      
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
    
    // Safety: Force publish if batch grows too large (prevent unbounded memory growth)
    // This happens if MQTT is down or publishing is failing
    const MAX_BATCH_MESSAGES = 10000; // Safety limit
    const MAX_BATCH_BYTES = 10 * 1024 * 1024; // 10MB safety limit
    
    if (this.messageBatch.messages.length >= MAX_BATCH_MESSAGES || 
        this.messageBatch.totalBytes >= MAX_BATCH_BYTES) {
      this.logger?.warn(
        `Message batch exceeds safety limits for endpoint '${this.getSensorName()}' ` +
        `(messages: ${this.messageBatch.messages.length}, bytes: ${this.messageBatch.totalBytes}). ` +
        `Force publishing to prevent memory exhaustion.`
      );
      this.publishBatch();
      return;
    }
    
    // Check if should publish batch immediately (buffer size reached)
    // Timer will handle time-based publishing (bufferTimeMs)
    const bufferSize = this.config.bufferSize ?? 0;
    const shouldPublish = bufferSize > 0 && this.messageBatch.messages.length >= bufferSize;
    
    if (shouldPublish) {
      this.publishBatch();
    }
  }

  /**
   * Enrich messages with anomaly scores from edge AI
   * Modifies readings in-place to add anomaly_score field
   */
  private enrichMessagesWithAnomalyScores(messages: any[]): any[] {
    if (!anomalyService) return messages;

    const sensorName = this.getSensorName();
    const enrichedMessages: any[] = [];

    for (const message of messages) {
      try {
        // Parse message if it's a string
        const data = typeof message === 'string' ? JSON.parse(message) : message;
        
        // Handle Modbus format: { readings: [...] }
        if (data.readings && Array.isArray(data.readings)) {
          for (const reading of data.readings) {
            if (typeof reading === 'object' && reading !== null) {
              const deviceName = reading.deviceName || sensorName;
              const fieldName = reading.registerName || reading.name;
              
              // Get anomaly score and metadata for this metric
              if (fieldName) {
                const metricName = `${deviceName}_${fieldName}`;
                const score = anomalyService.getAnomalyScore(metricName);
                const metadata = anomalyService.getAnomalyMetadata(metricName);
                
                // Only add score if it exists (metric is monitored)
                if (score !== undefined) {
                  reading.anomaly_score = score;
                  
                  // Add metadata for ML training and debugging
                  if (metadata) {
                    reading.anomaly_threshold = metadata.threshold;
                    reading.baseline_samples = metadata.samples;
                    reading.detection_methods = metadata.methods;
                  }
                }
              }
            }
          }
        }
        // Handle OPC-UA format: direct reading object (no readings array)
        else if (data.deviceName && (data.registerName || data.name) && data.value !== undefined) {
          const deviceName = data.deviceName;
          const fieldName = data.registerName || data.name;
          const metricName = `${deviceName}_${fieldName}`;
          const score = anomalyService.getAnomalyScore(metricName);
          const metadata = anomalyService.getAnomalyMetadata(metricName);
          
          // Only add score if it exists (metric is monitored)
          if (score !== undefined) {
            data.anomaly_score = score;
            
            // Add metadata for ML training and debugging
            if (metadata) {
              data.anomaly_threshold = metadata.threshold;
              data.baseline_samples = metadata.samples;
              data.detection_methods = metadata.methods;
            }
          }
        }
        
        // Return enriched message as object (for pretty MQTT display)
        enrichedMessages.push(data);
      } catch (error) {
        // If parsing fails, return original message unchanged
        enrichedMessages.push(message);
      }
    }

    return enrichedMessages;
  }

  /**
   * Publish message batch to MQTT
   */
  private async publishBatch(): Promise<void> {
    if (this.messageBatch.messages.length === 0) {
      return;
    }
    
    const isConnected = this.mqttConnection.isConnected();
    this.logger?.debug(`MQTT connection status: ${isConnected}`);
    
    // Build topic with device UUID (no leading $ - reserved for broker system topics)
    const topic = `iot/device/${this.deviceUuid}/endpoints/${this.config.mqttTopic}`;
    
    // Feed to edge AI anomaly detection FIRST (before publishing)
    // This ensures scores are available for enrichment
    if (anomalyService) {
      this.feedMessagesToAnomaly(this.messageBatch.messages);
    }
    
    // Enrich messages with anomaly scores from edge AI
    const enrichedMessages = this.enrichMessagesWithAnomalyScores(this.messageBatch.messages);
    
    // Publish as JSON array with enriched data
    // Messages are objects for MQTT Explorer pretty-printing
    // API handler will accept both objects and JSON strings
    const data = {
      sensor: this.getSensorName(),
      timestamp: new Date().toISOString(),
      messages: enrichedMessages
    };
    
    // If MQTT not connected, buffer to local database
    if (!isConnected) {
      this.logger?.warn(`MQTT not connected, buffering ${this.messageBatch.messages.length} messages from endpoint '${this.getSensorName()}'`);
      
      try {
        const { MessageBufferModel } = await import('../../db/models/index.js');
        
        // Buffer as JSON string (will be re-parsed on flush)
        const jsonPayload = JSON.stringify(data);
        await MessageBufferModel.enqueue({
          endpoint_name: this.getSensorName(),
          topic,
          qos: 1,
          payload: jsonPayload,
          payload_bytes: Buffer.byteLength(jsonPayload, 'utf8')
        });
        
        this.logger?.debug(`Buffered ${this.messageBatch.messages.length} messages to local database`);
        
        // Reset batch (data is safely buffered)
        this.messageBatch = {
          messages: [],
          totalBytes: 0,
          firstMessageTime: new Date()
        };
      } catch (error) {
        this.logger?.error(`Failed to buffer messages from endpoint '${this.getSensorName()}'`, error);
      }
      
      return;
    }
    
    try {
      // Use msgId for HA deduplication
      const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
      
      // POC: Use msgpack if enabled, otherwise JSON
      const mqttPayload = USE_MSGPACK_POC 
        ? createMsgpackPayload(data, msgIdGen)
        : createJsonPayload(data, msgIdGen);
      
      // Log compression stats for POC
      if (USE_MSGPACK_POC) {
        logCompressionStats(data, 'msgpack', this.logger, topic);
      }
      
      const serialized = serializePayload(mqttPayload);
      
      await this.mqttConnection.publish(topic, serialized, { qos: 1 });
      
      this.stats.messagesPublished += this.messageBatch.messages.length;
      this.stats.bytesPublished += this.messageBatch.totalBytes;
      this.stats.lastPublishTime = new Date();
      
      // Only log when messages were actually published
      if (this.messageBatch.messages.length > 0) {
        this.logger?.info(
          `Published ${this.messageBatch.messages.length} messages (${this.messageBatch.totalBytes} bytes) from '${this.getSensorName()}'`
        );
      }
      
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
   * Schedule reconnection attempt with exponential backoff for initial attempts
   * Uses fast retries (500ms → 8s) for first 5 attempts to handle startup race conditions,
   * then falls back to normal poll interval for steady-state operation
   */
  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    
    let delay: number;
    
    // Use exponential backoff for initial connection attempts (handles startup race conditions)
    if (this.stats.reconnectAttempts < this.FAST_RETRY_THRESHOLD) {
      delay = Math.min(this.currentRetryDelay, this.MAX_FAST_RETRY_DELAY_MS);
      this.currentRetryDelay *= 2; // Exponential backoff
      this.logger?.debug(
        `Fast reconnect for endpoint '${this.getSensorName()}' in ${delay}ms (attempt ${this.stats.reconnectAttempts + 1})`
      );
    } else {
      // After initial attempts, use normal poll interval
      delay = this.config.addrPollSec * 1000;
      this.logger?.debug(
        `Scheduling reconnect for endpoint '${this.getSensorName()}' in ${this.config.addrPollSec}s`
      );
    }
    
    this.reconnectTimer = setTimeout(() => {
      this.stats.reconnectAttempts++;
      this.connect();
    }, delay);
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
      const data = {
        endpoint: this.getSensorName(),
        timestamp: new Date().toISOString(),
        state: this.state,
        stats: this.stats
      };
      
      // Use msgId for HA deduplication even for heartbeats (QoS 0)
      const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
      const mqttPayload = createJsonPayload(data, msgIdGen);
      const payload = serializePayload(mqttPayload);
      
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
