/**
 * Protocol adapter manager.
 */

import { EventEmitter } from "events";
import { type AgentLogger } from "../logging/agent-logger.js";
import { ModbusAdapter } from "./modbus/adapter.js";
import { type ModbusAdapterConfig } from "./modbus/types.js";
import { MqttAdapter } from "./mqtt/adapter.js";
import { type MqttAdapterConfig } from "./mqtt/types.js";
import { SocketServer } from "../core/socket-server.js";
import {
	type DeviceDataPoint,
	type ExternalPluginConfig,
	type IProtocolAdapter,
	type ProtocolAdapterStarter,
	type SocketOutput,
} from "./types.js";
import { PluginLoader } from "./plugin-loader.js";
import { EndpointOutputModel } from "../db/models/endpoint-outputs.model.js";
import { EndpointModel } from "../db/models/endpoint.model.js";
import { DeviceModel } from "../db/models/device.model.js";
import { encodeIfUuid } from "../mqtt/codec.js";

// Type-only import.
import type { OPCUAAdapterConfig } from "./opcua/types.js";
import { BACnetAdapter } from "./bacnet/adapter.js";
import { type BACnetAdapterConfig } from "./bacnet/types.js";

export interface AdapterConfig {
	modbus?: { enabled: boolean; config?: ModbusAdapterConfig };
	can?: { enabled: boolean };
	opcua?: { enabled: boolean; config?: OPCUAAdapterConfig };
	snmp?: { enabled: boolean };
	mqtt?: { enabled: boolean; config?: MqttAdapterConfig };
	bacnet?: { enabled: boolean; config?: BACnetAdapterConfig };
	plugins?: ExternalPluginConfig[];
}

export class AdapterManager extends EventEmitter {
	private adapters: Map<string, IProtocolAdapter> = new Map();
	private socketServers: Map<string, SocketServer> = new Map();
	private adapterStarters: Map<string, ProtocolAdapterStarter> = new Map();
	private protocolEnabledOverrides: Map<string, boolean> = new Map();
	// Shared endpoint UUID lookup for MQTT hot-reloads.
	private mqttEndpointUuidByName: Map<string, string> = new Map();
	private config: AdapterConfig;
	private deviceUuid: string;
	private running = false;
	private pluginsLoaded = false;
	private readonly pluginLoader: PluginLoader;
	private readonly logger: {
		info(m: string): void;
		warn(m: string): void;
		error(m: string, ...a: any[]): void;
		debug(m: string, ...a: any[]): void;
	};

	private normalizeDisplayBaseName(value: string): string {
		return value.replace(/^(?:iotistica_){2,}/i, "iotistica_");
	}

	private enrichWithEndpointUuid(
		dataPoints: DeviceDataPoint[],
		endpointUuidByName: Map<string, string>,
	): DeviceDataPoint[] {
		if (endpointUuidByName.size === 0 || dataPoints.length === 0) {
			return dataPoints;
		}

		return dataPoints.map((point) => {
			const endpointUuid = endpointUuidByName.get(point.deviceName);
			if (!endpointUuid) {
				return point;
			}

			// Prefer source-provided device_uuid; otherwise use endpoint UUID.
			const device_uuid = point.device_uuid || endpointUuid;

			// Build a stable display name suffix with device UUID.
			const displayBase = this.normalizeDisplayBaseName(point.resolvedDisplayName || point.deviceName);
			const uuidSuffix = device_uuid.replace(/-/g, "").slice(0, 8);
			const deviceName =
				uuidSuffix.length === 8 ? `${displayBase}-${uuidSuffix}` : displayBase;

			this.logger.debug("Built endpoint deviceName", {
				displayBase,
				device_uuid,
				endpointUuid,
				finalDeviceName: deviceName,
			});

			return {
				...point,
				deviceName,
				endpoint_uuid: endpointUuid,
				device_uuid,
			};
		});
	}

	/** Build a device-name to endpoint-UUID map. */
	private buildUuidMap(devices: any[]): Map<string, string> {
		const map = new Map<string, string>();
		for (const device of devices) {
			const endpointUuid =
				(typeof device.uuid === "string" && device.uuid.trim()) ||
				(typeof device.metadata?.uuid === "string" &&
					device.metadata.uuid.trim()) ||
				(typeof device.metadata?.device_uuid === "string" &&
					device.metadata.device_uuid.trim());
			if (endpointUuid && typeof device.name === "string") {
				map.set(device.name, endpointUuid);
			}
		}
		return map;
	}

