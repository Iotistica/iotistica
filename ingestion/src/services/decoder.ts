import { promisify } from 'util';
import { brotliDecompress, gunzip, inflate } from 'zlib';
import { logger } from '../utils/logger';
import { DeviceDataEntry } from './types';

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

const shortId = (id?: string): string | undefined => id?.substring(0, 8);

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
  const startTime = Date.now();

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

    let readings: any[];
    try {
      const parsed = JSON.parse(rawJson);
      readings = Array.isArray(parsed) ? parsed : [parsed];
    } catch (parseErr: any) {
      logger.error('Failed to parse decompressed device payload', {
        deviceUuid: shortId(deviceUuid),
        deviceName: deviceName,
        encoding: contentEncoding,
        decompressedBytes: decompressed.length,
        error: parseErr.message,
        rawJsonPreview: rawJson.substring(0, 200),
      });
      throw parseErr;
    }

    const entries: DeviceDataEntry[] = readings.map((reading: any) => ({
      deviceUuid: reading.deviceUuid || deviceUuid,
      deviceName: reading.deviceName || deviceName,
      timestamp: reading.timestamp || new Date().toISOString(),
      data: reading.data || reading,
      metadata: reading.metadata,
    }));

    logger.debug('Decompressed device payload', {
      deviceUuid: shortId(deviceUuid),
      deviceName,
      encoding: contentEncoding,
      compressedBytes: compressedPayload.length,
      decompressedBytes: decompressed.length,
      readingCount: entries.length,
      durationMs: Date.now() - startTime,
    });

    return entries;
  } catch (err: any) {
    logger.error('Failed to decompress device payload', {
      deviceUuid: shortId(deviceUuid),
      deviceName: deviceName,
      encoding: contentEncoding,
      compressedBytes: compressedPayload.length,
      error: err.message,
    });
    throw err;
  }
}
