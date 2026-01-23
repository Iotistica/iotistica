import * as net from 'net';
import { EventEmitter } from 'events';
import { promisify } from 'util';
import { deflate as zlibDeflate } from 'zlib';
import { getHeapStatistics } from 'v8';
import * as msgpack from 'msgpack-lite';
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
} from './types.js';

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
 * Currently enabled for all publishes (always returns true)
 * Can be optimized later by sampling or using log level filtering
 * 
 * @param publishCount - Total number of publishes (stats.messagesPublished)
 * @returns true if CPU usage should be tracked
 */
function shouldTrackCpuUsage(publishCount: number): boolean {
  return true;  // Always track CPU - filter via log levels if needed
}

/**
 * Check if this publish should use baseline no-op path (control measurement)
 * Every 1000th publish skips compression to measure baseline publishing overhead
 * This provides a reference point to calibrate compression costs against
 * 
 * @param publishCount - Total number of publishes (stats.messagesPublished)
 * @returns true if baseline measurement should be taken
 */
function shouldMeasureBaseline(publishCount: number): boolean {
  return (publishCount % 1000) === 0;
}

/**
 * Compression information for logging and metrics
 */
interface CompressionInfo {
  method: 'json' | 'json+deflate' | 'msgpack' | 'msgpack+deflate' | 'dictionary' | 'dictionary+msgpack' | 'dictionary+deflate' | 'dictionary+msgpack+deflate' | 'baseline';
  originalSize: number;
  compressedSize: number;
  ratio: number; // Percentage saved (0-100)
  compressionMs: number; // Wall-clock time taken for compression in milliseconds
  isBaseline?: boolean;  // True if this is a no-op control measurement
  cpuUsage?: {
    // CPU time = actual CPU cycles consumed (can be < wall-clock time due to I/O waits)
    // Values are in MICROSECONDS (1ms = 1000μs)
    // user = time in user-mode code (your JavaScript), system = time in kernel (system calls, I/O)
    // SAMPLING: Only populated when HEAP_METRICS=true or every 100th publish
    // 
    // ⚠️ IMPORTANT: Separated into SERIALIZATION vs COMPRESSION:
    // - Serialization: Object traversal + encoding (dictionary, msgpack)
    // - Compression: Actual compression algorithms (deflate)
    //
    // ⚠️ DEFLATE CPU PROFILING CAVEAT:
    // deflateAsync() runs in libuv thread pool (not main thread), so CPU measurements are misleading:
    // - Actual deflate work happens off-thread (not measured by process.cpuUsage())
    // - Measured CPU = main thread overhead (scheduling, promise resolution, buffer copying)
    // - Wall-clock includes thread pool scheduling delays
    // - Numbers answer: "How long until payload ready?" NOT "How expensive is deflate per byte?"
    // - For pure deflate benchmarking, use sync deflate or worker_threads with dedicated profiling
    //
    // ⚠️ GC EFFECTS ARE INVISIBLE:
    // These metrics do NOT capture garbage collection costs, which can be significant:
    // - GC pause time: Not reflected in CPU measurements (happens asynchronously)
    // - Survivor promotion: msgpack buffers may survive to old generation (slower GC)
    // - Heap pressure: Large buffer allocations trigger more frequent GC cycles
    // - Tail latency: GC pauses can cause unpredictable spikes in publish times
    // Result: "msgpack looks cheap" may hide higher GC churn and worse P99 latency
    // Use --trace-gc or v8.getHeapStatistics() for memory profiling
    serialization?: {
      method: 'dictionary' | 'msgpack' | 'json';  // Which serialization was used
      cpu: { user: number; system: number };  // CPU μs for serialization overhead
    };
    compression?: {
      method: 'deflate';  // Which compression was used
      cpu: { user: number; system: number };  // CPU μs for compression - ⚠️ MISLEADING for deflate (main-thread overhead only)
    };
    total?: { user: number; system: number }; // Total CPU μs (serialization + compression)
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
    firstMessageTime: Date.now() // OPTIMIZATION: Use timestamp instead of Date object
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
  
  // OPTIMIZATION: Cache unit inference results (field names repeat heavily)
  private unitCache = new Map<string, string>();
  private unitCacheBatchCount = 0; // Track batches since last cache clear
  
  // OPTIMIZATION: Pre-allocated sets for extractNumericFields (reused per batch)
  private batchVisited = new WeakSet();
  private batchProcessedMetrics = new Set<string>();
  
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
    
    // Disconnect socket and remove all listeners (prevents closure retention)
    if (this.socket) {
      this.socket.removeAllListeners(); // Critical: Remove event listeners before destroy
      this.socket.destroy();
      this.socket = null;
    }
    
    // Publish remaining messages
    if (this.messageBatch.messages.length > 0) {
      await this.publishBatch();
    }
    
    // Clear caches to help GC
    this.batchProcessedMetrics.clear();
    // Note: unitCache is NOT cleared (it's meant to persist for reuse if sensor restarts)
    
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

    const timestampMs = Date.now(); // OPTIMIZATION: Use timestamp instead of Date object
    const sensorName = this.getSensorName();
    
    // OPTIMIZATION: Clear and reuse batch-level sets instead of creating new ones per message
    this.batchVisited = new WeakSet();
    this.batchProcessedMetrics.clear();

    for (const data of messages) {
      // Messages are already parsed objects (no JSON.parse needed)
      // Extract all numeric fields and feed to anomaly detection
      this.extractNumericFields(data, sensorName, timestampMs);
    }
  }

