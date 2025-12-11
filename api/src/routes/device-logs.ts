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
import { redisSensorQueue } from '../services/redis-sensor-queue';


export const router = express.Router();



/**
 * Device uploads logs
 * POST /api/v1/device/:uuid/logs
 * 
 * Accepts both JSON array and NDJSON (newline-delimited JSON) formats
 */
router.post('/device/:uuid/logs', deviceAuth, express.text({ type: 'application/x-ndjson' }), async (req, res) => {
  logger.debug('POST /device/:uuid/logs endpoint hit', { uuid: req.params.uuid });
  try {
    const { uuid } = req.params;
    let logs: any[];

    // Check Content-Type to determine format
    const contentType = req.headers['content-type'] || '';
    
    if (contentType.includes('application/x-ndjson') || contentType.includes('text/plain')) {
      // Parse NDJSON format (newline-delimited JSON)
      const ndjsonText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      logs = ndjsonText
        .split('\n')
        .filter(line => line.trim().length > 0)
        .map(line => {
          try {
            return JSON.parse(line);
          } catch (e) {
            logger.warn('Failed to parse NDJSON line', { line: line.substring(0, 100) });
            return null;
          }
        })
        .filter(log => log !== null);
      
      logger.info('Received logs from device (NDJSON format)', { 
        uuid: uuid.substring(0, 8), 
        count: logs.length 
      });
    } else {
      // Standard JSON array format
      logs = req.body;
      logger.info('Received logs from device (JSON array format)', { 
        uuid: uuid.substring(0, 8),
        count: Array.isArray(logs) ? logs.length : 0
      });
    }

    logger.debug('Log details', { 
      type: typeof logs, 
      isArray: Array.isArray(logs), 
      length: logs?.length,
      firstLog: logs && logs.length > 0 ? logs[0] : null
    });

    // Ensure device exists
    await DeviceModel.getOrCreate(uuid);

    // Store logs
    if (Array.isArray(logs) && logs.length > 0) {
      const startTime = Date.now();
      logger.debug('Storing logs', { count: logs.length });
      
      // Transform agent log format to API format
      const transformedLogs = logs.map((log: any) => ({
        serviceName: log.serviceName || log.source?.name || null,
        timestamp: log.timestamp ? new Date(log.timestamp) : new Date(),
        message: log.message,
        isSystem: log.isSystem || false,
        isStderr: log.isStderr || log.isStdErr || false, // Handle both field names
        level: log.level || 'info' // Agent sends this field
      }));
      
      // Apply sampling to reduce database writes
      // LOG_SAMPLING_RATE: 0.0-1.0 (default: 1.0 = store all logs)
      // Always store ERROR and WARN logs, sample INFO/DEBUG
      const samplingRate = parseFloat(process.env.LOG_SAMPLING_RATE || '1.0');
      const sampledLogs = transformedLogs.filter(log => {
        // Always store errors and warnings (use level field from agent)
        if (log.level === 'error' || log.level === 'warn' || log.isStderr) {
          return true;
        }
        
        // Sample info/debug logs based on rate
        return Math.random() < samplingRate;
      });
      
      const droppedCount = transformedLogs.length - sampledLogs.length;
      if (droppedCount > 0) {
        logger.debug('Sampled logs', { 
          received: transformedLogs.length, 
          stored: sampledLogs.length, 
          dropped: droppedCount,
          samplingRate 
        });
      }
      
      // Add logs to Redis Stream instead of writing immediately
      if (sampledLogs.length > 0) {
        // Add deviceUuid to each log entry
        const logsWithDevice = sampledLogs.map(log => ({
          ...log,
          deviceUuid: uuid
        }));
        
        await redisLogQueue.add(logsWithDevice);
        
        const duration = Date.now() - startTime;
        logger.info('Queued logs to Redis Stream', { 
          received: logs.length,
          queued: sampledLogs.length,
          dropped: droppedCount,
          uuid: uuid.substring(0, 8),
          durationMs: duration
        });
      }
      
      // Publish logs to Redis pub/sub for real-time WebSocket streaming
      try {
        const { redisClient } = await import('../redis/client');
        await redisClient.publish(`device:${uuid}:logs`, JSON.stringify({ logs: transformedLogs }));
        logger.debug('Published logs to Redis pub/sub', { count: transformedLogs.length });
      } catch (error) {
        logger.warn('Failed to publish logs to Redis', { error });
        // Don't fail the request if Redis publish fails
      }
    } else {
      logger.warn('No logs to store or invalid format');
    }

    res.json({ status: 'ok', received: Array.isArray(logs) ? logs.length : 0 });
  } catch (error: any) {
    logger.error('Error storing logs', { error: error.message });
    res.status(500).json({
      error: 'Failed to process logs',
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
