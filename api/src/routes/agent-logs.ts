/**
 * Device State Management Routes
 * Handles device target state, current state, and state reporting
 * 
 * Separated from cloud.ts for better organization
 * 
 * Device-Side Endpoints (used by devices themselves):
 * - GET  /api/v1/device/:uuid/state - Device polls for target state (ETag cached)
 * - POST /api/v1/device/:uuid/logs - Device uploads logs
 * - PATCH /api/v1/device/state - Device reports current state + metrics
 * 
 * Management API Endpoints (used by dashboard/admin):
 * - GET /api/v1/devices/:uuid/target-state - Get device target state
 * - POST /api/v1/devices/:uuid/target-state - Set device target state
 * - PUT /api/v1/devices/:uuid/target-state - Update device target state
 * - GET /api/v1/devices/:uuid/current-state - Get device current state
 * - DELETE /api/v1/devices/:uuid/target-state - Clear device target state
 * - GET /api/v1/devices/:uuid/logs - Get device logs
 * - GET /api/v1/devices/:uuid/metrics - Get device metrics
 */

import express from 'express';
import { query } from '../db/connection';
import {
  DeviceModel,
  DeviceLogsModel,
} from '../db/models';
import { logger } from '../utils/logger';
import deviceAuth, { deviceAuthFromBody } from '../middleware/device-auth';
import { redisLogQueue } from '../services/redis-log-queue';
import { redisSensorQueue } from '../services/redis-device-queue';


export const router = express.Router();

/**
 * Check if batch ID has been processed before (idempotency)
 * Uses Redis with 24-hour TTL
 */
async function checkBatchIdempotency(deviceUuid: string, batchId: string): Promise<boolean> {
  try {
    const { redisClient } = await import('../redis/client');
    const client = redisClient.getClient();
    if (!client) {
      logger.warn('Redis client not available for idempotency check');
      return false;
    }
    const key = `batch:${deviceUuid}:${batchId}`;
    const exists = await client.exists(key);
    return exists === 1;
  } catch (error) {
    logger.warn('Failed to check batch idempotency (Redis unavailable)', { error });
    return false; // Fail open (allow duplicate if Redis down)
  }
}

/**
 * Store batch ID for duplicate detection (24-hour TTL)
 */
async function storeBatchId(deviceUuid: string, batchId: string): Promise<void> {
  try {
    const { redisClient } = await import('../redis/client');
    const client = redisClient.getClient();
    if (!client) {
      logger.warn('Redis client not available for batch storage');
      return;
    }
    const key = `batch:${deviceUuid}:${batchId}`;
    const TTL = 24 * 60 * 60; // 24 hours
    await client.setex(key, TTL, Date.now().toString());
    logger.debug('Stored batch ID for idempotency', { deviceUuid: deviceUuid.substring(0, 8), batchId });
  } catch (error) {
    logger.warn('Failed to store batch ID (Redis unavailable)', { error });
    // Don't fail request if Redis unavailable
  }
}



/**
 * Brotli handling middleware (must run BEFORE express.raw())
 * Express body-parser rejects Brotli encoding by default.
 * We don't decompress here (that would block the event loop).
 * Instead, we preserve the original encoding and strip the header so Express accepts it as binary,
 * then the worker will decompress it asynchronously.
 */
const brotliHandlingMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const contentEncoding = req.headers['content-encoding'];
  
  if (contentEncoding === 'br') {
    // Save original encoding so route handler can use it
    (req as any).originalContentEncoding = 'br';
    // Strip content-encoding header so Express doesn't reject Brotli
    // The body stays compressed - worker will decompress it asynchronously
    delete req.headers['content-encoding'];
    logger.debug('Stripped Brotli content-encoding header (worker will decompress)', {
      path: req.path,
      uuid: req.params.uuid
    });
  } else if (contentEncoding === 'gzip' || contentEncoding === 'deflate') {
    // Express will auto-decompress these, save the original encoding
    (req as any).originalContentEncoding = contentEncoding;
  } else {
    (req as any).originalContentEncoding = 'identity';
  }
  
  next();
};

