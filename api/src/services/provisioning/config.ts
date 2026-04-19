import { SystemConfigModel } from '../config/system-config';

class ConfigService {
  private cache = new Map<string, any>();
  private timestamps = new Map<string, number>();
  private ttl = 3600000; // 1 hour

  async get(key: string) {
    const now = Date.now();
    if (!this.cache.has(key) || now - this.timestamps.get(key)! > this.ttl) {
      const value = await SystemConfigModel.get(key);
      this.cache.set(key, value);
      this.timestamps.set(key, now);
    }
    return this.cache.get(key);
  }
}

export const configService = new ConfigService();
