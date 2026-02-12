/**
 * Event Sourcing Service
 * Application-side implementation for event publishing and consumption
 */

import pool from '../db/connection';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import EventSourcingConfig from '../events/event-sourcing';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export interface Event {
  id?: number;
  event_id: string;
  event_type: string;
  event_version: number;
  timestamp: Date;
  aggregate_type: string;
  aggregate_id: string;
  data: any;
  metadata?: any;
  correlation_id?: string;
  causation_id?: string;
  source?: string;
  checksum: string;
  actor_type?: string;
  actor_id?: string;
  severity?: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  impact?: 'low' | 'medium' | 'high';
}

export interface Actor {
  type: 'user' | 'device' | 'system' | 'api' | 'scheduled_job';
  id: string;           // user_id, device_uuid, job_id
  name?: string;        // Display name
  ip_address?: string;  // For user/API actions
}

export interface SnapshotResult {
  timestamp: Date;
  device_uuid: string;
  target_state: any;
  current_state: any;
  containers: Record<string, any>;
  jobs: Record<string, any>;
  online: boolean | null;
  last_seen: Date | null;
  offline_since: Date | null;
  event_count: number;
  last_event_id?: string;
  last_event_type?: string;
}

export interface EventMetadata {
  actor?: Actor;
  request?: {
    id?: string;
    method?: string;
    path?: string;
    user_agent?: string;
  };
  tenant?: {
    id: string;
    name?: string;
  };
  tags?: Record<string, string>;
  [key: string]: any;  // Allow additional custom fields
}

export interface EventHandler {
  (event: Event): Promise<void>;
}

export interface ProjectionHandler {
  (event: Event, currentState: any): Promise<any>;
}

// ============================================================================
// EVENT PUBLISHER
// ============================================================================

export class EventPublisher {
  private correlationId?: string;
  private source: string;
  private actor?: Actor;

  constructor(source: string = 'system', correlationId?: string, actor?: Actor) {
    this.source = source;
    this.correlationId = correlationId || crypto.randomUUID();
    this.actor = actor;
  }

  /**
   * Publish a single event (with config-based filtering)
   */
  async publish(
    eventType: string,
    aggregateType: string,
    aggregateId: string,
    data: any,
    options?: {
      causationId?: string;
      metadata?: EventMetadata;
      severity?: 'debug' | 'info' | 'warning' | 'error' | 'critical';
      impact?: 'low' | 'medium' | 'high';
      actor?: Actor;  // Override instance-level actor
    }
  ): Promise<string | null> {
    // Check if this event should be published based on configuration
    if (!EventSourcingConfig.shouldPublishEvent(eventType)) {
      console.log(`[EventPublisher] Skipping event ${eventType} (filtered by config)`);
      return null;
    }

    // Merge instance actor with options actor (options takes precedence)
    const finalActor = options?.actor || this.actor;

    // Merge actor into metadata
    const enrichedMetadata = {
      ...options?.metadata,
      actor: finalActor,
    };

    const result = await pool.query(
      `SELECT publish_event($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) as event_id`,
      [
        eventType,
        aggregateType,
        aggregateId,
        JSON.stringify(data),
        this.source,
        this.correlationId,
        options?.causationId || null,
        JSON.stringify(enrichedMetadata),
        finalActor?.type || null,
        finalActor?.id || null,
        options?.severity || null,
        options?.impact || null,
      ]
    );

    return result.rows[0].event_id;
  }

  /**
   * Publish multiple events atomically (in transaction)
   */
  async publishBatch(
    events: Array<{
      eventType: string;
      aggregateType: string;
      aggregateId: string;
      data: any;
      metadata?: any;
    }>
  ): Promise<string[]> {
    return pool.transaction(async (client) => {
      const eventIds: string[] = [];

      for (const event of events) {
        const result = await client.query(
          `SELECT publish_event($1, $2, $3, $4, $5, $6, $7, $8) as event_id`,
          [
            event.eventType,
            event.aggregateType,
            event.aggregateId,
            JSON.stringify(event.data),
            this.source,
            this.correlationId,
            null, // causation_id
            event.metadata ? JSON.stringify(event.metadata) : null,
          ]
        );

        eventIds.push(result.rows[0].event_id);
      }

      return eventIds;
    });
  }

