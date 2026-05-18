import { DictionaryModel } from '../db/models/index.js';
import { agentTopic } from './topics.js';

/**
 * MQTT dictionary manager.
 *
 * Compacts payload keys to numeric indices and syncs dictionary state to cloud.
 * Key guarantees:
 * - Append-only index mapping
 * - Monotonic versions with dictionaryVersion <= workingVersion
 * - Payloads always reference dictionaryVersion (cloud-safe)
 */

import type { CloudMqttClient } from './manager.js';
import type { AgentLogger } from '../logging/agent-logger.js';
import { LogComponents } from '../logging/types.js';

/**
 * Domain types for semantic field partitioning
 */
export type DictionaryDomain = 'key' | 'metric' | 'unit' | 'quality' | 'device';

/**
 * Domain-partitioned dictionaries
 */
export interface DomainDictionaries {
  key: Map<string, number>;       // Structural keys: "temperature", "alarms[].code"
  metric: Map<string, number>;    // Semantic metrics: "engine_rpm", "pressure_bar"
  unit: Map<string, number>;      // Engineering units: "RPM", "bar", "°C", "mA", "V"
  quality: Map<string, number>;   // OPC UA qualities: "GOOD", "UNCERTAIN", "BAD"
  device: Map<string, number>;    // Device references: "modbus_slave_3", "gateway_main"
}

/**
 * Field classification with domain and index
 */
export interface FieldClassification {
  fieldName: string;
  domain: DictionaryDomain;
  index: number;
  isNew: boolean;
}

/**
 * Dictionary metrics for tracking compression effectiveness
 */
export interface DictionaryMetrics {
  dictionarySize: number;          // Total fields across all domains
  version: number;                 // Current dictionary version
  updateCount: number;             // Number of dictionary updates
  fieldAdditionRate: number;       // Fields added per hour
  compressionRatio: number;        // Percentage saved (0-100)
  messagesProcessed: number;       // Total messages compacted
  bytesSaved: number;              // Total bandwidth saved (bytes)
  avgCompressionRatio: number;     // Running average compression %
  lastUpdateTime: number;          // Timestamp of last update
  domainStats: Record<DictionaryDomain, number>; // Fields per domain
}

/**
 * Manages domain-partitioned field-to-index mappings and sync lifecycle.
 */
export class DictionaryManager {
	private domains: DomainDictionaries = {
		key: new Map(),
		metric: new Map(),
		unit: new Map(),
		quality: new Map(),
		device: new Map(),
	};

	// Cache domain inference results.
	private domainCache = new Map<string, DictionaryDomain>();

	// Frozen OPC UA quality enum (never changes - hardcoded for safety)
	private readonly QUALITY_ENUM: Record<string, number> = {
		'GOOD': 1,
		'BAD': 2,
		'UNCERTAIN': 3,
		'NOT_CONNECTED': 4,
	};

	// Promoted engineering unit enum (learned from observations)
	private unitEnum: Record<string, number> = {};
	private unitEnumFrozen = false;  // Once frozen, no new values allowed

	// Enum candidate observation (for unit domain only)
	private unitStats: Map<string, { count: number; firstSeen: number }> = new Map();

	// Protocol-aware metadata enums.
	// Namespace metrics/devices by protocol to prevent semantic collisions
	// Promotion thresholds:
	// - qualityCode: 20 observations (bounded set, medium frequency)
	// - metric: 100 observations (many possibilities, high frequency)
	// - device: 10 observations (very stable per edge, high repetition)
  
	// QualityCode enum (global, not protocol-namespaced)
	private qualityCodeEnum: Record<string, number> = {};
	private qualityCodeStats: Map<string, { count: number; firstSeen: number }> = new Map();
	private readonly QUALITY_CODE_THRESHOLD = 20;
  
	// Metric enums (protocol-namespaced: modbus.engine_rpm, snmp.sysUpTime)
	private metricEnums: Record<string, Record<string, number>> = {}; // { modbus: { engine_rpm: 1 } }
	private metricStats: Map<string, { count: number; firstSeen: number; protocol: string }> = new Map();
	private readonly METRIC_THRESHOLD = 50;
  
	// Device enums (protocol-namespaced: modbus.modbus_slave_3, snmp.snmp_device_60)
	private deviceEnums: Record<string, Record<string, number>> = {}; // { modbus: { modbus_slave_3: 5 } }
	private deviceStats: Map<string, { count: number; firstSeen: number; protocol: string }> = new Map();
	private readonly DEVICE_THRESHOLD = 10;

	// Enum stability tracking to reduce observation overhead.
	private qualityCodeEnumStable = false;
	private metricEnumStable = false;
	private deviceEnumStable = false;
	private lastQualityCodePromotion = 0;
	private lastMetricPromotion = 0;
	private lastDevicePromotion = 0;
  
	// Stability criteria:
	// - Enum size exceeds threshold (5 for qualityCode, 20 for metric, 10 for device)
	// - No new promotions for 5 minutes
	private readonly STABILITY_TIME_MS = 5 * 60 * 1000; // 5 minutes
	private readonly QUALITY_CODE_STABILITY_SIZE = 5;
	private readonly METRIC_STABILITY_SIZE = 20;
	private readonly DEVICE_STABILITY_SIZE = 10;

	// Two-version system: protects against noisy payloads exploding version numbers
	// - workingVersion: bumps immediately on discovery (local only, not sent to cloud)
	// - dictionaryVersion: bumps only when full sync succeeds (safe for cloud payloads)
	private workingVersion = 1;      // Internal discovery counter
	private dictionaryVersion = 1;   // Cloud-safe version (dictionaryVersion <= workingVersion always)
  
