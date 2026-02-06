/**
 * Metrics Catalog Routes
 * Query materialized views for metric discovery and time-series data
 * 
 * Endpoints:
 * - GET /api/v1/metrics/devices - List all endpoint devices
 * - GET /api/v1/metrics/catalog - Get metric catalog (optionally filtered by device)
 * - GET /api/v1/metrics/latest - Get latest readings for a device
 * - GET /api/v1/metrics/timeseries - Get time-series data for a metric
 */

import express from 'express';
import { query } from '../db/connection';
import logger from '../utils/logger';

export const router = express.Router();

/**
 * Get list of endpoint devices (from extra.deviceName)
 * GET /api/v1/metrics/devices
 * 
 * Query params:
 * - protocol: filter by protocol (optional)
 * - agentUuid: filter by agent UUID (optional)
 * 
 * Returns devices discovered from readings with their available metrics
 */
router.get('/devices', async (req, res) => {
  try {
    const { protocol, agentUuid } = req.query;
    
    // Group by device_name to get unique devices across all agents
    let sql = `
      WITH unnested AS (
        SELECT 
          device_name,
          protocol,
          last_seen,
          agent_uuid,
          overall_quality_percentage,
          unnest(available_metrics) as metric_name
        FROM endpoint_devices
        WHERE 1=1
    `;
    
    const params: any[] = [];
    
    if (protocol) {
      params.push(protocol);
      sql += ` AND protocol = $${params.length}`;
    }
    
    if (agentUuid) {
      params.push(agentUuid);
      sql += ` AND agent_uuid = $${params.length}`;
    }
    
    sql += `
      )
      SELECT 
        device_name,
        protocol,
        MAX(last_seen) as last_seen,
        COUNT(DISTINCT metric_name) as metric_count,
        array_agg(DISTINCT metric_name ORDER BY metric_name) as available_metrics,
        AVG(overall_quality_percentage) as overall_quality_percentage,
        COUNT(DISTINCT agent_uuid) as agent_count,
        array_agg(DISTINCT agent_uuid::text) as agent_uuids
      FROM unnested
      GROUP BY device_name, protocol
      ORDER BY last_seen DESC
    `;
    
    const result = await query(sql, params);
    
    res.json({
      count: result.rows.length,
      devices: result.rows
    });
  } catch (error: any) {
    logger.error('Error getting endpoint devices:', error);
    res.status(500).json({
      error: 'Failed to get endpoint devices',
      message: error.message
    });
  }
});

/**
 * Get metric catalog
 * GET /api/v1/metrics/catalog
 * 
 * Query params:
 * - deviceName: filter by device name (from extra.deviceName)
 * - protocol: filter by protocol
 * - agentUuid: filter by agent UUID
 * - metricName: filter by metric name
 * 
 * Returns available metrics with statistics
 */
router.get('/catalog', async (req, res) => {
  try {
    const { deviceName, protocol, agentUuid, metricName } = req.query;
    
    let sql = `
      SELECT 
        agent_uuid,
        agent_name,
        device_name,
        protocol,
        metric_name,
        unit,
        sample_count,
        first_seen,
        last_seen,
        avg_value,
        min_value,
        max_value,
        stddev_value,
        quality_percentage,
        avg_anomaly_score,
        max_anomaly_score,
        anomaly_count
      FROM metric_catalog
      WHERE 1=1
    `;
    
    const params: any[] = [];
    
    if (deviceName) {
      params.push(deviceName);
      sql += ` AND device_name = $${params.length}`;
    }
    
    if (protocol) {
      params.push(protocol);
      sql += ` AND protocol = $${params.length}`;
    }
    
    if (agentUuid) {
      params.push(agentUuid);
      sql += ` AND agent_uuid = $${params.length}`;
    }
    
    if (metricName) {
      params.push(metricName);
      sql += ` AND metric_name = $${params.length}`;
    }
    
    sql += ` ORDER BY device_name, metric_name`;
    
    const result = await query(sql, params);
    
    res.json({
      count: result.rows.length,
      metrics: result.rows
    });
  } catch (error: any) {
    logger.error('Error getting metric catalog:', error);
    res.status(500).json({
      error: 'Failed to get metric catalog',
      message: error.message
    });
  }
});

/**
 * Get latest readings for a device
 * GET /api/v1/metrics/latest
 * 
 * Query params:
 * - deviceName: device name (required)
 * - metricName: specific metric (optional, returns all if omitted)
 * - agentUuid: agent UUID (optional)
 * 
 * Returns current values from latest_readings view
 */
router.get('/latest', async (req, res) => {
  try {
    const { deviceName, metricName, agentUuid } = req.query;
    
    if (!deviceName) {
      return res.status(400).json({
        error: 'deviceName is required'
      });
    }
    
    let sql = `
      SELECT 
        agent_uuid,
        device_name,
        metric_name,
        time,
        value,
        quality,
        unit,
        protocol,
        ingested_at,
        anomaly_score,
        anomaly_threshold,
        agent_name,
        agent_is_online
      FROM latest_readings
      WHERE device_name = $1
    `;
    
    const params: any[] = [deviceName];
    
    if (metricName) {
      params.push(metricName);
      sql += ` AND metric_name = $${params.length}`;
    }
    
    if (agentUuid) {
      params.push(agentUuid);
      sql += ` AND agent_uuid = $${params.length}`;
    }
    
    sql += ` ORDER BY metric_name`;
    
    const result = await query(sql, params);
    
    res.json({
      count: result.rows.length,
      readings: result.rows
    });
  } catch (error: any) {
    logger.error('Error getting latest readings:', error);
    res.status(500).json({
      error: 'Failed to get latest readings',
      message: error.message
    });
  }
});

