/**
 * Message Buffer Sync Service
 * ===========================
 * 
 * Manages local message data buffer and syncs to MQTT when connection is available.
 * Implements offline queue pattern from AWS IoT Greengrass and Azure IoT Edge.
 * 
 * Features:
 * - Automatic flush on MQTT connect/reconnect
 * - Batch processing with configurable size
 * - Exponential backoff on failures
 * - Periodic cleanup of expired records
 * - Statistics tracking
 */

import { createJsonPayload, serializePayload } from '../../mqtt/codec';
import type { PublishMode } from './types.js';
import { MessageBufferModel } from '../../db/models';
import type { BufferAdmissionDecision } from '../../db/models';
import type { AgentLogger } from '../../logging/agent-logger';
import { LogComponents } from '../../logging/types';
import type { IClientPublishOptions } from 'mqtt';

export interface BufferSyncConfig {
  enabled: boolean;
  flushBatchSize: number; // How many records to process per batch
  flushIntervalMs: number; // How often to attempt flush when online
  maxRetries: number; // Max retries per message before dropping
  cleanupIntervalMs: number; // How often to cleanup expired records
  maxBufferRecords: number; // Hard cap on buffered message count
  dropPolicy: 'oldest' | 'newest' | 'error';
  flushTriggerThreshold: number; // Trigger immediate flush request above this threshold
  maxFlushPerCycle: number; // Hard cap of records handled in a single flush run
  bufferEvenWhenOnline: boolean; // Store-and-forward mode even while connected
  /**
   * When set, records are stored and dequeued with this exact endpoint_name instead of
   * the topic-derived name. Use this to partition per-destination buffers.
   */
  scopeEndpointName?: string;
  /**
   * When set, the flush step skips records whose endpoint_name starts with this prefix.
   * Use this on the internal (iotistica) buffer sync to prevent it from flushing
   * records that belong to external-destination buffer sync instances.
   */
  scopeExcludePrefix?: string;
}

export type MessageBufferSyncOptions = BufferSyncConfig;

/**
 * Minimal interface required by MessageBufferSync.
 * Both CloudMqttClient and any PublishTarget plugin satisfy this.
 */
export interface IPublishClient {
  on(event: 'connect', listener: () => void): this;
  off(event: 'connect', listener: () => void): this;
  isConnected(): boolean;
  getPublishMode?(): PublishMode;
  getMessageIdGenerator?(): any;
  publish(
    topic: string,
    payload: string | Buffer,
    options?: { qos?: 0 | 1 | 2 }
  ): Promise<void>;
}

export class MessageBufferSync {
	private static readonly SQLITE_BUSY_PATTERN = /SQLITE_BUSY|database is locked/i;
	private config: BufferSyncConfig;
	private mqttManager: IPublishClient;
	private logger?: AgentLogger;
  
	private flushIntervalHandle?: NodeJS.Timeout;
	private cleanupIntervalHandle?: NodeJS.Timeout;
	private isFlushRequested = false;
	private isFlushing = false;
	private started = false;
	private readonly connectListener = () => {
		this.flushNow();
	};

	constructor(
		mqttManager: IPublishClient,
		logger?: AgentLogger,
		config?: Partial<BufferSyncConfig>
	) {
		this.mqttManager = mqttManager;
		this.logger = logger;
    
		this.config = {
			enabled: true,
			flushBatchSize: 100,
			flushIntervalMs: 30000, // 30 seconds
			maxRetries: 3,
			cleanupIntervalMs: 3600000, // 1 hour
			maxBufferRecords: 10000,
			dropPolicy: 'oldest',
			flushTriggerThreshold: 1000,
			maxFlushPerCycle: 1000,
			bufferEvenWhenOnline: false,
			...config
		};
	}

