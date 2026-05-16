import { EventEmitter } from 'events';
import mqtt from 'mqtt';
import type { IClientOptions, MqttClient } from 'mqtt';
import type { AgentLogger } from '../../logging/agent-logger.js';
import { LogComponents } from '../../logging/types.js';
import type { MqttConnection, PublishMode } from '../../publish/types.js';
import { applyTopicTemplate, parseSourceTopic } from '../topic-mapper.js';

interface GcpMqttConfig {
	endpoint: string;
	clientId: string;
	username: string;
	password?: string;
	port: number;
	topicTemplate: string;
	ca?: string;
}

export class GcpIotClient extends EventEmitter implements MqttConnection {
	private client: MqttClient | null = null;
	private connected = false;
	private readonly maxPublishRetries = 3;

	constructor(
		private readonly config: GcpMqttConfig,
		private readonly logger?: AgentLogger,
	) {
		super();
	}

	public static fromEnv(logger?: AgentLogger): GcpIotClient {
		const endpoint = process.env.GCP_MQTT_ENDPOINT || '';
		if (!endpoint) {
			throw new Error('Missing GCP_MQTT_ENDPOINT for GCP publish target');
		}

		const clientId =
			process.env.GCP_MQTT_CLIENT_ID || process.env.DEVICE_UUID || process.env.DEVICE_ID || 'device';

		const config: GcpMqttConfig = {
			endpoint,
			clientId,
			username: process.env.GCP_MQTT_USERNAME || 'unused',
			password: process.env.GCP_MQTT_JWT || process.env.GCP_MQTT_PASSWORD,
			port: Number(process.env.GCP_MQTT_PORT || 8883),
			topicTemplate:
				process.env.GCP_MQTT_PUBLISH_TOPIC_TEMPLATE ||
				'/devices/{deviceId}/events/{endpoint}',
			ca: process.env.GCP_MQTT_CA_CERT,
		};

		return new GcpIotClient(config, logger);
	}

	public async connect(): Promise<void> {
		const options: IClientOptions = {
			host: this.config.endpoint,
			port: this.config.port,
			protocol: 'mqtts',
			clientId: this.config.clientId,
			username: this.config.username,
			password: this.config.password,
			rejectUnauthorized: true,
			keepalive: 60,
			clean: true,
			reconnectPeriod: 5000,
			connectTimeout: 30000,
		};

		if (this.config.ca) {
			options.ca = this.config.ca.replace(/\\n/g, '\n');
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
				this.logger?.errorSync('GCP MQTT client error', err instanceof Error ? err : new Error(String(err)), {
					component: LogComponents.agent,
					endpoint: this.config.endpoint,
					clientId: this.config.clientId,
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

		this.logger?.infoSync('GCP MQTT connected', {
			component: LogComponents.agent,
			endpoint: this.config.endpoint,
			clientId: this.config.clientId,
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
			throw new Error('GcpIotMqttClient: not connected');
		}

		const parsed = parseSourceTopic(topic);
		const targetTopic = applyTopicTemplate(this.config.topicTemplate, {
			deviceId: this.config.clientId,
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

		throw lastError || new Error('GCP publish failed after retries');
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
