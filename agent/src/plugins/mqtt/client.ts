import * as mqtt from "mqtt";
import { agentTopic } from "../../mqtt/topics.js";
import { type DeviceDataPoint, type IProtocolClient, type Logger } from "../types.js";
import { type MqttAdapterConfig } from "./types.js";

export interface MqttBrokerClientHandlers {
	onConnect?(client: mqtt.MqttClient, connack: mqtt.IConnackPacket, firstConnect: boolean): void;
	onError?(error: Error): void;
	onOffline?(): void;
	onReconnect?(attempt: number, nextReconnectDelayMs: number): void;
	onClose?(): void;
	onMessage?(topic: string, payload: Buffer, retain: boolean): void;
}

/**
 * MQTT broker runtime client.
 *
 * Owns mqtt.js lifecycle and reconnection policy. The adapter orchestrates
 * subscriptions and payload mapping on top of this client.
 */
export class MqttBrokerClient implements IProtocolClient<void, DeviceDataPoint[]> {
	private readonly config: MqttAdapterConfig;
	private readonly logger: Logger;
	private readonly deviceUuid: string;
	private readonly handlers: MqttBrokerClientHandlers;
	private client: mqtt.MqttClient | null = null;
	private connected = false;
	private firstConnect = true;
	private reconnectAttemptCount = 0;
	private currentReconnectPeriod = 0;
	private brokerStatusTopic: string | null = null;

	constructor(
		config: MqttAdapterConfig,
		logger: Logger,
		deviceUuid: string,
		handlers: MqttBrokerClientHandlers = {}
	) {
		this.config = config;
		this.logger = logger;
		this.deviceUuid = deviceUuid;
		this.handlers = handlers;
		this.currentReconnectPeriod = this.getBaseReconnectPeriod();
	}

	getRawClient(): mqtt.MqttClient | null {
		return this.client;
	}

	getBrokerStatusTopic(): string | null {
		return this.brokerStatusTopic;
	}

	isConnected(): boolean {
		return this.connected;
	}

	async read(): Promise<DeviceDataPoint[]> {
		return [];
	}

	async connect(): Promise<void> {
		const brokerUrl = `mqtt://${this.config.broker.host}:${this.config.broker.port}`;
		const stableClientId = this.resolveStableClientId();
		this.brokerStatusTopic = this.resolveBrokerStatusTopic();

		if (this.client) {
			this.client.removeAllListeners();
			this.client.end(true);
			this.client = null;
		}

		this.client = mqtt.connect(brokerUrl, {
			clientId: stableClientId,
			username: this.config.broker.username,
			password: this.config.broker.password,
			reconnectPeriod: this.currentReconnectPeriod,
			clean: false,
			keepalive: 30,
			...(this.brokerStatusTopic
				? {
					will: {
						topic: this.brokerStatusTopic,
						payload: Buffer.from("offline"),
						qos: 1,
						retain: true,
					},
				}
				: {}),
		});

		this.client.on("connect", (connack) => {
			this.connected = true;
			this.resetReconnectBackoff();
			this.handlers.onConnect?.(this.client!, connack, this.firstConnect);
			this.firstConnect = false;
		});

		this.client.on("error", (err) => {
			this.handlers.onError?.(err);
		});

		this.client.on("offline", () => {
			this.connected = false;
			this.handlers.onOffline?.();
		});

		this.client.on("reconnect", () => {
			const nextReconnectDelayMs = this.scheduleNextReconnectBackoff();
			this.handlers.onReconnect?.(this.reconnectAttemptCount, nextReconnectDelayMs);
		});

		this.client.on("close", () => {
			this.connected = false;
			this.handlers.onClose?.();
		});

		this.client.on("message", (topic, payload, packet) => {
			this.handlers.onMessage?.(topic, payload, packet.retain);
		});
	}

	async disconnect(): Promise<void> {
		if (!this.client) {
			return;
		}

		const client = this.client;
		client.removeAllListeners();
		await new Promise<void>((resolve) => {
			client.end(false, () => resolve());
		});

		this.client = null;
		this.connected = false;
		this.firstConnect = true;
	}

	private resolveStableClientId(): string {
		if (this.deviceUuid.toLowerCase() !== "unknown") {
			return `agent-${this.deviceUuid}`;
		}

		throw new Error(
			"MQTT clientId requires a valid device UUID to derive agent-<deviceUuid>."
		);
	}

	private getBaseReconnectPeriod(): number {
		const configured = Number(this.config.reconnect.period);
		return Number.isFinite(configured) ? Math.max(0, configured) : 0;
	}

	private getReconnectStrategy(): "fixed" | "exponential" {
		return this.config.reconnect.strategy === "exponential"
			? "exponential"
			: "fixed";
	}

	private getMaxReconnectPeriod(): number {
		const base = this.getBaseReconnectPeriod();
		const configured = Number(this.config.reconnect.maxPeriod);
		if (!Number.isFinite(configured)) {
			return base;
		}
		return Math.max(base, configured);
	}

	private getReconnectJitterRatio(): number {
		const configured = Number(this.config.reconnect.jitterRatio);
		if (!Number.isFinite(configured)) {
			return 0;
		}
		return Math.min(1, Math.max(0, configured));
	}

	private applyReconnectPeriod(periodMs: number): void {
		this.currentReconnectPeriod = periodMs;
		if (this.client) {
			(this.client.options as any).reconnectPeriod = periodMs;
		}
	}

	private computeReconnectPeriod(attempt: number): number {
		const base = this.getBaseReconnectPeriod();
		if (this.getReconnectStrategy() === "fixed") {
			return base;
		}

		const maxPeriod = this.getMaxReconnectPeriod();
		const exponentialDelay = Math.min(maxPeriod, base * 2 ** Math.max(0, attempt - 1));
		const jitterRatio = this.getReconnectJitterRatio();

		if (jitterRatio === 0) {
			return exponentialDelay;
		}

		const lowerBound = exponentialDelay * (1 - jitterRatio);
		const upperBound = exponentialDelay * (1 + jitterRatio);
		return Math.round(lowerBound + Math.random() * (upperBound - lowerBound));
	}

	private resetReconnectBackoff(): void {
		this.reconnectAttemptCount = 0;
		this.applyReconnectPeriod(this.getBaseReconnectPeriod());
	}

	private scheduleNextReconnectBackoff(): number {
		this.reconnectAttemptCount += 1;
		const nextPeriod = this.computeReconnectPeriod(this.reconnectAttemptCount);
		this.applyReconnectPeriod(nextPeriod);
		return nextPeriod;
	}

	private resolveBrokerStatusTopic(): string | null {
		if (!this.deviceUuid || this.deviceUuid.toLowerCase() === "unknown") {
			return null;
		}

		try {
			return agentTopic(this.deviceUuid, "agent", "broker");
		} catch {
			this.logger.debug("Broker status topic skipped: tenant ID not yet initialized");
			return null;
		}
	}
}
