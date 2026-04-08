
import { jwtAuth } from '../middleware/jwt-auth';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { generateDashboardSuggestions, getStrategy } from '../services/ai/dashboard-suggestions.service';
import type { FastifyPluginAsync } from 'fastify'

const plugin: FastifyPluginAsync = async (fastify) => {

type FeedbackEventType = 'suggestion_shown' | 'suggestion_accepted' | 'widget_removed';
type FeedbackChartType = 'line' | 'bar' | 'gauge' | 'stat';
type FeedbackBin = 'top' | 'main' | 'side' | 'bottom';
type FeedbackSource = 'rules' | 'llm' | 'hybrid';

type AiCardsQuerystring = {
  strategy?: string;
};

type DashboardAiFeedbackBody = {
  events?: unknown[];
  event?: unknown;
};

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

function sanitizeFeedbackEvent(input: unknown): DashboardAiFeedbackEvent | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as {
    eventType?: unknown;
    suggestionId?: unknown;
    suggestionSignature?: unknown;
    deviceId?: unknown;
    metric?: unknown;
    chart?: unknown;
    bin?: unknown;
    source?: unknown;
    metadata?: unknown;
  };

  if (!isFeedbackEventType(candidate.eventType)) {
    return null;
  }

  const suggestionSignature = typeof candidate.suggestionSignature === 'string' ? candidate.suggestionSignature.trim() : '';
  const metric = typeof candidate.metric === 'string' ? candidate.metric.trim() : '';
  if (!suggestionSignature || !metric) {
    return null;
  }

  if (!isFeedbackChartType(candidate.chart) || !isFeedbackBin(candidate.bin)) {
    return null;
  }

  const suggestionId = typeof candidate.suggestionId === 'string' && candidate.suggestionId.trim().length > 0
    ? candidate.suggestionId.trim()
    : undefined;

  const deviceId = typeof candidate.deviceId === 'string' && candidate.deviceId.trim().length > 0
    ? candidate.deviceId.trim()
    : undefined;

  if (deviceId && !UUID_REGEX.test(deviceId)) {
    return null;
  }

  const source = isFeedbackSource(candidate.source) ? candidate.source : 'rules';
  const metadata = candidate.metadata && typeof candidate.metadata === 'object' && !Array.isArray(candidate.metadata)
    ? candidate.metadata as Record<string, unknown>
    : {};

  return {
    eventType: candidate.eventType,
    suggestionId,
    suggestionSignature,
    deviceId,
    metric,
    chart: candidate.chart,
    bin: candidate.bin,
    source,
    metadata,
  };
}

fastify.get<{ Querystring: AiCardsQuerystring }>('/ai-cards', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  const strategy = getStrategy(req.query.strategy);

  try {
    const result = await generateDashboardSuggestions({
      strategy,
      requestId,
      userId: req.user?.id,
      customerId: req.user?.customerId,
    });

    reply.send(result);
  } catch (error: any) {
    logger.error('Failed to generate AI dashboard cards', {
      requestId,
      userId: req.user?.id,
      error: error?.message || 'Unknown error',
    });

    reply.status(500).send({ error: 'Failed to generate AI dashboard cards', requestId });
  }
});

fastify.post<{ Body: DashboardAiFeedbackBody | unknown[] }>('/ai-feedback', { preHandler: [jwtAuth] }, async (req, reply) => {
  const requestId = req.id || 'unknown';
  const userId = req.user?.id;
  const customerId = req.user?.customerId || null;
  const body = req.body;

  logger.info('Dashboard AI feedback request received', {
    requestId,
    userId,
    customerId,
    hasEventsArray: !Array.isArray(body) && !!body && typeof body === 'object' && Array.isArray(body.events),
    hasSingleEvent: !Array.isArray(body) && !!body && typeof body === 'object' && 'event' in body && !!body.event,
    bodyType: Array.isArray(body) ? 'array' : typeof body,
    rawEventCount: !Array.isArray(body) && !!body && typeof body === 'object' && Array.isArray(body.events)
      ? body.events.length
      : !Array.isArray(body) && !!body && typeof body === 'object' && 'event' in body && body.event
        ? 1
        : Array.isArray(body)
          ? body.length
          : 0,
  });

  const inputEvents = !Array.isArray(body) && !!body && typeof body === 'object' && Array.isArray(body.events)
    ? body.events
    : !Array.isArray(body) && !!body && typeof body === 'object' && 'event' in body && body.event
      ? [body.event]
      : Array.isArray(body)
        ? body
        : [];

  if (inputEvents.length === 0) {
    return reply.status(400).send({ error: 'No feedback events provided', requestId });
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
    return reply.status(400).send({ error: 'No valid feedback events provided', requestId });
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

    reply.status(202).send({ accepted: events.length, requestId });
  } catch (error: any) {
    logger.error('Failed to persist dashboard AI feedback events', {
      requestId,
      userId,
      customerId,
      acceptedCount: events.length,
      error: error?.message || 'Unknown error',
    });

    reply.status(500).send({ error: 'Failed to persist feedback events', requestId });
  }
});

};

export default plugin;