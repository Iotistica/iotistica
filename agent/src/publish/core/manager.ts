import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { agentTopic } from '../../mqtt/topics.js';
import type { PipelineService } from '../../features/pipeline/index.js';
import type { AnomalyDetectionService } from '../../anomaly/index.js';
import type { Protocol } from '../../anomaly/types.js';
import type { DeviceConfig, MqttConnection, Logger, DeviceStats, IPublishSink } from './types.js';
import { DeviceState } from './types.js';
import { AnomalyFeed } from '../anomaly/feed.js';
import { AnomalyEnricher } from '../anomaly/enrich.js';
import { PayloadCompressor } from '../compression/compress.js';
import { MessageBatcher } from './batch.js';
import { SocketConnection } from './socket.js';
import { PublishStats } from './stats.js';
import { HeartbeatManager } from './heartbeat.js';
import { SchemaDriftDetector } from './drift.js';
import { SchemaDriftModel } from '../../db/models/schema-drift.model.js';
import type { DictionaryManager } from '../../mqtt/dictionary.js';

// Adaptive batch safety limits (calculated once at module load)
const MAX_BATCH_MESSAGES = 10000;
const MAX_BATCH_BYTES = (() => {
	const heapLimit = getHeapStatistics().heap_size_limit;
	return Math.min(10 * 1024 * 1024, Math.floor(heapLimit * 0.05));
})();

type ExternalPayloadFormat = 'custom' | 'tags' | 'ecp';

type PublishPayload = Record<string, unknown>;

