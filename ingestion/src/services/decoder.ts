import { performance } from 'perf_hooks';
import { promisify } from 'util';
import { brotliDecompress, gunzip, inflate } from 'zlib';
import { logger, pinoLogger } from '../utils/logger';
import { DeviceDataEntry } from './types';

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

const shortId = (id?: string): string | undefined => id?.substring(0, 8);
const getErrorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Decompress and parse a compressed device payload from the Redis stream.
 * Supports Brotli, gzip, deflate, and identity (no compression).
 * Runs in the worker loop — offloads CPU from the main request thread.
 */
export async function decompressAndParseDevices(
  compressedPayload: Buffer,
  contentEncoding: string,
  deviceUuid: string,
  deviceName: string,
): Promise<DeviceDataEntry[]> {
  const startTime = performance.now();
  const debugEnabled = pinoLogger.isLevelEnabled('debug');

  try {
    let decompressed: Buffer;

    switch (contentEncoding) {
      case 'br':
        decompressed = await brotliDecompressAsync(compressedPayload);
        break;
      case 'gzip':
        decompressed = await gunzipAsync(compressedPayload);
        break;
      case 'deflate':
        decompressed = await inflateAsync(compressedPayload);
        break;
      case 'identity':
      default:
        decompressed = compressedPayload;
        break;
    }

    const rawJson = decompressed.toString('utf8');

    let entries: DeviceDataEntry[];
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      const readings = Array.isArray(parsed) ? parsed : [parsed];
      const fallbackTimestamp = new Date().toISOString();
      entries = new Array<DeviceDataEntry>(readings.length);

      for (let i = 0; i < readings.length; i++) {
        const reading = readings[i] as Record<string, unknown>;
        entries[i] = {
          deviceUuid: (reading.deviceUuid as string) || deviceUuid,
          deviceName: (reading.deviceName as string) || deviceName,
          timestamp: (reading.timestamp as string) || fallbackTimestamp,
          data: reading.data ?? reading,
          metadata: reading.metadata as Record<string, unknown> | undefined,
        };
      }
    } catch (parseErr: unknown) {
      const meta: Record<string, unknown> = {
        deviceUuid: shortId(deviceUuid),
        deviceName,
        encoding: contentEncoding,
        decompressedBytes: decompressed.length,
        error: getErrorMessage(parseErr),
      };
      if (debugEnabled) {
        meta.rawJsonPreview = rawJson.slice(0, 200);
      }
      logger.error('Failed to parse decompressed device payload', meta);
      throw parseErr;
    }

    if (debugEnabled) {
      logger.debug('Decompressed device payload', {
        deviceUuid: shortId(deviceUuid),
        deviceName,
        encoding: contentEncoding,
        compressedBytes: compressedPayload.length,
        decompressedBytes: decompressed.length,
        readingCount: entries.length,
        durationMs: performance.now() - startTime,
      });
    }

    return entries;
  } catch (err: unknown) {
    logger.error('Failed to decompress device payload', {
      deviceUuid: shortId(deviceUuid),
      deviceName,
      encoding: contentEncoding,
      compressedBytes: compressedPayload.length,
      error: getErrorMessage(err),
    });
    throw err;
  }
}