	/**
   * Start buffer sync service
   */
	async start(): Promise<void> {
		if (this.started) {
			return;
		}

		if (!this.config.enabled) {
			this.logger?.infoSync('Message buffer sync disabled', {
				component: LogComponents.agent
			});
			return;
		}

		this.logger?.infoSync('Starting message buffer sync service', {
			component: LogComponents.agent,
			flushInterval: `${this.config.flushIntervalMs}ms`,
			batchSize: this.config.flushBatchSize
		});

		// Flush immediately whenever MQTT connection is re-established.
		this.mqttManager.on('connect', this.connectListener);

		// Start periodic flush timer
		this.flushIntervalHandle = setInterval(
			() => this.periodicFlush(),
			this.config.flushIntervalMs
		);

		// Start periodic cleanup timer
		this.cleanupIntervalHandle = setInterval(
			() => this.cleanupExpired(),
			this.config.cleanupIntervalMs
		);

		// Initial flush if MQTT already connected
		if (this.mqttManager.isConnected()) {
			await this.flushBuffer();
		}

		// Initial cleanup
		await this.cleanupExpired();

		this.started = true;
	}

	/**
   * Stop buffer sync service
   */
	stop(): void {
		if (!this.started) {
			return;
		}

		this.logger?.infoSync('Stopping message buffer sync service', {
			component: LogComponents.agent
		});

		this.mqttManager.off('connect', this.connectListener);

		if (this.flushIntervalHandle) {
			clearInterval(this.flushIntervalHandle);
			this.flushIntervalHandle = undefined;
		}

		if (this.cleanupIntervalHandle) {
			clearInterval(this.cleanupIntervalHandle);
			this.cleanupIntervalHandle = undefined;
		}

		this.started = false;
	}

	/**
   * Return whether this buffer sync instance is enabled by config.
   */
	isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
   * Intercept publish calls so offline payloads are persisted to SQLite.
   * Returns true when publish was fully handled by buffer storage.
   */
	async handlePublish(
		topic: string,
		payload: Buffer,
		options?: IClientPublishOptions
	): Promise<boolean> {
		if (!this.config.enabled) {
			return false;
		}

		const publishMode = this.mqttManager.getPublishMode?.() ?? 'direct';
		const shouldBuffer =
      !this.mqttManager.isConnected() ||
      this.config.bufferEvenWhenOnline ||
      publishMode !== 'direct';

		if (!shouldBuffer) {
			return false;
		}

		const payloadText = payload.toString('utf-8');
		const payloadBytes = payload.length;
		const isCritical = this.isCriticalTopic(topic);
		const admission = await this.withSqliteBusyRetry(
			'buffer-check-admission',
			() => MessageBufferModel.canAcceptMessage(payloadBytes)
		);

		const exceedsConfigCount = admission.projected_count > this.config.maxBufferRecords;
		if (!admission.canAccept || exceedsConfigCount) {
			const accepted = await this.handleAdmissionPressure(
				topic,
				payloadBytes,
				isCritical,
				admission,
				exceedsConfigCount,
			);
			if (!accepted) {
				return true;
			}
		}

		await this.withSqliteBusyRetry('buffer-enqueue', () => MessageBufferModel.enqueue({
			endpoint_name: this.config.scopeEndpointName ?? this.extractEndpointName(topic),
			topic,
			qos: options?.qos ?? 0,
			payload: payloadText,
			msg_id: this.extractMsgId(payloadText),
			is_critical: isCritical ? 1 : 0,
			payload_bytes: payloadBytes,
		}));

		const newStats = await this.withSqliteBusyRetry(
			'buffer-stats-after-enqueue',
			() => MessageBufferModel.getStats()
		);
		if (!this.isFlushing && newStats.current_count >= this.config.flushTriggerThreshold) {
			this.requestFlush();
		}

		this.logger?.debugSync('Buffered MQTT publish while offline', {
			component: LogComponents.agent,
			topic,
			payloadBytes,
			qos: options?.qos ?? 0,
			publishMode,
		});

		return true;
	}

	/**
   * Request immediate flush (non-blocking)
   */
	requestFlush(): void {
		this.isFlushRequested = true;
	}

	/**
   * Get buffer statistics
   */
	async getStats() {
		return MessageBufferModel.getStats();
	}

