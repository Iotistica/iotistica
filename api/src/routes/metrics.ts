/**
 * Metrics Routes
 * Thin controllers for metric agents, latest readings, time-series, and view refresh.
 *
 * Endpoints:
 * - GET  /api/v1/metrics/catalog    - Metric catalog with statistics
 * - GET  /api/v1/metrics/agents     - List discovered endpoint devices
 * - GET  /api/v1/metrics/latest     - Latest readings for a device
 * - GET  /api/v1/metrics/timeseries - Time-bucketed series for a metric
 * - POST /api/v1/metrics/refresh    - Refresh a materialized view (admin only)
 */

import express from 'express';
import { z } from 'zod';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';
import {
  getAgents,
  getCatalog,
  getLatestReadings,
  getTimeseries,
  refreshViews,
} from '../services/metrics.service';
import type { TimeRange, Aggregation, RefreshView } from '../services/metrics.service';
import { redisSensorQueue } from '../services/device-queue/redis-queue';

export const router = express.Router();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const protocolSchema = z.string().min(1).max(50).regex(/^[a-zA-Z0-9_\-]+$/, 'Invalid protocol format').optional();
const uuidSchema = z.string().uuid('Invalid UUID format').optional();
const requiredUuidSchema = z.string().uuid('Invalid UUID format');
const metricNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_\-\.]+$/, 'Invalid metric name format');
const timeRangeSchema = z.enum(['1m', '1h', '6h', '12h', '24h', '7d', '30d']).default('1h');
const aggregationSchema = z.enum(['auto', '1min', '1hour', '1day']).default('auto');
const viewSchema = z.enum(['catalog', 'agents', 'latest', 'all']);

// ---------------------------------------------------------------------------
// GET /catalog  — metric catalog with statistics
// ---------------------------------------------------------------------------
router.get('/catalog', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  try {
    const validatedDeviceUuid = uuidSchema.parse(req.query.deviceUuid);
    const validatedProtocol   = protocolSchema.parse(req.query.protocol);
    const validatedAgentUuid  = uuidSchema.parse(req.query.agentUuid);
    const validatedMetricName = req.query.metricName ? metricNameSchema.parse(req.query.metricName) : undefined;

    const metrics = await getCatalog({
      deviceUuid: validatedDeviceUuid,
      protocol:   validatedProtocol,
      agentUuid:  validatedAgentUuid,
      metricName: validatedMetricName,
    });
    res.json({ count: metrics.length, metrics });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid catalog parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting metric catalog', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /agents  — list all endpoint devices
// ---------------------------------------------------------------------------
router.get('/agents', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  try {
    const validatedProtocol  = protocolSchema.parse(req.query.protocol);
    const validatedAgentUuid = uuidSchema.parse(req.query.agentUuid);

    const agents = await getAgents({ protocol: validatedProtocol, agentUuid: validatedAgentUuid });
    res.json({ count: agents.length, agents });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid agents parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting endpoint agents', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /latest  — current readings for a device
// ---------------------------------------------------------------------------
router.get('/latest', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  try {
    const validatedDeviceUuid = requiredUuidSchema.parse(req.query.deviceUuid);
    const validatedMetricName = req.query.metricName ? metricNameSchema.parse(req.query.metricName) : undefined;
    const validatedAgentUuid  = uuidSchema.parse(req.query.agentUuid);

    const readings = await getLatestReadings({
      deviceUuid: validatedDeviceUuid,
      metricName: validatedMetricName,
      agentUuid:  validatedAgentUuid,
    });
    res.json({ count: readings.length, readings });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid latest readings parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting latest readings', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /ingestion-health  — live pipeline health for chart freshness awareness
// ---------------------------------------------------------------------------
router.get('/ingestion-health', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  try {
    const health = await redisSensorQueue.getIngestionHealth();
    res.json(health);
  } catch (error: any) {
    logger.error('Error getting ingestion health', { requestId, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /timeseries  — time-bucketed aggregates for a metric
// ---------------------------------------------------------------------------
router.get('/timeseries', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  try {
    const validatedDeviceUuid  = requiredUuidSchema.parse(req.query.deviceUuid);
    const validatedMetricName  = metricNameSchema.parse(req.query.metricName);
    const validatedTimeRange   = timeRangeSchema.parse(req.query.timeRange) as TimeRange;
    const validatedAggregation = aggregationSchema.parse(req.query.aggregation) as Aggregation;
    const validatedAgentUuid   = uuidSchema.parse(req.query.agentUuid);

    const result = await getTimeseries({
      deviceUuid:  validatedDeviceUuid,
      metricName:  validatedMetricName,
      timeRange:   validatedTimeRange,
      aggregation: validatedAggregation,
      agentUuid:   validatedAgentUuid,
    });
    res.json(result);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid timeseries parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting time-series data', { requestId, userId: (req as any).user?.id, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// POST /refresh  — refresh a materialized view (admin only)
// ---------------------------------------------------------------------------
router.post('/refresh', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  const userId    = (req as any).user?.id;
  const userRole  = (req as any).user?.role;
  try {
    if (userRole !== 'admin') {
      logger.warn('Unauthorized view refresh attempt', { requestId, userId, userRole });
      return res.status(403).json({ error: 'Admin authorization required', requestId });
    }

    const validatedView = viewSchema.parse(req.query.view) as RefreshView;
    logger.info('Accepted metric view refresh request', { requestId, userId, view: validatedView });

    const result = await refreshViews(validatedView);
    res.status(202).json({
      message: result.alreadyInProgress
        ? `Refresh for ${validatedView} view(s) is already in progress or cooling down`
        : `Accepted refresh for ${validatedView} view(s)`,
      requestId,
      status: result.alreadyInProgress ? 'already_in_progress' : 'accepted',
      view: validatedView,
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid refresh parameters', { requestId, errors: error.errors });
      return res.status(400).json({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error refreshing views', { requestId, userId, error: error.message });
    res.status(500).json({ error: 'Internal server error', requestId });
  }
});
