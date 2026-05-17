/**
 * external/base-client.ts
 * =======================
 * Abstract base class shared by all external cloud MQTT publish clients.
 *
 * Handles:
 *  - MQTT connect / disconnect lifecycle
 *  - Event wiring (error, disconnect, offline, reconnect)
 *  - Publish with retry (with transient-error hook + retry-log hook)
 *  - State management (connected flag)
 *  - MqttConnection interface boilerplate
 *
 * Subclasses implement:
 *  - buildMqttOptions()   – provider-specific auth + options
 *  - buildPublishTopic()  – provider-specific topic format
 *  - getLogContext()      – fields added to every log entry
 *  - providerName         – display label used in logs / error messages
 *
 * Optional overrides:
 *  - onConnected()           – hook called after successful connect (Azure uses for SAS renewal)
 *  - onPreDisconnect()       – hook called before disconnect (Azure uses for timer cleanup)
 *  - isTransientPublishError – classify whether an error warrants a retry
 *  - onPublishRetry()        – hook called before each retry (Azure uses for warn logging)
 */

import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { MqttConnection, PublishMode } from '../publish/types.js';

export abstract class BaseMqttClient extends EventEmitter implements MqttConnection {
	protected client: MqttClient | null = null;
	protected connected = false;
	protected readonly maxPublishRetries = 3;

	constructor(protected readonly logger?: AgentLogger) {
		super();
	}

	// ── Abstract interface ────────────────────────────────────────────────────

	protected abstract get providerName(): string;
	protected abstract buildMqttOptions(): IClientOptions;
	protected abstract buildPublishTopic(sourceTopic: string): string;
	protected abstract getLogContext(): Record<string, unknown>;

	// ── Optional hooks ────────────────────────────────────────────────────────

	/** Called immediately after a successful connect. */
	protected onConnected(): void {}

	/** Called at the start of disconnect, before the socket is closed. */
	protected onPreDisconnect(): void {}

	/**
	 * Returns true if the publish error is transient and should be retried.
	 * Default: always retry (plain MQTT write failures are transient).
	 */
	protected isTransientPublishError(_error: Error): boolean {
		return true;
	}

	/**
	 * Called before each retry attempt.
	 * Override to add provider-specific warn logging.
	 */
	protected onPublishRetry(_attempt: number, _error: Error, _nextDelayMs: number): void {}

	// ── MqttConnection ────────────────────────────────────────────────────────

	public async connect(): Promise<void> {
		const options = this.buildMqttOptions();

		await new Promise<void>((resolve, reject) => {
			const client = mqtt.connect(options as any);

			const onConnect = () => {
				this.client = client;
				this.connected = true;
				client.removeListener('error', onError);
				this.emit('connect');
				resolve();
			};

			const onError = (err: Error) => {
				client.removeListener('connect', onConnect);
				reject(err);
			};

			client.once('connect', onConnect);
			client.once('error', onError);

			client.on('error', (err) => {
				this.logger?.errorSync(
					`${this.providerName} MQTT client error`,
					err instanceof Error ? err : new Error(String(err)),
					{ component: LogComponents.agent, ...this.getLogContext() },
				);
				this.emit('error', err);
			});

			client.on('disconnect', () => {
				this.connected = false;
				this.emit('disconnect');
			});

			client.on('offline', () => {
				this.connected = false;
			});

			client.on('reconnect', () => {
				this.logger?.infoSync(`${this.providerName} MQTT reconnecting`, {
					component: LogComponents.agent,
					...this.getLogContext(),
				});
			});
		});

		this.logger?.infoSync(`${this.providerName} MQTT connected`, {
			component: LogComponents.agent,
			...this.getLogContext(),
		});

		this.onConnected();
	}

	public async disconnect(): Promise<void> {
		this.onPreDisconnect();
		if (!this.client) return;
		await new Promise<void>((resolve) => this.client!.end(false, {}, () => resolve()));
		this.client = null;
		this.connected = false;
		this.emit('disconnect');
	}

	public async publish(
		topic: string,
		payload: string | Buffer,
		options?: { qos?: 0 | 1 | 2 },
	): Promise<void> {
		if (!this.client || !this.connected) {
			throw new Error(`${this.providerName}: not connected`);
		}

		const targetTopic = this.buildPublishTopic(topic);
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

	// ── Helpers ───────────────────────────────────────────────────────────────

	protected _retryDelayMs(attempt: number): number {
		return Math.min(250 * 2 ** attempt, 1000);
	}

	protected _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
