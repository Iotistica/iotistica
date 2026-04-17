/**
 * Event Sourcing Routes
 * Endpoints for querying device-related events for timeline visualization
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  EventStore,
  aggregateByPeriod,
  getDeviceSummary,
  getDeviceTimeline,
  searchEvents,
  type Event,
  type EventSearchCriteria,
} from '../services/audit/event-sourcing';
import { jwtAuth, requireRole } from '../middleware/jwt-auth';
import { logger } from '../utils/logger';

type AggregatePeriod = 'hour' | 'day' | 'week' | 'month';

interface DeviceUuidParams {
  deviceUuid: string;
}

interface CorrelationIdParams {
  correlationId: string;
}

interface SearchEventsQuerystring {
  deviceUuid?: string;
  eventTypes?: string;
  aggregateTypes?: string;
  dateFrom?: string;
  dateTo?: string;
  severity?: string;
  actorType?: string;
  actorId?: string;
  correlationId?: string;
  limit?: string | number;
  offset?: string | number;
}

interface TimelineQuerystring {
  sinceDate?: string;
  eventTypes?: string;
  includeSampled?: string | boolean;
  limit?: string | number;
}

interface AggregateQuerystring {
  period?: string;
  dateFrom?: string;
  dateTo?: string;
}

interface SummaryQuerystring {
  daysBack?: string | number;
}

interface DeviceEventsQuerystring {
  limit?: string | number;
  sinceEventId?: string | number;
  eventType?: string;
}

interface RecentEventsQuerystring {
  limit?: string | number;
  aggregateType?: string;
}

interface StatsQuerystring {
  daysBack?: string | number;
}

interface ReplayBody {
  fromTime?: string;
  toTime?: string;
}

interface SnapshotBody {
  timestamp?: string;
}

interface CompareBody {
  time1?: string;
  time2?: string;
}

interface TimelineOptions {
  sinceDate?: Date;
  eventTypes?: string[];
  includeSampled?: boolean;
  limit?: number;
}

interface EventDescriptionInput {
  event_type: string;
  data?: Record<string, unknown> | null;
}

function parseInteger(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const items = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length ? items : undefined;
}

function parseBoolean(value: string | boolean | undefined, fallback = false): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }

  return fallback;
}

function isAggregatePeriod(value: string): value is AggregatePeriod {
  return ['hour', 'day', 'week', 'month'].includes(value);
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', jwtAuth);
  fastify.addHook('preHandler', requireRole('admin'));

  fastify.get<{ Querystring: SearchEventsQuerystring }>('/events/search', async (req, reply) => {
    try {
      const criteria: EventSearchCriteria = {};
      const {
        deviceUuid,
        eventTypes,
        aggregateTypes,
        dateFrom,
        dateTo,
        severity,
        actorType,
        actorId,
        correlationId,
        limit,
        offset,
      } = req.query;

      if (deviceUuid) {
        criteria.deviceUuid = deviceUuid;
      }

      const parsedEventTypes = parseStringList(eventTypes);
      if (parsedEventTypes) {
        criteria.eventTypes = parsedEventTypes;
      }

      const parsedAggregateTypes = parseStringList(aggregateTypes);
      if (parsedAggregateTypes) {
        criteria.aggregateTypes = parsedAggregateTypes;
      }

      if (dateFrom) {
        criteria.dateFrom = new Date(dateFrom);
      }

      if (dateTo) {
        criteria.dateTo = new Date(dateTo);
      }

      const parsedSeverity = parseStringList(severity);
      if (parsedSeverity) {
        criteria.severity = parsedSeverity;
      }

      if (actorType) {
        criteria.actor = { type: actorType };
        if (actorId) {
          criteria.actor.id = actorId;
        }
      }

      if (correlationId) {
        criteria.correlationId = correlationId;
      }

      if (limit !== undefined) {
        criteria.limit = Math.min(parseInteger(limit, 100), 1000);
      }

      if (offset !== undefined) {
        criteria.offset = parseInteger(offset, 0);
      }

      const events = await searchEvents(criteria);

      return reply.send({
        success: true,
        count: events.length,
        events,
        criteria: {
          ...criteria,
          dateFrom: criteria.dateFrom?.toISOString(),
          dateTo: criteria.dateTo?.toISOString(),
        },
      });
    } catch (error: unknown) {
      logger.error('Error searching events:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to search events',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: DeviceUuidParams; Querystring: TimelineQuerystring }>('/events/device/:deviceUuid/timeline', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const options: TimelineOptions = {};
      const { sinceDate, eventTypes, includeSampled, limit } = req.query;

      if (sinceDate) {
        options.sinceDate = new Date(sinceDate);
      }

      const parsedEventTypes = parseStringList(eventTypes);
      if (parsedEventTypes) {
        options.eventTypes = parsedEventTypes;
      }

      if (includeSampled !== undefined) {
        options.includeSampled = parseBoolean(includeSampled);
      }

      if (limit !== undefined) {
        options.limit = parseInteger(limit, 1000);
      }

      const events = await getDeviceTimeline(deviceUuid, options);

      return reply.send({
        success: true,
        deviceUuid,
        count: events.length,
        events,
        options: {
          ...options,
          sinceDate: options.sinceDate?.toISOString(),
        },
      });
    } catch (error: unknown) {
      logger.error(`Error getting timeline for device ${req.params.deviceUuid}:`, error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to get device timeline',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: DeviceUuidParams; Querystring: AggregateQuerystring }>('/events/device/:deviceUuid/aggregate', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const { period, dateFrom, dateTo } = req.query;

      if (!period || !dateFrom || !dateTo) {
        return reply.status(400).send({
          success: false,
          error: 'Missing required parameters',
          message: 'period, dateFrom, and dateTo are required',
        });
      }

      if (!isAggregatePeriod(period)) {
        return reply.status(400).send({
          success: false,
          error: 'Invalid period',
          message: 'period must be one of: hour, day, week, month',
        });
      }

      const aggregation = await aggregateByPeriod(
        deviceUuid,
        period,
        new Date(dateFrom),
        new Date(dateTo)
      );

      return reply.send({
        success: true,
        deviceUuid,
        period,
        dateFrom,
        dateTo,
        count: aggregation.length,
        aggregation,
      });
    } catch (error: unknown) {
      logger.error(`Error aggregating events for device ${req.params.deviceUuid}:`, error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to aggregate events',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: DeviceUuidParams; Querystring: SummaryQuerystring }>('/events/device/:deviceUuid/summary', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const daysBack = parseInteger(req.query.daysBack, 30);

      const summary = await getDeviceSummary(deviceUuid, daysBack);

      return reply.send({
        success: true,
        deviceUuid,
        daysBack,
        summary,
      });
    } catch (error: unknown) {
      logger.error(`Error getting summary for device ${req.params.deviceUuid}:`, error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to get device summary',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: DeviceUuidParams; Querystring: DeviceEventsQuerystring }>('/events/device/:deviceUuid', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const limit = Math.min(parseInteger(req.query.limit, 50), 500);
      const sinceEventId = req.query.sinceEventId !== undefined
        ? parseInteger(req.query.sinceEventId, 0)
        : undefined;
      const { eventType } = req.query;

      logger.info(`Fetching events for device: ${deviceUuid}`);

      let events = await EventStore.getAggregateEvents('agent', deviceUuid, sinceEventId);

      if (eventType) {
        events = events.filter((event) => event.event_type === eventType);
      }

      events = events.slice(0, limit);

      const timelineEvents = events.map((event) => ({
        id: event.id,
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.event_type,
        category: categorizeEvent(event.event_type),
        title: generateEventTitle(event.event_type),
        description: generateEventDescription(event),
        data: event.data,
        metadata: event.metadata,
        source: event.source,
        correlation_id: event.correlation_id,
      }));

      return reply.send({
        success: true,
        count: timelineEvents.length,
        deviceUuid,
        events: timelineEvents,
      });
    } catch (error: unknown) {
      logger.error('Error fetching device events:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch device events',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Params: CorrelationIdParams }>('/events/chain/:correlationId', async (req, reply) => {
    try {
      const { correlationId } = req.params;

      logger.info(`Fetching event chain for correlation: ${correlationId}`);

      const events = await EventStore.getEventChain(correlationId);

      const timelineEvents = events.map((event) => ({
        id: event.id,
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.event_type,
        category: categorizeEvent(event.event_type),
        title: generateEventTitle(event.event_type),
        description: generateEventDescription(event),
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        data: event.data,
        metadata: event.metadata,
        source: event.source,
      }));

      return reply.send({
        success: true,
        count: timelineEvents.length,
        correlationId,
        events: timelineEvents,
      });
    } catch (error: unknown) {
      logger.error('Error fetching event chain:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch event chain',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Querystring: RecentEventsQuerystring }>('/events/recent', async (req, reply) => {
    try {
      const limit = Math.min(parseInteger(req.query.limit, 100), 500);
      const { aggregateType } = req.query;

      logger.info(`Fetching recent events (limit: ${limit})`);

      const events = await EventStore.getRecentEvents(limit, aggregateType);

      const timelineEvents = events.map((event) => ({
        id: event.id,
        event_id: event.event_id,
        timestamp: event.timestamp,
        type: event.event_type,
        category: categorizeEvent(event.event_type),
        title: generateEventTitle(event.event_type),
        description: generateEventDescription(event),
        aggregate_type: event.aggregate_type,
        aggregate_id: event.aggregate_id,
        data: event.data,
        metadata: event.metadata,
        source: event.source,
      }));

      return reply.send({
        success: true,
        count: timelineEvents.length,
        events: timelineEvents,
      });
    } catch (error: unknown) {
      logger.error('Error fetching recent events:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch recent events',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.get<{ Querystring: StatsQuerystring }>('/events/stats', async (req, reply) => {
    try {
      const daysBack = parseInteger(req.query.daysBack, 7);

      logger.info(`Fetching event stats (${daysBack} days)`);

      const stats = await EventStore.getStats(daysBack);

      return reply.send({
        success: true,
        daysBack,
        stats,
      });
    } catch (error: unknown) {
      logger.error('Error fetching event stats:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch event statistics',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Params: DeviceUuidParams; Body: ReplayBody }>('/events/device/:deviceUuid/replay', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const { fromTime, toTime } = req.body;

      if (!fromTime || !toTime) {
        return reply.status(400).send({
          success: false,
          error: 'fromTime and toTime are required',
        });
      }

      logger.info(`Replaying events for device ${deviceUuid} from ${fromTime} to ${toTime}`);

      const result = await EventStore.replayEvents(
        deviceUuid,
        new Date(fromTime),
        new Date(toTime)
      );

      return reply.send({
        success: true,
        deviceUuid,
        fromTime,
        toTime,
        ...result,
      });
    } catch (error: unknown) {
      logger.error('Error replaying events:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to replay events',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Params: DeviceUuidParams; Body: SnapshotBody }>('/events/device/:deviceUuid/snapshot', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const { timestamp } = req.body;

      if (!timestamp) {
        return reply.status(400).send({
          success: false,
          error: 'timestamp is required',
        });
      }

      logger.info(`Creating snapshot for device ${deviceUuid} at ${timestamp}`);

      const snapshot = await EventStore.createSnapshot(
        deviceUuid,
        new Date(timestamp)
      );

      return reply.send({
        success: true,
        ...snapshot,
      });
    } catch (error: unknown) {
      logger.error('Error creating snapshot:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to create snapshot',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  fastify.post<{ Params: DeviceUuidParams; Body: CompareBody }>('/events/device/:deviceUuid/compare', async (req, reply) => {
    try {
      const { deviceUuid } = req.params;
      const { time1, time2 } = req.body;

      if (!time1 || !time2) {
        return reply.status(400).send({
          success: false,
          error: 'time1 and time2 are required',
        });
      }

      logger.info(`Comparing states for device ${deviceUuid} between ${time1} and ${time2}`);

      const comparison = await EventStore.compareStates(
        deviceUuid,
        new Date(time1),
        new Date(time2)
      );

      return reply.send({
        success: true,
        deviceUuid,
        time1,
        time2,
        changes_count: comparison.changes.length,
        events_between_count: comparison.events_between.length,
        ...comparison,
      });
    } catch (error: unknown) {
      logger.error('Error comparing states:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to compare states',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });
};

function categorizeEvent(eventType: string): string {
  if (eventType.startsWith('target_state.')) return 'configuration';
  if (eventType.startsWith('current_state.')) return 'telemetry';
  if (eventType.startsWith('reconciliation.')) return 'system';
  if (eventType.startsWith('container.')) return 'container';
  if (eventType.startsWith('device_sensor.')) return 'provisioning';
  if (eventType.startsWith('device.')) return 'agent';
  if (eventType.startsWith('app.')) return 'application';
  if (eventType.startsWith('job.')) return 'job';
  return 'other';
}

function generateEventTitle(eventType: string): string {
  const titleMap: Record<string, string> = {
    'target_state.updated': 'Target State Updated',
    'current_state.updated': 'Current State Updated',
    'reconciliation.started': 'Reconciliation Started',
    'reconciliation.completed': 'Reconciliation Completed',
    'container.start': 'Container Started',
    'container.stop': 'Container Stopped',
    'container.restart': 'Container Restarted',
    'container.update': 'Container Updated',
    'device.provisioned': 'Agent Provisioned',
    'device.online': 'Agent Online',
    'device.offline': 'Agent Offline',
    'device_sensor.added': 'Device Added',
    'device_sensor.updated': 'Device Updated',
    'device_sensor.pending_deletion': 'Device Pending Deletion',
    'device_sensor.deleted': 'Device Deleted',
    'app.deployed': 'Application Deployed',
    'app.removed': 'Application Removed',
    'job.scheduled': 'Job Scheduled',
    'job.started': 'Job Started',
    'job.completed': 'Job Completed',
    'job.failed': 'Job Failed',
  };

  return titleMap[eventType] || eventType
    .split('.')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function generateEventDescription(event: EventDescriptionInput): string {
  const { event_type, data } = event;
  const eventData = data ?? {};

  try {
    switch (event_type) {
      case 'target_state.updated': {
        const changedFields = Array.isArray(eventData.changed_fields)
          ? eventData.changed_fields.filter((field): field is string => typeof field === 'string')
          : [];
        return changedFields.length > 0
          ? `Changed: ${changedFields.join(', ')}`
          : 'Configuration updated';
      }

      case 'reconciliation.completed': {
        const success = eventData.success === true;
        const actionsCount = typeof eventData.actions_count === 'number' ? eventData.actions_count : 0;
        const durationMs = typeof eventData.duration_ms === 'number' ? eventData.duration_ms : 'unknown';
        return success
          ? `${actionsCount} actions completed in ${durationMs}ms`
          : 'Reconciliation failed';
      }

      case 'container.start':
      case 'container.stop':
      case 'container.restart':
        return typeof eventData.container_name === 'string'
          ? eventData.container_name
          : typeof eventData.app_name === 'string'
            ? eventData.app_name
            : 'Container operation';

      case 'current_state.updated':
        return 'Device reported new state';

      case 'device.online':
        return 'Device connected';

      case 'device.offline':
        return 'Device disconnected';

      default:
        if (typeof eventData.message === 'string') return eventData.message;
        if (typeof eventData.description === 'string') return eventData.description;
        if (typeof eventData.status === 'string') return eventData.status;
        return 'Event occurred';
    }
  } catch {
    return 'Event occurred';
  }
}

export default plugin;