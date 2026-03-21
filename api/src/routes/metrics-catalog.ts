/**
 * Metrics Catalog Routes
 * Query materialized views for metric discovery and time-series data
 * 
 * Endpoints:
 * - GET /api/v1/metrics/agents - List all endpoint agents
 * - GET /api/v1/metrics/catalog - Get metric catalog (optionally filtered by device)
 * - GET /api/v1/metrics/latest - Get latest readings for a device
 * - GET /api/v1/metrics/timeseries - Get time-series data for a metric
 */

import express from 'express';
import { z } from 'zod';
import { query } from '../db/connection';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';

export const router = express.Router();

// Validation schemas
const protocolSchema = z.string().min(1).max(50).regex(/^[a-zA-Z0-9_\-]+$/, 'Invalid protocol format').optional();
const uuidSchema = z.string().uuid('Invalid UUID format').optional();
const deviceNameSchema = z.string().min(1).max(255).regex(/^[a-zA-Z0-9_\-\.\s]+$/, 'Invalid device name format');
const metricNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_\-\.]+$/, 'Invalid metric name format');
const timeRangeSchema = z.enum(['1m', '1h', '6h', '12h', '24h', '7d', '30d']).default('1h');
const aggregationSchema = z.enum(['auto', '1min', '1hour', '1day']).default('auto');
const viewSchema = z.enum(['catalog', 'agents', 'latest', 'all']);

/**
 * Get list of endpoint agents (from extra.deviceName)
 * GET /api/v1/metrics/agents
 * 
 * Query params:
 * - protocol: filter by protocol (optional)
 * - agentUuid: filter by agent UUID (optional)
 * 
 * Returns agents discovered from readings with their available metrics
 */
