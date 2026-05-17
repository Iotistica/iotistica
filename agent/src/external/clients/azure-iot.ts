/**
 * AzureIotClient
 * ==============
 * Azure IoT Hub D2C (device-to-cloud) MQTT client.
 *
 * Extends BaseMqttClient for shared connect/disconnect/publish lifecycle.
 * Adds Azure-specific:
 *  - SAS token generation (HMAC-SHA256, base64 key)
 *  - SAS token renewal at 80% of TTL via onConnected() hook
 *  - Azure IoT Hub topic format with message properties
 *  - Transient-error classification for smart retry
 */

import * as crypto from 'crypto';
import type { IClientOptions } from 'mqtt';
import { LogComponents } from '../../logging/types.js';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BaseMqttClient } from '../base-client.js';
import type { AzureIotProviderConfig } from '../config.js';

export class AzureIotClient extends BaseMqttClient {
	private renewalTimer: NodeJS.Timeout | null = null;
	private readonly tokenTtlSeconds: number;

	constructor(
		private readonly config: AzureIotProviderConfig,
		logger?: AgentLogger,
	) {
		super(logger);
		this.tokenTtlSeconds = config.auth.tokenTtlSeconds ?? 3600;
	}

	// ── Abstract implementation ───────────────────────────────────────────────

	protected get providerName(): string {
		return 'Azure IoT Hub';
	}

	protected getLogContext(): Record<string, unknown> {
		return { hostName: this.config.hostName, deviceId: this.config.deviceId };
	}

	/**
	 * Builds MQTT options with a freshly generated SAS token.
	 * Called by BaseMqttClient.connect() so renewals automatically get a new token.
	 */
	protected buildMqttOptions(): IClientOptions {
		const { hostName, deviceId } = this.config;
		const resourceUri = `${hostName}/devices/${deviceId}`;
		const sasToken = this._generateSasToken(
			resourceUri,
			this.config.auth.sharedAccessKey,
			this.tokenTtlSeconds,
		);

		return {
			host: hostName,
			port: 8883,
			protocol: 'mqtts',
			clientId: deviceId,
			username: `${hostName}/${deviceId}/?api-version=2021-04-12`,
			password: sasToken,
			rejectUnauthorized: true,
			keepalive: 60,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000,
		};
	}

	/**
	 * Encodes the source topic's endpoint segment as an IoT Hub message property
	 * so routing rules can filter by endpoint without parsing the payload.
	 * e.g. "iot/uuid/endpoints/modbus" → devices/{id}/messages/events/?endpoint=modbus
	 */
	protected buildPublishTopic(sourceTopic: string): string {
		const endpoint = sourceTopic.split('/').pop() || 'telemetry';
		return (
			`devices/${this.config.deviceId}/messages/events/?` +
			`endpoint=${encodeURIComponent(endpoint)}` +
			`&%24.ct=${encodeURIComponent('application/json')}` +
			`&%24.ce=${encodeURIComponent('utf-8')}`
		);
	}

	// ── Hooks ─────────────────────────────────────────────────────────────────

	/** Schedule SAS token renewal after successful connect. */
	protected onConnected(): void {
		this._scheduleRenewal();
	}

	/** Cancel pending renewal timer before disconnect. */
	protected onPreDisconnect(): void {
		this._clearRenewal();
	}

	/** Log a warning before each retry attempt. */
	protected onPublishRetry(attempt: number, error: Error, nextDelayMs: number): void {
		this.logger?.warnSync('Azure IoT Hub publish transient failure, retrying', {
			component: LogComponents.agent,
			attempt: attempt + 1,
			nextDelayMs,
			error: error.message,
			...this.getLogContext(),
		});
	}

	/** Azure-specific transient error classification. */
	protected isTransientPublishError(error: Error): boolean {
		const code = ((error as Error & { code?: string }).code || '').toUpperCase();
		if (['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
		const msg = (error.message || '').toLowerCase();
		return (
			msg.includes('timeout') ||
			msg.includes('temporarily unavailable') ||
			msg.includes('throttle') ||
			msg.includes('server busy')
		);
	}

	// ── SAS token ─────────────────────────────────────────────────────────────

	private _generateSasToken(resourceUri: string, key: string, ttlSeconds: number): string {
		const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
		const stringToSign = `${encodeURIComponent(resourceUri)}\n${expiry}`;
		const hmac = crypto.createHmac('sha256', Buffer.from(key, 'base64'));
		hmac.update(stringToSign);
		const signature = hmac.digest('base64');
		return (
			`SharedAccessSignature sr=${encodeURIComponent(resourceUri)}` +
			`&sig=${encodeURIComponent(signature)}&se=${expiry}`
		);
	}

	/** Renew at 80% of TTL to avoid expiry mid-connection. */
	private _scheduleRenewal(): void {
		const renewAfterMs = this.tokenTtlSeconds * 0.8 * 1000;
		this._clearRenewal();
		this.renewalTimer = setTimeout(() => {
			this.logger?.infoSync('Azure IoT Hub SAS token renewal', {
				component: LogComponents.agent,
				...this.getLogContext(),
			});
			if (this.client && this.connected) {
				// disconnect() triggers onPreDisconnect → clears timer, then reconnects
				// with a freshly generated SAS token via buildMqttOptions().
				this.disconnect()
					.then(() => this.connect())
					.catch((err) => {
						this.logger?.errorSync(
							'Azure IoT Hub SAS token renewal failed',
							err instanceof Error ? err : new Error(String(err)),
							{ component: LogComponents.agent, ...this.getLogContext() },
						);
					});
			}
		}, renewAfterMs);
	}

	private _clearRenewal(): void {
		if (this.renewalTimer) {
			clearTimeout(this.renewalTimer);
			this.renewalTimer = null;
		}
	}
}
