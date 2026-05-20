import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';
import type { MqttDiscoveryOptions } from '../plugins/mqtt/discovery.js';
import type { ConfigManager } from '../core/config.js';

/**
 * Builds protocol-specific discovery options from environment variables / ConfigManager.
 * Returns undefined for a protocol when no configuration is present (signals: skip that protocol).
 */
export class DiscoveryOptionsBuilder {
	constructor(
    private configManager?: ConfigManager,
    private logger?: AgentLogger
	) {}

	build(protocol: string): any {
		switch (protocol) {
			case 'modbus': return this.modbus();
			case 'opcua':  return this.opcua();
			case 'mqtt':   return this.mqtt();
			case 'bacnet': return this.bacnet();
			default:       return undefined;
		}
	}

	private modbus(): any {
		if (!this.configManager) return undefined;
		// Return empty object - plugin queries getDiscoveryTargets() for dynamic targets
		return {};
	}

	private opcua(): any {
		if (!this.configManager) return undefined;
		// Plugin primarily queries getDiscoveryTargets() from DB/state.
		// Also pass optional discovery URLs from env for no-endpoint bootstrap flows.
		const discoveryUrls = process.env.OPCUA_DISCOVERY_URLS?.split(',')
			.map((url) => url.trim())
			.filter(Boolean);

		return {
			...(discoveryUrls && discoveryUrls.length > 0 && { discoveryUrls })
		};
	}


	private mqtt(): MqttDiscoveryOptions | undefined {
		if (this.configManager) {
			const config = this.configManager.getMqttConfig();
			if (!config.enabled || !config.brokerUrl) return undefined;

			const options: MqttDiscoveryOptions = { brokerUrl: config.brokerUrl, topics: [] };
			if (config.username)                    options.username = config.username;
			if (config.password)                    options.password = config.password;
			if (config.discoveryRoots?.length)      options.topics = config.discoveryRoots;
			if (config.monitorDurationMs)           options.samplingDurationMs = config.monitorDurationMs;
			if (config.qos !== undefined)           options.qos = config.qos;
			return options;
		}

		// Legacy: direct env var reads (backward compatibility)
		const brokerUrl = process.env.MQTT_BROKER_URL;
		if (!brokerUrl) return undefined;

		const options: MqttDiscoveryOptions = { brokerUrl, topics: [] };
		if (process.env.MQTT_USERNAME) options.username = process.env.MQTT_USERNAME;
		if (process.env.MQTT_PASSWORD) options.password = process.env.MQTT_PASSWORD;

		if (process.env.MQTT_DISCOVERY_ROOTS) {
			try {
				options.topics = JSON.parse(process.env.MQTT_DISCOVERY_ROOTS);
			} catch (err) {
				this.logger?.warnSync(
					`Failed to parse MQTT_DISCOVERY_ROOTS - expected JSON array: ${(err as Error).message}`,
					{ component: LogComponents.discovery }
				);
			}
		}
		if (process.env.MQTT_DISCOVERY_DURATION_MS) {
			options.samplingDurationMs = parseInt(process.env.MQTT_DISCOVERY_DURATION_MS, 10);
		}
		if (process.env.MQTT_DISCOVERY_QOS) {
			options.qos = parseInt(process.env.MQTT_DISCOVERY_QOS, 10) as 0 | 1 | 2;
		}
		return options;
	}

	private bacnet(): any {
		if (!this.configManager) return undefined;
		const config = this.configManager.getBACnetConfig();
		if (!config.enabled) return undefined;
		return {
			...(config.discoveryTargets?.length && { discoveryTargets: config.discoveryTargets }),
			...(config.broadcastAddress && { broadcastAddress: config.broadcastAddress }),
			port: config.port || 47808,
			timeout: config.timeout || 5000,
			maxDevices: config.maxDevices || 100
		};
	}
}