	/** Load output config and start a protocol socket server. */
	private async createSocketServer(protocol: string): Promise<SocketServer> {
		const dbOutput = await EndpointOutputModel.getOutput(protocol);
		if (!dbOutput)
			throw new Error(`${protocol} output configuration not found in database`);
		const outputConfig: SocketOutput = {
			socketPath: dbOutput.socket_path,
			dataFormat: dbOutput.data_format as "json" | "csv",
			delimiter: dbOutput.delimiter,
			includeTimestamp: dbOutput.include_timestamp,
			includeDeviceName: dbOutput.include_device_name,
		};
		const socket = new SocketServer(outputConfig, this.logger);
		await socket.start();
		this.socketServers.set(protocol, socket);
		return socket;
	}

	/** Wire standard adapter events. */
	private wireAdapterEvents(
		protocol: string,
		adapter: IProtocolAdapter,
		socket: SocketServer,
		uuidMap: Map<string, string>,
	): void {
		const label = protocol.toUpperCase();
		adapter.on("started", () => this.logger.info(`${label} adapter started`));
		adapter.on("data", (dps: DeviceDataPoint[]) => {
			socket.sendData(this.enrichWithEndpointUuid(dps, uuidMap), protocol);
			// Stamp lastSeenAt on every data arrival for both endpoint and device tables.
			// This keeps health status fresh regardless of which protocol emits data.
			const names = [...new Set(dps.map((dp) => dp.deviceName).filter(Boolean))];
			for (const name of names) {
				EndpointModel.updateLastSeenByName(name).catch(() => {});
				DeviceModel.updateLastSeenByEndpointName(name).catch(() => {});
			}
		});
		adapter.on("device-connected", (name: string) =>
			this.logger.info(`${label} device connected: ${name}`),
		);
		adapter.on("device-disconnected", (name: string) =>
			this.logger.warn(`${label} device disconnected: ${name}`),
		);
		adapter.on("device-error", (name: string, err: Error | string) =>
			this.logger.error(
				`${label} device error [${name}]: ${err instanceof Error ? err.message : err}`,
			),
		);
	}

	constructor(
		config: AdapterConfig,
		agentLogger: AgentLogger,
		deviceUuid: string,
	) {
		super();
		this.config = config;
		this.deviceUuid = deviceUuid;
		this.logger = {
			info: (m) => agentLogger.infoSync(m, { component: "Adapters" }),
			warn: (m) => agentLogger.warnSync(m, { component: "Adapters" }),
			error: (m, ...a) =>
				agentLogger.errorSync(m, a[0] instanceof Error ? a[0] : undefined, {
					component: "Adapters",
				}),
			debug: (m, ...a) => {
				if (process.env.PROTOCOL_ADAPTERS_DEBUG === "true")
					agentLogger.debugSync(m, { component: "Adapters", args: a });
			},
		};
		this.pluginLoader = new PluginLoader(agentLogger);
		this.registerBuiltInProtocolStarters();
	}

	private registerBuiltInProtocolStarters(): void {
		this.registerProtocolStarter("modbus", () => this.startModbusAdapter());
		this.registerProtocolStarter("opcua", () => this.startOPCUAAdapter());
		this.registerProtocolStarter("mqtt", () => this.startMQTTAdapter());
		this.registerProtocolStarter("bacnet", () => this.startBACnetAdapter());
	}

	private isProtocolEnabled(protocol: string): boolean {
		switch (protocol) {
			case "modbus":
				return Boolean(this.config.modbus?.enabled);
			case "opcua":
				return Boolean(this.config.opcua?.enabled);
			case "mqtt":
				return Boolean(this.config.mqtt?.enabled);
			case "bacnet":
				return Boolean(this.config.bacnet?.enabled);
			case "can":
				return Boolean(this.config.can?.enabled);
			case "snmp":
				return Boolean(this.config.snmp?.enabled);
			default:
				if (this.protocolEnabledOverrides.has(protocol)) {
					return Boolean(this.protocolEnabledOverrides.get(protocol));
				}
				return this.adapterStarters.has(protocol);
		}
	}

	public registerProtocolStarter(
		protocol: string,
		starter: ProtocolAdapterStarter,
		enabled: boolean = true,
	): void {
		const normalizedProtocol = protocol.toLowerCase();
		this.adapterStarters.set(normalizedProtocol, starter);
		this.protocolEnabledOverrides.set(normalizedProtocol, enabled);
	}

