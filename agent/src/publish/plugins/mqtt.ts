import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BasePublishPlugin } from '../core/base-plugin.js';
import type { IPublishClient, Logger } from '../core/types.js';
import { BaseMqttClient } from '../core/base-client.js';

interface ExternalMqttConfig {
	provider: 'mqtt';
	host: string;
	port: number;
	protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
	path?: string;
	clientId: string;
	username?: string;
	password?: string;
	topicTemplate: string;
	ca?: string;
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function loadExternalMqttConfigFromRecord(
	config: Record<string, unknown> | null | undefined,
	fallbackDeviceId?: string,
	fallbackEndpointName?: string,
): ExternalMqttConfig | null {
	if (!isRecord(config)) {
		return null;
	}

	const brokerUrl = typeof config.brokerUrl === 'string'
		? config.brokerUrl
		: typeof config.url === 'string'
			? config.url
			: typeof config.host === 'string'
				? config.host
				: '';

	if (!brokerUrl) {
		return null;
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(brokerUrl);
	} catch {
		throw new Error('Invalid mqtt publisher config brokerUrl. Expected absolute URL like mqtt://host:1883 or mqtts://host:8883');
	}

	const scheme = parsedUrl.protocol.replace(':', '').toLowerCase();
	if (scheme !== 'mqtt' && scheme !== 'mqtts' && scheme !== 'ws' && scheme !== 'wss') {
		throw new Error('mqtt publisher config brokerUrl must use mqtt, mqtts, ws, or wss scheme');
	}

	const protocol = scheme;
	const defaultPort = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : protocol === 'wss' ? 443 : 80;
	const rejectUnauthorized = typeof config.rejectUnauthorized === 'boolean' ? config.rejectUnauthorized : undefined;
	const sanitizedEndpoint = (fallbackEndpointName || 'endpoint')
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
	const fallbackClientId = fallbackDeviceId && fallbackDeviceId.trim().length > 0
		? `${fallbackDeviceId}-${sanitizedEndpoint || 'endpoint'}-external-mqtt`
		: 'device-external-mqtt';

	return {
		provider: 'mqtt',
		host: parsedUrl.hostname,
		port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
		protocol,
		path: typeof config.path === 'string'
			? config.path
			: parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname : undefined,
		clientId:
			typeof config.clientId === 'string' && config.clientId.trim().length > 0
				? config.clientId
				: typeof config.deviceId === 'string' && config.deviceId.trim().length > 0
					? config.deviceId
					: fallbackClientId,
		username: typeof config.username === 'string' ? config.username : parsedUrl.username || undefined,
		password: typeof config.password === 'string' ? config.password : parsedUrl.password || undefined,
		topicTemplate:
			typeof config.topicTemplate === 'string' && config.topicTemplate.trim().length > 0
				? config.topicTemplate
				: typeof config.publishTopicTemplate === 'string' && config.publishTopicTemplate.trim().length > 0
					? config.publishTopicTemplate
					: '{topic}',
		ca: typeof config.ca === 'string' ? config.ca : undefined,
		cert: typeof config.cert === 'string' ? config.cert : undefined,
		key: typeof config.key === 'string' ? config.key : undefined,
		rejectUnauthorized,
	};
}

function parseSourceTopic(sourceTopic: string): { endpoint: string; originalTopic: string } {
	return {
		endpoint: sourceTopic.split('/').pop() || 'telemetry',
		originalTopic: sourceTopic,
	};
}

function applyTopicTemplate(
	template: string,
	params: { deviceId: string; endpoint: string; topic: string },
): string {
	return template
		.replaceAll('{deviceId}', encodeURIComponent(params.deviceId))
		.replaceAll('{endpoint}', encodeURIComponent(params.endpoint))
		.replaceAll('{topic}', params.topic);
}

export class ExternalMqttClient extends BaseMqttClient {
	constructor(
		private readonly config: ExternalMqttConfig,
		logger?: AgentLogger,
	) {
		super(logger);
	}

	protected get providerName(): string {
		return 'External MQTT';
	}

	protected getLogContext(): Record<string, unknown> {
		return {
			host: this.config.host,
			port: this.config.port,
			protocol: this.config.protocol,
			clientId: this.config.clientId,
		};
	}

	protected buildMqttOptions(): IClientOptions {
		const options: IClientOptions = {
			host: this.config.host,
			port: this.config.port,
			protocol: this.config.protocol,
			clientId: this.config.clientId,
			username: this.config.username,
			password: this.config.password,
			rejectUnauthorized: this.config.rejectUnauthorized ?? true,
			keepalive: 60,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000,
		};

		options.path = this.config.path;
		options.ca = this.config.ca?.replace(/\\n/g, '\n');
		options.cert = this.config.cert?.replace(/\\n/g, '\n');
		options.key = this.config.key?.replace(/\\n/g, '\n');

		return options;
	}

	protected buildPublishTopic(sourceTopic: string): string {
		const parsed = parseSourceTopic(sourceTopic);
		return applyTopicTemplate(this.config.topicTemplate || '{topic}', {
			deviceId: this.config.clientId,
			endpoint: parsed.endpoint,
			topic: parsed.originalTopic,
		});
	}
}

export class MqttPublishPlugin extends BasePublishPlugin {
	constructor(client: IPublishClient, logger?: Logger) {
		super(client, logger);
	}

	public static fromConfig(
		config: Record<string, unknown> | null | undefined,
		agentLogger?: AgentLogger,
		logger?: Logger,
		fallbackDeviceId?: string,
		fallbackEndpointName?: string,
	): MqttPublishPlugin {
		const resolved = loadExternalMqttConfigFromRecord(config, fallbackDeviceId, fallbackEndpointName);
		if (!resolved) {
			throw new Error('mqtt publisher requires config_json with a brokerUrl');
		}
		return new MqttPublishPlugin(new ExternalMqttClient(resolved, agentLogger), logger);
	}
}
