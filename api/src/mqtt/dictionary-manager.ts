/**
 * Cloud Dictionary Manager (Redis-Only POC)
 * 
 * Manages MQTT message dictionaries for key compaction.
 * - Stores dictionaries in Redis (30-day TTL)
 * - Expands compacted messages using stored dictionaries
 * - Handles full sync and delta updates
 * 
 * POC Note: Redis-only for simplicity. Add PostgreSQL backup in production.
 */

import msgpack from 'msgpack-lite';

interface DictionaryPayload {
  version: number;
  fields: Array<{ name: string; index: number }> | string[];
}

interface CompactedMessage {
  v: number;      // Dictionary version
  i: number[];    // Field indices
  d: any[];       // Field values
}

export class CloudDictionaryManager {
  private redis: any; // RedisClient type
  private logger?: any; // Winston logger

  constructor(redis: any, logger?: any) {
    this.redis = redis;
    this.logger = logger;
  }

  /**
   * Store dictionary from device (full sync)
   */
  async storeDictionary(deviceUuid: string, dict: DictionaryPayload): Promise<void> {
    try {
      // Build field map: index → name
      const fieldMap: Record<number, string> = {};
      
      // Handle both formats from agent:
      // 1. Array of strings (sorted by index): ["field1", "field2", ...]
      // 2. Array of objects (legacy): [{name: "field1", index: 0}, ...]
      if (Array.isArray(dict.fields) && dict.fields.length > 0) {
        if (typeof dict.fields[0] === 'string') {
          // Format 1: Array of field names (index = array position)
          (dict.fields as string[]).forEach((name: string, index: number) => {
            fieldMap[index] = name;
          });
        } else {
          // Format 2: Array of {name, index} objects
          (dict.fields as Array<{ name: string; index: number }>).forEach(({ name, index }) => {
            fieldMap[index] = name;
          });
        }
      }

      // Store in Redis with 30-day TTL
      const key = `dict:${deviceUuid}`;
      await this.redis.setex(key, 30 * 24 * 60 * 60, JSON.stringify(fieldMap));
      
      // Store version separately for quick lookup
      await this.redis.setex(`${key}:version`, 30 * 24 * 60 * 60, dict.version.toString());

      this.logger?.info(`Dictionary stored: ${deviceUuid} v${dict.version} (${dict.fields.length} fields)`, {
        operation: 'storeDictionary',
        deviceUuid,
        version: dict.version,
        fieldCount: dict.fields.length
      });
    } catch (error) {
      this.logger?.error(`Failed to store dictionary: ${deviceUuid}`, {
        operation: 'storeDictionary',
        error: error instanceof Error ? error.message : String(error),
        deviceUuid
      });
      throw error;
    }
  }

  /**
   * Apply delta update to existing dictionary
   */
  async applyDelta(deviceUuid: string, delta: any): Promise<void> {
    try {
      const currentDict = await this.getDictionary(deviceUuid);
      
      if (!currentDict) {
        this.logger?.warn(`Cannot apply delta: no base dictionary for ${deviceUuid}`, {
          operation: 'applyDelta',
          deviceUuid,
          deltaVersion: delta.version
        });
        
        // Cannot apply delta without base dictionary - agent should resync full dictionary
        return;
      }

      // Agent sends delta with newFields: string[] (array of field names)
      // New fields are appended to end of dictionary, so index = current length + position in array
      const newFields = delta.newFields || delta.fields || [];
      const baseIndex = Object.keys(currentDict).length;
      
      newFields.forEach((name: string, offset: number) => {
        const index = baseIndex + offset;
        currentDict[index] = name;
      });

      // Store updated dictionary
      const key = `dict:${deviceUuid}`;
      await this.redis.setex(key, 30 * 24 * 60 * 60, JSON.stringify(currentDict));
      await this.redis.setex(`${key}:version`, 30 * 24 * 60 * 60, delta.version.toString());

      this.logger?.info(`Delta applied: ${deviceUuid} v${delta.version} (+${newFields.length} fields)`, {
        operation: 'applyDelta',
        deviceUuid,
        version: delta.version,
        newFields: newFields.length,
        totalFields: Object.keys(currentDict).length
      });
    } catch (error) {
      this.logger?.error(`Failed to apply delta: ${deviceUuid}`, {
        operation: 'applyDelta',
        error: error instanceof Error ? error.message : String(error),
        deviceUuid
      });
      throw error;
    }
  }

