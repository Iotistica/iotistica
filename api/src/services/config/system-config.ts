import { query } from '../../db/connection';
import logger from '../../utils/logger';

// ---------------------------------------------------------------------------
// SystemConfigModel — raw DB layer
// ---------------------------------------------------------------------------

export class SystemConfigModel {
  static async get<T = any>(key: string): Promise<T | null> {
    const result = await query<{ value: T }>(
      'SELECT value FROM system_config WHERE key = $1',
      [key]
    );
    return result.rows[0]?.value || null;
  }

  static async set(key: string, value: any): Promise<void> {
    await query(
      `INSERT INTO system_config (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET
         value = $2,
         updated_at = CURRENT_TIMESTAMP`,
      [key, JSON.stringify(value)]
    );
  }

  static async delete(key: string): Promise<void> {
    await query('DELETE FROM system_config WHERE key = $1', [key]);
  }

  static async getAll(): Promise<Record<string, any>> {
    const result = await query<{ key: string; value: any }>(
      'SELECT key, value FROM system_config'
    );
    return result.rows.reduce(
      (acc, row) => {
        acc[row.key] = row.value;
        return acc;
      },
      {} as Record<string, any>
    );
  }

  static async getByPattern<T = any>(
    pattern: string
  ): Promise<Array<{ key: string; value: T }>> {
    const result = await query<{ key: string; value: T }>(
      'SELECT key, value FROM system_config WHERE key LIKE $1',
      [pattern]
    );
    return result.rows;
  }

  static async has(key: string): Promise<boolean> {
    const result = await query('SELECT 1 FROM system_config WHERE key = $1', [key]);
    return result.rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// SystemConfigManager — caching service layer
// ---------------------------------------------------------------------------

class SystemConfigManager {
  private static instance: SystemConfigManager;

  private cache: Map<string, any> = new Map();
  private isLoaded = false;
  private lastLoadTime: Date | null = null;

  private constructor() {}

  public static getInstance(): SystemConfigManager {
    if (!SystemConfigManager.instance) {
      SystemConfigManager.instance = new SystemConfigManager();
    }
    return SystemConfigManager.instance;
  }

  public async load(): Promise<void> {
    try {
      logger.info('Loading system configurations from database...');

      const configs = await SystemConfigModel.getAll();

      this.cache.clear();
      for (const [key, value] of Object.entries(configs)) {
        this.cache.set(key, value);
      }

      this.isLoaded = true;
      this.lastLoadTime = new Date();

      logger.info('System configurations loaded', {
        keys: this.cache.size,
        loadTime: this.lastLoadTime.toISOString(),
      });
    } catch (error) {
      logger.error('Failed to load system configurations', { error });
      throw error;
    }
  }

  public async reload(): Promise<void> {
    logger.info('Reloading system configurations...');
    await this.load();
  }

  public async get<T = any>(key: string, defaultValue?: T): Promise<T | null> {
    if (this.isLoaded && this.cache.has(key)) {
      return this.cache.get(key) as T;
    }

    const value = await SystemConfigModel.get<T>(key);

    if (value === null) {
      return defaultValue !== undefined ? defaultValue : null;
    }

    this.cache.set(key, value);
    return value as T;
  }

  public async set<T = any>(key: string, value: T): Promise<void> {
    await SystemConfigModel.set(key, value);
    this.cache.set(key, value);
    logger.debug('Config updated', { key });
  }

  public async delete(key: string): Promise<void> {
    await SystemConfigModel.delete(key);
    this.cache.delete(key);
    logger.debug('Config deleted', { key });
  }

  public async getByPattern<T = any>(pattern: string): Promise<Map<string, T>> {
    const rows = await SystemConfigModel.getByPattern<T>(pattern);

    const matches = new Map<string, T>();
    for (const row of rows) {
      matches.set(row.key, row.value as T);
      this.cache.set(row.key, row.value);
    }

    return matches;
  }

  public async getByPrefix<T = any>(prefix: string): Promise<Map<string, T>> {
    return this.getByPattern<T>(`${prefix}%`);
  }

  public async has(key: string): Promise<boolean> {
    if (this.isLoaded && this.cache.has(key)) {
      return true;
    }

    return SystemConfigModel.has(key);
  }

  public getAllKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  public clearCache(): void {
    this.cache.clear();
    this.isLoaded = false;
    this.lastLoadTime = null;
    logger.debug('Config cache cleared');
  }

  public async getMqttBroker(brokerId?: number | null): Promise<any> {
    if (!brokerId) {
      const defaultId = await this.get<number>('mqtt.defaultBrokerId');
      if (!defaultId) return null;
      brokerId = defaultId;
    }
    return this.get(`mqtt.brokers.${brokerId}`);
  }

  public async getAllMqttBrokers(): Promise<any[]> {
    const brokers = await this.getByPattern('mqtt.brokers.%');
    return Array.from(brokers.values());
  }

  public async getVpnConfig(configId?: number | null): Promise<any> {
    if (!configId) {
      const defaultId = await this.get<number>('vpn.defaultConfigId');
      if (!defaultId) return null;
      configId = defaultId;
    }
    return this.get(`vpn.configs.${configId}`);
  }

  public async getAllVpnConfigs(): Promise<any[]> {
    const configs = await this.getByPattern('vpn.configs.%');
    return Array.from(configs.values());
  }

  public async updateMqttBroker(brokerId: number, updates: Record<string, any>): Promise<void> {
    const current = await this.get(`mqtt.brokers.${brokerId}`);
    if (!current) {
      throw new Error(`MQTT broker ${brokerId} not found`);
    }
    await this.set(`mqtt.brokers.${brokerId}`, { ...current, ...updates });
  }

  public async updateVpnConfig(configId: number, updates: Record<string, any>): Promise<void> {
    const current = await this.get(`vpn.configs.${configId}`);
    if (!current) {
      throw new Error(`VPN config ${configId} not found`);
    }
    await this.set(`vpn.configs.${configId}`, { ...current, ...updates });
  }
}

export const SystemConfig = SystemConfigManager.getInstance();
