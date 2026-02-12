/**
 * Event Sourcing Routes
 * Endpoints for querying device-related events for timeline visualization
 */

import express from 'express';
import { 
  EventStore,
  searchEvents,
  getDeviceTimeline,
  aggregateByPeriod,
  getDeviceSummary,
  type EventSearchCriteria
} from '../services/event-sourcing';
import { logger } from '../utils/logger';

export const router = express.Router();

// ============================================================================
// Event Query Endpoints
// ============================================================================

/**
 * Advanced event search with filtering
 * GET /api/v1/events/search
 * 
 * Query params:
 * - deviceUuid: Filter by device UUID
 * - eventTypes: Comma-separated event types
 * - aggregateTypes: Comma-separated aggregate types
 * - dateFrom: ISO date string
 * - dateTo: ISO date string
 * - severity: Comma-separated severity levels
 * - actorType: Actor type (system, user, device, agent, api, scheduler)
 * - actorId: Actor ID
 * - correlationId: Correlation ID
 * - limit: Max results (default 100, max 1000)
 * - offset: Pagination offset
 */
router.get('/events/search', async (req, res) => {
  try {
    const criteria: EventSearchCriteria = {};

    if (req.query.deviceUuid) {
      criteria.deviceUuid = req.query.deviceUuid as string;
    }

    if (req.query.eventTypes) {
      criteria.eventTypes = (req.query.eventTypes as string).split(',').map(t => t.trim());
    }

    if (req.query.aggregateTypes) {
      criteria.aggregateTypes = (req.query.aggregateTypes as string).split(',').map(t => t.trim());
    }

    if (req.query.dateFrom) {
      criteria.dateFrom = new Date(req.query.dateFrom as string);
    }

    if (req.query.dateTo) {
      criteria.dateTo = new Date(req.query.dateTo as string);
    }

    if (req.query.severity) {
      criteria.severity = (req.query.severity as string).split(',').map(s => s.trim());
    }

    if (req.query.actorType) {
      criteria.actor = { type: req.query.actorType as string };
      if (req.query.actorId) {
        criteria.actor.id = req.query.actorId as string;
      }
    }

    if (req.query.correlationId) {
      criteria.correlationId = req.query.correlationId as string;
    }

    if (req.query.limit) {
      const limit = parseInt(req.query.limit as string, 10);
      criteria.limit = Math.min(limit, 1000); // Max 1000
    }

    if (req.query.offset) {
      criteria.offset = parseInt(req.query.offset as string, 10);
    }

    const events = await searchEvents(criteria);

    res.json({
      success: true,
      count: events.length,
      events,
      criteria: {
        ...criteria,
        dateFrom: criteria.dateFrom?.toISOString(),
        dateTo: criteria.dateTo?.toISOString(),
      }
    });
  } catch (error) {
    logger.error('Error searching events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search events',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get chronological event timeline for device
 * GET /api/v1/events/device/:deviceUuid/timeline
 * 
 * Query params:
 * - sinceDate: ISO date string (get events since this date)
 * - eventTypes: Comma-separated event types to include
 * - includeSampled: Include debug-level events (default: false)
 * - limit: Max events (default 1000)
 */
router.get('/events/device/:deviceUuid/timeline', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const options: any = {};

    if (req.query.sinceDate) {
      options.sinceDate = new Date(req.query.sinceDate as string);
    }

    if (req.query.eventTypes) {
      options.eventTypes = (req.query.eventTypes as string).split(',').map(t => t.trim());
    }

    if (req.query.includeSampled) {
      options.includeSampled = req.query.includeSampled === 'true';
    }

    if (req.query.limit) {
      options.limit = parseInt(req.query.limit as string, 10);
    }

    const events = await getDeviceTimeline(deviceUuid, options);

    res.json({
      success: true,
      deviceUuid,
      count: events.length,
      events,
      options: {
        ...options,
        sinceDate: options.sinceDate?.toISOString(),
      }
    });
  } catch (error) {
    logger.error(`Error getting timeline for device ${req.params.deviceUuid}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to get device timeline',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Aggregate events by time period
 * GET /api/v1/events/device/:deviceUuid/aggregate
 * 
 * Query params:
 * - period: hour|day|week|month (required)
 * - dateFrom: ISO date string (required)
 * - dateTo: ISO date string (required)
 */
router.get('/events/device/:deviceUuid/aggregate', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { period, dateFrom, dateTo } = req.query;

    if (!period || !dateFrom || !dateTo) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters',
        message: 'period, dateFrom, and dateTo are required'
      });
    }

    if (!['hour', 'day', 'week', 'month'].includes(period as string)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid period',
        message: 'period must be one of: hour, day, week, month'
      });
    }

    const aggregation = await aggregateByPeriod(
      deviceUuid,
      period as 'hour' | 'day' | 'week' | 'month',
      new Date(dateFrom as string),
      new Date(dateTo as string)
    );

    res.json({
      success: true,
      deviceUuid,
      period,
      dateFrom,
      dateTo,
      count: aggregation.length,
      aggregation
    });
  } catch (error) {
    logger.error(`Error aggregating events for device ${req.params.deviceUuid}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to aggregate events',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get event summary and health score for device
 * GET /api/v1/events/device/:deviceUuid/summary
 * 
 * Query params:
 * - daysBack: Number of days to analyze (default: 30)
 */
router.get('/events/device/:deviceUuid/summary', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const daysBack = req.query.daysBack 
      ? parseInt(req.query.daysBack as string, 10) 
      : 30;

    const summary = await getDeviceSummary(deviceUuid, daysBack);

    res.json({
      success: true,
      deviceUuid,
      daysBack,
      summary
    });
  } catch (error) {
    logger.error(`Error getting summary for device ${req.params.deviceUuid}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to get device summary',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get events for a specific device
 * GET /api/v1/events/device/:deviceUuid
 * Query params:
 *   - limit: number of events to return (default 50, max 500)
 *   - sinceEventId: get events after this event ID
 *   - eventType: filter by specific event type
 */
router.get('/events/device/:deviceUuid', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const sinceEventId = req.query.sinceEventId ? parseInt(req.query.sinceEventId as string) : undefined;
    const eventType = req.query.eventType as string | undefined;

    logger.info(`Fetching events for device: ${deviceUuid}`);

    // Get events for this device
    let events = await EventStore.getAggregateEvents('agent', deviceUuid, sinceEventId);

    // Filter by event type if specified
    if (eventType) {
      events = events.filter(e => e.event_type === eventType);
    }

    // Apply limit
    events = events.slice(0, limit);

    // Transform events for timeline display
    const timelineEvents = events.map(event => ({
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

    res.json({
      success: true,
      count: timelineEvents.length,
      deviceUuid,
      events: timelineEvents,
    });
  } catch (error) {
    logger.error('Error fetching device events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch device events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get event chain by correlation ID
 * GET /api/v1/events/chain/:correlationId
 */
router.get('/events/chain/:correlationId', async (req, res) => {
  try {
    const { correlationId } = req.params;

    logger.info(`Fetching event chain for correlation: ${correlationId}`);

    const events = await EventStore.getEventChain(correlationId);

    const timelineEvents = events.map(event => ({
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

    res.json({
      success: true,
      count: timelineEvents.length,
      correlationId,
      events: timelineEvents,
    });
  } catch (error) {
    logger.error('Error fetching event chain:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event chain',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get recent events across all devices
 * GET /api/v1/events/recent
 * Query params:
 *   - limit: number of events to return (default 100, max 500)
 *   - aggregateType: filter by aggregate type (e.g., 'agent', 'app')
 */
router.get('/events/recent', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const aggregateType = req.query.aggregateType as string | undefined;

    logger.info(`Fetching recent events (limit: ${limit})`);

    const events = await EventStore.getRecentEvents(limit, aggregateType);

    const timelineEvents = events.map(event => ({
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

    res.json({
      success: true,
      count: timelineEvents.length,
      events: timelineEvents,
    });
  } catch (error) {
    logger.error('Error fetching recent events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Get event statistics
 * GET /api/v1/events/stats
 * Query params:
 *   - daysBack: number of days to look back (default 7)
 */
router.get('/events/stats', async (req, res) => {
  try {
    const daysBack = parseInt(req.query.daysBack as string) || 7;

    logger.info(`Fetching event stats (${daysBack} days)`);

    const stats = await EventStore.getStats(daysBack);

    res.json({
      success: true,
      daysBack,
      stats,
    });
  } catch (error) {
    logger.error('Error fetching event stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event statistics',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Replay events within time window (for debugging)
 * POST /api/v1/events/device/:deviceUuid/replay
 * Body:
 *   - fromTime: ISO timestamp
 *   - toTime: ISO timestamp
 */
router.post('/events/device/:deviceUuid/replay', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { fromTime, toTime } = req.body;

    if (!fromTime || !toTime) {
      return res.status(400).json({
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

    res.json({
      success: true,
      deviceUuid,
      fromTime,
      toTime,
      ...result,
    });
  } catch (error) {
    logger.error('Error replaying events:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to replay events',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Create snapshot of device state at specific point in time
 * POST /api/v1/events/device/:deviceUuid/snapshot
 * Body:
 *   - timestamp: ISO timestamp
 */
router.post('/events/device/:deviceUuid/snapshot', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { timestamp } = req.body;

    if (!timestamp) {
      return res.status(400).json({
        success: false,
        error: 'timestamp is required',
      });
    }

    logger.info(`Creating snapshot for device ${deviceUuid} at ${timestamp}`);

    const snapshot = await EventStore.createSnapshot(
      deviceUuid,
      new Date(timestamp)
    );

    res.json({
      success: true,
      ...snapshot,
    });
  } catch (error) {
    logger.error('Error creating snapshot:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create snapshot',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * Compare device state between two points in time
 * POST /api/v1/events/device/:deviceUuid/compare
 * Body:
 *   - time1: ISO timestamp (earlier time)
 *   - time2: ISO timestamp (later time)
 */
router.post('/events/device/:deviceUuid/compare', async (req, res) => {
  try {
    const { deviceUuid } = req.params;
    const { time1, time2 } = req.body;

    if (!time1 || !time2) {
      return res.status(400).json({
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

    res.json({
      success: true,
      deviceUuid,
      time1,
      time2,
      changes_count: comparison.changes.length,
      events_between_count: comparison.events_between.length,
      ...comparison,
    });
  } catch (error) {
    logger.error('Error comparing states:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to compare states',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Categorize event types for display
 */
function categorizeEvent(eventType: string): string {
  if (eventType.startsWith('target_state.')) return 'configuration';
  if (eventType.startsWith('current_state.')) return 'telemetry';
  if (eventType.startsWith('reconciliation.')) return 'system';
  if (eventType.startsWith('container.')) return 'container';
  if (eventType.startsWith('device.')) return 'agent';
  if (eventType.startsWith('app.')) return 'application';
  if (eventType.startsWith('job.')) return 'job';
  return 'other';
}

/**
 * Generate human-readable event titles
 */
function generateEventTitle(eventType: string): string {
  const titleMap: { [key: string]: string } = {
    'target_state.updated': 'Target State Updated',
    'current_state.updated': 'Current State Updated',
    'reconciliation.started': 'Reconciliation Started',
    'reconciliation.completed': 'Reconciliation Completed',
    'container.start': 'Container Started',
    'container.stop': 'Container Stopped',
    'container.restart': 'Container Restarted',
    'container.update': 'Container Updated',
    'device.provisioned': 'Device Provisioned',
    'device.online': 'Device Online',
    'device.offline': 'Device Offline',
    'app.deployed': 'Application Deployed',
    'app.removed': 'Application Removed',
    'job.scheduled': 'Job Scheduled',
    'job.started': 'Job Started',
    'job.completed': 'Job Completed',
    'job.failed': 'Job Failed',
  };

  return titleMap[eventType] || eventType.split('.').map(s => 
    s.charAt(0).toUpperCase() + s.slice(1)
  ).join(' ');
}

/**
 * Generate event description from event data
 */
function generateEventDescription(event: any): string {
  const { event_type, data } = event;

  try {
    switch (event_type) {
      case 'target_state.updated':
        const changedFields = data.changed_fields || [];
        return changedFields.length > 0 
          ? `Changed: ${changedFields.join(', ')}`
          : 'Configuration updated';

      case 'reconciliation.completed':
        return data.success 
          ? `${data.actions_count || 0} actions completed in ${data.duration_ms}ms`
          : 'Reconciliation failed';

      case 'container.start':
      case 'container.stop':
      case 'container.restart':
        return data.container_name || data.app_name || 'Container operation';

      case 'current_state.updated':
        return 'Device reported new state';

      case 'device.online':
        return 'Device connected';

      case 'device.offline':
        return 'Device disconnected';

      default:
        // Try to extract meaningful description from data
        if (data.message) return data.message;
        if (data.description) return data.description;
        if (data.status) return data.status;
        return 'Event occurred';
    }
  } catch (error) {
    return 'Event occurred';
  }
}

export default router;
