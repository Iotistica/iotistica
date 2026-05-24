import { EventEmitter } from 'events';
import { getHeapStatistics } from 'v8';
import { agentTopic } from '../../mqtt/topics.js';
import type { AnomalyDetectionService } from '../../anomaly/index.js';
import type { Protocol } from '../../anomaly/types.js';
import type { DeviceConfig, MqttConnection, Logger, DeviceStats, IPublishClient, IPublishPlugin, IPublishSink } from './types.js';
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
import type { PublishDestinationInfo, PublishBatchItem } from './types.js';
import { PublishDestinationsModel, PublishSubscriptionsModel } from '../../db/models/index.js';
import type { PublisherRecord, PublishSubscriptionRecord, PublishSubscriptionRoute } from '../../db/models/index.js';

// Adaptive batch safety limits (calculated once at module load)
const MAX_BATCH_MESSAGES = 10000;
const MAX_BATCH_BYTES = (() => {
	const heapLimit = getHeapStatistics().heap_size_limit;
	return Math.min(10 * 1024 * 1024, Math.floor(heapLimit * 0.05));
})();

type ExternalPayloadFormat = 'custom' | 'tags' | 'ecp';

type PublishPayload = Record<string, unknown>;

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
	private liveDataInterceptor?: (messages: any[], endpointName: string) => Promise<any[]> | any[];
	private bindings: HostBinding[] = [];
	private pluginByPublisherId: Map<number, IPublishPlugin> = new Map();

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

		this.bindings = this.loadBindings();
		if (this.bindings.length === 0) {
			this.logger?.warn('No publisher bindings found; using default Iotistica');
			this.bindings = this.createDefaultIotisticaBinding();
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

		// If all plugins failed and we have non-default bindings, use default Iotistica
		if (failures.length === startedPlugins.size && failures.length > 0 && this.bindings.some((b) => b.publisher.id !== -1)) {
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
		this.pluginByPublisherId.clear();
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

			const payloadFormat = this.resolvePayloadFormatForActiveBindings();
			let { data, baselineSize, msgId } = this.buildPayload(name, enriched, payloadFormat);
			if (this.needStop) return;

			if (!this.isConnected()) {
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

	private buildPayload(endpointName: string, messages: any[], payloadFormat: ExternalPayloadFormat): {
    data: PublishPayload;
    msgId: string;
    baselineSize: number;
  } {
		const msgId = this.mqttConnection.getMessageIdGenerator?.()?.generate()
			?? `${this.deviceUuid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

		if (payloadFormat === 'tags' || payloadFormat === 'ecp') {
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

	private resolvePayloadFormatForActiveBindings(): ExternalPayloadFormat {
		if (this.bindings.length === 0) {
			return this.externalPayloadFormat;
		}

		const nonDefaultBindings = this.bindings.filter((binding) => binding.publisher.id !== -1);
		if (nonDefaultBindings.length === 0) {
			return this.externalPayloadFormat;
		}

		const formats = new Set<ExternalPayloadFormat>();
		for (const binding of nonDefaultBindings) {
			const candidate = String(binding.subscription.payload_format || '').toLowerCase();
			if (candidate === 'custom' || candidate === 'tags' || candidate === 'ecp') {
				formats.add(candidate);
			}
		}

		if (formats.size === 0) {
			return this.externalPayloadFormat;
		}

		if (formats.size > 1) {
			this.logger?.warn('Multiple payload formats detected across active publish bindings; using custom format', {
				component: 'PublishManager',
				formats: Array.from(formats),
			});
			return 'custom';
		}

		return Array.from(formats)[0];
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

			await this.routePublishBatch(topic, payload);
			publishConfirmed = true;

			const buffered = this.mqttConnection.getPublishMode?.() !== 'direct';
			const MessageBufferModel = await this.getMessageBufferModel();
			MessageBufferModel.deleteByIds([claimed.id]);
			this.stats.recordPublish(messageCount, batchBytes);
			this.stats.logPublishSuccess(messageCount, batchBytes, info, endpointName, this.logger, buffered, destinationContext);
			this.batcher.reset();
		} catch (err) {
			this.logger?.error(`Failed to publish batch from endpoint '${endpointName}'`, err, destinationContext);

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

	private getPublishDestinationLogContext(topic?: string): Record<string, unknown> | undefined {
		const destinations = this.getDestinationInfo();
		if (!Array.isArray(destinations) || destinations.length === 0) {
			return undefined;
		}

		return {
			topic,
			destinations: destinations.map((destination) => ({
				publish_destination_id: destination.publisherId,
				publisher_name: destination.publisherName,
				publisher_type: destination.publisherType,
				subscription_ids: destination.subscriptionIds,
				topics: destination.topics,
			})),
			destinationCount: destinations.length,
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

	public getDestinationInfo(): PublishDestinationInfo[] {
		if (this.bindings.length === 0) {
			return [];
		}

		const byPublisher = new Map<number, PublishDestinationInfo>();

		for (const binding of this.bindings) {
			const publisherId = binding.publisher.id ?? -1;
			const existing = byPublisher.get(publisherId);
			if (!existing) {
				byPublisher.set(publisherId, {
					publisherId: binding.publisher.id,
					publisherName: binding.publisher.name,
					publisherType: String(binding.publisher.type),
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

		for (const destination of byPublisher.values()) {
			destination.subscriptionIds.sort((a, b) => a - b);
			destination.topics.sort();
		}

		return Array.from(byPublisher.values());
	}

	private resolveDestinationTopic(binding: HostBinding, sourceTopic: string): string | null {
		if ((binding.publisher.id ?? -1) === -1) {
			return sourceTopic;
		}

		const route = binding.subscription.route_json as PublishSubscriptionRoute | null;
		const destinationTopic = typeof route?.topic === 'string' ? route.topic.trim() : '';
		if (destinationTopic.length === 0) {
			this.logger?.warn('Skipping publish binding without route_json.topic destination', {
				component: 'PublishManager',
				protocol: this.protocol,
				endpoint: this.endpointName,
				publisherId: binding.publisher.id,
				publisherName: binding.publisher.name,
				subscriptionId: binding.subscription.id,
			});
			return null;
		}

		return destinationTopic;
	}

	private async routePublishBatch(sourceTopic: string, payload: string | Buffer): Promise<void> {
		if (this.bindings.length === 0) {
			throw new Error('No publish destinations configured');
		}

		const batchesByPlugin = new Map<IPublishPlugin, PublishBatchItem[]>();
		for (const binding of this.bindings) {
			const destinationTopic = this.resolveDestinationTopic(binding, sourceTopic);
			if (!destinationTopic) {
				continue;
			}

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

		const entries = Array.from(batchesByPlugin.entries());
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

	private loadBindings(): HostBinding[] {
		const publishers = PublishDestinationsModel.getAll(false);
		const subscriptions = PublishSubscriptionsModel.getAll(false);
		// If no explicit subscriptions configured, return empty to use default Iotistica
		if (subscriptions.length === 0) {
			return [];
		}
		// If subscriptions exist but publishers don't, still process subscriptions
		// (they may be misconfigured but we shouldn't silently ignore them)
		if (publishers.length === 0) {
			return [];
		}

		const publishersById = new Map<number, PublisherRecord>();
		for (const publisher of publishers) {
			if (publisher.id !== undefined) {
				publishersById.set(publisher.id, publisher);
			}
		}

		this.pluginByPublisherId.clear();
		const bindings: HostBinding[] = [];

		for (const subscription of subscriptions) {
			const publisher = publishersById.get(subscription.publish_destination_id);
			if (!publisher) {
				continue;
			}

			if (!this.matchesSubscription(subscription)) {
				continue;
			}

			let plugin = this.pluginByPublisherId.get(subscription.publish_destination_id);
			if (!plugin) {
				plugin = this.buildPlugin(publisher, this.defaultClient, this.logger, this.endpointName);
				this.pluginByPublisherId.set(subscription.publish_destination_id, plugin);
			}

			bindings.push({ subscription, publisher, plugin });
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
