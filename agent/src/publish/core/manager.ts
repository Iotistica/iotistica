import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { agentTopic } from '../../mqtt/topics.js';
import type { AnomalyDetectionService } from '../../anomaly/index.js';
import type { Protocol } from '../../anomaly/types.js';
import type { DeviceConfig, MqttConnection, Logger, DeviceStats, IPublishClient, IPublishPlugin } from './types.js';
import { DeviceState, normalizeTarget } from './types.js';
import { AnomalyFeed } from '../anomaly/feed.js';
import { AnomalyEnricher } from '../anomaly/enrich.js';
import { PayloadCompressor } from './compress.js';
import type { CompressorOptions } from './compress.js';
import { compressionToOpts } from './compress.js';
import { MessageBatcher } from './batch.js';
import { SocketConnection } from './socket.js';
import { PublishStats } from './stats.js';
import { HeartbeatManager } from './heartbeat.js';
import { SchemaDriftDetector } from './drift.js';
import { SchemaDriftModel } from '../../db/models/schema-drift.model.js';
import type { DictionaryManager } from '../../mqtt/dictionary.js';
import type { PublishDestinationInfo, PublishBatchItem } from './types.js';
import { PublishDestinationsModel, PublishSubscriptionsModel } from '../../db/models/index.js';
import type { PublisherRecord, PublishSubscriptionRecord, PublishSubscriptionRoute, SubscriptionCompression } from '../../db/models/index.js';

// Adaptive batch safety limits (calculated once at module load)
const MAX_BATCH_MESSAGES = 10000;
const MAX_BATCH_BYTES = (() => {
	const heapLimit = getHeapStatistics().heap_size_limit;
	return Math.min(10 * 1024 * 1024, Math.floor(heapLimit * 0.05));
})();

type PayloadFormat = 'custom' | 'tags' | 'ecp';

type PublishPayload = Record<string, unknown>;

interface ProtocolMessage extends Record<string, unknown> {
	readings?: ProtocolMessage[];
}

interface TagPayload {
	name: string;
	value?: unknown;
	error?: unknown;
	type?: 1 | 2 | 3 | 4;
}

interface RuntimeSnapshot {
	state: DeviceState;
	addr: string;
	enabled: boolean;
	healthy: boolean;
	lastError: string | null;
	lastErrorTime: Date | null;
	messagesReceived: number;
	messagesPublished: number;
	bytesReceived: number;
	bytesPublished: number;
	reconnectAttempts: number;
	lastPublishTime?: Date;
	lastHeartbeatTime?: Date;
	lastConnectedTime?: Date;
}

