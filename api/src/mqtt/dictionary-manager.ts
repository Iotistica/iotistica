/**
 * Cloud Dictionary Manager (Redis-Only POC)
 * 
 * Manages MQTT message dictionaries for key compaction.
 * - Stores dictionaries in Redis (30-day TTL)
 * - Expands compacted messages using stored dictionaries
 * - Handles full sync and delta updates
 * - Supports both indexed arrays (messages[0]) and opaque arrays (messages[])
 * 
 * POC Note: Redis-only for simplicity. Add PostgreSQL backup in production.
 */

import msgpack from 'msgpack-lite';
import { createHash } from 'crypto';

interface DictionaryPayload {
  version: number;
  fields: Array<{ name: string; index: number }> | string[];
}

interface DictionaryDelta {
  version: number;
  newFields: string[];  // New fields to append (agent may send as 'fields' for backwards compat)
}

// ✅ Clean typed payload contract (no shape guessing)
type Pair = 
  | [number, any]                                      // Leaf value: [index, primitive]
  | ['a', string, Array<Array<Pair>>];                 // Array frame: ["a", arrayKey, [[pairs], [pairs]]]

// Tuple-based compaction format (new format)
interface CompactedMessageTuples {
  v: number;                        // Dictionary version
  p: Array<Pair>;                   // Typed pairs (leaf or array frame)
  h?: string;                       // Optional: SHA-256 hash of dictionary content (integrity check)
}

// Legacy parallel array format (backwards compatibility)
interface CompactedMessageLegacy {
  v: number;      // Dictionary version
  i: number[];    // Field indices
  d: any[];       // Field values
  h?: string;     // Optional: SHA-256 hash of dictionary content (integrity check)
}

type CompactedMessage = CompactedMessageTuples | CompactedMessageLegacy;

export class CloudDictionaryManager {
  private redis: any; // RedisClient type
  private logger?: any; // Winston logger
  private strictVersioning: boolean; // Reject version mismatches by default

