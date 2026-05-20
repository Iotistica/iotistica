import type { IClientOptions } from 'mqtt';
import type { AgentLogger } from '../../../logging/agent-logger.js';
import { BaseMqttClient } from '../base-client.js';
import type { ExternalMqttProviderConfig } from '../config.js';
import { applyTopicTemplate, parseSourceTopic } from '../topic-mapper.js';

export class ExternalMqttClient extends BaseMqttClient {
	constructor(
		private readonly config: ExternalMqttProviderConfig,
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

		if (this.config.path) {
			options.path = this.config.path;
		}

		if (this.config.ca) {
			options.ca = this.config.ca.replace(/\\n/g, '\n');
		}

		if (this.config.cert) {
			options.cert = this.config.cert.replace(/\\n/g, '\n');
		}

		if (this.config.key) {
			options.key = this.config.key.replace(/\\n/g, '\n');
		}

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