  /**
   * Get correlation ID for this publisher
   */
  getCorrelationId(): string {
    return this.correlationId!;
  }
}

// ============================================================================
// EVENT STORE (Query Interface)
// ============================================================================

export class EventStore {
  /**
   * Get all events for an aggregate
   */
  static async getAggregateEvents(
    aggregateType: string,
    aggregateId: string,
    sinceEventId?: number
  ): Promise<Event[]> {
    const result = await pool.query(
      `SELECT * FROM get_aggregate_events($1, $2, $3)`,
      [aggregateType, aggregateId, sinceEventId || null]
    );

    return result.rows;
  }

  /**
   * Get event chain by correlation ID
   */
  static async getEventChain(correlationId: string): Promise<Event[]> {
    const result = await pool.query(
      `SELECT * FROM get_event_chain($1)`,
      [correlationId]
    );

    return result.rows;
  }

  /**
   * Get events by type
   */
  static async getEventsByType(
    eventType: string,
    limit: number = 100,
    offset: number = 0
  ): Promise<Event[]> {
    const result = await pool.query(
      `SELECT * FROM events 
       WHERE event_type = $1 
       ORDER BY timestamp DESC 
       LIMIT $2 OFFSET $3`,
      [eventType, limit, offset]
    );

    return result.rows;
  }

  /**
   * Get recent events
   */
  static async getRecentEvents(
    limit: number = 100,
    aggregateType?: string
  ): Promise<Event[]> {
    const query = aggregateType
      ? `SELECT * FROM events WHERE aggregate_type = $1 ORDER BY timestamp DESC LIMIT $2`
      : `SELECT * FROM events ORDER BY timestamp DESC LIMIT $1`;

    const params = aggregateType ? [aggregateType, limit] : [limit];
    const result = await pool.query(query, params);

    return result.rows;
  }

  /**
   * Get event statistics
   */
  static async getStats(daysBack: number = 7): Promise<any[]> {
    const result = await pool.query(
      `SELECT * FROM get_event_stats($1)`,
      [daysBack]
    );

    return result.rows;
  }

  /**
   * Rebuild state from events (event replay)
   */
  static async rebuildDeviceState(deviceUuid: string): Promise<any> {
    const result = await pool.query(
      `SELECT rebuild_device_state($1) as state`,
      [deviceUuid]
    );

    return result.rows[0]?.state || {};
  }

  /**
   * Replay events within time window (for debugging)
   */
  static async replayEvents(
    deviceUuid: string,
    fromTime: Date,
    toTime: Date,
    handlers?: Record<string, (event: Event) => void>
  ): Promise<{
    events_replayed: number;
    final_state: any;
    errors: string[];
    events: Event[];
  }> {
    // Fetch all events in time window
    const result = await pool.query(
      `SELECT * FROM events 
       WHERE aggregate_id = $1 
         AND aggregate_type = 'agent'
         AND timestamp >= $2 
         AND timestamp <= $3
       ORDER BY timestamp ASC, id ASC`,
      [deviceUuid, fromTime, toTime]
    );

    const events = result.rows as Event[];
    const errors: string[] = [];
    let state: any = {
      target_state: {},
      current_state: {},
      containers: {},
      jobs: {},
    };

    // Replay events in chronological order
    for (const event of events) {
      try {
        // Call handler if registered
        if (handlers && handlers[event.event_type]) {
          handlers[event.event_type](event);
        }

        // Apply event to state reconstruction
        state = this.applyEventToState(state, event);
      } catch (error: any) {
        errors.push(`Event ${event.event_id} (${event.event_type}): ${error.message}`);
      }
    }

    return {
      events_replayed: events.length,
      final_state: state,
      errors,
      events,
    };
  }

