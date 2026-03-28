import express from 'express';
import { jwtAuth } from '../middleware/jwt-auth';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { generateDashboardSuggestions, getStrategy } from '../services/ai/dashboard-suggestions.service';

const router = express.Router();

type FeedbackEventType = 'suggestion_shown' | 'suggestion_accepted' | 'widget_removed';
type FeedbackChartType = 'line' | 'bar' | 'gauge' | 'stat';
type FeedbackBin = 'top' | 'main' | 'side' | 'bottom';
type FeedbackSource = 'rules' | 'llm' | 'hybrid';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DashboardAiFeedbackEvent {
  eventType: FeedbackEventType;
  suggestionId?: string;
  suggestionSignature: string;
  deviceId?: string;
  metric: string;
  chart: FeedbackChartType;
  bin: FeedbackBin;
  source?: FeedbackSource;
  metadata?: Record<string, unknown>;
}

function isFeedbackEventType(value: unknown): value is FeedbackEventType {
  return value === 'suggestion_shown' || value === 'suggestion_accepted' || value === 'widget_removed';
}

function isFeedbackChartType(value: unknown): value is FeedbackChartType {
  return value === 'line' || value === 'bar' || value === 'gauge' || value === 'stat';
}

function isFeedbackBin(value: unknown): value is FeedbackBin {
  return value === 'top' || value === 'main' || value === 'side' || value === 'bottom';
}

function isFeedbackSource(value: unknown): value is FeedbackSource {
  return value === 'rules' || value === 'llm' || value === 'hybrid';
}

function sanitizeFeedbackEvent(input: any): DashboardAiFeedbackEvent | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  if (!isFeedbackEventType(input.eventType)) {
    return null;
  }

  const suggestionSignature = typeof input.suggestionSignature === 'string' ? input.suggestionSignature.trim() : '';
  const metric = typeof input.metric === 'string' ? input.metric.trim() : '';
  if (!suggestionSignature || !metric) {
    return null;
  }

  if (!isFeedbackChartType(input.chart) || !isFeedbackBin(input.bin)) {
    return null;
  }

  const suggestionId = typeof input.suggestionId === 'string' && input.suggestionId.trim().length > 0
    ? input.suggestionId.trim()
    : undefined;

  const deviceId = typeof input.deviceId === 'string' && input.deviceId.trim().length > 0
    ? input.deviceId.trim()
    : undefined;

  if (deviceId && !UUID_REGEX.test(deviceId)) {
    return null;
  }

  const source = isFeedbackSource(input.source) ? input.source : 'rules';
  const metadata = input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
    ? input.metadata
    : {};

  return {
    eventType: input.eventType,
    suggestionId,
    suggestionSignature,
    deviceId,
    metric,
    chart: input.chart,
    bin: input.bin,
    source,
    metadata,
  };
}

router.get('/ai-cards', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  const strategy = getStrategy(req.query?.strategy);

  try {
    const result = await generateDashboardSuggestions({
      strategy,
      requestId,
      userId: (req as any).user?.id,
      customerId: (req as any).user?.customerId,
    });

    res.json(result);
  } catch (error: any) {
    logger.error('Failed to generate AI dashboard cards', {
      requestId,
      userId: (req as any).user?.id,
      error: error?.message || 'Unknown error',
    });

    res.status(500).json({ error: 'Failed to generate AI dashboard cards', requestId });
  }
});

router.post('/ai-feedback', jwtAuth, async (req, res) => {
  const requestId = (req as any).id || 'unknown';
  const userId = (req as any).user?.id;
  const customerId = (req as any).user?.customerId || null;

  logger.info('Dashboard AI feedback request received', {
    requestId,
    userId,
    customerId,
    hasEventsArray: Array.isArray(req.body?.events),
    hasSingleEvent: !!req.body?.event,
    bodyType: Array.isArray(req.body) ? 'array' : typeof req.body,
    rawEventCount: Array.isArray(req.body?.events)
      ? req.body.events.length
      : req.body?.event
        ? 1
        : Array.isArray(req.body)
          ? req.body.length
          : 0,
  });

  const inputEvents = Array.isArray(req.body?.events)
    ? req.body.events
    : req.body?.event
      ? [req.body.event]
      : Array.isArray(req.body)
        ? req.body
        : [];

  if (inputEvents.length === 0) {
    return res.status(400).json({ error: 'No feedback events provided', requestId });
  }

  const events = inputEvents
    .map(sanitizeFeedbackEvent)
    .filter((event): event is DashboardAiFeedbackEvent => event !== null)
    .slice(0, 100);

  logger.info('Dashboard AI feedback events sanitized', {
    requestId,
    userId,
    customerId,
    inputEventCount: inputEvents.length,
    acceptedEventCount: events.length,
    acceptedEventTypes: events.map((event) => event.eventType),
    suggestionSignatures: events.map((event) => event.suggestionSignature),
  });

  if (events.length === 0) {
    return res.status(400).json({ error: 'No valid feedback events provided', requestId });
  }

  try {
    await Promise.all(events.map((event) => query(
      `
      INSERT INTO dashboard_ai_feedback_events (
        event_type,
        suggestion_id,
        suggestion_signature,
        device_id,
        metric_name,
        chart_type,
        layout_bin,
        source,
        user_id,
        customer_id,
        metadata
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `,
      [
        event.eventType,
        event.suggestionId || null,
        event.suggestionSignature,
        event.deviceId || null,
        event.metric,
        event.chart,
        event.bin,
        event.source || 'rules',
        userId !== undefined && userId !== null ? String(userId) : null,
        customerId,
        JSON.stringify(event.metadata || {}),
      ],
    )));

    logger.info('Dashboard AI feedback events persisted', {
      requestId,
      userId,
      customerId,
      persistedEventCount: events.length,
      persistedEventTypes: events.map((event) => event.eventType),
    });

    res.status(202).json({ accepted: events.length, requestId });
  } catch (error: any) {
    logger.error('Failed to persist dashboard AI feedback events', {
      requestId,
      userId,
      customerId,
      acceptedCount: events.length,
      error: error?.message || 'Unknown error',
    });

    res.status(500).json({ error: 'Failed to persist feedback events', requestId });
  }
});

export default router;