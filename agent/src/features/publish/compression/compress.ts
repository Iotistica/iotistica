import { deflate as zlibDeflate } from 'zlib';
import { promisify } from 'util';
import * as msgpack from 'msgpack-lite';
import { createJsonPayload, createMsgpackPayload, serializePayload } from '../../../mqtt/manager.js';
import { getCpuUsage } from '../../../system/metrics.js';
import type { MqttConnection, Logger } from '../types.js';

const deflateAsync = promisify(zlibDeflate);

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
    private readonly dictionaryManager?: any,
    private readonly logger?: Logger,
    private readonly protocol?: string,
    private readonly deviceName?: string,
  ) {}

  async compress(
    data: unknown,
    baselineSize: number,
    publishCount: number,
  ): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
    if (shouldMeasureBaseline(publishCount)) {
      return this.baseline(data, baselineSize);
    }
    if (this.dictionaryManager && this.opts.useKeyCompaction) {
      return this.applyDictionary(data, baselineSize);
    }
    return this.applyMsgpackOrJson(data, baselineSize);
  }

  // --- strategies -------------------------------------------------------------

  private async baseline(data: unknown, baselineSize: number): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
    const t0 = Date.now();
    const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();
    const payload = serializePayload(createJsonPayload(data as object, msgIdGen));
    const compressedSize = typeof payload === 'string' ? Buffer.byteLength(payload, 'utf-8') : payload.length;
    return {
      payload,
      info: { method: 'baseline', originalSize: baselineSize, compressedSize, ratio: 0, compressionMs: Date.now() - t0, isBaseline: true },
    };
  }

  private async applyDictionary(data: unknown, baselineSize: number): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
    const t0 = Date.now();
    const cpu0 = process.cpuUsage();

    const dictCpu0 = process.cpuUsage();
    const { compacted } = await this.dictionaryManager.compact(data, this.protocol);
    const dictCpu = process.cpuUsage(dictCpu0);

    let msgpackCpu: { user: number; system: number } | undefined;
    let intermediate: Buffer | string;
    if (this.opts.useMsgpack) {
      const cpu1 = process.cpuUsage();
      intermediate = msgpack.encode(compacted);
      msgpackCpu = process.cpuUsage(cpu1);
    } else {
      intermediate = JSON.stringify(compacted);
    }

    let deflateCpu: { user: number; system: number } | undefined;
    let finalPayload: Buffer | string;
    if (this.opts.useDeflate) {
      const buf = typeof intermediate === 'string' ? Buffer.from(intermediate, 'utf-8') : intermediate;
      const cpu1 = process.cpuUsage();
      finalPayload = shouldDeflate(buf.length, await getCpuUsage()) ? await deflateAsync(buf) : buf;
      deflateCpu = process.cpuUsage(cpu1);
    } else {
      finalPayload = intermediate;
    }

    const finalSize = typeof finalPayload === 'string' ? Buffer.byteLength(finalPayload, 'utf-8') : finalPayload.length;
    const method = (
      this.opts.useMsgpack
        ? (this.opts.useDeflate ? 'dictionary+msgpack+deflate' : 'dictionary+msgpack')
        : (this.opts.useDeflate ? 'dictionary+deflate' : 'dictionary')
    ) as CompressionInfo['method'];

    const serializationMethod = this.opts.useMsgpack ? 'msgpack' as const : 'dictionary' as const;
    const serializationCpu = this.opts.useMsgpack ? (msgpackCpu || dictCpu) : dictCpu;

    return {
      payload: finalPayload,
      info: {
        method, originalSize: baselineSize, compressedSize: finalSize,
        ratio: ((baselineSize - finalSize) / baselineSize) * 100,
        compressionMs: Date.now() - t0,
        cpuUsage: {
          serialization: { method: serializationMethod, cpu: serializationCpu },
          compression: deflateCpu ? { method: 'deflate', cpu: deflateCpu } : undefined,
          total: process.cpuUsage(cpu0),
        },
      },
    };
  }

  private async applyMsgpackOrJson(data: unknown, baselineSize: number): Promise<{ payload: Buffer | string; info: CompressionInfo }> {
    const t0 = Date.now();
    const cpu0 = process.cpuUsage();
    const msgIdGen = this.mqttConnection.getMessageIdGenerator?.();

    let msgpackCpu: { user: number; system: number } | undefined;
    let deflateCpu: { user: number; system: number } | undefined;
    let finalPayload: Buffer | string;
    let compressedSize: number;

    if (this.opts.useMsgpack) {
      const cpu1 = process.cpuUsage();
      let payload = serializePayload(createMsgpackPayload(data as object, msgIdGen));
      msgpackCpu = process.cpuUsage(cpu1);

      if (this.opts.useDeflate && shouldDeflate(payload.length, await getCpuUsage())) {
        const cpu2 = process.cpuUsage();
        finalPayload = await deflateAsync(payload);
        deflateCpu = process.cpuUsage(cpu2);
      } else {
        finalPayload = payload;
      }
      compressedSize = typeof finalPayload === 'string' ? Buffer.byteLength(finalPayload, 'utf-8') : finalPayload.length;
    } else {
      let payload = serializePayload(createJsonPayload(data as object, msgIdGen));

      if (this.opts.useDeflate) {
        const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf-8') : payload;
        if (shouldDeflate(buf.length, await getCpuUsage())) {
          const cpu1 = process.cpuUsage();
          finalPayload = await deflateAsync(buf);
          deflateCpu = process.cpuUsage(cpu1);
          compressedSize = finalPayload.length;
        } else {
          finalPayload = buf;
          compressedSize = buf.length;
        }
      } else {
        finalPayload = payload;
        compressedSize = baselineSize;
      }
    }

    const method = (
      this.opts.useMsgpack
        ? (this.opts.useDeflate ? 'msgpack+deflate' : 'msgpack')
        : (this.opts.useDeflate ? 'json+deflate' : 'json')
    ) as CompressionInfo['method'];

    return {
      payload: finalPayload!,
      info: {
        method, originalSize: baselineSize, compressedSize: compressedSize!,
        ratio: ((baselineSize - compressedSize!) / baselineSize) * 100,
        compressionMs: Date.now() - t0,
        cpuUsage: {
          serialization: msgpackCpu
            ? { method: 'msgpack', cpu: msgpackCpu }
            : { method: 'json', cpu: { user: 0, system: 0 } },
          compression: deflateCpu ? { method: 'deflate', cpu: deflateCpu } : undefined,
          total: process.cpuUsage(cpu0),
        },
      },
    };
  }
}
