import type { HttpClient } from '../lib/http-client.js';
import { OfflineQueue } from '../logging/offline-queue.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import { buildApiEndpoint } from '../utils/api-utils.js';
import { agentTopic } from '../mqtt/topics.js';
import type { AgentStateReport, CloudSyncMqttManager } from './types.js';
import type { PublishMode } from '../mqtt/manager.js';
import { CloudTransportBufferedError, NonRetryableTransportError } from './types.js';
import { stableStringify } from './utils.js';

export class CloudTransport {
	readonly reportQueue: OfflineQueue<AgentStateReport>;

	private lastQueueFlushAttemptAt?: number;
	private lastQueueFlushSuccessAt?: number;
	private isFlushing = false;

	constructor(
		private readonly mqttManager: CloudSyncMqttManager | undefined,
		private httpClient: HttpClient,
		private readonly cloudApiEndpoint: string,
		private readonly getAgentInfo: () => { uuid: string; apiKey?: string; provisioned: boolean },
		private readonly getPublishMode: () => PublishMode,
		private readonly logger: AgentLogger | undefined,
		private readonly getApiTimeout: () => number,
	) {
		this.reportQueue = new OfflineQueue<AgentStateReport>('state-reports', 1000, 2 * 60 * 60 * 1000);
	}

	async initQueue(): Promise<void> {
		await this.reportQueue.init();
	}

	updateHttpClient(httpClient: HttpClient): void {
		this.httpClient = httpClient;
	}

	/**
	* Send a report to the cloud.
	* Uses MQTT as primary path with HTTP as fallback.
	* Throws CloudTransportBufferedError when publish mode is 'buffer-only'.
	*/
	async sendReport(report: AgentStateReport): Promise<'mqtt' | 'http'> {
		const agentInfo = this.getAgentInfo();
		const publishMode = this.getPublishMode();

		if (publishMode === 'buffer-only') {
			throw new CloudTransportBufferedError(publishMode);
		}

		let topic: string | null = null;
		try {
			topic = agentTopic(agentInfo.uuid, 'state');
		} catch (error) {
			this.logger?.warnSync('Tenant ID missing for MQTT topic, using HTTP', {
				component: LogComponents.cloudSync,
				operation: 'mqtt-topic-missing-tenant-id',
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const mqttHealthy = this.mqttManager?.isConnected() ?? false;

		if (publishMode === 'direct' && mqttHealthy && topic) {
			try {
				await this.mqttManager!.publishNoQueue(topic, stableStringify(report), { qos: 1 });
				return 'mqtt';
			} catch (mqttError) {
				this.logger?.warnSync('MQTT publish failed, falling back to HTTP', {
					component: LogComponents.cloudSync,
					operation: 'mqtt-fallback',
					error: mqttError instanceof Error ? mqttError.message : String(mqttError),
				});
			}
		} else if (publishMode === 'recovering') {
			this.logger?.infoSync('MQTT suspended during transport recovery - using HTTP fallback', {
				component: LogComponents.cloudSync,
				operation: 'mqtt-recovering-http-fallback',
			});
		} else if (this.mqttManager) {
			this.logger?.warnSync('MQTT disconnected, attempting HTTP fallback', {
				component: LogComponents.cloudSync,
				operation: 'mqtt-skip',
				reason: 'mqtt-unavailable',
			});
		}

		const endpoint = buildApiEndpoint(this.cloudApiEndpoint, '/device/state');
		const protocol = endpoint.startsWith('https://') ? 'https' : 'http';
		const apiKey = agentInfo.apiKey;

		const response = await this.httpClient.patch(endpoint, report, {
			headers: apiKey ? { 'X-Device-API-Key': apiKey } : undefined,
			compress: true,
			timeout: this.getApiTimeout(),
		});

		if (!response.ok) {
			const msg = `${protocol.toUpperCase()} ${response.status}: ${response.statusText}`;
			if (response.status >= 400 && response.status < 500) {
				throw new NonRetryableTransportError(response.status, msg);
			}
			throw new Error(msg);
		}

		this.logger?.infoSync(`State report sent via ${protocol.toUpperCase()}`, {
			component: LogComponents.cloudSync,
			operation: 'http-success',
			transport: protocol,
		});
		return 'http';
	}

	/**
	* Flush offline queue with rate limiting (10 items per second) to prevent API flooding
	* after long offline periods.
	*/
	async flushOfflineQueue(): Promise<void> {
		if (this.isFlushing) return;
		if (this.reportQueue.isEmpty()) return;

		// Prune stale reports before attempting to send.
		// Mirrors EdgeHub CleanupProcessor: expired items are discarded rather than
		// replayed. Reports older than the TTL (2h) are stale — the agent's current
		// state will be captured in the first fresh report after reconnect.
		const pruned = this.reportQueue.pruneExpired();
		if (pruned > 0) {
			this.logger?.warnSync('Discarded expired reports before flush', {
				component: LogComponents.cloudSync,
				operation: 'flush-queue-prune',
				pruned,
			});
		}

		if (this.reportQueue.isEmpty()) return;

		this.isFlushing = true;

		try {
			this.lastQueueFlushAttemptAt = Date.now();
			const queueSize = this.reportQueue.size();

			this.logger?.infoSync('Flushing offline queue with rate limiting', {
				component: LogComponents.cloudSync,
				operation: 'flush-queue',
				queueSize,
				batchSize: 10,
				estimatedDurationSec: Math.ceil(queueSize / 10),
			});

			const BATCH_SIZE = 10;
			const BATCH_DELAY_MS = 1000;
			let totalSent = 0;
			let batchCount = 0;

			while (!this.reportQueue.isEmpty()) {
				let sentInBatch = 0;

				for (let i = 0; i < BATCH_SIZE && !this.reportQueue.isEmpty(); i++) {
					const report = await this.reportQueue.dequeue();
					if (!report) break;

					try {
						await this.sendReport(report);
						sentInBatch++;
						totalSent++;
					} catch (error) {
						if (error instanceof NonRetryableTransportError) {
							this.logger?.warnSync('Dropping non-retryable queued report', {
								component: LogComponents.cloudSync,
								operation: 'flush-queue',
								status: error.status,
							});
						} else {
							this.logger?.warnSync('Failed to send queued report, re-enqueueing', {
								component: LogComponents.cloudSync,
								operation: 'flush-queue',
								error: error instanceof Error ? error.message : String(error),
							});
							await this.reportQueue.enqueue(report);
						}
						break;
					}
				}

				batchCount++;

				if (sentInBatch === 0) {
					this.logger?.warnSync('Queue flush stopped - send failures', {
						component: LogComponents.cloudSync,
						operation: 'flush-queue',
						totalSent,
						batchesCompleted: batchCount,
						queueRemaining: this.reportQueue.size(),
					});
					break;
				}

				if (!this.reportQueue.isEmpty()) {
					await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS));
				}
			}

			if (totalSent > 0) {
				this.lastQueueFlushSuccessAt = Date.now();
				this.logger?.infoSync('Successfully flushed queued reports', {
					component: LogComponents.cloudSync,
					operation: 'flush-queue',
					sentCount: totalSent,
					totalCount: queueSize,
					batchesCompleted: batchCount,
				});
			}
		} finally {
			this.isFlushing = false;
		}
	}

	getQueueStats() {
		return this.reportQueue.getStats();
	}

	getLastFlushAttemptAt(): number | undefined {
		return this.lastQueueFlushAttemptAt;
	}

	getLastFlushSuccessAt(): number | undefined {
		return this.lastQueueFlushSuccessAt;
	}
}
