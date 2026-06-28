import { BaseProtocolAdapter } from "../base.js";
import type * as mqtt from "mqtt";
import * as mqttPattern from "mqtt-pattern";
import { type DeviceDataPoint, type IDeviceStatus, type Logger } from "../types.js";
import { type MqttAdapterConfig, type MqttDevice, type MqttMetricConfig } from "./types.js";
import { parsePayload, coerceType } from "./payload.js";
import { agentTopic } from "../../mqtt/topics.js";
import { EndpointModel } from "../../db/models/endpoint.model.js";
import { DeviceModel } from "../../db/models/device.model.js";
import { MqttBrokerClient } from "./client.js";

/**
 * MQTT Adapter
 *
 * Architecture: This adapter is socket-agnostic. It subscribes to MQTT topics
 * from external publishers (ESP32, PLCs, IoT devices) publishing to the local
 * Mosquitto broker and emits 'data' events with device readings. The parent
 * AdapterManager manages SocketServer and routes data to the appropriate socket.
 *
 * Pattern: Mosquitto broker acts as the ENDPOINT (data aggregation point),
 *          just like a Modbus gateway or OPC-UA server.
 *
 * Events:
 * - 'started': Adapter started successfully
 * - 'stopped': Adapter stopped
 * - 'data': Emitted with deviceDataPoint[] when data is collected
 * - 'device-connected': Emitted when broker connects
 * - 'device-disconnected': Emitted when broker disconnects
 * - 'device-error': Emitted when an error occurs
 */
export class MqttAdapter extends BaseProtocolAdapter {
	private static readonly MAX_QUEUE_DEPTH = 1000; // Max buffered data batches
	private static readonly MAX_PAYLOAD_BYTES = 1 * 1024 * 1024; // 1MB max payload (edge-safe default)

	private config: MqttAdapterConfig;
	private client: mqtt.MqttClient | null = null;
	private subscriptions: Map<string, MqttDevice> = new Map();
	private connected = false;
	private emitQueue: DeviceDataPoint[][] = [];
	private processingEmitQueue = false;
	private droppedMessageCount = 0;
	private reconnectAttemptCount = 0;
	private compiledMetrics = new Map<
		string,
		Array<MqttMetricConfig & { path: string[] }>
	>();
	private compiledTimestampFields = new Map<string, string[]>();
	private lwtDeviceIdToName = new Map<string, string>();
	private brokerStatusTopic: string | null = null;
	private deviceUuid: string | null = null;
	private brokerClient: MqttBrokerClient;
	// Optional human-readable labels keyed by topic (resolve via subscriptions map at publish time)
	private displayNamesByTopic = new Map<string, string>();

	constructor(config: MqttAdapterConfig, logger: Logger, deviceUuid?: string) {
		super([], logger);
		this.config = config;
		this.deviceUuid = deviceUuid?.trim() || null;
		if (!this.deviceUuid || this.deviceUuid.toLowerCase() === "unknown") {
			throw new Error(
				"MQTT clientId requires a valid device UUID to derive agent-<deviceUuid>.",
			);
		}
		const runtimeDeviceUuid = this.deviceUuid;
		this.brokerClient = new MqttBrokerClient(this.config, this.logger, runtimeDeviceUuid, {
			onConnect: (client, connack, firstConnect) => {
				this.client = client;
				this.connected = true;
				this.emit("device-connected", "mqtt-broker");

				this.brokerStatusTopic = this.brokerClient.getBrokerStatusTopic();
				void this.publishBrokerStatus("online");

				this.subscribeToStatusTopic().catch((err) => {
					this.logger.warn(
						`Failed to subscribe to broker status topic: ${err.message}`,
					);
				});

				if (!connack.sessionPresent) {
					this.logger.warn(
						"MQTT session not present, subscribing all configured topics",
						{
							firstConnect,
							risk: firstConnect
								? "No broker-side session yet; messages published before the first successful subscribe are not recoverable."
								: "Persistent session was lost; messages published while the adapter was disconnected may have been dropped by the broker.",
						},
					);
				} else if (firstConnect) {
					this.logger.debug(
						"Connected with existing persistent session (sessionPresent=true)",
					);
				} else {
					this.logger.debug("Reconnected - refreshing subscriptions");
				}

				this.subscribeAllConfiguredDevices().catch((err) => {
					this.logger.error(
						`Failed to subscribe configured topics after connect: ${err.message}`,
					);
				});
			},
			onError: (err) => {
				this.logger.error(`MQTT client error: ${err.message}`);
				this.emit("device-error", "mqtt-broker", err);
			},
			onOffline: () => {
				this.connected = false;
				this.logger.warn("MQTT broker offline");
				this.emit("device-disconnected", "mqtt-broker");
			},
			onReconnect: (attempt, nextReconnectDelayMs) => {
				this.reconnectAttemptCount = attempt;
				this.logger.debug("MQTT reconnecting to broker", {
					attempt,
					nextReconnectDelayMs,
				});
			},
			onClose: () => {
				this.connected = false;
				this.logger.debug("MQTT connection closed");
			},
			onMessage: (topic, payload, retain) => {
				if (topic.startsWith("device/") && topic.endsWith("/status")) {
					this.handleLwtStatus(topic, payload, retain);
					return;
				}
				this.handleMessage(topic, payload, retain);
			},
		});

		for (const device of this.config.devices) {
			if (device.enabled) {
				this.subscriptions.set(device.topic, device);
			}

			// Cache displayName by topic for fast lookup in enqueueData
			if (device.displayName?.trim()) {
				this.displayNamesByTopic.set(device.topic, device.displayName.trim());
			}

			const lwtDeviceId = device.deviceId?.trim();
			if (lwtDeviceId) {
				this.lwtDeviceIdToName.set(lwtDeviceId, device.name);
			}

			if (device.timestampField) {
				this.compiledTimestampFields.set(
					device.name,
					this.compileMetricPath(
						device.timestampField,
						Boolean(device.allowArrayMetrics),
					),
				);
			}

			if (device.metrics && device.metrics.length > 0) {
				this.compiledMetrics.set(
					device.name,
					device.metrics.map((metric) => ({
						...metric,
						path: this.compileMetricPath(
							metric.field,
							Boolean(device.allowArrayMetrics),
						),
					})),
				);
			}
		}

		this.initializeMqttDeviceStatuses();
	}