  /**
   * Create snapshot of device state at specific point in time
   */
  static async createSnapshot(
    deviceUuid: string,
    atTime: Date
  ): Promise<SnapshotResult> {
    // Get all events up to this point in time
    const eventsResult = await pool.query(
      `SELECT * FROM events 
       WHERE aggregate_id = $1 
         AND aggregate_type = 'agent'
         AND timestamp <= $2
       ORDER BY timestamp ASC, id ASC`,
      [deviceUuid, atTime]
    );

    const events = eventsResult.rows as Event[];
    let state: any = {
      target_state: {},
      current_state: {},
      containers: {},
      jobs: {},
    };

    // Replay all events to reconstruct state
    for (const event of events) {
      state = this.applyEventToState(state, event);
    }

    const lastEvent = events[events.length - 1];

    return {
      timestamp: atTime,
      device_uuid: deviceUuid,
      target_state: state.target_state,
      current_state: state.current_state,
      containers: state.containers || {},
      jobs: state.jobs || {},
      online: state.online ?? null,
      last_seen: state.last_seen ?? null,
      offline_since: state.offline_since ?? null,
      event_count: events.length,
      last_event_id: lastEvent?.event_id,
      last_event_type: lastEvent?.event_type,
    };
  }

  /**
   * Compare device state between two points in time
   */
  static async compareStates(
    deviceUuid: string,
    time1: Date,
    time2: Date
  ): Promise<{
    time1_snapshot: any;
    time2_snapshot: any;
    changes: Array<{
      field: string;
      old_value: any;
      new_value: any;
      events_involved: string[];
    }>;
    events_between: Event[];
  }> {
    // Get snapshots at both times
    const [snapshot1, snapshot2] = await Promise.all([
      this.createSnapshot(deviceUuid, time1),
      this.createSnapshot(deviceUuid, time2),
    ]);

    // Get events between the two times
    const eventsResult = await pool.query(
      `SELECT * FROM events 
       WHERE aggregate_id = $1 
         AND aggregate_type = 'agent'
         AND timestamp > $2 
         AND timestamp <= $3
       ORDER BY timestamp ASC`,
      [deviceUuid, time1, time2]
    );

    const eventsBetween = eventsResult.rows as Event[];

    // Calculate differences
    const changes = this.calculateStateChanges(
      snapshot1.target_state,
      snapshot2.target_state,
      eventsBetween
    );

    return {
      time1_snapshot: snapshot1,
      time2_snapshot: snapshot2,
      changes,
      events_between: eventsBetween,
    };
  }

  /**
   * Apply an event to state (state reconstruction logic)
   */
  private static applyEventToState(state: any, event: Event): any {
    const newState = { ...state };

    switch (event.event_type) {
      case 'target_state.updated':
        newState.target_state = event.data.new_state || event.data.state || {};
        break;

      case 'current_state.updated':
        newState.current_state = event.data.state || {};
        break;

      case 'container.started':
      case 'container.created':
        if (event.data.container_id || event.data.container_name) {
          const containerId = event.data.container_id || event.data.container_name;
          newState.containers[containerId] = {
            state: 'running',
            started_at: event.timestamp,
            ...event.data,
          };
        }
        break;

      case 'container.stopped':
      case 'container.killed':
        if (event.data.container_id || event.data.container_name) {
          const containerId = event.data.container_id || event.data.container_name;
          if (newState.containers[containerId]) {
            newState.containers[containerId].state = 'stopped';
            newState.containers[containerId].stopped_at = event.timestamp;
          }
        }
        break;

      case 'container.paused':
        if (event.data.container_id || event.data.container_name) {
          const containerId = event.data.container_id || event.data.container_name;
          if (newState.containers[containerId]) {
            newState.containers[containerId].state = 'paused';
            newState.containers[containerId].paused_at = event.timestamp;
          }
        }
        break;

      case 'container.unpaused':
        if (event.data.container_id || event.data.container_name) {
          const containerId = event.data.container_id || event.data.container_name;
          if (newState.containers[containerId]) {
            newState.containers[containerId].state = 'running';
            newState.containers[containerId].unpaused_at = event.timestamp;
          }
        }
        break;

      case 'job.queued':
      case 'job.started':
      case 'job.completed':
      case 'job.failed':
      case 'job.cancelled':
      case 'job.timeout':
        if (event.data.job_id) {
          newState.jobs[event.data.job_id] = {
            ...newState.jobs[event.data.job_id],
            status: event.event_type.split('.')[1], // Extract status from event type
            last_updated: event.timestamp,
            ...event.data,
          };
        }
        break;

      case 'device.online':
        newState.online = true;
        newState.last_seen = event.timestamp;
        break;

      case 'device.offline':
        newState.online = false;
        newState.offline_since = event.timestamp;
        break;

      // Add more event types as needed
    }

    return newState;
  }