	private updateCount = 0;
	private lastSyncTime = 0;
	private lastSyncedVersion = 0; // Track last synced dictionaryVersion to avoid redundant syncs
	private lastDeltaSync = 0;
	private fieldAdditionTimes: number[] = [];
	private hasUnsyncedEnumPromotions = false;
  
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
		domainStats: {
			key: 0,
			metric: 0,
			unit: 0,
			quality: 0,
			device: 0,
		},
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
    private mqttManager: CloudMqttClient,
    private logger?: AgentLogger,
    deviceUuid?: string
	) {
		this.deviceUuid = deviceUuid || process.env.DEVICE_UUID || 'unknown';
		this.enabled = process.env.USE_KEY_COMPACTION_POC === 'true';
		this.arrayMode = (process.env.DICTIONARY_ARRAY_MODE as 'opaque' | 'indexed') || 'opaque';
		this.syncIntervalMs = parseInt(process.env.DICTIONARY_SYNC_INTERVAL_MS || '30000', 10); // Default 30s (was 5min)
		this.deltaThreshold = parseInt(process.env.DICTIONARY_DELTA_THRESHOLD || '5', 10);
		this.deltaSyncDebounceMs = parseInt(process.env.DICTIONARY_DELTA_DEBOUNCE_MS || '200', 10);
	}

	/**
   * Load promoted enums and observation counts from database
   */
	private async loadEnumsFromDatabase(): Promise<void> {
		try {
			// Load promoted enums
			const enums = await DictionaryModel.getPromotedEnums();
      
			// Reconstruct enum maps from database
			this.qualityCodeEnum = enums.qualityCodes || {};
			this.metricEnums = enums.metrics || {};
			this.deviceEnums = enums.devices || {};
      
			// Load observation counts (stats)
			const stats = await DictionaryModel.getEnumStats();
      
			// Reconstruct stats maps
			this.qualityCodeStats = new Map(Object.entries(stats.qualityCodes || {}));
			this.metricStats = new Map(Object.entries(stats.metrics || {}));
			this.deviceStats = new Map(Object.entries(stats.devices || {}));
      
			const totalMetrics = this.getTotalPromotedMetrics();
			const totalDevices = this.getTotalPromotedDevices();
			const totalQualityCodes = Object.keys(this.qualityCodeEnum).length;
      
			this.logger?.infoSync('Enums loaded from database', {
				component: LogComponents.dictionary,
				operation: 'loadEnumsFromDatabase',
				promoted: {
					metrics: totalMetrics,
					devices: totalDevices,
					qualityCodes: totalQualityCodes,
				},
				observations: {
					metrics: this.metricStats.size,
					devices: this.deviceStats.size,
					qualityCodes: this.qualityCodeStats.size,
				},
			});
		} catch (error) {
			this.logger?.warnSync('Failed to load enums from database, starting fresh', {
				component: LogComponents.dictionary,
				operation: 'loadEnumsFromDatabase',
				error: error instanceof Error ? error.message : String(error),
			});
			// Continue with empty enums - will rebuild through observations
		}
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
			this.domains = await DictionaryModel.loadDictionary();
			this.dictionaryVersion = await DictionaryModel.getCurrentVersion();
			this.workingVersion = this.dictionaryVersion; // Start in sync
      
			const totalSize = Object.values(this.domains).reduce((sum, map) => sum + map.size, 0);
      
			this.logger?.infoSync('Dictionary loaded from database', {
				component: LogComponents.dictionary,
				operation: 'initialize',
				dictionarySize: totalSize,
				dictionaryVersion: this.dictionaryVersion,
				workingVersion: this.workingVersion,
				arrayMode: this.arrayMode,
				syncIntervalMs: this.syncIntervalMs,
				deltaThreshold: this.deltaThreshold,
				deviceUuid: this.deviceUuid,
				domainBreakdown: {
					key: this.domains.key.size,
					metric: this.domains.metric.size,
					unit: this.domains.unit.size,
					quality: this.domains.quality.size,
					device: this.domains.device.size,
				},
			});

			// Update metrics to match loaded state (use dictionaryVersion for cloud safety)
			this.metrics.dictionarySize = totalSize;
			this.metrics.version = this.dictionaryVersion;
			this.metrics.domainStats = {
				key: this.domains.key.size,
				metric: this.domains.metric.size,
				unit: this.domains.unit.size,
				quality: this.domains.quality.size,
				device: this.domains.device.size,
			};
			this.updateCount = totalSize; // Approximate - each field is an update
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
		if (this.enabled && this.getTotalDictionarySize() > 0) {
			await this.syncFullDictionary();
		}
	}

	/**
   * Check if field should be skipped during dictionary inference
   */
	private shouldSkipField(fieldName: string): boolean {
		// Skip qualityCode fields - they're redundant with quality field
		// qualityCode is now only included in payloads when quality != GOOD (error diagnostics)
		// No need to track in dictionary since quality field is sufficient
		return fieldName.includes('qualityCode');
	}

	/**
   * Infer domain from field name using heuristics
   * Order: Explicit prefixes → Semantic content → Structural markers → Default
   */
	private inferDomain(fieldName: string): DictionaryDomain {
		// Check cache first.
		const cached = this.domainCache.get(fieldName);
		if (cached) return cached;

		// Step 1: Explicit domain prefixes (highest priority)
		if (fieldName.startsWith('quality.')) {
			this.domainCache.set(fieldName, 'quality');
			return 'quality';
		}
		if (fieldName.startsWith('unit.')) {
			this.domainCache.set(fieldName, 'unit');
			return 'unit';
		}
		if (fieldName.startsWith('device.')) {
			this.domainCache.set(fieldName, 'device');
			return 'device';
		}
		if (fieldName.startsWith('metric.')) {
			this.domainCache.set(fieldName, 'metric');
			return 'metric';
		}
		if (fieldName.startsWith('key.')) {
			this.domainCache.set(fieldName, 'key');
			return 'key';
		}

		// Step 2: Semantic content (field name contains semantic meaning)
		// Check if field name ends with quality indicators
		const baseName = this.extractBaseName(fieldName);  // "quality" from "messages[].readings[].quality"
    
		if (this.isQualityField(baseName)) {
			this.domainCache.set(fieldName, 'quality');
			return 'quality';  // "quality", "qualityCode", "status", "state"
		}

		if (this.isUnitField(baseName)) {
			this.domainCache.set(fieldName, 'unit');
			return 'unit';  // "unit", "unitCode", "engineering_unit"
		}

		// Device references
		if (fieldName.includes('_slave_') || fieldName.includes('_gateway_') || 
        baseName.includes('device') || baseName.includes('gateway')) {
			this.domainCache.set(fieldName, 'device');
			return 'device';
		}

		// Step 3: Structural paths (arrays, nested objects) - lowest priority
		if (fieldName.includes('[') || fieldName.includes(']')) {
			this.domainCache.set(fieldName, 'key');
			return 'key'; // Array notation: "messages[]", "readings[]"
		}

		// Step 4: Default semantic metric
		const domain: DictionaryDomain = 'metric';
		this.domainCache.set(fieldName, domain);
		return domain;
	}

	/**
   * Extract the final field name without array notation
   * Examples: "messages[].readings[].quality" → "quality", "device" → "device"
   */
	private extractBaseName(fieldName: string): string {
		// Remove everything before the last dot or bracket
		const lastDot = fieldName.lastIndexOf('.');
		const lastBracket = fieldName.lastIndexOf('[');
		const lastIndex = Math.max(lastDot, lastBracket);
    
		if (lastIndex === -1) return fieldName;
    
		let baseName = fieldName.substring(lastIndex + 1);
		// Remove trailing bracket notation
		baseName = baseName.replace(/\[\]$/g, '');
		return baseName;
	}

	/**
   * Check if field name indicates a quality/status field
   */
	private isQualityField(fieldName: string): boolean {
		const qualityKeywords = ['quality', 'qualityCode', 'code', 'status', 'state', 'condition'];
		const lowerName = fieldName.toLowerCase();
		return qualityKeywords.some(kw => lowerName === kw || lowerName.endsWith(`_${kw}`));
	}

	/**
   * Check if field name indicates a unit field
   */
	private isUnitField(fieldName: string): boolean {
		const unitKeywords = ['unit', 'unitCode', 'engineering_unit', 'unit_of_measure'];
		const lowerName = fieldName.toLowerCase();
		return unitKeywords.some(kw => lowerName === kw || lowerName.endsWith(`_${kw}`));
	}

	/**
   * Check if value is an OPC UA quality code (for reference, not used in field inference)
   */
	private isOpcUaQuality(value: string): boolean {
		const qualityCodes = ['GOOD', 'BAD', 'UNCERTAIN', 'NOT_CONNECTED'];
		return qualityCodes.includes(value);
	}

	/**
   * Check if value is an engineering unit
   */
	private isEngineeringUnit(value: string): boolean {
		const units = [
			'RPM', 'bar', 'Pa', 'kPa', 'MPa', '°C', '°F', 'K',
			'V', 'mV', 'A', 'mA', 'W', 'kW', 'MW', 'Wh', 'kWh',
			'Hz', 'kHz', 'MHz', 'L', 'mL', 'L/min', 'm3/h',
			'%', 'ppm', 'ppb', 'dB', 'dBm',
		];
		return units.includes(value);
	}

	/**
   * Encode enum values for quality and unit domains
   * Quality: hardcoded frozen enum (always safe)
   * Unit: learned enum (promoted after observation)
   */
	private encodeEnumValue(fieldName: string, value: any): any {
		// Only encode strings in enum-eligible domains
		if (typeof value !== 'string') return value;
		if (value.length > 16) return value;  // Skip free text

		// Check which domain this field belongs to
		const domain = this.inferDomain(fieldName);

		// Quality domain uses the frozen OPC UA enum.
		if (domain === 'quality') {
			const enumIndex = this.QUALITY_ENUM[value];
			if (enumIndex !== undefined) {
				return enumIndex;  // Replace "GOOD" with 1
			}
			// Unknown quality code - return raw (safety)
			this.logger?.warnSync(`Unknown quality code: ${value}`, {
				component: LogComponents.dictionary,
				operation: 'encodeEnumValue',
				value
			});
			return value;
		}

		// Unit domain uses promoted enum values when available.
		if (domain === 'unit') {
			// Observe for promotion (if not frozen)
			if (!this.unitEnumFrozen) {
				this.observeUnitCandidate(value);
			}

			// If enum is frozen and value is known, encode it
			if (this.unitEnumFrozen && this.unitEnum[value] !== undefined) {
				return this.unitEnum[value];  // Replace "RPM" with 1
			}

			// Not frozen yet, or unknown value - return raw
			return value;
		}

		// Other domains: no enum encoding
		return value;
	}

	/**
   * Observe unit value for enum promotion
   */
	private observeUnitCandidate(value: string): void {
		const stats = this.unitStats.get(value) || { count: 0, firstSeen: Date.now() };
		stats.count++;
		this.unitStats.set(value, stats);

		// Check if we should promote to enum
		if (this.shouldPromoteUnitEnum()) {
			this.promoteUnitEnum();
		}
	}

	/**
   * Check if unit values should be promoted to enum
   * Criteria: low cardinality (≤5), high frequency (≥100 each), short strings
   */
	private shouldPromoteUnitEnum(): boolean {
		if (this.unitEnumFrozen) return false;  // Already promoted

		const values = Array.from(this.unitStats.keys());
		if (values.length === 0 || values.length > 5) return false;  // Low cardinality check

		// All values must be seen ≥100 times
		return values.every(v => {
			const stats = this.unitStats.get(v)!;
			return stats.count >= 100;
		});
	}

	/**
   * Promote unit values to frozen enum
   */
	private promoteUnitEnum(): void {
		const values = Array.from(this.unitStats.keys()).sort();  // Deterministic order
    
		values.forEach((value, index) => {
			this.unitEnum[value] = index + 1;  // Start at 1 (0 reserved for null)
		});

		this.unitEnumFrozen = true;

		this.logger?.infoSync('Unit enum promoted', {
			component: LogComponents.dictionary,
			operation: 'promoteUnitEnum',
			values,
			enum: this.unitEnum
		});
	}

	// Protocol-aware enum methods.

	/**
   * Observe and potentially promote qualityCode value to enum
   * Threshold: 20 observations (bounded set, medium frequency)
   */
	private async observeQualityCode(value: string | undefined): Promise<void> {
		if (!value || typeof value !== 'string') return;
    
		// Fast path when enum is stable.
		if (this.qualityCodeEnumStable) return;
    
		// Skip if already promoted (no need to continue counting)
		if (this.qualityCodeEnum[value]) return;
    
		const stats = this.qualityCodeStats.get(value) || { count: 0, firstSeen: Date.now() };
		stats.count++;
		this.qualityCodeStats.set(value, stats);

		// Persist stats every 10th count (reduce DB writes)
		if (stats.count % 10 === 0) {
			try {
				await DictionaryModel.saveEnumStats('qualityCode', undefined, value, stats.count, stats.firstSeen);
			} catch (_error) {
				// Silently fail - stats are in memory
			}
		}

		// Log only at milestones: first, every 10th, and at threshold
		if (stats.count === 1 || stats.count === this.QUALITY_CODE_THRESHOLD || stats.count % 10 === 0) {
			this.logger?.infoSync('QualityCode observation', {
				component: LogComponents.dictionary,
				value,
				count: stats.count,
				threshold: this.QUALITY_CODE_THRESHOLD
			});
		}

		// Check promotion threshold (use >= to handle race conditions)
		if (stats.count >= this.QUALITY_CODE_THRESHOLD && !this.qualityCodeEnum[value]) {
			await this.promoteQualityCode(value);
		}
	}

	/**
   * Promote qualityCode value to enum (immutable index assignment)
   */
	private async promoteQualityCode(value: string): Promise<void> {
		const nextIndex = Object.keys(this.qualityCodeEnum).length + 1;
		this.qualityCodeEnum[value] = nextIndex;
		this.lastQualityCodePromotion = Date.now();

		this.logger?.infoSync('QualityCode promoted to enum', {
			component: LogComponents.dictionary,
			operation: 'promoteQualityCode',
			value,
			index: nextIndex,
			observations: this.qualityCodeStats.get(value)?.count
		});

		// Check if enum is now stable
		this.checkQualityCodeStability();

		// Persist to database
		try {
			await DictionaryModel.savePromotedEnum('qualityCode', undefined, value, nextIndex);
		} catch (error) {
			this.logger?.errorSync('Failed to persist qualityCode enum', error instanceof Error ? error : undefined, {
				component: LogComponents.dictionary,
				operation: 'promoteQualityCode',
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
   * Observe and potentially promote metric value to enum
   * Threshold: 100 observations per protocol namespace
   */
	private async observeMetric(protocol: string | undefined, metric: string): Promise<void> {
		if (!protocol) return;  // Skip if no protocol context
    
		// Fast path when enum is stable.
		if (this.metricEnumStable) return;
    
		// Skip if already promoted (no need to continue counting)
		if (this.metricEnums[protocol]?.[metric]) return;
    
		const key = `${protocol}:${metric}`;
		const stats = this.metricStats.get(key) || { count: 0, firstSeen: Date.now(), protocol };
		stats.count++;
		this.metricStats.set(key, stats);

		// Persist stats every 10th count (reduce DB writes)
		if (stats.count % 10 === 0) {
			try {
				await DictionaryModel.saveEnumStats('metric', protocol, metric, stats.count, stats.firstSeen);
			} catch (_error) {
				// Silently fail - stats are in memory
			}
		}

		// Log only at milestones: first, every 10th, and at threshold
		if (stats.count === 1 || stats.count === this.METRIC_THRESHOLD || stats.count % 10 === 0) {
			this.logger?.infoSync('Metric observation', {
				component: LogComponents.dictionary,
				protocol,
				metric,
				count: stats.count,
				threshold: this.METRIC_THRESHOLD
			});
		}

		// Check promotion threshold (use >= to handle race conditions)
		if (stats.count >= this.METRIC_THRESHOLD && !this.metricEnums[protocol]?.[metric]) {
			await this.promoteMetric(protocol, metric);
		}
	}

	/**
   * Promote metric to protocol-namespaced enum
   */
	private async promoteMetric(protocol: string, metric: string): Promise<void> {
		if (!this.metricEnums[protocol]) {
			this.metricEnums[protocol] = {};
		}

		// Check if already promoted (avoid duplicates)
		if (this.metricEnums[protocol][metric]) return;

		const nextIndex = Object.keys(this.metricEnums[protocol]).length + 1;
		this.metricEnums[protocol][metric] = nextIndex;
		this.lastMetricPromotion = Date.now();

		// Mark that we have unsynced enum promotions
		this.hasUnsyncedEnumPromotions = true;

		this.logger?.infoSync('Metric promoted to enum', {
			component: LogComponents.dictionary,
			operation: 'promoteMetric',
			protocol,
			metric,
			index: nextIndex,
			observations: this.metricStats.get(`${protocol}:${metric}`)?.count
		});

		// Check if enum is now stable
		this.checkMetricStability();

		// Trigger delta sync to publish promoted enums
		this.scheduleDeltaSync();

		// Persist to database
		try {
			await DictionaryModel.savePromotedEnum('metric', protocol, metric, nextIndex);
		} catch (error) {
			this.logger?.errorSync('Failed to persist metric enum', error instanceof Error ? error : undefined, {
				component: LogComponents.dictionary,
				operation: 'promoteMetric',
				protocol,
				metric,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
   * Observe and potentially promote device name to enum
   * Threshold: 10 observations per protocol namespace (low threshold - very stable)
   */
	private async observeDevice(protocol: string | undefined, deviceName: string): Promise<void> {
		if (!protocol) return;  // Skip if no protocol context
    
		// Fast path when enum is stable.
		if (this.deviceEnumStable) return;
    
		// Skip if already promoted (no need to continue counting)
		if (this.deviceEnums[protocol]?.[deviceName]) {
			this.logger?.debugSync('Device already promoted, skipping observation', {
				component: LogComponents.dictionary,
				protocol,
				deviceName,
				index: this.deviceEnums[protocol][deviceName]
			});
			return;
		}
    
		const key = `${protocol}:${deviceName}`;
		const stats = this.deviceStats.get(key) || { count: 0, firstSeen: Date.now(), protocol };
		stats.count++;
		this.deviceStats.set(key, stats);

		// Persist stats every 10th count (reduce DB writes)
		if (stats.count % 10 === 0) {
			try {
				await DictionaryModel.saveEnumStats('device', protocol, deviceName, stats.count, stats.firstSeen);
			} catch (_error) {
				// Silently fail - stats are in memory
			}
		}

		// Log only at milestones: first, every 10th, and at threshold
		if (stats.count === 1 || stats.count === this.DEVICE_THRESHOLD || stats.count % 10 === 0) {
			this.logger?.infoSync('Device observation', {
				component: LogComponents.dictionary,
				protocol,
				deviceName,
				count: stats.count,
				threshold: this.DEVICE_THRESHOLD
			});
		}

		// Check promotion threshold (use >= to handle race conditions)
		if (stats.count >= this.DEVICE_THRESHOLD && !this.deviceEnums[protocol]?.[deviceName]) {
			this.logger?.infoSync('Device threshold reached, promoting', {
				component: LogComponents.dictionary,
				protocol,
				deviceName,
				count: stats.count,
				threshold: this.DEVICE_THRESHOLD
			});
			await this.promoteDevice(protocol, deviceName);
			this.logger?.infoSync('Device promotion complete', {
				component: LogComponents.dictionary,
				protocol,
				deviceName,
				index: this.deviceEnums[protocol]?.[deviceName]
			});
		}
	}

	/**
   * Promote device to protocol-namespaced enum
   */
	private async promoteDevice(protocol: string, deviceName: string): Promise<void> {
		if (!this.deviceEnums[protocol]) {
			this.deviceEnums[protocol] = {};
		}

		// Check if already promoted
		if (this.deviceEnums[protocol][deviceName]) return;

		const nextIndex = Object.keys(this.deviceEnums[protocol]).length + 1;
		this.deviceEnums[protocol][deviceName] = nextIndex;
		this.lastDevicePromotion = Date.now();

		// Mark that we have unsynced enum promotions
		this.hasUnsyncedEnumPromotions = true;

		this.logger?.infoSync('Device promoted to enum', {
			component: LogComponents.dictionary,
			operation: 'promoteDevice',
			protocol,
			deviceName,
			index: nextIndex,
			observations: this.deviceStats.get(`${protocol}:${deviceName}`)?.count
		});

		// Check if enum is now stable
		this.checkDeviceStability();

		// Trigger delta sync to publish promoted enums
		this.scheduleDeltaSync();

		// Persist to database
		try {
			await DictionaryModel.savePromotedEnum('device', protocol, deviceName, nextIndex);
		} catch (error) {
			this.logger?.errorSync('Failed to persist device enum', error instanceof Error ? error : undefined, {
				component: LogComponents.dictionary,
				operation: 'promoteDevice',
				protocol,
				deviceName,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
   * Check if quality code enum has stabilized
   * Stability criteria: size >= 5 AND no promotions for 5 minutes
   * Once stable, observation is disabled for performance
   */
	private checkQualityCodeStability(): void {
		if (this.qualityCodeEnumStable) return;
    
		const enumSize = Object.keys(this.qualityCodeEnum).length;
		const timeSinceLastPromotion = Date.now() - this.lastQualityCodePromotion;
    
		if (enumSize >= this.QUALITY_CODE_STABILITY_SIZE && 
        timeSinceLastPromotion >= this.STABILITY_TIME_MS) {
			this.qualityCodeEnumStable = true;
			this.logger?.infoSync('QualityCode enum marked as stable - observation disabled', {
				component: LogComponents.dictionary,
				operation: 'checkQualityCodeStability',
				enumSize,
				minutesSinceLastPromotion: Math.round(timeSinceLastPromotion / 60000)
			});
		}
	}

	/**
   * Check if metric enums have stabilized across all protocols
   * Stability criteria: total size >= 20 AND no promotions for 5 minutes
   * Once stable, observation is disabled for performance
   */
	private checkMetricStability(): void {
		if (this.metricEnumStable) return;
    
		// Count total metrics across all protocols
		let totalMetrics = 0;
		for (const protocolEnums of Object.values(this.metricEnums)) {
			totalMetrics += Object.keys(protocolEnums).length;
		}
    
		const timeSinceLastPromotion = Date.now() - this.lastMetricPromotion;
    
		if (totalMetrics >= this.METRIC_STABILITY_SIZE && 
        timeSinceLastPromotion >= this.STABILITY_TIME_MS) {
			this.metricEnumStable = true;
			this.logger?.infoSync('Metric enum marked as stable - observation disabled', {
				component: LogComponents.dictionary,
				operation: 'checkMetricStability',
				totalMetrics,
				protocols: Object.keys(this.metricEnums).length,
				minutesSinceLastPromotion: Math.round(timeSinceLastPromotion / 60000)
			});
		}
	}

	/**
   * Check if device enums have stabilized across all protocols
   * Stability criteria: total size >= 10 AND no promotions for 5 minutes
   * Once stable, observation is disabled for performance
   */
	private checkDeviceStability(): void {
		if (this.deviceEnumStable) return;
    
		// Count total devices across all protocols
		let totalDevices = 0;
		for (const protocolEnums of Object.values(this.deviceEnums)) {
			totalDevices += Object.keys(protocolEnums).length;
		}
    
		const timeSinceLastPromotion = Date.now() - this.lastDevicePromotion;
    
		if (totalDevices >= this.DEVICE_STABILITY_SIZE && 
        timeSinceLastPromotion >= this.STABILITY_TIME_MS) {
			this.deviceEnumStable = true;
			this.logger?.infoSync('Device enum marked as stable - observation disabled', {
				component: LogComponents.dictionary,
				operation: 'checkDeviceStability',
				totalDevices,
				protocols: Object.keys(this.deviceEnums).length,
				minutesSinceLastPromotion: Math.round(timeSinceLastPromotion / 60000)
			});
		}
	}

	/**
   * Encode metadata field value using protocol-aware enums
   * Returns enum index if promoted, otherwise raw value
   */
	private encodeMetadataValue(
		fieldType: 'qualityCode' | 'metric' | 'device',
		protocol: string | undefined,
		value: string
	): string | number {
		switch (fieldType) {
			case 'qualityCode':
				return this.qualityCodeEnum[value] ?? value;
      
			case 'metric':
				if (!protocol) return value;
				return this.metricEnums[protocol]?.[value] ?? value;
      
			case 'device':
				if (!protocol) return value;
				return this.deviceEnums[protocol]?.[value] ?? value;
      
			default:
				return value;
		}
	}

	/**
   * Get total dictionary size across all domains
   */
	private getTotalDictionarySize(): number {
		return Object.values(this.domains).reduce((sum, map) => sum + map.size, 0);
	}

	/**
   * Get or assign index for a field name (auto-discovery with domain inference)
   */
	private getIndex(fieldName: string): number {
		// Skip qualityCode fields - they're redundant with quality field
		if (this.shouldSkipField(fieldName)) {
			return -1;  // Signal to skip this field
		}

		const domain = this.inferDomain(fieldName);
		let index = this.domains[domain].get(fieldName);
    
		if (index === undefined) {
			// New field - assign next available index within domain
			index = this.domains[domain].size;
			this.domains[domain].set(fieldName, index);
			this.updateCount++;
			this.fieldAdditionTimes.push(Date.now());
      
			// Bump workingVersion (internal), not dictionaryVersion.
			// dictionaryVersion only bumps on successful cloud sync
			// This prevents noisy payloads from exploding version numbers on cloud
			this.workingVersion++;
      
			this.logger?.infoSync('New field discovered and indexed', {
				component: LogComponents.dictionary,
				operation: 'getIndex',
				fieldName,
				domain,
				fieldIndex: index,
				workingVersion: this.workingVersion,
				dictionaryVersion: this.dictionaryVersion,
				dictionaryVersionGap: this.workingVersion - this.dictionaryVersion,
				totalSize: this.getTotalDictionarySize()
			});
      
			// Save immediately (fire-and-forget).
			this.persistNewField(fieldName, index, this.workingVersion, domain).catch((err) => {
				this.logger?.errorSync('Failed to persist dictionary field to database', err, {
					component: LogComponents.dictionary,
					operation: 'persistNewField',
					fieldName,
					domain,
					fieldIndex: index
				});
			});
      
			// Keep only last hour of addition times for rate calculation
			const oneHourAgo = Date.now() - 3600000;
			this.fieldAdditionTimes = this.fieldAdditionTimes.filter((t) => t > oneHourAgo);
      
			// Keep metrics aligned with current state.
			const totalSize = this.getTotalDictionarySize();
			this.metrics.dictionarySize = totalSize;
			this.metrics.version = this.dictionaryVersion; // Metrics use dictionaryVersion (cloud-safe)
			this.metrics.fieldAdditionRate = this.fieldAdditionTimes.length;
			this.metrics.updateCount = this.updateCount;
			this.metrics.lastUpdateTime = Date.now();
			this.metrics.domainStats = {
				key: this.domains.key.size,
				metric: this.domains.metric.size,
				unit: this.domains.unit.size,
				quality: this.domains.quality.size,
				device: this.domains.device.size,
			};
      
			// Trigger debounced delta sync if threshold reached
			// This batches rapid field additions to avoid flooding MQTT
			if (this.updateCount - this.lastDeltaSync >= this.deltaThreshold) {
				this.scheduleDeltaSync();
			}
		}
    
		return index;
	}

	/**
   * Persist new field to database with domain
   */
	private async persistNewField(fieldName: string, fieldIndex: number, version: number, domain: DictionaryDomain): Promise<void> {
		this.logger?.infoSync('Persisting field to database', {
			component: LogComponents.dictionary,
			operation: 'persistNewField',
			fieldName,
			domain,
			fieldIndex,
			version
		});
    
		try {
			// Save entry with domain
			await DictionaryModel.saveEntry(fieldName, fieldIndex, version, domain);
			this.logger?.debugSync('Dictionary entry saved to database', {
				component: LogComponents.dictionary,
				operation: 'saveEntry',
				fieldName,
				domain,
				fieldIndex
			});
      
			// Record delta for sync tracking with domain
			const deltaId = await DictionaryModel.saveDelta(fieldName, fieldIndex, version, domain);
			this.logger?.debugSync('Delta record created', {
				component: LogComponents.dictionary,
				operation: 'saveDelta',
				deltaId,
				fieldName,
				domain,
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
				domain,
				fieldIndex,
				version,
				deltaId
			});
		} catch (error) {
			this.logger?.errorSync('Failed to persist field to database', error as Error, {
				component: LogComponents.dictionary,
				operation: 'persistNewField',
				fieldName,
				domain,
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
   */
	private async compactWithDictionary(
		data: any,
		prefix = '',
		protocol?: string  // Protocol context for inline metadata observation
	): Promise<Array<[number, any]>> {
		const pairs: Array<[number, any]> = [];

		// Handle null or primitives
		if (data === null || typeof data !== 'object') {
			return [];
		}

		// Explicit root array handling.
		if (Array.isArray(data)) {
			if (!prefix) {
				// Root-level array - handle explicitly without indexing empty key
				const arrayPairs: Array<Array<[number, any]>> = [];
        
				if (this.arrayMode === 'opaque') {
					for (const item of data) {
						if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
							const itemPairs = await this.compactWithDictionary(item, '[]', protocol);
							arrayPairs.push(itemPairs);
						} else if (Array.isArray(item)) {
							const nestedPairs = await this.compactWithDictionary(item, '[]', protocol);
							arrayPairs.push(nestedPairs);
						} else {
							const index = this.getIndex('[]');
							arrayPairs.push([[index, item]]);
						}
					}
				} else {
					for (const [idx, item] of data.entries()) {
						const indexedKey = `[${idx}]`;
						if (typeof item === 'object' && item !== null) {
							const itemPairs = await this.compactWithDictionary(item, indexedKey, protocol);
							arrayPairs.push(itemPairs);
						} else {
							const index = this.getIndex(indexedKey);
							arrayPairs.push([[index, item]]);
						}
					}
				}
        
				// Use a special key for root-level arrays.
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

			// Inline metadata observation.
			// Observe metadata fields during compaction to eliminate separate traversal
			if (key === 'metric' && typeof value === 'string' && protocol) {
				await this.observeMetric(protocol, value);
				// Encode if promoted (replace string with index)
				const encodedValue = this.encodeMetadataValue('metric', protocol, value);
				const index = this.getIndex(fullKey);
				if (index !== -1) {
					pairs.push([index, encodedValue]);
				}
				continue; // Skip normal processing
			} else if (key === 'deviceName' && typeof value === 'string' && protocol) {
				await this.observeDevice(protocol, value);
				// Encode if promoted (replace string with index)
				const encodedValue = this.encodeMetadataValue('device', protocol, value);
				const index = this.getIndex(fullKey);
				if (index !== -1) {
					pairs.push([index, encodedValue]);
				}
				continue; // Skip normal processing
			} else if (key === 'qualityCode' && typeof value === 'string') {
				await this.observeQualityCode(value);
				// Encode if promoted (replace string with index)
				const encodedValue = this.encodeMetadataValue('qualityCode', undefined, value);
				const index = this.getIndex(fullKey);
				if (index !== -1) {
					pairs.push([index, encodedValue]);
				}
				continue; // Skip normal processing
			}

			if (Array.isArray(value)) {
				// Handle arrays inline; do not index the container key.
				// Only element fields (e.g., "alarms[].code") get indices
				const arrayPairs: Array<Array<[number, any]>> = [];
        
				if (this.arrayMode === 'opaque') {
					for (const item of value) {
						if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
							// Object in array - compact with [] notation
							const itemPairs = await this.compactWithDictionary(item, `${fullKey}[]`, protocol);
							arrayPairs.push(itemPairs);
						} else if (Array.isArray(item)) {
							// Nested array
							const nestedPairs = await this.compactWithDictionary(item, `${fullKey}[]`, protocol);
							arrayPairs.push(nestedPairs);
						} else {
							// Primitive in array
							const index = this.getIndex(`${fullKey}[]`);
							arrayPairs.push([[index, item]]);
						}
					}
				} else {
					// Indexed mode (legacy)
					for (const [idx, item] of value.entries()) {
						const indexedKey = `${fullKey}[${idx}]`;
						if (typeof item === 'object' && item !== null) {
							const itemPairs = await this.compactWithDictionary(item, indexedKey, protocol);
							arrayPairs.push(itemPairs);
						} else {
							const index = this.getIndex(indexedKey);
							arrayPairs.push([[index, item]]);
						}
					}
				}
        
				// Include array key explicitly in the frame.
				// Format: ["a", "alarms", [[pairs], [pairs]]]
				pairs.push(['a', key, arrayPairs] as any);
			} else if (typeof value === 'object' && value !== null) {
				// Nested object - recurse
				const nestedPairs = await this.compactWithDictionary(value, fullKey, protocol);
				pairs.push(...nestedPairs);
			} else {
				// Leaf value - encode with enum if applicable
				const index = this.getIndex(fullKey);
				if (index === -1) continue;  // Skip qualityCode fields
				const encodedValue = this.encodeEnumValue(fullKey, value);
				pairs.push([index, encodedValue]);
			}
		}

		return pairs;
	}

	/**
   * Compact message using dictionary compression
   * Returns compacted data without publishing (decoupled from MQTT)
   */
	/**
   * Observe message metadata fields for frequency tracking and enum promotion
   * Extracts protocol-specific metrics/devices and qualityCode values
   */
	private async observeMessageMetadata(message: any, protocol?: string): Promise<void> {
		if (!message || typeof message !== 'object') return;

		// Recursively extract metrics, devices, and qualityCodes from nested structure
		await this.extractMetadataRecursive(message, protocol);
	}

	/**
   * Recursively extract metadata fields for observation AND encode promoted values
   */
	private async extractMetadataRecursive(obj: any, protocol?: string, path: string = ''): Promise<void> {
		if (!obj || typeof obj !== 'object') return;

		if (Array.isArray(obj)) {
			// Process array elements
			for (const item of obj) {
				await this.extractMetadataRecursive(item, protocol, `${path}[]`);
			}
			return;
		}

		// Process object properties
		for (const [key, value] of Object.entries(obj)) {
			const fullPath = path ? `${path}.${key}` : key;

			// Check for metadata fields - observe AND encode
			if (key === 'metric' && typeof value === 'string' && protocol) {
				await this.observeMetric(protocol, value);
				// Encode if promoted (replace string with index)
				obj[key] = this.encodeMetadataValue('metric', protocol, value);
			} else if (key === 'deviceName' && typeof value === 'string' && protocol) {
				await this.observeDevice(protocol, value);
				// Encode if promoted (replace string with index)
				obj[key] = this.encodeMetadataValue('device', protocol, value);
			} else if (key === 'qualityCode' && typeof value === 'string') {
				await this.observeQualityCode(value);
				// Encode if promoted (replace string with index)
				obj[key] = this.encodeMetadataValue('qualityCode', undefined, value);
			} else if (typeof value === 'object' && value !== null) {
				// Recurse into nested objects/arrays
				await this.extractMetadataRecursive(value, protocol, fullPath);
			}
		}
	}

	public async compact(
		message: any,
		protocol?: string  // Protocol context for enum namespacing
	): Promise<{ compacted: any; originalSize: number; compactedSize: number; compressionRatio: number }> {
		if (!this.enabled) {
			// Passthrough mode - return original message
			this.logger?.warnSync('Dictionary compaction disabled - USE_KEY_COMPACTION_POC must be true', {
				component: LogComponents.dictionary,
				operation: 'compact',
				enabled: this.enabled
			});
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
			dictionarySize: this.getTotalDictionarySize(),
			dictionaryVersion: this.dictionaryVersion,
			protocol
		});

		// Compact message using tuple-based encoding.
		const pairs = await this.compactWithDictionary(message, '', protocol);
		// Use dictionaryVersion (cloud-safe), not workingVersion.
		const compacted = {
			v: this.dictionaryVersion,  // Cloud safe - cloud has this version
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
			component: LogComponents.devicePublish,
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
				dictionaryVersion: this.dictionaryVersion,
				workingVersion: this.workingVersion,
				fields: this.getTotalDictionarySize(),
			},
		});
	}

	/**
   * Sync full dictionary to cloud
   */
	/**
   * Save promoted enum to database
   */
	private async saveEnumToDatabase(
		type: 'metric' | 'device' | 'qualityCode',
		protocol: string | undefined,
		value: string,
		index: number
	): Promise<void> {
		try {
			await DictionaryModel.savePromotedEnum(type, protocol, value, index);
		} catch (error) {
			this.logger?.errorSync('Failed to save enum to database', error instanceof Error ? error : undefined, {
				component: LogComponents.dictionary,
				operation: 'saveEnumToDatabase',
				type,
				protocol,
				value,
				index,
				error: error instanceof Error ? error.message : String(error),
			});
			// Continue - enum is in memory, will sync via full dictionary if needed
		}
	}

	/**
   * Count total promoted metrics across all protocols
   */
	private getTotalPromotedMetrics(): number {
		return Object.values(this.metricEnums)
			.reduce((total, protocolMetrics) => total + Object.keys(protocolMetrics).length, 0);
	}

	/**
   * Count total promoted devices across all protocols
   */
	private getTotalPromotedDevices(): number {
		return Object.values(this.deviceEnums)
			.reduce((total, protocolDevices) => total + Object.keys(protocolDevices).length, 0);
	}

	private async syncFullDictionary(): Promise<void> {
		const totalSize = this.getTotalDictionarySize();
		if (totalSize === 0) {
			return; // Nothing to sync
		}

		// Skip sync if dictionaryVersion hasn't changed since last sync
		if (this.dictionaryVersion === this.lastSyncedVersion) {
			this.logger?.debugSync('Dictionary version unchanged, skipping sync', {
				component: LogComponents.dictionary,
				operation: 'syncFullDictionary',
				dictionaryVersion: this.dictionaryVersion,
				workingVersion: this.workingVersion,
				lastSyncedVersion: this.lastSyncedVersion
			});
			return;
		}

		// Build domain-aware field payload
		const fieldsByDomain: Record<DictionaryDomain, Array<{ index: number; name: string }>> = {
			key: [],
			metric: [],
			unit: [],
			quality: [],
			device: [],
		};

		for (const [domain, domainMap] of Object.entries(this.domains) as Array<[DictionaryDomain, Map<string, number>]>) {
			const fields = Array.from(domainMap.entries())
				.sort((a, b) => a[1] - b[1]) // Sort by index
				.map(([name, index]) => ({ index, name }));
			fieldsByDomain[domain] = fields;
		}

		// Create flattened fields list for compatibility
		const fields = Object.values(fieldsByDomain)
			.flatMap((domainFields) => domainFields.map((f) => f.name));

		// Build protocol-aware enum payload.
		const payload = {
			version: this.dictionaryVersion, // Cloud-safe version
			fields,
			fieldsByDomain, // Include domain breakdown for backward compatibility
      
			// Cloud API prefers this format when present.
			format_version: 2,  // Signals new format
			keys: fieldsByDomain.key,  // Structural keys only
			enums: {
				quality: this.QUALITY_ENUM,  // Frozen OPC UA codes
				qualityCode: this.qualityCodeEnum,  // Frequency-learned (≥20 obs)
				unit: this.unitEnumFrozen ? this.unitEnum : {},  // Only if promoted (≥50 obs)
			},
			metrics: this.metricEnums,  // { modbus: {...}, snmp: {...}, opcua: {...} }
			devices: this.deviceEnums,  // { modbus: {...}, snmp: {...} }
      
			// Metadata for cloud analytics
			metadata: {
				timestamp: Date.now(),
				deviceUuid: this.deviceUuid,
				totalMetricsPromoted: this.getTotalPromotedMetrics(),
				totalDevicesPromoted: this.getTotalPromotedDevices(),
				totalQualityCodesPromoted: Object.keys(this.qualityCodeEnum).length,
			},
		};

		await this.mqttManager.publish(
			agentTopic(this.deviceUuid, 'meta', 'dictionary'),
			{ format: 'json', data: payload },
			{ qos: 1, retain: true }
		);

		this.lastSyncTime = Date.now();
		this.lastSyncedVersion = this.dictionaryVersion; // Track synced dictionaryVersion
    
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

		this.logger?.infoSync('Dictionary synced to cloud', {
			component: LogComponents.mqtt,
			operation: 'syncFullDictionary',
			dictionaryVersion: this.dictionaryVersion,
			workingVersion: this.workingVersion,
			versionGap: this.workingVersion - this.dictionaryVersion,
			fields: fields.length,
			domainBreakdown: this.metrics.domainStats,
			deviceUuid: this.deviceUuid,
			topic: agentTopic(this.deviceUuid, 'meta', 'dictionary'),
			qos: 1,
			retain: true
		});
	}

	/**
   * Sync delta dictionary updates (new fields only)
	 * Version is bumped in getIndex().
	 * Uses persisted delta records to determine unsynced changes.
   */
	private async syncDeltaDictionary(): Promise<void> {
		if (!this.enabled || this.getTotalDictionarySize() === 0) {
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
				deltaIds: unsyncedDeltas.map(d => d.id),
				hasUnsyncedEnumPromotions: this.hasUnsyncedEnumPromotions
			});
      
			if (unsyncedDeltas.length === 0 && !this.hasUnsyncedEnumPromotions) {
				this.logger?.debugSync('No unsynced deltas found, skipping sync', {
					component: LogComponents.dictionary,
					operation: 'syncDeltaDictionary'
				});
				return; // No new fields to sync
			}

			// Build payload with new fields and domains
			const newFieldsWithDomains = unsyncedDeltas.map(d => ({
				name: d.field_name,
				domain: d.domain || 'metric', // Default to metric for backward compatibility
				index: d.field_index,
			}));
			const newFields = newFieldsWithDomains.map(f => f.name);
			const payload = {
				version: this.dictionaryVersion, // Cloud-safe version
				newFields,
				newFieldsWithDomains, // Include domain info for cloud API
				format_version: 2,  // Protocol-aware format
				enums: {
					quality: this.QUALITY_ENUM,  // Always include frozen quality enum
					qualityCode: this.qualityCodeEnum,  // Quality code enum
					unit: this.unitEnumFrozen ? this.unitEnum : {},  // Only if frozen, else empty
				},
				metrics: this.metricEnums,  // Protocol-namespaced metrics
				devices: this.deviceEnums,  // Protocol-namespaced devices
				metadata: {
					timestamp: Date.now(),
					deviceUuid: this.deviceUuid,
					totalMetricsPromoted: this.getTotalPromotedMetrics(),
					totalDevicesPromoted: this.getTotalPromotedDevices(),
					totalQualityCodesPromoted: Object.keys(this.qualityCodeEnum).length,
				},
				deviceUuid: this.deviceUuid,
				timestamp: Date.now(),
			};

			// Publish to MQTT
			this.logger?.infoSync('Publishing delta dictionary to MQTT', {
				component: LogComponents.dictionary,
				operation: 'syncDeltaDictionary',
				dictionaryVersion: this.dictionaryVersion,
				workingVersion: this.workingVersion,
				fieldCount: newFields.length,
				fields: newFields
			});
      
			await this.mqttManager.publish(
				agentTopic(this.deviceUuid, 'meta', 'dictionary', 'delta'),
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
			this.hasUnsyncedEnumPromotions = false; // Clear flag after successful sync

			this.logger?.infoSync('Delta dictionary synced successfully', {
				component: LogComponents.dictionary,
				operation: 'syncDeltaDictionary',
				dictionaryVersion: this.dictionaryVersion,
				workingVersion: this.workingVersion,
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
   * Get dictionary size (number of indexed fields across all domains)
   */
	public getDictionarySize(): number {
		return this.getTotalDictionarySize();
	}

	/**
   * Get dictionary status
   */
	public getStatus(): {
    enabled: boolean;
    dictionaryVersion: number;
    workingVersion: number;
    versionGap: number;
    size: number;
    updateCount: number;
    lastSyncTime: number;
    } {
		return {
			enabled: this.enabled,
			dictionaryVersion: this.dictionaryVersion,
			workingVersion: this.workingVersion,
			versionGap: this.workingVersion - this.dictionaryVersion,
			size: this.getTotalDictionarySize(),
			updateCount: this.updateCount,
			lastSyncTime: this.lastSyncTime,
		};
	}

	/**
   * Reset dictionary (for testing or manual reset)
	 * Clears in-memory and persisted dictionary state.
   */
	public async reset(): Promise<void> {
		this.domains = {
			key: new Map(),
			metric: new Map(),
			unit: new Map(),
			quality: new Map(),
			device: new Map(),
		};
		this.domainCache.clear(); // Clear inference cache
		this.workingVersion = 1;
		this.dictionaryVersion = 1;
		this.updateCount = 0;
		this.lastDeltaSync = 0;
		this.fieldAdditionTimes = [];
		this.metrics.messagesProcessed = 0;
		this.metrics.bytesSaved = 0;
		this.totalOriginalBytes = 0;
		this.totalCompactedBytes = 0;
		this.metrics.domainStats = {
			key: 0,
			metric: 0,
			unit: 0,
			quality: 0,
			device: 0,
		};

		// Clear database
		try {
			await DictionaryModel.clearAll();
      
			this.logger?.warnSync('Dictionary reset (in-memory and database)', {
				component: LogComponents.dictionary,
				operation: 'reset',
				dictionaryVersion: this.dictionaryVersion,
				workingVersion: this.workingVersion,
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
