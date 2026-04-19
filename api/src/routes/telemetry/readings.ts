/**
 * Readings API Routes
 * 
 * Endpoints for querying time-series sensor data from readings hypertable.
 */

import { z } from 'zod';

import { readingsService } from '../../services/telemetry/reader';
import { jwtAuth } from '../../middleware/jwt-auth';
import logger from '../../utils/logger';
import type { FastifyPluginAsync } from 'fastify'

interface AgentUuidParams {
  agent_uuid: string;
}

interface AgentMetricParams extends AgentUuidParams {
  metric: string;
}

interface LatestReadingsQuerystring {
  metrics?: string;
}

interface TimeSeriesQuerystring {
  metric?: string;
  protocol?: string;
  start?: string;
  end?: string;
  limit?: string;
}

interface AggregateQuerystring {
  start?: string;
  end?: string;
}

interface InsertReadingBody {
  agent_uuid?: string;
  metric_name?: string;
  value?: number;
  unit?: string;
  protocol?: string;
  quality?: 'good' | 'fair' | 'poor';
  extra?: Record<string, unknown> | null;
}

const plugin: FastifyPluginAsync = async (fastify) => {

// Validation schemas
const uuidSchema = z.string().uuid('Invalid device UUID format');
const metricNameSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_\-]+$/, 'Invalid metric name format');
const limitSchema = z.number().int().min(1).max(10000).default(1000);

/**
 * Get latest readings for a device
 * GET /api/readings/:agent_uuid/latest
 *
 * Query params:
 * - metrics: Comma-separated list of metric names (optional)
 */
fastify.get<{ Params: AgentUuidParams; Querystring: LatestReadingsQuerystring }>('/:agent_uuid/latest', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { agent_uuid } = req.params;
    const { metrics } = req.query;
    const requestId = req.id || 'unknown';
    const userId = req.user?.id;

    // Validate agent_uuid
    const validatedUuid = uuidSchema.parse(agent_uuid);

    const metric_names = metrics ? (metrics as string).split(',').map(m => m.trim()) : undefined;

    const readings = await readingsService.getLatest(validatedUuid, metric_names);

    return reply.send({
      agent_uuid: validatedUuid,
      count: readings.length,
      readings
    });
  } catch (error: unknown) {
    const requestId = req.id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid agent UUID format', requestId });
    }
    logger.error('Error getting latest readings', { requestId, userId: req.user?.id, error: error instanceof Error ? error.message : 'Unknown error' });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

/**
 * Get time-series data
 * GET /api/readings/:agent_uuid/timeseries
 *
 * Query params:
 * - metric: Metric name (optional)
 * - protocol: Protocol filter (optional)
 * - start: ISO 8601 start time (optional)
 * - end: ISO 8601 end time (optional)
 * - limit: Max results (default: 1000)
 */
