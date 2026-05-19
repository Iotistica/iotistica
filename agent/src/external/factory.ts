import type { AgentLogger } from '../logging/agent-logger.js';
import type { MqttConnection } from '../publish/types.js';
import { PublishConfigLoader } from './config.js';
import type { PublishProviderConfig } from './config.js';
import { AwsIotClient } from './clients/aws-iot.js';
import { AzureIotClient } from './clients/azure-iot.js';
import { GcpIotClient } from './clients/gcp-iot.js';
import type { CloudTargetFactoryInput } from './types.js';
import type { BaseMqttClient } from './base-client.js';

/**
 * Creates the correct client for a given provider config.
 * Add new providers here when extending the set of supported targets.
 */
export class PublishClientFactory {
	public static create(
		config: PublishProviderConfig,
		logger?: AgentLogger,
	): BaseMqttClient {
		switch (config.provider) {
			case 'azure':
				return new AzureIotClient(config, logger);
			case 'aws':
				return new AwsIotClient(config, logger);
			case 'gcp':
				return new GcpIotClient(config, logger);
			default: {
				const _exhaustive: never = config;
				throw new Error(
					`Unsupported publish provider: ${(_exhaustive as PublishProviderConfig).provider}`,
				);
			}
		}
	}
}

/**
 * Top-level entry point used by init/infra.ts.
 * Loads config from env, creates and connects the appropriate client.
 * Returns null when no external target is configured (use Iotistica fallback).
 */
export async function createExternalPublishTarget(
	input: CloudTargetFactoryInput,
): Promise<MqttConnection | null> {
	const loader = new PublishConfigLoader();
	const config = loader.loadFromEnv(input.target);

	if (!config) return null;

	const client: BaseMqttClient = PublishClientFactory.create(config, input.logger);
	await client.connect();
	return client;
}
