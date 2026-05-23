import type { IPublishPlugin, PublishPluginStarter, PublishPluginStarterContext } from './core/types.js';

export class PublishPluginRegistry {
  private readonly starters = new Map<string, PublishPluginStarter>();
  private readonly builtInStarters = new Set<string>();

  public registerPublishPluginStarter(
    name: string,
    starter: PublishPluginStarter,
    builtIn = false,
  ): void {
    const normalizedName = name.trim().toLowerCase();
    this.starters.set(normalizedName, starter);
    if (builtIn) {
      this.builtInStarters.add(normalizedName);
    }
  }

  public hasStarter(name: string): boolean {
    return this.starters.has(name.trim().toLowerCase());
  }

  public isBuiltInStarter(name: string): boolean {
    return this.builtInStarters.has(name.trim().toLowerCase());
  }

  public create(name: string, context: PublishPluginStarterContext): IPublishPlugin {
    const normalizedName = name.trim().toLowerCase();
    const starter = this.starters.get(normalizedName);
    if (!starter) {
      throw new Error(`Publish plugin starter not found: ${normalizedName}`);
    }
    return starter(context);
  }
}
