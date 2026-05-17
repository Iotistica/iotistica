import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BaseMqttClient } from '../base-client.js';
import type { AwsIotProviderConfig } from '../config.js';
import { applyTopicTemplate, parseSourceTopic } from '../topic-mapper.js';

export class AwsIotClient extends BaseMqttClient {
	constructor(
		private readonly config: AwsIotProviderConfig,
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
			if (ca) options.ca = ca.replace(/\\n/g, '\n');
			if (cert) options.cert = cert.replace(/\\n/g, '\n');
			if (key) options.key = key.replace(/\\n/g, '\n');
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
