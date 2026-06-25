import {
	SchemaDriftModel,
} from '../../db/models/schema-drift.model.js';
import type {
	PersistedBaselineState,
	SchemaDriftEvent,
	SchemaDriftStore,
} from '../../db/models/schema-drift.model.js';
import type { Logger } from "./types.js";

type ValueType = "number" | "string" | "boolean" | "object" | "array" | "null";
type DriftSeverity = "warning" | "critical";

/**
 * Per-field type observation counts used to determine dominant expected types.
 * Tracks counts per ValueType plus a total, preventing unlimited type widening:
 * a type is "expected" only when its ratio to total exceeds minTypeDominanceRatio.
 */
type TypeFrequency = {
	counts: Map<ValueType, number>;
	total: number;
};

type DriftDetectorOptions = {
	enabled: boolean;
	warmupBatches: number;
	minFieldPresenceRatio: number;
	consecutiveMissingThreshold: number;
	alertCooldownMs: number;
	adaptivePromotionBatches: number;
	/** Minimum ratio of batches-present vs batches-since-first-seen before promotion. */
	adaptivePromotionRatio: number;
	adaptiveRetireBatches: number;
	maxTrackedFields: number;
	maxTraversalDepth: number;
	maxFieldsPerBatch: number;
	/** Maximum candidates per side when searching for rename pairs. */
	maxRenameCandidates: number;
	/** Skip Levenshtein for field names longer than this. */
	maxRenameFieldLength: number;
	/**
	 * A ValueType must appear in at least this fraction of observations to be
	 * considered "expected". Prevents one bad payload from permanently widening
	 * the accepted type set.
	 */
	minTypeDominanceRatio: number;
	/** Maximum array length used in log fields to prevent oversized log payloads. */
	logSampleSize: number;
	/**
	 * Run the full schema check only every Nth batch after the baseline is established.
	 * 1 = every batch (default). Higher values reduce CPU at high-frequency endpoints.
	 * The warmup phase always processes every batch regardless of this setting.
	 */
	checkIntervalBatches: number;
};

type ExtractedSchema = {
	fields: Set<string>;
	typesByField: Map<string, Set<ValueType>>;
};

type TypeDrift = {
	field: string;
	dominantExpectedType: ValueType;
	observedTypes: ValueType[];
};

const DEFAULT_OPTIONS: DriftDetectorOptions = {
	enabled: true,
	warmupBatches: 20,
	minFieldPresenceRatio: 0.5,
	consecutiveMissingThreshold: 10,
	alertCooldownMs: 30 * 60 * 1000,
	adaptivePromotionBatches: 50,
	adaptivePromotionRatio: 0.6,
	adaptiveRetireBatches: 250,
	maxTrackedFields: 1000,
	maxTraversalDepth: 5,
	maxFieldsPerBatch: 500,
	maxRenameCandidates: 20,
	maxRenameFieldLength: 64,
	minTypeDominanceRatio: 0.15,
	logSampleSize: 10,
	checkIntervalBatches: 1,
};

const RESERVED_GENERIC_KEYS = new Set<string>([
	"timestamp",
	"ts",
	"time",
	"devicename",
	"deviceid",
	"device_id",
	"device_uuid",
	"deviceuuid",
	"quality",
	"unit",
	"status",
	"state",
	"msgid",
	"device",
	"protocol",
]);

function toFieldName(input: unknown): string | undefined {
	if (typeof input !== "string") {
		return undefined;
	}

	const trimmed = input.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeFieldName(value: string): string {
	return value
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/[\s-]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/[^a-zA-Z0-9_.:]/g, "")
		.toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}

	return value as Record<string, unknown>;
}

function valueTypeOf(value: unknown): ValueType {
	if (value === null) {
		return "null";
	}

	if (Array.isArray(value)) {
		return "array";
	}

	if (typeof value === "number") {
		return "number";
	}

	if (typeof value === "string") {
		return "string";
	}

	if (typeof value === "boolean") {
		return "boolean";
	}

	return "object";
}

