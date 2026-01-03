import msgpack from 'msgpack-lite';
import { DictionaryModel } from '../db/models/index.js';

/**
 * MQTT Message Dictionary Manager
 * =================================
 * 
 * Fully Dynamic Runtime Dictionary (Schema-Free) - Pattern B with Metrics
 * 
 * Automatically compacts MQTT message keys into numeric indices, reducing bandwidth
 * by 45-70%. New fields are auto-discovered and added to dictionary without code changes.
 * 
 * Features:
 * - Auto-discovery: New fields automatically indexed on first appearance
 * - Versioning: Dictionary version in every payload prevents stale data
 * - Nested objects: Recursive compaction with dot-notation keys
 * - Metrics tracking: Compression stats, anomaly detection
 * - Zero maintenance: Adapts to config changes (Modbus, OPC UA) automatically
 * 
 * ⚠️ CRITICAL INVARIANTS (must never be violated):
 * 1. APPEND-ONLY: Dictionary can only grow, never shrink or reorder
 * 2. MONOTONIC VERSION: Version increments on each field addition, never decrements
 * 3. NO RESET: Dictionary persists for device lifetime (except manual reset())
 * 4. INDEX STABILITY: Once assigned, an index→field mapping never changes
 * 
 * These invariants enable delta sync without full state reconciliation.
 * Violating them will cause silent data corruption in cloud expansion.
 * 
 * Topic Structure:
 * - iot/device/{uuid}/meta/dictionary - Full dictionary sync
 * - iot/device/{uuid}/meta/dictionary/delta - Delta updates
 * - iot/device/{uuid}/endpoints/{sensor} - Original sensor topics (unchanged)
 * 
 * Message Format (Compacted):
 * {
 *   v: 5,                    // Dictionary version
 *   i: [0, 1, 2, 3],        // Field indices
 *   d: [21.5, 1735401234, "active", { temp: 23.1 }]  // Values
 * }
 * 
 * Usage:
 *   const manager = new DictionaryManager(mqttManager, logger, deviceUuid);
 *   await manager.initialize();
 *   
 *   // Compact message (decoupled from publishing)
 *   const original = { temperature: 21.5, timestamp: Date.now(), status: "active" };
 *   const { compacted, compressionRatio } = manager.compact(original);
 *   
 *   // Publish separately (via MqttManager or sensor-publish)
 *   await mqttManager.publish(topic, compacted, options);
 *   
 *   // Check metrics
 *   const stats = manager.getMetrics();
 *   console.log(`Compression: ${stats.avgCompressionRatio}%`);
 * 
 * Environment Variables:
 * - USE_KEY_COMPACTION_POC=true - Enable dictionary compaction
 * - DICTIONARY_ARRAY_MODE=opaque|indexed - Array indexing mode (default: opaque)
 *   - opaque: Use generic [] for arrays (messages[].timestamp) - keeps dictionary small
 *   - indexed: Use specific indices (messages[0].timestamp, messages[1].timestamp) - legacy mode
 * - DICTIONARY_SYNC_INTERVAL_MS=300000 - Full sync interval (default: 5 minutes)
 * - DICTIONARY_DELTA_THRESHOLD=5 - Trigger delta after N new fields (default: 5)
 * - DICTIONARY_DELTA_DEBOUNCE_MS=200 - Debounce window for batching delta updates (default: 200ms)
 * 
 * See: docs/MQTT-KEY-COMPACTION-STRATEGY.md (Alternative 6)
 */

import type { MqttManager } from '../mqtt/manager';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';

/**
 * Dictionary metrics for tracking compression effectiveness
 */
export interface DictionaryMetrics {
  dictionarySize: number;          // Total fields in dictionary
  version: number;                 // Current dictionary version
  updateCount: number;             // Number of dictionary updates
  fieldAdditionRate: number;       // Fields added per hour
  compressionRatio: number;        // Percentage saved (0-100)
  messagesProcessed: number;       // Total messages compacted
  bytesSaved: number;              // Total bandwidth saved (bytes)
  avgCompressionRatio: number;     // Running average compression %
  lastUpdateTime: number;          // Timestamp of last update
}

/**
 * Dictionary Manager - Pattern B (Advanced)
 * Manages field-to-index mapping with automatic discovery and metrics
 */
