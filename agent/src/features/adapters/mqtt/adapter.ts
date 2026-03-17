import { EventEmitter } from 'events';
import * as mqtt from 'mqtt';
import * as mqttPattern from 'mqtt-pattern';
import { SensorDataPoint, DeviceStatus, Logger } from '../types.js';
import { MqttAdapterConfig, MqttDevice, MqttMetricConfig } from './types.js';
import { parsePayload, coerceType } from './payload-parser.js';
import { deviceTopic } from '../../../mqtt/topics.js';

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
  private static readonly MAX_QUEUE_DEPTH = 1000; // Max buffered data batches
  private static readonly MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB max payload (edge-safe default)
  
  private config: MqttAdapterConfig;
  private logger: Logger;
  private client: mqtt.MqttClient | null = null;
  private subscriptions: Map<string, MqttDevice> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private running = false;
  private connected = false;
  private emitQueue: SensorDataPoint[][] = [];
  private processingEmitQueue = false;
  private droppedMessageCount = 0;
  private firstConnect = true; // Track first connection for subscription logic
  private compiledMetrics = new Map<string, Array<MqttMetricConfig & { path: string[] }>>();
  private compiledTimestampFields = new Map<string, string[]>();
  private lwtDeviceIdToName = new Map<string, string>();
  private brokerStatusTopic: string | null = null;
  private deviceUuid: string | null = null;

  constructor(config: MqttAdapterConfig, logger: Logger, deviceUuid?: string) {
    super();
    this.config = config;
    this.logger = logger;
    this.deviceUuid = deviceUuid?.trim() || null;

    for (const device of this.config.devices) {
      if (device.enabled) {
        this.subscriptions.set(device.topic, device);
      }

      const lwtDeviceId = device.deviceId?.trim();
      if (lwtDeviceId) {
        this.lwtDeviceIdToName.set(lwtDeviceId, device.name);
      }

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
        // Publish graceful offline status so retained state reflects intentional shutdown.
        await this.publishBrokerStatus('offline');

        // Best-effort unsubscribe to avoid stale persistent subscriptions on broker.
        await this.unsubscribeAll();

        // Production fix: Remove all listeners to prevent memory leaks
        this.client.removeAllListeners();

        // Graceful disconnect to ensure socket closes before stop completes.
        await new Promise<void>((resolve) => {
          this.client!.end(false, (error?: Error) => {
            if (error) {
              this.logger.warn(`Error while ending MQTT client connection: ${error.message}`);
            }
            resolve();
          });
        });

        this.client = null;
        this.connected = false;
      }

      this.subscriptions.clear();
      this.emitQueue = [];
      this.processingEmitQueue = false;
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
    const stableClientId = this.resolveStableClientId();
    this.brokerStatusTopic = this.resolveBrokerStatusTopic();
    
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
      ...(this.brokerStatusTopic ? {
        will: {
          topic: this.brokerStatusTopic,
          payload: Buffer.from('offline'),
          qos: 1,
          retain: true
        }
      } : {})
    });

    // Event-based state machine (not promise-based)
    // mqtt.js will keep retrying automatically
    
    this.client.on('connect', (connack) => {
      this.connected = true;
      
      this.logger.info(`MQTT broker connected: ${brokerUrl}`);
      this.emit('device-connected', 'mqtt-broker');

      // Overwrite retained LWT offline marker with current online status.
      void this.publishBrokerStatus('online');

      // LWT status stream: subscribe once per connected session.
      this.subscribeToStatusTopic().catch(err => {
        this.logger.warn(`Failed to subscribe to broker status topic: ${err.message}`);
      });
      
      // Refresh configured subscriptions on every connect.
      if (!connack.sessionPresent) {
        this.logger.warn('MQTT session not present, subscribing all configured topics');
      } else if (this.firstConnect) {
        this.logger.debug('Connected with existing persistent session (sessionPresent=true)');
      } else {
        this.logger.debug('Reconnected - refreshing subscriptions');
      }

      this.subscribeAllConfiguredDevices().catch(err => {
        this.logger.error(`Failed to subscribe configured topics after connect: ${err.message}`);
      });

      this.firstConnect = false;
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
      if (topic.startsWith('device/') && topic.endsWith('/status')) {
        this.handleLwtStatus(topic, payload, packet.retain);
        return;
      }
      this.handleMessage(topic, payload, packet.retain);
    });
  }

  private resolveStableClientId(): string {
    const deviceUuid = this.deviceUuid?.trim();
    if (deviceUuid && deviceUuid.toLowerCase() !== 'unknown') {
      return `agent-${deviceUuid}`;
    }

    throw new Error(
      'MQTT clientId requires a valid device UUID to derive agent-<deviceUuid>.'
    );
  }

  private resolveBrokerStatusTopic(): string | null {
    if (!this.deviceUuid || this.deviceUuid.toLowerCase() === 'unknown') {
      this.logger.debug('Broker status topic skipped: no device UUID provided');
      return null;
    }

    try {
      return deviceTopic(this.deviceUuid, 'agent', 'broker');
    } catch {
      // Tenant ID not yet initialized (pre-provisioning). Topic will remain null until reconnect.
      this.logger.debug('Broker status topic skipped: tenant ID not yet initialized');
      return null;
    }
  }

  private async publishBrokerStatus(status: 'online' | 'offline'): Promise<void> {
    if (!this.client || !this.connected || !this.brokerStatusTopic) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.client!.publish(
        this.brokerStatusTopic!,
        Buffer.from(status),
        { qos: 1, retain: true },
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        }
      );
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to publish broker status '${status}': ${message}`, {
        topic: this.brokerStatusTopic,
      });
    });
  }

  private async subscribeAllConfiguredDevices(): Promise<void> {
    for (const device of this.config.devices) {
      if (!device.enabled) {
        continue;
      }

      try {
        await this.subscribeToDevice(device);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to subscribe to device topic ${device.topic}: ${message}`);
      }
    }
  }

  private async subscribeToStatusTopic(): Promise<void> {
    if (!this.client || !this.connected) {
      return;
    }

    const statusTopic = 'device/+/status';
    await new Promise<void>((resolve, reject) => {
      this.client!.subscribe(statusTopic, { qos: 1 }, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private async unsubscribeAll(): Promise<void> {
    if (!this.client) {
      return;
    }

    const topics = Array.from(this.subscriptions.keys());
    if (topics.length === 0) {
      return;
    }

    try {
      await new Promise<void>((resolve) => {
        this.client!.unsubscribe(topics, () => resolve());
      });
      this.logger.debug(`Unsubscribed from ${topics.length} MQTT topics before shutdown`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Failed to unsubscribe all MQTT topics during shutdown: ${errorMessage}`);
    }
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

  private handleLwtStatus(topic: string, payload: Buffer, retain: boolean): void {
    if (retain) {
      return;
    }

    const deviceId = topic.split('/')[1];
    if (!deviceId) {
      return;
    }

    const deviceName = this.lwtDeviceIdToName.get(deviceId);
    if (!deviceName) {
      this.logger.debug(`Ignoring LWT status for unmapped deviceId: ${deviceId}`, { topic });
      return;
    }

    const statusText = payload.toString('utf8').trim().toLowerCase();
    const status = this.deviceStatuses.get(deviceName);
    if (!status) {
      return;
    }

    const now = new Date();
    if (statusText === 'online') {
      status.connected = true;
      status.communicationQuality = 'good';
      status.lastSeen = now;
      status.lastPoll = now;
      this.logger.info(`LWT: device online`, { deviceId, deviceName });
    } else if (statusText === 'offline') {
      status.connected = false;
      status.communicationQuality = 'offline';
      this.logger.info(`LWT: device offline`, { deviceId, deviceName });
    }
  }

  private enqueueData(points: SensorDataPoint[], topic: string): void {
    if (this.emitQueue.length >= MqttAdapter.MAX_QUEUE_DEPTH) {
      this.droppedMessageCount++;
      if (this.droppedMessageCount % 100 === 1) {
        this.logger.warn('Dropping MQTT messages due to bounded queue limit', {
          queueDepth: this.emitQueue.length,
          droppedTotal: this.droppedMessageCount,
          maxQueueDepth: MqttAdapter.MAX_QUEUE_DEPTH,
          topic
        });
      }
      return;
    }

    this.emitQueue.push(points);
    void this.processEmitQueue();
  }

  private async processEmitQueue(): Promise<void> {
    if (this.processingEmitQueue) {
      return;
    }

    this.processingEmitQueue = true;
    try {
      while (this.emitQueue.length > 0) {
        const points = this.emitQueue.shift();
        if (!points) {
          continue;
        }

        const listeners = this.listeners('data');
        for (const listener of listeners) {
          try {
            await Promise.resolve(listener(points));
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.error(`MQTT data listener failed: ${errorMessage}`);
          }
        }

        await new Promise<void>(resolve => setImmediate(resolve));
      }
    } finally {
      this.processingEmitQueue = false;
    }
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
    deviceId: string | undefined,
    topic: string,
    now: string,
    retain: boolean
  ): SensorDataPoint {
    const value = coerceType(rawValue, type || device.dataType || 'string');

    return {
      deviceName: device.name,
      ...(deviceId && { deviceId }),
      metric: metric || topic,
      value,
      unit,
      timestamp: now,
      quality: retain ? 'UNCERTAIN' : 'GOOD',
      ...(retain && { qualityCode: 'RETAINED_MESSAGE' })
    };
  }

  private resolveMessageDeviceId(device: MqttDevice, parsed: unknown): string | undefined {
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const candidate = (parsed as any).deviceId ?? (parsed as any).device_id;
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
      if (typeof candidate === 'number' && Number.isFinite(candidate)) {
        return String(candidate);
      }
    }

    if (typeof device.deviceId === 'string' && device.deviceId.trim()) {
      return device.deviceId.trim();
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
    
    // Check if topic matches any configured device
    const device = this.findDeviceForTopic(topic);
    
    // If no device configured for this topic, ignore
    if (!device) {
      this.logger.debug(`Ignoring message for unconfigured topic: ${topic}`);
      return;
    }

    // Liveness is based on message receipt, not parse success.
    if (!retain) {
      this.trackMessageActivity(device.name);
    }

    try {
      const parsed = parsePayload(payload);
      const now = new Date().toISOString();
      const timestampPath = this.compiledTimestampFields.get(device.name);
      const payloadTimestamp = timestampPath && typeof parsed === 'object' && parsed !== null
        ? this.resolveTimestamp(this.getFieldFast(parsed, timestampPath), now)
        : now;
      const resolvedDeviceId = this.resolveMessageDeviceId(device, parsed);
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
                resolvedDeviceId,
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
              resolvedDeviceId,
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
          resolvedDeviceId,
          topic,
          payloadTimestamp,
          retain
        ));
      }
      
      // Emit data through bounded queue for real backpressure handling.
      this.enqueueData(points, topic);

      if (retain) {
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
      
      this.enqueueData([dataPoint], topic);
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
    status.communicationQuality = 'good';
    
    // Note: Don't set connected=true here
    // Let higher-level logic decide connectivity based on:
    // - Time since lastSeen (staleness)
    // - LWT messages
    // - Application requirements
  }
}