router.get('/agents', jwtAuth, async (req, res) => {
  try {
    const { protocol, agentUuid } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate inputs
    const validatedProtocol = protocolSchema.parse(protocol);
    const validatedAgentUuid = uuidSchema.parse(agentUuid);
    
    // Group by device_name to get unique agents across all agents while preserving
    // exact source references (asset_uuid, endpoint_uuid) for widget configs that need stable IDs.
    let sql = `
      WITH unnested AS (
        SELECT
          ed.device_name,
          ed.protocol,
          ed.last_seen,
          ed.agent_uuid,
          ed.agent_name,
          ed.overall_quality_percentage,
          ed.agent_uuid,
          ed.endpoint_uuid,
          ep.name AS endpoint_name,
          unnest(ed.available_metrics) as metric_name
        FROM endpoint_agents ed
        LEFT JOIN endpoints ep ON ep.uuid::text = ed.endpoint_uuid
          AND ep.agent_uuid = ed.agent_uuid
        WHERE 1=1
    `;
    
    const params: any[] = [];
    let paramIndex = 0;
    
    if (validatedProtocol) {
      params.push(validatedProtocol);
      paramIndex++;
      sql += ` AND protocol = $${paramIndex}`;
    }
    
    if (validatedAgentUuid) {
      params.push(validatedAgentUuid);
      paramIndex++;
      sql += ` AND agent_uuid = $${paramIndex}`;
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
        array_agg(DISTINCT agent_uuid::text) as agent_uuids,
        array_agg(DISTINCT agent_name ORDER BY agent_name) as agent_names,
        COALESCE(
          jsonb_agg(DISTINCT jsonb_build_object(
            'deviceUuid', agent_uuid,
            'endpointUuid', endpoint_uuid,
            'agentUuid', agent_uuid::text,
            'agentName', agent_name,
            'endpointName', endpoint_name
          )) FILTER (WHERE agent_uuid IS NOT NULL),
          '[]'::jsonb
        ) as source_refs
      FROM unnested
      GROUP BY device_name, protocol
      ORDER BY last_seen DESC
    `;
    
    const result = await query(sql, params);
    
    res.json({
      count: result.rows.length,
      agents: result.rows
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid agents parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting endpoint agents', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
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
router.get('/catalog', jwtAuth, async (req, res) => {
  try {
    const { deviceName, protocol, agentUuid, metricName } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate inputs
    const validatedDeviceName = deviceName ? deviceNameSchema.parse(deviceName) : undefined;
    const validatedProtocol = protocolSchema.parse(protocol);
    const validatedAgentUuid = uuidSchema.parse(agentUuid);
    const validatedMetricName = metricName ? metricNameSchema.parse(metricName) : undefined;
    
    let sql = `
      SELECT
        agent_uuid,
        agent_name,
        device_name,
        agent_uuid,
        endpoint_uuid,
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
    let paramIndex = 0;
    
    if (validatedDeviceName) {
      params.push(validatedDeviceName);
      paramIndex++;
      sql += ` AND device_name = $${paramIndex}`;
    }
    
    if (validatedProtocol) {
      params.push(validatedProtocol);
      paramIndex++;
      sql += ` AND protocol = $${paramIndex}`;
    }
    
    if (validatedAgentUuid) {
      params.push(validatedAgentUuid);
      paramIndex++;
      sql += ` AND agent_uuid = $${paramIndex}`;
    }
    
    if (validatedMetricName) {
      params.push(validatedMetricName);
      paramIndex++;
      sql += ` AND metric_name = $${paramIndex}`;
    }
    
    sql += ` ORDER BY device_name, metric_name`;
    
    const result = await query(sql, params);
    
    res.json({
      count: result.rows.length,
      metrics: result.rows
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid catalog parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting metric catalog', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
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
router.get('/latest', jwtAuth, async (req, res) => {
  try {
    const { deviceName, metricName, agentUuid } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate required params
    const validatedDeviceName = deviceNameSchema.parse(deviceName);
    const validatedMetricName = metricName ? metricNameSchema.parse(metricName) : undefined;
    const validatedAgentUuid = uuidSchema.parse(agentUuid);
    
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
        agent_uuid,
        endpoint_uuid,
        anomaly_score,
        anomaly_threshold,
        agent_name,
        agent_is_online
      FROM latest_readings
      WHERE device_name = $1
    `;
    
    const params: any[] = [validatedDeviceName];
    let paramIndex = 1;
    
    if (validatedMetricName) {
      params.push(validatedMetricName);
      paramIndex++;
      sql += ` AND metric_name = $${paramIndex}`;
    }
    
    if (validatedAgentUuid) {
      params.push(validatedAgentUuid);
      paramIndex++;
      sql += ` AND agent_uuid = $${paramIndex}`;
    }
    
    sql += ` ORDER BY metric_name`;
    
    const result = await query(sql, params);
    
    res.json({
      count: result.rows.length,
      readings: result.rows
    });
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid latest readings parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting latest readings', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
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
router.get('/timeseries', jwtAuth, async (req, res) => {
  try {
    const { deviceName, metricName, timeRange, agentUuid, aggregation } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate required params
    const validatedDeviceName = deviceNameSchema.parse(deviceName);
    const validatedMetricName = metricNameSchema.parse(metricName);
    const validatedTimeRange = timeRangeSchema.parse(timeRange);
    const validatedAggregation = aggregationSchema.parse(aggregation);
    const validatedAgentUuid = uuidSchema.parse(agentUuid);
    
    // Auto-select view based on time range and aggregation preference
    let viewName: string;
    let intervalMinutes: number = 0;
    
    if (validatedAggregation !== 'auto') {
      // Manual aggregation selection
      switch (validatedAggregation) {
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
            requestId
          });
      }
    } else {
      // Auto-select based on time range
      switch (validatedTimeRange) {
        case '1m':
          intervalMinutes = 5;
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
            requestId
          });
      }
    }
    
    // Build query for selected view - SAFE: intervalMinutes is number, not interpolated into SQL
    // All views now use agent_uuid for the gateway UUID (migration 013)
    const agentUuidCol = 'agent_uuid';
    // readings_hourly and readings_daily do not have quality_ratio
    const qualityCol = (viewName === 'readings_hourly' || viewName === 'readings_daily')
      ? 'NULL::float as quality_ratio'
      : 'quality_ratio';

    let sql = `
      SELECT
        bucket as time,
        agent_uuid,
        endpoint_uuid,
        avg_value,
        min_value,
        max_value,
        sample_count,
        ${qualityCol}
      FROM ${viewName}
      WHERE device_name = $1
        AND metric_name = $2
    `;
    
    const params: any[] = [validatedDeviceName, validatedMetricName];
    let paramIndex = 2;
    
    // Add time range filter - SAFE: Using parameterized make_interval() with validated number
    if (intervalMinutes > 0) {
      sql += ` AND bucket > NOW() - make_interval(mins => $${++paramIndex})`;
      params.push(intervalMinutes);
    }
    
    if (validatedAgentUuid) {
      params.push(validatedAgentUuid);
      sql += ` AND ${agentUuidCol} = $${++paramIndex}`;
    }
    
    sql += ` ORDER BY bucket ASC`;
    
    const result = await query(sql, params);
    
    // Get metric metadata from catalog
    const metadataResult = await query(
      `SELECT unit, protocol, quality_percentage 
       FROM metric_catalog 
       WHERE device_name = $1 AND metric_name = $2
       LIMIT 1`,
      [validatedDeviceName, validatedMetricName]
    );
    
    const metadata = metadataResult.rows[0] || {};
    
    res.json({
      metric: {
        deviceName: validatedDeviceName,
        metricName: validatedMetricName,
        unit: metadata.unit,
        protocol: metadata.protocol
      },
      metadata: {
        sampleCount: result.rows.length,
        startTime: result.rows[0]?.time,
        endTime: result.rows[result.rows.length - 1]?.time,
        aggregationLevel: viewName.replace('readings_', ''),
        timeRange: validatedTimeRange,
        qualityPercentage: metadata.quality_percentage
      },
      data: result.rows
    });
    
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid timeseries parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting time-series data', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

/**
 * Refresh materialized views
 * POST /api/v1/metrics/refresh
 * 
 * Query params:
 * - view: which view to refresh (catalog, agents, latest, all)
 * 
 * Requires admin access
 */
router.post('/refresh', jwtAuth, async (req, res) => {
  try {
    const { view } = req.query;
    const requestId = (req as any).id || 'unknown';
    const userId = (req as any).user?.id;
    const userRole = (req as any).user?.role;
    
    // Verify admin role
    if (userRole !== 'admin') {
      logger.warn('Unauthorized view refresh attempt', { requestId, userId, userRole });
      return res.status(403).json({ error: 'Admin authorization required', requestId });
    }
    
    // Validate view parameter
    const validatedView = viewSchema.parse(view);
    
    let sql: string;
    
    switch (validatedView) {
      case 'catalog':
        sql = 'SELECT refresh_metric_catalog()';
        break;
      case 'agents':
        sql = 'SELECT refresh_endpoint_agents()';
        break;
      case 'latest':
        sql = 'SELECT refresh_latest_readings()';
        break;
      case 'all':
        sql = 'SELECT refresh_all_catalog_views()';
        break;
      default:
        return res.status(400).json({ error: 'Invalid view parameter', requestId });
    }
    
    logger.info('Refreshing metric views', { requestId, userId, view: validatedView });
    await query(sql);
    
    res.json({
      message: `Refreshed ${validatedView} view(s)`,
      requestId
    });
    
  } catch (error: any) {
    const requestId = (req as any).id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid refresh parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error refreshing views', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});
