import msgpack from 'msgpack-lite';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { type MessageIdGenerator } from './utils';

/**
 * Explicit payload contract - callers must specify format
 * This prevents implicit parsing/serialization in the transport layer
 */
export type MqttPayload =
	| { format: 'json'; data: object }
	| { format: 'msgpack'; data: object }
	| { format: 'binary'; data: Buffer }
	| { format: 'text'; data: string };

/**
 * Helper: Create JSON payload with msgId injection
 * Use this for messages that need HA deduplication
 */
export function createJsonPayload(data: object, msgIdGenerator?: MessageIdGenerator): MqttPayload {
	const existingMsgId = (data as { msgId?: string }).msgId;
	const enrichedData = existingMsgId
		? data
		: msgIdGenerator
			? { ...data, msgId: msgIdGenerator.generate() }
			: data;
	return { format: 'json', data: enrichedData };
}

/**
 * Helper: Create MessagePack payload with msgId injection
 * Use this for high-frequency device data (better compression + faster)
 */
export function createMsgpackPayload(data: object, msgIdGenerator?: MessageIdGenerator): MqttPayload {
	const existingMsgId = (data as { msgId?: string }).msgId;
	const enrichedData = existingMsgId
		? data
		: msgIdGenerator
			? { ...data, msgId: msgIdGenerator.generate() }
			: data;
	return { format: 'msgpack', data: enrichedData };
}

/**
 * Helper: Serialize payload to Buffer for MQTT transport
 * This is the ONLY place where serialization happens
 */
export function serializePayload(payload: MqttPayload): Buffer {
	switch (payload.format) {
		case 'json':
			return Buffer.from(JSON.stringify(payload.data), 'utf-8');
		case 'msgpack':
			return msgpack.encode(payload.data);
		case 'binary':
			return payload.data;
		case 'text':
			return Buffer.from(payload.data, 'utf-8');
		default: {
			// TypeScript exhaustiveness check
			const _exhaustive: never = payload;
			throw new Error(`Unknown payload format: ${(_exhaustive as any).format}`);
		}
	}
}

/**
 * Helper: Deserialize Buffer to payload (for received messages)
 * Tries MessagePack first (fast binary check), then JSON, then binary
 *
 * TODO (POST-POC): Replace auto-detection with explicit format signaling
 *
 * Current approach (first-byte heuristics) is acceptable for POC but not production-safe:
 * - Binary data can coincidentally start with msgpack markers (0x90-0x9f, 0x80-0x8f)
 * - Some msgpack types won't match markers (e.g., positive fixint 0x00-0x7f)
 * - False positives = corrupted decoding and data loss
 *
 * Production solution (choose one):
 *
 * 1. Topic-based format (RECOMMENDED):
 *    - Agent: Publish to `iot/device/{uuid}/endpoints/msgpack/{endpoint}`
 *    - API: Route by topic pattern, deserialize with explicit format
 *    - Benefits: Format visible in topic, easy debugging, backward compatible
 *
 * 2. MQTT v5 contentType property:
 *    - Set `properties: { contentType: 'application/x-msgpack' }`
 *    - Requires MQTT v5 broker support
 *
 * 3. Format prefix byte:
 *    - Prepend 0x01 (JSON) or 0x02 (msgpack) before serialized data
 *    - Simple but adds 1 byte overhead per message
 *
 * See: docs/MESSAGEPACK-POC-GUIDE.md for migration plan
 */
export function deserializePayload(buffer: Buffer): MqttPayload {
	// Try MessagePack first (check first byte for msgpack markers)
	if (buffer.length > 0) {
		const firstByte = buffer[0];
		// MessagePack markers: 0x90-0x9f (fixarray), 0xdc-0xdd (array16/32), 0x80-0x8f (fixmap)
		if ((firstByte >= 0x90 && firstByte <= 0x9f) ||
				firstByte === 0xdc || firstByte === 0xdd ||
				(firstByte >= 0x80 && firstByte <= 0x8f)) {
			try {
				const data = msgpack.decode(buffer);
				return { format: 'msgpack', data };
			} catch {
				// Not msgpack, continue to JSON
			}
		}
	}

	// Try JSON
	try {
		const str = buffer.toString('utf-8');
		const data = JSON.parse(str);
		return { format: 'json', data };
	} catch {
		// Not JSON - treat as binary
		return { format: 'binary', data: buffer };
	}
}

// ─── Topic ID Codec ──────────────────────────────────────────────────────────
//
// UUID Base64 URL-safe codec for MQTT topic compression.
// Encodes UUIDs (36 chars) → 22-char base64url strings.
// Encodes 12-char hex tenant IDs (6 bytes) → 8-char base64url strings.
// Reversible encoding for size reduction only — NOT security.

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENCODED_UUID_REGEX = /^[A-Za-z0-9_-]{22}$/;
// 12-char hex tenant IDs (6 bytes) encode to exactly 8 base64url chars (no padding)
const HEX_ID_REGEX = /^[0-9a-f]{12}$/i;
const ENCODED_HEX_REGEX = /^[A-Za-z0-9_-]{8}$/;

// LRU-style caches to avoid repeated encode/decode on hot paths
const encodeCache = new Map<string, string>();
const decodeCache = new Map<string, string>();
const MAX_CACHE_SIZE = 1024;