function isTelemetryPrimitive(value: unknown): boolean {
	return typeof value === "number" || typeof value === "boolean";
}

/**
 * Returns the Levenshtein edit distance between a and b, or undefined when the
 * length difference alone exceeds a reasonable rename threshold (fast path).
 * Uses a flat Int16Array instead of nested arrays to reduce GC pressure.
 */
function levenshteinDistance(
	a: string,
	b: string,
	maxFieldLength: number,
): number | undefined {
	if (Math.abs(a.length - b.length) > Math.ceil(maxFieldLength * 0.5)) {
		return undefined;
	}

	if (a === b) {
		return 0;
	}

	if (a.length === 0) {
		return b.length;
	}

	if (b.length === 0) {
		return a.length;
	}

	const rows = a.length + 1;
	const cols = b.length + 1;
	const dp = new Int16Array(rows * cols);

	for (let i = 0; i < rows; i++) {
		dp[i * cols] = i;
	}

	for (let j = 0; j < cols; j++) {
		dp[j] = j;
	}

	for (let i = 1; i < rows; i++) {
		for (let j = 1; j < cols; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[i * cols + j] = Math.min(
				dp[(i - 1) * cols + j] + 1,
				dp[i * cols + (j - 1)] + 1,
				dp[(i - 1) * cols + (j - 1)] + cost,
			);
		}
	}

	return dp[(rows - 1) * cols + (cols - 1)];
}

function stringSimilarity(
	a: string,
	b: string,
	maxFieldLength: number,
): number | undefined {
	const maxLen = Math.max(a.length, b.length);
	if (maxLen === 0) {
		return 1;
	}

	const dist = levenshteinDistance(a, b, maxFieldLength);
	if (dist === undefined) {
		return undefined;
	}

	return 1 - dist / maxLen;
}

function sampleArray<T>(arr: T[], maxSize: number): T[] {
	return arr.length <= maxSize ? arr : arr.slice(0, maxSize);
}

export class SchemaDriftDetector {
	private readonly options: DriftDetectorOptions;
	private readonly endpointName: string;
	private readonly logger?: Logger;
	private readonly store: SchemaDriftStore;

	private totalBatches = 0;
	private warmupSeen = 0;
	private baseline: Set<string> | undefined;
	/**
	 * Frequency-based type tracking per baseline field.
	 * Baseline types are evaluated BEFORE updating with new observations so a
	 * single bad batch cannot permanently widen the accepted type set.
	 */
	private readonly baselineTypeFreq = new Map<string, TypeFrequency>();
	private readonly warmupFieldCounts = new Map<string, number>();
	private readonly warmupTypeFreq = new Map<string, TypeFrequency>();
	private readonly missingStreakByField = new Map<string, number>();
	/** Count and first-seen batch for candidate new fields pending promotion. */
	private readonly newFieldCounts = new Map<string, number>();
	private readonly newFieldFirstSeen = new Map<string, number>();
	private readonly newFieldTypeFreq = new Map<string, TypeFrequency>();
	/** Per-field-signature cooldown map; replaces the previous single global timestamp. */
	private readonly lastAlertAtBySignature = new Map<string, number>();
	/** Lightweight tombstones: records the batch number when a field was retired. */
	private readonly tombstones = new Map<string, number>();

	constructor(
		endpointName: string,
		logger?: Logger,
		options?: Partial<DriftDetectorOptions>,
		store: SchemaDriftStore = SchemaDriftModel,
	) {
		this.endpointName = endpointName;
		this.logger = logger;
		this.options = { ...DEFAULT_OPTIONS, ...(options || {}) };
		this.store = store;
		this.restorePersistedBaseline();
	}

