/**
 * Dictionary Model
 * ================
 * 
 * Persistent storage for MQTT message dictionary field-to-index mappings.
 * Enables dictionary to survive agent restarts and tracks delta sync state.
 * 
 * Features:
 * - Load/save field mappings
 * - Track deltas for cloud sync
 * - Metadata management
 * - Audit trail
 */

import { getKnex } from '../connection';

export type DictionaryDomain = 'key' | 'metric' | 'unit' | 'quality' | 'device';

export interface DictionaryEntry {
  id?: number;
  field_name: string;
  field_index: number;
  version_added: number;
  domain?: DictionaryDomain; // Defaults to 'key' for backward compatibility
  created_at?: Date;
}

export interface DictionaryDelta {
  id?: number;
  version: number;
  field_name: string;
  field_index: number;
  domain?: DictionaryDomain; // Defaults to 'metric' for backward compatibility
  synced_to_cloud: boolean;
  synced_at?: Date;
  created_at?: Date;
}

export interface DictionaryMetadata {
  key: string;
  value: string;
  updated_at?: Date;
}

export class DictionaryModel {
  private static readonly ENTRIES_TABLE = 'dictionary_entries';
  private static readonly METADATA_TABLE = 'dictionary_metadata';
  private static readonly DELTAS_TABLE = 'dictionary_deltas';

  /**
   * Load entire dictionary from database
   * Returns domain-partitioned maps for field_name -> field_index
   */
  static async loadDictionary(): Promise<{
    key: Map<string, number>;
    metric: Map<string, number>;
    unit: Map<string, number>;
    quality: Map<string, number>;
    device: Map<string, number>;
  }> {
    const knex = getKnex();
    
    const entries = await knex(this.ENTRIES_TABLE)
      .select('field_name', 'field_index', 'domain')
      .orderBy('field_index', 'asc');

    // Initialize domain maps
    const domains = {
      key: new Map<string, number>(),
      metric: new Map<string, number>(),
      unit: new Map<string, number>(),
      quality: new Map<string, number>(),
      device: new Map<string, number>(),
    };

    // Populate maps by domain
    for (const entry of entries) {
      const domain = (entry.domain || 'key') as DictionaryDomain;
      domains[domain].set(entry.field_name, entry.field_index);
    }
    
    return domains;
  }

  /**
   * Save a single field entry to dictionary
   */
  static async saveEntry(fieldName: string, fieldIndex: number, versionAdded: number, domain: DictionaryDomain = 'key'): Promise<void> {
    const knex = getKnex();
    
    await knex(this.ENTRIES_TABLE).insert({
      field_name: fieldName,
      field_index: fieldIndex,
      version_added: versionAdded,
      domain,
      created_at: knex.fn.now()
    });
  }

  /**
   * Record a delta (new field addition) for sync tracking
   */
  static async saveDelta(fieldName: string, fieldIndex: number, version: number, domain: DictionaryDomain = 'metric'): Promise<number> {
    const knex = getKnex();
    
    const [id] = await knex(this.DELTAS_TABLE).insert({
      version,
      field_name: fieldName,
      field_index: fieldIndex,
      domain,
      synced_to_cloud: false,
      created_at: knex.fn.now()
    });
    
    
    return id;
  }

  /**
   * Get all deltas not yet synced to cloud
   */
  static async getUnsyncedDeltas(): Promise<DictionaryDelta[]> {
    const knex = getKnex();
    
    const deltas = await knex(this.DELTAS_TABLE)
      .where('synced_to_cloud', false)
      .orderBy('version', 'asc')
      .select('*');
    
    return deltas;
  }

  /**
   * Get deltas for a specific version
   */
  static async getDeltasByVersion(version: number): Promise<DictionaryDelta[]> {
    const knex = getKnex();
    
    return knex(this.DELTAS_TABLE)
      .where('version', version)
      .orderBy('field_index', 'asc')
      .select('*');
  }

  /**
   * Mark deltas as synced to cloud
   */
  static async markDeltasSynced(deltaIds: number[]): Promise<void> {
    if (deltaIds.length === 0) return;
    
    const knex = getKnex();
    
    await knex(this.DELTAS_TABLE)
      .whereIn('id', deltaIds)
      .update({
        synced_to_cloud: true,
        synced_at: knex.fn.now()
      });
  }

