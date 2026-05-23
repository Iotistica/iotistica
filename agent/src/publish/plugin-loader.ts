import path from 'path';
import { pathToFileURL } from 'url';
import type { AgentLogger } from '../logging/agent-logger.js';
import type { ExternalPublishPluginConfig, ExternalPublishPluginManifest, PublishPluginStarter } from './core/types.js';
import type { PublishPluginRegistry } from './plugin-registry.js';

export const EXTERNAL_PUBLISH_PLUGIN_API_VERSION = '1.0.0';

export interface ExternalPublishPluginContext {
  apiVersion: string;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
  };
}

export interface ExternalPublishPluginDefinition {
  manifest: ExternalPublishPluginManifest;
  createStarter: (
    registry: PublishPluginRegistry,
    options?: Record<string, unknown>,
  ) => PublishPluginStarter;
}

interface ExternalPublishPluginModule {
  createPlugin?: (context: ExternalPublishPluginContext) => ExternalPublishPluginDefinition;
}

const BUILT_IN_TARGETS = new Set(['iotistica', 'azure', 'aws', 'gcp', 'mqtt']);

export class PublishPluginLoader {
  private readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug(message: string): void;
  };

  constructor(agentLogger: AgentLogger) {
    this.logger = {
      info: (message: string) => agentLogger.infoSync(message, { component: 'PublishPluginLoader' }),
      warn: (message: string) => agentLogger.warnSync(message, { component: 'PublishPluginLoader' }),
      error: (message: string) => agentLogger.errorSync(message, undefined, { component: 'PublishPluginLoader' }),
      debug: (message: string) => agentLogger.debugSync(message, { component: 'PublishPluginLoader' }),
    };
  }

  async registerFromConfig(
    registry: PublishPluginRegistry,
    plugins: ExternalPublishPluginConfig[] | undefined,
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

        const target = definition.manifest.target.toLowerCase();
        if (BUILT_IN_TARGETS.has(target) && !pluginConfig.allowBuiltInOverride) {
          this.logger.warn(
            `Skipping external publish plugin '${definition.manifest.name}' for built-in target '${target}'. Set allowBuiltInOverride=true to override.`,
          );
          continue;
        }

        const starter = definition.createStarter(registry, pluginConfig.options);
        registry.registerPublishPluginStarter(target, starter, false);
        this.logger.info(
          `Registered external publish plugin '${definition.manifest.name}' (${definition.manifest.version}) for target '${target}'`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Failed to load external publish plugin from '${pluginConfig.modulePath}': ${message}`);
      }
    }
  }

  private async loadPluginDefinition(modulePath: string): Promise<ExternalPublishPluginDefinition> {
    const resolvedPath = path.isAbsolute(modulePath)
      ? modulePath
      : path.resolve(process.cwd(), modulePath);
    const moduleUrl = pathToFileURL(resolvedPath).href;
    const pluginModule = (await import(moduleUrl)) as ExternalPublishPluginModule;

    if (typeof pluginModule.createPlugin !== 'function') {
      throw new Error('Module must export createPlugin(context)');
    }

    const context: ExternalPublishPluginContext = {
      apiVersion: EXTERNAL_PUBLISH_PLUGIN_API_VERSION,
      logger: this.logger,
    };

    const definition = pluginModule.createPlugin(context);
    if (!definition || typeof definition !== 'object') {
      throw new Error('createPlugin must return a plugin definition object');
    }

    if (typeof definition.createStarter !== 'function') {
      throw new Error('Plugin definition must include createStarter(registry, options)');
    }

    return definition;
  }

  private validateManifest(manifest: ExternalPublishPluginManifest, modulePath: string): void {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error(`Publish plugin at '${modulePath}' must expose a manifest object`);
    }

    if (!manifest.name || !manifest.version || !manifest.apiVersion || !manifest.target) {
      throw new Error(
        `Publish plugin manifest at '${modulePath}' must include name, version, apiVersion, and target`,
      );
    }

    if (!this.isApiVersionCompatible(manifest.apiVersion, EXTERNAL_PUBLISH_PLUGIN_API_VERSION)) {
      throw new Error(
        `Publish plugin API version mismatch for '${manifest.name}'. Expected compatible with ${EXTERNAL_PUBLISH_PLUGIN_API_VERSION}, got ${manifest.apiVersion}`,
      );
    }
  }

  private isApiVersionCompatible(pluginVersion: string, runtimeVersion: string): boolean {
    const pluginMajor = pluginVersion.split('.')[0];
    const runtimeMajor = runtimeVersion.split('.')[0];
    return pluginMajor === runtimeMajor;
  }
}