	private restorePersistedBaseline(): void {
		const persisted = this.store.loadBaseline(this.endpointName);
		if (!persisted) {
			return;
		}

		this.baseline = new Set(persisted.baselineFields);
		this.totalBatches = persisted.totalBatches;
		this.warmupSeen = persisted.warmupSeen;

		for (const [field, freq] of Object.entries(persisted.baselineTypeFreq)) {
			this.baselineTypeFreq.set(field, {
				counts: this.toValueTypeCountMap(freq.counts),
				total: freq.total,
			});
		}

		for (const [field, streak] of Object.entries(persisted.missingStreakByField)) {
			this.missingStreakByField.set(field, streak);
		}

		for (const [field, batch] of Object.entries(persisted.tombstones ?? {})) {
			this.tombstones.set(field, batch);
		}

		for (const [field, count] of Object.entries(persisted.newFieldCounts ?? {})) {
			this.newFieldCounts.set(field, count);
		}

		for (const [field, firstSeen] of Object.entries(persisted.newFieldFirstSeen ?? {})) {
			this.newFieldFirstSeen.set(field, firstSeen);
		}

		for (const [field, freq] of Object.entries(persisted.newFieldTypeFreq ?? {})) {
			this.newFieldTypeFreq.set(field, {
				counts: this.toValueTypeCountMap(freq.counts),
				total: freq.total,
			});
		}
	}

	private persistBaselineState(): void {
		if (!this.baseline) {
			return;
		}

		const state: PersistedBaselineState = {
			endpointName: this.endpointName,
			baselineFields: Array.from(this.baseline),
			baselineTypeFreq: this.serializeTypeFrequencies(this.baselineTypeFreq),
			missingStreakByField: Object.fromEntries(this.missingStreakByField),
			totalBatches: this.totalBatches,
			warmupSeen: this.warmupSeen,
			tombstones: Object.fromEntries(this.tombstones),
			newFieldCounts: Object.fromEntries(this.newFieldCounts),
			newFieldFirstSeen: Object.fromEntries(this.newFieldFirstSeen),
			newFieldTypeFreq: this.serializeTypeFrequencies(this.newFieldTypeFreq),
		};

		try {
			this.store.saveBaseline(state);
		} catch (error) {
			this.logger?.error(
				`Failed to persist schema baseline for endpoint '${this.endpointName}'`,
				{ endpointName: this.endpointName, error },
			);
		}
	}

	private persistDriftEvent(event: SchemaDriftEvent): void {
		try {
			this.store.saveDrift(event);
		} catch (error) {
			this.logger?.error(
				`Failed to persist schema drift event for endpoint '${this.endpointName}'`,
				{ endpointName: this.endpointName, error },
			);
		}
	}

	private serializeTypeFrequencies(
		freqMap: Map<string, TypeFrequency>,
	): PersistedBaselineState['baselineTypeFreq'] {
		const result: PersistedBaselineState['baselineTypeFreq'] = {};
		for (const [field, freq] of freqMap.entries()) {
			result[field] = {
				counts: Object.fromEntries(freq.counts),
				total: freq.total,
			};
		}

		return result;
	}

	private toValueTypeCountMap(counts: Record<string, number>): Map<ValueType, number> {
		const result = new Map<ValueType, number>();
		for (const [type, count] of Object.entries(counts)) {
			if (
				type === 'number' ||
				type === 'string' ||
				type === 'boolean' ||
				type === 'object' ||
				type === 'array' ||
				type === 'null'
			) {
				result.set(type, count);
			}
		}

		return result;
	}

	observe(messages: unknown[]): void {
		if (!this.options.enabled || messages.length === 0) {
			return;
		}

		const extracted = this.extractSchema(messages);
		if (extracted.fields.size === 0) {
			return;
		}

		this.totalBatches += 1;

		if (!this.baseline) {
			this.learnBaseline(extracted);
			return;
		}

		const interval = Math.max(1, this.options.checkIntervalBatches);
		if (interval > 1 && this.totalBatches % interval !== 0) {
			return;
		}

		this.detectDrift(extracted);
	}

