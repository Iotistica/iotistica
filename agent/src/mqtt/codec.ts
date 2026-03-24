import msgpack from 'msgpack-lite';
import type { AgentLogger } from '../logging/agent-logger';
import { LogComponents } from '../logging/types';
import { MessageIdGenerator } from './utils';

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
	const enrichedData = msgIdGenerator
		? { ...data, msgId: msgIdGenerator.generate() }
		: data;
	return { format: 'json', data: enrichedData };
}

/**
 * Helper: Create MessagePack payload with msgId injection
 * Use this for high-frequency sensor data (better compression + faster)
 */
export function createMsgpackPayload(data: object, msgIdGenerator?: MessageIdGenerator): MqttPayload {
	const enrichedData = msgIdGenerator
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
		default:
			// TypeScript exhaustiveness check
			const _exhaustive: never = payload;
			throw new Error(`Unknown payload format: ${(_exhaustive as any).format}`);
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
	} catch (error) {
		// Ignore logging errors
	}
}
