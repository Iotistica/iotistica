"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.decompressAndParseDevices = decompressAndParseDevices;
const util_1 = require("util");
const zlib_1 = require("zlib");
const logger_1 = require("../utils/logger");
const brotliDecompressAsync = (0, util_1.promisify)(zlib_1.brotliDecompress);
const gunzipAsync = (0, util_1.promisify)(zlib_1.gunzip);
const inflateAsync = (0, util_1.promisify)(zlib_1.inflate);
const shortId = (id) => id?.substring(0, 8);
async function decompressAndParseDevices(compressedPayload, contentEncoding, deviceUuid, deviceName) {
    const startTime = Date.now();
    try {
        let decompressed;
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
        let readings;
        try {
            const parsed = JSON.parse(rawJson);
            readings = Array.isArray(parsed) ? parsed : [parsed];
        }
        catch (parseErr) {
            logger_1.logger.error('Failed to parse decompressed device payload', {
                deviceUuid: shortId(deviceUuid),
                deviceName: deviceName,
                encoding: contentEncoding,
                decompressedBytes: decompressed.length,
                error: parseErr.message,
                rawJsonPreview: rawJson.substring(0, 200),
            });
            throw parseErr;
        }
        const entries = readings.map((reading) => ({
            deviceUuid: reading.deviceUuid || deviceUuid,
            deviceName: reading.deviceName || deviceName,
            timestamp: reading.timestamp || new Date().toISOString(),
            data: reading.data || reading,
            metadata: reading.metadata,
        }));
        logger_1.logger.debug('Decompressed device payload', {
            deviceUuid: shortId(deviceUuid),
            deviceName,
            encoding: contentEncoding,
            compressedBytes: compressedPayload.length,
            decompressedBytes: decompressed.length,
            readingCount: entries.length,
            durationMs: Date.now() - startTime,
        });
        return entries;
    }
    catch (err) {
        logger_1.logger.error('Failed to decompress device payload', {
            deviceUuid: shortId(deviceUuid),
            deviceName: deviceName,
            encoding: contentEncoding,
            compressedBytes: compressedPayload.length,
            error: err.message,
        });
        throw err;
    }
}
//# sourceMappingURL=decoder.js.map