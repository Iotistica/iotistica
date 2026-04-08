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

import { z } from 'zod';
import { jwtAuth } from '../middleware/jwt-auth';
import logger from '../utils/logger';
import {

  getAgents,
  getCatalog,
  getLatestReadings,
  getTimeseries,
  refreshViews,
} from '../services/agent/metrics.service';
import type { TimeRange, Aggregation, RefreshView } from '../services/agent/metrics.service';
import { redisDeviceQueue } from '../services/ingestion/redis-device-queue';
import type { FastifyPluginAsync } from 'fastify'

const plugin: FastifyPluginAsync = async (fastify) => {

interface CatalogQuerystring {
  deviceUuid?: string;
  protocol?: string;
  agentUuid?: string;
  metricName?: string;
}

interface AgentsQuerystring {
  protocol?: string;
  agentUuid?: string;
}

interface LatestQuerystring {
  deviceUuid?: string;
  metricName?: string;
  agentUuid?: string;
}

interface TimeseriesQuerystring {
  deviceUuid?: string;
  metricName?: string;
  timeRange?: string;
  aggregation?: string;
  agentUuid?: string;
  startTime?: string;
  endTime?: string;
}

interface RefreshQuerystring {
  view?: string;
}

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
const optionalDateTimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), 'Invalid datetime').optional();

// ---------------------------------------------------------------------------
// GET /catalog  — metric catalog with statistics
// ---------------------------------------------------------------------------
fastify.get<{ Querystring: CatalogQuerystring }>('/catalog', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
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
    return reply.send({ count: metrics.length, metrics });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid catalog parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting metric catalog', {
      requestId,
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /agents  — list all endpoint devices
// ---------------------------------------------------------------------------
fastify.get<{ Querystring: AgentsQuerystring }>('/agents', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  try {
    const validatedProtocol  = protocolSchema.parse(req.query.protocol);
    const validatedAgentUuid = uuidSchema.parse(req.query.agentUuid);

    const agents = await getAgents({ protocol: validatedProtocol, agentUuid: validatedAgentUuid });
    return reply.send({ count: agents.length, agents });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid agents parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting endpoint agents', {
      requestId,
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /latest  — current readings for a device
// ---------------------------------------------------------------------------
fastify.get<{ Querystring: LatestQuerystring }>('/latest', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  try {
    const validatedDeviceUuid = requiredUuidSchema.parse(req.query.deviceUuid);
    const validatedMetricName = req.query.metricName ? metricNameSchema.parse(req.query.metricName) : undefined;
    const validatedAgentUuid  = uuidSchema.parse(req.query.agentUuid);

    const readings = await getLatestReadings({
      deviceUuid: validatedDeviceUuid,
      metricName: validatedMetricName,
      agentUuid:  validatedAgentUuid,
    });
    return reply.send({ count: readings.length, readings });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid latest readings parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting latest readings', {
      requestId,
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /ingestion-health  — live pipeline health for chart freshness awareness
// ---------------------------------------------------------------------------
fastify.get('/ingestion-health', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  try {
    const health = await redisDeviceQueue.getIngestionHealth();
    return reply.send(health);
  } catch (error: unknown) {
    logger.error('Error getting ingestion health', {
      requestId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// GET /timeseries  — time-bucketed aggregates for a metric
// ---------------------------------------------------------------------------
fastify.get<{ Querystring: TimeseriesQuerystring }>('/timeseries', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  try {
    const validatedDeviceUuid  = requiredUuidSchema.parse(req.query.deviceUuid);
    const validatedMetricName  = metricNameSchema.parse(req.query.metricName);
    const validatedTimeRange   = timeRangeSchema.parse(req.query.timeRange) as TimeRange;
    const validatedAggregation = aggregationSchema.parse(req.query.aggregation) as Aggregation;
    const validatedAgentUuid   = uuidSchema.parse(req.query.agentUuid);
    const validatedStartTime   = optionalDateTimeSchema.parse(req.query.startTime);
    const validatedEndTime     = optionalDateTimeSchema.parse(req.query.endTime);

    if (validatedStartTime && validatedEndTime && new Date(validatedEndTime) <= new Date(validatedStartTime)) {
      return reply.status(400).send({ error: 'endTime must be greater than startTime', requestId });
    }

    const result = await getTimeseries({
      deviceUuid:  validatedDeviceUuid,
      metricName:  validatedMetricName,
      timeRange:   validatedTimeRange,
      aggregation: validatedAggregation,
      agentUuid:   validatedAgentUuid,
      startTime:   validatedStartTime ? new Date(validatedStartTime) : undefined,
      endTime:     validatedEndTime ? new Date(validatedEndTime) : undefined,
    });
    return reply.send(result);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid timeseries parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting time-series data', {
      requestId,
      userId: req.user?.id,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

// ---------------------------------------------------------------------------
// POST /refresh  — refresh a materialized view (admin only)
// ---------------------------------------------------------------------------
fastify.post<{ Querystring: RefreshQuerystring }>('/refresh', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  const userId    = req.user?.id;
  const userRole  = req.user?.role;
  try {
    if (userRole !== 'admin') {
      logger.warn('Unauthorized view refresh attempt', { requestId, userId, userRole });
      return reply.status(403).send({ error: 'Admin authorization required', requestId });
    }

    const validatedView = viewSchema.parse(req.query.view) as RefreshView;
    logger.info('Accepted metric view refresh request', { requestId, userId, view: validatedView });

    const result = await refreshViews(validatedView);
    return reply.status(202).send({
      message: result.alreadyInProgress
        ? `Refresh for ${validatedView} view(s) is already in progress or cooling down`
        : `Accepted refresh for ${validatedView} view(s)`,
      requestId,
      status: result.alreadyInProgress ? 'already_in_progress' : 'accepted',
      view: validatedView,
    });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      logger.warn('Invalid refresh parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error refreshing views', {
      requestId,
      userId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});
};

export default plugin;
