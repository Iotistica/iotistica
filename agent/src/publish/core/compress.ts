import { deflate as zlibDeflate } from 'zlib';
import { promisify } from 'util';
import * as msgpack from 'msgpack-lite';
import { createJsonPayload, createMsgpackPayload, serializePayload } from '../../mqtt/manager.js';
import { getCpuUsage } from '../../system/metrics.js';
import type { MqttConnection } from './types.js';
import type { Protocol } from '../../plugins/protocol.js';
import type { DictionaryManager } from '../../mqtt/dictionary.js';

const deflateAsync = promisify(zlibDeflate);
type Payload = Buffer | string;

export interface CompressionInfo {
  method:
    | 'json' | 'json+deflate'
    | 'msgpack' | 'msgpack+deflate'
    | 'dictionary' | 'dictionary+msgpack' | 'dictionary+deflate' | 'dictionary+msgpack+deflate'
    | 'baseline';
  originalSize: number;
  compressedSize: number;
  /** Percentage of bytes saved (0-100) */
  ratio: number;
  compressionMs: number;
  isBaseline?: boolean;
  cpuUsage?: {
    // CPU μs — serialization (dict/msgpack) vs compression (deflate) are tracked separately.
    // ⚠️ deflate runs in libuv thread pool: numbers reflect main-thread overhead only.
    // ⚠️ GC costs (pause time, survivor promotion) are NOT captured here.
    serialization?: { method: 'dictionary' | 'msgpack' | 'json'; cpu: { user: number; system: number } };
    compression?: { method: 'deflate'; cpu: { user: number; system: number } };
    total?: { user: number; system: number };
  };
}

export interface CompressorOptions {
  useMsgpack: boolean;
  useKeyCompaction: boolean;
  useDeflate: boolean;
}

/** The four compression strategies a subscription can request explicitly. */
export type SubscriptionCompression = 'json' | 'msgpack' | 'json+deflate' | 'msgpack+deflate';

/** Convert a SubscriptionCompression string to CompressorOptions. Dictionary compaction is never
 *  requested at the per-subscription level (it requires a shared DictionaryManager). */
export function compressionToOpts(c: SubscriptionCompression): CompressorOptions {
	return {
		useMsgpack: c === 'msgpack' || c === 'msgpack+deflate',
		useKeyCompaction: false,
		useDeflate: c === 'json+deflate' || c === 'msgpack+deflate',
	};
}

// Only compress when beneficial: payload > 4 KB AND CPU < 70 %
function shouldDeflate(payloadSize: number, cpuLoad: number): boolean {
	return payloadSize > 4 * 1024 && cpuLoad < 70;
}

// Every 1000th publish uses bare JSON (no-op control) to calibrate overhead
function shouldMeasureBaseline(publishCount: number): boolean {
	return (publishCount % 1000) === 0;
}

/**
 * Selects and applies the best compression strategy for a publish cycle.
 * Strategy priority: dictionary → msgpack → json  (each optionally + deflate).
 */
export class PayloadCompressor {
	constructor(
    private readonly opts: CompressorOptions,
    private readonly mqttConnection: MqttConnection,
	private readonly dictionaryManager?: DictionaryManager,
    private readonly protocol?: Protocol,
	) {}