  /**
   * Retrieve dictionary from Redis
   */
  async getDictionary(deviceUuid: string): Promise<Record<number, string> | null> {
    try {
      const key = `dict:${deviceUuid}`;
      const dictionaryJson = await this.redis.get(key);
      
      if (!dictionaryJson) {
        this.logger?.warn(`No dictionary found for ${deviceUuid}`, {
          operation: 'getDictionary',
          deviceUuid
        });
        return null;
      }

      return JSON.parse(dictionaryJson);
    } catch (error) {
      this.logger?.error(`Failed to retrieve dictionary: ${deviceUuid}`, {
        operation: 'getDictionary',
        error: error instanceof Error ? error.message : String(error),
        deviceUuid
      });
      return null;
    }
  }

  /**
   * Get dictionary version
   */
  async getDictionaryVersion(deviceUuid: string): Promise<number | null> {
    try {
      const version = await this.redis.get(`dict:${deviceUuid}:version`);
      return version ? Number(version) : null;
    } catch (error) {
      this.logger?.error(`Failed to get dictionary version: ${deviceUuid}`, {
        operation: 'getDictionaryVersion',
        error: error instanceof Error ? error.message : String(error),
        deviceUuid
      });
      return null;
    }
  }

  /**
   * Expand compacted message to original format
   */
  async expandMessage(deviceUuid: string, compacted: CompactedMessage): Promise<Record<string, any>> {
    const dictionary = await this.getDictionary(deviceUuid);
    
    if (!dictionary) {
      throw new Error(`Cannot expand message: no dictionary for ${deviceUuid} (dictionary may have been lost on Redis restart)`);
    }

    // Version check (warn if mismatch)
    const cachedVersion = await this.getDictionaryVersion(deviceUuid);
    if (cachedVersion !== null && cachedVersion !== compacted.v) {
      this.logger?.warn(`Version mismatch: message v${compacted.v}, cached v${cachedVersion}`, {
        operation: 'expandMessage',
        deviceUuid,
        messageVersion: compacted.v,
        cachedVersion
      });
    }

    return this.expandObject(compacted.i, compacted.d, dictionary);
  }

  /**
   * Recursively expand compacted object
   */
  private expandObject(indices: number[], values: any[], dictionary: Record<number, string>): Record<string, any> {
    const expanded: Record<string, any> = {};

    indices.forEach((index, pos) => {
      const fieldName = dictionary[index];
      if (!fieldName) {
        // Skip unknown indices silently - version mismatch warning already logged at top level
        return;
      }
      
      const value = values[pos];
      
      // Handle nested compacted objects
      if (value && typeof value === 'object' && 'i' in value && 'd' in value) {
        expanded[fieldName] = this.expandObject(value.i, value.d, dictionary);
      } 
      // Handle arrays of compacted objects
      else if (Array.isArray(value)) {
        expanded[fieldName] = value.map(item =>
          item && typeof item === 'object' && 'i' in item && 'd' in item
            ? this.expandObject(item.i, item.d, dictionary)
            : item
        );
      } 
      // Primitive value
      else {
        expanded[fieldName] = value;
      }
    });

    return expanded;
  }

  /**
   * Check if message is compacted (has dictionary encoding)
   */
  isCompactedMessage(payload: any): payload is CompactedMessage {
    return (
      payload &&
      typeof payload === 'object' &&
      'v' in payload &&
      'i' in payload &&
      'd' in payload &&
      Array.isArray(payload.i) &&
      Array.isArray(payload.d)
    );
  }

  /**
   * Delete dictionary (for testing/cleanup)
   */
  async deleteDictionary(deviceUuid: string): Promise<void> {
    await this.redis.del(`dict:${deviceUuid}`);
    await this.redis.del(`dict:${deviceUuid}:version`);
    
    this.logger?.info(`Dictionary deleted: ${deviceUuid}`, {
      operation: 'deleteDictionary',
      deviceUuid
    });
  }

  /**
   * Get statistics about stored dictionaries (for monitoring)
   */
  async getStatistics(): Promise<{
    totalDictionaries: number;
    dictionaries: Array<{ deviceUuid: string; version: number; fieldCount: number }>;
  }> {
    try {
      // Scan for all dictionary keys
      const keys = await this.redis.keys('dict:*');
      const dictKeys = keys.filter((k: string) => !k.endsWith(':version'));
      
      const dictionaries = await Promise.all(
        dictKeys.map(async (key: string) => {
          const deviceUuid = key.replace('dict:', '');
          const version = await this.getDictionaryVersion(deviceUuid);
          const dict = await this.getDictionary(deviceUuid);
          
          return {
            deviceUuid,
            version: version || 0,
            fieldCount: dict ? Object.keys(dict).length : 0
          };
        })
      );

      return {
        totalDictionaries: dictionaries.length,
        dictionaries
      };
    } catch (error) {
      this.logger?.error('Failed to get dictionary statistics', {
        operation: 'getStatistics',
        error: error instanceof Error ? error.message : String(error)
      });
      
      return { totalDictionaries: 0, dictionaries: [] };
    }
  }
}
