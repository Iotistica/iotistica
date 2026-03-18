import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { deviceTopic } from '../../mqtt/topics.js';
import type { AnomalyDetectionService } from '../../anomaly/index.js';
import type { DeviceConfig, MqttConnection, Logger, DeviceStats } from './types.js';
import { DeviceState } from './types.js';
import { AnomalyFeed } from './anomaly/feed.js';
import { AnomalyEnricher } from './anomaly/enrich.js';
import { PayloadCompressor } from './compression/compress.js';
import { MessageBatcher } from './batch.js';
import { EndpointConnection } from './connection.js';
import { PublishStats } from './stats.js';
import { HeartbeatManager } from './heartbeat.js';

// ============================================================================
// MODULE-LEVEL ANOMALY SERVICE  backward compat for ai.ts:
//   const { configureAnomalyFeed } = await import('../features/publish/manager.js');
//   configureAnomalyFeed(anomalyService);
// ============================================================================

let anomalyService: AnomalyDetectionService | undefined;

export function configureAnomalyFeed(service: AnomalyDetectionService | undefined): void {
  anomalyService = service;
}

// Adaptive batch safety limits (calculated once at module load)
const MAX_BATCH_MESSAGES = 10000;
const MAX_BATCH_BYTES = (() => {
  const heapLimit = getHeapStatistics().heap_size_limit;
  return Math.min(10 * 1024 * 1024, Math.floor(heapLimit * 0.05));
})();

// ============================================================================
// PUBLISH MANAGER
// ============================================================================

export class PublishManager extends EventEmitter {
  private readonly batcher: MessageBatcher;
  private readonly connection: EndpointConnection;
  private readonly compressor: PayloadCompressor;
  private readonly stats: PublishStats;
  private readonly feed: AnomalyFeed;
  private readonly enricher: AnomalyEnricher;
  private heartbeat?: HeartbeatManager;
  private bufferTimer: NodeJS.Timeout | null = null;
  private needStop = false;

  constructor(
    private readonly config: DeviceConfig,
    private readonly mqttConnection: MqttConnection,
    private readonly logger: Logger | undefined,
    private readonly deviceUuid: string,
    dictionaryManager?: any,
    useMsgpackPoc = false,
    useKeyCompactionPoc = false,
    useDeflatePoc = false,
    private readonly protocol?: string,
  ) {
    super();

    this.batcher = new MessageBatcher(config, MAX_BATCH_MESSAGES, MAX_BATCH_BYTES, logger);
    this.connection = new EndpointConnection(config, logger);
    this.compressor = new PayloadCompressor(
      { useMsgpack: useMsgpackPoc, useKeyCompaction: useKeyCompactionPoc, useDeflate: useDeflatePoc },
      mqttConnection, dictionaryManager, logger, protocol, config.name,
    );
    this.stats = new PublishStats();
    this.feed = new AnomalyFeed(() => anomalyService, deviceUuid, protocol, logger);
    this.enricher = new AnomalyEnricher(() => anomalyService, deviceUuid, protocol, logger);

    this.batcher.on('flush', () => { this.publishBatch(); });
    this.batcher.on('message-added', () => { this.stats.data.messagesReceived++; });

    this.connection.on('connected', () => {
      this.stats.recordConnected();
      if (config.bufferTimeMs > 0) this.startBufferTimer();
      this.emit('connected');
    });
    this.connection.on('data', (buf: Buffer) => {
      this.stats.data.bytesReceived += buf.length;
      this.batcher.appendData(buf);
    });
    this.connection.on('error', (err: Error) => {
      this.stats.recordError(err.message);
      this.emit('error', err);
    });
    this.connection.on('disconnected', () => {
      if (this.batcher.messageCount > 0) this.publishBatch();
      this.emit('disconnected');
    });
    this.connection.on('reconnecting', () => {
      this.stats.data.reconnectAttempts++;
    });
  }