	async compress(
		data: unknown,
		baselineSize: number,
		publishCount: number,
		overrideOpts?: CompressorOptions,
	): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
		if (shouldMeasureBaseline(publishCount)) {
			return this.baseline(data, baselineSize);
		}
		const opts = overrideOpts ?? this.opts;
		if (this.dictionaryManager && opts.useKeyCompaction) {
			return this.applyDictionary(data, baselineSize, opts);
		}
		return this.applyMsgpackOrJson(data, baselineSize, opts);
	}

	// --- strategies -------------------------------------------------------------

	private sizeOf(payload: Payload): number {
		return typeof payload === 'string' ? Buffer.byteLength(payload, 'utf-8') : payload.length;
	}

	private buildInfo(
		method: CompressionInfo['method'],
		baselineSize: number,
		compressedSize: number,
		t0: number,
		isBaseline = false,
		cpuUsage?: CompressionInfo['cpuUsage'],
	): CompressionInfo {
		return {
			method,
			originalSize: baselineSize,
			compressedSize,
			ratio: isBaseline ? 0 : ((baselineSize - compressedSize) / baselineSize) * 100,
			compressionMs: Date.now() - t0,
			...(isBaseline ? { isBaseline: true } : {}),
			...(cpuUsage ? { cpuUsage } : {}),
		};
	}

	private dictionaryMethod(useMsgpack: boolean, useDeflate: boolean):
    'dictionary' | 'dictionary+msgpack' | 'dictionary+deflate' | 'dictionary+msgpack+deflate' {
		if (useMsgpack) return useDeflate ? 'dictionary+msgpack+deflate' : 'dictionary+msgpack';
		return useDeflate ? 'dictionary+deflate' : 'dictionary';
	}

	private standardMethod(useMsgpack: boolean, useDeflate: boolean):
    'json' | 'json+deflate' | 'msgpack' | 'msgpack+deflate' {
		if (useMsgpack) return useDeflate ? 'msgpack+deflate' : 'msgpack';
		return useDeflate ? 'json+deflate' : 'json';
	}

	private async maybeDeflatePayload(
		payload: Payload,
		enabled: boolean,
	): Promise<{ payload: Payload; deflateCpu?: { user: number; system: number } }> {
		if (!enabled) {
			return { payload };
		}

		const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
		if (!shouldDeflate(buf.length, await getCpuUsage())) {
			return { payload: buf };
		}

		const cpu1 = process.cpuUsage();
		const finalPayload = await deflateAsync(buf);
		const deflateCpu = process.cpuUsage(cpu1);

		return { payload: finalPayload, deflateCpu };
	}

	private async baseline(data: unknown, baselineSize: number): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
		const t0 = Date.now();
		const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
		const payload = serializePayload(createJsonPayload(data as object, msgIdGen));
		const compressedSize = this.sizeOf(payload);
		return {
			payload,
			info: this.buildInfo('baseline', baselineSize, compressedSize, t0, true),
		};
	}

	private async applyDictionary(data: unknown, baselineSize: number, opts = this.opts): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
		const t0 = Date.now();
		const cpu0 = process.cpuUsage();
		const dictionaryManager = this.dictionaryManager;
		if (!dictionaryManager) {
			throw new Error('Dictionary manager not initialized');
		}

		const dictCpu0 = process.cpuUsage();
		const { compacted } = await dictionaryManager.compact(data, this.protocol);
		const dictCpu = process.cpuUsage(dictCpu0);

		let msgpackCpu: { user: number; system: number } | undefined;
		let intermediate: Buffer | string;
		if (opts.useMsgpack) {
			const cpu1 = process.cpuUsage();
			intermediate = msgpack.encode(compacted);
			msgpackCpu = process.cpuUsage(cpu1);
		} else {
			intermediate = JSON.stringify(compacted);
		}

		const { payload: finalPayload, deflateCpu } = await this.maybeDeflatePayload(intermediate, opts.useDeflate);

		const finalSize = this.sizeOf(finalPayload);
		const method = this.dictionaryMethod(opts.useMsgpack, opts.useDeflate);

		const serializationMethod = opts.useMsgpack ? 'msgpack' as const : 'dictionary' as const;
		const serializationCpu = opts.useMsgpack ? (msgpackCpu || dictCpu) : dictCpu;

		return {
			payload: finalPayload,
			info: this.buildInfo(method, baselineSize, finalSize, t0, false, {
				serialization: { method: serializationMethod, cpu: serializationCpu },
				compression: deflateCpu ? { method: 'deflate', cpu: deflateCpu } : undefined,
				total: process.cpuUsage(cpu0),
			}),
		};
	}

	private async applyMsgpackOrJson(data: unknown, baselineSize: number, opts = this.opts): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
		const t0 = Date.now();
		const cpu0 = process.cpuUsage();
		const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();

		let msgpackCpu: { user: number; system: number } | undefined;
		let deflateCpu: { user: number; system: number } | undefined;
		let finalPayload: Buffer | string;
		let compressedSize: number;

		if (opts.useMsgpack) {
			const cpu1 = process.cpuUsage();
			const payload = serializePayload(createMsgpackPayload(data as object, msgIdGen));
			msgpackCpu = process.cpuUsage(cpu1);

			const deflated = await this.maybeDeflatePayload(payload, opts.useDeflate);
			finalPayload = deflated.payload;
			deflateCpu = deflated.deflateCpu;
			compressedSize = this.sizeOf(finalPayload);
		} else {
			const payload = serializePayload(createJsonPayload(data as object, msgIdGen));

			if (opts.useDeflate) {
				const deflated = await this.maybeDeflatePayload(payload, true);
				finalPayload = deflated.payload;
				deflateCpu = deflated.deflateCpu;
				compressedSize = this.sizeOf(finalPayload);
			} else {
				finalPayload = payload;
				compressedSize = baselineSize;
			}
		}

		const method = this.standardMethod(opts.useMsgpack, opts.useDeflate);

		return {
			payload: finalPayload!,
			info: this.buildInfo(method, baselineSize, compressedSize!, t0, false, {
				serialization: msgpackCpu
					? { method: 'msgpack', cpu: msgpackCpu }
					: { method: 'json', cpu: { user: 0, system: 0 } },
				compression: deflateCpu ? { method: 'deflate', cpu: deflateCpu } : undefined,
				total: process.cpuUsage(cpu0),
			}),
		};
	}
}
