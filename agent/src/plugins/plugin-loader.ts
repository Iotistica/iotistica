import path from "path";
import { pathToFileURL } from "url";
import type { AgentLogger } from "../logging/agent-logger.js";
import type {
	ExternalPluginConfig,
	ExternalPluginManifest,
	ProtocolAdapterStarter,
} from "./types.js";
import type { AdapterManager } from "./index.js";

export const EXTERNAL_PLUGIN_API_VERSION = "1.0.0";

export interface ExternalPluginContext {
	apiVersion: string;
	logger: {
		info(message: string): void;
		warn(message: string): void;
		error(message: string): void;
		debug(message: string): void;
	};
}

export interface ExternalPluginDefinition {
	manifest: ExternalPluginManifest;
	createStarter: (
		manager: AdapterManager,
		options?: Record<string, unknown>,
	) => ProtocolAdapterStarter;
}

interface ExternalPluginModule {
	createPlugin?: (context: ExternalPluginContext) => ExternalPluginDefinition;
}

const BUILT_IN_PROTOCOLS = new Set(["modbus", "opcua", "mqtt", "bacnet", "can", "snmp"]);

export class PluginLoader {
	private readonly logger: {
		info(message: string): void;
		warn(message: string): void;
		error(message: string): void;
		debug(message: string): void;
	};

	constructor(agentLogger: AgentLogger) {
		this.logger = {
			info: (message: string) =>
				agentLogger.infoSync(message, { component: "PluginLoader" }),
			warn: (message: string) =>
				agentLogger.warnSync(message, { component: "PluginLoader" }),
			error: (message: string) =>
				agentLogger.errorSync(message, undefined, { component: "PluginLoader" }),
			debug: (message: string) =>
				agentLogger.debugSync(message, { component: "PluginLoader" }),
		};
	}

	async registerFromConfig(
		manager: AdapterManager,
		plugins: ExternalPluginConfig[] | undefined,
	): Promise<void> {
		if (!plugins || plugins.length === 0) {
			return;
		}

		for (const pluginConfig of plugins) {
			const enabled = pluginConfig.enabled !== false;
			if (!enabled) {
				continue;
			}

			try {
				const definition = await this.loadPluginDefinition(pluginConfig.modulePath);
				this.validateManifest(definition.manifest, pluginConfig.modulePath);

				const protocol = definition.manifest.protocol.toLowerCase();
				if (BUILT_IN_PROTOCOLS.has(protocol) && !pluginConfig.allowBuiltInOverride) {
					this.logger.warn(
						`Skipping external plugin '${definition.manifest.name}' for built-in protocol '${protocol}'. Set allowBuiltInOverride=true to override.`,
					);
					continue;
				}

				const starter = definition.createStarter(manager, pluginConfig.options);
				manager.registerProtocolStarter(protocol, starter, true);
				this.logger.info(
					`Registered external plugin '${definition.manifest.name}' (${definition.manifest.version}) for protocol '${protocol}'`,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.error(
					`Failed to load external plugin from '${pluginConfig.modulePath}': ${message}`,
				);
			}
		}
	}

	private async loadPluginDefinition(modulePath: string): Promise<ExternalPluginDefinition> {
		const resolvedPath = path.isAbsolute(modulePath)
			? modulePath
			: path.resolve(process.cwd(), modulePath);
		const moduleUrl = pathToFileURL(resolvedPath).href;
		const pluginModule = (await import(moduleUrl)) as ExternalPluginModule;

		if (typeof pluginModule.createPlugin !== "function") {
			throw new Error("Module must export createPlugin(context)");
		}

		const context: ExternalPluginContext = {
			apiVersion: EXTERNAL_PLUGIN_API_VERSION,
			logger: this.logger,
		};

		const definition = pluginModule.createPlugin(context);
		if (!definition || typeof definition !== "object") {
			throw new Error("createPlugin must return a plugin definition object");
		}

		if (typeof definition.createStarter !== "function") {
			throw new Error("Plugin definition must include createStarter(manager, options)");
		}

		return definition;
	}

	private validateManifest(manifest: ExternalPluginManifest, modulePath: string): void {
		if (!manifest || typeof manifest !== "object") {
			throw new Error(`Plugin at '${modulePath}' must expose a manifest object`);
		}

		if (!manifest.name || !manifest.version || !manifest.apiVersion || !manifest.protocol) {
			throw new Error(
				`Plugin manifest at '${modulePath}' must include name, version, apiVersion, and protocol`,
			);
		}

		if (!this.isApiVersionCompatible(manifest.apiVersion, EXTERNAL_PLUGIN_API_VERSION)) {
			throw new Error(
				`Plugin API version mismatch for '${manifest.name}'. Expected compatible with ${EXTERNAL_PLUGIN_API_VERSION}, got ${manifest.apiVersion}`,
			);
		}
	}

	private isApiVersionCompatible(pluginVersion: string, runtimeVersion: string): boolean {
		const pluginMajor = pluginVersion.split(".")[0];
		const runtimeMajor = runtimeVersion.split(".")[0];
		return pluginMajor === runtimeMajor;
	}
}