  /**
   * Mark all deltas up to a version as synced
   */
  static async markDeltasSyncedUpToVersion(version: number): Promise<void> {
    const knex = getKnex();
    
    await knex(this.DELTAS_TABLE)
      .where('version', '<=', version)
      .where('synced_to_cloud', false)
      .update({
        synced_to_cloud: true,
        synced_at: knex.fn.now()
      });
  }

  /**
   * Get current dictionary version from metadata
   */
  static async getCurrentVersion(): Promise<number> {
    const knex = getKnex();
    
    const result = await knex(this.METADATA_TABLE)
      .where('key', 'current_version')
      .first();
    
    return result ? parseInt(result.value, 10) : 1;
  }

  /**
   * Update current dictionary version in metadata
   */
  static async setCurrentVersion(version: number): Promise<void> {
    const knex = getKnex();
    
    await knex(this.METADATA_TABLE)
      .where('key', 'current_version')
      .update({
        value: version.toString(),
        updated_at: knex.fn.now()
      });
  }

  /**
   * Get metadata value by key
   */
  static async getMetadata(key: string): Promise<string | null> {
    const knex = getKnex();
    
    const result = await knex(this.METADATA_TABLE)
      .where('key', key)
      .first();
    
    return result ? result.value : null;
  }

  /**
   * Set metadata value
   */
  static async setMetadata(key: string, value: string): Promise<void> {
    const knex = getKnex();
    
    const exists = await knex(this.METADATA_TABLE)
      .where('key', key)
      .first();
    
    if (exists) {
      await knex(this.METADATA_TABLE)
        .where('key', key)
        .update({
          value,
          updated_at: knex.fn.now()
        });
    } else {
      await knex(this.METADATA_TABLE).insert({
        key,
        value,
        updated_at: knex.fn.now()
      });
    }
  }

  /**
   * Get count of unsynced deltas
   */
  static async getUnsyncedDeltaCount(): Promise<number> {
    const knex = getKnex();
    
    const result = await knex(this.DELTAS_TABLE)
      .where('synced_to_cloud', false)
      .count('* as count')
      .first();
    
    return result ? parseInt(result.count as string, 10) : 0;
  }

  /**
   * Get dictionary statistics
   */
  static async getStats(): Promise<{
    totalEntries: number;
    currentVersion: number;
    totalDeltas: number;
    unsyncedDeltas: number;
    oldestEntryDate?: Date;
    newestEntryDate?: Date;
  }> {
    const knex = getKnex();
    
    const [entriesCount, deltasCount, unsyncedCount, version, dateRange] = await Promise.all([
      knex(this.ENTRIES_TABLE).count('* as count').first(),
      knex(this.DELTAS_TABLE).count('* as count').first(),
      this.getUnsyncedDeltaCount(),
      this.getCurrentVersion(),
      knex(this.ENTRIES_TABLE)
        .min('created_at as oldest')
        .max('created_at as newest')
        .first()
    ]);
    
    return {
      totalEntries: entriesCount ? parseInt(entriesCount.count as string, 10) : 0,
      currentVersion: version,
      totalDeltas: deltasCount ? parseInt(deltasCount.count as string, 10) : 0,
      unsyncedDeltas: unsyncedCount,
      oldestEntryDate: dateRange?.oldest ? new Date(dateRange.oldest) : undefined,
      newestEntryDate: dateRange?.newest ? new Date(dateRange.newest) : undefined
    };
  }

  /**
   * Clear all dictionary data (for reset)
   */
  static async clearAll(): Promise<void> {
    const knex = getKnex();
    
    await knex(this.DELTAS_TABLE).del();
    await knex(this.ENTRIES_TABLE).del();
    await this.setCurrentVersion(1);
    await this.setMetadata('last_full_sync', '0');
    await this.setMetadata('last_delta_sync', '0');
  }

  // ========================================================================
  // PHASE 7: PROTOCOL-AWARE ENUM PERSISTENCE
  // ========================================================================

