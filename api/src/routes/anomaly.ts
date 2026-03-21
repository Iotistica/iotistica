/**
 * Anomaly Detection API Routes
 * 
 * Endpoints for querying anomaly scores and aggregates from edge AI
 */

import { Router } from 'express';
import { readingsService } from '../services/readings.service';
import logger from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

const router = Router();

// NOTE: JWT auth is applied to each individual route below since paths are mixed
//       (some start with /, others with /:deviceUuid) and we want to avoid
//       intercepting unrelated routes when mounted at API_BASE

/**
 * GET /api/anomaly/summary
 * Get anomaly summary for agents
 * 
 * Query params:
 * - edgeUuid: Filter by edge gateway UUID
 * - deviceName: Filter by monitored device name (e.g., 'COMAP-Main-Controller')
 */
router.get('/summary', jwtAuth, async (req, res) => {
  try {
    const { edgeUuid, deviceName } = req.query;

    const summary = await readingsService.getDeviceAnomalySummary(
      edgeUuid as string | undefined,
      deviceName as string | undefined
    );

    res.json({
      success: true,
      data: summary,
      count: summary.length
    });
  } catch (error) {
    logger.error('Failed to get device anomaly summary', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve anomaly summary'
    });
  }
});

/**
 * GET /api/anomaly/:deviceUuid/summary (legacy - edge gateway UUID)
 * Get anomaly summary for a specific edge gateway
 */
router.get('/:deviceUuid/summary', jwtAuth, async (req, res) => {
  try {
    const { deviceUuid } = req.params;

    const summary = await readingsService.getDeviceAnomalySummary(deviceUuid);

    if (!summary || summary.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No anomaly data found for edge gateway'
      });
    }

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    logger.error('Failed to get device anomaly summary', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve anomaly summary'
    });
  }
});

/**
 * GET /api/anomaly/hourly
 * Get hourly anomaly aggregates
 * 
 * Query params:
 * - edgeUuid: Filter by edge gateway UUID
 * - deviceName: Filter by monitored device name (e.g., 'COMAP-Main-Controller')
 * - metric: Filter by metric name
 * - start: Start time (ISO 8601)
 * - end: End time (ISO 8601)
 * - limit: Max records (default 24)
 */
router.get('/hourly', jwtAuth, async (req, res) => {
  try {
    const { edgeUuid, deviceName, metric, start, end, limit } = req.query;

    const startTime = start ? new Date(start as string) : undefined;
    const endTime = end ? new Date(end as string) : undefined;
    const maxRecords = limit ? parseInt(limit as string, 10) : 24;

    const aggregates = await readingsService.getHourlyAnomalyScores(
      edgeUuid as string | undefined,
      deviceName as string | undefined,
      metric as string | undefined,
      startTime,
      endTime,
      maxRecords
    );

    res.json({
      success: true,
      data: aggregates,
      count: aggregates.length
    });
  } catch (error) {
    logger.error('Failed to get hourly anomaly scores', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve hourly anomaly scores'
    });
  }
});

/**
 * GET /api/anomaly/:deviceUuid/hourly (legacy - edge gateway UUID)
 * Get hourly anomaly aggregates for specific edge gateway
 * 
 * Query params:
 * - metric: Filter by metric name
 * - start: Start time (ISO 8601)
 * - end: End time (ISO 8601)
 * - limit: Max records (default 24)
 */
router.get('/:deviceUuid/hourly', jwtAuth, async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { metric, start, end, limit } = req.query;

    const startTime = start ? new Date(start as string) : undefined;
    const endTime = end ? new Date(end as string) : undefined;
    const maxRecords = limit ? parseInt(limit as string, 10) : 24;

    const aggregates = await readingsService.getHourlyAnomalyScores(
      deviceUuid,
      undefined, // no deviceName filter
      metric as string | undefined,
      startTime,
      endTime,
      maxRecords
    );

    res.json({
      success: true,
      data: aggregates,
      count: aggregates.length
    });
  } catch (error) {
    logger.error('Failed to get hourly anomaly scores', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve hourly anomaly scores'
    });
  }
});