export class PublishManager extends EventEmitter {
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private messageBufferModel?: typeof import('../../db/models/buffer.model.js').MessageBufferModel;
	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private messageBufferModelPromise?: Promise<typeof import('../../db/models/buffer.model.js').MessageBufferModel>;
	private readonly batcher: MessageBatcher;
	private readonly connection: SocketConnection;
	private readonly compressor: PayloadCompressor;
	private readonly stats: PublishStats;
	private readonly feed: AnomalyFeed;
	private readonly enricher: AnomalyEnricher;
	private readonly schemaDriftDetector: SchemaDriftDetector;
	private heartbeat?: HeartbeatManager;
	private bufferTimer: NodeJS.Timeout | null = null;
	private needStop = false;
	private publishing = false;
	private connectionHandlersAttached = false;
	private pipelineService?: PipelineService;
	private liveDataInterceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[];

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
	private readonly publishPlugin: IPublishSink,
    private readonly logger: Logger | undefined,
    private readonly deviceUuid: string,
	private dictionaryManager?: DictionaryManager,
    private useMsgpackPoc = false,
    private useKeyCompactionPoc = false,
    private useDeflatePoc = false,
    private readonly protocol: Protocol = 'mqtt',
    private anomalyService?: AnomalyDetectionService,
		private readonly externalPayloadFormat: ExternalPayloadFormat = 'custom',
	) {
		super();

		this.batcher = new MessageBatcher(config, MAX_BATCH_MESSAGES, MAX_BATCH_BYTES, logger);
		this.connection = new SocketConnection(config, logger);
		this.compressor = new PayloadCompressor(
			{ useMsgpack: useMsgpackPoc, useKeyCompaction: useKeyCompactionPoc, useDeflate: useDeflatePoc },
			mqttConnection, dictionaryManager,  protocol,
		);
		this.stats = new PublishStats();
		this.feed = new AnomalyFeed(() => this.anomalyService, deviceUuid, protocol, logger);
		this.enricher = new AnomalyEnricher(() => this.anomalyService, deviceUuid, protocol);
		this.schemaDriftDetector = new SchemaDriftDetector(
			config.name || 'unknown',
			logger,
			undefined,
			SchemaDriftModel,
		);

		this.batcher.on('flush', () => { this.publishBatch(); });
		this.batcher.on('message-added', () => { this.stats.data.messagesReceived++; });
	}

	public setAnomalyService(service?: AnomalyDetectionService): void {
		this.anomalyService = service;
	}

	public setPipelineService(service?: PipelineService): void {
		this.pipelineService = service;
	}

	public setLiveDataInterceptor(interceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[]): void {
		this.liveDataInterceptor = interceptor;
	}

	async start(): Promise<void> {
		const name = this.config.name || 'unknown';
		if (!this.config.enabled) {
			this.logger?.info(`Endpoint '${name}' is disabled`);
			return;
		}
		this.logger?.info(`Starting endpoint '${name}'`);
		this.needStop = false;
		await this.publishPlugin.start();
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
		await this.publishPlugin.stop();
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
			let messages = [...this.batcher.messages];

			if (this.liveDataInterceptor) {
				try {
					const intercepted = await this.liveDataInterceptor(messages, name);
					if (Array.isArray(intercepted)) {
						messages = intercepted;
					}
				} catch (err) {
					this.logger?.warn(`Live data interceptor failed for endpoint '${name}', continuing with original payload`, err);
				}
			}

			try {
				this.schemaDriftDetector.observe(messages);
			} catch (err) {
				this.logger?.warn(`Schema drift detector failed for endpoint '${name}', continuing with original payload`, err);
			}

			const enriched = this.processAnomaly(messages, name);
			if (this.needStop) return;

			let { data, baselineSize, msgId } = this.buildPayload(name, enriched);
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
					const transformed = result.payload as PublishPayload;
					baselineSize = Buffer.byteLength(JSON.stringify(transformed), 'utf8');
					data = transformed;
					if (typeof (transformed as { msgId?: unknown }).msgId === 'string') {
						msgId = (transformed as { msgId: string }).msgId;
					}
					const transformedMessageCount = Array.isArray((transformed as { messages?: unknown }).messages)
						? ((transformed as { messages: unknown[] }).messages).length
						: 0;
					this.logger?.debug(`Pipeline transform applied for '${name}': ${transformedMessageCount} messages, ${baselineSize} bytes in ${Date.now() - pipelineStart}ms`);
				} catch (err) {
					this.logger?.warn(`Pipeline transform failed for '${name}', publishing original payload`, err);
				}
			}

			if (!this.publishPlugin.isConnected()) {
				await this.publishOffline(topic, data, msgId, messageCount);
				return;
			}

			await this.publishOnline(topic, data, msgId, baselineSize, messageCount, batchBytes, enriched, name);
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
    data: PublishPayload;
    msgId: string;
    baselineSize: number;
  } {
		const msgId = this.mqttConnection.getMessageIdGenerator?.()?.generate()
			?? `${this.deviceUuid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		if (this.externalPayloadFormat === 'tags' || this.externalPayloadFormat === 'ecp') {
			const externalGroupName = this.normalizeExternalGroupName(endpointName);
			const parsedMessages = messages as Array<Record<string, unknown>>;
			const tagRecords: Record<string, unknown>[] = [];
			for (const message of parsedMessages) {
				if (Array.isArray(message?.readings)) {
					for (const reading of message.readings as Array<Record<string, unknown>>) {
						tagRecords.push(reading);
					}
				} else {
					tagRecords.push(message);
				}
			}
			const externalNodeName = this.resolveExternalNodeName(externalGroupName, parsedMessages, tagRecords);

			const timestampMs = Date.now();
			const tags = tagRecords
				.map((message: Record<string, unknown>, index: number) => {
					const name = String(
						message.metric
					?? message.metric_name
					?? message.nodeName
					?? message.name
					?? message.tag
					?? message.id
					?? `tag_${index}`,
					);
					const quality = typeof message.quality === 'string' ? message.quality.toUpperCase() : undefined;
					const hasError = message.error !== undefined
					|| message.errorCode !== undefined
					|| quality === 'BAD'
					|| message.qualityCode !== undefined;

					if (hasError) {
					// ECP format does not include/report tag error codes.
						if (this.externalPayloadFormat === 'ecp') {
							return null;
						}

						return {
							name,
							error: message.error ?? message.errorCode ?? message.qualityCode ?? 'READ_ERROR',
						};
					}

					const value = message.value ?? message.rawValue ?? null;
					if (this.externalPayloadFormat === 'ecp') {
						if (value === null || value === undefined) {
							return null;
						}
						return {
							name,
							value,
							type: this.inferEcpType(value),
						};
					}

					return {
						name,
						value,
					};
				})
				.filter((tag) => tag !== null);

			const data = {
				timestamp: timestampMs,
				node: externalNodeName,
				group: externalGroupName,
				tags,
			};

			const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
			return { data, msgId, baselineSize };
		}

		const timestampIso = new Date().toISOString();
		const data = {
			timestamp: timestampIso,
			protocol: this.protocol,
			messages,
			msgId,
		};
		const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
		return { data, msgId, baselineSize };
	}

	private normalizeExternalGroupName(endpointName: string): string {
		return endpointName.replace(/(?:^|[-_\s])pipe$/i, '').replace(/[-_\s]+$/g, '');
	}

	private resolveExternalNodeName(
		externalGroupName: string,
		messages: Array<Record<string, unknown>>,
		tagRecords: Array<Record<string, unknown>>,
	): string {
		const candidates = [
			...messages,
			...tagRecords,
		];

		for (const candidate of candidates) {
			const resolved = this.readExternalNodeCandidate(candidate);
			if (resolved) {
				return this.normalizeExternalGroupName(resolved);
			}
		}

		return externalGroupName;
	}

	private readExternalNodeCandidate(message: Record<string, unknown>): string | null {
		const value = message.deviceName
			?? message.device_name
			?? message.resolvedDisplayName
			?? message.resolved_display_name
			?? message.sourceDeviceName
			?? message.source_device_name
			?? null;

		if (typeof value !== 'string') {
			return null;
		}

		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}

	private inferEcpType(value: unknown): 1 | 2 | 3 | 4 {
		if (typeof value === 'boolean') {
			return 1;
		}

		if (typeof value === 'number') {
			if (Number.isInteger(value)) {
				return 2;
			}
			return 3;
		}

		return 4;
	}

	private async persistQueuedBatch(
		topic: string,
		data: PublishPayload,
		msgId: string,
	): Promise<number> {
		const MessageBufferModel = await this.getMessageBufferModel();
		const jsonPayload = JSON.stringify(data);

		return MessageBufferModel.enqueue({
			endpoint_name: this.config.name || 'unknown',
			topic,
			qos: 1,
			payload: jsonPayload,
			msg_id: msgId,
			payload_bytes: Buffer.byteLength(jsonPayload, 'utf8'),
		});
	}

	private async persistClaimedBatch(
		topic: string,
		data: PublishPayload,
		msgId: string,
	): Promise<{ id: number; lockId: string }> {
		const MessageBufferModel = await this.getMessageBufferModel();
		const jsonPayload = JSON.stringify(data);
		const lockId = `inline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		const id = MessageBufferModel.enqueueClaimed(
			{
				endpoint_name: this.config.name || 'unknown',
				topic,
				qos: 1,
				payload: jsonPayload,
				msg_id: msgId,
				payload_bytes: Buffer.byteLength(jsonPayload, 'utf8'),
			},
			lockId,
		);

		return { id, lockId };
	}

	private async publishOnline(
		topic: string,
		data: PublishPayload,
		msgId: string,
		baselineSize: number,
		messageCount: number,
		batchBytes: number,
		enriched: any[],
		endpointName: string,
	): Promise<void> {
		if (this.needStop) return;
		let bufferedRecordId: number | undefined;
		let publishConfirmed = false;

		try {
			const claimed = await this.persistClaimedBatch(topic, data, msgId);
			bufferedRecordId = claimed.id;
			if (this.needStop) {
				const MessageBufferModel = await this.getMessageBufferModel();
				MessageBufferModel.markRetryFailed(claimed.id, 'Publish interrupted during shutdown');
				this.batcher.reset();
				return;
			}

			const { payload, info } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished);
			if (this.needStop) {
				const MessageBufferModel = await this.getMessageBufferModel();
				MessageBufferModel.markRetryFailed(claimed.id, 'Publish interrupted during shutdown');
				this.batcher.reset();
				return;
			}

			await this.publishPlugin.publishBatch([
				{ topic, payload, options: { qos: 1 } },
			]);
			publishConfirmed = true;

			const buffered = this.mqttConnection.getPublishMode?.() !== 'direct';
			const MessageBufferModel = await this.getMessageBufferModel();
			MessageBufferModel.deleteByIds([claimed.id]);
			this.stats.recordPublish(messageCount, batchBytes);
			this.stats.logPublishSuccess(messageCount, batchBytes, info, endpointName, this.logger, buffered);
			this.batcher.reset();
		} catch (err) {
			this.logger?.error(`Failed to publish batch from endpoint '${endpointName}'`, err);

			try {
				if (publishConfirmed) {
					this.batcher.reset();
					this.logger?.error(
						`Published batch from endpoint '${endpointName}' but failed to clean durable buffer record; leaving claimed row for timeout recovery`,
						err,
					);
				} else if (bufferedRecordId !== undefined) {
					const MessageBufferModel = await this.getMessageBufferModel();
					MessageBufferModel.markRetryFailed(
						bufferedRecordId,
						err instanceof Error ? err.message : String(err),
					);
					this.batcher.reset();
					this.logger?.warn(`Queued failed publish for endpoint '${endpointName}' for durable retry`);
				} else {
					await this.publishOffline(topic, data, msgId, messageCount);
					this.logger?.warn(`Buffered failed publish for endpoint '${endpointName}' to durable storage`);
				}
			} catch (bufferError) {
				this.logger?.error(`Failed to durably buffer publish failure for endpoint '${endpointName}'`, bufferError);
			}
		}
	}

	private async publishOffline(
		topic: string,
		data: PublishPayload,
		msgId: string,
		messageCount: number,
	): Promise<void> {
		if (this.needStop) return;
		await this.bufferOfflineMessages(topic, data, msgId, messageCount);
	}

	private async bufferOfflineMessages(
		topic: string,
		data: PublishPayload,
		msgId: string,
		messageCount: number,
	): Promise<void> {
		const name = this.config.name || 'unknown';
		this.logger?.warn(`MQTT not connected  buffering ${messageCount} messages from '${name}'`);
		try {
			await this.persistQueuedBatch(topic, data, msgId);
			this.batcher.reset();
		} catch (err) {
			this.logger?.error(`Failed to buffer messages from device '${name}'`, err);
		}
	}

	// eslint-disable-next-line @typescript-eslint/consistent-type-imports
	private async getMessageBufferModel(): Promise<typeof import('../../db/models/buffer.model.js').MessageBufferModel> {
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
