import * as net from 'net';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { deflate as zlibDeflate } from 'zlib';
import { getHeapStatistics } from 'v8';
import { createJsonPayload, createMsgpackPayload, serializePayload, logCompressionStats, MqttManager } from '../../mqtt/manager.js';
import type { AnomalyDetectionService } from '../../ai/anomaly/index.js';
import { getCpuUsage } from '../../system/metrics.js';
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

/**
 * Enable DEFLATE compression as final compression layer
 * Set USE_DEFLATE_COMPRESSION=true to enable zlib deflate compression
 */
const USE_DEFLATE_POC = process.env.USE_DEFLATE_COMPRESSION === 'true';

/**
 * Enable detailed CPU usage tracking for compression layers
 * Set HEAP_METRICS=true to enable process.cpuUsage() calls (adds syscall overhead)
 * When disabled, CPU usage tracking is sampled (every 100th publish)
 */
const HEAP_METRICS_ENABLED = process.env.HEAP_METRICS === 'true';

/**
 * Async deflate (non-blocking, uses thread pool)
 */
const deflateAsync = promisify(zlibDeflate);

/**
 * Adaptive batch safety limits - prevent OOM on edge devices
 * Tie limits to available memory, not hardcoded constants
 * 
 * Calculated once at module load:
 * - MAX_BATCH_BYTES: Lesser of 10MB OR 5% of heap_size_limit
 * - MAX_BATCH_MESSAGES: Fixed at 10000 (count-based safety)
 * 
 * Example heap limits:
 * - Raspberry Pi (512MB heap): 5% = 25.6MB → capped at 10MB ✅
 * - Raspberry Pi (256MB heap): 5% = 12.8MB → capped at 10MB ✅
 * - Raspberry Pi (128MB heap): 5% = 6.4MB → uses 6.4MB ✅
 * - Cloud server (4GB heap): 5% = 204MB → capped at 10MB ✅
 */
const MAX_BATCH_MESSAGES = 10000; // Fixed count limit
const MAX_BATCH_BYTES = (() => {
  const heapLimit = getHeapStatistics().heap_size_limit;
  const fivePercent = Math.floor(heapLimit * 0.05);
  const tenMB = 10 * 1024 * 1024;
  const limit = Math.min(tenMB, fivePercent);
  
  // Log calculated limit for visibility
  console.log(`[Sensor] Adaptive batch limit: ${(limit / (1024 * 1024)).toFixed(2)}MB (heap: ${(heapLimit / (1024 * 1024)).toFixed(0)}MB)`);
  
  return limit;
})();

/**
 * Adaptive deflate policy - only compress when beneficial
 * Prevents event loop blocking on edge devices (Raspberry Pi, etc.)
 * 
 * Criteria:
 * - Payload size > 4KB (small payloads don't benefit from compression)
 * - CPU load < 70% (avoid compression when device is busy)
 * - Network cost is high (if we can measure it, prefer compression over bandwidth)
 * 
 * @param payloadSize - Payload size in bytes
 * @param cpuLoad - Current CPU load (0-100)
 * @returns true if deflate should be applied
 */
function shouldDeflate(payloadSize: number, cpuLoad: number): boolean {
  const MIN_PAYLOAD_SIZE = 4 * 1024; // 4KB threshold
  const MAX_CPU_LOAD = 70; // 70% CPU threshold
  
  return payloadSize > MIN_PAYLOAD_SIZE && cpuLoad < MAX_CPU_LOAD;
}

/**
 * Check if CPU usage should be tracked for this publish
 * OPTIMIZATION: Reduces syscall overhead by sampling every 100th publish
 * Always tracks if HEAP_METRICS=true (for debugging/profiling)
 * 
 * @param publishCount - Total number of publishes (stats.messagesPublished)
 * @returns true if CPU usage should be tracked
 */
function shouldTrackCpuUsage(publishCount: number): boolean {
  return HEAP_METRICS_ENABLED || (publishCount % 100) === 0;
}

/**
 * Compression information for logging and metrics
 */