  /**
   * Calculate changes between two states
   */
  private static calculateStateChanges(
    oldState: any,
    newState: any,
    events: Event[]
  ): Array<{
    field: string;
    old_value: any;
    new_value: any;
    events_involved: string[];
  }> {
    const changes: Array<{
      field: string;
      old_value: any;
      new_value: any;
      events_involved: string[];
    }> = [];

    const allKeys = new Set([
      ...Object.keys(oldState || {}),
      ...Object.keys(newState || {}),
    ]);

    for (const key of allKeys) {
      const oldValue = oldState?.[key];
      const newValue = newState?.[key];

      // Deep comparison using JSON stringify
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        // Find events that might have caused this change
        const eventsInvolved = events
          .filter(e => {
            const dataStr = JSON.stringify(e.data);
            return dataStr.includes(key) || e.event_type.includes(key);
          })
          .map(e => `${e.event_type} (${e.event_id.substring(0, 8)})`);

        changes.push({
          field: key,
          old_value: oldValue,
          new_value: newValue,
          events_involved: eventsInvolved,
        });
      }
    }

    return changes;
  }
}

// ============================================================================
// EVENT LISTENER (Real-time event processing)
// ============================================================================

export class EventListener extends EventEmitter {
  private client: any;
  private isListening: boolean = false;

  /**
   * Start listening for events via PostgreSQL NOTIFY
   */
  async start(): Promise<void> {
    if (this.isListening) {
      return;
    }

    this.client = await pool.getClient();
    
    await this.client.query('LISTEN events');
    
    this.client.on('notification', (msg: any) => {
      if (msg.channel === 'events') {
        try {
          const payload = JSON.parse(msg.payload);
          this.emit('event', payload);
          this.emit(payload.event_type, payload);
        } catch (error) {
          console.error('Error parsing event notification:', error);
        }
      }
    });

    this.isListening = true;
    console.log('Event listener started');
  }

  /**
   * Stop listening
   */
  async stop(): Promise<void> {
    if (!this.isListening || !this.client) {
      return;
    }

    await this.client.query('UNLISTEN events');
    this.client.release();
    this.isListening = false;
    console.log('Event listener stopped');
  }

  /**
   * Subscribe to specific event types
   */
  onEventType(eventType: string, handler: (payload: any) => void): void {
    this.on(eventType, handler);
  }
}

// ============================================================================
// PROJECTION BUILDER
// ============================================================================

export class ProjectionBuilder {
  private handlers: Map<string, ProjectionHandler> = new Map();
  private cursorName: string;

  constructor(cursorName: string) {
    this.cursorName = cursorName;
  }

  /**
   * Register event handler for projection
   */
  on(eventType: string, handler: ProjectionHandler): void {
    this.handlers.set(eventType, handler);
  }

