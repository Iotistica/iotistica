import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { BaseMqttClient } from '../base-client.js';
import type { GcpIotProviderConfig } from '../config.js';
import { applyTopicTemplate, parseSourceTopic } from '../topic-mapper.js';

export class GcpIotClient extends BaseMqttClient {
	constructor(
		private readonly config: GcpIotProviderConfig,
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

		if (this.config.ca) {
			options.ca = this.config.ca.replace(/\\n/g, '\n');
		}

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
