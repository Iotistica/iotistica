import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import type { MqttConnection, PublishMode } from '../../publish/types.js';
import { applyTopicTemplate, parseSourceTopic } from '../topic-mapper.js';

interface AwsIotConfig {
	endpoint: string;
	deviceId: string;
	port: number;
	topicTemplate: string;
	ca?: string;
	cert?: string;
	key?: string;
}

export class AwsIotClient extends EventEmitter implements MqttConnection {
	private client: MqttClient | null = null;
	private connected = false;
	private readonly maxPublishRetries = 3;

	constructor(
		private readonly config: AwsIotConfig,
		private readonly logger?: AgentLogger,
	) {
		super();
	}

	public static fromEnv(logger?: AgentLogger): AwsIotClient {
		const endpoint = process.env.AWS_IOT_ENDPOINT || '';
		if (!endpoint) {
			throw new Error('Missing AWS_IOT_ENDPOINT for AWS publish target');
		}

		const deviceId = process.env.AWS_IOT_DEVICE_ID || process.env.DEVICE_UUID || process.env.DEVICE_ID || 'device';
		const port = Number(process.env.AWS_IOT_PORT || 8883);
		const topicTemplate =
			process.env.AWS_IOT_PUBLISH_TOPIC_TEMPLATE ||
			'devices/{deviceId}/messages/events/{endpoint}';

		const config: AwsIotConfig = {
			endpoint,
			deviceId,
			port,
			topicTemplate,
			ca: process.env.AWS_IOT_CA_CERT,
			cert: process.env.AWS_IOT_CLIENT_CERT,
			key: process.env.AWS_IOT_PRIVATE_KEY,
		};

		return new AwsIotClient(config, logger);
	}

	public async connect(): Promise<void> {
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

		if (this.config.ca) {
			options.ca = this.config.ca.replace(/\\n/g, '\n');
		}
		if (this.config.cert) {
			options.cert = this.config.cert.replace(/\\n/g, '\n');
		}
		if (this.config.key) {
			options.key = this.config.key.replace(/\\n/g, '\n');
		}

		await new Promise<void>((resolve, reject) => {
			const client = mqtt.connect(options as any);

			const onConnect = () => {
				this.client = client;
				this.connected = true;
				client.removeListener('error', onError);
				this.emit('connect');
				resolve();
			};

			const onError = (err: Error) => {
				client.removeListener('connect', onConnect);
				reject(err);
			};

			client.once('connect', onConnect);
			client.once('error', onError);

			client.on('error', (err) => {
				this.logger?.errorSync('AWS IoT MQTT client error', err instanceof Error ? err : new Error(String(err)), {
					component: LogComponents.agent,
					endpoint: this.config.endpoint,
					deviceId: this.config.deviceId,
				});
				this.emit('error', err);
			});

			client.on('disconnect', () => {
				this.connected = false;
				this.emit('disconnect');
			});
			client.on('offline', () => {
				this.connected = false;
			});
		});

		this.logger?.infoSync('AWS IoT MQTT connected', {
			component: LogComponents.agent,
			endpoint: this.config.endpoint,
			deviceId: this.config.deviceId,
		});
	}

	public async disconnect(): Promise<void> {
		if (!this.client) return;
		await new Promise<void>((resolve) => this.client!.end(false, {}, () => resolve()));
		this.client = null;
		this.connected = false;
		this.emit('disconnect');
	}

	public async publish(
		topic: string,
		payload: string | Buffer,
		options?: { qos?: 0 | 1 | 2 },
	): Promise<void> {
		if (!this.client || !this.connected) {
			throw new Error('AwsIotMqttClient: not connected');
		}

		const parsed = parseSourceTopic(topic);
		const targetTopic = applyTopicTemplate(this.config.topicTemplate, {
			deviceId: this.config.deviceId,
			endpoint: parsed.endpoint,
			topic: parsed.originalTopic,
		});

		let lastError: Error | null = null;
		for (let attempt = 0; attempt < this.maxPublishRetries; attempt++) {
			try {
				await new Promise<void>((resolve, reject) => {
					this.client!.publish(targetTopic, payload, { qos: options?.qos ?? 1 }, (err) =>
						err ? reject(err) : resolve(),
					);
				});
				return;
			} catch (error) {
				const asError = error instanceof Error ? error : new Error(String(error));
				lastError = asError;
				if (attempt === this.maxPublishRetries - 1) {
					throw asError;
				}
				await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 1000)));
			}
		}

		throw lastError || new Error('AWS IoT publish failed after retries');
	}

	public isConnected(): boolean {
		return this.connected;
	}

	public getPublishMode(): PublishMode {
		return this.connected ? 'direct' : 'buffer-only';
	}

	public getMessageIdGenerator(): undefined {
		return undefined;
	}
}
