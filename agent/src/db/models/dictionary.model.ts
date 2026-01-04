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

export interface DictionaryEntry {
  id?: number;
  field_name: string;
  field_index: number;
  version_added: number;
  created_at?: Date;
}

export interface DictionaryDelta {
  id?: number;
  version: number;
  field_name: string;
  field_index: number;
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
   * Returns Map of field_name -> field_index
   */
  static async loadDictionary(): Promise<Map<string, number>> {
    const knex = getKnex();
    
  
    const entries = await knex(this.ENTRIES_TABLE)
      .select('field_name', 'field_index')
      .orderBy('field_index', 'asc');
    

    const dictionary = new Map<string, number>();
    for (const entry of entries) {
      dictionary.set(entry.field_name, entry.field_index);
    }
    
    return dictionary;
  }

  /**
   * Save a single field entry to dictionary
   */
  static async saveEntry(fieldName: string, fieldIndex: number, versionAdded: number): Promise<void> {
    const knex = getKnex();
    
    await knex(this.ENTRIES_TABLE).insert({
      field_name: fieldName,
      field_index: fieldIndex,
      version_added: versionAdded,
      created_at: knex.fn.now()
    });
    
    
  }

  /**
   * Record a delta (new field addition) for sync tracking
   */
  static async saveDelta(fieldName: string, fieldIndex: number, version: number): Promise<number> {
    const knex = getKnex();
    
    const [id] = await knex(this.DELTAS_TABLE).insert({
      version,
      field_name: fieldName,
      field_index: fieldIndex,
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
}