/**
 * Get time-series data for a metric
 * GET /api/v1/metrics/timeseries
 * 
 * Query params (required):
 * - deviceName: device name (from extra.deviceName)
 * - metricName: metric name
 * 
 * Query params (optional):
 * - timeRange: 1h, 6h, 12h, 24h, 7d, 30d (default: 1h)
 * - agentUuid: agent UUID filter
 * - aggregation: auto (default), 1min, 1hour, 1day
 * 
 * Returns time-bucketed aggregates from appropriate view
 */
router.get('/timeseries', async (req, res) => {
  try {
    const { deviceName, metricName, timeRange, agentUuid, aggregation } = req.query;
    
    // Validate required params
    if (!deviceName || !metricName) {
      return res.status(400).json({
        error: 'deviceName and metricName are required'
      });
    }
    
    // Parse time range
    const range = (timeRange as string) || '1h';
    let intervalMinutes: number;
    let viewName: string;
    
    // Auto-select view based on time range and aggregation preference
    const aggLevel = aggregation as string || 'auto';
    
    if (aggLevel !== 'auto') {
      // Manual aggregation selection
      switch (aggLevel) {
        case '1min':
          viewName = 'readings_1m';
          break;
        case '1hour':
          viewName = 'readings_1h';
          break;
        case '1day':
          viewName = 'readings_daily';
          break;
        default:
          return res.status(400).json({
            error: 'Invalid aggregation level',
            message: 'Must be: auto, 1min, 1hour, or 1day'
          });
      }
    } else {
      // Auto-select based on time range
      switch (range) {
        case '1m':
          intervalMinutes = 5;  // Show last 5 minutes of 1-minute buckets
          viewName = 'readings_1m';
          break;
        case '1h':
          intervalMinutes = 60;
          viewName = 'readings_1m';
          break;
        case '6h':
          intervalMinutes = 360;
          viewName = 'readings_1m';
          break;
        case '12h':
          intervalMinutes = 720;
          viewName = 'readings_1h';
          break;
        case '24h':
          intervalMinutes = 1440;
          viewName = 'readings_1h';
          break;
        case '7d':
          intervalMinutes = 7 * 1440;
          viewName = 'readings_hourly';
          break;
        case '30d':
          intervalMinutes = 30 * 1440;
          viewName = 'readings_daily';
          break;
        default:
          return res.status(400).json({
            error: 'Invalid time range',
            message: 'Must be: 1m, 1h, 6h, 12h, 24h, 7d, or 30d'
          });
      }
    }
    
    // Build query for selected view
    let sql = `
      SELECT 
        bucket as time,
        avg_value,
        min_value,
        max_value,
        sample_count,
        quality_ratio
      FROM ${viewName}
      WHERE device_name = $1
        AND metric_name = $2
    `;
    
    const params: any[] = [deviceName, metricName];
    
    // Add time range filter
    if (intervalMinutes) {
      sql += ` AND bucket > NOW() - INTERVAL '${intervalMinutes} minutes'`;
    }
    
    if (agentUuid) {
      params.push(agentUuid);
      sql += ` AND agent_uuid = $${params.length}`;
    }
    
    sql += ` ORDER BY bucket ASC`;
    
    const result = await query(sql, params);
    
    // Get metric metadata from catalog
    const metadataResult = await query(
      `SELECT unit, protocol, quality_percentage 
       FROM metric_catalog 
       WHERE device_name = $1 AND metric_name = $2 
       LIMIT 1`,
      [deviceName, metricName]
    );
    
    const metadata = metadataResult.rows[0] || {};
    
    res.json({
      metric: {
        deviceName,
        metricName,
        unit: metadata.unit,
        protocol: metadata.protocol
      },
      metadata: {
        sampleCount: result.rows.length,
        startTime: result.rows[0]?.time,
        endTime: result.rows[result.rows.length - 1]?.time,
        aggregationLevel: viewName.replace('readings_', ''),
        timeRange: range,
        qualityPercentage: metadata.quality_percentage
      },
      data: result.rows
    });
    
  } catch (error: any) {
    logger.error('Error getting time-series data:', error);
    res.status(500).json({
      error: 'Failed to get time-series data',
      message: error.message
    });
  }
});

/**
 * Refresh materialized views
 * POST /api/v1/metrics/refresh
 * 
 * Query params:
 * - view: which view to refresh (catalog, devices, latest, all)
 * 
 * Requires admin access (add auth middleware as needed)
 */
router.post('/refresh', async (req, res) => {
  try {
    const { view } = req.query;
    
    let sql: string;
    
    switch (view) {
      case 'catalog':
        sql = 'SELECT refresh_metric_catalog()';
        break;
      case 'devices':
        sql = 'SELECT refresh_endpoint_devices()';
        break;
      case 'latest':
        sql = 'SELECT refresh_latest_readings()';
        break;
      case 'all':
        sql = 'SELECT refresh_all_catalog_views()';
        break;
      default:
        return res.status(400).json({
          error: 'Invalid view parameter',
          message: 'Must be: catalog, devices, latest, or all'
        });
    }
    
    await query(sql);
    
    res.json({
      success: true,
      message: `Refreshed ${view} view(s)`
    });
    
  } catch (error: any) {
    logger.error('Error refreshing views:', error);
    res.status(500).json({
      error: 'Failed to refresh views',
      message: error.message
    });
  }
});
