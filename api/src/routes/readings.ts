/**
 * Readings API Routes
 * 
 * Endpoints for querying time-series sensor data from readings hypertable.
 */

import express from 'express';
import { z } from 'zod';
import { readingsService } from '../services/readings.service';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';

const router = express.Router();

// Validation schemas
const uuidSchema = z.string().uuid('Invalid device UUID format');
const metricNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_\-]+$/, 'Invalid metric name format');
const limitSchema = z.number().int().min(1).max(10000).default(1000);

/**
 * Get latest readings for a device
 * GET /api/readings/:device_uuid/latest
 * 
 * Query params:
 * - metrics: Comma-separated list of metric names (optional)
 */
router.get('/:device_uuid/latest', jwtAuth, async (req, res) => {
  try {
    const { device_uuid } = req.params;
    const { metrics } = req.query;
    const requestId = (req as any).id || 'unknown';
    const userId = (req as any).user?.id;

    // Validate device_uuid
    const validatedUuid = uuidSchema.parse(device_uuid);

    const metric_names = metrics ? (metrics as string).split(',').map(m => m.trim()) : undefined;

    const readings = await readingsService.getLatest(validatedUuid, metric_names);

    res.json({
      device_uuid: validatedUuid,
      count: readings.length,
      readings
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid device UUID format', requestId });
    }
    logger.error('Error getting latest readings', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * Get time-series data
 * GET /api/readings/:device_uuid/timeseries
 * 
 * Query params:
 * - metric: Metric name (optional)
 * - protocol: Protocol filter (optional)
 * - start: ISO 8601 start time (optional)
 * - end: ISO 8601 end time (optional)
 * - limit: Max results (default: 1000)
 */
router.get('/:device_uuid/timeseries', jwtAuth, async (req, res) => {
  try {
    const { device_uuid } = req.params;
    const { metric, protocol, start, end, limit } = req.query;
    const requestId = (req as any).id || 'unknown';

    // Validate device_uuid
    const validatedUuid = uuidSchema.parse(device_uuid);

    // Validate metric if provided
    if (metric) {
      metricNameSchema.parse(metric as string);
    }

    // Validate limit
    const validatedLimit = limitSchema.parse(limit ? parseInt(limit as string) : 1000);

    // Validate dates
    let startTime, endTime;
    if (start) {
      startTime = new Date(start as string);
      if (isNaN(startTime.getTime())) {
        return res.status(400).json({ error: 'Invalid start time format', requestId });
      }
    }
    if (end) {
      endTime = new Date(end as string);
      if (isNaN(endTime.getTime())) {
        return res.status(400).json({ error: 'Invalid end time format', requestId });
      }
    }

    const readings = await readingsService.getTimeSeries({
      device_uuid: validatedUuid,
      metric_name: metric as string,
      protocol: protocol as string,
      start_time: startTime,
      end_time: endTime,
      limit: validatedLimit
    });

    res.json({
      device_uuid: validatedUuid,
      count: readings.length,
      readings
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting timeseries', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * Get hourly aggregates (fast - uses continuous aggregate)
 * GET /api/readings/:device_uuid/:metric/hourly
 * 
 * Query params:
 * - start: ISO 8601 start time (required)
 * - end: ISO 8601 end time (required)
 */
router.get('/:device_uuid/:metric/hourly', jwtAuth, async (req, res) => {
  try {
    const { device_uuid, metric } = req.params;
    const { start, end } = req.query;
    const requestId = (req as any).id || 'unknown';

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end times are required', requestId });
    }

    // Validate inputs
    const validatedUuid = uuidSchema.parse(device_uuid);
    const validatedMetric = metricNameSchema.parse(metric);

    // Validate dates
    const startTime = new Date(start as string);
    const endTime = new Date(end as string);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).json({ error: 'Invalid date format', requestId });
    }

    const aggregates = await readingsService.getHourlyAggregates(
      validatedUuid,
      validatedMetric,
      startTime,
      endTime
    );

    res.json({
      device_uuid: validatedUuid,
      metric_name: validatedMetric,
      interval: 'hourly',
      count: aggregates.length,
      aggregates
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting hourly aggregates', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * Get daily aggregates (fast - uses continuous aggregate)
 * GET /api/readings/:device_uuid/:metric/daily
 * 
 * Query params:
 * - start: ISO 8601 start time (required)
 * - end: ISO 8601 end time (required)
 */
router.get('/:device_uuid/:metric/daily', jwtAuth, async (req, res) => {
  try {
    const { device_uuid, metric } = req.params;
    const { start, end } = req.query;
    const requestId = (req as any).id || 'unknown';

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end times are required', requestId });
    }

    // Validate inputs
    const validatedUuid = uuidSchema.parse(device_uuid);
    const validatedMetric = metricNameSchema.parse(metric);

    // Validate dates
    const startTime = new Date(start as string);
    const endTime = new Date(end as string);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return res.status(400).json({ error: 'Invalid date format', requestId });
    }

    const aggregates = await readingsService.getDailyAggregates(
      validatedUuid,
      validatedMetric,
      startTime,
      endTime
    );

    res.json({
      device_uuid: validatedUuid,
      metric_name: validatedMetric,
      interval: 'daily',
      count: aggregates.length,
      aggregates
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting daily aggregates', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * Get metrics summary
 * GET /api/readings/:device_uuid/summary
 */
router.get('/:device_uuid/summary', jwtAuth, async (req, res) => {
  try {
    const { device_uuid } = req.params;
    const requestId = (req as any).id || 'unknown';

    // Validate device_uuid
    const validatedUuid = uuidSchema.parse(device_uuid);

    const summary = await readingsService.getMetricsSummary(validatedUuid);

    res.json({
      device_uuid: validatedUuid,
      total_metrics: summary.length,
      metrics: summary
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid device UUID format', requestId });
    }
    logger.error('Error getting metrics summary', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * Insert reading (for testing/manual entry)
 * POST /api/readings
 * 
 * Body:
 * {
 *   "device_uuid": "...",
 *   "metric_name": "temperature",
 *   "value": 23.5,
 *   "unit": "°C",
 *   "protocol": "modbus",
 *   "quality": "good",
 *   "extra": { "slave_id": 1 }
 * }
 */
router.post('/', jwtAuth, async (req, res) => {
  try {
    const reading = req.body;
    const requestId = (req as any).id || 'unknown';
    const userId = (req as any).user?.id;

    // Validate required fields
    if (!reading.device_uuid || !reading.metric_name || !reading.protocol) {
      return res.status(400).json({
        error: 'device_uuid, metric_name, and protocol are required',
        requestId
      });
    }

    // Validate inputs
    const validatedUuid = uuidSchema.parse(reading.device_uuid);
    const validatedMetric = metricNameSchema.parse(reading.metric_name);
    const validatedProtocol = z.string().min(1).max(50).parse(reading.protocol);
    const validatedValue = z.number().parse(reading.value);

    // Validate quality if provided
    if (reading.quality) {
      z.enum(['good', 'fair', 'poor']).parse(reading.quality);
    }

    const sanitizedReading = {
      device_uuid: validatedUuid,
      metric_name: validatedMetric,
      value: validatedValue,
      unit: reading.unit ? z.string().max(20).parse(reading.unit) : undefined,
      protocol: validatedProtocol,
      quality: reading.quality || 'good',
      extra: reading.extra || null
    };

    await readingsService.insert(sanitizedReading);

    logger.info('Reading inserted', { requestId, userId, deviceUuid: validatedUuid, metric: validatedMetric });
    res.status(201).json({ message: 'Reading inserted successfully', requestId });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid reading data', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid reading data', requestId });
    }
    logger.error('Error inserting reading', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

export default router;