interface HostBinding {
	subscription: PublishSubscriptionRecord;
	publisher: PublisherRecord;
	plugin: IPublishPlugin;
}

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
	private liveDataInterceptor?: (messages: ProtocolMessage[], endpointName: string) => Promise<ProtocolMessage[]> | ProtocolMessage[];
	private bindings: HostBinding[] = [];
	private pluginByDestinationId: Map<number, IPublishPlugin> = new Map();
	// Serializes concurrent reloadBindings() calls so only one runs at a time.
	// Without this, two rapid admin-UI actions can create zombie plugins that escape
	// the stop-before-start guard and produce a duplicate-clientId kick cycle.
	private reloadQueue: Promise<void> = Promise.resolve();

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
    private readonly protocol: Protocol,
    private readonly endpointName: string,
    private readonly defaultClient: IPublishClient,
		private readonly buildPlugin: (publisher: PublisherRecord, client: IPublishClient, logger?: Logger, endpointName?: string) => IPublishPlugin,
    private readonly logger: Logger | undefined,
    private readonly deviceUuid: string,
	private dictionaryManager?: DictionaryManager,
    private useMsgpackPoc = false,
    private useKeyCompactionPoc = false,
    private useDeflatePoc = false,
    private anomalyService?: AnomalyDetectionService,
	private readonly payloadFormat: PayloadFormat = 'custom',
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

	public setLiveDataInterceptor(interceptor?: (messages: ProtocolMessage[], endpointName: string) => Promise<ProtocolMessage[]> | ProtocolMessage[]): void {
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

		this.bindings = this.loadBindings();
		if (this.bindings.length === 0) {
			if (this.defaultClient.isConnected()) {
				this.logger?.warn('No publisher bindings found; using default Iotistica');
				this.bindings = this.createDefaultIotisticaBinding();
			} else {
				this.logger?.info('No publisher bindings found; waiting for bindings to be configured');
			}
		}

		// Try to start plugins and fall back to default if all fail
		const startedPlugins = new Set<IPublishPlugin>();
		const failures: Array<{ plugin: IPublishPlugin; error: Error }> = [];

		for (const binding of this.bindings) {
			if (startedPlugins.has(binding.plugin)) {
				continue; // Already started this plugin instance
			}

			this.logger?.info(`Starting publish plugin`, {
				publisher: binding.publisher.name,
				type: binding.publisher.type,
			});

			try {
				await binding.plugin.start();
				startedPlugins.add(binding.plugin);
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				this.logger?.error(`Failed to start publish plugin`, error, {
					publisher: binding.publisher.name,
					type: binding.publisher.type,
				});
				failures.push({ plugin: binding.plugin, error });
				startedPlugins.add(binding.plugin); // Track as attempted
			}
		}

		// If all plugins failed and we have non-default bindings, fall back to Iotistica only when cloud is connected
		if (failures.length === startedPlugins.size && failures.length > 0 && this.bindings.some((b) => b.publisher.id !== -1)) {
			if (this.defaultClient.isConnected()) {
				this.logger?.warn(`All publish plugins failed to start; falling back to default Iotistica`, {
					failedPluginCount: failures.length,
					errors: failures.map((f) => f.error.message),
				});
				this.bindings = this.createDefaultIotisticaBinding();
				this.logger?.info(`Starting default Iotistica publish plugin`);
				try {
					await this.bindings[0].plugin.start();
				} catch (err) {
					this.logger?.error('Failed to start default Iotistica publisher', err);
					throw new Error(`All publish plugins failed and fallback also failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else {
				this.logger?.warn(`All publish plugins failed to start; cloud not connected, clearing bindings`, {
					failedPluginCount: failures.length,
					errors: failures.map((f) => f.error.message),
				});
				this.bindings = [];
			}
		}

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

		for (const plugin of this.getUniquePlugins()) {
			await plugin.stop();
		}

		this.bindings = [];
		this.pluginByDestinationId.clear();
	}

	async reloadBindings(): Promise<void> {
		// Chain onto the existing reload so concurrent calls (e.g. two rapid admin-UI
		// subscription creates) execute sequentially and never interleave plugin
		// stop/start operations — the root cause of the duplicate-clientId kick cycle.
		this.reloadQueue = this.reloadQueue.then(() => this._doReloadBindings());
		return this.reloadQueue;
	}

	private async _doReloadBindings(): Promise<void> {
		if (this.needStop) return;

		const oldPlugins = this.getUniquePlugins();
		const newBindings = this.loadBindings();

		if (newBindings.length === 0 && this.defaultClient.isConnected()) {
			newBindings.push(...this.createDefaultIotisticaBinding());
		}

		this.bindings = newBindings;
		const newPlugins = this.getUniquePlugins();

		// Stop removed plugins BEFORE starting new ones so that external MQTT clients
		// sharing the same clientId do not briefly coexist — the broker would kick the
		// old client when the new one connects, and the old client's 5-second reconnect
		// timer would then kick the new client back in an infinite cycle.
		for (const plugin of oldPlugins) {
			if (!newPlugins.includes(plugin)) {
				await plugin.stop().catch((err) => {
					this.logger?.error('Failed to stop old plugin during binding reload', err);
				});
			}
		}

		for (const plugin of newPlugins) {
			if (!oldPlugins.includes(plugin)) {
				try {
					await plugin.start();
				} catch (err) {
					this.logger?.error('Failed to start plugin during binding reload', err);
				}
			}
		}

		this.logger?.info('Reloaded publish bindings', { bindingCount: this.bindings.length });
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
	public injectSimulationMessage(message: ProtocolMessage): void {
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

	getRuntimeSnapshot(staleThresholdMs = 60000): RuntimeSnapshot {
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

		// No destinations or subscriptions configured — discard the batch silently.
		// Buffering without a destination wastes disk and misleads the operator.
		// Once bindings are added, reloadBindings() will repopulate this.bindings
		// and subsequent batches will flow normally.
		if (this.bindings.length === 0) {
			this.batcher.reset();
			return;
		}

		this.publishing = true;
		try {

			const name = this.config.name || 'unknown';
			let topic: string;
			try {
				topic = agentTopic(this.deviceUuid, 'endpoints', this.config.mqttTopic);
			} catch {
				topic = `local/${this.deviceUuid}/${this.config.mqttTopic || 'data'}`;
			}
			const messageCount = this.batcher.messageCount;
			const batchBytes = this.batcher.totalBytes;
			let messages = [...this.batcher.messages] as ProtocolMessage[];

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

			let { data, baselineSize, msgId } = this.buildPayload(name, enriched, this.payloadFormat);
			if (this.needStop) return;

			const hasExternalBindings = this.bindings.some((b) => b.publisher.type !== 'iotistica');
			if (!this.isConnected() && !hasExternalBindings) {
				await this.publishOffline(topic, data, msgId, messageCount);
				return;
			}

			await this.publishOnline(topic, data, msgId, baselineSize, messageCount, batchBytes, enriched, name);
		} finally {
			this.publishing = false;
		}
	}

	private processAnomaly(messages: ProtocolMessage[], endpointName: string): ProtocolMessage[] {
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
		return this.enricher.enrich(messages, endpointName) as ProtocolMessage[];
	}

	private buildPayload(endpointName: string, messages: ProtocolMessage[], payloadFormat: PayloadFormat): {
    data: PublishPayload;
    msgId: string;
    baselineSize: number;
  } {
		const msgId = this.mqttConnection.getMessageIdGenerator?.()?.generate()
			?? `${this.deviceUuid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		if (payloadFormat === 'custom') {
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

		const externalGroupName = this.normalizeExternalGroupName(endpointName);
		const tagRecords = this.collectTagRecords(messages);
		const externalNodeName = this.resolveExternalNodeName(externalGroupName, messages, tagRecords);
		const timestampMs = Date.now();
		const tags = tagRecords
			.map((message, index) => this.mapTagPayload(message, index, payloadFormat))
			.filter((tag): tag is TagPayload => tag !== null);

		const data = {
			timestamp: timestampMs,
			node: externalNodeName,
			group: externalGroupName,
			tags,
		};

		const baselineSize = Buffer.byteLength(JSON.stringify(data), 'utf8');
		return { data, msgId, baselineSize };
	}

	private collectTagRecords(messages: ProtocolMessage[]): ProtocolMessage[] {
		const tagRecords: ProtocolMessage[] = [];
		for (const message of messages) {
			if (Array.isArray(message.readings)) {
				tagRecords.push(...message.readings);
				continue;
			}

			tagRecords.push(message);
		}

		return tagRecords;
	}

	private mapTagPayload(message: ProtocolMessage, index: number, payloadFormat: Exclude<PayloadFormat, 'custom'>): TagPayload | null {
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
			if (payloadFormat === 'ecp') {
				return null;
			}

			return {
				name,
				error: message.error ?? message.errorCode ?? message.qualityCode ?? 'READ_ERROR',
			};
		}

		const value = message.value ?? message.rawValue ?? null;
		if (payloadFormat === 'ecp') {
			if (value === null || value === undefined) {
				return null;
			}

			return {
				name,
				value,
				type: this.inferEcpType(value),
			};
		}

		return { name, value };
	}

	private resolvePayloadFormatForBinding(binding: HostBinding): PayloadFormat {
		const candidate = String(binding.subscription.payload_format || '').toLowerCase();
		if (candidate === 'custom' || candidate === 'tags' || candidate === 'ecp') {
			return candidate;
		}

		return this.payloadFormat;
	}

	private async getCompressedPayloadForFormat(
		payloadFormat: PayloadFormat,
		cacheKey: string,
		endpointName: string,
		messages: ProtocolMessage[],
		compressedPayloadCache: Map<string, string | Buffer>,
		overrideOpts?: CompressorOptions,
	): Promise<string | Buffer> {
		const cached = compressedPayloadCache.get(cacheKey);
		if (cached !== undefined) {
			return cached;
		}

		const { data, baselineSize } = this.buildPayload(endpointName, messages, payloadFormat);
		const { payload } = await this.compressor.compress(data, baselineSize, this.stats.data.messagesPublished, overrideOpts);
		compressedPayloadCache.set(cacheKey, payload);
		return payload;
	}

	private normalizeExternalGroupName(endpointName: string): string {
		return endpointName.replace(/(?:^|[-_\s])pipe$/i, '').replace(/[-_\s]+$/g, '');
	}

	private resolveExternalNodeName(
		externalGroupName: string,
		messages: ProtocolMessage[],
		tagRecords: ProtocolMessage[],
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

	private readExternalNodeCandidate(message: ProtocolMessage): string | null {
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
		enriched: ProtocolMessage[],
		endpointName: string,
	): Promise<void> {
		if (this.needStop) return;
		let bufferedRecordId: number | undefined;
		let publishConfirmed = false;
		const destinationContext = this.getPublishDestinationLogContext(topic);

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

			const compressedPayloadCache = new Map<string, string | Buffer>();
			compressedPayloadCache.set(`${this.payloadFormat}::global`, payload);
			await this.routePublishBatch(topic, compressedPayloadCache, endpointName, enriched);
			publishConfirmed = true;

			const buffered = this.mqttConnection.getPublishMode?.() !== 'direct';
			const MessageBufferModel = await this.getMessageBufferModel();
			MessageBufferModel.deleteByIds([claimed.id]);
			this.stats.recordPublish(messageCount, batchBytes);
			this.stats.logPublishSuccess(messageCount, batchBytes, info, endpointName, this.logger, buffered, destinationContext);
			this.batcher.reset();
		} catch (err) {
			this.logger?.error(`Failed to publish batch from endpoint '${endpointName}'`, err, destinationContext);
			await this.handlePublishFailure(endpointName, err, bufferedRecordId, publishConfirmed, topic, data, msgId, messageCount);
		}
	}

	private async handlePublishFailure(
		endpointName: string,
		err: unknown,
		bufferedRecordId: number | undefined,
		publishConfirmed: boolean,
		topic: string,
		data: PublishPayload,
		msgId: string,
		messageCount: number,
	): Promise<void> {
		try {
			if (publishConfirmed) {
				this.batcher.reset();
				this.logger?.error(
					`Published batch from endpoint '${endpointName}' but failed to clean durable buffer record; leaving claimed row for timeout recovery`,
					err,
				);
				return;
			}

			if (bufferedRecordId !== undefined) {
				const MessageBufferModel = await this.getMessageBufferModel();
				MessageBufferModel.markRetryFailed(
					bufferedRecordId,
					err instanceof Error ? err.message : String(err),
				);
				this.batcher.reset();
				this.logger?.warn(`Queued failed publish for endpoint '${endpointName}' for durable retry`);
				return;
			}

			await this.publishOffline(topic, data, msgId, messageCount);
			this.logger?.warn(`Buffered failed publish for endpoint '${endpointName}' to durable storage`);
		} catch (bufferError) {
			this.logger?.error(`Failed to durably buffer publish failure for endpoint '${endpointName}'`, bufferError);
		}
	}

	private getPublishDestinationLogContext(topic?: string): Record<string, unknown> | undefined {
		if (this.bindings.length === 0) {
			return undefined;
		}

		// Only include external (non-iotistica) routes — the internal endpointTopic is already shown separately.
		const externalRoutes: Array<{ destination: string; destinationTopic: string; payloadFormat: string; subscriptionId: number | undefined }> = [];
		for (const binding of this.bindings) {
			if ((binding.publisher.id ?? -1) === -1) continue; // skip default iotistica binding
			const destinationTopic = this.resolveDestinationTopic(binding, topic ?? '');
			if (!destinationTopic) continue;
			externalRoutes.push({
				destination: binding.publisher.name,
				destinationTopic,
				payloadFormat: this.resolvePayloadFormatForBinding(binding),
				subscriptionId: binding.subscription.id,
			});
		}

		return {
			protocol: this.protocol,
			endpointTopic: topic,
			...(externalRoutes.length > 0 ? { externalRoutes } : {}),
		};
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

	private isConnected(): boolean {
		const plugins = this.getUniquePlugins();
		if (plugins.length === 0) {
			return false;
		}

		return plugins.some((plugin) => plugin.isConnected());
	}

	public getPublishDestinationInfo(): PublishDestinationInfo[] {
		if (this.bindings.length === 0) {
			return [];
		}

		const byDestination = new Map<number, PublishDestinationInfo>();

		for (const binding of this.bindings) {
			const destinationId = binding.publisher.id ?? -1;
			const normalizedDestinationType = normalizeTarget(binding.publisher.type);
			const existing = byDestination.get(destinationId);
			if (!existing) {
				byDestination.set(destinationId, {
					destinationId: binding.publisher.id,
					destinationName: binding.publisher.name,
					destinationType: normalizedDestinationType,
					subscriptionIds: binding.subscription.id !== undefined ? [binding.subscription.id] : [],
					topics: this.normalizeTopics(binding.subscription.topics),
				});
				continue;
			}

			if (binding.subscription.id !== undefined && !existing.subscriptionIds.includes(binding.subscription.id)) {
				existing.subscriptionIds.push(binding.subscription.id);
			}

			for (const topic of this.normalizeTopics(binding.subscription.topics)) {
				if (!existing.topics.includes(topic)) {
					existing.topics.push(topic);
				}
			}
		}

		for (const destination of byDestination.values()) {
			destination.subscriptionIds.sort((a, b) => a - b);
			destination.topics.sort();
		}

		return Array.from(byDestination.values());
	}

	private resolveDestinationTopic(binding: HostBinding, sourceTopic: string): string | null {
		if ((binding.publisher.id ?? -1) === -1) {
			return sourceTopic;
		}

		const route = binding.subscription.route_json as PublishSubscriptionRoute | null;
		const destinationTopic = typeof route?.topic === 'string' ? route.topic.trim() : '';
		if (destinationTopic.length === 0) {
			// InfluxDB uses an optional measurement name — empty topic is valid, plugin defaults to 'metrics'
			if (binding.publisher.type === 'influxdb') {
				return '';
			}
			this.logger?.warn('Skipping publish binding without route_json.topic destination', {
				component: 'PublishManager',
				protocol: this.protocol,
				endpoint: this.endpointName,
				destinationId: binding.publisher.id,
				destinationName: binding.publisher.name,
				subscriptionId: binding.subscription.id,
			});
			return null;
		}

		return destinationTopic;
	}

	private async routePublishBatch(
		sourceTopic: string,
		compressedPayloadCache: Map<string, string | Buffer>,
		endpointName: string,
		messages: ProtocolMessage[],
	): Promise<void> {
		if (this.bindings.length === 0) {
			throw new Error('No publish destinations configured');
		}

		const entries = await this.collectRouteEntries(sourceTopic, compressedPayloadCache, endpointName, messages);
		if (entries.length === 0) {
			throw new Error('No valid publish destinations configured (missing route_json.topic)');
		}

		const results = await Promise.allSettled(entries.map(([plugin, batch]) => plugin.publishBatch(batch)));
		const failures = results.filter((result) => result.status === 'rejected') as Array<PromiseRejectedResult>;
		if (failures.length === 0) {
			return;
		}

		if (failures.length === results.length) {
			const first = failures[0]?.reason;
			throw first instanceof Error ? first : new Error(String(first));
		}

		this.logger?.warn('Some publish destinations failed while others succeeded', {
			component: 'PublishManager',
			protocol: this.protocol,
			endpoint: this.endpointName,
			failedDestinations: failures.length,
			totalDestinations: entries.length,
		});
	}

	private async collectRouteEntries(
		sourceTopic: string,
		compressedPayloadCache: Map<string, string | Buffer>,
		endpointName: string,
		messages: ProtocolMessage[],
	): Promise<Array<[IPublishPlugin, PublishBatchItem[]]>> {

		const batchesByPlugin = new Map<IPublishPlugin, PublishBatchItem[]>();
		for (const binding of this.bindings) {
			const destinationTopic = this.resolveDestinationTopic(binding, sourceTopic);
			if (destinationTopic === null) {
				continue;
			}

			const payloadFormat = this.resolvePayloadFormatForBinding(binding);
			const subscriptionCompression = (binding.subscription.compression ?? null) as SubscriptionCompression | null;
			const cacheKey = subscriptionCompression
				? `${payloadFormat}::${subscriptionCompression}`
				: `${payloadFormat}::global`;
			const overrideOpts = subscriptionCompression ? compressionToOpts(subscriptionCompression) : undefined;
			const payload = await this.getCompressedPayloadForFormat(
				payloadFormat,
				cacheKey,
				endpointName,
				messages,
				compressedPayloadCache,
				overrideOpts,
			);

			this.logger?.debug('Routing batch to destination', {
				component: 'PublishManager',
				protocol: this.protocol,
				endpointName,
				destinationName: binding.publisher.name,
				destinationType: binding.publisher.type,
				destinationTopic,
				payloadFormat,
				compression: subscriptionCompression ?? 'global',
				subscriptionId: binding.subscription.id ?? null,
				messageCount: messages.length,
			});

			const items = batchesByPlugin.get(binding.plugin) || [];
			items.push({
				topic: sourceTopic,
				payload,
				options: {
					qos: 1,
					destinationTopic,
				},
			});
			batchesByPlugin.set(binding.plugin, items);
		}

		return Array.from(batchesByPlugin.entries());
	}

	private loadBindings(): HostBinding[] {
		const destinations = PublishDestinationsModel.getAll(false);
		const subscriptions = PublishSubscriptionsModel.getAll(false);
		const cloudConnected = this.defaultClient.isConnected();

		if (subscriptions.length === 0 || destinations.length === 0) {
			this.pluginByDestinationId.clear();
			return cloudConnected ? this.createDefaultIotisticaBinding() : [];
		}

		const destinationsById = new Map<number, PublisherRecord>();
		for (const destination of destinations) {
			if (destination.id !== undefined) {
				destinationsById.set(destination.id, destination);
			}
		}

		this.pluginByDestinationId.clear();
		const bindings: HostBinding[] = [];

		for (const subscription of subscriptions) {
			const destination = destinationsById.get(subscription.publish_destination_id);
			if (!destination) {
				continue;
			}

			if (!this.matchesSubscription(subscription)) {
				continue;
			}

			let plugin = this.pluginByDestinationId.get(subscription.publish_destination_id);
			if (!plugin) {
				plugin = this.buildPlugin(destination, this.defaultClient, this.logger, this.endpointName);
				this.pluginByDestinationId.set(subscription.publish_destination_id, plugin);
			}

			bindings.push({ subscription, publisher: destination, plugin });
		}

		const hasConfiguredIotisticaBinding = bindings.some((binding) => {
			const destinationType = normalizeTarget(binding.publisher.type);
			return destinationType === 'iotistica';
		});

		if (!hasConfiguredIotisticaBinding && cloudConnected) {
			return [...this.createDefaultIotisticaBinding(), ...bindings];
		}

		return bindings;
	}

	private createDefaultIotisticaBinding(): HostBinding[] {
		const target = 'iotistica';
		const publisher: PublisherRecord = {
			id: -1,
			name: target,
			type: target,
			config_json: null,
			enabled: true,
		};
		const plugin = this.buildPlugin(publisher, this.defaultClient, this.logger, this.endpointName);
		return [{
			subscription: {
				publish_destination_id: -1,
				topics: [],
				payload_format: 'custom',
				enabled: true,
			},
			publisher: {
				...publisher,
			},
			plugin,
		}];
	}

	private getUniquePlugins(): IPublishPlugin[] {
		const deduped = new Set<IPublishPlugin>();
		for (const binding of this.bindings) {
			deduped.add(binding.plugin);
		}
		return Array.from(deduped);
	}

	private matchesSubscription(subscription: PublishSubscriptionRecord): boolean {
		const topics = Array.isArray(subscription.topics) ? subscription.topics : [];
		if (topics.length > 0 && !topics.includes(this.protocol)) {
			return false;
		}

		const route = subscription.route_json as PublishSubscriptionRoute | null;
		if (!route) {
			return true;
		}

		if (Array.isArray(route.includeDevices) && route.includeDevices.length > 0) {
			if (!route.includeDevices.includes(this.endpointName)) {
				return false;
			}
		}

		if (Array.isArray(route.excludeDevices) && route.excludeDevices.length > 0) {
			if (route.excludeDevices.includes(this.endpointName)) {
				return false;
			}
		}

		return true;
	}

	private normalizeTopics(topics: string[] | undefined): string[] {
		if (!Array.isArray(topics) || topics.length === 0) {
			return ['*'];
		}

		const normalized = topics
			.map((topic) => topic.trim())
			.filter((topic) => topic.length > 0);

		return normalized.length > 0 ? normalized : ['*'];
	}
}
