/**
 * Readings API Routes
 * 
 * Endpoints for querying time-series sensor data from readings hypertable.
 */

import express from 'express';
import { readingsService } from '../services/readings.service';
import logger from '../utils/logger';

const router = express.Router();

/**
 * Get latest readings for a device
 * GET /api/readings/:device_uuid/latest
 * 
 * Query params:
 * - metrics: Comma-separated list of metric names (optional)
 */
router.get('/:device_uuid/latest', async (req, res) => {
  try {
    const { device_uuid } = req.params;
    const { metrics } = req.query;

    const metric_names = metrics ? (metrics as string).split(',') : undefined;

    const readings = await readingsService.getLatest(device_uuid, metric_names);

    res.json({
      device_uuid,
      count: readings.length,
      readings
    });
  } catch (error: any) {
    logger.error('Error getting latest readings', { error: error.message });
    res.status(500).json({ error: 'Failed to get latest readings' });
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
router.get('/:device_uuid/timeseries', async (req, res) => {
  try {
    const { device_uuid } = req.params;
    const { metric, protocol, start, end, limit } = req.query;

    const readings = await readingsService.getTimeSeries({
      device_uuid,
      metric_name: metric as string,
      protocol: protocol as string,
      start_time: start ? new Date(start as string) : undefined,
      end_time: end ? new Date(end as string) : undefined,
      limit: limit ? parseInt(limit as string) : 1000
    });

    res.json({
      device_uuid,
      count: readings.length,
      readings
    });
  } catch (error: any) {
    logger.error('Error getting timeseries', { error: error.message });
    res.status(500).json({ error: 'Failed to get timeseries data' });
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
router.get('/:device_uuid/:metric/hourly', async (req, res) => {
  try {
    const { device_uuid, metric } = req.params;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end times are required' });
    }

    const aggregates = await readingsService.getHourlyAggregates(
      device_uuid,
      metric,
      new Date(start as string),
      new Date(end as string)
    );

    res.json({
      device_uuid,
      metric_name: metric,
      interval: 'hourly',
      count: aggregates.length,
      aggregates
    });
  } catch (error: any) {
    logger.error('Error getting hourly aggregates', { error: error.message });
    res.status(500).json({ error: 'Failed to get hourly aggregates' });
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
router.get('/:device_uuid/:metric/daily', async (req, res) => {
  try {
    const { device_uuid, metric } = req.params;
    const { start, end } = req.query;

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end times are required' });
    }

    const aggregates = await readingsService.getDailyAggregates(
      device_uuid,
      metric,
      new Date(start as string),
      new Date(end as string)
    );

    res.json({
      device_uuid,
      metric_name: metric,
      interval: 'daily',
      count: aggregates.length,
      aggregates
    });
  } catch (error: any) {
    logger.error('Error getting daily aggregates', { error: error.message });
    res.status(500).json({ error: 'Failed to get daily aggregates' });
  }
});

/**
 * Get metrics summary
 * GET /api/readings/:device_uuid/summary
 */
router.get('/:device_uuid/summary', async (req, res) => {
  try {
    const { device_uuid } = req.params;

    const summary = await readingsService.getMetricsSummary(device_uuid);

    res.json({
      device_uuid,
      total_metrics: summary.length,
      metrics: summary
    });
  } catch (error: any) {
    logger.error('Error getting metrics summary', { error: error.message });
    res.status(500).json({ error: 'Failed to get metrics summary' });
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
router.post('/', async (req, res) => {
  try {
    const reading = req.body;

    if (!reading.device_uuid || !reading.metric_name || !reading.protocol) {
      return res.status(400).json({
        error: 'device_uuid, metric_name, and protocol are required'
      });
    }

    await readingsService.insert(reading);

    res.status(201).json({ message: 'Reading inserted successfully' });
  } catch (error: any) {
    logger.error('Error inserting reading', { error: error.message });
    res.status(500).json({ error: 'Failed to insert reading' });
  }
});

export default router;
