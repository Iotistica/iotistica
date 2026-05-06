/**
 * IotHubMqttClient
 * ================
 * Azure IoT Hub D2C (device-to-cloud) MQTT client.
 *
 * Connects via native MQTT over TLS (port 8883) using SAS token authentication.
 * Publishes sensor telemetry to the IoT Hub topic:
 *   devices/{deviceId}/messages/events/
 *
 * Implements the MqttConnection interface from publish/types so it can be
 * injected directly into PublishManager / DevicePublishFeature.
 *
 * Connection strings are in the standard Azure format:
 *   HostName=hub.azure-devices.net;DeviceId=my-device;SharedAccessKey=base64==
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import mqtt from 'mqtt';
import type { MqttClient, IClientOptions } from 'mqtt';
import type { MqttConnection, PublishMode } from '../features/publish/types.js';
import { LogComponents } from '../logging/types.js';
import type { AgentLogger } from '../logging/agent-logger.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface ParsedConnStr {
	hostName: string;
	deviceId: string;
	sharedAccessKey: string;
}

// ─── SAS token helpers ────────────────────────────────────────────────────────

function parseConnectionString(connStr: string): ParsedConnStr | null {
	const parts: Record<string, string> = {};
	for (const segment of connStr.split(';')) {
		const eq = segment.indexOf('=');
		if (eq === -1) continue;
		parts[segment.slice(0, eq)] = segment.slice(eq + 1);
	}
	const { HostName: hostName, DeviceId: deviceId, SharedAccessKey: sharedAccessKey } = parts;
	if (!hostName || !deviceId || !sharedAccessKey) return null;
	return { hostName, deviceId, sharedAccessKey };
}

function generateSasToken(
	resourceUri: string,
	key: string,
	ttlSeconds: number,
): string {
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

// ─── Client ──────────────────────────────────────────────────────────────────

export class IotHubMqttClient extends EventEmitter implements MqttConnection {
	private client: MqttClient | null = null;
	private connected = false;
	private renewalTimer: NodeJS.Timeout | null = null;
	private readonly parsed: ParsedConnStr;

	/** SAS token TTL in seconds (default: 1 hour). */
	private readonly tokenTtlSeconds: number;
	private readonly maxPublishRetries = 3;

	constructor(
		private readonly connectionString: string,
		private readonly logger?: AgentLogger,
		tokenTtlSeconds = 3600,
	) {
		super();
		const parsed = parseConnectionString(connectionString);
		if (!parsed) {
			throw new Error(
				'Invalid Azure IoT Hub connection string. ' +
				'Expected: HostName=...;DeviceId=...;SharedAccessKey=...',
			);
		}
		this.parsed = parsed;
		this.tokenTtlSeconds = tokenTtlSeconds;
	}

	// ─── MqttConnection ──────────────────────────────────────────────────────

	public async connect(): Promise<void> {
		await this._openConnection(this.parsed);

		this.logger?.infoSync('IotHub MQTT connected', {
			component: LogComponents.agent,
			hostName: this.parsed.hostName,
			deviceId: this.parsed.deviceId,
		});

		this._scheduleRenewal(this.parsed);
	}

	public async disconnect(): Promise<void> {
		this._clearRenewal();
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
			throw new Error('IotHubMqttClient: not connected');
		}
		// Extract the endpoint name from the last segment of the Iotistica topic
		// (e.g. "iot/uuid/endpoints/modbus" → "modbus") and encode it as an IoT Hub
		// message property so routing rules can filter by endpoint without parsing the payload.
		const endpoint = topic.split('/').pop() || 'telemetry';
		const iotHubTopic =
			`devices/${this._deviceId()}/messages/events/?` +
			`endpoint=${encodeURIComponent(endpoint)}` +
			`&%24.ct=${encodeURIComponent('application/json')}` +
			`&%24.ce=${encodeURIComponent('utf-8')}`;

		let lastError: Error | null = null;
		for (let attempt = 0; attempt < this.maxPublishRetries; attempt++) {
			try {
				await this._publishOnce(iotHubTopic, payload, options?.qos ?? 1);
				return;
			} catch (error) {
				const asError = error instanceof Error ? error : new Error(String(error));
				lastError = asError;
				if (!this._isTransientPublishError(asError) || attempt === this.maxPublishRetries - 1) {
					throw asError;
				}

				const delayMs = this._retryDelayMs(attempt);
				this.logger?.warnSync('IotHub publish transient failure, retrying', {
					component: LogComponents.agent,
					attempt: attempt + 1,
					nextDelayMs: delayMs,
					error: asError.message,
				});
				await this._sleep(delayMs);
			}
		}

		throw lastError || new Error('IotHub publish failed after retries');
	}

	public isConnected(): boolean {
		return this.connected;
	}

	public getPublishMode(): PublishMode {
		return this.connected ? 'direct' : 'buffer-only';
	}

	public getMessageIdGenerator(): undefined {
		// IoT Hub handles deduplication server-side; no client-side msgId needed.
		return undefined;
	}

	// ─── Internal ────────────────────────────────────────────────────────────

	private _deviceId(): string {
		return this.parsed.deviceId;
	}

	private _publishOnce(
		iotHubTopic: string,
		payload: string | Buffer,
		qos: 0 | 1 | 2,
	): Promise<void> {
		return new Promise((resolve, reject) => {
			this.client!.publish(iotHubTopic, payload, { qos }, (err) =>
				err ? reject(err) : resolve(),
			);
		});
	}

	private _retryDelayMs(attempt: number): number {
		// 250ms, 500ms, 1000ms
		return Math.min(250 * 2 ** attempt, 1000);
	}

	private _isTransientPublishError(error: Error): boolean {
		const anyError = error as Error & { code?: string };
		const code = (anyError.code || '').toUpperCase();
		if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EAI_AGAIN' || code === 'ENOTFOUND') {
			return true;
		}

		const message = (error.message || '').toLowerCase();
		return (
			message.includes('timeout') ||
			message.includes('temporarily unavailable') ||
			message.includes('throttle') ||
			message.includes('server busy')
		);
	}

	private _sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private async _openConnection(parsed: ParsedConnStr): Promise<void> {
		const { hostName, deviceId, sharedAccessKey } = parsed;
		const resourceUri = `${hostName}/devices/${deviceId}`;
		const sasToken = generateSasToken(resourceUri, sharedAccessKey, this.tokenTtlSeconds);

		const options: IClientOptions = {
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

		return new Promise((resolve, reject) => {
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
					'IotHub MQTT client error',
					err instanceof Error ? err : new Error(String(err)),
					{
						component: LogComponents.agent,
						hostName,
						deviceId,
					},
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
				this.logger?.infoSync('IotHub MQTT reconnecting', {
					component: LogComponents.agent,
					hostName,
					deviceId,
				});
			});
		});
	}

	private _scheduleRenewal(parsed: ParsedConnStr): void {
		// Renew the SAS token at 80% of TTL to avoid expiry mid-connection.
		const renewAfterMs = this.tokenTtlSeconds * 0.8 * 1000;
		this._clearRenewal();
		this.renewalTimer = setTimeout(() => {
			this.logger?.infoSync('IotHub SAS token renewal', {
				component: LogComponents.agent,
				deviceId: parsed.deviceId,
			});
			if (this.client && this.connected) {
				this.disconnect()
					.then(() => this._openConnection(parsed))
					.then(() => this._scheduleRenewal(parsed))
					.catch((err) => {
						this.logger?.errorSync('IotHub SAS token renewal failed', err instanceof Error ? err : new Error(String(err)), {
							component: LogComponents.agent,
						});
					});
			} else {
				// If currently disconnected, avoid forced churn and reschedule renewal.
				this._scheduleRenewal(parsed);
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