  /**
   * Process events and build projection
   */
  async process(batchSize: number = 100): Promise<number> {
    // Get last processed event ID
    const cursorResult = await pool.query(
      `SELECT last_event_id FROM event_cursors WHERE processor_name = $1`,
      [this.cursorName]
    );

    const lastEventId = cursorResult.rows[0]?.last_event_id || 0;

    // Get next batch of events
    const eventsResult = await pool.query(
      `SELECT * FROM events 
       WHERE id > $1 
       ORDER BY id ASC 
       LIMIT $2`,
      [lastEventId, batchSize]
    );

    const events = eventsResult.rows;

    if (events.length === 0) {
      return 0;
    }

    // Process events
    let processed = 0;
    for (const event of events) {
      const handler = this.handlers.get(event.event_type);
      if (handler) {
        try {
          // Get current projection state
          const stateResult = await pool.query(
            `SELECT * FROM state_projections WHERE device_uuid = $1`,
            [event.aggregate_id]
          );

          const currentState = stateResult.rows[0] || {};

          // Apply event to state
          await handler(event, currentState);

          processed++;
        } catch (error) {
          console.error(`Error processing event ${event.id}:`, error);
        }
      }

      // Update cursor
      await pool.query(
        `INSERT INTO event_cursors (processor_name, last_event_id)
         VALUES ($1, $2)
         ON CONFLICT (processor_name) 
         DO UPDATE SET last_event_id = $2, last_processed_at = NOW()`,
        [this.cursorName, event.id]
      );
    }

    return processed;
  }

  /**
   * Reset projection (rebuild from scratch)
   */
  async reset(): Promise<void> {
    await pool.query(
      `DELETE FROM event_cursors WHERE processor_name = $1`,
      [this.cursorName]
    );
  }
}

// ============================================================================
// EXAMPLE USAGE & HELPERS
// ============================================================================

/**
 * Helper: Publish target state change
 */
export async function publishTargetStateChange(
  deviceUuid: string,
  oldState: any,
  newState: any,
  source: string = 'api',
  metadata?: any
): Promise<string> {
  const publisher = new EventPublisher(source);

  return publisher.publish(
    'target_state.updated',
    'agent',
    deviceUuid,
    {
      old_state: oldState,
      new_state: newState,
      changed_fields: calculateChangedFields(oldState, newState),
    },
    { metadata }
  );
}

/**
 * Helper: Publish current state change
 */
export async function publishCurrentStateChange(
  deviceUuid: string,
  newState: any,
  source: string = 'supervisor'
): Promise<string> {
  const publisher = new EventPublisher(source);

  return publisher.publish(
    'current_state.updated',
    'agent',
    deviceUuid,
    { state: newState }
  );
}

/**
 * Helper: Publish reconciliation events
 */
export async function publishReconciliationCycle(
  deviceUuid: string,
  diff: any,
  actionsResult: any
): Promise<string[]> {
  const publisher = new EventPublisher('supervisor');

  const startEventId = await publisher.publish(
    'reconciliation.started',
    'agent',
    deviceUuid,
    { diff }
  );

  // Publish individual action events
  const actionEventIds: string[] = [];
  for (const action of actionsResult.actions || []) {
    const eventId = await publisher.publish(
      `container.${action.type}`,
      'app',
      action.app_name,
      action.details,
      { causationId: startEventId }
    );
    actionEventIds.push(eventId);
  }

  const completedEventId = await publisher.publish(
    'reconciliation.completed',
    'agent',
    deviceUuid,
    {
      actions_count: actionEventIds.length,
      success: actionsResult.success,
      duration_ms: actionsResult.duration_ms,
    },
    { causationId: startEventId }
  );

  return [startEventId, ...actionEventIds, completedEventId];
}

/**
 * Helper: Calculate hash of an object for comparison
 */
function calculateObjectHash(obj: any): string {
  if (obj === null || obj === undefined) {
    return '';
  }
  
  // Stringify with sorted keys for consistent hashing
  const normalized = JSON.stringify(obj, Object.keys(obj).sort());
  
  return crypto.createHash('sha256')
    .update(normalized)
    .digest('hex');
}

/**
 * Helper: Calculate changed fields between two objects (using hash comparison)
 */
