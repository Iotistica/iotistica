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
const requiredUuidSchema = z.string().uuid('Invalid UUID format');
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
    
    // Query agent_devices (live table) with a metric_catalog rollup and
    // a fallback rollup directly from readings for resilience.
    let sql = `
      SELECT
        ad.uuid::text                                       AS device_uuid,
        ad.name                                             AS device_name,
        ad.protocol,
        COALESCE(mc_rollup.last_seen, live_rollup.last_seen, ad.last_seen_at)
                                                            AS last_seen,
        COALESCE(mc_rollup.metric_count, live_rollup.metric_count, 0)
                                                            AS metric_count,
        COALESCE(mc_rollup.available_metrics, live_rollup.available_metrics, ARRAY[]::text[])
                                                            AS available_metrics,
        COALESCE(mc_rollup.overall_quality_percentage, live_rollup.overall_quality_percentage, 0)
                                                            AS overall_quality_percentage,
        1                                                   AS agent_count,
        ARRAY[ad.agent_uuid::text]                          AS agent_uuids,
        ARRAY[a.device_name]                                AS agent_names,
        COALESCE(
          (SELECT jsonb_agg(src)
           FROM (
             SELECT DISTINCT jsonb_build_object(
               'deviceUuid',   ad2.uuid::text,
               'endpointUuid', ad2.endpoint_uuid::text,
               'agentUuid',    ad2.agent_uuid::text,
               'agentName',    a2.device_name,
               'endpointName', ep2.name
             ) AS src
             FROM agent_devices ad2
             JOIN  agents    a2  ON a2.uuid  = ad2.agent_uuid
             LEFT JOIN endpoints ep2 ON ep2.uuid = ad2.endpoint_uuid
             WHERE ad2.uuid     = ad.uuid
               AND ad2.protocol = ad.protocol
               AND ad2.enabled  = true
           ) AS srcs),
          '[]'::jsonb
        )                                                   AS source_refs
      FROM agent_devices ad
      JOIN  agents a  ON a.uuid  = ad.agent_uuid
      LEFT JOIN LATERAL (
        SELECT
          MAX(mc.last_seen)                                       AS last_seen,
          COUNT(DISTINCT mc.metric_name)::int                     AS metric_count,
          array_agg(DISTINCT mc.metric_name ORDER BY mc.metric_name)
                                                                 AS available_metrics,
          AVG(mc.quality_percentage)                              AS overall_quality_percentage
        FROM metric_catalog mc
        WHERE mc.device_uuid = ad.uuid
          AND mc.agent_uuid  = ad.agent_uuid
          AND mc.protocol    = ad.protocol
      ) mc_rollup ON true
      LEFT JOIN LATERAL (
        SELECT
          MAX(r.time)                                              AS last_seen,
          COUNT(DISTINCT r.metric_name)::int                       AS metric_count,
          array_agg(DISTINCT r.metric_name ORDER BY r.metric_name)
                                                                   AS available_metrics,
          (SUM(CASE WHEN r.quality = 'good' THEN 1 ELSE 0 END)::float / NULLIF(COUNT(*), 0) * 100)
                                                                   AS overall_quality_percentage
        FROM readings r
        WHERE r.agent_uuid = ad.agent_uuid
          AND r.protocol   = ad.protocol
          AND COALESCE(NULLIF(r.extra->>'device_uuid', ''), NULLIF(r.extra->>'deviceUuid', '')) = ad.uuid::text
          AND r.time > NOW() - INTERVAL '7 days'
      ) live_rollup ON true
      WHERE ad.enabled = true
    `;

    const params: any[] = [];
    let paramIndex = 0;

    if (validatedProtocol) {
      params.push(validatedProtocol);
      paramIndex++;
      sql += ` AND ad.protocol = $${paramIndex}`;
    }

    if (validatedAgentUuid) {
      params.push(validatedAgentUuid);
      paramIndex++;
      sql += ` AND ad.agent_uuid = $${paramIndex}`;
    }

    sql += ` ORDER BY last_seen DESC NULLS LAST`;
    
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
 * - deviceUuid: filter by device UUID
 * - protocol: filter by protocol
 * - agentUuid: filter by agent UUID
 * - metricName: filter by metric name
 * 
 * Returns available metrics with statistics
 */
router.get('/catalog', jwtAuth, async (req, res) => {
  try {
    const { deviceUuid, protocol, agentUuid, metricName } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate inputs
    const validatedDeviceUuid = uuidSchema.parse(deviceUuid);
    const validatedProtocol = protocolSchema.parse(protocol);
    const validatedAgentUuid = uuidSchema.parse(agentUuid);
    const validatedMetricName = metricName ? metricNameSchema.parse(metricName) : undefined;
    
    let sql = `
      SELECT
        agent_uuid,
        agent_name,
        device_uuid,
        device_name,
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
    
    if (validatedDeviceUuid) {
      params.push(validatedDeviceUuid);
      paramIndex++;
      sql += ` AND device_uuid = $${paramIndex}`;
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
    
    sql += ` ORDER BY device_uuid, metric_name`;
    
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
 * - deviceUuid: device UUID (required)
 * - metricName: specific metric (optional, returns all if omitted)
 * - agentUuid: agent UUID (optional)
 * 
 * Returns current values from latest_readings view
 */
router.get('/latest', jwtAuth, async (req, res) => {
  try {
    const { deviceUuid, metricName, agentUuid } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate required params
    const validatedDeviceUuid = requiredUuidSchema.parse(deviceUuid);
    const validatedMetricName = metricName ? metricNameSchema.parse(metricName) : undefined;
    const validatedAgentUuid = uuidSchema.parse(agentUuid);
    
    let sql = `
      SELECT 
        agent_uuid,
        device_uuid,
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
      WHERE device_uuid = $1
    `;
    
    const params: any[] = [validatedDeviceUuid];
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
 * - deviceUuid: device UUID
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
    const { deviceUuid, metricName, timeRange, agentUuid, aggregation } = req.query;
    const requestId = (req as any).id || 'unknown';
    
    // Validate required params
    const validatedDeviceUuid = requiredUuidSchema.parse(deviceUuid);
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
        device_uuid,
        endpoint_uuid,
        avg_value,
        min_value,
        max_value,
        sample_count,
        ${qualityCol}
      FROM ${viewName}
      WHERE device_uuid = $1
        AND metric_name = $2
    `;
    
    const params: any[] = [validatedDeviceUuid, validatedMetricName];
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
       WHERE device_uuid = $1 AND metric_name = $2
       LIMIT 1`,
      [validatedDeviceUuid, validatedMetricName]
    );
    
    const metadata = metadataResult.rows[0] || {};
    
    res.json({
      metric: {
        deviceUuid: validatedDeviceUuid,
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
        sql = 'SELECT refresh_endpoint_devices()';
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