fastify.get<{ Params: AgentUuidParams; Querystring: TimeSeriesQuerystring }>('/:agent_uuid/timeseries', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { agent_uuid } = req.params;
    const { metric, protocol, start, end, limit } = req.query;
    const requestId = req.id || 'unknown';

    // Validate agent_uuid
    const validatedUuid = uuidSchema.parse(agent_uuid);

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
        return reply.status(400).send({ error: 'Invalid start time format', requestId });
      }
    }
    if (end) {
      endTime = new Date(end as string);
      if (isNaN(endTime.getTime())) {
        return reply.status(400).send({ error: 'Invalid end time format', requestId });
      }
    }

    const readings = await readingsService.getTimeSeries({
      agent_uuid: validatedUuid,
      metric_name: metric as string,
      protocol: protocol as string,
      start_time: startTime,
      end_time: endTime,
      limit: validatedLimit
    });

    return reply.send({
      agent_uuid: validatedUuid,
      count: readings.length,
      readings
    });
  } catch (error: unknown) {
    const requestId = req.id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting timeseries', { requestId, userId: req.user?.id, error: error instanceof Error ? error.message : 'Unknown error' });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

/**
 * Get hourly aggregates (fast - uses continuous aggregate)
 * GET /api/readings/:agent_uuid/:metric/hourly
 *
 * Query params:
 * - start: ISO 8601 start time (required)
 * - end: ISO 8601 end time (required)
 */
fastify.get<{ Params: AgentMetricParams; Querystring: AggregateQuerystring }>('/:agent_uuid/:metric/hourly', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { agent_uuid, metric } = req.params;
    const { start, end } = req.query;
    const requestId = req.id || 'unknown';

    if (!start || !end) {
      return reply.status(400).send({ error: 'start and end times are required', requestId });
    }

    // Validate inputs
    const validatedUuid = uuidSchema.parse(agent_uuid);
    const validatedMetric = metricNameSchema.parse(metric);

    // Validate dates
    const startTime = new Date(start as string);
    const endTime = new Date(end as string);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return reply.status(400).send({ error: 'Invalid date format', requestId });
    }

    const aggregates = await readingsService.getHourlyAggregates(
      validatedUuid,
      validatedMetric,
      startTime,
      endTime
    );

    return reply.send({
      agent_uuid: validatedUuid,
      metric_name: validatedMetric,
      interval: 'hourly',
      count: aggregates.length,
      aggregates
    });
  } catch (error: unknown) {
    const requestId = req.id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting hourly aggregates', { requestId, userId: req.user?.id, error: error instanceof Error ? error.message : 'Unknown error' });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

/**
 * Get daily aggregates (fast - uses continuous aggregate)
 * GET /api/readings/:agent_uuid/:metric/daily
 *
 * Query params:
 * - start: ISO 8601 start time (required)
 * - end: ISO 8601 end time (required)
 */
fastify.get<{ Params: AgentMetricParams; Querystring: AggregateQuerystring }>('/:agent_uuid/:metric/daily', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { agent_uuid, metric } = req.params;
    const { start, end } = req.query;
    const requestId = req.id || 'unknown';

    if (!start || !end) {
      return reply.status(400).send({ error: 'start and end times are required', requestId });
    }

    // Validate inputs
    const validatedUuid = uuidSchema.parse(agent_uuid);
    const validatedMetric = metricNameSchema.parse(metric);

    // Validate dates
    const startTime = new Date(start as string);
    const endTime = new Date(end as string);
    if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
      return reply.status(400).send({ error: 'Invalid date format', requestId });
    }

    const aggregates = await readingsService.getDailyAggregates(
      validatedUuid,
      validatedMetric,
      startTime,
      endTime
    );

    return reply.send({
      agent_uuid: validatedUuid,
      metric_name: validatedMetric,
      interval: 'daily',
      count: aggregates.length,
      aggregates
    });
  } catch (error: unknown) {
    const requestId = req.id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid parameters', requestId });
    }
    logger.error('Error getting daily aggregates', { requestId, userId: req.user?.id, error: error instanceof Error ? error.message : 'Unknown error' });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});

/**
 * Get metrics summary
 * GET /api/readings/:agent_uuid/summary
 */
fastify.get<{ Params: AgentUuidParams }>('/:agent_uuid/summary', { preHandler: [jwtAuth] }, async (req, reply) => {
  try {
    const { agent_uuid } = req.params;
    const requestId = req.id || 'unknown';

    // Validate agent_uuid
    const validatedUuid = uuidSchema.parse(agent_uuid);

    const summary = await readingsService.getMetricsSummary(validatedUuid);

    return reply.send({
      agent_uuid: validatedUuid,
      total_metrics: summary.length,
      metrics: summary
    });
  } catch (error: unknown) {
    const requestId = req.id || 'unknown';
    if (error instanceof z.ZodError) {
      logger.warn('Invalid request parameters', { requestId, errors: error.errors });
      return reply.status(400).send({ error: 'Invalid agent UUID format', requestId });
    }
    logger.error('Error getting metrics summary', { requestId, userId: req.user?.id, error: error instanceof Error ? error.message : 'Unknown error' });
    return reply.status(500).send({ error: 'Internal server error', requestId });
  }
});


};

export default plugin;