function calculateChangedFields(oldObj: any, newObj: any): string[] {
  const changed: string[] = [];

  const allKeys = new Set([
    ...Object.keys(oldObj || {}),
    ...Object.keys(newObj || {}),
  ]);

  for (const key of allKeys) {
    const oldHash = calculateObjectHash(oldObj?.[key]);
    const newHash = calculateObjectHash(newObj?.[key]);
    
    if (oldHash !== newHash) {
      changed.push(key);
    }
  }

  return changed;
}

/**
 * Helper: Check if two objects are equal using hash comparison
 */
export function objectsAreEqual(obj1: any, obj2: any): boolean {
  return calculateObjectHash(obj1) === calculateObjectHash(obj2);
}

// ============================================================================
// EVENT SEARCH & AGGREGATION
// ============================================================================

export interface EventSearchCriteria {
  deviceUuid?: string;
  eventTypes?: string[];
  aggregateTypes?: string[];
  dateFrom?: Date;
  dateTo?: Date;
  severity?: string[];
  actor?: { type: string; id?: string };
  tags?: Record<string, string>;
  correlationId?: string;
  limit?: number;
  offset?: number;
}

export interface EventAggregation {
  period_start: Date;
  event_type: string;
  count: number;
}

export interface DeviceEventSummary {
  total_events: number;
  event_type_breakdown: Record<string, number>;
  critical_events: number;
  last_activity: Date | null;
  health_score: number;
}

/**
 * Advanced event search with filtering
 */