	private flushNow(): void {
		this.logger?.infoSync('MQTT connected - initiating buffer flush', {
			component: LogComponents.agent
		});
    
		// Keep the request flag set so the periodic timer can retry if this immediate attempt is skipped.
		this.requestFlush();

		void this.periodicFlush().catch((error: unknown) => {
			this.logger?.errorSync(
				'Immediate buffer flush trigger failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agent,
				}
			);
		});
	}

	/**
   * Periodic flush attempt
   */
	private async periodicFlush(): Promise<void> {
		// Skip if already flushing or no flush requested
		if (this.isFlushing) return;

		const publishMode = this.mqttManager.getPublishMode?.() ?? 'direct';
		const canFlushNow = this.mqttManager.isConnected() && publishMode === 'direct';
    
		// Only flush if requested OR MQTT is connected
		if (!this.isFlushRequested && !canFlushNow) {
			return;
		}

		await this.flushBuffer();
	}

	/**
   * Flush buffered messages to MQTT
   */
	private async flushBuffer(): Promise<void> {
		if (this.isFlushing) {
			this.logger?.debugSync('Flush already in progress, skipping', {
				component: LogComponents.agent
			});
			return;
		}

		if (!this.mqttManager.isConnected()) {
			this.logger?.debugSync('MQTT not connected, skipping flush', {
				component: LogComponents.agent
			});
			return;
		}

		if ((this.mqttManager.getPublishMode?.() ?? 'direct') !== 'direct') {
			this.logger?.debugSync('MQTT publish mode is buffering, skipping flush', {
				component: LogComponents.agent,
				publishMode: this.mqttManager.getPublishMode?.() ?? 'direct',
			});
			return;
		}

		this.isFlushing = true;
		this.isFlushRequested = false;

		try {
			let totalFlushed = 0;
			let hasMore = true;
			let totalHandled = 0;
			// Process in batches until queue is empty
			while (hasMore && this.mqttManager.isConnected()) {
				if (totalHandled >= this.config.maxFlushPerCycle) {
					this.logger?.debugSync('Max flush per cycle reached, scheduling next cycle', {
						component: LogComponents.agent,
						totalHandled,
						maxFlushPerCycle: this.config.maxFlushPerCycle
					});
					this.requestFlush();
					break;
				}

				const records = await this.withSqliteBusyRetry(
					'buffer-dequeue-ready',
					() => MessageBufferModel.dequeueReady(
						this.config.flushBatchSize,
						new Date(),
						undefined,
						this.config.maxRetries,
						{
							exact: this.config.scopeEndpointName,
							excludePrefix: this.config.scopeExcludePrefix,
						},
					)
				);
        
				if (records.length === 0) {
					hasMore = false;
					break;
				}

				const successfulIds: number[] = [];
				const droppedIds: number[] = [];
				const failedRecords: Array<{ id: number; error: string }> = [];
				const retryCountById = new Map<number, number>();

				// Publish each message
				for (const record of records) {
					try {
						// Try to parse as JSON and inject msgId for deduplication
						let payload: Buffer | string = record.payload;
						try {
							const json = JSON.parse(record.payload);
							const msgIdGen = this.mqttManager.getMessageIdGenerator?.();
							let mqttPayload;
							if (record.msg_id) {
								mqttPayload = createJsonPayload({ ...json, msgId: record.msg_id });
							} else if (typeof json?.msgId === 'string' && json.msgId.length > 0) {
								mqttPayload = createJsonPayload(json);
							} else {
								mqttPayload = createJsonPayload(json, msgIdGen);
							}
							payload = serializePayload(mqttPayload);
						} catch {
							// Not JSON - use as-is (Buffer or string)
						}
            
						await this.mqttManager.publish(
							record.topic,
							payload,
							{ qos: record.qos as 0 | 1 | 2 }
						);
            
						successfulIds.push(record.id!);
					} catch (error: any) {
						const errorMsg = error?.message || String(error);
						retryCountById.set(record.id!, record.retry_count);
            
						// Check if message should be retried or dropped
						if (record.retry_count >= this.config.maxRetries) {
							this.logger?.warnSync('Message exceeded max retries, dropping', {
								component: LogComponents.agent,
								recordId: record.id,
								endpoint: record.endpoint_name,
								retries: record.retry_count,
								error: errorMsg
							});
              
							droppedIds.push(record.id!);
						} else {
							failedRecords.push({ id: record.id!, error: errorMsg });
						}
					}
				}

				// Delete successfully published records
				if (successfulIds.length > 0) {
					await this.withSqliteBusyRetry(
						'buffer-delete-flushed',
						() => MessageBufferModel.deleteByIds(successfulIds)
					);
					totalFlushed += successfulIds.length;
				}

				if (droppedIds.length > 0) {
					await this.withSqliteBusyRetry(
						'buffer-drop-failed',
						() => MessageBufferModel.dropByIds(droppedIds)
					);
				}

				// Mark failed records for retry
				for (const failed of failedRecords) {
					await this.withSqliteBusyRetry(
						'buffer-mark-retry-failed',
						() => MessageBufferModel.markRetryFailed(
							failed.id,
							failed.error,
							this.calculateNextRetryAt(retryCountById.get(failed.id) ?? 0)
						)
					);
				}

				// Log batch progress
				if (records.length > 0) {
					totalHandled += records.length;
					this.logger?.infoSync('Buffer flush batch completed', {
						component: LogComponents.agent,
						processed: records.length,
						successful: successfulIds.length,
						dropped: droppedIds.length,
						failed: failedRecords.length,
						totalFlushed
					});
				}

				// Yield so long flushes do not starve the event loop.
				await new Promise<void>((resolve) => setImmediate(resolve));
			}

			if (totalFlushed > 0) {
				this.logger?.infoSync('Buffer flush completed', {
					component: LogComponents.agent,
					totalFlushed
				});
			}

		} catch (error: any) {
			this.logger?.errorSync(
				'Buffer flush failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agent
				}
			);
		} finally {
			this.isFlushing = false;
		}
	}

	/**
   * Cleanup expired records
   */
	private async cleanupExpired(): Promise<void> {
		if (this.isFlushing) {
			return;
		}

		try {
			const deleted = await this.withSqliteBusyRetry(
				'buffer-cleanup-expired',
				() => MessageBufferModel.cleanupExpired(this.config.maxRetries)
			);
      
			if (deleted > 0) {
				this.logger?.infoSync('Cleaned up expired buffer records', {
					component: LogComponents.agent,
					deleted
				});
			}
		} catch (error: any) {
			this.logger?.errorSync(
				'Cleanup failed',
				error instanceof Error ? error : new Error(String(error)),
				{
					component: LogComponents.agent
				}
			);
		}
	}

	private extractEndpointName(topic: string): string {
		const parts = topic.split('/').filter(Boolean);
		return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
	}

	private isCriticalTopic(topic: string): boolean {
		return topic.startsWith('alerts/') || topic.startsWith('events/');
	}

	private async handleAdmissionPressure(
		topic: string,
		payloadBytes: number,
		isCritical: boolean,
		admission: BufferAdmissionDecision,
		exceedsConfigCount: boolean,
	): Promise<boolean> {
		if (!isCritical) {
			return this.rejectUnderPressure(topic, payloadBytes, admission, exceedsConfigCount);
		}

		const spaceFreed = await this.applyBackpressurePolicy(topic, admission.current_count);
		if (!spaceFreed) {
			return false;
		}

		const postPressureAdmission = await this.withSqliteBusyRetry(
			'buffer-check-admission-after-pressure',
			() => MessageBufferModel.canAcceptMessage(payloadBytes)
		);

		if (postPressureAdmission.projected_count > this.config.maxBufferRecords || !postPressureAdmission.canAccept) {
			MessageBufferModel.incrementDropped(1);
			this.logger?.warnSync('Critical message still rejected after buffer pressure handling', {
				component: LogComponents.agent,
				topic,
				payloadBytes,
				currentCount: postPressureAdmission.current_count,
				currentBytes: postPressureAdmission.current_bytes,
				maxBufferRecords: this.config.maxBufferRecords,
				maxRecords: postPressureAdmission.max_records,
				maxBytes: postPressureAdmission.max_bytes,
			});
			return false;
		}

		return true;
	}

	private rejectUnderPressure(
		topic: string,
		payloadBytes: number,
		admission: BufferAdmissionDecision,
		exceedsConfigCount: boolean,
	): boolean {
		const pressureContext = {
			component: LogComponents.agent,
			topic,
			payloadBytes,
			currentCount: admission.current_count,
			currentBytes: admission.current_bytes,
			projectedCount: admission.projected_count,
			projectedBytes: admission.projected_bytes,
			maxBufferRecords: this.config.maxBufferRecords,
			maxRecords: admission.max_records,
			maxBytes: admission.max_bytes,
			exceedsConfigCount,
			exceedsRecordQuota: admission.exceeds_count,
			exceedsByteQuota: admission.exceeds_bytes,
		};

		switch (this.config.dropPolicy) {
			case 'error':
				MessageBufferModel.incrementDropped(1);
				throw new Error(
					`Message buffer rejected non-critical message under pressure (${admission.projected_count}/${Math.min(this.config.maxBufferRecords, admission.max_records)} records, ${admission.projected_bytes}/${admission.max_bytes} bytes)`
				);
			case 'newest':
			case 'oldest':
			default:
				MessageBufferModel.incrementDropped(1);
				this.logger?.warnSync('Rejected non-critical message before enqueue due to buffer pressure', pressureContext);
				return false;
		}
	}

	private async applyBackpressurePolicy(topic: string, currentCount: number): Promise<boolean> {
		switch (this.config.dropPolicy) {
			case 'oldest': {
				const needed = (currentCount - this.config.maxBufferRecords) + 1;
				const deleted = MessageBufferModel.deleteOldest(Math.max(needed, 100), true);

				if (deleted > 0) {
					this.logger?.warnSync('Buffer full, dropped oldest buffered records', {
						component: LogComponents.agent,
						deleted,
						maxBufferRecords: this.config.maxBufferRecords
					});
					return true;
				}

				MessageBufferModel.incrementDropped(1);
				this.logger?.warnSync('Buffer full and only critical topics buffered, dropping newest message', {
					component: LogComponents.agent,
					topic,
					maxBufferRecords: this.config.maxBufferRecords
				});
				return false;
			}
			case 'newest':
				MessageBufferModel.incrementDropped(1);
				this.logger?.warnSync('Buffer full, dropping newest message by policy', {
					component: LogComponents.agent,
					topic,
					maxBufferRecords: this.config.maxBufferRecords
				});
				return false;
			case 'error': {
				MessageBufferModel.incrementDropped(1);
				throw new Error(`Message buffer is full (${currentCount}/${this.config.maxBufferRecords})`);
			}
			default:
				return false;
		}
	}

	private extractMsgId(payload: string): string | undefined {
		try {
			const parsed = JSON.parse(payload);
			const msgId = parsed?.msgId;
			return typeof msgId === 'string' && msgId.length > 0 ? msgId : undefined;
		} catch {
			return undefined;
		}
	}

	private calculateNextRetryAt(currentRetryCount: number): Date | undefined {
		const nextAttempt = currentRetryCount + 1;
		let delayMs: number;

		if (nextAttempt <= 1) {
			delayMs = 5000;
		} else if (nextAttempt === 2) {
			delayMs = 30000;
		} else {
			delayMs = 300000;
		}

		const nextRetryAt = new Date(Date.now() + delayMs);
		return nextRetryAt;
	}

	private isSqliteBusyError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return MessageBufferSync.SQLITE_BUSY_PATTERN.test(message);
	}

	private async withSqliteBusyRetry<T>(
		operation: string,
		work: () => T | Promise<T>,
		maxAttempts = 4
	): Promise<T> {
		let attempt = 0;

		while (attempt < maxAttempts) {
			attempt += 1;
			try {
				return await work();
			} catch (error) {
				if (!this.isSqliteBusyError(error) || attempt >= maxAttempts) {
					throw error;
				}

				const delayMs = Math.min(1000, 100 * Math.pow(2, attempt - 1));
				this.logger?.warnSync('SQLite busy during buffer operation, retrying', {
					component: LogComponents.agent,
					operation,
					attempt,
					maxAttempts,
					delayMs,
					error: error instanceof Error ? error.message : String(error)
				});

				await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
			}
		}

		throw new Error(`SQLite retry exhausted unexpectedly during ${operation}`);
	}

}