interface CompressionInfo {
  method: 'json' | 'json+deflate' | 'msgpack' | 'msgpack+deflate' | 'dictionary' | 'dictionary+msgpack' | 'dictionary+deflate' | 'dictionary+msgpack+deflate';
  originalSize: number;
  compressedSize: number;
  ratio: number; // Percentage saved (0-100)
  compressionMs: number; // Wall-clock time taken for compression in milliseconds
  cpuUsage?: {
    // CPU time = actual CPU cycles consumed (can be < wall-clock time due to I/O waits)
    // Values are in MICROSECONDS (1ms = 1000μs)
    // user = time in user-mode code (your JavaScript), system = time in kernel (system calls, I/O)
    // SAMPLING: Only populated when HEAP_METRICS=true or every 100th publish
    dictionary?: { user: number; system: number }; // CPU μs for dictionary field compression
    msgpack?: { user: number; system: number }; // CPU μs for msgpack binary serialization
    deflate?: { user: number; system: number }; // CPU μs for zlib DEFLATE compression
    total?: { user: number; system: number }; // Total CPU μs (sum of all layers) - optional when sampling
  };
}

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
  private protocol?: string; // Protocol context (modbus, snmp, opcua)
  
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
  private dictionaryManager?: any; // Dictionary manager for MQTT message key compaction
  
  // Compression configuration (set at initialization)
  private readonly useMsgpackPoc: boolean;
  private readonly useKeyCompactionPoc: boolean;
  private readonly useDeflatePoc: boolean;
  
  // Exponential backoff for initial connection attempts
  private readonly INITIAL_RETRY_DELAY_MS = 500;  // Start fast for startup race conditions
  private readonly MAX_FAST_RETRY_DELAY_MS = 8000; // Max 8s for fast retries
  private readonly FAST_RETRY_THRESHOLD = 5;       // After 5 attempts, use normal poll interval
  private currentRetryDelay: number;

  constructor(
    config: SensorConfig,
    mqttConnection: MqttConnection,
    logger: Logger | undefined,
    deviceUuid: string,
    dictionaryManager?: any, // Optional dictionary manager for key compaction
    useMsgpackPoc: boolean = false, // Enable MessagePack compression POC
    useKeyCompactionPoc: boolean = false, // Enable dictionary key compaction POC
    useDeflatePoc: boolean = false, // Enable DEFLATE compression POC
    protocol?: string  // Protocol context (modbus, snmp, opcua, etc)
  ) {
    super();
    this.config = config;
    this.mqttConnection = mqttConnection;
    this.logger = logger;
    this.deviceUuid = deviceUuid;
    this.protocol = protocol;
    this.dictionaryManager = dictionaryManager;
    this.useMsgpackPoc = useMsgpackPoc;
    this.useKeyCompactionPoc = useKeyCompactionPoc;
    this.useDeflatePoc = useDeflatePoc;
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
   * OPTIMIZATION: Messages are now pre-parsed objects (parsed once in addMessageToBatch)
   */
  private feedMessagesToAnomaly(messages: any[]): void {
    if (!anomalyService) return;

    const timestamp = new Date();
    const sensorName = this.getSensorName();

    for (const data of messages) {
      // Messages are already parsed objects (no JSON.parse needed)
      // Extract all numeric fields and feed to anomaly detection
      this.extractNumericFields(data, sensorName, timestamp);
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
    visited = new WeakSet(),
    processedMetrics = new Set<string>() // Track processed metrics to avoid duplicates
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
      const fullMetricName = `${sensorName}_${metricName}`;
      
      // Skip if already processed (prevents duplicates from nested parsing)
      if (processedMetrics.has(fullMetricName)) {
        return;
      }
      processedMetrics.add(fullMetricName);
      
      anomalyService.processDataPoint({
        source: 'endpoint',
        metric: fullMetricName,
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
        (data.metric || data.name) &&
        data.value !== undefined
      ) {
        const deviceName = data.deviceName;
        const fieldName = data.metric || data.name;
        const value = data.value;
        const quality = data.quality || 'GOOD';
        
        // Feed if numeric value
        if (typeof value === 'number') {
          const fullMetricName = `${deviceName}_${fieldName}`;
          
          // Skip if already processed
          if (processedMetrics.has(fullMetricName)) {
            return;
          }
          processedMetrics.add(fullMetricName);
          
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
            // Support metric field (standard) or name field (legacy OPC-UA)
            const fieldName = reading.metric || reading.name;
            const value = reading.value;
            const quality = reading.quality || 'GOOD';
            
            // Feed if we have both fieldName and numeric value
            if (fieldName && typeof value === 'number') {
              const fullMetricName = `${deviceName}_${fieldName}`;
              
              // Skip if already processed
              if (processedMetrics.has(fullMetricName)) {
                continue;
              }
              processedMetrics.add(fullMetricName);
              
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
          const fullMetricName = `${sensorName}_${metricName}`;
          
          // Skip if already processed
          if (processedMetrics.has(fullMetricName)) {
            continue;
          }
          processedMetrics.add(fullMetricName);
          
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
          this.extractNumericFields(value, sensorName, timestamp, key, depth + 1, visited, processedMetrics);
        } else if (typeof value === 'object' && value !== null) {
          // Recurse into nested object (depth-limited)
          this.extractNumericFields(value, sensorName, timestamp, key, depth + 1, visited, processedMetrics);
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
   * OPTIMIZATION: Parse JSON once here to avoid duplicate parsing in:
   * - feedMessagesToAnomaly() (was parsing each message)
   * - enrichMessagesWithAnomalyScores() (was parsing each message)
   * This eliminates 50% of JSON parsing CPU (1 parse instead of 2)
   */
  private addMessageToBatch(message: string): void {
    // Check if message exceeds buffer capacity
    if (Buffer.byteLength(message, 'utf8') > this.config.bufferCapacity) {
      this.logger?.error('Message size exceeds buffer capacity, discarding message');
      return;
    }
    
    // Parse JSON once (will be reused by anomaly detection + enrichment)
    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch (error) {
      this.logger?.warn(
        `Failed to parse JSON message from '${this.getSensorName()}', discarding: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
      return; // Skip invalid JSON
    }
    
    // Initialize batch timestamp if first message
    if (this.messageBatch.messages.length === 0) {
      this.messageBatch.firstMessageTime = new Date();
    }
    
    // Store parsed object (not raw string)
    this.messageBatch.messages.push(parsed);
    this.messageBatch.totalBytes += Buffer.byteLength(message, 'utf8');
    this.stats.messagesReceived++;
    
    // Safety: Force publish if batch grows too large (prevent unbounded memory growth)
    // This happens if MQTT is down or publishing is failing
    // Limits are adaptive based on available heap (see MAX_BATCH_BYTES calculation)
    if (this.messageBatch.messages.length >= MAX_BATCH_MESSAGES || 
        this.messageBatch.totalBytes >= MAX_BATCH_BYTES) {
      this.logger?.warn(
        `Message batch exceeds safety limits for endpoint '${this.getSensorName()}' ` +
        `(messages: ${this.messageBatch.messages.length}, bytes: ${this.messageBatch.totalBytes}, ` +
        `limits: ${MAX_BATCH_MESSAGES} msgs / ${(MAX_BATCH_BYTES / (1024 * 1024)).toFixed(1)}MB). ` +
        `Force publishing to prevent memory exhaustion.`
      );
      this.publishBatch();
      return;
    }
    
    // Check publish strategy
    const bufferSize = this.config.bufferSize ?? 0;
    const bufferTimeMs = this.config.bufferTimeMs ?? 0;
    const shouldPublishNow = bufferSize <= 0 && bufferTimeMs <= 0;
    const shouldPublishBySize = bufferSize > 0 && this.messageBatch.messages.length >= bufferSize;

    // If no buffering configured, publish immediately to avoid stuck batches
    if (shouldPublishNow) {
      this.publishBatch();
      return;
    }

    // Publish when size threshold reached; timer handles time-based flush
    if (shouldPublishBySize) {
      this.publishBatch();
    }
  }

  /**
   * Enrich messages with anomaly scores and forecasts from edge AI
   * Adds: anomaly_score, anomaly_threshold, baseline_samples, detection_methods,
   *       predicted_next, trend, trend_strength, forecast_confidence, time_to_threshold
   * OPTIMIZATION: Messages are now pre-parsed objects (parsed once in addMessageToBatch)
   */
  private enrichMessagesWithAnomalyScores(messages: any[]): any[] {
    if (!anomalyService) return messages;

    const sensorName = this.getSensorName();
    const enrichedMessages: any[] = [];
    
    // Get predictions once for all readings (cached by anomaly service)
    // Note: getPredictions() is available via getSummaryForReport() internally
    const predictions: Record<string, any> = {};

    for (const data of messages) {
      // Messages are already parsed objects (no JSON.parse needed)
        
        // Handle Modbus format: { readings: [...] }
        if (data.readings && Array.isArray(data.readings)) {
          for (const reading of data.readings) {
            if (typeof reading === 'object' && reading !== null) {
              const deviceName = reading.deviceName || sensorName;
              const fieldName = reading.registerName || reading.metric;
              
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
                  
                  // Add forecasts if available (trend, next prediction, time-to-threshold)
                  if (predictions && predictions[metricName]) {
                    const prediction = predictions[metricName];
                    reading.predicted_next = prediction.predicted_next;
                    reading.trend = prediction.trend;
                    reading.trend_strength = prediction.trend_strength;
                    reading.forecast_confidence = prediction.confidence;
                    
                    // Attach time-to-threshold if available (threshold breach prediction)
                    if (prediction.time_to_threshold) {
                      reading.time_to_threshold = prediction.time_to_threshold;
                    }
                  }
                }
              }
            }
          }
        }
        // Handle OPC-UA format: direct reading object (no readings array)
        else if (data.deviceName && (data.registerName || data.metric) && data.value !== undefined) {
          const deviceName = data.deviceName;
          const fieldName = data.registerName || data.metric;
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
            
            // Add forecasts if available (trend, next prediction, time-to-threshold)
            if (predictions && predictions[metricName]) {
              const prediction = predictions[metricName];
              data.predicted_next = prediction.predicted_next;
              data.trend = prediction.trend;
              data.trend_strength = prediction.trend_strength;
              data.forecast_confidence = prediction.confidence;
              
              // Attach time-to-threshold if available (threshold breach prediction)
              if (prediction.time_to_threshold) {
                data.time_to_threshold = prediction.time_to_threshold;
              }
            }
          }
        }
      
      // Return enriched message as object (for pretty MQTT display)
      enrichedMessages.push(data);
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
    
    const topic = `iot/device/${this.deviceUuid}/endpoints/${this.config.mqttTopic}`;
    const messageCount = this.messageBatch.messages.length;
    const batchBytes = this.messageBatch.totalBytes;
    
    // Prepare data with anomaly enrichment
    const data = this.preparePublishData();
    
    // Handle offline MQTT - buffer to local database
    if (!this.mqttConnection.isConnected()) {
      await this.bufferOfflineMessages(topic, data, messageCount);
      return;
    }
    
    try {
      // Choose compression strategy and serialize payload
      const { payload, compressionInfo } = await this.compressPayload(data);
      
      // Publish to MQTT (single call)
      await this.mqttConnection.publish(topic, payload, { qos: 1 });
      
      // Update statistics
      this.updatePublishStats(messageCount, batchBytes);
      
      // Log publish success with compression details
      this.logPublishSuccess(messageCount, batchBytes, compressionInfo);
      
      // Reset batch
      this.resetBatch();
      
    } catch (error) {
      this.logger?.error(`Failed to publish batch from endpoint '${this.getSensorName()}'`, error);
    }
  }

  /**
   * Prepare data for publishing with anomaly detection and forecast enrichment
   */
  private preparePublishData(): any {
    // Feed to edge AI anomaly detection FIRST (before enrichment)
    if (anomalyService) {
      this.feedMessagesToAnomaly(this.messageBatch.messages);
    }
    
    // Enrich messages with anomaly scores and forecasts
    const enrichedMessages = this.enrichMessagesWithAnomalyScores(this.messageBatch.messages);
    
    const publishData: any = {
      sensor: this.getSensorName(),
      timestamp: new Date().toISOString(),
      messages: enrichedMessages
    };
    
    // Attach batch-level forecasts summary if available
    if (anomalyService) {
      // Note: getPredictions is internal to anomaly service; skipping batch summary for now
      // Forecast data is still attached to individual readings via anomaly metadata
    }
    
    return publishData;
  }

  /**
   * Buffer messages to local database when MQTT is offline
   */
  private async bufferOfflineMessages(topic: string, data: any, messageCount: number): Promise<void> {
    this.logger?.warn(`MQTT not connected, buffering ${messageCount} messages from endpoint '${this.getSensorName()}'`);
    
    try {
      const { MessageBufferModel } = await import('../../db/models/index.js');
      
      const jsonPayload = JSON.stringify(data);
      await MessageBufferModel.enqueue({
        endpoint_name: this.getSensorName(),
        topic,
        qos: 1,
        payload: jsonPayload,
        payload_bytes: Buffer.byteLength(jsonPayload, 'utf8')
      });
      
      this.logger?.debug(`Buffered ${messageCount} messages to local database`);
      this.resetBatch();
    } catch (error) {
      this.logger?.error(`Failed to buffer messages from endpoint '${this.getSensorName()}'`, error);
    }
  }

  /**
   * Compress payload using best available strategy:
   * 1. Dictionary compression (with optional MessagePack stacking)
   * 2. MessagePack compression
   * 3. JSON (no compression)
   */
  private async compressPayload(data: any): Promise<{ payload: Buffer | string; compressionInfo: CompressionInfo }> {
    // Strategy 1: Dictionary compression (enabled and builds dictionary on first use)
    if (this.dictionaryManager && this.useKeyCompactionPoc) {
      this.logger?.debug(`Using dictionary compression (size: ${this.dictionaryManager.getDictionarySize()})`, {
        endpoint: this.getSensorName(),
        dictionarySize: this.dictionaryManager.getDictionarySize()
      });
      return await this.applyDictionaryCompression(data);
    }
    
    // Strategy 2 & 3: MessagePack or JSON (fallback when dictionary disabled)
    this.logger?.debug(`Dictionary disabled, using fallback compression`, {
      endpoint: this.getSensorName(),
      useMsgpack: this.useMsgpackPoc
    });
    return await this.applyMsgpackOrJson(data);
  }

  /**
   * Apply dictionary compression with optional MessagePack stacking
   */
  private async applyDictionaryCompression(data: any): Promise<{ payload: Buffer | string; compressionInfo: CompressionInfo }> {
    const startTime = Date.now();
    
    // OPTIMIZATION: Sample CPU usage (not every batch) to reduce syscall overhead
    // Only track if HEAP_METRICS=true or every 100th publish
    const trackCpu = shouldTrackCpuUsage(this.stats.messagesPublished);
    const startCpu = trackCpu ? process.cpuUsage() : undefined;
    
    this.logger?.debug('Compacting message with dictionary', {
      endpoint: this.getSensorName(),
      dictionarySize: this.dictionaryManager.getDictionarySize()
    });
    
    // Track dictionary compression CPU (measures ONLY dictionary layer)
    const dictStartCpu = trackCpu ? process.cpuUsage() : undefined;
    const { compacted, originalSize, compactedSize, compressionRatio} = 
      await this.dictionaryManager.compact(data, this.protocol);
    const dictCpuUsage = (trackCpu && dictStartCpu) ? process.cpuUsage(dictStartCpu) : undefined;
    
    this.logger?.debug('Dictionary compaction complete', {
      endpoint: this.getSensorName(),
      protocol: this.protocol,
      originalSize,
      compactedSize,
      ratio: `${compressionRatio.toFixed(1)}%`,
      newDictionarySize: this.dictionaryManager.getDictionarySize()
    });
    
    // Track MessagePack compression CPU (measures ONLY msgpack layer)
    let msgpackCpuUsage: { user: number; system: number } | undefined;
    let payload: Buffer | string;
    if (this.useMsgpackPoc) {
      const msgpackStartCpu = trackCpu ? process.cpuUsage() : undefined;
      payload = require('msgpack-lite').encode(compacted);
      msgpackCpuUsage = (trackCpu && msgpackStartCpu) ? process.cpuUsage(msgpackStartCpu) : undefined;
    } else {
      payload = JSON.stringify(compacted);
    }
    
    // Track DEFLATE compression CPU (measures ONLY deflate layer)
    let deflateCpuUsage: { user: number; system: number } | undefined;
    let finalPayload: Buffer | string;
    if (this.useDeflatePoc) {
      const deflateStartCpu = trackCpu ? process.cpuUsage() : undefined;
      const payloadBuffer = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
      const cpuLoad = await getCpuUsage();
      
      // Adaptive deflate: only compress if beneficial (prevents event loop blocking)
      if (shouldDeflate(payloadBuffer.length, cpuLoad)) {
        finalPayload = await deflateAsync(payloadBuffer);
      } else {
        this.logger?.debug(`Skipping deflate (payload: ${payloadBuffer.length} bytes, CPU: ${cpuLoad}%)`, {
          endpoint: this.getSensorName()
        });
        finalPayload = payloadBuffer;
      }
      deflateCpuUsage = (trackCpu && deflateStartCpu) ? process.cpuUsage(deflateStartCpu) : undefined;
    } else {
      finalPayload = payload;
    }
    
    // Calculate final compression ratio (dictionary + optional msgpack + optional deflate)
    const finalSize = typeof finalPayload === 'string' ? Buffer.byteLength(finalPayload, 'utf-8') : finalPayload.length;
    const finalRatio = ((originalSize - finalSize) / originalSize) * 100;
    const compressionMs = Date.now() - startTime; // Wall-clock time (includes I/O waits)
    const totalCpuUsage = (trackCpu && startCpu) ? process.cpuUsage(startCpu) : undefined;
    
    const compressionMethod = this.useMsgpackPoc
      ? (this.useDeflatePoc ? 'dictionary+msgpack+deflate' : 'dictionary+msgpack')
      : (this.useDeflatePoc ? 'dictionary+deflate' : 'dictionary');
    
    return {
      payload: finalPayload,
      compressionInfo: {
        method: compressionMethod,
        originalSize,
        compressedSize: finalSize,
        ratio: finalRatio,
        compressionMs,
        cpuUsage: trackCpu ? {
          dictionary: dictCpuUsage,
          msgpack: msgpackCpuUsage,
          deflate: deflateCpuUsage,
          total: totalCpuUsage
        } : undefined
      }
    };
  }

  /**
   * Apply MessagePack or JSON serialization (fallback when dictionary disabled)
   * ASYNC: Uses non-blocking deflate to prevent event loop stalls on edge devices
   */
  private async applyMsgpackOrJson(data: any): Promise<{ payload: Buffer | string; compressionInfo: CompressionInfo }> {
    const startTime = Date.now();
    const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
    
    if (this.useMsgpackPoc) {
      // MessagePack compression (handled by createMsgpackPayload + serializePayload)
      const mqttPayload = createMsgpackPayload(data, msgIdGen);
      let payload = serializePayload(mqttPayload);
      
      // Calculate compression stats
      const originalSize = Buffer.from(JSON.stringify(data), 'utf-8').length;
      let compressedSize = payload.length;
      
      // Apply deflate if enabled (async to prevent event loop blocking)
      let finalPayload: Buffer | string;
      if (this.useDeflatePoc) {
        const cpuLoad = await getCpuUsage();
        
        // Adaptive deflate: only compress if beneficial
        if (shouldDeflate(payload.length, cpuLoad)) {
          finalPayload = await deflateAsync(payload);
          compressedSize = finalPayload.length;
        } else {
          this.logger?.debug(`Skipping deflate (payload: ${payload.length} bytes, CPU: ${cpuLoad}%)`, {
            endpoint: this.getSensorName()
          });
          finalPayload = payload;
          compressedSize = payload.length;
        }
      } else {
        finalPayload = payload;
      }
      
      const ratio = ((originalSize - compressedSize) / originalSize) * 100;
      const compressionMs = Date.now() - startTime;
      
      return {
        payload: finalPayload,
        compressionInfo: {
          method: this.useDeflatePoc ? 'msgpack+deflate' : 'msgpack',
          originalSize,
          compressedSize,
          ratio,
          compressionMs
        }
      };
    } else {
      // JSON (no compression)
      const mqttPayload = createJsonPayload(data, msgIdGen);
      let payload = serializePayload(mqttPayload);
      const originalSize = payload.length;
      
      // Apply deflate if enabled (async to prevent event loop blocking)
      let finalPayload: Buffer | string;
      let compressedSize: number;
      if (this.useDeflatePoc) {
        const payloadBuffer = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
        const cpuLoad = await getCpuUsage();
        
        // Adaptive deflate: only compress if beneficial
        if (shouldDeflate(payloadBuffer.length, cpuLoad)) {
          finalPayload = await deflateAsync(payloadBuffer);
          compressedSize = finalPayload.length;
        } else {
          this.logger?.debug(`Skipping deflate (payload: ${payloadBuffer.length} bytes, CPU: ${cpuLoad}%)`, {
            endpoint: this.getSensorName()
          });
          finalPayload = payloadBuffer;
          compressedSize = payloadBuffer.length;
        }
      } else {
        finalPayload = payload;
        compressedSize = originalSize;
      }
      
      const ratio = this.useDeflatePoc ? ((originalSize - compressedSize) / originalSize) * 100 : 0;
      const compressionMs = Date.now() - startTime;
      
      return {
        payload: finalPayload,
        compressionInfo: {
          method: this.useDeflatePoc ? 'json+deflate' : 'json',
          originalSize,
          compressedSize,
          ratio,
          compressionMs
        }
      };
    }
  }

  /**
   * Update publish statistics
   */
  private updatePublishStats(messageCount: number, batchBytes: number): void {
    this.stats.messagesPublished += messageCount;
    this.stats.bytesPublished += batchBytes;
    this.stats.lastPublishTime = new Date();
  }

  /**
   * Log successful publish with compression details
   */
  private logPublishSuccess(messageCount: number, batchBytes: number, info: CompressionInfo): void {
    // Build compression log object
    const compressionLog: any = {
      method: info.method,
      originalSize: info.originalSize,
      compressedSize: info.compressedSize,
      savedBytes: info.originalSize - info.compressedSize,
      savedPercent: `${info.ratio.toFixed(1)}%`,
      compressionMs: info.compressionMs
    };

    // Add CPU usage if available (in milliseconds for readability)
    if (info.cpuUsage) {
      compressionLog.cpuMs = {
        dictionary: info.cpuUsage.dictionary 
          ? ((info.cpuUsage.dictionary.user + info.cpuUsage.dictionary.system) / 1000).toFixed(2) 
          : undefined,
        msgpack: info.cpuUsage.msgpack 
          ? ((info.cpuUsage.msgpack.user + info.cpuUsage.msgpack.system) / 1000).toFixed(2) 
          : undefined,
        deflate: info.cpuUsage.deflate 
          ? ((info.cpuUsage.deflate.user + info.cpuUsage.deflate.system) / 1000).toFixed(2) 
          : undefined,
        total: info.cpuUsage.total
          ? ((info.cpuUsage.total.user + info.cpuUsage.total.system) / 1000).toFixed(2)
          : undefined
      };
    }

    this.logger?.info(`Published ${messageCount} messages from '${this.getSensorName()}'`, {
      endpoint: this.getSensorName(),
      messages: messageCount,
      batchBytes,
      compression: compressionLog
    });
  }

  /**
   * Reset message batch
   * MEMORY LEAK FIX: Explicitly nullify object references to prevent survivor space accumulation
   * - Compression buffers (msgpack/deflate) may be retained in closures
   * - MQTT publish callbacks may hold references to payload buffers
   * - Nullifying ensures GC can reclaim memory immediately
   */
  private resetBatch(): void {
    // Explicitly nullify object references before clearing array
    // This helps GC reclaim compression buffers that may be retained in closures
    for (let i = 0; i < this.messageBatch.messages.length; i++) {
      this.messageBatch.messages[i] = null;
    }
    
    this.messageBatch = {
      messages: [],
      totalBytes: 0,
      firstMessageTime: new Date()
    };
    
    // Hint to GC for large batches (survivor space leak mitigation)
    // Only runs if --expose-gc flag is set (npm run dev:gc or node --expose-gc)
    if (this.messageBatch.totalBytes > 1024 * 1024 && global.gc) {
      setImmediate(() => {
        global.gc?.();
      });
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
