/**
 * Device Dictionary PostgreSQL Service
 * 
 * Persists device dictionaries to PostgreSQL for durability and multi-API support.
 * Works alongside Redis cache (Redis = fast lookup, PostgreSQL = durable storage).
 */

import { query } from '../db/connection';
import { createHash } from 'crypto';

export interface DictionaryEntry {
  device_uuid: string;
  field_name: string;
  field_index: number;
  version_added: number;
}

export interface DictionaryMetadata {
  device_uuid: string;
  current_version: number;
  last_full_sync: Date | null;
  last_delta_sync: Date | null;
  dictionary_hash: string | null;
  total_fields: number;
}

export class DeviceDictionaryService {
  /**
   * Load device dictionary from PostgreSQL
   * Returns field map: index → name
   */
  static async loadDictionary(deviceUuid: string): Promise<Record<number, string>> {
    const result = await query(
      `SELECT field_name, field_index 
       FROM device_dictionary_entries 
       WHERE device_uuid = $1 
       ORDER BY field_index ASC`,
      [deviceUuid]
    );

    const fieldMap: Record<number, string> = {};
    for (const row of result.rows) {
      fieldMap[row.field_index] = row.field_name;
    }

    return fieldMap;
  }

  /**
   * Store full dictionary (replaces existing entries)
   */
  static async storeDictionary(
    deviceUuid: string,
    fieldMap: Record<number, string>,
    version: number
  ): Promise<void> {
    // Calculate dictionary hash (SHA-256 of sorted field names)
    const sortedFields = Object.values(fieldMap).sort();
    const dictHash = createHash('sha256')
      .update(JSON.stringify(sortedFields))
      .digest('hex');

    // Delete existing entries
    await query(
      'DELETE FROM device_dictionary_entries WHERE device_uuid = $1',
      [deviceUuid]
    );

    // Insert new entries
    const entries = Object.entries(fieldMap);
    if (entries.length > 0) {
      const values = entries.map(([index, name]) => 
        `('${deviceUuid}', '${name.replace(/'/g, "''")}', ${parseInt(index, 10)}, ${version})`
      ).join(',');
      
      await query(
        `INSERT INTO device_dictionary_entries (device_uuid, field_name, field_index, version_added) 
         VALUES ${values}`
      );
    }

    // Upsert metadata
    await query(
      `INSERT INTO device_dictionary_metadata 
       (device_uuid, current_version, last_full_sync, dictionary_hash, total_fields, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, NOW())
       ON CONFLICT (device_uuid) 
       DO UPDATE SET 
         current_version = $2,
         last_full_sync = NOW(),
         dictionary_hash = $3,
         total_fields = $4,
         updated_at = NOW()`,
      [deviceUuid, version, dictHash, entries.length]
    );
  }

  /**
   * Add delta fields (append to existing dictionary)
   */
  static async addDeltaFields(
    deviceUuid: string,
    newFields: Array<{ name: string; index: number }>,
    version: number
  ): Promise<void> {
    // Insert new entries (skip duplicates)
    if (newFields.length > 0) {
      const values = newFields.map(({ name, index }) => 
        `('${deviceUuid}', '${name.replace(/'/g, "''")}', ${index}, ${version})`
      ).join(',');
      
      await query(
        `INSERT INTO device_dictionary_entries (device_uuid, field_name, field_index, version_added) 
         VALUES ${values}
         ON CONFLICT (device_uuid, field_name) DO NOTHING`
      );
    }

    // Get total field count
    const countResult = await query(
      'SELECT COUNT(*) as count FROM device_dictionary_entries WHERE device_uuid = $1',
      [deviceUuid]
    );
    const totalFields = parseInt(countResult.rows[0]?.count || '0', 10);

    // Recalculate hash
    const fieldsResult = await query(
      'SELECT field_name FROM device_dictionary_entries WHERE device_uuid = $1 ORDER BY field_name ASC',
      [deviceUuid]
    );
    const sortedFields = fieldsResult.rows.map(r => r.field_name).sort();
    const dictHash = createHash('sha256')
      .update(JSON.stringify(sortedFields))
      .digest('hex');

    // Upsert metadata
    await query(
      `INSERT INTO device_dictionary_metadata 
       (device_uuid, current_version, last_delta_sync, dictionary_hash, total_fields, updated_at)
       VALUES ($1, $2, NOW(), $3, $4, NOW())
       ON CONFLICT (device_uuid) 
       DO UPDATE SET 
         current_version = $2,
         last_delta_sync = NOW(),
         dictionary_hash = $3,
         total_fields = $4,
         updated_at = NOW()`,
      [deviceUuid, version, dictHash, totalFields]
    );
  }

  /**
   * Get dictionary metadata
   */
  static async getMetadata(deviceUuid: string): Promise<DictionaryMetadata | null> {
    const result = await query(
      'SELECT * FROM device_dictionary_metadata WHERE device_uuid = $1',
      [deviceUuid]
    );

    return result.rows[0] || null;
  }

  /**
   * Check if dictionary exists for device
   */
  static async exists(deviceUuid: string): Promise<boolean> {
    const result = await query(
      'SELECT COUNT(*) as count FROM device_dictionary_entries WHERE device_uuid = $1',
      [deviceUuid]
    );

    return parseInt(result.rows[0]?.count || '0', 10) > 0;
  }

  /**
   * Delete dictionary for device
   */
  static async deleteDictionary(deviceUuid: string): Promise<void> {
    await query(
      'DELETE FROM device_dictionary_entries WHERE device_uuid = $1',
      [deviceUuid]
    );

    await query(
      'DELETE FROM device_dictionary_metadata WHERE device_uuid = $1',
      [deviceUuid]
    );
  }

  /**
   * Get dictionary statistics
   */
  static async getStats(deviceUuid: string): Promise<{
    totalFields: number;
    currentVersion: number;
    lastSync: Date | null;
    dictionaryHash: string | null;
  } | null> {
    const metadata = await this.getMetadata(deviceUuid);
    
    if (!metadata) {
      return null;
    }

    return {
      totalFields: metadata.total_fields,
      currentVersion: metadata.current_version,
      lastSync: metadata.last_full_sync || metadata.last_delta_sync,
      dictionaryHash: metadata.dictionary_hash
    };
  }
}
