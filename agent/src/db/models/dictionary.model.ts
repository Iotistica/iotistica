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

import type { DatabaseSync } from 'node:sqlite';
import { getDatabase, transact } from '../sqlite';

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

type DictionaryEntryRow = Omit<DictionaryEntry, 'created_at'> & {
  created_at?: string | Date;
};

type DictionaryDeltaRow = Omit<DictionaryDelta, 'synced_to_cloud' | 'synced_at' | 'created_at'> & {
  synced_to_cloud: number;
  synced_at?: string | Date | null;
  created_at?: string | Date;
};

type DictionaryMetadataRow = Omit<DictionaryMetadata, 'updated_at'> & {
  updated_at?: string | Date;
};

export class DictionaryModel {
	private static readonly ENTRIES_TABLE = 'dictionary_entries';
	private static readonly METADATA_TABLE = 'dictionary_metadata';
	private static readonly DELTAS_TABLE = 'dictionary_deltas';

	private static getDb(): DatabaseSync {
		return getDatabase();
	}

	private static parseDelta(row: DictionaryDeltaRow): DictionaryDelta {
		return {
			...row,
			synced_to_cloud: !!row.synced_to_cloud,
			synced_at: row.synced_at ? new Date(row.synced_at) : undefined,
			created_at: row.created_at ? new Date(row.created_at) : undefined,
		};
	}

	private static now(): string {
		return new Date().toISOString();
	}

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
		const entries = this.getDb()
			.prepare(`SELECT field_name, field_index, domain FROM ${this.ENTRIES_TABLE} ORDER BY field_index ASC`)
			.all() as unknown as Array<Pick<DictionaryEntryRow, 'field_name' | 'field_index' | 'domain'>>;

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
			const domain = (entry.domain || 'key');
			domains[domain].set(entry.field_name, entry.field_index);
		}
    
		return domains;
	}

	/**
   * Save a single field entry to dictionary
   */
	static async saveEntry(fieldName: string, fieldIndex: number, versionAdded: number, domain: DictionaryDomain = 'key'): Promise<void> {
		this.getDb()
			.prepare(`
        INSERT INTO ${this.ENTRIES_TABLE} (field_name, field_index, version_added, domain, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
			.run(fieldName, fieldIndex, versionAdded, domain, this.now());
	}

	/**
   * Record a delta (new field addition) for sync tracking
   */
	static async saveDelta(fieldName: string, fieldIndex: number, version: number, domain: DictionaryDomain = 'metric'): Promise<number> {
		const result = this.getDb()
			.prepare(`
        INSERT INTO ${this.DELTAS_TABLE} (version, field_name, field_index, domain, synced_to_cloud, created_at)
        VALUES (?, ?, ?, ?, 0, ?)
      `)
			.run(version, fieldName, fieldIndex, domain, this.now());

		return Number(result.lastInsertRowid);
	}

	/**
   * Get all deltas not yet synced to cloud
   */
	static async getUnsyncedDeltas(): Promise<DictionaryDelta[]> {
		const deltas = this.getDb()
			.prepare(`SELECT * FROM ${this.DELTAS_TABLE} WHERE synced_to_cloud = 0 ORDER BY version ASC`)
			.all() as unknown as DictionaryDeltaRow[];

		return deltas.map((delta) => this.parseDelta(delta));
	}

	/**
   * Get deltas for a specific version
   */
	static async getDeltasByVersion(version: number): Promise<DictionaryDelta[]> {
		const deltas = this.getDb()
			.prepare(`SELECT * FROM ${this.DELTAS_TABLE} WHERE version = ? ORDER BY field_index ASC`)
			.all(version) as unknown as DictionaryDeltaRow[];

		return deltas.map((delta) => this.parseDelta(delta));
	}

	/**
   * Mark deltas as synced to cloud
   */
	static async markDeltasSynced(deltaIds: number[]): Promise<void> {
		if (deltaIds.length === 0) return;

		const placeholders = deltaIds.map(() => '?').join(', ');
		this.getDb()
			.prepare(`UPDATE ${this.DELTAS_TABLE} SET synced_to_cloud = 1, synced_at = ? WHERE id IN (${placeholders})`)
			.run(this.now(), ...deltaIds);
	}

	/**
   * Mark all deltas up to a version as synced
   */
	static async markDeltasSyncedUpToVersion(version: number): Promise<void> {
		this.getDb()
			.prepare(`UPDATE ${this.DELTAS_TABLE} SET synced_to_cloud = 1, synced_at = ? WHERE version <= ? AND synced_to_cloud = 0`)
			.run(this.now(), version);
	}

	/**
   * Get current dictionary version from metadata
   */
	static async getCurrentVersion(): Promise<number> {
		const result = this.getDb()
			.prepare(`SELECT value FROM ${this.METADATA_TABLE} WHERE key = 'current_version' LIMIT 1`)
			.get() as unknown as Pick<DictionaryMetadataRow, 'value'> | undefined;
    
		return result ? parseInt(result.value, 10) : 1;
	}

	/**
   * Update current dictionary version in metadata
   */
	static async setCurrentVersion(version: number): Promise<void> {
		await this.setMetadata('current_version', version.toString());
	}

	/**
   * Get metadata value by key
   */
	static async getMetadata(key: string): Promise<string | null> {
		const result = this.getDb()
			.prepare(`SELECT value FROM ${this.METADATA_TABLE} WHERE key = ? LIMIT 1`)
			.get(key) as unknown as Pick<DictionaryMetadataRow, 'value'> | undefined;
    
		return result ? result.value : null;
	}

	/**
   * Set metadata value
   */
	static async setMetadata(key: string, value: string): Promise<void> {
		this.getDb()
			.prepare(`
        INSERT INTO ${this.METADATA_TABLE} (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
			.run(key, value, this.now());
	}

	/**
   * Get count of unsynced deltas
   */
	static async getUnsyncedDeltaCount(): Promise<number> {
		const result = this.getDb()
			.prepare(`SELECT COUNT(*) as count FROM ${this.DELTAS_TABLE} WHERE synced_to_cloud = 0`)
			.get() as { count: number | string } | undefined;
    
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
		const db = this.getDb();
		const [entriesCount, deltasCount, unsyncedCount, version, dateRange] = await Promise.all([
			Promise.resolve(db.prepare(`SELECT COUNT(*) as unknown as count FROM ${this.ENTRIES_TABLE}`).get() as { count: number | string } | undefined),
			Promise.resolve(db.prepare(`SELECT COUNT(*) as count FROM ${this.DELTAS_TABLE}`).get() as { count: number | string } | undefined),
			this.getUnsyncedDeltaCount(),
			this.getCurrentVersion(),
			Promise.resolve(
        db.prepare(`SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM ${this.ENTRIES_TABLE}`).get() as { oldest?: string | null; newest?: string | null } | undefined,
			),
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
		const db = this.getDb();
		transact(db, () => {
			db.prepare(`DELETE FROM ${this.DELTAS_TABLE}`).run();
			db.prepare(`DELETE FROM ${this.ENTRIES_TABLE}`).run();
		});
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
		const enumKeys = this.getDb()
			.prepare(`SELECT key, value FROM ${this.METADATA_TABLE} WHERE key LIKE 'enum:%'`)
			.all() as unknown as Array<Pick<DictionaryMetadataRow, 'key' | 'value'>>;
    
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
		const statsKeys = this.getDb()
			.prepare(`SELECT key, value FROM ${this.METADATA_TABLE} WHERE key LIKE 'stats:%'`)
			.all() as unknown as Array<Pick<DictionaryMetadataRow, 'key' | 'value'>>;
    
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