function evictOldest(cache: Map<string, string>): void {
	if (cache.size >= MAX_CACHE_SIZE) {
		const firstKey = cache.keys().next().value;
		if (firstKey !== undefined) cache.delete(firstKey);
	}
}

export function isUuid(value: string): boolean { return UUID_REGEX.test(value); }
export function isEncodedUuid(value: string): boolean { return ENCODED_UUID_REGEX.test(value); }
export function isHexId(value: string): boolean { return HEX_ID_REGEX.test(value); }
export function isEncodedHexId(value: string): boolean { return ENCODED_HEX_REGEX.test(value); }

/** Encode a standard UUID to a 22-char Base64 URL-safe string. */
export function encodeUuid(uuid: string): string {
	const cached = encodeCache.get(uuid);
	if (cached) return cached;
	if (!UUID_REGEX.test(uuid)) throw new Error(`Invalid UUID: ${uuid}`);
	const encoded = Buffer.from(uuid.replace(/-/g, ''), 'hex')
		.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	evictOldest(encodeCache); encodeCache.set(uuid, encoded);
	evictOldest(decodeCache); decodeCache.set(encoded, uuid.toLowerCase());
	return encoded;
}

/** Decode a 22-char Base64 URL-safe string back to a standard UUID. */
export function decodeUuid(encoded: string): string {
	const cached = decodeCache.get(encoded);
	if (cached) return cached;
	if (!ENCODED_UUID_REGEX.test(encoded)) throw new Error(`Invalid encoded UUID: ${encoded}`);
	const bytes = Buffer.from(
		encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '='),
		'base64'
	);
	if (bytes.length !== 16) throw new Error(`Invalid encoded UUID: decoded to ${bytes.length} bytes, expected 16`);
	const h = bytes.toString('hex');
	const uuid = `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
	evictOldest(decodeCache); decodeCache.set(encoded, uuid);
	return uuid;
}

/** Encode a 12-char hex tenant ID to an 8-char Base64 URL-safe string. */
export function encodeHexId(hex: string): string {
	const cached = encodeCache.get(hex);
	if (cached) return cached;
	if (!HEX_ID_REGEX.test(hex)) throw new Error(`Invalid hex ID: ${hex}`);
	const encoded = Buffer.from(hex, 'hex')
		.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	evictOldest(encodeCache); encodeCache.set(hex, encoded);
	evictOldest(decodeCache); decodeCache.set(encoded, hex.toLowerCase());
	return encoded;
}

/** Decode an 8-char Base64 URL-safe string back to a 12-char hex tenant ID. */
export function decodeHexId(encoded: string): string {
	const cached = decodeCache.get(encoded);
	if (cached) return cached;
	if (!ENCODED_HEX_REGEX.test(encoded)) throw new Error(`Invalid encoded hex ID: ${encoded}`);
	const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
	if (bytes.length !== 6) throw new Error(`Invalid encoded hex ID: decoded to ${bytes.length} bytes, expected 6`);
	const result = bytes.toString('hex');
	evictOldest(decodeCache); decodeCache.set(encoded, result);
	return result;
}

/**
 * Encode any recognized topic ID: UUID → 22 chars, 12-char hex → 8 chars.
 * Passes through MQTT wildcards (+, #, *) unchanged.
 */
export function encodeIfUuid(value: string): string {
	if (value === '+' || value === '#' || value === '*') return value;
	if (isUuid(value)) return encodeUuid(value);
	if (isHexId(value)) return encodeHexId(value);
	return value;
}

/** Clear topic ID caches (for testing). */
export function clearCodecCaches(): void {
	encodeCache.clear();
	decodeCache.clear();
}

// ─── Payload Compression ─────────────────────────────────────────────────────

/**
 * Calculate and log compression ratio for POC testing
 * Compares msgpack size vs JSON size
 */
export function logCompressionStats(
	data: object,
	format: 'json' | 'msgpack',
	logger?: AgentLogger | { info: (msg: string, ...args: any[]) => void },
	topic?: string
): void {
	if (format !== 'msgpack' || !logger) return; // Only log for msgpack with valid logger

	try {
		const jsonSize = Buffer.from(JSON.stringify(data), 'utf-8').length;
		const msgpackSize = msgpack.encode(data).length;
		const compressionRatio = ((jsonSize - msgpackSize) / jsonSize * 100).toFixed(1);
		const savingsBytes = jsonSize - msgpackSize;

		// Use infoSync for AgentLogger, info for simple Logger
		if ('infoSync' in logger) {
			logger.infoSync('MessagePack compression stats', {
				component: LogComponents.mqtt,
				topic: topic?.substring(topic.lastIndexOf('/') + 1) || 'unknown',
				jsonBytes: jsonSize,
				msgpackBytes: msgpackSize,
				savingsBytes,
				compressionPct: `${compressionRatio}%`,
				ratio: `${jsonSize}:${msgpackSize}`
			});
		} else {
			logger.info(
				`MessagePack compression stats - topic: ${topic?.substring(topic.lastIndexOf('/') + 1) || 'unknown'}, ` +
				`json: ${jsonSize}B, msgpack: ${msgpackSize}B, savings: ${savingsBytes}B (${compressionRatio}%)`
			);
		}
	} catch (_error) {
		// Ignore logging errors
	}
}
