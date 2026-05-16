import type { MqttConnection } from '../publish/types.js';
import { AwsIotMqttClient } from './aws-iot-client.js';
import { GcpIotMqttClient } from './gcp-iot-client.js';
import { normalizeTarget } from './types.js';
import type { CloudTargetFactoryInput } from './types.js';

export async function createExternalPublishTarget(
	input: CloudTargetFactoryInput,
): Promise<MqttConnection | null> {
	const target = normalizeTarget(input.target || process.env.PUBLISH_TARGET);

	if (target === 'iotistica') {
		return null;
	}

	if (target === 'iothub') {
		const connStr = process.env.AZURE_IOTHUB_CONNECTION_STRING;
		if (!connStr) {
			throw new Error('PUBLISH_TARGET=iothub requires AZURE_IOTHUB_CONNECTION_STRING');
		}

		const { IotHubMqttClient } = await import('./azure-iot-client.js');
		const client = new IotHubMqttClient(connStr, input.logger);
		await client.connect();
		return client;
	}

	if (target === 'aws') {
		const client = AwsIotMqttClient.fromEnv(input.logger);
		await client.connect();
		return client;
	}

	if (target === 'gcp') {
		const client = GcpIotMqttClient.fromEnv(input.logger);
		await client.connect();
		return client;
	}

	return null;
}
