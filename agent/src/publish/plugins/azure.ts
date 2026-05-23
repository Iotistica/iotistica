import * as crypto from 'crypto';
import type { IClientOptions } from 'mqtt';
import { LogComponents } from '../../logging/types.js';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BasePublishPlugin } from '../core/base-plugin.js';
import type { IPublishClient, Logger } from '../core/types.js';
import { BaseMqttClient } from '../core/base-client.js';

interface AzureIotConfig {
	provider: 'azure';
	hostName: string;
	deviceId: string;
	auth: {
		type: 'sas';
		sharedAccessKey: string;
		tokenTtlSeconds?: number;
	};
}

function parseAzureConnectionString(
	connStr: string,
): { hostName: string; deviceId: string; sharedAccessKey: string } | null {
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

function loadAzureConfigFromEnv(): AzureIotConfig {
	const connStr = process.env.AZURE_IOTHUB_CONNECTION_STRING || '';
	if (!connStr) {
		throw new Error('PUBLISH_TARGET=azure requires AZURE_IOTHUB_CONNECTION_STRING');
	}

	const parsed = parseAzureConnectionString(connStr);
	if (!parsed) {
		throw new Error(
			'Invalid AZURE_IOTHUB_CONNECTION_STRING. Expected: HostName=...;DeviceId=...;SharedAccessKey=...',
		);
	}

	return {
		provider: 'azure',
		hostName: parsed.hostName,
		deviceId: parsed.deviceId,
		auth: {
			type: 'sas',
			sharedAccessKey: parsed.sharedAccessKey,
			tokenTtlSeconds: process.env.AZURE_SAS_TOKEN_TTL_SECONDS
				? Number(process.env.AZURE_SAS_TOKEN_TTL_SECONDS)
				: undefined,
		},
	};
}

export class AzureIotClient extends BaseMqttClient {
	private renewalTimer: NodeJS.Timeout | null = null;
	private readonly tokenTtlSeconds: number;

	constructor(
		private readonly config: AzureIotConfig,
		logger?: AgentLogger,
	) {
		super(logger);
		this.tokenTtlSeconds = config.auth.tokenTtlSeconds ?? 3600;
	}

	protected get providerName(): string {
		return 'Azure IoT Hub';
	}

	protected getLogContext(): Record<string, unknown> {
		return { hostName: this.config.hostName, deviceId: this.config.deviceId };
	}

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

	protected buildPublishTopic(sourceTopic: string): string {
		const endpoint = sourceTopic.split('/').pop() || 'telemetry';
		return (
			`devices/${this.config.deviceId}/messages/events/?` +
			`endpoint=${encodeURIComponent(endpoint)}` +
			`&%24.ct=${encodeURIComponent('application/json')}` +
			`&%24.ce=${encodeURIComponent('utf-8')}`
		);
	}

	protected onConnected(): void {
		this._scheduleRenewal();
	}

	protected onPreDisconnect(): void {
		this._clearRenewal();
	}

	protected onPublishRetry(attempt: number, error: Error, nextDelayMs: number): void {
		this.logger?.warnSync('Azure IoT Hub publish transient failure, retrying', {
			component: LogComponents.agent,
			attempt: attempt + 1,
			nextDelayMs,
			error: error.message,
			...this.getLogContext(),
		});
	}

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

	private _scheduleRenewal(): void {
		const renewAfterMs = this.tokenTtlSeconds * 0.8 * 1000;
		this._clearRenewal();
		this.renewalTimer = setTimeout(() => {
			this.logger?.infoSync('Azure IoT Hub SAS token renewal', {
				component: LogComponents.agent,
				...this.getLogContext(),
			});
			if (this.connected && this.client?.connected) {
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

export class AzurePublishPlugin extends BasePublishPlugin {
	constructor(client: IPublishClient, logger?: Logger) {
		super(client, logger);
	}

	public static fromEnv(agentLogger?: AgentLogger, logger?: Logger): AzurePublishPlugin {
		const client = AzurePublishPlugin.createClientFromEnv(agentLogger);

		return new AzurePublishPlugin(client, logger);
	}

	public static createClientFromEnv(agentLogger?: AgentLogger): AzureIotClient {
		return new AzureIotClient(loadAzureConfigFromEnv(), agentLogger);
	}
}