/**
 * Device uploads logs with ACK-based durability
 * POST /api/v1/device/:uuid/logs
 * 
 * OPTIMIZATION: Accepts RAW compressed body (Brotli/gzip) and queues directly to Redis.
 * CPU-intensive decompression + JSON parsing happens in worker process to avoid
 * event loop blocking in the main API server.
 * 
 * Accepts both JSON array and NDJSON (newline-delimited JSON) formats (after decompression)
 * 
 * Headers:
 * - Content-Encoding: br, gzip, deflate, or identity
 * - Content-Type: application/x-ndjson or application/json
 * - X-Batch-Id: Unique batch identifier for idempotency
 * - X-Batch-Attempt: Retry attempt number (optional)
 * 
 * Response:
 * - { batchId: string, accepted: boolean, queued: true } - ACK confirmation (202 Accepted)
 */
router.post('/device/:uuid/logs', 
  deviceAuth,
  brotliHandlingMiddleware, // Strip Brotli header (worker will decompress)
  express.raw({ 
    type: '*/*', // Accept any content type (worker will validate)
    limit: '10mb' // COMPRESSED size limit (protects against decompression bombs)
  }),
  async (req, res) => {
  logger.debug('POST /device/:uuid/logs endpoint hit (raw mode)', { uuid: req.params.uuid });
  try {
    const { uuid } = req.params;
    
    // Extract batch metadata for idempotency
    const batchId = req.headers['x-batch-id'] as string | undefined;
    const batchAttempt = parseInt(req.headers['x-batch-attempt'] as string || '1');

    // Idempotency check (deduplicate retries)
    if (batchId) {
      const isDuplicate = await checkBatchIdempotency(uuid, batchId);
      if (isDuplicate) {
        logger.info('Duplicate batch detected, skipping', { 
          uuid: uuid.substring(0, 8), 
          batchId,
          attempt: batchAttempt
        });
        return res.status(200).json({ 
          batchId, 
          accepted: true,
          duplicate: true
        });
      }
    }
    
    // Ensure device exists (lightweight check, don't auto-create)
    const device = await DeviceModel.getOrCreate(uuid);
    if (!device) {
      logger.warn('Log upload from unregistered device - rejecting', {
        deviceUuid: uuid.substring(0, 8) + '...',
      });
      return res.status(404).json({
        error: 'Device not registered',
        message: 'Please complete device registration before uploading logs'
      });
    }
    
    // CRITICAL: Express body-parser auto-decompresses gzip/deflate BEFORE our handler runs
    // If original encoding was gzip/deflate, the body is now decompressed (raw JSON)
    // Store as 'identity' encoding to prevent worker from trying to decompress again
    let finalEncoding = (req as any).originalContentEncoding || 'identity';
    if (finalEncoding === 'gzip' || finalEncoding === 'deflate') {
      // Body-parser already decompressed this - treat as identity
      logger.debug('Body-parser pre-decompressed', {
        uuid: uuid.substring(0, 8),
        originalEncoding: finalEncoding
      });
      finalEncoding = 'identity';
    }
    
    const contentType = req.headers['content-type'] || 'application/x-ndjson';
    const finalPayload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    
    logger.info('Queueing log payload', {
      uuid: uuid.substring(0, 8),
      batchId,
      encoding: finalEncoding,
      compressedBytes: finalPayload.length
    });
    
    // Fire-and-forget: Don't await Redis write - return 202 immediately
    // This prevents slow Redis network I/O from blocking the response (saves ~3 seconds)
    redisLogQueue.addCompressed({
      deviceUuid: uuid,
      batchId: batchId || `auto-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      compressedPayload: finalPayload,
      contentEncoding: finalEncoding,
      contentType
    }).catch(err => {
      logger.error('Failed to queue logs to Redis (async)', {
        uuid: uuid.substring(0, 8),
        batchId,
        error: err.message
      });
    });
    
    // Store batch ID for idempotency (24-hour TTL)
    if (batchId) {
      await storeBatchId(uuid, batchId);
    }
    
    // Return ACK immediately (202 Accepted - queued for async processing)
    // Worker will decompress, parse, validate, and insert to database
    return res.status(202).json({ 
      batchId: batchId || 'auto-generated',
      accepted: true,
      queued: true // Indicates async processing
    });
  } catch (error: any) {
    logger.error('Error queueing logs', { 
      error: error.message,
      stack: error.stack,
      uuid: req.params.uuid?.substring(0, 8),
      bodySize: Buffer.isBuffer(req.body) ? req.body.length : 0
    });
    res.status(500).json({
      error: 'Failed to queue logs',
      message: error.message
    });
  }
});


/**
 * Device reports dropped log summaries (connection loss tracking)
 * POST /api/v1/device/:uuid/logs/dropped-summaries
 * 
 * Allows agents to report which logs were dropped during connection outages
 * This helps with troubleshooting and understanding data loss
 */
router.post('/device/:uuid/logs/dropped-summaries', deviceAuth, express.json(), async (req, res) => {
  try {
    const { uuid } = req.params;
    const { summaries, reportedAt } = req.body;

    logger.info('Received dropped log summaries', {
      uuid: uuid.substring(0, 8),
      summaryCount: summaries?.length || 0,
      totalDropped: summaries?.reduce((sum: number, s: any) => sum + (s.totalCount || 0), 0) || 0
    });

    // TODO: Store summaries in database for analysis
    // For now, just log them and acknowledge receipt
    // Could be stored in a separate dropped_logs_summary table

    res.json({ 
      status: 'ok', 
      received: summaries?.length || 0,
      message: 'Summaries received and logged'
    });
  } catch (error: any) {
    logger.error('Error processing dropped log summaries', { error: error.message });
    res.status(500).json({
      error: 'Failed to process dropped log summaries',
      message: error.message
    });
  }
});


/**
 * Get device logs
 * GET /api/v1/devices/:uuid/logs
 */
router.get('/devices/:uuid/logs', async (req, res) => {
  try {
    const { uuid } = req.params;
    const serviceName = req.query.service as string | undefined;
    const limit = parseInt(req.query.limit as string) || 1000;
    const offset = parseInt(req.query.offset as string) || 0;
    const from = req.query.from as string | undefined;
    const to = req.query.to as string | undefined;

    // Build filter options
    const filterOptions: any = {
      serviceName,
      limit,
      offset,
    };

    // Add date range filtering
    if (from) {
      filterOptions.since = new Date(from);
    }
    
    // Note: DeviceLogsModel doesn't have 'until' param, so we'll filter by 'since'
    // and rely on limit. For proper date range, we'd need to add 'until' support.

    const logs = await DeviceLogsModel.get(uuid, filterOptions);
    
    // If 'to' is provided, filter results in memory (temporary solution)
    let filteredLogs = logs;
    if (to) {
      const toDate = new Date(to);
      toDate.setHours(23, 59, 59, 999); // End of day
      filteredLogs = logs.filter(log => new Date(log.timestamp) <= toDate);
    }

    res.json({
      count: filteredLogs.length,
      logs: filteredLogs,
    });
  } catch (error: any) {
    logger.error('Error getting logs', { error: error.message });
    res.status(500).json({
      error: 'Failed to get logs',
      message: error.message
    });
  }
});

/**
 * Get list of services with logs for a device
 * GET /api/v1/devices/:uuid/logs/services
 */
router.get('/devices/:uuid/logs/services', async (req, res) => {
  try {
    const { uuid } = req.params;
    
    const result = await query(
      'SELECT DISTINCT service_name FROM device_logs WHERE device_uuid = $1 ORDER BY service_name ASC',
      [uuid]
    );
    
    const services = result.rows.map(row => row.service_name);
    
    res.json({
      services,
    });
  } catch (error: any) {
    logger.error('Error getting log services', { error: error.message });
    res.status(500).json({
      error: 'Failed to get log services',
      message: error.message
    });
  }
});

/**
 * Get Redis Stream queue statistics
 * GET /api/v1/admin/log-queue/stats
 */
router.get('/admin/log-queue/stats', async (req, res) => {
  try {
    const stats = await redisLogQueue.getStats();
    res.json(stats);
  } catch (error: any) {
    logger.error('Error getting log queue stats', { error: error.message });
    res.status(500).json({
      error: 'Failed to get log queue stats',
      message: error.message
    });
  }
});

/**
 * Get Redis Stream sensor queue statistics
 * GET /api/v1/admin/sensor-queue/stats
 */
router.get('/admin/sensor-queue/stats', async (req, res) => {
  try {
    const stats = await redisSensorQueue.getStats();
    res.json(stats);
  } catch (error: any) {
    logger.error('Error getting sensor queue stats', { error: error.message });
    res.status(500).json({
      error: 'Failed to get sensor queue stats',
      message: error.message
    });
  }
});


export default router;
