import msgpack from 'msgpack-lite';

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
 *   // Compact and publish
 *   const original = { temperature: 21.5, timestamp: Date.now(), status: "active" };
 *   const compacted = await manager.compactAndPublish(original, "endpoints/modbus");
 *   
 *   // Check metrics
 *   const stats = manager.getMetrics();
 *   console.log(`Compression: ${stats.avgCompressionRatio}%`);
 * 
 * Environment Variables:
 * - USE_KEY_COMPACTION_POC=true - Enable dictionary compaction
 * - DICTIONARY_SYNC_INTERVAL_MS=300000 - Full sync interval (default: 5 minutes)
 * - DICTIONARY_DELTA_THRESHOLD=5 - Trigger delta after N new fields (default: 5)
 * - DICTIONARY_DELTA_DEBOUNCE_MS=200 - Debounce window for batching delta updates (default: 200ms)
 * 
 * See: docs/MQTT-KEY-COMPACTION-STRATEGY.md (Alternative 6)
 */

import type { MqttManager } from './manager';
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
  
  private syncTimer?: NodeJS.Timeout;
  private deltaSyncDebounceTimer?: NodeJS.Timeout;

  constructor(
    private mqttManager: MqttManager,
    private logger?: AgentLogger,
    deviceUuid?: string
  ) {
    this.deviceUuid = deviceUuid || process.env.DEVICE_UUID || 'unknown';
    this.enabled = process.env.USE_KEY_COMPACTION_POC === 'true';
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
        component: LogComponents.mqtt,
        operation: 'initialize',
      });
      return;
    }

    this.logger?.infoSync('Initializing dictionary manager', {
      component: LogComponents.mqtt,
      operation: 'initialize',
      syncIntervalMs: this.syncIntervalMs,
      deltaThreshold: this.deltaThreshold,
      deviceUuid: this.deviceUuid,
    });

    // Start periodic full sync
    this.syncTimer = setInterval(() => {
      this.syncFullDictionary().catch((err) => {
        this.logger?.errorSync('Failed to sync dictionary', err, {
          component: LogComponents.mqtt,
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
   */
  private getIndex(fieldName: string): number {
    let index = this.dictionary.get(fieldName);
    
    if (index === undefined) {
      // New field - assign next available index
      index = this.dictionary.size;
      this.dictionary.set(fieldName, index);
      this.updateCount++;
      this.fieldAdditionTimes.push(Date.now());
      
      // Keep only last hour of addition times for rate calculation
      const oneHourAgo = Date.now() - 3600000;
      this.fieldAdditionTimes = this.fieldAdditionTimes.filter((t) => t > oneHourAgo);
      
      // Trigger debounced delta sync if threshold reached
      // This batches rapid field additions to avoid flooding MQTT
      if (this.updateCount - this.lastDeltaSync >= this.deltaThreshold) {
        this.scheduleDeltaSync();
      }
    }
    
    return index;
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
          component: LogComponents.mqtt,
          operation: 'syncDeltaDictionary',
        });
      });
      this.deltaSyncDebounceTimer = undefined;
    }, this.deltaSyncDebounceMs);
  }

  /**
   * Compact message using dictionary (recursive for nested objects and arrays)
   */
  private compactWithDictionary(
    data: any,
    prefix = ''
  ): [number[], any[]] {
    const indices: number[] = [];
    const values: any[] = [];

    // Handle null or primitives
    if (data === null || typeof data !== 'object') {
      return [[], []];
    }

    // Handle arrays
    if (Array.isArray(data)) {
      // Iterate over all array elements and assign indices
      // This handles both primitive arrays and object arrays consistently
      data.forEach((item, idx) => {
        const indexedKey = `${prefix}[${idx}]`;
        
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          // Object in array - recurse with indexed key
          const [nestedIndices, nestedValues] = this.compactWithDictionary(item, indexedKey);
          indices.push(...nestedIndices);
          values.push(...nestedValues);
        } else if (Array.isArray(item)) {
          // Nested array - recurse
          const [nestedIndices, nestedValues] = this.compactWithDictionary(item, indexedKey);
          indices.push(...nestedIndices);
          values.push(...nestedValues);
        } else {
          // Primitive in array - store with indexed key
          const index = this.getIndex(indexedKey);
          indices.push(index);
          values.push(item);
        }
      });
      return [indices, values];
    }

    // Handle objects
    for (const [key, value] of Object.entries(data)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;

      if (Array.isArray(value)) {
        // Handle array values (will recurse into compactWithDictionary)
        const [nestedIndices, nestedValues] = this.compactWithDictionary(value, fullKey);
        indices.push(...nestedIndices);
        values.push(...nestedValues);
      } else if (typeof value === 'object' && value !== null) {
        // Nested object - recurse
        const [nestedIndices, nestedValues] = this.compactWithDictionary(value, fullKey);
        indices.push(...nestedIndices);
        values.push(...nestedValues);
      } else {
        // Leaf value - add to dictionary
        const index = this.getIndex(fullKey);
        indices.push(index);
        values.push(value);
      }
    }

    return [indices, values];
  }

  /**
   * Compact message and publish to MQTT
   * Returns compression stats for logging
   */
  public async compactAndPublish(
    message: any,
    endpoint: string
  ): Promise<{ originalSize: number; compactedSize: number; compressionRatio: number }> {
    if (!this.enabled) {
      // Passthrough mode - publish without compaction
      const payload = Buffer.from(JSON.stringify(message), 'utf-8');
      await this.mqttManager.publish(
        `iot/device/${this.deviceUuid}/endpoints/${endpoint}`,
        { format: 'json', data: message },
        { qos: 1, retain: false }
      );
      return { originalSize: payload.length, compactedSize: payload.length, compressionRatio: 0 };
    }

    // Compact message (dictionary compaction: field names → indices)
    const [indices, values] = this.compactWithDictionary(message);
    const compacted = {
      v: this.version,
      i: indices,
      d: values,
    };

    // Calculate sizes for different compression stages
    const originalJson = JSON.stringify(message);
    const originalSize = Buffer.byteLength(originalJson, 'utf-8');
    
    // Use MessagePack if enabled (stacks with dictionary compression)
    const useMsgpack = process.env.USE_MSGPACK_POC === 'true';
    let compactedSize: number;
    let format: 'json' | 'msgpack';
    
    if (useMsgpack) {
      // MessagePack on top of dictionary compaction (best compression)
      const msgpackBuffer = msgpack.encode(compacted);
      compactedSize = msgpackBuffer.length;
      format = 'msgpack';
      
      // Publish with msgpack format
      await this.mqttManager.publish(
        `iot/device/${this.deviceUuid}/endpoints/${endpoint}`,
        { format: 'msgpack', data: compacted },
        { qos: 1, retain: false }
      );
    } else {
      // JSON with dictionary compaction only
      const compactedJson = JSON.stringify(compacted);
      compactedSize = Buffer.byteLength(compactedJson, 'utf-8');
      format = 'json';
      
      // Publish with JSON format
      await this.mqttManager.publish(
        `iot/device/${this.deviceUuid}/endpoints/${endpoint}`,
        { format: 'json', data: compacted },
        { qos: 1, retain: false }
      );
    }

    const compressionRatio = ((originalSize - compactedSize) / originalSize) * 100;

    // Update metrics
    this.metrics.messagesProcessed++;
    this.metrics.bytesSaved += (originalSize - compactedSize);
    this.totalOriginalBytes += originalSize;
    this.totalCompactedBytes += compactedSize;
    this.metrics.avgCompressionRatio = ((this.totalOriginalBytes - this.totalCompactedBytes) / this.totalOriginalBytes) * 100;

    // Log compression stats (shows dictionary + msgpack if enabled)
    this.logCompressionStats(originalSize, compactedSize, compressionRatio, endpoint);

    return { originalSize, compactedSize, compressionRatio };
  }

  /**
   * Log compression statistics (matches MessagePack POC format)
   */
  private logCompressionStats(
    originalSize: number,
    compactedSize: number,
    compressionRatio: number,
    endpoint: string
  ): void {
    const useMsgpack = process.env.USE_MSGPACK_POC === 'true';
    const method = useMsgpack ? 'dictionary+msgpack' : 'dictionary';
    
    this.logger?.infoSync(`Message compacted (${method})`, {
      component: LogComponents.sensorPublish,
      operation: 'compactAndPublish',
      topic: `iot/device/${this.deviceUuid}/endpoints/${endpoint}`,
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

    this.logger?.infoSync('Dictionary synced', {
      component: LogComponents.mqtt,
      operation: 'syncFullDictionary',
      version: this.version,
      fields: fields.length,
    });
  }

  /**
   * Sync delta dictionary updates (new fields only)
   */
  private async syncDeltaDictionary(): Promise<void> {
    const newFieldsSinceLastSync = this.updateCount - this.lastDeltaSync;
    
    if (newFieldsSinceLastSync === 0) {
      return; // No new fields
    }

    // Increment version when dictionary schema changes (new fields added)
    // This ensures cloud can validate message compatibility
    this.version++;

    const allEntries = Array.from(this.dictionary.entries()).sort((a, b) => a[1] - b[1]);
    const newFields = allEntries.slice(-newFieldsSinceLastSync).map(([field]) => field);

    const payload = {
      version: this.version,
      newFields,
      deviceUuid: this.deviceUuid,
      timestamp: Date.now(),
    };

    await this.mqttManager.publish(
      `iot/device/${this.deviceUuid}/meta/dictionary/delta`,
      { format: 'json', data: payload },
      { qos: 1, retain: false }
    );

    this.lastDeltaSync = this.updateCount;

    this.logger?.debugSync('Delta dictionary synced', {
      component: LogComponents.mqtt,
      operation: 'syncDeltaDictionary',
      version: this.version,
      newFields: newFields.length,
    });
  }

  /**
   * Get current metrics
   */
  public getMetrics(): DictionaryMetrics {
    return { ...this.metrics };
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
   */
  public reset(): void {
    this.dictionary.clear();
    this.version++;
    this.updateCount = 0;
    this.lastDeltaSync = 0;
    this.fieldAdditionTimes = [];
    this.metrics.messagesProcessed = 0;
    this.metrics.bytesSaved = 0;
    this.totalOriginalBytes = 0;
    this.totalCompactedBytes = 0;

    this.logger?.warnSync('Dictionary reset', {
      component: LogComponents.mqtt,
      operation: 'reset',
      version: this.version,
    });
  }
}