	public async attachAdapter(
		groupName: string,
		adapter: IProtocolAdapter,
		uuidMap: Map<string, string> = new Map(),
	): Promise<void> {
		const normalizedGroup = groupName.toLowerCase();
		// Extract protocol from groupName if it contains a dash (e.g., "warehouse-modbus" -> "modbus")
		const protocol = normalizedGroup.includes('-') 
			? normalizedGroup.split('-').pop()?.toLowerCase() || normalizedGroup
			: normalizedGroup;
		
		const socket = await this.createSocketServer(protocol);
		this.adapters.set(normalizedGroup, adapter);
		this.wireAdapterEvents(normalizedGroup, adapter, socket, uuidMap);
		await adapter.start();
	}

	public buildEndpointUuidMap(devices: any[]): Map<string, string> {
		return this.buildUuidMap(devices);
	}

	/** Determine effective group name: use explicit groupName or default to protocol. */
	private getEffectiveGroupName(protocol: string, groupName?: string): string {
		if (groupName?.trim()) {
			return groupName.toLowerCase();
		}
		return protocol.toLowerCase();
	}

	private async ensureExternalPluginStartersRegistered(): Promise<void> {
		if (this.pluginsLoaded) {
			return;
		}

		await this.pluginLoader.registerFromConfig(this, this.config.plugins);
		this.pluginsLoaded = true;
	}

	/** Start all enabled protocol adapters, supporting multi-instance groups. */
	async start(): Promise<void> {
		if (this.running) return;

		await this.ensureExternalPluginStartersRegistered();

		// Load endpoints from DB and group by (protocol, groupName)
		const allEndpoints = await EndpointModel.getAll();
		const groupsByProtocol = new Map<string, Map<string, any[]>>();
		
		for (const endpoint of allEndpoints) {
			if (!groupsByProtocol.has(endpoint.protocol)) {
				groupsByProtocol.set(endpoint.protocol, new Map());
			}
			const groupName = this.getEffectiveGroupName(endpoint.protocol, endpoint.groupName);
			const protocolGroups = groupsByProtocol.get(endpoint.protocol)!;
			if (!protocolGroups.has(groupName)) {
				protocolGroups.set(groupName, []);
			}
			protocolGroups.get(groupName)!.push(endpoint);
		}

		// Start adapters for each (protocol, groupName) combination
		const builtInOrder = ["modbus", "opcua", "mqtt", "bacnet", "can", "snmp"];
		const customOrder = [...this.adapterStarters.keys()].filter(
			(protocol) => !builtInOrder.includes(protocol),
		);
		const startOrder = [...builtInOrder, ...customOrder];
		
		for (const protocol of startOrder) {
			if (!this.isProtocolEnabled(protocol)) {
				continue;
			}

			const starter = this.adapterStarters.get(protocol);
			if (!starter) {
				this.logger.warn(`${protocol.toUpperCase()} adapter not yet implemented`);
				continue;
			}

			// If endpoints exist for this protocol, start them per group
			const protocolGroups = groupsByProtocol.get(protocol);
			if (protocolGroups && protocolGroups.size > 0) {
				for (const [groupName, endpoints] of protocolGroups) {
					if (endpoints.length > 0) {
						await this.startAdapterGroup(protocol, groupName, endpoints);
					}
				}
			} else if (this.config[protocol as keyof AdapterConfig] && 
						(this.config[protocol as keyof AdapterConfig] as any)?.config) {
				// Fall back to config-based startup if no DB endpoints
				await starter();
			}
		}

		this.running = true;
		this.emit("started");
	}