/**
 * GET /api/anomaly/daily
 * Get daily anomaly aggregates
 * 
 * Query params:
 * - edgeUuid: Filter by edge gateway UUID
 * - deviceName: Filter by monitored device name (e.g., 'COMAP-Main-Controller')
 * - metric: Filter by metric name
 * - start: Start time (ISO 8601)
 * - end: End time (ISO 8601)
 * - limit: Max records (default 30)
 */
router.get('/daily', jwtAuth, async (req, res) => {
  try {
    const { edgeUuid, deviceName, metric, start, end, limit } = req.query;

    const startTime = start ? new Date(start as string) : undefined;
    const endTime = end ? new Date(end as string) : undefined;
    const maxRecords = limit ? parseInt(limit as string, 10) : 30;

    const aggregates = await readingsService.getDailyAnomalyScores(
      edgeUuid as string | undefined,
      deviceName as string | undefined,
      metric as string | undefined,
      startTime,
      endTime,
      maxRecords
    );

    res.json({
      success: true,
      data: aggregates,
      count: aggregates.length
    });
  } catch (error) {
    logger.error('Failed to get daily anomaly scores', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve daily anomaly scores'
    });
  }
});

/**
 * GET /api/anomaly/top-metrics
 * Get metrics with highest anomaly scores
 * 
 * Query params:
 * - edgeUuid: Filter by edge gateway UUID
 * - deviceName: Filter by monitored device name (e.g., 'COMAP-Main-Controller')
 * - hours: Time window in hours (default 24)
 * - limit: Max metrics to return (default 10)
 */
router.get('/top-metrics', jwtAuth, async (req, res) => {
  try {
    const { edgeUuid, deviceName, hours, limit } = req.query;

    const timeWindow = hours ? parseInt(hours as string, 10) : 24;
    const maxMetrics = limit ? parseInt(limit as string, 10) : 10;

    const metrics = await readingsService.getTopAnomalousMetrics(
      edgeUuid as string | undefined,
      deviceName as string | undefined,
      timeWindow,
      maxMetrics
    );

    res.json({
      success: true,
      data: metrics,
      count: metrics.length
    });
  } catch (error) {
    logger.error('Failed to get top anomalous metrics', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve top anomalous metrics'
    });
  }
});

/**
 * GET /api/anomaly/:deviceUuid/top-metrics (legacy - edge gateway UUID)
 * Get metrics with highest anomaly scores for specific edge gateway
 * 
 * Query params:
 * - hours: Time window in hours (default 24)
 * - limit: Max metrics to return (default 10)
 */
router.get('/:deviceUuid/top-metrics', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { hours, limit } = req.query;

    const timeWindow = hours ? parseInt(hours as string, 10) : 24;
    const maxMetrics = limit ? parseInt(limit as string, 10) : 10;

    const metrics = await readingsService.getTopAnomalousMetrics(
      deviceUuid,
      undefined, // no deviceName filter
      timeWindow,
      maxMetrics
    );

    res.json({
      success: true,
      data: metrics,
      count: metrics.length
    });
  } catch (error) {
    logger.error('Failed to get top anomalous metrics', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve top anomalous metrics'
    });
  }
});

/**
 * GET /api/anomaly/:deviceUuid/top-metrics
 * Get metrics with highest anomaly scores
 * 
 * Query params:
 * - hours: Time window in hours (default 24)
 * - limit: Max metrics to return (default 10)
 */
router.get('/:deviceUuid/top-metrics', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { hours, limit } = req.query;

    const timeWindow = hours ? parseInt(hours as string, 10) : 24;
    const maxMetrics = limit ? parseInt(limit as string, 10) : 10;

    const metrics = await readingsService.getTopAnomalousMetrics(
      deviceUuid,
      undefined, // no deviceName filter
      timeWindow,
      maxMetrics
    );

    res.json({
      success: true,
      data: metrics,
      count: metrics.length
    });
  } catch (error) {
    logger.error('Failed to get top anomalous metrics', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve top anomalous metrics'
    });
  }
});

export default router;