export class DictionaryManager {
  private dictionary: Map<string, number> = new Map();
  private version = 1;
  private updateCount = 0;
  private lastSyncTime = 0;
  private lastDeltaSync = 0;
  private fieldAdditionTimes: number[] = [];
  
  // Metrics tracking
  private metrics: DictionaryMetrics = {
    dictionarySize: 0,
    version: 1,
    updateCount: 0,
    fieldAdditionRate: 0,
    compressionRatio: 0,
    messagesProcessed: 0,
    bytesSaved: 0,
    avgCompressionRatio: 0,
    lastUpdateTime: Date.now(),
  };
  
  // Running totals for average compression
  private totalOriginalBytes = 0;
  private totalCompactedBytes = 0;
  
  // Configuration
  private readonly syncIntervalMs: number;
  private readonly deltaThreshold: number;
  private readonly deltaSyncDebounceMs: number;
  private readonly deviceUuid: string;
  private readonly enabled: boolean;
  private readonly arrayMode: 'opaque' | 'indexed';
  
  private syncTimer?: NodeJS.Timeout;
  private deltaSyncDebounceTimer?: NodeJS.Timeout;

  constructor(
    private mqttManager: MqttManager,
    private logger?: AgentLogger,
    deviceUuid?: string
  ) {
    this.deviceUuid = deviceUuid || process.env.DEVICE_UUID || 'unknown';
    this.enabled = process.env.USE_KEY_COMPACTION_POC === 'true';
    this.arrayMode = (process.env.DICTIONARY_ARRAY_MODE as 'opaque' | 'indexed') || 'opaque';
    this.syncIntervalMs = parseInt(process.env.DICTIONARY_SYNC_INTERVAL_MS || '300000', 10);
    this.deltaThreshold = parseInt(process.env.DICTIONARY_DELTA_THRESHOLD || '5', 10);
    this.deltaSyncDebounceMs = parseInt(process.env.DICTIONARY_DELTA_DEBOUNCE_MS || '200', 10);
  }

  /**
   * Initialize dictionary manager and start sync timer
   */
  public async initialize(): Promise<void> {
    if (!this.enabled) {
      this.logger?.debugSync('Dictionary compaction disabled (USE_KEY_COMPACTION_POC=false)', {
        component: LogComponents.dictionary,
        operation: 'initialize',
      });
      return;
    }

    // Load existing dictionary from database
    try {
      this.dictionary = await DictionaryModel.loadDictionary();
      this.version = await DictionaryModel.getCurrentVersion();
      
      this.logger?.infoSync('Dictionary loaded from database', {
        component: LogComponents.dictionary,
        operation: 'initialize',
        dictionarySize: this.dictionary.size,
        version: this.version,
        arrayMode: this.arrayMode,
        syncIntervalMs: this.syncIntervalMs,
        deltaThreshold: this.deltaThreshold,
        deviceUuid: this.deviceUuid,
      });

      // Update metrics to match loaded state
      this.metrics.dictionarySize = this.dictionary.size;
      this.metrics.version = this.version;
      this.updateCount = this.dictionary.size; // Approximate - each field is an update
    } catch (error) {
      this.logger?.warnSync('Failed to load dictionary from database, starting fresh', {
        component: LogComponents.dictionary,
        operation: 'initialize',
        error: error instanceof Error ? error.message : String(error)
      });
    }

    // Start periodic full sync
    this.syncTimer = setInterval(() => {
      this.syncFullDictionary().catch((err) => {
        this.logger?.errorSync('Failed to sync dictionary', err, {
          component: LogComponents.dictionary,
          operation: 'syncFullDictionary',
        });
      });
    }, this.syncIntervalMs);

    // Initial sync
    await this.syncFullDictionary();
  }

  /**
   * Shutdown dictionary manager
   */
  public async shutdown(): Promise<void> {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = undefined;
    }

    // Clear debounce timer and trigger final delta sync if pending
    if (this.deltaSyncDebounceTimer) {
      clearTimeout(this.deltaSyncDebounceTimer);
      this.deltaSyncDebounceTimer = undefined;
      
      // Send final delta sync if there are pending updates
      if (this.updateCount > this.lastDeltaSync) {
        await this.syncDeltaDictionary();
      }
    }