	/** Start adapter for a specific (protocol, groupName) combination. */
	private async startAdapterGroup(
		protocol: string,
		groupName: string,
		endpoints: any[],
	): Promise<void> {
		try {
			this.logger.info(`Starting ${protocol.toUpperCase()} adapter group: ${groupName}`);
			
			switch (protocol.toLowerCase()) {
				case 'modbus':
					await this.startModbusAdapterGroup(groupName, endpoints);
					break;
				case 'opcua':
					await this.startOPCUAAdapterGroup(groupName, endpoints);
					break;
				case 'bacnet':
					await this.startBACnetAdapterGroup(groupName, endpoints);
					break;
				case 'mqtt':
					await this.startMQTTAdapterGroup(groupName, endpoints);
					break;
				default:
					this.logger.warn(`No group handler for protocol: ${protocol}`);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start ${protocol.toUpperCase()} adapter group ${groupName}: ${errorMessage}`);
			// Non-fatal: one broken adapter group must not prevent other adapters or health reporting from working.
		}
	}

	/** Stop all running adapters and socket servers. */
	async stop(): Promise<void> {
		if (!this.running) return;
		for (const [, adapter] of this.adapters) {
			if (adapter && typeof adapter.stop === "function") await adapter.stop();
		}
		this.adapters.clear();
		for (const [, server] of this.socketServers) await server.stop();
		this.socketServers.clear();
		this.running = false;
		this.emit("stopped");
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Start Modbus adapter. */
	private async startModbusAdapter(): Promise<void> {
		try {
			let modbusConfig: ModbusAdapterConfig;

			if (this.config.modbus?.config) {
				modbusConfig = this.config.modbus.config;
			} else {
				const dbDevices = await EndpointModel.getEnabled("modbus");
				modbusConfig = {
					devices: dbDevices.map(
						(d) =>
							({
								uuid: d.uuid,
								name: d.name,
								enabled: d.enabled,
								slaveId: d.connection.slaveId || 1,
								connection: d.connection as any,
								pollInterval: d.poll_interval,
								registers: (d.data_points || []).map((dp: any) => {
									let functionCode = dp.functionCode;
									if (!functionCode && dp.type) {
										const typeMap: Record<string, number> = {
											coil: 1,
											discrete: 2,
											holding: 3,
											input: 4,
										};
										functionCode = typeMap[dp.type.toLowerCase()];
									}
									return {
										...dp,
										functionCode,
										dataType: dp.dataType || "float32",
										count:
											dp.count ||
											(dp.dataType === "float32" ||
											dp.dataType === "int32" ||
											dp.dataType === "uint32"
												? 2
												: 1),
										scale: dp.scale !== undefined ? dp.scale : 1,
										offset: dp.offset !== undefined ? dp.offset : 0,
									};
								}),
							}) as any,
					),
					logging: { level: "info", enableConsole: false, enableFile: false },
				};
			}

			const uuidMap = this.buildUuidMap(modbusConfig.devices);
			const socket = await this.createSocketServer("modbus");
			const adapter = new ModbusAdapter(modbusConfig, this.logger);
			this.adapters.set("modbus", adapter);
			(adapter as any)._socketServer = socket;
			this.wireAdapterEvents("modbus", adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start Modbus adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start Modbus adapter group for a specific groupName. */
	private async startModbusAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const modbusConfig: ModbusAdapterConfig = {
				devices: endpoints.map(
					(d) =>
						({
							uuid: d.uuid,
							name: d.name,
							enabled: d.enabled,
							slaveId: d.connection.slaveId || 1,
							connection: d.connection,
							pollInterval: d.poll_interval,
							registers: (d.data_points || []).map((dp: any) => {
								let functionCode = dp.functionCode;
								if (!functionCode && dp.type) {
									const typeMap: Record<string, number> = {
										coil: 1,
										discrete: 2,
										holding: 3,
										input: 4,
									};
									functionCode = typeMap[dp.type.toLowerCase()];
								}
								return {
									...dp,
									functionCode,
									dataType: dp.dataType || "float32",
									count:
										dp.count ||
										(dp.dataType === "float32" ||
										dp.dataType === "int32" ||
										dp.dataType === "uint32"
											? 2
											: 1),
									scale: dp.scale !== undefined ? dp.scale : 1,
									offset: dp.offset !== undefined ? dp.offset : 0,
								};
							}),
						}) as any,
				),
				logging: { level: "info", enableConsole: false, enableFile: false },
			};

			const uuidMap = this.buildUuidMap(modbusConfig.devices);
			const socket = await this.createSocketServer("modbus");
			const adapter = new ModbusAdapter(modbusConfig, this.logger);
			this.adapters.set(groupName, adapter);
			(adapter as any)._socketServer = socket;
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start Modbus adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}
	private async startOPCUAAdapter(): Promise<void> {
		try {
			let opcuaDevices: any[];

			if (this.config.opcua?.config) {
				opcuaDevices = this.config.opcua.config.devices;
			} else {
				const dbDevices = await EndpointModel.getEnabled("opcua");
				opcuaDevices = dbDevices.map((d) => ({
					uuid: d.uuid,
					name: d.name,
					protocol: "opcua",
					enabled: d.enabled,
					connection: d.connection,
					pollInterval: d.poll_interval,
					dataPoints: (d.data_points || []).map((dp: any) => ({
						...dp,
						dataType: dp.dataType || "number",
						scalingFactor: dp.scalingFactor || dp.scale || 1,
						offset: dp.offset || 0,
					})),
					metadata: d.metadata || {},
				}));
			}

			const uuidMap = this.buildUuidMap(opcuaDevices);
			const socket = await this.createSocketServer("opcua");
			const { OPCUAAdapter } = await import("./opcua/adapter.js");
			const adapter = new OPCUAAdapter(opcuaDevices, this.logger);
			this.adapters.set("opcua", adapter);
			this.wireAdapterEvents("opcua", adapter, socket, uuidMap);
			adapter.on(
				"rediscovery-needed",
				(data: { deviceName: string; endpointUrl: string }) => {
					this.logger.warn(
						`OPC-UA adapter requesting rediscovery for ${data.deviceName} (high NodeID failure rate, endpointUrl: ${data.endpointUrl})`,
					);
					this.emit("rediscovery-needed", data);
				},
			);
			await adapter.start();
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start OPC-UA adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start OPC UA adapter group for a specific groupName. */
	private async startOPCUAAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const opcuaDevices = endpoints.map((d) => ({
				uuid: d.uuid,
				name: d.name,
				enabled: d.enabled,
				connection: d.connection,
				pollInterval: d.poll_interval,
				dataPoints: (d.data_points || []).map((dp: any) => ({
					...dp,
					dataType: dp.dataType || "number",
					scalingFactor: dp.scalingFactor || dp.scale || 1,
					offset: dp.offset || 0,
				})),
				metadata: d.metadata || {},
			})) as any as OPCUAAdapterConfig['devices'];

			const uuidMap = this.buildUuidMap(endpoints);
			const socket = await this.createSocketServer("opcua");
			const { OPCUAAdapter } = await import("./opcua/adapter.js");
			const adapter = new OPCUAAdapter(opcuaDevices, this.logger);
			this.adapters.set(groupName, adapter);
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			adapter.on(
				"rediscovery-needed",
				(data: { deviceName: string; endpointUrl: string }) => {
					this.logger.warn(
						`OPC-UA adapter group ${groupName} requesting rediscovery for ${data.deviceName} (high NodeID failure rate, endpointUrl: ${data.endpointUrl})`,
					);
					this.emit("rediscovery-needed", data);
				},
			);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start OPC-UA adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}

	/** Start MQTT adapter, or hot-reload devices if already running. */
	private async startMQTTAdapter(): Promise<void> {
		try {
			let mqttConfig: MqttAdapterConfig;

			if (this.config.mqtt?.config) {
				mqttConfig = this.config.mqtt.config;
			} else {
				const dbDevices = await EndpointModel.getEnabled("mqtt");
				const brokerUrl = process.env.MQTT_BROKER_URL;
				if (!brokerUrl)
					throw new Error(
						"MQTT_BROKER_URL is required for MQTT adapter startup",
					);
				let brokerHost: string;
				let brokerPort: number;
				try {
					const url = new URL(brokerUrl);
					brokerHost = url.hostname;
					brokerPort = parseInt(url.port) || 1883;
				} catch (error) {
					throw new Error(
						`Failed to parse MQTT broker URL '${brokerUrl}': ${error}`,
					);
				}
				mqttConfig = {
					broker: {
						host: brokerHost,
						port: brokerPort,
						username: process.env.MQTT_USERNAME,
						password: process.env.MQTT_PASSWORD,
					},
					qos: 1,
					reconnect: {
						period: 1000,
						maxAttempts: 10,
						strategy: "fixed",
						maxPeriod: 1000,
						jitterRatio: 0,
					},
					devices: dbDevices.map((d) => ({
						uuid: d.uuid,
						name: d.name,
						enabled: d.enabled,
						topic: d.connection.topic
							? `${d.connection.topic}/#`
							: encodeIfUuid(d.name),
						qos: d.connection.qos || 1,
						dataType: d.connection.dataType || "float32",
						unit: d.connection.unit,
						precision: Number.isFinite((d.connection as any).precision)
							? Number((d.connection as any).precision)
							: undefined,
						metric: d.connection.metric,
						deviceId: d.connection.deviceId,
						timestampField: d.connection.timestampField,
						metrics: Array.isArray((d.connection as any).metrics)
							? (d.connection as any).metrics.map((metric: any) => ({
								field: metric.field,
								metric: metric.metric,
								unit: metric.unit,
								type: metric.type,
								precision: Number.isFinite(metric.precision)
									? Number(metric.precision)
									: undefined,
							}))
							: undefined,
						autoMetrics: Boolean((d.connection as any).autoMetrics),
						defaultUnits:
							(d.connection as any).defaultUnits &&
							typeof (d.connection as any).defaultUnits === "object"
								? Object.entries((d.connection as any).defaultUnits).reduce<
										Record<string, string>
									>((acc, [key, value]) => {
										if (
											typeof key === "string" &&
											key.trim() &&
											typeof value === "string" &&
											value.trim()
										)
											acc[key] = value;
										return acc;
									}, {})
								: undefined,
						defaultPrecisions:
							(d.connection as any).defaultPrecisions &&
							typeof (d.connection as any).defaultPrecisions === "object"
								? Object.entries(
									(d.connection as any).defaultPrecisions,
								).reduce<Record<string, number>>((acc, [key, value]) => {
									if (
										typeof key === "string" &&
											key.trim() &&
											Number.isFinite(value)
									)
										acc[key] = Number(value);
									return acc;
								}, {})
								: undefined,
						allowArrayMetrics: Boolean((d.connection as any).allowArrayMetrics),
					})),
					logging: { level: "info", enableConsole: false, enableFile: false },
				};
			}

			// Rebuild class-level UUID map in place for hot-reload event handlers.
			const newMap = this.buildUuidMap(mqttConfig.devices);
			this.mqttEndpointUuidByName.clear();
			newMap.forEach((v, k) => this.mqttEndpointUuidByName.set(k, v));

			// Hot-update subscriptions without reconnecting.
			const existingAdapter = this.adapters.get("mqtt") as
				| MqttAdapter
				| undefined;
			if (existingAdapter) {
				this.logger.info(
					"MQTT adapter already running — applying hot device update",
				);
				await existingAdapter.updateDevices(mqttConfig.devices);
				return;
			}

			const socket = await this.createSocketServer("mqtt");
			const adapter = new MqttAdapter(
				mqttConfig,
				this.logger,
				this.deviceUuid,
			);
			this.adapters.set("mqtt", adapter);
			// Use class map so handlers always see latest UUID mappings.
			this.wireAdapterEvents(
				"mqtt",
				adapter,
				socket,
				this.mqttEndpointUuidByName,
			);
			await adapter.start();
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start MQTT adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start MQTT adapter group for a specific groupName. */
	private async startMQTTAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const brokerUrl = process.env.MQTT_BROKER_URL;
			if (!brokerUrl)
				throw new Error("MQTT_BROKER_URL is required for MQTT adapter startup");

			let brokerHost: string;
			let brokerPort: number;
			try {
				const url = new URL(brokerUrl);
				brokerHost = url.hostname;
				brokerPort = parseInt(url.port) || 1883;
			} catch (error) {
				throw new Error(`Failed to parse MQTT broker URL '${brokerUrl}': ${error}`);
			}

			const mqttConfig: MqttAdapterConfig = {
				broker: {
					host: brokerHost,
					port: brokerPort,
					username: process.env.MQTT_USERNAME,
					password: process.env.MQTT_PASSWORD,
				},
				qos: 1,
				reconnect: {
					period: 1000,
					maxAttempts: 10,
					strategy: "fixed",
					maxPeriod: 1000,
					jitterRatio: 0,
				},
				devices: endpoints.map((d) => ({
					name: d.name,
					enabled: d.enabled,
					topic: d.connection.topic || "#",
					qos: (d.connection.qos || 1) as 0 | 1 | 2,
					dataType: d.connection.dataType || "json",
					metric: d.connection.metric || d.name,
				})),
			};

			const uuidMap = this.buildUuidMap(endpoints);
			const socket = await this.createSocketServer("mqtt");
			const adapter = new MqttAdapter(mqttConfig, this.logger, this.deviceUuid);
			this.adapters.set(groupName, adapter);
			(adapter as any)._socketServer = socket;
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start MQTT adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}

	/** Hot-reload MQTT adapter devices without disconnecting. */
	async reloadMQTTAdapter(): Promise<void> {
		if (this.config.mqtt?.enabled) {
			await this.startMQTTAdapter();
		}
	}

	/** Get endpoint health across configured devices and running adapters. */
	async getAllDeviceStatuses(): Promise<Record<string, any>> {
		const health: Record<string, any> = {};

		this.logger.debug(
			`getAllDeviceStatuses called - adapters.size: ${this.adapters.size}, keys: [${Array.from(this.adapters.keys()).join(", ")}]`,
		);

		// Load all configured and discovered devices from the database.
		try {
			const allDevices = await EndpointModel.getAll();
			const stalenessThresholdMs = 24 * 60 * 60 * 1000; // 24 hours

			this.logger.debug(`Found ${allDevices.length} devices in database`);

			// Build baseline health from database state.
			for (const device of allDevices) {
				// Determine online/offline from lastSeenAt.
				const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
				const now = Date.now();
				const isOnline =
					lastSeen && now - lastSeen.getTime() < stalenessThresholdMs;

				// SQLite stores booleans as 0/1.
				const isEnabled = Boolean(device.enabled);

				health[device.name] = {
					protocol: device.protocol,
					status: !isEnabled ? "disabled" : isOnline ? "online" : "offline",
					connected: isEnabled && isOnline,
					lastPoll: null,
					lastSeen: lastSeen?.toISOString() || null,
					errorCount: 0,
					lastError: null,
					responseTimeMs: null,
					pollSuccessRate: isEnabled && isOnline ? 1.0 : 0,
					registersUpdated: 0,
					communicationQuality: !isEnabled
						? ("disabled" as const)
						: isOnline
							? ("good" as const)
							: ("offline" as const),
				};
			}

			// Overlay runtime adapter status when available.
			for (const [protocol, adapter] of this.adapters) {
				if (adapter && typeof adapter.getDeviceStatuses === "function") {
					try {
						const statuses = adapter.getDeviceStatuses();

						this.logger.debug(
							`Adapter ${protocol} returned ${statuses?.length || 0} device statuses`,
						);

						// Update health with runtime data from adapter
						if (Array.isArray(statuses)) {
							for (const device of statuses) {
								if (health[device.deviceName]) {
									// Derive effective runtime status from fresh timestamps.
									const now = Date.now();
									const runtimeLastSeenMs = device.lastSeen
										? new Date(device.lastSeen).getTime()
										: null;
									const runtimeLastPollMs = device.lastPoll
										? new Date(device.lastPoll).getTime()
										: null;
									const hasFreshRuntimeSignal = Boolean(
										(runtimeLastSeenMs &&
											now - runtimeLastSeenMs < stalenessThresholdMs) ||
											(runtimeLastPollMs &&
												now - runtimeLastPollMs < stalenessThresholdMs),
									);

									const isEnabled =
										health[device.deviceName].status !== "disabled";
									const explicitlyOffline =
										device.communicationQuality === "offline";
									// Derive connectivity from activity, not adapter connected flag.
									const runtimeOnline = Boolean(
										hasFreshRuntimeSignal && !explicitlyOffline,
									);
									const effectiveStatus = !isEnabled
										? "disabled"
										: runtimeOnline
											? "online"
											: health[device.deviceName].status;

									health[device.deviceName] = {
										protocol,
										status: effectiveStatus,
										connected: isEnabled && runtimeOnline,
										lastPoll: device.lastPoll?.toISOString() || null,
										lastSeen: device.lastSeen?.toISOString() || null,
										errorCount: device.errorCount,
										lastError: device.lastError,
										responseTimeMs: device.responseTimeMs,
										pollSuccessRate: device.pollSuccessRate,
										registersUpdated: device.registersUpdated,
										communicationQuality: device.communicationQuality,
									};
								}
							}
						}
					} catch (error) {
						this.logger.warn(
							`Failed to get device statuses from ${protocol} adapter: ${error}`,
						);
					}
				}
			}
		} catch (error) {
			this.logger.error(`Failed to get devices from database: ${error}`);
		}

		return health;
	}

	/** Start BACnet adapter. */
	private async startBACnetAdapter(): Promise<void> {
		try {
			let bacnetConfig: BACnetAdapterConfig;

			if (this.config.bacnet?.config) {
				bacnetConfig = this.config.bacnet.config;
			} else {
				const dbDevices = await EndpointModel.getEnabled("bacnet");
				if (dbDevices.length === 0) {
					this.logger.info(
						"BACnet ADAPTER: No BACnet devices in database - skipping adapter start",
					);
					return;
				}
				this.logger.info(
					`BACnet ADAPTER: Found ${dbDevices.length} BACnet devices in database`,
				);
				bacnetConfig = {
					enabled: true,
					port: (this.config.bacnet as any)?.port || 47809,
					devices: dbDevices.map((d) => ({
						uuid: d.uuid,
						name: d.name,
						enabled: d.enabled,
						ipAddress: d.connection.ipAddress || d.connection.host,
						port: d.connection.port || 47808,
						deviceInstance: d.connection.deviceInstance || 0,
						pollIntervalMs: d.poll_interval || 5000,
						maxConcurrentReads: d.connection.maxConcurrentReads || 5,
						connectionTimeoutMs: d.connection.connectionTimeoutMs || 5000,
						retryAttempts: d.connection.retryAttempts || 3,
						retryDelayMs: d.connection.retryDelayMs || 1000,
						objects: (d.data_points || [])
							.filter((obj: any) => [
								'analog-input', 'analog-output', 'analog-value',
								'binary-input', 'binary-output', 'binary-value',
								'multi-state-input', 'multi-state-output', 'multi-state-value',
							].includes(obj.objectType))
							.map((obj: any) => ({
								name: obj.name,
								objectType: obj.objectType,
								objectInstance: obj.objectInstance,
								propertyId: obj.propertyId || 85,
								unit: obj.unit || obj.units || "",
								pollIntervalMs: obj.pollIntervalMs || 5000,
								enabled: obj.enabled !== false,
							})),
					})),
					globalPollIntervalMs:
						(this.config.bacnet as any)?.globalPollIntervalMs || 5000,
					maxConcurrentDevices:
						(this.config.bacnet as any)?.maxConcurrentDevices || 10,
				};
			}

			const uuidMap = this.buildUuidMap(bacnetConfig.devices);
			const socket = await this.createSocketServer("bacnet");
			const adapter = new BACnetAdapter(bacnetConfig, this.logger);
			this.adapters.set("bacnet", adapter);
			this.wireAdapterEvents("bacnet", adapter, socket, uuidMap);
			await adapter.start();
			this.logger.info(
				`BACnet adapter started with ${bacnetConfig.devices.length} device(s)`,
			);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start BACnet adapter: ${errorMessage}`);
			throw error;
		}
	}

	/** Start BACnet adapter group for a specific groupName. */
	private async startBACnetAdapterGroup(groupName: string, endpoints: any[]): Promise<void> {
		try {
			const bacnetConfig = {
				enabled: true,
				port: (this.config.bacnet as any)?.port || 47809,
				globalPollIntervalMs: (this.config.bacnet as any)?.globalPollIntervalMs || 5000,
				devices: endpoints.map((d) => ({
					name: d.name,
					ipAddress: d.connection.ipAddress || d.connection.host,
					port: d.connection.port || 47808,
					deviceInstance: d.connection.deviceId || d.connection.deviceInstance || 0,
					enabled: d.enabled,
					objects: (d.data_points || [])
						.filter((dp: any) => [
							'analog-input', 'analog-output', 'analog-value',
							'binary-input', 'binary-output', 'binary-value',
							'multi-state-input', 'multi-state-output', 'multi-state-value',
						].includes(dp.objectType))
						.map((dp: any) => ({
							name: dp.name || dp.objectName,
							objectType: dp.objectType,
							objectInstance: dp.objectInstance,
							propertyId: dp.propertyId || 85,
							unit: dp.unit || dp.units || '',
							pollIntervalMs: dp.pollIntervalMs || 5000,
							enabled: dp.enabled !== false,
						})),
					pollIntervalMs: d.poll_interval || 5000,
					maxConcurrentReads: d.connection.maxConcurrentReads || 5,
					connectionTimeoutMs: d.connection.timeout || 5000,
					retryAttempts: d.connection.retryCount || 3,
					retryDelayMs: d.connection.retryDelayMs || 1000,
				})),
				maxConcurrentDevices: (this.config.bacnet as any)?.maxConcurrentDevices || 10,
			};

			const uuidMap = this.buildUuidMap(endpoints);
			const socket = await this.createSocketServer("bacnet");
			const adapter = new BACnetAdapter(bacnetConfig, this.logger);
			this.adapters.set(groupName, adapter);
			this.wireAdapterEvents(groupName, adapter, socket, uuidMap);
			await adapter.start();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.logger.error(`Failed to start BACnet adapter group ${groupName}: ${errorMessage}`);
			throw error;
		}
	}

	/** Get adapter by groupName (group-based lookup). */
	getAdapterGroup(groupName: string): IProtocolAdapter | undefined {
		return this.adapters.get(groupName.toLowerCase());
	}

	/** Get adapter by protocol (backward compatible - returns first adapter for protocol). */
	getAdapter(protocol: string): IProtocolAdapter | undefined {
		const normalized = protocol.toLowerCase();
		// First, try direct protocol name (backward compatibility)
		if (this.adapters.has(normalized)) {
			return this.adapters.get(normalized);
		}
		// If not found, search for any adapter whose groupName ends with the protocol
		for (const [groupName, adapter] of this.adapters) {
			if (groupName.endsWith(`-${normalized}`) || groupName === normalized) {
				return adapter;
			}
		}
		return undefined;
	}

	/** Get all running adapters. */
	getAllAdapters(): Map<string, IProtocolAdapter> {
		return new Map(this.adapters);
	}
}