	private learnBaseline(extracted: ExtractedSchema): void {
		this.warmupSeen += 1;

		for (const field of extracted.fields) {
			this.incrementCount(this.warmupFieldCounts, field);
			this.recordTypeFrequency(
				this.warmupTypeFreq,
				field,
				extracted.typesByField.get(field) ?? new Set<ValueType>(),
			);
		}

		if (this.warmupSeen < this.options.warmupBatches) {
			return;
		}

		const requiredPresence = Math.max(
			1,
			Math.ceil(
				this.options.warmupBatches * this.options.minFieldPresenceRatio,
			),
		);
		const baseline = new Set<string>();

		for (const [field, count] of this.warmupFieldCounts.entries()) {
			if (count < requiredPresence) {
				continue;
			}

			if (baseline.size >= this.options.maxTrackedFields) {
				break;
			}

			baseline.add(field);
			const freq = this.warmupTypeFreq.get(field);
			if (freq) {
				this.baselineTypeFreq.set(field, {
					counts: new Map(freq.counts),
					total: freq.total,
				});
			}
		}

		this.baseline = baseline;
		this.logger?.info(
			`Schema baseline learned for endpoint '${this.endpointName}'`,
			{
				endpointName: this.endpointName,
				warmupBatches: this.warmupSeen,
				baselineFieldCount: baseline.size,
				observationMode: "per-batch",
				sampleBaselineFields: sampleArray(
					Array.from(baseline),
					this.options.logSampleSize,
				),
			},
		);

		this.persistBaselineState();
	}