  /**
   * Recursively extract numeric fields from sensor data
   * Handles nested objects and arrays
   * OPTIMIZATION: Reuses batch-level WeakSet and Set instead of creating new ones per message
   */
  private extractNumericFields(
    data: any,
    sensorName: string,
    timestampMs: number, // OPTIMIZATION: Accept timestamp (ms) instead of Date object
    prefix = '',
    depth = 0
  ): void {
    if (!anomalyService) return;

    // Prevent infinite recursion
    const MAX_DEPTH = 3;
    if (depth > MAX_DEPTH) {
      return;
    }

    // Prevent circular references (use batch-level WeakSet)
    if (typeof data === 'object' && data !== null) {
      if (this.batchVisited.has(data)) {
        return;
      }
      this.batchVisited.add(data);
    }

    if (typeof data === 'number') {
      // Direct numeric value
      const metricName = prefix || 'value';
      const fullMetricName = `${this.deviceUuid}_${sensorName}_${metricName}`;
      
      // Skip if already processed (use batch-level Set)
      if (this.batchProcessedMetrics.has(fullMetricName)) {
        return;
      }
      this.batchProcessedMetrics.add(fullMetricName);
      
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
          const fullMetricName = `${this.deviceUuid}_${deviceName}_${fieldName}`;
          
          // Skip if already processed (use batch-level Set)
          if (this.batchProcessedMetrics.has(fullMetricName)) {
            return;
          }
          this.batchProcessedMetrics.add(fullMetricName);
          
          anomalyService.processDataPoint({
            source: 'endpoint',
            metric: `${this.deviceUuid}_${deviceName}_${fieldName}`,
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
              const fullMetricName = `${this.deviceUuid}_${deviceName}_${fieldName}`;
              
              // Skip if already processed (use batch-level Set)
              if (this.batchProcessedMetrics.has(fullMetricName)) {
                continue;
              }
              this.batchProcessedMetrics.add(fullMetricName);
              
              anomalyService.processDataPoint({
                source: 'endpoint',
                metric: `${this.deviceUuid}_${deviceName}_${fieldName}`,
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
          const fullMetricName = `${this.deviceUuid}_${sensorName}_${metricName}`;
          
          // Skip if already processed (use batch-level Set)
          if (this.batchProcessedMetrics.has(fullMetricName)) {
            continue;
          }
          this.batchProcessedMetrics.add(fullMetricName);
          
          anomalyService.processDataPoint({
            source: 'sensor',
            metric: `${this.deviceUuid}_${sensorName}_${metricName}`,
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
          this.extractNumericFields(value, sensorName, timestampMs, key, depth + 1);
        } else if (typeof value === 'object' && value !== null) {
          // Recurse into nested object (depth-limited)
          this.extractNumericFields(value, sensorName, timestampMs, key, depth + 1);
        }
      }
    }
  }

  /**
   * Infer measurement unit from field name
   * Returns common units based on field name patterns
   * OPTIMIZATION: Results cached (field names repeat heavily in sensor data)
   */
  private inferUnit(fieldName: string): string {
    // OPTIMIZATION: Check cache first (field names repeat heavily)
    const cached = this.unitCache.get(fieldName);
    if (cached) {
      return cached;
    }
    
    const lower = fieldName.toLowerCase();

    // Temperature
    if (lower.includes('temp') || lower.includes('temperature')) {
      return this.cacheUnit(fieldName, '°C');
    }

    // Humidity
    if (lower.includes('humid') || lower.includes('moisture')) {
      return this.cacheUnit(fieldName, '%');
    }

    // Pressure
    if (lower.includes('pressure') || lower.includes('baro')) {
      return this.cacheUnit(fieldName, 'hPa');
    }

    // Electrical
    if (lower.includes('voltage') || lower.includes('volt')) {
      return this.cacheUnit(fieldName, 'V');
    }
    if (lower.includes('current') || lower.includes('ampere') || lower.includes('amp')) {
      return this.cacheUnit(fieldName, 'A');
    }
    if (lower.includes('power') || lower.includes('watt')) {
      return this.cacheUnit(fieldName, 'W');
    }
    if (lower.includes('resistance') || lower.includes('ohm')) {
      return this.cacheUnit(fieldName, 'Ω');
    }

    // Gas/Air Quality
    if (lower.includes('co2') || lower.includes('carbon')) {
      return this.cacheUnit(fieldName, 'ppm');
    }
    if (lower.includes('gas') || lower.includes('voc') || lower.includes('iaq')) {
      return this.cacheUnit(fieldName, 'index');
    }

    // Light
    if (lower.includes('light') || lower.includes('lux') || lower.includes('illumin')) {
      return this.cacheUnit(fieldName, 'lux');
    }

    // Distance
    if (lower.includes('distance') || lower.includes('range')) {
      return this.cacheUnit(fieldName, 'cm');
    }

    // Speed
    if (lower.includes('speed') || lower.includes('velocity')) {
      return this.cacheUnit(fieldName, 'm/s');
    }

    // Percentage
    if (lower.includes('percent') || lower.includes('level') || lower.includes('battery')) {
      return this.cacheUnit(fieldName, '%');
    }

    // Default
    return this.cacheUnit(fieldName, 'value');
  }
  
  /**
   * Cache unit result for repeated field names
   * OPTIMIZATION: Reduces string matching overhead for repeated fields
   */
  private cacheUnit(fieldName: string, unit: string): string {
    this.unitCache.set(fieldName, unit);
    return unit;
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
    // OPTIMIZATION: Avoid Buffer.concat() for small appends (reduces allocations)
    if (this.buffer.length === 0) {
      this.buffer = data;
    } else {
      const newBuffer = Buffer.allocUnsafe(this.buffer.length + data.length);
      this.buffer.copy(newBuffer, 0);
      data.copy(newBuffer, this.buffer.length);
      this.buffer = newBuffer;
    }
    
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
      this.messageBatch.firstMessageTime = Date.now(); // OPTIMIZATION: Use timestamp
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
    
    // Get predictions once for all readings (avoids repeated forecasting calls)
    const predictions = anomalyService.getPredictions() || {};

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
                const metricName = `${this.deviceUuid}_${deviceName}_${fieldName}`;
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
          const metricName = `${this.deviceUuid}_${deviceName}_${fieldName}`;
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
    
    // Prepare data with anomaly enrichment and freeze baseline size
    const { data, baselineSize } = this.preparePublishData();
    
    // Handle offline MQTT - buffer to local database
    if (!this.mqttConnection.isConnected()) {
      await this.bufferOfflineMessages(topic, data, messageCount);
      return;
    }
    
    try {
      // Choose compression strategy and serialize payload (using frozen baseline)
      const { payload, compressionInfo } = await this.compressPayload(data, baselineSize);
      
      // Publish to MQTT (single call)
      await this.mqttConnection.publish(topic, payload, { qos: 1 });
      
      // Update statistics BEFORE clearing references
      this.updatePublishStats(messageCount, batchBytes);
      
      // Log publish success BEFORE clearing (creates copy of compressionInfo)
      this.logPublishSuccess(messageCount, batchBytes, compressionInfo);
      
      // Clear all references immediately after logging (survivor space leak mitigation)
      // These objects are captured in compression closures and survive minor GC cycles
      // Must clear ASAP to break closure chains before next publish cycle
      if (data.messages && Array.isArray(data.messages)) {
        data.messages.length = 0;
      }
      // Explicitly clear CPU usage objects (contain large data structures)
      if (compressionInfo.cpuUsage) {
        // @ts-ignore - delete readonly property for GC
        delete compressionInfo.cpuUsage;
      }
      
      // Reset batch (clears messageBatch.messages array and caches)
      this.resetBatch();
      
    } catch (error) {
      this.logger?.error(`Failed to publish batch from endpoint '${this.getSensorName()}'`, error);
    }
  }

  /**
   * Prepare data for publishing with anomaly detection and forecast enrichment
   */
  private preparePublishData(): { data: any; baselineSize: number } {
    // Feed to edge AI anomaly detection FIRST (before enrichment)
    if (anomalyService) {
      this.feedMessagesToAnomaly(this.messageBatch.messages);
    }
    
    // Enrich messages with anomaly scores and forecasts
    // ⚠️ CREATES NEW ARRAY - must be explicitly cleared to prevent survivor space leak
    const enrichedMessages = this.enrichMessagesWithAnomalyScores(this.messageBatch.messages);
    
    // OPTIMIZATION: Format timestamp once (avoid repeated new Date().toISOString())
    const timestampIso = new Date().toISOString();
    
    const publishData: any = {
      sensor: this.getSensorName(),
      timestamp: timestampIso,
      messages: enrichedMessages
    };
    
    // Freeze canonical baseline BEFORE any transformations (for valid compression comparison)
    // This is the exact structure that will be compressed, measured as JSON
    const baselineSize = Buffer.byteLength(
      JSON.stringify({ sensor: publishData.sensor, timestamp: publishData.timestamp, messages: publishData.messages }),
      'utf8'
    );
    
    return { data: publishData, baselineSize };
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
   * 
   * IMPORTANT: Uses frozen baseline for valid cross-method comparison
   * Baseline is calculated BEFORE any transformations in preparePublishData()
   * All methods measure compression against the same canonical JSON size
   * 
   * BASELINE CONTROL: Every 1000th publish uses no-op path (JSON only) to measure
   * baseline publishing overhead without compression. This calibrates all other measurements.
   * 
   * @param data - Data to compress
   * @param baselineSize - Frozen baseline size (canonical JSON before transformations)
   */
  private async compressPayload(data: any, baselineSize: number): Promise<{ payload: Buffer | string; compressionInfo: CompressionInfo }> {
    // Baseline control measurement: Every 1000th publish skips compression
    // This measures pure publishing overhead (JSON serialization + MQTT publish)
    // Provides reference point to calibrate compression costs against
    if (shouldMeasureBaseline(this.stats.messagesPublished)) {
      const startTime = Date.now();
      const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
      const mqttPayload = createJsonPayload(data, msgIdGen);
      const payload = serializePayload(mqttPayload);
      const compressionMs = Date.now() - startTime;
      const payloadSize = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf-8') : payload.length;
      
      return {
        payload,
        compressionInfo: {
          method: 'baseline',
          originalSize: baselineSize,
          compressedSize: payloadSize,
          ratio: 0,  // No compression
          compressionMs,
          isBaseline: true
        }
      };
    }
    
    // Strategy 1: Dictionary compression (enabled and builds dictionary on first use)
    if (this.dictionaryManager && this.useKeyCompactionPoc) {
      this.logger?.debug(`Using dictionary compression (size: ${this.dictionaryManager.getDictionarySize()})`, {
        endpoint: this.getSensorName(),
        dictionarySize: this.dictionaryManager.getDictionarySize()
      });
      return await this.applyDictionaryCompression(data, baselineSize);
    }
    
    return await this.applyMsgpackOrJson(data, baselineSize);
  }

  /**
   * Apply dictionary compression with optional MessagePack stacking
   * @param data - Data to compress
   * @param baselineSize - Frozen baseline (canonical JSON) for cross-method comparison
   */
  private async applyDictionaryCompression(data: any, baselineSize: number): Promise<{ payload: Buffer | string; compressionInfo: CompressionInfo }> {
    const startTime = Date.now();
    
    // OPTIMIZATION: Sample CPU usage (not every batch) to reduce syscall overhead
    // Only track if HEAP_METRICS=true or every 100th publish
    const trackCpu = shouldTrackCpuUsage(this.stats.messagesPublished);
    const startCpu = trackCpu ? process.cpuUsage() : undefined;
    
    this.logger?.debug('Compacting message with dictionary', {
      endpoint: this.getSensorName(),
      dictionarySize: this.dictionaryManager.getDictionarySize()
    });
    
    // Track dictionary compaction CPU (measures field traversal + key replacement + object mutation)
    // This is NOT pure compression - it's a serialization-like transformation
    const dictStartCpu = trackCpu ? process.cpuUsage() : undefined;
    const { compacted, originalSize, compactedSize, compressionRatio} = 
      await this.dictionaryManager.compact(data, this.protocol);
    const dictCpuUsage = (trackCpu && dictStartCpu) ? process.cpuUsage(dictStartCpu) : undefined;
    
    // Use frozen baseline for cross-method comparison (not dictionary's internal originalSize)
    const consistentOriginalSize = baselineSize;
    
    this.logger?.debug('Dictionary compaction complete', {
      endpoint: this.getSensorName(),
      protocol: this.protocol,
      originalSize,
      compactedSize,
      ratio: `${compressionRatio.toFixed(1)}%`,
      newDictionarySize: this.dictionaryManager.getDictionarySize()
    });
    
    // Track MessagePack serialization CPU (measures object traversal + encoding + buffer allocation)
    // This is NOT pure compression - it's binary serialization overhead
    let msgpackCpuUsage: { user: number; system: number } | undefined;
    let payload: Buffer | string;
    if (this.useMsgpackPoc) {
      const msgpackStartCpu = trackCpu ? process.cpuUsage() : undefined;
      payload = msgpack.encode(compacted);
      msgpackCpuUsage = (trackCpu && msgpackStartCpu) ? process.cpuUsage(msgpackStartCpu) : undefined;
    } else {
      payload = JSON.stringify(compacted);
    }
    
    // Track DEFLATE compression CPU (this IS pure compression - DEFLATE algorithm only)
    // ⚠️ CAVEAT: deflateAsync() runs in libuv thread pool, so this only measures main-thread overhead
    // (scheduling, promise, buffer copying) NOT actual compression cost. Wall-clock includes scheduling delays.
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
    const finalRatio = ((consistentOriginalSize - finalSize) / consistentOriginalSize) * 100;
    const compressionMs = Date.now() - startTime; // Wall-clock time (includes I/O waits)
    const totalCpuUsage = (trackCpu && startCpu) ? process.cpuUsage(startCpu) : undefined;
    
    const compressionMethod = this.useMsgpackPoc
      ? (this.useDeflatePoc ? 'dictionary+msgpack+deflate' : 'dictionary+msgpack')
      : (this.useDeflatePoc ? 'dictionary+deflate' : 'dictionary');
    
    // Determine serialization method (dictionary or dictionary+msgpack)
    const serializationMethod = this.useMsgpackPoc ? 'msgpack' : 'dictionary';
    const serializationCpu = this.useMsgpackPoc 
      ? (msgpackCpuUsage || dictCpuUsage)  // Prefer msgpack if both exist
      : dictCpuUsage;
    
    return {
      payload: finalPayload,
      compressionInfo: {
        method: compressionMethod,
        originalSize: consistentOriginalSize,  // Use consistent baseline for comparison
        compressedSize: finalSize,
        ratio: finalRatio,
        compressionMs,
        cpuUsage: trackCpu ? {
          serialization: serializationCpu ? {
            method: serializationMethod,
            cpu: serializationCpu
          } : undefined,
          compression: deflateCpuUsage ? {
            method: 'deflate',
            cpu: deflateCpuUsage
          } : undefined,
          total: totalCpuUsage
        } : undefined
      }
    };
  }

  /**
   * Apply MessagePack or JSON serialization (fallback when dictionary disabled)
   * ASYNC: Uses non-blocking deflate to prevent event loop stalls on edge devices
   * @param data - Data to compress
   * @param baselineSize - Frozen baseline (canonical JSON) for cross-method comparison
   */
  private async applyMsgpackOrJson(data: any, baselineSize: number): Promise<{ payload: Buffer | string; compressionInfo: CompressionInfo }> {
    const startTime = Date.now();
    const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
    
    // CPU profiling setup
    const trackCpu = shouldTrackCpuUsage(this.stats.messagesPublished);
    const startCpu = trackCpu ? process.cpuUsage() : undefined;
    let msgpackCpuUsage: { user: number; system: number } | undefined;
    let deflateCpuUsage: { user: number; system: number } | undefined;
    
    if (this.useMsgpackPoc) {
      // MessagePack serialization (measures object traversal + encoding + buffer allocation)
      // NOT pure compression - this is binary serialization overhead
      // ⚠️ Hidden cost: msgpack creates intermediate buffers (GC churn, survivor promotion)
      const msgpackStartCpu = trackCpu ? process.cpuUsage() : undefined;
      const mqttPayload = createMsgpackPayload(data, msgIdGen);
      let payload = serializePayload(mqttPayload);
      msgpackCpuUsage = (trackCpu && msgpackStartCpu) ? process.cpuUsage(msgpackStartCpu) : undefined;
      
      // Use frozen baseline for cross-method comparison
      const originalSize = baselineSize;
      let compressedSize = payload.length;
      
      // Apply deflate if enabled (async to prevent event loop blocking)
      // ⚠️ CAVEAT: deflateAsync() in thread pool means CPU measurements only show main-thread overhead
      let finalPayload: Buffer | string;
      if (this.useDeflatePoc) {
        const cpuLoad = await getCpuUsage();
        
        // Adaptive deflate: only compress if beneficial
        if (shouldDeflate(payload.length, cpuLoad)) {
          const deflateStartCpu = trackCpu ? process.cpuUsage() : undefined;
          finalPayload = await deflateAsync(payload);
          deflateCpuUsage = (trackCpu && deflateStartCpu) ? process.cpuUsage(deflateStartCpu) : undefined;
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
      const totalCpuUsage = (trackCpu && startCpu) ? process.cpuUsage(startCpu) : undefined;
      
      return {
        payload: finalPayload,
        compressionInfo: {
          method: this.useDeflatePoc ? 'msgpack+deflate' : 'msgpack',
          originalSize,
          compressedSize,
          ratio,
          compressionMs,
          cpuUsage: trackCpu ? {
            serialization: msgpackCpuUsage ? {
              method: 'msgpack',
              cpu: msgpackCpuUsage
            } : undefined,
            compression: deflateCpuUsage ? {
              method: 'deflate',
              cpu: deflateCpuUsage
            } : undefined,
            total: totalCpuUsage
          } : undefined
        }
      };
    } else {
      // JSON (no compression)
      const mqttPayload = createJsonPayload(data, msgIdGen);
      let payload = serializePayload(mqttPayload);
      const originalSize = baselineSize;  // Use frozen baseline for cross-method comparison
      
      // Apply deflate if enabled (async to prevent event loop blocking)
      // ⚠️ CAVEAT: deflateAsync() in thread pool means CPU measurements only show main-thread overhead
      let finalPayload: Buffer | string;
      let compressedSize: number;
      if (this.useDeflatePoc) {
        const payloadBuffer = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
        const cpuLoad = await getCpuUsage();
        
        // Adaptive deflate: only compress if beneficial
        if (shouldDeflate(payloadBuffer.length, cpuLoad)) {
          const deflateStartCpu = trackCpu ? process.cpuUsage() : undefined;
          finalPayload = await deflateAsync(payloadBuffer);
          deflateCpuUsage = (trackCpu && deflateStartCpu) ? process.cpuUsage(deflateStartCpu) : undefined;
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
      const totalCpuUsage = (trackCpu && startCpu) ? process.cpuUsage(startCpu) : undefined;
      
      return {
        payload: finalPayload,
        compressionInfo: {
          method: this.useDeflatePoc ? 'json+deflate' : 'json',
          originalSize,
          compressedSize,
          ratio,
          compressionMs,
          cpuUsage: trackCpu ? {
            serialization: {
              method: 'json',
              cpu: { user: 0, system: 0 }  // JSON serialization is negligible (native)
            },
            compression: deflateCpuUsage ? {
              method: 'deflate',
              cpu: deflateCpuUsage
            } : undefined,
            total: totalCpuUsage
          } : undefined
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
      compressionMs: info.compressionMs,
      throughputBytesPerMs: info.compressionMs > 0 
        ? Math.round(info.compressedSize / info.compressionMs)
        : 0
    };

    // Add CPU usage if available (in milliseconds for readability)
    // ⚠️ Separated: serialization (msgpack/dictionary) vs compression (deflate)
    // ⚠️ GC effects invisible: Metrics don't capture pause time, survivor promotion, or heap pressure
    if (info.cpuUsage) {
      // Serialization timing (msgpack, dictionary, or json)
      if (info.cpuUsage.serialization) {
        const cpuMs = ((info.cpuUsage.serialization.cpu.user + info.cpuUsage.serialization.cpu.system) / 1000).toFixed(2);
        compressionLog.serialization = info.cpuUsage.serialization.method;
        compressionLog.serializationMs = cpuMs;
      }
      
      // Compression timing (deflate - main-thread overhead only)
      if (info.cpuUsage.compression) {
        const cpuMs = ((info.cpuUsage.compression.cpu.user + info.cpuUsage.compression.cpu.system) / 1000).toFixed(2);
        compressionLog.compression = info.cpuUsage.compression.method;
        compressionLog.compressionMs = cpuMs;
      }
      
      // Total CPU time
      if (info.cpuUsage.total) {
        compressionLog.totalCpuMs = ((info.cpuUsage.total.user + info.cpuUsage.total.system) / 1000).toFixed(2);
      }
    }

    // Log with special marker for baseline measurements (control path)
    // MEMORY LEAK FIX: Use debug level to prevent buffering large compression objects in log backend
    // LocalLogBackend keeps 1000 logs in memory - at 12 publishes/min, that's 30KB × 1000 = 30MB
    // Debug level means these only log when LOG_LEVEL=debug, reducing buffer pressure
    const message = info.isBaseline
      ? `Published ${messageCount} messages from '${this.getSensorName()}' (no-op control)`
      : `Published ${messageCount} messages from '${this.getSensorName()}'`;
    
    // Baseline measurements at info level, regular publishes at debug level
    // Global LOG_LEVEL setting controls whether these actually get logged/buffered
    if (info.isBaseline) {
      this.logger?.info(message, {
        messages: messageCount,
        batchBytes,
        compression: compressionLog
      });
    } else {
      this.logger?.info(message, {
        messages: messageCount,
        batchBytes,
        compression: compressionLog
      });
    }
  }

  /**
   * Reset message batch
   * MEMORY LEAK FIX: Explicitly nullify object references to prevent survivor space accumulation
   * - Compression buffers (msgpack/deflate) may be retained in closures
   * - MQTT publish callbacks may hold references to payload buffers
   * - Nullifying ensures GC can reclaim memory immediately
   * 
   * ⚠️ GC EFFECTS NOT MEASURED:
   * Manual GC calls and buffer churn from msgpack/deflate create hidden costs:
   * - GC pause time (can spike to 10-50ms on large batches)
   * - Survivor promotion (msgpack buffers may reach old generation)
   * - Heap fragmentation (frequent large allocations)
   * These costs are NOT reflected in CPU profiling metrics but affect tail latency
   */
  private resetBatch(): void {
    // Clear array in-place to help GC reclaim memory immediately
    // Setting length to 0 is faster than splice() and properly releases references
    this.messageBatch.messages.length = 0;
    this.messageBatch.totalBytes = 0;
    this.messageBatch.firstMessageTime = Date.now();
    
    // Clear batch-level caches to prevent survivor space accumulation
    this.batchProcessedMetrics.clear();
    // Note: batchVisited is WeakSet (auto-GC'd when objects released)
    
    // Clear unitCache periodically to prevent unbounded growth
    // Cache field name → unit mappings but reset every 100 batches (~10 min)
    this.unitCacheBatchCount++;
    if (this.unitCacheBatchCount >= 100) {
      this.unitCache.clear();
      this.unitCacheBatchCount = 0;
    }
    
    // Force buffer cleanup to break circular references
    // Manual GC hints cause survivor promotion - let V8 handle GC naturally
    this.buffer = Buffer.alloc(0);
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
