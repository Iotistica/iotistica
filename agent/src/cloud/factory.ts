import type { MqttConnection } from '../publish/types.js';
import { AwsIotClient } from './clients/aws-iot.js';
import { GcpIotClient } from './clients/gcp-iot.js';
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

		const { IotHubClient: IotHubClient } = await import('./clients/azure-iot.js');
		const client = new IotHubClient(connStr, input.logger);
		await client.connect();
		return client;
	}

	if (target === 'aws') {
		const client = AwsIotClient.fromEnv(input.logger);
		await client.connect();
		return client;
	}

	if (target === 'gcp') {
		const client = GcpIotClient.fromEnv(input.logger);
		await client.connect();
		return client;
	}

	return null;
}
