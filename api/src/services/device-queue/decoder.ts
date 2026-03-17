import { promisify } from 'util';
import { brotliDecompress, gunzip, inflate } from 'zlib';
import { logger } from '../../utils/logger';
import { SensorDataEntry } from './types';

const brotliDecompressAsync = promisify(brotliDecompress);
const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);

const shortId = (id?: string): string | undefined => id?.substring(0, 8);

/**
 * Decompress and parse a compressed sensor payload from the Redis stream.
 * Supports Brotli, gzip, deflate, and identity (no compression).
 * Runs in the worker loop — offloads CPU from the main request thread.
 */
export async function decompressAndParseSensors(
  compressedPayload: Buffer,
  contentEncoding: string,
  deviceUuid: string,
  sensorName: string,
): Promise<SensorDataEntry[]> {
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
      logger.error('Failed to parse decompressed sensor payload', {
        deviceUuid: shortId(deviceUuid),
        sensorName,
        encoding: contentEncoding,
        decompressedBytes: decompressed.length,
        error: parseErr.message,
        rawJsonPreview: rawJson.substring(0, 200),
      });
      throw parseErr;
    }

    const entries: SensorDataEntry[] = readings.map((reading: any) => ({
      deviceUuid: reading.deviceUuid || deviceUuid,
      sensorName: reading.sensorName || sensorName,
      timestamp: reading.timestamp || new Date().toISOString(),
      data: reading.data || reading,
      metadata: reading.metadata,
    }));

    logger.debug('Decompressed sensor payload', {
      deviceUuid: shortId(deviceUuid),
      sensorName,
      encoding: contentEncoding,
      compressedBytes: compressedPayload.length,
      decompressedBytes: decompressed.length,
      readingCount: entries.length,
      durationMs: Date.now() - startTime,
    });

    return entries;
  } catch (err: any) {
    logger.error('Failed to decompress sensor payload', {
      deviceUuid: shortId(deviceUuid),
      sensorName,
      encoding: contentEncoding,
      compressedBytes: compressedPayload.length,
      error: err.message,
    });
    throw err;
  }
}
