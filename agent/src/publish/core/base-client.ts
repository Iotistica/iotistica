/** Shared base MQTT client for external cloud publish providers. */

import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import type { MqttConnection, PublishMode } from './types.js';

export abstract class BaseMqttClient extends EventEmitter implements MqttConnection {
	protected client: MqttClient | null = null;
	protected connected = false;
	protected readonly maxPublishRetries = 3;

	constructor(protected readonly logger?: AgentLogger) {
		super();
	}

	protected abstract get providerName(): string;
	protected abstract buildMqttOptions(): IClientOptions;
	protected abstract buildPublishTopic(sourceTopic: string): string;
	protected abstract getLogContext(): Record<string, unknown>;

	protected onConnected(): void {}

	protected onPreDisconnect(): void {}

	protected isTransientPublishError(_error: Error): boolean {
		return true;
	}

	protected onPublishRetry(_attempt: number, _error: Error, _nextDelayMs: number): void {}

	public async connect(): Promise<void> {
		const options = this.buildMqttOptions();

		await new Promise<void>((resolve, reject) => {
			const client = mqtt.connect(options as any);
			// Assign immediately so disconnect() can always call end(), even if
			// the initial connection fails and this.client would otherwise stay null.
			this.client = client;
			let initialized = false;

			const markConnected = () => {
				const wasConnected = this.connected;
				this.connected = true;

				if (!wasConnected) {
					this.logger?.infoSync(`${this.providerName} MQTT connected`, {
						component: LogComponents.agent,
						...this.getLogContext(),
					});
					this.emit('connect');
					this.onConnected();
				}
			};

			const onConnect = () => {
				markConnected();
				if (!initialized) {
					initialized = true;
					client.removeListener('error', onError);
					resolve();
				}
			};

			const onCloseLike = () => {
				this.connected = false;
			};

			const onDisconnect = () => {
				onCloseLike();
				this.emit('disconnect');
			};

			const onOffline = () => {
				onCloseLike();
			};

			const onReconnect = () => {
				this.logger?.debugSync(`${this.providerName} MQTT reconnecting`, {
					component: LogComponents.agent,
					...this.getLogContext(),
				});
			};

			const onEnd = () => {
				onCloseLike();
			};

			const onClose = () => {
				onCloseLike();
			};

			const onError = (err: Error) => {
				if (!initialized) {
					initialized = true;
					client.removeListener('connect', onConnect);
					reject(err);
				}
			};

			client.on('connect', onConnect);
			client.once('error', onError);

			client.on('error', (err) => {
				this.logger?.errorSync(
					`${this.providerName} MQTT client error`,
					err instanceof Error ? err : new Error(String(err)),
					{ component: LogComponents.agent, ...this.getLogContext() },
				);
				// Only re-emit if a consumer has registered a listener; otherwise an unhandled
				// 'error' event on an EventEmitter throws and crashes the process.
				if (this.listenerCount('error') > 0) {
					this.emit('error', err);
				}
			});

			client.on('disconnect', onDisconnect);
			client.on('offline', onOffline);
			client.on('reconnect', onReconnect);
			client.on('end', onEnd);
			client.on('close', onClose);
		});
	}

	public async disconnect(): Promise<void> {
		this.onPreDisconnect();
		if (!this.client) return;
		const client = this.client;
		this.client = null;
		this.connected = false;
		// force=true stops any pending reconnect timer immediately
		await new Promise<void>((resolve) => client.end(true, {}, () => resolve()));
		this.emit('disconnect');
	}

	public async publish(
		topic: string,
		payload: string | Buffer,
		options?: { qos?: 0 | 1 | 2; destinationTopic?: string },
	): Promise<void> {
		if (!this.client || !this.connected) {
			throw new Error(`${this.providerName}: not connected`);
		}

		const targetTopic =
			typeof options?.destinationTopic === 'string' && options.destinationTopic.trim().length > 0
				? options.destinationTopic.trim()
				: this.buildPublishTopic(topic);
		const qos = options?.qos ?? 1;

		let lastError: Error | null = null;
		for (let attempt = 0; attempt < this.maxPublishRetries; attempt++) {
			try {
				await new Promise<void>((resolve, reject) => {
					this.client!.publish(targetTopic, payload, { qos }, (err) =>
						err ? reject(err) : resolve(),
					);
				});
				return;
			} catch (error) {
				const asError = error instanceof Error ? error : new Error(String(error));
				lastError = asError;

				const isLast = attempt === this.maxPublishRetries - 1;
				if (!this.isTransientPublishError(asError) || isLast) {
					throw asError;
				}

				const delayMs = this._retryDelayMs(attempt);
				this.onPublishRetry(attempt, asError, delayMs);
				await this._sleep(delayMs);
			}
		}

		throw lastError || new Error(`${this.providerName} publish failed after retries`);
	}

	public isConnected(): boolean {
		return this.connected;
	}

	public getPublishMode(): PublishMode {
		return this.connected ? 'direct' : 'buffer-only';
	}

	public getMessageIdGenerator(): undefined {
		return undefined;
	}

	protected _retryDelayMs(attempt: number): number {
		return Math.min(250 * 2 ** attempt, 1000);
	}

	protected _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
