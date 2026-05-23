import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BasePublishPlugin } from '../core/base-plugin.js';
import type { IPublishClient, Logger } from '../core/types.js';
import { BaseMqttClient } from '../core/base-client.js';

interface GcpIotConfig {
	provider: 'gcp';
	endpoint: string;
	port: number;
	clientId: string;
	username: string;
	topicTemplate: string;
	auth: {
		type: 'jwt';
		jwt?: string;
		password?: string;
	};
	ca?: string;
}

function loadGcpConfigFromEnv(): GcpIotConfig {
	const endpoint = process.env.GCP_MQTT_ENDPOINT || '';
	if (!endpoint) {
		throw new Error('PUBLISH_TARGET=gcp requires GCP_MQTT_ENDPOINT');
	}

	return {
		provider: 'gcp',
		endpoint,
		port: Number(process.env.GCP_MQTT_PORT || 8883),
		clientId:
			process.env.GCP_MQTT_CLIENT_ID ||
			process.env.DEVICE_UUID ||
			process.env.DEVICE_ID ||
			'device',
		username: process.env.GCP_MQTT_USERNAME || 'unused',
		topicTemplate:
			process.env.GCP_MQTT_PUBLISH_TOPIC_TEMPLATE ||
			'/devices/{deviceId}/events/{endpoint}',
		auth: {
			type: 'jwt',
			jwt: process.env.GCP_MQTT_JWT,
			password: process.env.GCP_MQTT_PASSWORD,
		},
		ca: process.env.GCP_MQTT_CA_CERT,
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

export class GcpIotClient extends BaseMqttClient {
	constructor(
		private readonly config: GcpIotConfig,
		logger?: AgentLogger,
	) {
		super(logger);
	}

	protected get providerName(): string {
		return 'GCP IoT';
	}

	protected getLogContext(): Record<string, unknown> {
		return { endpoint: this.config.endpoint, clientId: this.config.clientId };
	}

	protected buildMqttOptions(): IClientOptions {
		const options: IClientOptions = {
			host: this.config.endpoint,
			port: this.config.port,
			protocol: 'mqtts',
			clientId: this.config.clientId,
			username: this.config.username,
			password: this.config.auth.jwt ?? this.config.auth.password,
			rejectUnauthorized: true,
			keepalive: 60,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000,
		};

		options.ca = this.config.ca?.replace(/\\n/g, '\n');

		return options;
	}

	protected buildPublishTopic(sourceTopic: string): string {
		const parsed = parseSourceTopic(sourceTopic);
		return applyTopicTemplate(
			this.config.topicTemplate || '/devices/{deviceId}/events/{endpoint}',
			{
				deviceId: this.config.clientId,
				endpoint: parsed.endpoint,
				topic: parsed.originalTopic,
			},
		);
	}
}

export class GcpPublishPlugin extends BasePublishPlugin {
	constructor(client: IPublishClient, logger?: Logger) {
		super(client, logger);
	}

	public static fromEnv(agentLogger?: AgentLogger, logger?: Logger): GcpPublishPlugin {
		const client = GcpPublishPlugin.createClientFromEnv(agentLogger);

		return new GcpPublishPlugin(client, logger);
	}

	public static createClientFromEnv(agentLogger?: AgentLogger): GcpIotClient {
		return new GcpIotClient(loadGcpConfigFromEnv(), agentLogger);
	}
}
