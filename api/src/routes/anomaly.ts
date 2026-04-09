/**
 * Anomaly Detection API Routes
 *
 * Endpoints for querying anomaly scores and aggregates from edge AI
 */
import type { FastifyPluginAsync } from 'fastify';
import { readingsService } from '../services/telemetry/readings.service';
import logger from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

type DeviceParams = {
  deviceUuid: string;
};

type SummaryQuerystring = {
  edgeUuid?: string;
  deviceName?: string;
};

type AggregateQuerystring = {
  edgeUuid?: string;
  deviceName?: string;
  metric?: string;
  start?: string;
  end?: string;
  limit?: string | number;
};

type LegacyAggregateQuerystring = {
  metric?: string;
  start?: string;
  end?: string;
  limit?: string | number;
};

type TopMetricsQuerystring = {
  edgeUuid?: string;
  deviceName?: string;
  hours?: string | number;
  limit?: string | number;
};

type LegacyTopMetricsQuerystring = {
  hours?: string | number;
  limit?: string | number;
};

function parseNumericQuery(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function parseDateQuery(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }

  return parsed;
}

const plugin: FastifyPluginAsync = async (fastify) => {
  // NOTE: JWT auth is applied to each individual route below since paths are mixed
  //       (some start with /, others with /:deviceUuid) and we want to avoid
  //       intercepting unrelated routes when mounted at API_BASE

  fastify.get<{ Querystring: SummaryQuerystring }>('/summary', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { edgeUuid, deviceName } = req.query;

      const summary = await readingsService.getDeviceAnomalySummary(edgeUuid, deviceName);

      reply.send({
        success: true,
        data: summary,
        count: summary.length,
      });
    } catch (error) {
      logger.error('Failed to get device anomaly summary', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve anomaly summary',
      });
    }
  });

  fastify.get<{ Params: DeviceParams }>('/:deviceUuid/summary', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { deviceUuid } = req.params;

      const summary = await readingsService.getDeviceAnomalySummary(deviceUuid);

      if (!summary || summary.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'No anomaly data found for edge gateway',
        });
      }

      reply.send({
        success: true,
        data: summary,
      });
    } catch (error) {
      logger.error('Failed to get device anomaly summary', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve anomaly summary',
      });
    }
  });

  fastify.get<{ Querystring: AggregateQuerystring }>('/hourly', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { edgeUuid, deviceName, metric, start, end, limit } = req.query;

      const aggregates = await readingsService.getHourlyAnomalyScores(
        edgeUuid,
        deviceName,
        metric,
        parseDateQuery(start),
        parseDateQuery(end),
        parseNumericQuery(limit, 24)
      );

      reply.send({
        success: true,
        data: aggregates,
        count: aggregates.length,
      });
    } catch (error) {
      logger.error('Failed to get hourly anomaly scores', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve hourly anomaly scores',
      });
    }
  });

  fastify.get<{ Params: DeviceParams; Querystring: LegacyAggregateQuerystring }>('/:deviceUuid/hourly', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const { metric, start, end, limit } = req.query;

      const aggregates = await readingsService.getHourlyAnomalyScores(
        deviceUuid,
        undefined,
        metric,
        parseDateQuery(start),
        parseDateQuery(end),
        parseNumericQuery(limit, 24)
      );

      reply.send({
        success: true,
        data: aggregates,
        count: aggregates.length,
      });
    } catch (error) {
      logger.error('Failed to get hourly anomaly scores', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve hourly anomaly scores',
      });
    }
  });

  fastify.get<{ Querystring: AggregateQuerystring }>('/daily', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { edgeUuid, deviceName, metric, start, end, limit } = req.query;

      const aggregates = await readingsService.getDailyAnomalyScores(
        edgeUuid,
        deviceName,
        metric,
        parseDateQuery(start),
        parseDateQuery(end),
        parseNumericQuery(limit, 30)
      );

      reply.send({
        success: true,
        data: aggregates,
        count: aggregates.length,
      });
    } catch (error) {
      logger.error('Failed to get daily anomaly scores', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve daily anomaly scores',
      });
    }
  });

  fastify.get<{ Querystring: TopMetricsQuerystring }>('/top-metrics', { preHandler: [jwtAuth] }, async (req, reply) => {
    try {
      const { edgeUuid, deviceName, hours, limit } = req.query;

      const metrics = await readingsService.getTopAnomalousMetrics(
        edgeUuid,
        deviceName,
        parseNumericQuery(hours, 24),
        parseNumericQuery(limit, 10)
      );

      reply.send({
        success: true,
        data: metrics,
        count: metrics.length,
      });
    } catch (error) {
      logger.error('Failed to get top anomalous metrics', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve top anomalous metrics',
      });
    }
  });

  fastify.get<{ Params: DeviceParams; Querystring: LegacyTopMetricsQuerystring }>('/:deviceUuid/top-metrics', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const { hours, limit } = req.query;

      const metrics = await readingsService.getTopAnomalousMetrics(
        deviceUuid,
        undefined,
        parseNumericQuery(hours, 24),
        parseNumericQuery(limit, 10)
      );

      reply.send({
        success: true,
        data: metrics,
        count: metrics.length,
      });
    } catch (error) {
      logger.error('Failed to get top anomalous metrics', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve top anomalous metrics',
      });
    }
  });
};

export default plugin;