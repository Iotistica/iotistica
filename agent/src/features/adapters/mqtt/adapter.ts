import { EventEmitter } from 'events';
import * as mqtt from 'mqtt';
import * as mqttPattern from 'mqtt-pattern';
import { SensorDataPoint, DeviceStatus, Logger } from '../types.js';
import { MqttAdapterConfig, MqttDevice, MqttMetricConfig } from './types.js';
import { parsePayload, coerceType } from './payload-parser.js';

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
  private static readonly MAX_PAYLOAD_BYTES = 10 * 1024 * 1024; // 10MB max payload
  
  private config: MqttAdapterConfig;
  private logger: Logger;
  private client: mqtt.MqttClient | null = null;
  private subscriptions: Map<string, MqttDevice> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private running = false;
  private connected = false;
  private emitQueueDepth = 0;
  private droppedMessageCount = 0;
  private firstConnect = true; // Track first connection for subscription logic
  private compiledMetrics = new Map<string, Array<MqttMetricConfig & { path: string[] }>>();
  private compiledTimestampFields = new Map<string, string[]>();

  constructor(config: MqttAdapterConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;

    for (const device of this.config.devices) {
      if (device.timestampField) {
        this.compiledTimestampFields.set(
          device.name,
          this.compileMetricPath(device.timestampField, Boolean(device.allowArrayMetrics))
        );
      }

      if (device.metrics && device.metrics.length > 0) {
        this.compiledMetrics.set(
          device.name,
          device.metrics.map(metric => ({
            ...metric,
            path: this.compileMetricPath(metric.field, Boolean(device.allowArrayMetrics))
          }))
        );
      }
    }
    
    this.initializeDeviceStatuses();
  }

  private compileMetricPath(field: string, allowArrayMetrics: boolean): string[] {
    if (!field) {
      return [];
    }

    const normalized = allowArrayMetrics
      // Convert bracket numeric indexing only: values[0] -> values.0
      ? field.replace(/\[(\d+)\]/g, '.$1')
      : field;

    return normalized.split('.').filter(Boolean);
  }

  /**
   * Start the MQTT adapter - create client and let mqtt.js handle reconnection
   * 
   * Self-healing architecture:
   * - Creates client immediately (doesn't wait for connection)
   * - mqtt.js handles automatic reconnection via reconnectPeriod
   * - Adapter survives broker downtime at startup
   * - Connection state tracked via events, not promise resolution
   * 
   * This makes the adapter resilient in edge environments where:
   * - Broker may start after agent
   * - Network may be unavailable at startup
   * - Transient failures should not kill the adapter
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.logger.debug('Starting MQTT Adapter...');

    // Create client - let mqtt.js handle connection and reconnection
    this.createClient();

    this.running = true;
    
    this.emit('started');
    this.logger.info('MQTT Adapter started (connection state tracked via events)');
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
        // Production fix: Remove all listeners to prevent memory leaks
        this.client.removeAllListeners();
        this.client.end();
        this.client = null;
        this.connected = false;
      }

      this.subscriptions.clear();
      this.running = false;
      this.firstConnect = true; // Reset for next start
      
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
   * Create MQTT client and attach event handlers
   * 
   * Self-healing architecture:
   * - Does NOT wait for initial connection (no timeout rejection)
   * - mqtt.js handles automatic reconnection via reconnectPeriod
   * - Survives broker downtime at startup (edge-friendly)
   * - Connection state tracked via events
   * 
   * Production-safe:
   * - Cleans up old client before creating new one (prevents listener leaks)
   * - Uses .on() for ongoing state tracking (not .once() for promises)
   * - Handles persistent session subscription logic correctly
   * - Emits events for connection state transitions
   */
  private createClient(): void {
    const brokerUrl = `mqtt://${this.config.broker.host}:${this.config.broker.port}`;
    
    // Generate stable clientId for persistent sessions (critical for edge agents)
    const stableClientId = this.config.broker.clientId || `iotistica-agent-${process.env.DEVICE_UUID || 'unknown'}`;
    
    this.logger.info(`Creating MQTT client for broker: ${brokerUrl}`, { 
      clientId: stableClientId,
      reconnectPeriod: this.config.reconnect.period 
    });

    // Cleanup old client before creating new one (prevents listener leaks)
    if (this.client) {
      this.client.removeAllListeners();
      this.client.end(true);
      this.client = null;
    }

    this.client = mqtt.connect(brokerUrl, {
      clientId: stableClientId,
      username: this.config.broker.username,
      password: this.config.broker.password,
      reconnectPeriod: this.config.reconnect.period,
      clean: false, // Persistent session: survive reconnects, keep subscriptions, replay QoS 1 messages
      keepalive: 30, // Send pings every 30s (well before mosquitto's 60s idle timeout)
      will: {
        topic: `device/${stableClientId}/status`,
        payload: Buffer.from('offline'),
        qos: 1,
        retain: true
      }
    });

    // Event-based state machine (not promise-based)
    // mqtt.js will keep retrying automatically
    
    this.client.on('connect', () => {
      this.connected = true;
      
      this.logger.info(`MQTT broker connected: ${brokerUrl}`);
      this.emit('device-connected', 'mqtt-broker');
      
      // Persistent session subscription logic
      // With clean: false, subscriptions persist on broker
      // Only subscribe on first connection to avoid duplication
      if (this.firstConnect) {
        this.logger.debug('First connection - subscribing to all configured devices');
        this.firstConnect = false;
        
        for (const device of this.config.devices) {
          if (device.enabled) {
            this.subscribeToDevice(device).catch(err => {
              this.logger.error(`Failed to subscribe to device topic ${device.topic}: ${err.message}`);
            });
          }
        }
      } else {
        this.logger.debug('Reconnected - subscriptions persisted on broker (clean: false)');
      }
    });

    this.client.on('error', (err) => {
      this.logger.error(`MQTT client error: ${err.message}`);
      this.emit('device-error', 'mqtt-broker', err);
      // Don't kill the client - let mqtt.js retry
    });

    this.client.on('offline', () => {
      this.connected = false;
      this.logger.warn('MQTT broker offline');
      this.emit('device-disconnected', 'mqtt-broker');
    });

    this.client.on('reconnect', () => {
      this.logger.info('MQTT reconnecting to broker...');
    });

    this.client.on('close', () => {
      this.connected = false;
      this.logger.debug('MQTT connection closed');
    });

    // Handle incoming messages
    // Note: MQTT callback signature includes packet metadata (retain flag, qos, etc.)
    this.client.on('message', (topic, payload, packet) => {
      this.handleMessage(topic, payload, packet.retain);
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
   * 
   * Performance Note: O(N) linear search through subscriptions.
   * Fine for typical deployments (10-100 devices).
   * For high-scale (1000+ wildcard filters), consider:
   * - Pre-compile patterns
   * - Index by first topic segment
   * - Use trie-based matching
   */
  private findDeviceForTopic(topic: string): MqttDevice | undefined {
    for (const [filter, device] of this.subscriptions.entries()) {
      if (mqttPattern.matches(filter, topic)) {
        return device;
      }
    }
    return undefined;
  }

  private getFieldFast(payload: any, path: string[]): any {
    let value = payload;
    for (const segment of path) {
      if (value == null) {
        return undefined;
      }
      value = value[segment];
    }
    return value;
  }

  private resolveTimestamp(rawTimestamp: any, fallback: string): string {
    if (rawTimestamp === undefined || rawTimestamp === null) {
      return fallback;
    }

    // Numeric epoch support: seconds or milliseconds
    if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
      const epochMs = rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
      const date = new Date(epochMs);
      return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
    }

    // String support: ISO date or numeric epoch string
    if (typeof rawTimestamp === 'string') {
      const trimmed = rawTimestamp.trim();
      if (!trimmed) {
        return fallback;
      }

      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        const epochMs = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
        const date = new Date(epochMs);
        return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
      }

      const date = new Date(trimmed);
      return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
    }

    return fallback;
  }

  private buildMetricPoint(
    device: MqttDevice,
    metric: string,
    rawValue: any,
    unit: string,
    type: string | undefined,
    topic: string,
    now: string,
    retain: boolean
  ): SensorDataPoint {
    const value = coerceType(rawValue, type || device.dataType || 'string');

    return {
      deviceName: device.name,
      metric: metric || topic,
      value,
      unit,
      timestamp: now,
      quality: retain ? 'UNCERTAIN' : 'GOOD',
      ...(retain && { qualityCode: 'RETAINED_MESSAGE' })
    };
  }

  /**
   * Handle incoming MQTT message
   * 
   * @param topic - MQTT topic
   * @param payload - Message payload
   * @param retain - Retained message flag (true = stale/historical data)
   */
  private handleMessage(topic: string, payload: Buffer, retain: boolean = false): void {
    this.logger.debug(`[MQTT] handleMessage: topic=${topic}, retain=${retain}, payloadSize=${payload.length}`);
    
    // Production fix #8: Max payload size guard
    // Protects against memory exhaustion from malicious/corrupt messages
    if (payload.length > MqttAdapter.MAX_PAYLOAD_BYTES) {
      this.droppedMessageCount++;
      this.logger.warn('Dropping oversized MQTT message', {
        topic,
        payloadSize: payload.length,
        maxAllowed: MqttAdapter.MAX_PAYLOAD_BYTES,
        droppedTotal: this.droppedMessageCount,
        hint: 'Possible JSON bomb or malicious payload'
      });
      return;
    }
    
    // Production fix #5: Backpressure guard
    // Note: This is a "soft" guard based on emit depth, not true async backpressure.
    // Downstream listeners may perform async work not reflected in this counter.
    // For strict backpressure, consider bounded queue or promise tracking.
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

    // Check if topic matches any configured device
    const device = this.findDeviceForTopic(topic);
    
    // If no device configured for this topic, ignore
    if (!device) {
      this.logger.debug(`Ignoring message for unconfigured topic: ${topic}`);
      return;
    }

    try {
      const parsed = parsePayload(payload);
      const now = new Date().toISOString();
      const timestampPath = this.compiledTimestampFields.get(device.name);
      const payloadTimestamp = timestampPath && typeof parsed === 'object' && parsed !== null
        ? this.resolveTimestamp(this.getFieldFast(parsed, timestampPath), now)
        : now;
      const points: SensorDataPoint[] = [];

      const compiledDeviceMetrics = this.compiledMetrics.get(device.name);
      if (compiledDeviceMetrics && compiledDeviceMetrics.length > 0) {
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          for (const metricConfig of compiledDeviceMetrics) {
            const rawValue = this.getFieldFast(parsed, metricConfig.path);

            if (rawValue === undefined) {
              this.logger.debug(`MQTT metric field not found in payload`, {
                topic,
                deviceName: device.name,
                field: metricConfig.field,
              });
              continue;
            }

            try {
              points.push(this.buildMetricPoint(
                device,
                metricConfig.metric,
                rawValue,
                metricConfig.unit || '',
                metricConfig.type,
                topic,
                payloadTimestamp,
                retain
              ));
            } catch (fieldError) {
              this.logger.warn(`Failed to coerce MQTT metric field '${metricConfig.field}'`, {
                topic,
                deviceName: device.name,
                metric: metricConfig.metric,
                error: fieldError instanceof Error ? fieldError.message : String(fieldError)
              });
            }
          }
        } else {
          this.logger.warn('MQTT multi-metric config requires JSON object payload', {
            topic,
            deviceName: device.name
          });
        }
      }

      if (device.autoMetrics && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        for (const [key, rawValue] of Object.entries(parsed)) {
          // Skip nested objects/arrays in auto mode to avoid emitting ambiguous metrics.
          if (rawValue !== null && typeof rawValue === 'object') {
            continue;
          }

          try {
            points.push(this.buildMetricPoint(
              device,
              key,
              rawValue,
              '',
              undefined,
              topic,
              payloadTimestamp,
              retain
            ));
          } catch (fieldError) {
            this.logger.warn(`Failed to coerce MQTT auto metric field '${key}'`, {
              topic,
              deviceName: device.name,
              error: fieldError instanceof Error ? fieldError.message : String(fieldError)
            });
          }
        }
      }

      // Backward-compatible fallback: single metric per message.
      if (points.length === 0) {
        const singleSource =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && (parsed as any).value !== undefined
            ? (parsed as any).value
            : parsed;

        points.push(this.buildMetricPoint(
          device,
          device.metric || topic,
          singleSource,
          device.unit || '',
          device.dataType,
          topic,
          payloadTimestamp,
          retain
        ));
      }
      
      // Emit data event with backpressure tracking
      this.emitQueueDepth++;
      this.emit('data', points);
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
        metric: device.metric || topic,
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