    // Final sync
    if (this.enabled && this.dictionary.size > 0) {
      await this.syncFullDictionary();
    }
  }

  /**
   * Get or assign index for a field name (auto-discovery)
   * ✅ FIX: Increment version immediately when new field is added
   * ✅ PERSISTENCE: Save new fields to database immediately
   */
  private getIndex(fieldName: string): number {
    let index = this.dictionary.get(fieldName);
    
    if (index === undefined) {
      // New field - assign next available index
      index = this.dictionary.size;
      this.dictionary.set(fieldName, index);
      this.updateCount++;
      this.fieldAdditionTimes.push(Date.now());
      
      // ✅ FIX: Bump version immediately so compacted messages reference valid dictionary
      this.version++;
      
      this.logger?.infoSync('New field discovered and indexed', {
        component: LogComponents.dictionary,
        operation: 'getIndex',
        fieldName,
        fieldIndex: index,
        version: this.version,
        dictionarySize: this.dictionary.size
      });
      
      // ✅ PERSISTENCE: Save to database immediately (async but fire-and-forget)
      this.persistNewField(fieldName, index, this.version).catch((err) => {
        this.logger?.errorSync('Failed to persist dictionary field to database', err, {
          component: LogComponents.dictionary,
          operation: 'persistNewField',
          fieldName,
          fieldIndex: index
        });
      });
      
      // Keep only last hour of addition times for rate calculation
      const oneHourAgo = Date.now() - 3600000;
      this.fieldAdditionTimes = this.fieldAdditionTimes.filter((t) => t > oneHourAgo);
      
      // ✅ FIX: Update metrics to prevent drift (critical for dashboards)
      this.metrics.dictionarySize = this.dictionary.size;
      this.metrics.version = this.version;
      this.metrics.fieldAdditionRate = this.fieldAdditionTimes.length;
      this.metrics.updateCount = this.updateCount;
      this.metrics.lastUpdateTime = Date.now();
      
      // Trigger debounced delta sync if threshold reached
      // This batches rapid field additions to avoid flooding MQTT
      if (this.updateCount - this.lastDeltaSync >= this.deltaThreshold) {
        this.scheduleDeltaSync();
      }
    }
    
    return index;
  }

  /**
   * Persist new field to database
   */
  private async persistNewField(fieldName: string, fieldIndex: number, version: number): Promise<void> {
    this.logger?.infoSync('Persisting field to database', {
      component: LogComponents.dictionary,
      operation: 'persistNewField',
      fieldName,
      fieldIndex,
      version
    });
    
    try {
      // Save entry
      await DictionaryModel.saveEntry(fieldName, fieldIndex, version);
      this.logger?.debugSync('Dictionary entry saved to database', {
        component: LogComponents.dictionary,
        operation: 'saveEntry',
        fieldName,
        fieldIndex
      });
      
      // Record delta for sync tracking
      const deltaId = await DictionaryModel.saveDelta(fieldName, fieldIndex, version);
      this.logger?.debugSync('Delta record created', {
        component: LogComponents.dictionary,
        operation: 'saveDelta',
        deltaId,
        fieldName,
        fieldIndex,
        version
      });
      
      // Update version in metadata
      await DictionaryModel.setCurrentVersion(version);
      this.logger?.debugSync('Dictionary version updated in metadata', {
        component: LogComponents.dictionary,
        operation: 'setCurrentVersion',
        version
      });
      
      this.logger?.infoSync('Dictionary field successfully persisted to database', {
        component: LogComponents.dictionary,
        operation: 'persistNewField',
        fieldName,
        fieldIndex,
        version,
        deltaId
      });
    } catch (error) {
      this.logger?.errorSync('Failed to persist field to database', error as Error, {
        component: LogComponents.dictionary,
        operation: 'persistNewField',
        fieldName,
        fieldIndex,
        version
      });
      // Re-throw to be caught by caller
      throw error;
    }
  }

  /**
   * Schedule a debounced delta sync
   * Batches rapid field additions within a short time window
   */
  private scheduleDeltaSync(): void {
    // Clear existing debounce timer
    if (this.deltaSyncDebounceTimer) {
      clearTimeout(this.deltaSyncDebounceTimer);
    }

    // Schedule new delta sync after debounce period
    this.deltaSyncDebounceTimer = setTimeout(() => {
      this.syncDeltaDictionary().catch((err) => {
        this.logger?.errorSync('Failed to sync delta dictionary', err, {
          component: LogComponents.dictionary,
          operation: 'syncDeltaDictionary',
        });
      });
      this.deltaSyncDebounceTimer = undefined;
    }, this.deltaSyncDebounceMs);
  }

  /**
   * Compact message using dictionary (recursive for nested objects and arrays)
   * ✅ FIX: Use tuple-based encoding [[index, value], ...] for structure preservation
   * ✅ FIX: Add array framing to preserve boundaries
   */
  private compactWithDictionary(
    data: any,
    prefix = ''
  ): Array<[number, any]> {
    const pairs: Array<[number, any]> = [];

    // Handle null or primitives
    if (data === null || typeof data !== 'object') {
      return [];
    }

    // ✅ FIX: Explicit root array handling (when prefix is empty)
    if (Array.isArray(data)) {
      if (!prefix) {
        // Root-level array - handle explicitly without indexing empty key
        const arrayPairs: Array<Array<[number, any]>> = [];
        
        if (this.arrayMode === 'opaque') {
          data.forEach((item) => {
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
              const itemPairs = this.compactWithDictionary(item, '[]');
              arrayPairs.push(itemPairs);
            } else if (Array.isArray(item)) {
              const nestedPairs = this.compactWithDictionary(item, '[]');
              arrayPairs.push(nestedPairs);
            } else {
              const index = this.getIndex('[]');
              arrayPairs.push([[index, item]]);
            }
          });
        } else {
          data.forEach((item, idx) => {
            const indexedKey = `[${idx}]`;
            if (typeof item === 'object' && item !== null) {
              const itemPairs = this.compactWithDictionary(item, indexedKey);
              arrayPairs.push(itemPairs);
            } else {
              const index = this.getIndex(indexedKey);
              arrayPairs.push([[index, item]]);
            }
          });
        }
        
        // ✅ FIX: Use special '$root' key for root-level arrays
        // Decoder will unwrap this automatically
        pairs.push(['a', '$root', arrayPairs] as any);
        return pairs;
      } else {
        // Non-root array called recursively - this should never happen
        // Arrays should only be processed from the object field handler
        throw new Error('Array handling should be done in parent object context, not recursively');
      }
    }

    // Handle objects
    for (const [key, value] of Object.entries(data)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (Array.isArray(value)) {
        // ✅ FIX: Handle arrays inline - no dictionary entry for array container
        // Only element fields (e.g., "alarms[].code") get indices
        const arrayPairs: Array<Array<[number, any]>> = [];
        
        if (this.arrayMode === 'opaque') {
          value.forEach((item) => {
            if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
              // Object in array - compact with [] notation
              const itemPairs = this.compactWithDictionary(item, `${fullKey}[]`);
              arrayPairs.push(itemPairs);
            } else if (Array.isArray(item)) {
              // Nested array
              const nestedPairs = this.compactWithDictionary(item, `${fullKey}[]`);
              arrayPairs.push(nestedPairs);
            } else {
              // Primitive in array
              const index = this.getIndex(`${fullKey}[]`);
              arrayPairs.push([[index, item]]);
            }
          });
        } else {
          // Indexed mode (legacy)
          value.forEach((item, idx) => {
            const indexedKey = `${fullKey}[${idx}]`;
            if (typeof item === 'object' && item !== null) {
              const itemPairs = this.compactWithDictionary(item, indexedKey);
              arrayPairs.push(itemPairs);
            } else {
              const index = this.getIndex(indexedKey);
              arrayPairs.push([[index, item]]);
            }
          });
        }
        
        // ✅ FIX: Include array key explicitly in frame (no inference needed)
        // Format: ["a", "alarms", [[pairs], [pairs]]]
        pairs.push(['a', key, arrayPairs] as any);
      } else if (typeof value === 'object' && value !== null) {
        // Nested object - recurse
        const nestedPairs = this.compactWithDictionary(value, fullKey);
        pairs.push(...nestedPairs);
      } else {
        // Leaf value - add as tuple [index, value]
        const index = this.getIndex(fullKey);
        pairs.push([index, value]);
      }
    }

    return pairs;
  }

  /**
   * Compact message using dictionary compression
   * Returns compacted data without publishing (decoupled from MQTT)
   */
  public compact(
    message: any
  ): { compacted: any; originalSize: number; compactedSize: number; compressionRatio: number } {
    if (!this.enabled) {
      // Passthrough mode - return original message
      const payload = Buffer.from(JSON.stringify(message), 'utf-8');
      return { 
        compacted: message, 
        originalSize: payload.length, 
        compactedSize: payload.length, 
        compressionRatio: 0 
      };
    }

    this.logger?.debugSync('Starting dictionary compaction', {
      component: LogComponents.dictionary,
      operation: 'compact',
      dictionarySize: this.dictionary.size,
      version: this.version
    });

    // Compact message using tuple-based encoding
    const pairs = this.compactWithDictionary(message);
    const compacted = {
      v: this.version,
      p: pairs,  // Use 'p' for pairs instead of separate 'i' and 'd'
    };

    // Calculate sizes for different compression stages
    const originalJson = JSON.stringify(message);
    const originalSize = Buffer.byteLength(originalJson, 'utf-8');
    
    // Calculate compacted size (JSON format)
    const compactedJson = JSON.stringify(compacted);
    const compactedSize = Buffer.byteLength(compactedJson, 'utf-8');

    const compressionRatio = ((originalSize - compactedSize) / originalSize) * 100;

    // Update metrics
    this.metrics.messagesProcessed++;
    this.metrics.bytesSaved += (originalSize - compactedSize);
    this.totalOriginalBytes += originalSize;
    this.totalCompactedBytes += compactedSize;
    this.metrics.avgCompressionRatio = ((this.totalOriginalBytes - this.totalCompactedBytes) / this.totalOriginalBytes) * 100;

    return { compacted, originalSize, compactedSize, compressionRatio };
  }

  /**
   * Log compression statistics
   * Called externally after publishing (decoupled from compaction)
   */
  public logCompressionStats(
    originalSize: number,
    compactedSize: number,
    compressionRatio: number,
    topic: string
  ): void {
    const useMsgpack = process.env.USE_MSGPACK_POC === 'true';
    const method = useMsgpack ? 'dictionary+msgpack' : 'dictionary';
    
    this.logger?.debugSync(`Message compacted (${method})`, {
      component: LogComponents.sensorPublish,
      operation: 'compact',
      topic,
      sizes: {
        json: originalSize,
        compacted: compactedSize,
      },
      compression: {
        ratio: `${compressionRatio.toFixed(1)}%`,
        bytes_saved: originalSize - compactedSize,
      },
      running_totals: {
        messages: this.metrics.messagesProcessed,
        saved_bytes: this.metrics.bytesSaved,
        avg_compression: `${this.metrics.avgCompressionRatio.toFixed(1)}%`,
      },
      dictionary: {
        version: this.version,
        fields: this.dictionary.size,
      },
    });
  }

  /**
   * Sync full dictionary to cloud
   */
  private async syncFullDictionary(): Promise<void> {
    if (this.dictionary.size === 0) {
      return; // Nothing to sync
    }

    const fields = Array.from(this.dictionary.entries())
      .sort((a, b) => a[1] - b[1]) // Sort by index
      .map(([field]) => field);

    const payload = {
      version: this.version,
      fields,
      deviceUuid: this.deviceUuid,
      timestamp: Date.now(),
    };

    await this.mqttManager.publish(
      `iot/device/${this.deviceUuid}/meta/dictionary`,
      { format: 'json', data: payload },
      { qos: 1, retain: true }
    );

    this.lastSyncTime = Date.now();
    
    // Update metadata
    try {
      await DictionaryModel.setMetadata('last_full_sync', Date.now().toString());
    } catch (error) {
      this.logger?.warnSync('Failed to update last_full_sync metadata', {
        component: LogComponents.dictionary,
        operation: 'syncFullDictionary',
        error: error instanceof Error ? error.message : String(error)
      });
    }

    this.logger?.infoSync('Dictionary synced', {
      component: LogComponents.mqtt,
      operation: 'syncFullDictionary',
      version: this.version,
      fields: fields.length,
    });
  }

  /**
   * Sync delta dictionary updates (new fields only)
   * ✅ FIX: Version already bumped in getIndex(), no need to increment here
   * ✅ PERSISTENCE: Uses database to track unsynced deltas
   */
  private async syncDeltaDictionary(): Promise<void> {
    if (!this.enabled || this.dictionary.size === 0) {
      return;
    }

    try {
      // Get unsynced deltas from database
      this.logger?.debugSync('Querying unsynced deltas from database', {
        component: LogComponents.dictionary,
        operation: 'syncDeltaDictionary'
      });
      
      const unsyncedDeltas = await DictionaryModel.getUnsyncedDeltas();
      
      this.logger?.infoSync('Retrieved unsynced deltas from database', {
        component: LogComponents.dictionary,
        operation: 'getUnsyncedDeltas',
        count: unsyncedDeltas.length,
        deltaIds: unsyncedDeltas.map(d => d.id)
      });
      
      if (unsyncedDeltas.length === 0) {
        this.logger?.debugSync('No unsynced deltas found, skipping sync', {
          component: LogComponents.dictionary,
          operation: 'syncDeltaDictionary'
        });
        return; // No new fields to sync
      }

      // Build payload with new fields
      const newFields = unsyncedDeltas.map(d => d.field_name);
      const payload = {
        version: this.version,
        newFields,
        deviceUuid: this.deviceUuid,
        timestamp: Date.now(),
      };

      // Publish to MQTT
      this.logger?.infoSync('Publishing delta dictionary to MQTT', {
        component: LogComponents.dictionary,
        operation: 'syncDeltaDictionary',
        fieldCount: newFields.length,
        fields: newFields
      });
      
      await this.mqttManager.publish(
        `iot/device/${this.deviceUuid}/meta/dictionary/delta`,
        { format: 'json', data: payload },
        { qos: 1, retain: false }
      );

      // Mark deltas as synced in database
      const deltaIds = unsyncedDeltas.map(d => d.id!).filter(id => id !== undefined);
      this.logger?.debugSync('Marking deltas as synced in database', {
        component: LogComponents.dictionary,
        operation: 'markDeltasSynced',
        deltaIds
      });
      
      await DictionaryModel.markDeltasSynced(deltaIds);
      
      // Update metadata
      await DictionaryModel.setMetadata('last_delta_sync', Date.now().toString());

      this.lastDeltaSync = this.updateCount;

      this.logger?.infoSync('Delta dictionary synced successfully', {
        component: LogComponents.dictionary,
        operation: 'syncDeltaDictionary',
        version: this.version,
        newFields: newFields.length,
        syncedDeltaIds: deltaIds
      });
    } catch (error) {
      this.logger?.errorSync('Failed to sync delta dictionary', error as Error, {
        component: LogComponents.dictionary,
        operation: 'syncDeltaDictionary'
      });
      throw error;
    }
  }

  /**
   * Get current metrics
   */
  public getMetrics(): DictionaryMetrics {
    return { ...this.metrics };
  }

  /**
   * Get dictionary size (number of indexed fields)
   */
  public getDictionarySize(): number {
    return this.dictionary.size;
  }

  /**
   * Get dictionary status
   */
  public getStatus(): {
    enabled: boolean;
    version: number;
    size: number;
    updateCount: number;
    lastSyncTime: number;
  } {
    return {
      enabled: this.enabled,
      version: this.version,
      size: this.dictionary.size,
      updateCount: this.updateCount,
      lastSyncTime: this.lastSyncTime,
    };
  }

  /**
   * Reset dictionary (for testing or manual reset)
   * ✅ PERSISTENCE: Clears database tables
   */
  public async reset(): Promise<void> {
    this.dictionary.clear();
    this.version = 1;
    this.updateCount = 0;
    this.lastDeltaSync = 0;
    this.fieldAdditionTimes = [];
    this.metrics.messagesProcessed = 0;
    this.metrics.bytesSaved = 0;
    this.totalOriginalBytes = 0;
    this.totalCompactedBytes = 0;

    // Clear database
    try {
      await DictionaryModel.clearAll();
      
      this.logger?.warnSync('Dictionary reset (in-memory and database)', {
        component: LogComponents.dictionary,
        operation: 'reset',
        version: this.version,
      });
    } catch (error) {
      this.logger?.errorSync('Failed to reset dictionary in database', error as Error, {
        component: LogComponents.dictionary,
        operation: 'reset'
      });
      throw error;
    }
  }
}