  /**
   * Save a promoted enum value to database
   */
  static async savePromotedEnum(
    type: 'metric' | 'device' | 'qualityCode',
    protocol: string | undefined,
    value: string,
    index: number
  ): Promise<void> {
    const knex = getKnex();
    const metadata = this.METADATA_TABLE;
    
    // Store as JSON in metadata table (key = "enum:{type}:{protocol}")
    const key = protocol ? `enum:${type}:${protocol}` : `enum:${type}`;
    
    // Load existing enum object
    const existing = await this.getMetadata(key);
    const enumObj = existing ? JSON.parse(existing) : {};
    
    // Add new value -> index mapping
    enumObj[value] = index;
    
    // Save back
    await this.setMetadata(key, JSON.stringify(enumObj));
  }

  /**
   * Save observation stats for an enum candidate
   */
  static async saveEnumStats(
    type: 'metric' | 'device' | 'qualityCode',
    protocol: string | undefined,
    value: string,
    count: number,
    firstSeen: number
  ): Promise<void> {
    const knex = getKnex();
    
    // Store as JSON in metadata table (key = "stats:{type}:{protocol}")
    const key = protocol ? `stats:${type}:${protocol}` : `stats:${type}`;
    
    // Load existing stats object
    const existing = await this.getMetadata(key);
    const statsObj = existing ? JSON.parse(existing) : {};
    
    // Update stats for this value
    statsObj[value] = { count, firstSeen };
    
    // Save back
    await this.setMetadata(key, JSON.stringify(statsObj));
  }

  /**
   * Load all promoted enums from database
   */
  static async getPromotedEnums(): Promise<{
    qualityCodes: Record<string, number>;
    metrics: Record<string, Record<string, number>>; // protocol -> value -> index
    devices: Record<string, Record<string, number>>; // protocol -> value -> index
  }> {
    const knex = getKnex();
    
    // Load all enum: keys from metadata
    const enumKeys = await knex(this.METADATA_TABLE)
      .where('key', 'like', 'enum:%')
      .select('key', 'value');
    
    const result = {
      qualityCodes: {},
      metrics: {} as Record<string, Record<string, number>>,
      devices: {} as Record<string, Record<string, number>>,
    };
    
    for (const row of enumKeys) {
      const parts = row.key.split(':'); // ["enum", "metric", "modbus"]
      const type = parts[1];
      const protocol = parts[2]; // undefined for qualityCode
      const enumObj = JSON.parse(row.value);
      
      if (type === 'qualityCode') {
        result.qualityCodes = enumObj;
      } else if (type === 'metric') {
        if (!result.metrics[protocol]) {
          result.metrics[protocol] = {};
        }
        result.metrics[protocol] = enumObj;
      } else if (type === 'device') {
        if (!result.devices[protocol]) {
          result.devices[protocol] = {};
        }
        result.devices[protocol] = enumObj;
      }
    }
    
    return result;
  }

  /**
   * Load observation stats from database
   */
  static async getEnumStats(): Promise<{
    qualityCodes: Record<string, { count: number; firstSeen: number }>;
    metrics: Record<string, { count: number; firstSeen: number; protocol: string }>;
    devices: Record<string, { count: number; firstSeen: number; protocol: string }>;
  }> {
    const knex = getKnex();
    
    // Load all stats: keys from metadata
    const statsKeys = await knex(this.METADATA_TABLE)
      .where('key', 'like', 'stats:%')
      .select('key', 'value');
    
    const result = {
      qualityCodes: {},
      metrics: {} as Record<string, { count: number; firstSeen: number; protocol: string }>,
      devices: {} as Record<string, { count: number; firstSeen: number; protocol: string }>,
    };
    
    for (const row of statsKeys) {
      const parts = row.key.split(':'); // ["stats", "metric", "modbus"]
      const type = parts[1];
      const protocol = parts[2]; // undefined for qualityCode
      const statsObj = JSON.parse(row.value);
      
      if (type === 'qualityCode') {
        result.qualityCodes = statsObj;
      } else if (type === 'metric') {
        // Convert to flat map with protocol embedded
        for (const [value, stats] of Object.entries(statsObj)) {
          const key = `${protocol}:${value}`;
          result.metrics[key] = { ...(stats as any), protocol };
        }
      } else if (type === 'device') {
        // Convert to flat map with protocol embedded
        for (const [value, stats] of Object.entries(statsObj)) {
          const key = `${protocol}:${value}`;
          result.devices[key] = { ...(stats as any), protocol };
        }
      }
    }
    
    return result;
  }
}
