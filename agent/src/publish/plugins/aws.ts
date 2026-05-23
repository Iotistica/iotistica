import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BasePublishPlugin } from '../core/base-plugin.js';
import type { IPublishClient, Logger } from '../core/types.js';
import { BaseMqttClient } from '../core/base-client.js';

interface AwsIotConfig {
	provider: 'aws';
	endpoint: string;
	port: number;
	deviceId: string;
	topicTemplate: string;
	auth: {
		type: 'mtls';
		ca?: string;
		cert: string;
		key: string;
	};
}

function loadAwsConfigFromEnv(): AwsIotConfig {
	const endpoint = process.env.AWS_IOT_ENDPOINT || '';
	if (!endpoint) {
		throw new Error('PUBLISH_TARGET=aws requires AWS_IOT_ENDPOINT');
	}

	const cert = process.env.AWS_IOT_CLIENT_CERT || '';
	const key = process.env.AWS_IOT_PRIVATE_KEY || '';
	if (!cert || !key) {
		throw new Error('PUBLISH_TARGET=aws requires AWS_IOT_CLIENT_CERT and AWS_IOT_PRIVATE_KEY');
	}

	return {
		provider: 'aws',
		endpoint,
		port: Number(process.env.AWS_IOT_PORT || 8883),
		deviceId:
			process.env.AWS_IOT_DEVICE_ID ||
			process.env.DEVICE_UUID ||
			process.env.DEVICE_ID ||
			'device',
		topicTemplate:
			process.env.AWS_IOT_PUBLISH_TOPIC_TEMPLATE ||
			'devices/{deviceId}/messages/events/{endpoint}',
		auth: {
			type: 'mtls',
			ca: process.env.AWS_IOT_CA_CERT,
			cert,
			key,
		},
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

export class AwsIotClient extends BaseMqttClient {
	constructor(
		private readonly config: AwsIotConfig,
		logger?: AgentLogger,
	) {
		super(logger);
	}

	protected get providerName(): string {
		return 'AWS IoT';
	}

	protected getLogContext(): Record<string, unknown> {
		return { endpoint: this.config.endpoint, deviceId: this.config.deviceId };
	}

	protected buildMqttOptions(): IClientOptions {
		const options: IClientOptions = {
			host: this.config.endpoint,
			port: this.config.port,
			protocol: 'mqtts',
			clientId: this.config.deviceId,
			rejectUnauthorized: true,
			keepalive: 60,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000,
		};

		if (this.config.auth.type === 'mtls') {
			const { ca, cert, key } = this.config.auth;
			options.ca = ca?.replace(/\\n/g, '\n');
			options.cert = cert?.replace(/\\n/g, '\n');
			options.key = key?.replace(/\\n/g, '\n');
		}

		return options;
	}

	protected buildPublishTopic(sourceTopic: string): string {
		const parsed = parseSourceTopic(sourceTopic);
		return applyTopicTemplate(
			this.config.topicTemplate || 'devices/{deviceId}/messages/events/{endpoint}',
			{
				deviceId: this.config.deviceId,
				endpoint: parsed.endpoint,
				topic: parsed.originalTopic,
			},
		);
	}
}

export class AwsPublishPlugin extends BasePublishPlugin {
	constructor(client: IPublishClient, logger?: Logger) {
		super(client, logger);
	}

	public static fromEnv(agentLogger?: AgentLogger, logger?: Logger): AwsPublishPlugin {
		const client = AwsPublishPlugin.createClientFromEnv(agentLogger);

		return new AwsPublishPlugin(client, logger);
	}

	public static createClientFromEnv(agentLogger?: AgentLogger): AwsIotClient {
		return new AwsIotClient(loadAwsConfigFromEnv(), agentLogger);
	}
}