	private compileMetricPath(
		field: string,
		allowArrayMetrics: boolean,
	): string[] {
		if (!field) {
			return [];
		}

		const normalized = allowArrayMetrics
			? // Convert bracket numeric indexing only: values[0] -> values.0
			field.replace(/\[(\d+)\]/g, ".$1")
			: field;

		return normalized.split(".").filter(Boolean);
	}

	/**
	 * Start the MQTT adapter - create client and let mqtt.js handle reconnection
	 *
	 * Self-healing architecture:
	 * - Creates client immediately (doesn't wait for connection)
	 * - mqtt.js handles automatic reconnection via reconnectPeriod
	 * - Adapter survives broker downtime at startup
	 * - Connection state tracked via events, not promise resolution
	 *
	 * This makes the adapter resilient in edge environments where:
	 * - Broker may start after agent
	 * - Network may be unavailable at startup
	 * - Transient failures should not kill the adapter
	 */
	async start(): Promise<void> {
		if (this.running) {
			return;
		}

		this.logger.debug("Starting MQTT Adapter...");

		// Create client - let mqtt.js handle connection and reconnection
		await this.brokerClient.connect();

		this.running = true;

		this.emit("started");
	}

	/**
	 * Stop the MQTT adapter
	 */
	async stop(): Promise<void> {
		if (!this.running) {
			return;
		}

		try {
			this.logger.debug("Stopping MQTT Adapter...");

			if (this.client) {
				// Publish graceful offline status so retained state reflects intentional shutdown.
				await this.publishBrokerStatus("offline");

				// Best-effort unsubscribe to avoid stale persistent subscriptions on broker.
				await this.unsubscribeAll();

				await this.brokerClient.disconnect();

				this.client = null;
				this.connected = false;
			}

			this.subscriptions.clear();
			this.emitQueue = [];
			this.processingEmitQueue = false;
			this.running = false;
			// Runtime first-connect flag is managed by MqttBrokerClient.

			this.logger.debug("MQTT Adapter stopped successfully");
			this.emit("stopped");
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Error stopping MQTT Adapter: ${errorMessage}`);
		}
	}

	isRunning(): boolean {
		return this.running;
	}

	/**
	 * Hot-update device subscriptions without reconnecting to the broker.
	 *
	 * Diffs the new device list against the current one by topic and:
	 * - Subscribes to topics for newly added/enabled devices
	 * - Unsubscribes from topics for removed/disabled devices
	 * - Updates all internal maps (subscriptions, compiledMetrics, etc.)
	 * - Updates config.devices so reconnect logic re-subscribes correctly
	 *
	 * If the client is not yet connected the subscription changes will be
	 * picked up automatically on the next 'connect' event because
	 * subscribeAllConfiguredDevices() reads config.devices.
	 */
	async updateDevices(newDevices: MqttDevice[]): Promise<void> {
		const oldTopics = new Set(this.subscriptions.keys());
		const newEnabledDevices = newDevices.filter((d) => d.enabled);
		const newTopics = new Set(newEnabledDevices.map((d) => d.topic));

		// --- Removed devices ---
		const removedTopics = [...oldTopics].filter((t) => !newTopics.has(t));
		for (const topic of removedTopics) {
			const device = this.subscriptions.get(topic);
			if (!device) continue;

			// Unsubscribe from broker (best-effort; client may not be connected)
			if (this.client && this.connected) {
				await new Promise<void>((resolve) => {
					this.client!.unsubscribe(topic, () => resolve());
				});
			}

			this.subscriptions.delete(topic);
			this.deviceStatuses.delete(device.name);
			this.compiledMetrics.delete(device.name);
			this.compiledTimestampFields.delete(device.name);
			this.displayNamesByTopic.delete(topic);

			if (device.deviceId?.trim()) {
				this.lwtDeviceIdToName.delete(device.deviceId.trim());
			}

			this.logger.info(
				`MQTT hot-update: unsubscribed removed device '${device.name}' (${topic})`,
			);
		}

		// --- Added devices ---
		const addedDevices = newEnabledDevices.filter(
			(d) => !oldTopics.has(d.topic),
		);
		for (const device of addedDevices) {
			// Update lookup maps before subscribing so message handler can find the device
			this.subscriptions.set(device.topic, device);

			this.deviceStatuses.set(device.name, {
				deviceName: device.name,
				connected: false,
				lastPoll: null,
				lastSeen: null,
				errorCount: 0,
				lastError: null,
				responseTimeMs: null,
				pollSuccessRate: 0,
				registersUpdated: 0,
				communicationQuality: "offline",
			});

			if (device.displayName?.trim()) {
				this.displayNamesByTopic.set(device.topic, device.displayName.trim());
			}

			if (device.deviceId?.trim()) {
				this.lwtDeviceIdToName.set(device.deviceId.trim(), device.name);
			}

			if (device.timestampField) {
				this.compiledTimestampFields.set(
					device.name,
					this.compileMetricPath(
						device.timestampField,
						Boolean(device.allowArrayMetrics),
					),
				);
			}

			if (device.metrics && device.metrics.length > 0) {
				this.compiledMetrics.set(
					device.name,
					device.metrics.map((metric) => ({
						...metric,
						path: this.compileMetricPath(
							metric.field,
							Boolean(device.allowArrayMetrics),
						),
					})),
				);
			}

			// Subscribe on the live connection if available
			if (this.client && this.connected) {
				try {
					await this.subscribeToDevice(device);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					this.logger.error(
						`MQTT hot-update: failed to subscribe '${device.name}' (${device.topic}): ${msg}`,
					);
				}
			} else {
				this.logger.debug(
					`MQTT hot-update: queued subscription for '${device.name}' (${device.topic}) — will subscribe on next connect`,
				);
			}
		}

		// Sync config.devices so reconnect/subscribeAllConfiguredDevices() is consistent
		this.config = { ...this.config, devices: newDevices };

		if (removedTopics.length > 0 || addedDevices.length > 0) {
			this.logger.info("MQTT hot-update complete", {
				added: addedDevices.length,
				removed: removedTopics.length,
				totalActive: this.subscriptions.size,
			});
		}
	}

	/**
	 * Get status of all devices
	 */
	getDeviceStatuses(): IDeviceStatus[] {
		return Array.from(this.deviceStatuses.values());
	}

	/**
	 * Get status of a specific device
	 */
	getDeviceStatus(deviceName: string): IDeviceStatus | undefined {
		return this.deviceStatuses.get(deviceName);
	}

	private async publishBrokerStatus(
		status: "online" | "offline",
	): Promise<void> {
		if (!this.client || !this.connected || !this.brokerStatusTopic) {
			return;
		}

		await new Promise<void>((resolve, reject) => {
			this.client!.publish(
				this.brokerStatusTopic!,
				Buffer.from(status),
				{ qos: 1, retain: true },
				(err) => {
					if (err) {
						reject(err);
						return;
					}
					resolve();
				},
			);
		}).catch((err) => {
			const message = err instanceof Error ? err.message : String(err);
			this.logger.warn(
				`Failed to publish broker status '${status}': ${message}`,
				{
					topic: this.brokerStatusTopic,
				},
			);
		});
	}

	private async subscribeAllConfiguredDevices(): Promise<void> {
		for (const device of this.config.devices) {
			if (!device.enabled) {
				continue;
			}

			try {
				await this.subscribeToDevice(device);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.logger.error(
					`Failed to subscribe to device topic ${device.topic}: ${message}`,
				);
			}
		}
	}

	private async subscribeToStatusTopic(): Promise<void> {
		if (!this.client || !this.connected) {
			return;
		}

		const statusTopic = "device/+/status";
		await new Promise<void>((resolve, reject) => {
			this.client!.subscribe(statusTopic, { qos: 1 }, (err) => {
				if (err) {
					reject(err);
					return;
				}
				resolve();
			});
		});
	}

	private async unsubscribeAll(): Promise<void> {
		if (!this.client) {
			return;
		}

		const topics = Array.from(this.subscriptions.keys());
		if (topics.length === 0) {
			return;
		}

		try {
			await new Promise<void>((resolve) => {
				this.client!.unsubscribe(topics, () => resolve());
			});
			this.logger.debug(
				`Unsubscribed from ${topics.length} MQTT topics before shutdown`,
			);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.warn(
				`Failed to unsubscribe all MQTT topics during shutdown: ${errorMessage}`,
			);
		}
	}

	/**
	 * Subscribe to a device's topics
	 */
	private async subscribeToDevice(device: MqttDevice): Promise<void> {
		if (!this.client || !this.connected) {
			throw new Error("MQTT client not connected");
		}

		const topic = device.topic;
		const qos = device.qos || this.config.qos;

		if (qos === 0) {
			this.logger.warn(
				"MQTT subscription uses QoS 0; messages published during disconnects may be lost",
				{
					topic,
					deviceName: device.name,
					clientId: this.client.options.clientId,
				},
			);
		}

		return new Promise((resolve, reject) => {
			this.client!.subscribe(topic, { qos }, (err) => {
				if (err) {
					this.logger.error(
						`Failed to subscribe to topic: ${topic} - ${err.message}`,
					);
					reject(err);
					return;
				}

				this.subscriptions.set(topic, device);
				resolve();
			});
		});
	}

	/**
	 * Find device config for incoming topic (supports MQTT wildcards: +, #)
	 * Uses mqtt-pattern library for proper wildcard matching
	 *
	 * Performance Note: O(N) linear search through subscriptions.
	 * Fine for typical deployments (10-100 devices).
	 * For high-scale (1000+ wildcard filters), consider:
	 * - Pre-compile patterns
	 * - Index by first topic segment
	 * - Use trie-based matching
	 */
	private findDeviceForTopic(topic: string): MqttDevice | undefined {
		for (const [filter, device] of this.subscriptions.entries()) {
			if (mqttPattern.matches(filter, topic)) {
				return device;
			}
		}
		return undefined;
	}

	private handleLwtStatus(
		topic: string,
		payload: Buffer,
		retain: boolean,
	): void {
		if (retain) {
			return;
		}

		const deviceId = topic.split("/")[1];
		if (!deviceId) {
			return;
		}

		const deviceName = this.lwtDeviceIdToName.get(deviceId);
		if (!deviceName) {
			this.logger.debug(
				`Ignoring LWT status for unmapped deviceId: ${deviceId}`,
				{ topic },
			);
			return;
		}

		const statusText = payload.toString("utf8").trim().toLowerCase();
		const status = this.deviceStatuses.get(deviceName);
		if (!status) {
			return;
		}

		const now = new Date();
		if (statusText === "online") {
			status.connected = true;
			status.communicationQuality = "good";
			status.lastSeen = now;
			status.lastPoll = now;
			this.logger.debug(`LWT: device online`, { deviceId, deviceName });
		} else if (statusText === "offline") {
			status.connected = false;
			status.communicationQuality = "offline";
			this.logger.debug(`LWT: device offline`, { deviceId, deviceName });
		}
	}

	private enqueueData(points: DeviceDataPoint[], topic: string): void {
		if (this.emitQueue.length >= MqttAdapter.MAX_QUEUE_DEPTH) {
			this.droppedMessageCount++;
			if (this.droppedMessageCount % 100 === 1) {
				this.logger.warn("Dropping MQTT messages due to bounded queue limit", {
					queueDepth: this.emitQueue.length,
					droppedTotal: this.droppedMessageCount,
					maxQueueDepth: MqttAdapter.MAX_QUEUE_DEPTH,
					topic,
				});
			}
			return;
		}

		// Attach resolvedDisplayName if a config override exists for this topic
		const resolvedDisplayName = this.displayNamesByTopic.get(topic);
		const enriched = resolvedDisplayName
			? points.map((p) => ({ ...p, resolvedDisplayName }))
			: points;

		this.emitQueue.push(enriched);
		void this.processEmitQueue();
	}

	private async processEmitQueue(): Promise<void> {
		if (this.processingEmitQueue) {
			return;
		}

		this.processingEmitQueue = true;
		try {
			while (this.emitQueue.length > 0) {
				const points = this.emitQueue.shift();
				if (!points) {
					continue;
				}

				const listeners = this.listeners("data");
				for (const listener of listeners) {
					try {
						await Promise.resolve(listener(points));
					} catch (error) {
						const errorMessage =
							error instanceof Error ? error.message : String(error);
						this.logger.error(`MQTT data listener failed: ${errorMessage}`);
					}
				}

				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		} finally {
			this.processingEmitQueue = false;
		}
	}

	private getFieldFast(payload: any, path: string[]): any {
		let value = payload;
		for (const segment of path) {
			if (value == null) {
				return undefined;
			}
			value = value[segment];
		}
		return value;
	}

	private resolveTimestamp(rawTimestamp: any, fallback: string): string {
		if (rawTimestamp === undefined || rawTimestamp === null) {
			return fallback;
		}

		// Numeric epoch support: seconds or milliseconds
		if (typeof rawTimestamp === "number" && Number.isFinite(rawTimestamp)) {
			const epochMs =
				rawTimestamp < 1_000_000_000_000 ? rawTimestamp * 1000 : rawTimestamp;
			const date = new Date(epochMs);
			return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
		}

		// String support: ISO date or numeric epoch string
		if (typeof rawTimestamp === "string") {
			const trimmed = rawTimestamp.trim();
			if (!trimmed) {
				return fallback;
			}

			const numeric = Number(trimmed);
			if (Number.isFinite(numeric)) {
				const epochMs = numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
				const date = new Date(epochMs);
				return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
			}

			const date = new Date(trimmed);
			return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
		}

		return fallback;
	}

	private resolveIncomingUnit(
		parsed: unknown,
		metric: string,
	): string | undefined {
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const parsedObj = parsed as Record<string, unknown>;

			const units = parsedObj.units;
			if (units && typeof units === "object" && !Array.isArray(units)) {
				const mappedUnit = (units as Record<string, unknown>)[metric];
				if (typeof mappedUnit === "string" && mappedUnit.trim()) {
					return mappedUnit.trim();
				}
			}

			const suffixedUnit = parsedObj[`${metric}_unit`];
			if (typeof suffixedUnit === "string" && suffixedUnit.trim()) {
				return suffixedUnit.trim();
			}

			const payloadName = parsedObj.name;
			const payloadUnit = parsedObj.unit;
			if (
				payloadName === metric &&
				typeof payloadUnit === "string" &&
				payloadUnit.trim()
			) {
				return payloadUnit.trim();
			}
		}

		return undefined;
	}

	private canonicalizeUnit(unit: string | undefined): string | undefined {
		if (!unit) {
			return undefined;
		}

		const trimmed = unit.trim();
		if (!trimmed) {
			return undefined;
		}

		const normalized = trimmed.toLowerCase();
		switch (normalized) {
			case "c":
			case "°c":
			case "degc":
			case "deg_c":
			case "celsius":
				return "C";
			case "f":
			case "°f":
			case "fahrenheit":
				return "F";
			case "k":
			case "kelvin":
				return "K";
			case "pa":
				return "Pa";
			case "kpa":
				return "kPa";
			case "bar":
				return "bar";
			case "mbar":
				return "mbar";
			case "mm/s":
				return "mm/s";
			case "m/s":
				return "m/s";
			case "psi":
				return "psi";
			case "atm":
				return "atm";
			case "%":
			case "percent":
			case "percentage":
				return "%";
			case "ppm":
				return "ppm";
			case "ppb":
				return "ppb";
			case "db":
			case "dba":
				return "dB";
			case "lux":
			case "lx":
				return "lux";
			case "w":
				return "W";
			case "kw":
				return "kW";
			case "kwh":
				return "kWh";
			case "v":
				return "V";
			case "a":
				return "A";
			case "rpm":
				return "RPM";
			default:
				this.logger.warn("Unknown unit encountered", { unit: trimmed });
				return trimmed;
		}
	}

	private resolveUnitDimension(
		unit: string,
	): "temperature" | "pressure" | undefined {
		switch (unit) {
			case "C":
			case "F":
			case "K":
				return "temperature";
			case "Pa":
			case "kPa":
			case "bar":
			case "mbar":
			case "psi":
			case "atm":
				return "pressure";
			default:
				return undefined;
		}
	}

	private convertToBaseUnit(
		value: number,
		unit: string,
		dimension: "temperature" | "pressure",
	): number {
		if (dimension === "temperature") {
			switch (unit) {
				case "K":
					return value;
				case "C":
					return value + 273.15;
				case "F":
					return ((value - 32) * 5) / 9 + 273.15;
			}
		}

		if (dimension === "pressure") {
			switch (unit) {
				case "Pa":
					return value;
				case "kPa":
					return value * 1000;
				case "bar":
					return value * 100000;
				case "mbar":
					return value * 100;
				case "psi":
					return value * 6894.757293168;
				case "atm":
					return value * 101325;
			}
		}

		throw new Error(`Unsupported unit conversion source: ${unit}`);
	}

	private convertFromBaseUnit(
		value: number,
		unit: string,
		dimension: "temperature" | "pressure",
	): number {
		if (dimension === "temperature") {
			switch (unit) {
				case "K":
					return value;
				case "C":
					return value - 273.15;
				case "F":
					return ((value - 273.15) * 9) / 5 + 32;
			}
		}

		if (dimension === "pressure") {
			switch (unit) {
				case "Pa":
					return value;
				case "kPa":
					return value / 1000;
				case "bar":
					return value / 100000;
				case "mbar":
					return value / 100;
				case "psi":
					return value / 6894.757293168;
				case "atm":
					return value / 101325;
			}
		}

		throw new Error(`Unsupported unit conversion target: ${unit}`);
	}

	private convertUnitValue(
		value: number,
		fromUnit: string,
		toUnit: string,
	): number {
		if (fromUnit === toUnit) {
			return value;
		}

		const fromDimension = this.resolveUnitDimension(fromUnit);
		const toDimension = this.resolveUnitDimension(toUnit);

		if (!fromDimension || !toDimension || fromDimension !== toDimension) {
			throw new Error(`Unsupported unit conversion: ${fromUnit} -> ${toUnit}`);
		}

		const baseValue = this.convertToBaseUnit(value, fromUnit, fromDimension);
		return this.convertFromBaseUnit(baseValue, toUnit, toDimension);
	}

	private normalizePrecision(
		precision: number | undefined,
	): number | undefined {
		if (!Number.isFinite(precision)) {
			return undefined;
		}

		return Math.max(0, Math.floor(Number(precision)));
	}

	private roundNumericValue(value: number, precision: number): number {
		const factor = 10 ** precision;
		return Math.round((value + Number.EPSILON) * factor) / factor;
	}

	private normalizeMetricValue(
		rawValue: any,
		type: string,
		incomingUnit: string | undefined,
		canonicalUnit: string | undefined,
		precision: number | undefined,
	): { value: number | boolean | string | null; unit?: string } {
		const value = coerceType(rawValue, type);
		const normalizedIncoming = this.canonicalizeUnit(incomingUnit);
		const normalizedCanonical = this.canonicalizeUnit(canonicalUnit);
		const normalizedPrecision = this.normalizePrecision(precision);

		if (typeof value !== "number" || !Number.isFinite(value)) {
			return {
				value,
				unit: normalizedCanonical ?? normalizedIncoming,
			};
		}

		if (normalizedCanonical) {
			if (!normalizedIncoming || normalizedIncoming === normalizedCanonical) {
				return {
					value:
						normalizedPrecision !== undefined
							? this.roundNumericValue(value, normalizedPrecision)
							: value,
					unit: normalizedCanonical,
				};
			}

			try {
				const convertedValue = this.convertUnitValue(
					value,
					normalizedIncoming,
					normalizedCanonical,
				);
				return {
					value: this.roundNumericValue(
						convertedValue,
						normalizedPrecision ?? 2,
					),
					unit: normalizedCanonical,
				};
			} catch (error) {
				this.logger.warn("Unknown unit conversion, storing raw value", {
					from: normalizedIncoming,
					to: normalizedCanonical,
					error: error instanceof Error ? error.message : String(error),
				});

				return {
					value,
					unit: normalizedIncoming,
				};
			}
		}

		return {
			value:
				normalizedPrecision !== undefined
					? this.roundNumericValue(value, normalizedPrecision)
					: value,
			unit: normalizedIncoming,
		};
	}

	private buildMetricPoint(
		device: MqttDevice,
		metric: string,
		rawValue: any,
		incomingUnit: string | undefined,
		canonicalUnit: string | undefined,
		precision: number | undefined,
		type: string | undefined,
		deviceId: string | undefined,
		topic: string,
		now: string,
		retain: boolean,
	): DeviceDataPoint {
		const normalized = this.normalizeMetricValue(
			rawValue,
			type || device.dataType || "string",
			incomingUnit,
			canonicalUnit,
			precision,
		);

		return {
			deviceName: device.name,
			...(deviceId && { deviceId }),
			metric: metric || topic,
			value: normalized.value,
			...(normalized.unit !== undefined && { unit: normalized.unit }),
			timestamp: now,
			quality: retain ? "UNCERTAIN" : "GOOD",
			...(retain && { qualityCode: "RETAINED_MESSAGE" }),
		};
	}

	private resolveMessageDeviceId(
		device: MqttDevice,
		parsed: unknown,
	): string | undefined {
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const candidate = (parsed as any).deviceId ?? (parsed as any).device_id;
			if (typeof candidate === "string" && candidate.trim()) {
				return candidate.trim();
			}
			if (typeof candidate === "number" && Number.isFinite(candidate)) {
				return String(candidate);
			}
		}

		if (typeof device.deviceId === "string" && device.deviceId.trim()) {
			return device.deviceId.trim();
		}

		return undefined;
	}

	/**
	 * Handle incoming MQTT message
	 *
	 * @param topic - MQTT topic
	 * @param payload - Message payload
	 * @param retain - Retained message flag (true = stale/historical data)
	 */
	private handleMessage(
		topic: string,
		payload: Buffer,
		retain: boolean = false,
	): void {
		// Production fix #8: Max payload size guard
		// Protects against memory exhaustion from malicious/corrupt messages
		if (payload.length > MqttAdapter.MAX_PAYLOAD_BYTES) {
			this.droppedMessageCount++;
			this.logger.warn("Dropping oversized MQTT message", {
				topic,
				payloadSize: payload.length,
				maxAllowed: MqttAdapter.MAX_PAYLOAD_BYTES,
				droppedTotal: this.droppedMessageCount,
				hint: "Possible JSON bomb or malicious payload",
			});
			return;
		}

		// Check if topic matches any configured device
		const device = this.findDeviceForTopic(topic);

		// If no device configured for this topic, ignore
		if (!device) {
			this.logger.debug(`Ignoring message for unconfigured topic: ${topic}`);
			return;
		}

		// Liveness is based on message receipt, not parse success.
		if (!retain) {
			this.trackMessageActivity(device.name);
		}

		try {
			const parsed = parsePayload(payload);
			const now = new Date().toISOString();
			const timestampPath = this.compiledTimestampFields.get(device.name);
			const payloadTimestamp =
				timestampPath && typeof parsed === "object" && parsed !== null
					? this.resolveTimestamp(this.getFieldFast(parsed, timestampPath), now)
					: now;
			const resolvedDeviceId = this.resolveMessageDeviceId(device, parsed);
			const points: DeviceDataPoint[] = [];

			const compiledDeviceMetrics = this.compiledMetrics.get(device.name);
			if (compiledDeviceMetrics && compiledDeviceMetrics.length > 0) {
				if (
					typeof parsed === "object" &&
					parsed !== null &&
					!Array.isArray(parsed)
				) {
					for (const metricConfig of compiledDeviceMetrics) {
						const rawValue = this.getFieldFast(parsed, metricConfig.path);

						if (rawValue === undefined) {
							this.logger.debug(`MQTT metric field not found in payload`, {
								topic,
								deviceName: device.name,
								field: metricConfig.field,
							});
							continue;
						}

						try {
							points.push(
								this.buildMetricPoint(
									device,
									metricConfig.metric,
									rawValue,
									this.resolveIncomingUnit(parsed, metricConfig.metric),
									metricConfig.unit,
									metricConfig.precision,
									metricConfig.type,
									resolvedDeviceId,
									topic,
									payloadTimestamp,
									retain,
								),
							);
						} catch (fieldError) {
							this.logger.warn(
								`Failed to coerce MQTT metric field '${metricConfig.field}'`,
								{
									topic,
									deviceName: device.name,
									metric: metricConfig.metric,
									error:
										fieldError instanceof Error
											? fieldError.message
											: String(fieldError),
								},
							);
						}
					}
				} else {
					this.logger.warn(
						"MQTT multi-metric config requires JSON object payload",
						{
							topic,
							deviceName: device.name,
						},
					);
				}
			}

			if (
				device.autoMetrics &&
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed)
			) {
				for (const [key, rawValue] of Object.entries(parsed)) {
					// Skip nested objects/arrays in auto mode to avoid emitting ambiguous metrics.
					if (rawValue !== null && typeof rawValue === "object") {
						continue;
					}

					try {
						points.push(
							this.buildMetricPoint(
								device,
								key,
								rawValue,
								this.resolveIncomingUnit(parsed, key),
								device.defaultUnits?.[key],
								device.defaultPrecisions?.[key],
								undefined,
								resolvedDeviceId,
								topic,
								payloadTimestamp,
								retain,
							),
						);
					} catch (fieldError) {
						this.logger.warn(
							`Failed to coerce MQTT auto metric field '${key}'`,
							{
								topic,
								deviceName: device.name,
								error:
									fieldError instanceof Error
										? fieldError.message
										: String(fieldError),
							},
						);
					}
				}
			}

			// Default behavior without explicit metric mapping:
			// emit every primitive field from JSON object payloads.
			if (points.length === 0) {
				const singleMetric = device.metric || topic;
				let singleType = device.dataType;
				let singleSource: unknown = parsed;

				if (
					typeof parsed === "object" &&
					parsed !== null &&
					!Array.isArray(parsed)
				) {
					const parsedObj = parsed as Record<string, unknown>;

					if (
						parsedObj.value !== undefined &&
						(parsedObj.value === null || typeof parsedObj.value !== "object")
					) {
						singleSource = parsedObj.value;
					} else {
						const metadataKeys = new Set([
							"timestamp",
							"ts",
							"time",
							"name",
							"unit",
							"deviceId",
							"device_id",
							"device_uuid",
							"topic",
							"units",
						]);

						const primitiveEntries = Object.entries(parsedObj).filter(
							([key, value]) => {
								if (metadataKeys.has(key)) {
									return false;
								}
								if (key.endsWith("_unit")) {
									return false;
								}
								return (
									value === null ||
									["string", "number", "boolean"].includes(typeof value)
								);
							},
						);

						if (primitiveEntries.length > 0) {
							for (const [metricName, metricValue] of primitiveEntries) {
								points.push(
									this.buildMetricPoint(
										device,
										metricName,
										metricValue,
										this.resolveIncomingUnit(parsedObj, metricName),
										device.defaultUnits?.[metricName],
										device.defaultPrecisions?.[metricName],
										undefined,
										resolvedDeviceId,
										topic,
										payloadTimestamp,
										retain,
									),
								);
							}

							this.logger.debug(
								"MQTT emitted primitive fields from object payload",
								{
									topic,
									deviceName: device.name,
									fields: primitiveEntries.map(([key]) => key),
								},
							);
						} else {
							// No scalar field to coerce; preserve payload as JSON text.
							singleSource = JSON.stringify(parsedObj);
							singleType = "json";
						}
					}
				}

				if (points.length === 0) {
					points.push(
						this.buildMetricPoint(
							device,
							singleMetric,
							singleSource,
							this.resolveIncomingUnit(parsed, singleMetric),
							device.unit,
							device.precision,
							singleType,
							resolvedDeviceId,
							topic,
							payloadTimestamp,
							retain,
						),
					);
				}
			}

			// Emit data through bounded queue for real backpressure handling.
			this.enqueueData(points, topic);

			if (retain) {
				this.logger.debug(
					`Retained message ignored for device health tracking`,
					{
						topic,
						deviceName: device.name,
					},
				);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			this.logger.error(
				`Failed to parse MQTT message from topic ${topic}: ${errorMessage}`,
			);

			// Emit BAD quality data point
			const dataPoint: DeviceDataPoint = {
				deviceName: device.name,
				metric: device.metric || topic,
				value: null,
				...(device.unit !== undefined && { unit: device.unit }),
				timestamp: new Date().toISOString(),
				quality: "BAD",
				qualityCode: "PARSE_ERROR",
			};

			this.enqueueData([dataPoint], topic);
		}
	}

	/**
	 * Initialize device statuses
	 *
	 * Note: MQTT devices don't have persistent connections like Modbus/OPC-UA.
	 * Connection state should be inferred from:
	 * - lastSeen timestamp (message recency)
	 * - Last Will and Testament (LWT) messages
	 * - Application-specific staleness thresholds
	 */
	private initializeMqttDeviceStatuses(): void {
		for (const device of this.config.devices) {
			this.deviceStatuses.set(device.name, {
				deviceName: device.name,
				connected: false, // MQTT: Use LWT or staleness logic to determine this
				lastPoll: null,
				lastSeen: null,
				errorCount: 0,
				lastError: null,
				responseTimeMs: null,
				pollSuccessRate: 0,
				registersUpdated: 0,
				communicationQuality: "offline",
			});
		}
	}

	/**
	 * Track message activity (not connection state)
	 *
	 * For MQTT devices:
	 * - Message arrival ≠ device connected
	 * - Devices may publish once per hour and sleep
	 * - "Connected" state should be inferred from lastSeen + staleness threshold
	 * - Use Last Will and Testament (LWT) for definitive offline detection
	 */
	private trackMessageActivity(deviceName: string): void {
		const status = this.deviceStatuses.get(deviceName);
		if (!status) {
			return;
		}

		const now = new Date();
		status.lastSeen = now;
		status.lastPoll = now;
		status.registersUpdated = (status.registersUpdated || 0) + 1;
		status.communicationQuality = "good";

		// Persist lastSeen to DB so stale-device checks don't flag MQTT endpoints as null
		EndpointModel.updateLastSeenByName(deviceName).catch((err: Error) => {
			this.logger.warn(
				`Failed to update lastSeen for ${deviceName}: ${err.message}`,
			);
		});
		DeviceModel.updateLastSeenByEndpointName(deviceName).catch((err: Error) => {
			this.logger.warn(
				`Failed to update device lastSeenAt for ${deviceName}: ${err.message}`,
			);
		});

		// Note: Don't set connected=true here
		// Let higher-level logic decide connectivity based on:
		// - Time since lastSeen (staleness)
		// - LWT messages
		// - Application requirements
	}
}
