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

function loadExternalMqttConfigFromRecord(config: Record<string, unknown> | null | undefined, fallbackDeviceId?: string): ExternalMqttConfig | null {
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
					: fallbackDeviceId || 'device',
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

function loadExternalMqttConfigFromEnv(fallbackDeviceId?: string): ExternalMqttConfig {
	const rawUrl = process.env.EXTERNAL_MQTT_BROKER_URL || process.env.MQTT_EXTERNAL_BROKER_URL || '';
	if (!rawUrl) {
		throw new Error('PUBLISH_TARGET=mqtt requires EXTERNAL_MQTT_BROKER_URL');
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw new Error(
			'Invalid EXTERNAL_MQTT_BROKER_URL. Expected absolute URL like mqtt://host:1883 or mqtts://host:8883',
		);
	}

	const scheme = parsedUrl.protocol.replace(':', '').toLowerCase();
	if (scheme !== 'mqtt' && scheme !== 'mqtts' && scheme !== 'ws' && scheme !== 'wss') {
		throw new Error('EXTERNAL_MQTT_BROKER_URL must use mqtt, mqtts, ws, or wss scheme');
	}

	const protocol = scheme;
	const defaultPort = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : protocol === 'wss' ? 443 : 80;
	const envReject = process.env.EXTERNAL_MQTT_REJECT_UNAUTHORIZED;
	const rejectUnauthorized =
		envReject === undefined
			? true
			: !['0', 'false', 'no', 'off'].includes(envReject.trim().toLowerCase());

	return {
		provider: 'mqtt',
		host: parsedUrl.hostname,
		port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
		protocol,
		path: parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname : undefined,
		clientId:
			process.env.EXTERNAL_MQTT_CLIENT_ID ||
			process.env.DEVICE_UUID ||
			process.env.DEVICE_ID ||
			fallbackDeviceId ||
			'device',
		username: process.env.EXTERNAL_MQTT_USERNAME || parsedUrl.username || undefined,
		password: process.env.EXTERNAL_MQTT_PASSWORD || parsedUrl.password || undefined,
		topicTemplate:
			process.env.EXTERNAL_MQTT_TOPIC_TEMPLATE ||
			process.env.MQTT_EXTERNAL_PUBLISH_TOPIC_TEMPLATE ||
			'{topic}',
		ca: process.env.EXTERNAL_MQTT_CA_CERT,
		cert: process.env.EXTERNAL_MQTT_CLIENT_CERT,
		key: process.env.EXTERNAL_MQTT_CLIENT_KEY,
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

	public static fromEnv(agentLogger?: AgentLogger, logger?: Logger): MqttPublishPlugin {
		const client = MqttPublishPlugin.createClientFromEnv(agentLogger);

		return new MqttPublishPlugin(client, logger);
	}

	public static fromConfig(
		config: Record<string, unknown> | null | undefined,
		agentLogger?: AgentLogger,
		logger?: Logger,
		fallbackDeviceId?: string,
	): MqttPublishPlugin {
		const resolved = loadExternalMqttConfigFromRecord(config, fallbackDeviceId)
			?? loadExternalMqttConfigFromEnv(fallbackDeviceId);
		return new MqttPublishPlugin(new ExternalMqttClient(resolved, agentLogger), logger);
	}

	public static createClientFromEnv(agentLogger?: AgentLogger, deviceUuid?: string): ExternalMqttClient {
		return new ExternalMqttClient(loadExternalMqttConfigFromEnv(deviceUuid), agentLogger);
	}
}