  constructor(redis: any, logger?: any, options?: { strictVersioning?: boolean }) {
    this.redis = redis;
    this.logger = logger;
    this.strictVersioning = options?.strictVersioning ?? true; // Default: strict mode
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

      // Calculate dictionary hash (SHA-256 of sorted field names)
      const sortedFields = Object.values(fieldMap).sort();
      const dictHash = createHash('sha256').update(JSON.stringify(sortedFields)).digest('hex');

      // Store in Redis with 30-day TTL
      const key = `dict:${deviceUuid}`;
      await this.redis.setex(key, 30 * 24 * 60 * 60, JSON.stringify(fieldMap));
      
      // Store version and hash separately for quick lookup
      await this.redis.setex(`${key}:version`, 30 * 24 * 60 * 60, dict.version.toString());
      await this.redis.setex(`${key}:hash`, 30 * 24 * 60 * 60, dictHash);

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
   * 
   * ⚠️ CRITICAL ASSUMPTION: Dictionary is append-only
   * This method assumes:
   * - No dictionary resets between deltas
   * - No rollback of versions
   * - No missing deltas (all deltas applied in order)
   * - Agent enforces monotonic growth (version only increments)
   * 
   * If any delta is missed or dictionary is reset, cloud state becomes corrupt.
   * Recovery: Device must send full dictionary sync (not delta).
   */
  async applyDelta(deviceUuid: string, delta: DictionaryDelta): Promise<void> {
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

      // ✅ APPEND-ONLY INVARIANT: New fields are always appended to end
      // Index = current dictionary length + offset in newFields array
      const newFields = delta.newFields;
      const baseIndex = Object.keys(currentDict).length;
      
      // ✅ INVARIANT CHECK: Validate version monotonicity
      const currentVersion = await this.getDictionaryVersion(deviceUuid);
      if (currentVersion !== null && delta.version <= currentVersion) {
        this.logger?.error(`Delta version violation: delta v${delta.version} <= current v${currentVersion}`, {
          operation: 'applyDelta',
          deviceUuid,
          deltaVersion: delta.version,
          currentVersion
        });
        throw new Error(`Delta version must be > current version (got ${delta.version}, expected > ${currentVersion}). Dictionary may have been reset - device should send full sync.`);
      }
      
      newFields.forEach((name: string, offset: number) => {
        const index = baseIndex + offset;
        currentDict[index] = name;
      });

      // Calculate updated dictionary hash
      const sortedFields = Object.values(currentDict).sort();
      const dictHash = createHash('sha256').update(JSON.stringify(sortedFields)).digest('hex');

      // Store updated dictionary
      const key = `dict:${deviceUuid}`;
      await this.redis.setex(key, 30 * 24 * 60 * 60, JSON.stringify(currentDict));
      await this.redis.setex(`${key}:version`, 30 * 24 * 60 * 60, delta.version.toString());
      await this.redis.setex(`${key}:hash`, 30 * 24 * 60 * 60, dictHash);

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
   * Get dictionary content hash (SHA-256)
   */
  async getDictionaryHash(deviceUuid: string): Promise<string | null> {
    try {
      const hash = await this.redis.get(`dict:${deviceUuid}:hash`);
      return hash || null;
    } catch (error) {
      this.logger?.error(`Failed to get dictionary hash: ${deviceUuid}`, {
        operation: 'getDictionaryHash',
        error: error instanceof Error ? error.message : String(error),
        deviceUuid
      });
      return null;
    }
  }

  /**
   * Expand compacted message to original format
   * Supports both tuple-based (new) and parallel array (legacy) formats
   */
  async expandMessage(deviceUuid: string, compacted: CompactedMessage): Promise<Record<string, any>> {
    const dictionary = await this.getDictionary(deviceUuid);
    
    if (!dictionary) {
      throw new Error(`Cannot expand message: no dictionary for ${deviceUuid} (dictionary may have been lost on Redis restart)`);
    }

    // ✅ Refresh TTL on decode to keep active dictionaries alive
    // Without this, dictionaries expire after 30 days even if device is actively publishing
    const key = `dict:${deviceUuid}`;
    await this.redis.expire(key, 30 * 24 * 60 * 60);
    await this.redis.expire(`${key}:version`, 30 * 24 * 60 * 60);
    await this.redis.expire(`${key}:hash`, 30 * 24 * 60 * 60);

    // ✅ Hash validation (if message includes hash)
    // Protects against: device bugs, UUID collisions, Redis corruption
    if (compacted.h) {
      const cachedHash = await this.getDictionaryHash(deviceUuid);
      if (cachedHash && cachedHash !== compacted.h) {
        const errorMsg = `Dictionary hash mismatch: content differs despite version match (cached: ${cachedHash.substring(0, 8)}..., message: ${compacted.h.substring(0, 8)}...)`;
        this.logger?.error(errorMsg, {
          operation: 'expandMessage',
          deviceUuid,
          messageVersion: compacted.v,
          cachedHash: cachedHash.substring(0, 16),
          messageHash: compacted.h.substring(0, 16)
        });
        throw new Error(`${errorMsg}. Dictionary content corruption detected - device must resync (send full sync to iot/device/${deviceUuid}/meta/dictionary)`);
      }
    }

    // Version check (warn if mismatch)
    const cachedVersion = await this.getDictionaryVersion(deviceUuid);
    if (cachedVersion !== null && cachedVersion !== compacted.v) {
      const errorMsg = `Dictionary version mismatch: message v${compacted.v}, cached v${cachedVersion}`;
      
      if (this.strictVersioning) {
        // ✅ STRICT MODE (default): Reject mismatched versions to prevent silent corruption
        this.logger?.error(errorMsg, {
          operation: 'expandMessage',
          deviceUuid,
          messageVersion: compacted.v,
          cachedVersion,
          action: 'rejected'
        });
        throw new Error(`${errorMsg}. Device should resync dictionary (send full sync to iot/device/${deviceUuid}/meta/dictionary)`);
      } else {
        // ⚠️ LENIENT MODE: Allow decoding but log warning (may cause corruption!)
        this.logger?.warn(`${errorMsg} (lenient mode - decoding anyway)`, {
          operation: 'expandMessage',
          deviceUuid,
          messageVersion: compacted.v,
          cachedVersion,
          action: 'continuing'
        });
      }
    }

    // Detect format: new tuple-based ('p' field) vs legacy parallel arrays ('i'/'d' fields)
    if ('p' in compacted) {
      // ✅ New tuple-based format with array framing
      const pairs = compacted.p;
      
      // ✅ FIX: Explicit root array handling
      // If entire payload is a single array frame with '$root' key, unwrap it
      if (pairs.length === 1 && pairs[0][0] === 'a') {
        const [_marker, arrayKey, arrayElements] = pairs[0] as ['a', string, Array<Array<Pair>>];
        if (arrayKey === '$root') {
          // Root-level array - expand and unwrap
          return arrayElements.map((elementPairs: Array<Pair>) => {
            return this.expandTuples(elementPairs, dictionary);
          });
        }
      }
      
      // Regular object expansion
      return this.expandTuples(pairs, dictionary);
    } else if ('i' in compacted && 'd' in compacted) {
      // ⚠️ Legacy parallel array format (backwards compatibility)
      this.logger?.debug('Using legacy expansion for parallel array format', {
        operation: 'expandMessage',
        deviceUuid
      });
      return this.expandLegacy(compacted.i, compacted.d, dictionary);
    } else {
      throw new Error('Invalid compacted message format: missing both "p" (tuples) and "i"/"d" (legacy) fields');
    }
  }

  /**
   * ✅ NEW: Expand tuple-based compacted message with array framing
   * Format: {v, p: [[index, value], ...]}
   * Arrays are marked with typed frames ['a', arrayKey, [...]] (explicit, no inference!)
   */
  private expandTuples(pairs: Array<Pair>, dictionary: Record<number, string>): Record<string, any> {
    const expanded: Record<string, any> = {};

    for (const pair of pairs) {
      // ✅ Type-based dispatch (no shape guessing!)
      if (pair[0] === 'a') {
        // Array frame: ['a', arrayKey, arrayElements]
        const [_marker, arrayKey, arrayElements] = pair as ['a', string, Array<Array<Pair>>];
        
        if (arrayElements.length === 0) {
          expanded[arrayKey] = [];
          continue;
        }
        
        // ✅ Simple recursion - no prefix tracking needed
        expanded[arrayKey] = arrayElements.map((elementPairs: Array<Pair>) => {
          return this.expandTuples(elementPairs, dictionary);
        });
      } else {
        // Leaf value: [index, value]
        const [index, value] = pair as [number, any];
        const fieldName = dictionary[index];
        
        if (!fieldName) {
          this.logger?.warn('Unknown field index in compacted message', {
            operation: 'expandTuples',
            index
          });
          continue;
        }

        // ✅ Strip array markers from field path to get relative name
        // "alarms[].code" → "code", "metrics[].values[].min" → "min"
        const lastArrayMarker = fieldName.lastIndexOf('[].');
        const relativeFieldName = lastArrayMarker >= 0 
          ? fieldName.substring(lastArrayMarker + 3)  // Skip "[]."
          : fieldName;

        // Set the leaf value using relative field name
        this.setNestedValue(expanded, relativeFieldName, value);
      }
    }

    return expanded;
  }

  /**
   * Set nested value using dot-notation path (e.g., "messages[0].timestamp" or "sensor.temperature")
   */
  private setNestedValue(obj: any, path: string, value: any): void {
    const parts = path.split(/\.|\[|\]/).filter(p => p);
    let current = obj;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      
      if (isLast) {
        current[part] = value;
      } else {
        if (!current[part]) {
          // Look ahead to see if next part is a number (array index)
          const nextPart = parts[i + 1];
          const nextIsIndex = nextPart && /^\d+$/.test(nextPart);
          current[part] = nextIsIndex ? [] : {};
        }
        current = current[part];
      }
    }
  }

  /**
   * ⚠️ LEGACY: Expand parallel array format (backwards compatibility)
   * Old format: {v, i: [indices], d: [values]}
   * This format has known issues with nested arrays - kept for migration period only
   */
  private expandLegacy(indices: number[], values: any[], dictionary: Record<number, string>): Record<string, any> {
    const expanded: Record<string, any> = {};

    indices.forEach((index, pos) => {
      const fieldName = dictionary[index];
      if (!fieldName) {
        return;
      }
      
      const value = values[pos];
      
      // Handle nested compacted objects (legacy)
      if (value && typeof value === 'object' && 'i' in value && 'd' in value) {
        expanded[fieldName] = this.expandLegacy(value.i, value.d, dictionary);
      } 
      // Handle arrays of compacted objects (legacy indexed mode)
      else if (Array.isArray(value)) {
        expanded[fieldName] = value.map(item =>
          item && typeof item === 'object' && 'i' in item && 'd' in item
            ? this.expandLegacy(item.i, item.d, dictionary)
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
   * Supports both tuple-based (new) and parallel array (legacy) formats
   */
  isCompactedMessage(payload: any): payload is CompactedMessage {
    return (
      payload &&
      typeof payload === 'object' &&
      typeof payload.v === 'number' &&
      (
        Array.isArray(payload.p) ||
        (Array.isArray(payload.i) && Array.isArray(payload.d))
      )
    );
  }

  /**
   * Delete dictionary (for testing/cleanup)
   */
  async deleteDictionary(deviceUuid: string): Promise<void> {
    await this.redis.del(`dict:${deviceUuid}`);
    await this.redis.del(`dict:${deviceUuid}:version`);
    await this.redis.del(`dict:${deviceUuid}:hash`);
    
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
