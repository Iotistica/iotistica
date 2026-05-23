import type { AgentLogger } from '../../logging/agent-logger.js';
import type { MqttConnection } from './types.js';
import { normalizeTarget } from './types.js';
import { AwsPublishPlugin } from '../plugins/aws.js';
import { AzurePublishPlugin } from '../plugins/azure.js';
import { GcpPublishPlugin } from '../plugins/gcp.js';
import { MqttPublishPlugin } from '../plugins/mqtt.js';

export interface ExternalPublishTargetInput {
	target?: string;
	logger?: AgentLogger;
	deviceUuid?: string;
}

export function createExternalPublishClient(
	input: ExternalPublishTargetInput,
): MqttConnection | null {
	const target = normalizeTarget(input.target);
	if (target === 'iotistica') {
		return null;
	}

	switch (target) {
		case 'azure': {
			return AzurePublishPlugin.createClientFromEnv(input.logger);
		}
		case 'aws': {
			return AwsPublishPlugin.createClientFromEnv(input.logger);
		}
		case 'gcp': {
			return GcpPublishPlugin.createClientFromEnv(input.logger);
		}
		case 'mqtt': {
			return MqttPublishPlugin.createClientFromEnv(input.logger, input.deviceUuid);
		}
		default:
			return null;
	}
}

export async function createExternalPublishTarget(
	input: ExternalPublishTargetInput,
): Promise<MqttConnection | null> {
	const client = createExternalPublishClient(input);
	if (!client) {
		return null;
	}

	await client.connect?.();
	return client;
}