  async start(): Promise<void> {
    const name = this.config.name || 'unknown';
    if (!this.config.enabled) {
      this.logger?.info(`Endpoint '${name}' is disabled`);
      return;
    }
    this.logger?.info(`Starting endpoint '${name}'`);
    this.needStop = false;

    if (this.config.mqttHeartbeatTopic) {
      this.heartbeat = new HeartbeatManager(this.config, this.mqttConnection, this.deviceUuid, this.logger);
      this.heartbeat.start(
        () => this.connection.state,
        () => this.getStats(),
      );
    }

    this.connection.connect();
  }

  async stop(): Promise<void> {
    const name = this.config.name || 'unknown';
    this.logger?.info(`Stopping endpoint '${name}'`);
    this.needStop = true;

    this.heartbeat?.stop();
    this.clearBufferTimer();
    this.connection.disconnect();

    if (this.batcher.messageCount > 0) await this.publishBatch();
  }

  getStats(): DeviceStats {
    return { ...this.stats.data };
  }

  getState(): DeviceState {
    return this.connection.state;
  }

  updateInterval(intervalMs: number): void {
    if (intervalMs < 1000) throw new Error(`Invalid interval: minimum 1000ms`);
    this.config.publishInterval = intervalMs;
    this.logger?.info(`Updated interval for '${this.config.name || 'unknown'}': ${intervalMs}ms`);
  }

  // --------------------------------------------------------------------------

  private async publishBatch(): Promise<void> {
    if (this.batcher.messageCount === 0) return;

    const name = this.config.name || 'unknown';
    const topic = deviceTopic(this.deviceUuid, 'endpoints', this.config.mqttTopic);
    const messageCount = this.batcher.messageCount;
    const batchBytes = this.batcher.totalBytes;

    // 1. Feed anomaly detection (side-effect only  mutates service state)
    this.feed.processBatch(this.batcher.messages, name);

    // 2. Enrich messages with anomaly scores / forecasts
    const enriched = this.enricher.enrich(this.batcher.messages, name);

    // 3. Build publish payload
    const timestampIso = new Date().toISOString();
    const data = { sensor: name, timestamp: timestampIso, messages: enriched };
    const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');

    // 4. Offline: buffer to local database
    if (!this.mqttConnection.isConnected()) {
      await this.bufferOfflineMessages(topic, data, messageCount);
      return;
    }

    // 5. Compress + publish
    try {
      const { payload, info } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished);
      await this.mqttConnection.publish(topic, payload, { qos: 1 });
      this.stats.recordPublish(messageCount, batchBytes);
      this.stats.logPublishSuccess(messageCount, batchBytes, info, name, this.logger);
      if (Array.isArray(enriched)) enriched.length = 0;
      this.batcher.reset();
    } catch (err) {
      this.logger?.error(`Failed to publish batch from endpoint '${name}'`, err);
    }
  }

  private async bufferOfflineMessages(topic: string, data: unknown, messageCount: number): Promise<void> {
    const name = this.config.name || 'unknown';
    this.logger?.warn(`MQTT not connected  buffering ${messageCount} messages from '${name}'`);
    try {
      const { MessageBufferModel } = await import('../../db/models/index.js');
      const jsonPayload = JSON.stringify(data);
      await MessageBufferModel.enqueue({
        endpoint_name: name,
        topic,
        qos: 1,
        payload: jsonPayload,
        payload_bytes: Buffer.byteLength(jsonPayload, 'utf8'),
      });
      this.batcher.reset();
    } catch (err) {
      this.logger?.error(`Failed to buffer messages from endpoint '${name}'`, err);
    }
  }

  private startBufferTimer(): void {
    this.clearBufferTimer();
    this.bufferTimer = setInterval(() => {
      if (this.batcher.messageCount > 0) this.publishBatch();
    }, this.config.bufferTimeMs);
  }

  private clearBufferTimer(): void {
    if (this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
  }
}
