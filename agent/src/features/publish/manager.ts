import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { agentTopic } from '../../mqtt/topics.js';
import type { PipelineService } from '../pipeline/index.js';
import type { AnomalyDetectionService } from '../../anomaly/index.js';
import type { Protocol } from '../../anomaly/types.js';
import type { DeviceConfig, MqttConnection, Logger, DeviceStats } from './types.js';
import { DeviceState } from './types.js';
import { AnomalyFeed } from './anomaly/feed.js';
import { AnomalyEnricher } from './anomaly/enrich.js';
import { PayloadCompressor } from './compression/compress.js';
import { MessageBatcher } from './batch.js';
import { DeviceConnection } from './connection.js';
import { PublishStats } from './stats.js';
import { HeartbeatManager } from './heartbeat.js';

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
  private messageBufferModel?: typeof import('../../db/models/message-buffer.model.js').MessageBufferModel;
  private messageBufferModelPromise?: Promise<typeof import('../../db/models/message-buffer.model.js').MessageBufferModel>;
  private readonly batcher: MessageBatcher;
  private readonly connection: DeviceConnection;
  private readonly compressor: PayloadCompressor;
  private readonly stats: PublishStats;
  private readonly feed: AnomalyFeed;
  private readonly enricher: AnomalyEnricher;
  private heartbeat?: HeartbeatManager;
  private bufferTimer: NodeJS.Timeout | null = null;
  private needStop = false;
  private publishing = false;
  private connectionHandlersAttached = false;
  private pipelineService?: PipelineService;

  private readonly onConnected = (): void => {
    if (this.needStop) return;
    this.stats.recordConnected();
    if (this.config.bufferTimeMs > 0) this.startBufferTimer();
    this.emit('connected');
  };

  private readonly onData = (buf: Buffer): void => {
    if (this.needStop) return;
    this.stats.data.bytesReceived += buf.length;
    this.batcher.appendData(buf);
  };

  private readonly onConnectionError = (err: Error): void => {
    if (this.needStop) return;
    this.stats.recordError(err.message);
    this.emit('error', err);
  };

  private readonly onDisconnected = (): void => {
    if (this.needStop) return;
    if (this.batcher.messageCount > 0) {
      this.publishBatch().catch((err) => {
        this.logger?.error('Failed to publish batch on disconnect', err);
      });
    }
    this.emit('disconnected');
  };

  private readonly onReconnecting = (): void => {
    if (this.needStop) return;
    this.stats.data.reconnectAttempts++;
  };

  constructor(
    private readonly config: DeviceConfig,
    private readonly mqttConnection: MqttConnection,
    private readonly logger: Logger | undefined,
    private readonly deviceUuid: string,
    dictionaryManager?: any,
    useMsgpackPoc = false,
    useKeyCompactionPoc = false,
    useDeflatePoc = false,
    private readonly protocol?: Protocol,
    private anomalyService?: AnomalyDetectionService,
  ) {
    super();

    this.batcher = new MessageBatcher(config, MAX_BATCH_MESSAGES, MAX_BATCH_BYTES, logger);
    this.connection = new DeviceConnection(config, logger);
    this.compressor = new PayloadCompressor(
      { useMsgpack: useMsgpackPoc, useKeyCompaction: useKeyCompactionPoc, useDeflate: useDeflatePoc },
      mqttConnection, dictionaryManager,  protocol,
    );
    this.stats = new PublishStats();
    this.feed = new AnomalyFeed(() => this.anomalyService, deviceUuid, protocol, logger);
    this.enricher = new AnomalyEnricher(() => this.anomalyService, deviceUuid, protocol);

    this.batcher.on('flush', () => { this.publishBatch(); });
    this.batcher.on('message-added', () => { this.stats.data.messagesReceived++; });
  }

  public setAnomalyService(service?: AnomalyDetectionService): void {
    this.anomalyService = service;
  }

  public setPipelineService(service?: PipelineService): void {
    this.pipelineService = service;
  }

  async start(): Promise<void> {
    const name = this.config.name || 'unknown';
    if (!this.config.enabled) {
      this.logger?.info(`Endpoint '${name}' is disabled`);
      return;
    }
    this.logger?.info(`Starting endpoint '${name}'`);
    this.needStop = false;
    this.attachConnectionHandlers();

    if (this.config.mqttHeartbeatTopic) {
      this.heartbeat = new HeartbeatManager(this.config, this.mqttConnection, this.deviceUuid, this.logger);
      this.heartbeat.start(
        () => this.connection.state,
        () => this.getStats(),
      );
    }

    this.clearBufferTimer();
    if (this.config.bufferTimeMs > 0) this.startBufferTimer();
    this.connection.connect();
  }

  async stop(): Promise<void> {
    const name = this.config.name || 'unknown';
    this.logger?.info(`Stopping endpoint '${name}'`);
    this.needStop = true;

    this.heartbeat?.stop();
    this.clearBufferTimer();
    this.detachConnectionHandlers();
    this.connection.disconnect();

    if (this.batcher.messageCount > 0) await this.publishBatch();
  }

  getStats(): DeviceStats {
    return { ...this.stats.data };
  }

  getState(): DeviceState {
    return this.connection.state;
  }

  /**
   * Inject a simulated protocol message directly into the same publish pipeline.
   * This reuses batching, anomaly enrichment, compression, and MQTT publish paths.
   */
  public injectSimulationMessage(message: Record<string, any>): void {
    if (this.needStop) {
      return;
    }

    try {
      const raw = JSON.stringify(message) + this.config.eomDelimiter;
      this.batcher.appendData(Buffer.from(raw, 'utf8'));
    } catch (error) {
      this.logger?.error(`Failed to inject simulation message for endpoint '${this.config.name || 'unknown'}'`, error);
    }
  }

  getRuntimeSnapshot(staleThresholdMs = 60000): Record<string, any> {
    const stats = this.getStats();
    const state = this.getState();
    const hasRecentData = stats.lastPublishTime &&
      (Date.now() - stats.lastPublishTime.getTime()) < staleThresholdMs;
    const healthy = state === DeviceState.CONNECTED && (hasRecentData || stats.messagesReceived === 0);

    return {
      state,
      addr: this.config.addr,
      enabled: this.config.enabled !== false,
      healthy,
      lastError: stats.lastError || null,
      lastErrorTime: stats.lastErrorTime || null,
      ...stats,
    };
  }

  updateInterval(intervalMs: number): void {
    if (intervalMs < 1000) throw new Error(`Invalid interval: minimum 1000ms`);
    this.config.publishInterval = intervalMs;
    this.logger?.info(`Updated interval for '${this.config.name || 'unknown'}': ${intervalMs}ms`);
  }

  // --------------------------------------------------------------------------

  private async publishBatch(): Promise<void> {
    if (this.needStop) return;
    if (this.batcher.messageCount === 0) return;
    if (this.publishing) return;

    this.publishing = true;
    try {

      const name = this.config.name || 'unknown';
      const topic = agentTopic(this.deviceUuid, 'endpoints', this.config.mqttTopic);
      const messageCount = this.batcher.messageCount;
      const batchBytes = this.batcher.totalBytes;
        const messages = [...this.batcher.messages];

        const enriched = this.processAnomaly(messages, name);
      if (this.needStop) return;

      let { data, baselineSize } = this.buildPayload(name, enriched);
      if (this.needStop) return;

      // Run payload through the Node-RED pipeline (if configured)
      if (this.pipelineService) {
        try {
          const pipelineStart = Date.now();
          const result = await this.pipelineService.transform({
            payload: data,
            topic,
            deviceId: name,
          });
          if (result.drop) {
            this.logger?.debug(`Pipeline dropped batch from endpoint '${name}'`);
            this.batcher.reset();
            return;
          }
          const transformed = result.payload as typeof data;
          baselineSize = Buffer.byteLength(JSON.stringify(transformed), 'utf8');
          data = transformed;
          this.logger?.debug(`Pipeline transform applied for '${name}': ${transformed.messages?.length ?? 0} messages, ${baselineSize} bytes in ${Date.now() - pipelineStart}ms`);
        } catch (err) {
          this.logger?.warn(`Pipeline transform failed for '${name}', publishing original payload`, err);
        }
      }

      if (!this.mqttConnection.isConnected()) {
        await this.publishOffline(topic, data, messageCount);
        return;
      }

      await this.publishOnline(topic, data, baselineSize, messageCount, batchBytes, enriched, name);
    } finally {
      this.publishing = false;
    }
  }

  private processAnomaly(messages: any[], endpointName: string): any[] {
    if (!this.anomalyService) {
      this.logger?.debug('Skipping endpoint anomaly processing: no anomaly service bound', {
        endpointName,
        messageCount: messages.length,
      });
      return messages;
    }

    this.logger?.debug('Dispatching endpoint batch to anomaly feed', {
      endpointName,
      messageCount: messages.length,
    });
    this.feed.processBatch(messages, endpointName);
    return this.enricher.enrich(messages, endpointName);
  }

  private buildPayload(endpointName: string, messages: any[]): {
    data: { sensor: string; timestamp: string; messages: any[] };
    baselineSize: number;
  } {
    const timestampIso = new Date().toISOString();
    const data = { sensor: endpointName, timestamp: timestampIso, messages };
    const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
    return { data, baselineSize };
  }

  private async publishOnline(
    topic: string,
    data: { sensor: string; timestamp: string; messages: any[] },
    baselineSize: number,
    messageCount: number,
    batchBytes: number,
    enriched: any[],
    endpointName: string,
  ): Promise<void> {
    if (this.needStop) return;
    try {
      const { payload, info } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished);
      if (this.needStop) return;
      await this.mqttConnection.publish(topic, payload, { qos: 1 });
      this.stats.recordPublish(messageCount, batchBytes);
      this.stats.logPublishSuccess(messageCount, batchBytes, info, endpointName, this.logger);
      this.batcher.reset();
    } catch (err) {
      this.logger?.error(`Failed to publish batch from endpoint '${endpointName}'`, err);
    }
  }

  private async publishOffline(
    topic: string,
    data: { sensor: string; timestamp: string; messages: any[] },
    messageCount: number,
  ): Promise<void> {
    if (this.needStop) return;
    await this.bufferOfflineMessages(topic, data, messageCount);
  }

  private async bufferOfflineMessages(topic: string, data: unknown, messageCount: number): Promise<void> {
    const name = this.config.name || 'unknown';
    this.logger?.warn(`MQTT not connected  buffering ${messageCount} messages from '${name}'`);
    try {
      const MessageBufferModel = await this.getMessageBufferModel();
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
      this.logger?.error(`Failed to buffer messages from device '${name}'`, err);
    }
  }

  private async getMessageBufferModel(): Promise<typeof import('../../db/models/message-buffer.model.js').MessageBufferModel> {
    if (this.messageBufferModel) {
      return this.messageBufferModel;
    }

    if (!this.messageBufferModelPromise) {
      this.messageBufferModelPromise = import('../../db/models/index.js')
        .then(({ MessageBufferModel }) => {
          this.messageBufferModel = MessageBufferModel;
          return MessageBufferModel;
        })
        .finally(() => {
          this.messageBufferModelPromise = undefined;
        });
    }

    return this.messageBufferModelPromise;
  }

  private startBufferTimer(): void {
    if (this.needStop) return;
    this.clearBufferTimer();
    this.bufferTimer = setInterval(() => {
      if (this.needStop) return;
      if (this.batcher.messageCount > 0) this.publishBatch();
    }, this.config.bufferTimeMs);
  }

  private clearBufferTimer(): void {
    if (this.bufferTimer) {
      clearInterval(this.bufferTimer);
      this.bufferTimer = null;
    }
  }

  private attachConnectionHandlers(): void {
    if (this.connectionHandlersAttached) return;
    this.connection.on('connected', this.onConnected);
    this.connection.on('data', this.onData);
    this.connection.on('error', this.onConnectionError);
    this.connection.on('disconnected', this.onDisconnected);
    this.connection.on('reconnecting', this.onReconnecting);
    this.connectionHandlersAttached = true;
  }

  private detachConnectionHandlers(): void {
    if (!this.connectionHandlersAttached) return;
    this.connection.off('connected', this.onConnected);
    this.connection.off('data', this.onData);
    this.connection.off('error', this.onConnectionError);
    this.connection.off('disconnected', this.onDisconnected);
    this.connection.off('reconnecting', this.onReconnecting);
    this.connectionHandlersAttached = false;
  }
}