	private detectDrift(extracted: ExtractedSchema): void {
		const baseline = this.baseline;
		if (!baseline) {
			return;
		}

		const newFields: string[] = [];
		const missingFields: string[] = [];
		const typeDrifts: TypeDrift[] = [];

		for (const field of extracted.fields) {
			if (!baseline.has(field)) {
				this.handleNewField(field, extracted, newFields);
				continue;
			}

			this.missingStreakByField.set(field, 0);
			this.checkTypeDrift(field, extracted, typeDrifts);
		}

		for (const expected of baseline) {
			if (extracted.fields.has(expected)) {
				continue;
			}

			this.handleMissingField(expected, baseline, missingFields);
		}

		if (
			newFields.length === 0 &&
			missingFields.length === 0 &&
			typeDrifts.length === 0
		) {
			return;
		}

		const reportableNew = this.filterByCooldown(newFields, "new");
		const reportableMissing = this.filterByCooldown(missingFields, "missing");
		const reportableTypeDrifts = typeDrifts.filter((d) =>
			this.isPastCooldown(`type:${d.field}`),
		);
		for (const d of reportableTypeDrifts) {
			this.touchCooldown(`type:${d.field}`);
		}

		if (
			reportableNew.length === 0 &&
			reportableMissing.length === 0 &&
			reportableTypeDrifts.length === 0
		) {
			return;
		}

		const severity: DriftSeverity =
			reportableMissing.length > 0 || reportableTypeDrifts.length > 0
				? "critical"
				: "warning";

		const renameCandidate = this.detectRenameCandidate(
			reportableMissing,
			reportableNew,
		);
		const s = this.options.logSampleSize;

		this.logger?.warn(
			`Schema drift detected for endpoint '${this.endpointName}'`,
			{
				endpointName: this.endpointName,
				severity,
				baselineFieldCount: baseline.size,
				observedFieldCount: extracted.fields.size,
				additiveFieldCount: reportableNew.length,
				sampleAdditiveFields: sampleArray(reportableNew, s),
				breakingFieldCount: reportableMissing.length,
				sampleBreakingFields: sampleArray(reportableMissing, s),
				typeDriftCount: reportableTypeDrifts.length,
				sampleTypeDrifts: sampleArray(reportableTypeDrifts, s),
				renameCandidate,
				observationMode: "per-batch",
			},
		);

		for (const field of reportableNew) {
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'new-field',
				fieldName: field,
				severity: 'warning',
			});
		}

		for (const field of reportableMissing) {
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'missing-field',
				fieldName: field,
				severity: 'critical',
			});
		}

		for (const drift of reportableTypeDrifts) {
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'type-drift',
				fieldName: drift.field,
				severity: 'critical',
				expectedType: drift.dominantExpectedType,
				observedTypes: drift.observedTypes,
			});
		}

		if (renameCandidate) {
			this.persistDriftEvent({
				endpointName: this.endpointName,
				driftType: 'rename-candidate',
				severity: 'warning',
				renameCandidateFrom: renameCandidate.from,
				renameCandidateTo: renameCandidate.to,
				renameSimilarity: renameCandidate.similarity,
			});
		}
	}

	private handleNewField(
		field: string,
		extracted: ExtractedSchema,
		newFields: string[],
	): void {
		newFields.push(field);

		// Resurrection: field was previously retired — log and clear tombstone.
		const retiredAt = this.tombstones.get(field);
		if (retiredAt !== undefined) {
			this.tombstones.delete(field);
			this.logger?.info(
				`Field reappeared for endpoint '${this.endpointName}'`,
				{ endpointName: this.endpointName, field, retiredAtBatch: retiredAt, reappearedAtBatch: this.totalBatches },
			);
		}

		if (!this.newFieldFirstSeen.has(field)) {
			this.newFieldFirstSeen.set(field, this.totalBatches);
		}

		this.incrementCount(this.newFieldCounts, field);
		this.recordTypeFrequency(
			this.newFieldTypeFreq,
			field,
			extracted.typesByField.get(field) ?? new Set<ValueType>(),
		);

		const stableCount = this.newFieldCounts.get(field) ?? 0;
		const firstSeen = this.newFieldFirstSeen.get(field) ?? this.totalBatches;
		const windowSize = this.totalBatches - firstSeen + 1;
		const presenceRatio = windowSize > 0 ? stableCount / windowSize : 0;

		const shouldPromote =
			stableCount >= this.options.adaptivePromotionBatches &&
			presenceRatio >= this.options.adaptivePromotionRatio &&
			this.baseline!.size < this.options.maxTrackedFields;

		if (!shouldPromote) {
			return;
		}

		this.baseline!.add(field);
		this.missingStreakByField.set(field, 0);
		this.newFieldCounts.delete(field);
		this.newFieldFirstSeen.delete(field);

		const freq = this.newFieldTypeFreq.get(field);
		if (freq) {
			this.baselineTypeFreq.set(field, {
				counts: new Map(freq.counts),
				total: freq.total,
			});
			this.newFieldTypeFreq.delete(field);
		}

		this.logger?.info(
			`Promoted stable field into schema baseline for endpoint '${this.endpointName}'`,
			{
				endpointName: this.endpointName,
				field,
				stableBatches: stableCount,
				presenceRatio: presenceRatio.toFixed(2),
				windowSize,
			},
		);

		this.persistBaselineState();
	}

	private checkTypeDrift(
		field: string,
		extracted: ExtractedSchema,
		typeDrifts: TypeDrift[],
	): void {
		const observedTypes = extracted.typesByField.get(field);
		if (!observedTypes || observedTypes.size === 0) {
			return;
		}

		const freq = this.baselineTypeFreq.get(field);
		if (!freq) {
			this.recordTypeFrequency(this.baselineTypeFreq, field, observedTypes);
			return;
		}

		const expectedTypes = this.getDominantExpectedTypes(freq);
		this.recordTypeFrequency(this.baselineTypeFreq, field, observedTypes);

		if (expectedTypes.size === 0) {
			return;
		}

		const unexpectedTypes = Array.from(observedTypes).filter(
			(t) => !expectedTypes.has(t),
		);
		if (unexpectedTypes.length === 0) {
			return;
		}

		const dominantExpectedType = this.getDominantType(freq);
		// null dominant means the baseline was built while the device was offline — not meaningful drift
		if (!dominantExpectedType || dominantExpectedType === 'null') {
			return;
		}

		typeDrifts.push({
			field,
			dominantExpectedType,
			observedTypes: Array.from(observedTypes),
		});
	}

	private handleMissingField(
		expected: string,
		baseline: Set<string>,
		missingFields: string[],
	): void {
		const streak = (this.missingStreakByField.get(expected) ?? 0) + 1;
		this.missingStreakByField.set(expected, streak);

		if (streak >= this.options.consecutiveMissingThreshold) {
			missingFields.push(expected);
		}

		if (streak >= this.options.adaptiveRetireBatches) {
			baseline.delete(expected);
			this.missingStreakByField.delete(expected);
			this.baselineTypeFreq.delete(expected);

			if (this.canTrackInMap(this.tombstones, expected)) {
				this.tombstones.set(expected, this.totalBatches);
			}

			this.logger?.info(
				`Retired stale field from schema baseline for endpoint '${this.endpointName}'`,
				{
					endpointName: this.endpointName,
					field: expected,
					missingStreak: streak,
					retiredAtBatch: this.totalBatches,
				},
			);

			this.persistBaselineState();
		}
	}

	private detectRenameCandidate(
		missingFields: string[],
		newFields: string[],
	): { from: string; to: string; similarity: number } | undefined {
		if (missingFields.length === 0 || newFields.length === 0) {
			return undefined;
		}

		const { maxRenameCandidates, maxRenameFieldLength } = this.options;
		const candidates = missingFields.slice(0, maxRenameCandidates);
		const added = newFields.slice(0, maxRenameCandidates);
		let best: { from: string; to: string; similarity: number } | undefined;

		for (const m of candidates) {
			const fromRaw = m.split(":").slice(1).join(":");
			if (fromRaw.length > maxRenameFieldLength) {
				continue;
			}

			for (const a of added) {
				const toRaw = a.split(":").slice(1).join(":");
				if (toRaw.length > maxRenameFieldLength) {
					continue;
				}

				const similarity = stringSimilarity(fromRaw, toRaw, maxRenameFieldLength);
				if (similarity === undefined) {
					continue;
				}

				if (!best || similarity > best.similarity) {
					best = { from: m, to: a, similarity };
				}
			}
		}

		return best && best.similarity >= 0.72 ? best : undefined;
	}

	private extractSchema(messages: unknown[]): ExtractedSchema {
		const fields = new Set<string>();
		const typesByField = new Map<string, Set<ValueType>>();
		const visited = new WeakSet<object>();

		const addField = (field: string, value: unknown): void => {
			if (fields.size >= this.options.maxFieldsPerBatch) {
				return;
			}

			if (!fields.has(field) && fields.size >= this.options.maxTrackedFields) {
				return;
			}

			fields.add(field);

			// null means "no reading yet" — don't let it define the expected type
			if (value === null || value === undefined) {
				return;
			}

			if (!this.canTrackInMap(typesByField, field)) {
				return;
			}

			let types = typesByField.get(field);
			if (!types) {
				types = new Set<ValueType>();
				typesByField.set(field, types);
			}

			types.add(valueTypeOf(value));
		};

		const traverse = (value: unknown, prefix: string, depth: number): void => {
			if (
				depth > this.options.maxTraversalDepth ||
				fields.size >= this.options.maxFieldsPerBatch
			) {
				return;
			}

			if (Array.isArray(value)) {
				if (value.length === 0) {
					return;
				}

				const arrayRef = value as unknown as object;
				if (visited.has(arrayRef)) {
					return;
				}

				visited.add(arrayRef);

				// Array entries are traversed under the same prefix, intentionally collapsing
				// positional structure. All entries contribute to the same field namespace.
				for (const entry of value) {
					traverse(entry, prefix, depth + 1);
					if (fields.size >= this.options.maxFieldsPerBatch) {
						return;
					}
				}

				return;
			}

			const record = asRecord(value);
			if (!record) {
				return;
			}

			const objectRef = record as unknown as object;
			if (visited.has(objectRef)) {
				return;
			}

			visited.add(objectRef);

			const handledKeys = new Set<string>();

			const readings = record.readings;
			if (Array.isArray(readings)) {
				handledKeys.add("readings");
				for (const reading of readings) {
					const rr = asRecord(reading);
					if (!rr) {
						continue;
					}

					const fieldNameRaw = toFieldName(rr.metric) || toFieldName(rr.registerName) || toFieldName(rr.name);

					if (!fieldNameRaw) {
						continue;
					}

					const normalized = normalizeFieldName(fieldNameRaw);
					if (normalized) {
						addField(`reading:${normalized}`, rr.value);
					}
				}
			}

			const directFieldRaw = toFieldName(record.metric) || toFieldName(record.registerName) || toFieldName(record.name);

			if (directFieldRaw) {
				handledKeys.add("metric");
				handledKeys.add("register_name");
				handledKeys.add("name");
				handledKeys.add("value");
				const normalized = normalizeFieldName(directFieldRaw);
				if (normalized) {
					addField(`reading:${normalized}`, record.value);
				}
			}

			for (const [rawKey, rawValue] of Object.entries(record)) {
				const normalizedKey = normalizeFieldName(rawKey);
				if (!normalizedKey) {
					continue;
				}

				if (
					RESERVED_GENERIC_KEYS.has(normalizedKey) ||
					handledKeys.has(normalizedKey)
				) {
					continue;
				}

				if (isTelemetryPrimitive(rawValue)) {
					const scopedKey = prefix
						? `${prefix}.${normalizedKey}`
						: normalizedKey;
					addField(`key:${scopedKey}`, rawValue);
				}

				if (typeof rawValue === "object" && rawValue !== null) {
					const nextPrefix = prefix
						? `${prefix}.${normalizedKey}`
						: normalizedKey;
					traverse(rawValue, nextPrefix, depth + 1);
				}
			}
		};

		for (const message of messages) {
			traverse(message, "", 0);
			if (fields.size >= this.options.maxFieldsPerBatch) {
				break;
			}
		}

		return { fields, typesByField };
	}

	private canTrackInMap<V>(map: Map<string, V>, field: string): boolean {
		return map.has(field) || map.size < this.options.maxTrackedFields;
	}

	private incrementCount(
		map: Map<string, number>,
		field: string,
		amount = 1,
	): void {
		if (!this.canTrackInMap(map, field)) {
			return;
		}

		map.set(field, (map.get(field) ?? 0) + amount);
	}

	private recordTypeFrequency(
		freqMap: Map<string, TypeFrequency>,
		field: string,
		types: Set<ValueType>,
	): void {
		if (!this.canTrackInMap(freqMap, field)) {
			return;
		}

		let freq = freqMap.get(field);
		if (!freq) {
			freq = { counts: new Map(), total: 0 };
			freqMap.set(field, freq);
		}

		for (const t of types) {
			freq.counts.set(t, (freq.counts.get(t) ?? 0) + 1);
		}

		freq.total += 1;
	}

	/**
	 * Returns the set of ValueTypes whose frequency ratio meets or exceeds
	 * minTypeDominanceRatio. A type must be consistently present to be considered
	 * "expected", preventing unlimited widening from occasional bad payloads.
	 */
	private getDominantExpectedTypes(freq: TypeFrequency): Set<ValueType> {
		const expected = new Set<ValueType>();
		for (const [type, count] of freq.counts) {
			if (count / freq.total >= this.options.minTypeDominanceRatio) {
				expected.add(type);
			}
		}
		return expected;
	}

	private getDominantType(freq: TypeFrequency): ValueType | undefined {
		let best: { type: ValueType; count: number } | undefined;
		for (const [type, count] of freq.counts.entries()) {
			if (!best || count > best.count) {
				best = { type, count };
			}
		}

		return best?.type;
	}

	private isPastCooldown(signature: string): boolean {
		return (
			Date.now() - (this.lastAlertAtBySignature.get(signature) ?? 0) >=
			this.options.alertCooldownMs
		);
	}

	private touchCooldown(signature: string): void {
		if (!this.canTrackInMap(this.lastAlertAtBySignature, signature)) {
			return;
		}

		this.lastAlertAtBySignature.set(signature, Date.now());
	}

	private filterByCooldown(fields: string[], prefix: string): string[] {
		const allowed: string[] = [];
		for (const field of fields) {
			const sig = `${prefix}:${field}`;
			if (!this.isPastCooldown(sig)) {
				continue;
			}

			this.touchCooldown(sig);
			allowed.push(field);
		}

		return allowed;
	}
}
