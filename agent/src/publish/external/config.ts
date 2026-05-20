/** Typed external publish provider config and environment-based loader. */

export type AwsIotAuth =
	| { type: 'mtls'; ca?: string; cert: string; key: string }
	| { type: 'websocket-sigv4'; accessKey: string; secretKey: string };

export type AzureIotAuth = {
	type: 'sas';
	sharedAccessKey: string;
	tokenTtlSeconds?: number;
};

export type GcpIotAuth = {
	type: 'jwt';
	jwt?: string;
	password?: string;
};

export interface BaseProviderConfig {
	provider: 'aws' | 'azure' | 'gcp' | 'mqtt';
	enabled: boolean;
	qos?: 0 | 1 | 2;
	topicTemplate?: string;
}

export interface ExternalMqttProviderConfig extends BaseProviderConfig {
	provider: 'mqtt';
	host: string;
	port: number;
	protocol: 'mqtt' | 'mqtts' | 'ws' | 'wss';
	path?: string;
	clientId: string;
	username?: string;
	password?: string;
	ca?: string;
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
}

export interface AwsIotProviderConfig extends BaseProviderConfig {
	provider: 'aws';
	endpoint: string;
	port: number;
	deviceId: string;
	auth: AwsIotAuth;
}

export interface AzureIotProviderConfig extends BaseProviderConfig {
	provider: 'azure';
	hostName: string;
	deviceId: string;
	auth: AzureIotAuth;
}

export interface GcpIotProviderConfig extends BaseProviderConfig {
	provider: 'gcp';
	endpoint: string;
	port: number;
	clientId: string;
	username: string;
	auth: GcpIotAuth;
	ca?: string;
}

export type PublishProviderConfig =
	| AwsIotProviderConfig
	| AzureIotProviderConfig
	| GcpIotProviderConfig
	| ExternalMqttProviderConfig;

interface ParsedAzureConnStr {
	hostName: string;
	deviceId: string;
	sharedAccessKey: string;
}

function parseAzureConnectionString(connStr: string): ParsedAzureConnStr | null {
	const parts: Record<string, string> = {};
	for (const segment of connStr.split(';')) {
		const eq = segment.indexOf('=');
		if (eq === -1) continue;
		parts[segment.slice(0, eq)] = segment.slice(eq + 1);
	}
	const { HostName: hostName, DeviceId: deviceId, SharedAccessKey: sharedAccessKey } = parts;
	if (!hostName || !deviceId || !sharedAccessKey) return null;
	return { hostName, deviceId, sharedAccessKey };
}

export class PublishConfigLoader {
	public loadFromEnv(targetOverride?: string): PublishProviderConfig | null {
		const raw = (targetOverride || process.env.PUBLISH_TARGET || '').trim().toLowerCase();

		if (raw === 'azure') return this._loadAzure();
		if (raw === 'aws' || raw === 'awsiot' || raw === 'aws-iot') return this._loadAws();
		if (raw === 'gcp' || raw === 'google' || raw === 'google-cloud') return this._loadGcp();
		if (raw === 'mqtt' || raw === 'external-mqtt' || raw === 'generic-mqtt') return this._loadMqtt();

		return null;
	}

	private _loadMqtt(): ExternalMqttProviderConfig {
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

		const protocol = scheme as ExternalMqttProviderConfig['protocol'];
		const defaultPort = protocol === 'mqtts' ? 8883 : protocol === 'mqtt' ? 1883 : protocol === 'wss' ? 443 : 80;
		const envReject = process.env.EXTERNAL_MQTT_REJECT_UNAUTHORIZED;
		const rejectUnauthorized =
			envReject === undefined
				? true
				: !['0', 'false', 'no', 'off'].includes(envReject.trim().toLowerCase());

		return {
			provider: 'mqtt',
			enabled: true,
			host: parsedUrl.hostname,
			port: parsedUrl.port ? Number(parsedUrl.port) : defaultPort,
			protocol,
			path: parsedUrl.pathname && parsedUrl.pathname !== '/' ? parsedUrl.pathname : undefined,
			clientId:
				process.env.EXTERNAL_MQTT_CLIENT_ID ||
				process.env.DEVICE_UUID ||
				process.env.DEVICE_ID ||
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

	private _loadAzure(): AzureIotProviderConfig {
		const connStr = process.env.AZURE_IOTHUB_CONNECTION_STRING || '';
		if (!connStr) {
			throw new Error('PUBLISH_TARGET=azure requires AZURE_IOTHUB_CONNECTION_STRING');
		}

		const parsed = parseAzureConnectionString(connStr);
		if (!parsed) {
			throw new Error(
				'Invalid AZURE_IOTHUB_CONNECTION_STRING. ' +
				'Expected: HostName=...;DeviceId=...;SharedAccessKey=...',
			);
		}

		return {
			provider: 'azure',
			enabled: true,
			hostName: parsed.hostName,
			deviceId: parsed.deviceId,
			auth: {
				type: 'sas',
				sharedAccessKey: parsed.sharedAccessKey,
				tokenTtlSeconds: process.env.AZURE_SAS_TOKEN_TTL_SECONDS
					? Number(process.env.AZURE_SAS_TOKEN_TTL_SECONDS)
					: undefined,
			},
		};
	}

	private _loadAws(): AwsIotProviderConfig {
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
			enabled: true,
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

	private _loadGcp(): GcpIotProviderConfig {
		const endpoint = process.env.GCP_MQTT_ENDPOINT || '';
		if (!endpoint) {
			throw new Error('PUBLISH_TARGET=gcp requires GCP_MQTT_ENDPOINT');
		}

		return {
			provider: 'gcp',
			enabled: true,
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
}
