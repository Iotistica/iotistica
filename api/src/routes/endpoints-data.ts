/**
 * Endpoints Data API
 * 
 * Provides time-series data for dashboard visualizations
 * Uses TimescaleDB continuous aggregate for performance
 */

import express from 'express';
import { query } from '../db/connection';
import { logger } from '../utils/logger';
import { z } from 'zod';

export const router = express.Router();

// Validation schema for time range
const timeRangeSchema = z.enum(['1h', '6h', '24h', '7d', '30d']).default('24h');
const aggregationSchema = z.enum(['avg', 'min', 'max', 'last']).default('avg');

/**
 * GET /api/endpoints/timeseries
 * 
 * Query parameters:
 * - devices: Comma-separated device UUIDs (optional, default: all)
 * - metrics: Comma-separated metric names (optional, default: all)
 * - timeRange: 1h, 24h, 7d, 30d (default: 24h)
 * - interval: auto, 5m, 1h, 1d (default: auto based on timeRange)
 * - aggregation: avg, min, max, last (default: avg)
 */
router.get('/timeseries', async (req, res) => {
  try {
    const {
      devices,
      metrics,
      timeRange = '24h',
      interval = 'auto',
      aggregation = 'avg'
    } = req.query;

    // Validate time range parameter
    const validTimeRange = timeRangeSchema.safeParse(timeRange);
    if (!validTimeRange.success) {
      return res.status(400).json({
        error: 'Invalid timeRange parameter',
        message: 'timeRange must be one of: 1h, 6h, 24h, 7d, 30d'
      });
    }

    // Validate aggregation parameter
    const validAggregation = aggregationSchema.safeParse(aggregation);
    if (!validAggregation.success) {
      return res.status(400).json({
        error: 'Invalid aggregation parameter',
        message: 'aggregation must be one of: avg, min, max, last'
      });
    }

    // Parse time range using lookup table (safe, no injection)
    const timeRangeMap: Record<string, { unit: string; value: number }> = {
      '1h': { unit: 'hours', value: 1 },
      '6h': { unit: 'hours', value: 6 },
      '24h': { unit: 'hours', value: 24 },
      '7d': { unit: 'days', value: 7 },
      '30d': { unit: 'days', value: 30 }
    };
    const timeRangeConfig = timeRangeMap[validTimeRange.data] || timeRangeMap['24h'];

    // Auto-select interval based on time range
    let bucketInterval = interval as string;
    if (interval === 'auto') {
      if (timeRange === '1h' || timeRange === '6h') {
        bucketInterval = '5 minutes';
      } else if (timeRange === '24h') {
        bucketInterval = '1 hour';
      } else {
        bucketInterval = '1 day';
      }
    }

    // Build WHERE conditions
    const conditions: string[] = [];
    const params: any[] = [];

    if (devices) {
      const deviceList = (devices as string).split(',');
      conditions.push(`device_uuid = ANY($${params.length + 1})`);
      params.push(deviceList);
    }

    if (metrics) {
      const metricList = (metrics as string).split(',');
      conditions.push(`metric_name = ANY($${params.length + 1})`);
      params.push(metricList);
    }

    // SECURITY FIX: Use make_interval function with parameters to prevent SQL injection
    // Instead of: bucket >= NOW() - INTERVAL '${pgInterval}'
    // Use: bucket >= NOW() - make_interval(${unit} => ${value})
    conditions.push(`bucket >= NOW() - make_interval(${timeRangeConfig.unit} => $${params.length + 1})`);
    params.push(timeRangeConfig.value);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Select aggregation column (validated against enum)
    const aggColumn = validAggregation.data === 'avg' ? 'avg_value' :
                      validAggregation.data === 'min' ? 'min_value' :
                      validAggregation.data === 'max' ? 'max_value' :
                      'last_value';

    // Query continuous aggregate
    const result = await query(`
      SELECT 
        bucket,
        device_uuid,
        device_name,
        metric_name,
        protocol,
        ${aggColumn} as value,
        sample_count
      FROM readings_hourly
      ${whereClause}
      ORDER BY bucket ASC, device_uuid, device_name, metric_name
    `, params);

    res.json({
      timeRange: validTimeRange.data,
      interval: bucketInterval,
      aggregation: validAggregation.data,
      dataPoints: result.rows.length,
      data: result.rows
    });

  } catch (error: any) {
    logger.error('Error fetching timeseries data', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Internal server error', requestId: req.id || 'unknown' });
  }
});

/**
 * GET /api/endpoints/current
 * 
 * Get current values for all devices/metrics (latest reading)
 */
router.get('/current', async (req, res) => {
  try {
    const { devices, metrics } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];

    if (devices) {
      const deviceList = (devices as string).split(',');
      conditions.push(`r.device_uuid = ANY($${params.length + 1})`);
      params.push(deviceList);
    }

    if (metrics) {
      const metricList = (metrics as string).split(',');
      conditions.push(`r.metric_name = ANY($${params.length + 1})`);
      params.push(metricList);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await query(`
      WITH latest AS (
        SELECT DISTINCT ON (device_uuid, device_name, metric_name)
          device_uuid,
          device_name,
          metric_name,
          protocol,
          last_value as value,
          last_time as timestamp,
          bucket
        FROM readings_hourly
        ORDER BY device_uuid, device_name, metric_name, bucket DESC
      )
      SELECT 
        r.device_uuid,
        r.device_name,
        r.metric_name,
        r.protocol,
        r.value,
        r.timestamp,
        CASE 
          WHEN d.last_connectivity_event > NOW() - INTERVAL '5 minutes' THEN 'online'
          WHEN d.last_connectivity_event > NOW() - INTERVAL '1 hour' THEN 'degraded'
          ELSE 'offline'
        END as device_status
      FROM latest r
      LEFT JOIN devices d ON d.uuid = r.device_uuid
      ${whereClause}
      ORDER BY r.device_name, r.metric_name
    `, params);

    res.json({
      timestamp: new Date().toISOString(),
      dataPoints: result.rows.length,
      data: result.rows
    });

  } catch (error: any) {
    logger.error('Error fetching current values', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch current values' });
  }
});

/**
 * GET /api/endpoints/statistics
 * 
 * Get aggregated statistics for time range
 */
router.get('/statistics', async (req, res) => {
  try {
    const { timeRange = '24h' } = req.query;

    const timeRangeMap: Record<string, string> = {
      '1h': '1 hour',
      '24h': '24 hours',
      '7d': '7 days',
      '30d': '30 days'
    };
    const pgInterval = timeRangeMap[timeRange as string] || '24 hours';

    const result = await query(`
      SELECT 
        COUNT(DISTINCT device_uuid) as total_devices,
        COUNT(DISTINCT metric_name) as total_metrics,
        COUNT(*) as total_readings,
        MIN(bucket) as earliest_reading,
        MAX(bucket) as latest_reading
      FROM readings_hourly
      WHERE bucket >= NOW() - INTERVAL '${pgInterval}'
    `);

    const devicesOnline = await query(`
      SELECT COUNT(*) as count
      FROM devices
      WHERE last_connectivity_event > NOW() - INTERVAL '5 minutes'
    `);

    res.json({
      timeRange,
      ...result.rows[0],
      devices_online: devicesOnline.rows[0].count
    });

  } catch (error: any) {
    logger.error('Error fetching statistics', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

/**
 * GET /api/endpoints/metadata
 * 
 * Get all available devices, metrics, and protocols (for dynamic UI)
 */
router.get('/metadata', async (req, res) => {
  try {
    logger.info('Fetching endpoints metadata');
    
    // Get all devices with their status
    const devicesResult = await query(`
      SELECT 
        d.uuid,
        d.device_name,
        d.last_connectivity_event,
        CASE 
          WHEN d.last_connectivity_event > NOW() - INTERVAL '5 minutes' THEN 'online'
          WHEN d.last_connectivity_event > NOW() - INTERVAL '1 hour' THEN 'degraded'
          ELSE 'offline'
        END as status,
        COUNT(DISTINCT r.metric_name) as metric_count
      FROM devices d
      LEFT JOIN readings_hourly r ON r.device_uuid = d.uuid
      GROUP BY d.uuid, d.device_name, d.last_connectivity_event
      ORDER BY d.device_name
    `);

    logger.info(`Found ${devicesResult.rows.length} devices`);

    // Get all unique metrics with sample data
    const metricsResult = await query(`
      SELECT DISTINCT ON (metric_name, protocol)
        metric_name,
        protocol,
        COUNT(*) OVER (PARTITION BY metric_name) as device_count,
        last_value as sample_value
      FROM readings_hourly
      WHERE bucket >= NOW() - INTERVAL '24 hours'
      ORDER BY metric_name, protocol, bucket DESC
    `);

    logger.info(`Found ${metricsResult.rows.length} metrics`);

    // Get all protocols
    const protocolsResult = await query(`
      SELECT DISTINCT protocol, COUNT(DISTINCT device_uuid) as device_count
      FROM readings_hourly
      WHERE bucket >= NOW() - INTERVAL '24 hours'
      GROUP BY protocol
      ORDER BY protocol
    `);

    logger.info(`Found ${protocolsResult.rows.length} protocols`);

    res.json({
      devices: devicesResult.rows,
      metrics: metricsResult.rows,
      protocols: protocolsResult.rows,
      totalDevices: devicesResult.rows.length,
      totalMetrics: metricsResult.rows.length
    });

  } catch (error: any) {
    logger.error('Error fetching metadata', { error: error.message, stack: error.stack });
    res.status(500).json({ error: 'Failed to fetch metadata', details: error.message });
  }
});

export default router;