export async function searchEvents(criteria: EventSearchCriteria): Promise<Event[]> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramCounter = 1;

  if (criteria.deviceUuid) {
    conditions.push(`aggregate_id = $${paramCounter++}`);
    params.push(criteria.deviceUuid);
  }

  if (criteria.eventTypes && criteria.eventTypes.length > 0) {
    conditions.push(`event_type = ANY($${paramCounter++})`);
    params.push(criteria.eventTypes);
  }

  if (criteria.aggregateTypes && criteria.aggregateTypes.length > 0) {
    conditions.push(`aggregate_type = ANY($${paramCounter++})`);
    params.push(criteria.aggregateTypes);
  }

  if (criteria.dateFrom) {
    conditions.push(`timestamp >= $${paramCounter++}`);
    params.push(criteria.dateFrom);
  }

  if (criteria.dateTo) {
    conditions.push(`timestamp <= $${paramCounter++}`);
    params.push(criteria.dateTo);
  }

  if (criteria.severity && criteria.severity.length > 0) {
    conditions.push(`severity = ANY($${paramCounter++})`);
    params.push(criteria.severity);
  }

  if (criteria.actor?.type) {
    conditions.push(`actor_type = $${paramCounter++}`);
    params.push(criteria.actor.type);
    
    if (criteria.actor.id) {
      conditions.push(`actor_id = $${paramCounter++}`);
      params.push(criteria.actor.id);
    }
  }

  if (criteria.correlationId) {
    conditions.push(`correlation_id = $${paramCounter++}`);
    params.push(criteria.correlationId);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = criteria.limit || 100;
  const offset = criteria.offset || 0;

  const query = `
    SELECT 
      event_id, event_type, event_version, timestamp, 
      aggregate_type, aggregate_id, data, metadata,
      correlation_id, causation_id, source, checksum,
      actor_type, actor_id, severity, impact
    FROM events
    ${whereClause}
    ORDER BY timestamp DESC
    LIMIT $${paramCounter++} OFFSET $${paramCounter++}
  `;

  params.push(limit, offset);

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Get event timeline for device (all events chronologically)
 */
export async function getDeviceTimeline(
  deviceUuid: string,
  options: {
    sinceDate?: Date;
    eventTypes?: string[];
    includeSampled?: boolean;
    limit?: number;
  } = {}
): Promise<Event[]> {
  const conditions: string[] = ['aggregate_id = $1'];
  const params: any[] = [deviceUuid];
  let paramCounter = 2;

  if (options.sinceDate) {
    conditions.push(`timestamp >= $${paramCounter++}`);
    params.push(options.sinceDate);
  }

  if (options.eventTypes && options.eventTypes.length > 0) {
    conditions.push(`event_type = ANY($${paramCounter++})`);
    params.push(options.eventTypes);
  }

  if (!options.includeSampled) {
    // Exclude high-frequency debug events
    conditions.push(`severity NOT IN ('debug')`);
  }

  const limit = options.limit || 1000;

  const query = `
    SELECT 
      e.event_id, e.event_type, e.event_version, e.timestamp,
      e.aggregate_type, e.aggregate_id, e.data, e.metadata,
      e.correlation_id, e.causation_id, e.source, e.checksum,
      e.actor_type, e.actor_id, e.severity, e.impact,
      et.description as event_description
    FROM events e
    LEFT JOIN event_types et ON e.event_type = et.event_type
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.timestamp DESC
    LIMIT $${paramCounter}
  `;

  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Aggregate events by time period
 */
export async function aggregateByPeriod(
  deviceUuid: string,
  period: 'hour' | 'day' | 'week' | 'month',
  dateFrom: Date,
  dateTo: Date
): Promise<EventAggregation[]> {
  const truncFunc = {
    hour: 'hour',
    day: 'day',
    week: 'week',
    month: 'month'
  }[period];

  const query = `
    SELECT 
      DATE_TRUNC($1, timestamp) as period_start,
      event_type,
      COUNT(*) as count
    FROM events
    WHERE aggregate_id = $2
      AND timestamp >= $3
      AND timestamp <= $4
    GROUP BY DATE_TRUNC($1, timestamp), event_type
    ORDER BY period_start DESC, count DESC
  `;

  const result = await pool.query(query, [truncFunc, deviceUuid, dateFrom, dateTo]);
  return result.rows.map(row => ({
    period_start: row.period_start,
    event_type: row.event_type,
    count: parseInt(row.count, 10)
  }));
}

/**
 * Get event summary for device
 */
export async function getDeviceSummary(
  deviceUuid: string,
  daysBack: number = 30
): Promise<DeviceEventSummary> {
  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - daysBack);

  // Get total events and breakdown
  const summaryQuery = `
    SELECT 
      COUNT(*) as total_events,
      COUNT(*) FILTER (WHERE severity IN ('error', 'critical')) as critical_events,
      MAX(timestamp) as last_activity,
      jsonb_object_agg(event_type, event_count) as event_type_breakdown
    FROM (
      SELECT 
        event_type,
        COUNT(*) as event_count,
        MAX(timestamp) as timestamp,
        MAX(severity) as severity
      FROM events
      WHERE aggregate_id = $1
        AND timestamp >= $2
      GROUP BY event_type
    ) sub
  `;

  const result = await pool.query(summaryQuery, [deviceUuid, dateFrom]);
  const row = result.rows[0];

  // Calculate health score (0-100)
  // Based on: ratio of error events, recency of activity, variety of events
  const totalEvents = parseInt(row.total_events || '0', 10);
  const criticalEvents = parseInt(row.critical_events || '0', 10);
  const errorRatio = totalEvents > 0 ? criticalEvents / totalEvents : 0;
  
  let healthScore = 100;
  healthScore -= errorRatio * 50; // Up to -50 for errors
  
  if (row.last_activity) {
    const hoursSinceActivity = (Date.now() - new Date(row.last_activity).getTime()) / (1000 * 60 * 60);
    if (hoursSinceActivity > 24) {
      healthScore -= Math.min(30, hoursSinceActivity / 2); // Up to -30 for inactivity
    }
  } else {
    healthScore -= 50; // No activity at all
  }

  healthScore = Math.max(0, Math.min(100, healthScore));

  return {
    total_events: totalEvents,
    event_type_breakdown: row.event_type_breakdown || {},
    critical_events: criticalEvents,
    last_activity: row.last_activity || null,
    health_score: Math.round(healthScore)
  };
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  EventPublisher,
  EventStore,
  EventListener,
  ProjectionBuilder,
  publishTargetStateChange,
  publishCurrentStateChange,
  publishReconciliationCycle,
  searchEvents,
  getDeviceTimeline,
  aggregateByPeriod,
  getDeviceSummary,
};
