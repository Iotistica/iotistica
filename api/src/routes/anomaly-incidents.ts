/**
 * Anomaly Incidents API Routes
 *
 * Endpoints for querying, viewing, and managing anomaly incidents (correlated anomaly events)
 * from the edge AI anomaly detection system.
 */

import { Router } from 'express';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

const router = Router();

// Apply JWT auth only to /anomaly-incidents routes (path-specific to avoid intercepting other routes)
router.use('/anomaly-incidents', jwtAuth);

interface IncidentFilters {
  status?: 'open' | 'active' | 'resolved';
  severity?: 'info' | 'warning' | 'critical';
  deviceName?: string;
  deviceUuid?: string;
  deviceType?: string;
  deviceState?: 'running' | 'idle' | 'fault' | 'unknown';
  metric?: string;
  startTime?: number;
  endTime?: number;
  limit: number;
  offset: number;
}

const ENDPOINT_METRIC_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(.+)$/i;

async function resolveEndpointDisplayName(
  agentUuid: string | undefined,
  endpointUuid: string,
  cache: Map<string, string>
): Promise<string | undefined> {
  if (!agentUuid) return undefined;

  const cacheKey = `${agentUuid}:${endpointUuid}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    return cached || undefined;
  }

  const result = await query(
    `SELECT name
     FROM endpoints
     WHERE agent_uuid = $1 AND uuid::text = $2 AND deployment_status != 'deleted'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [agentUuid, endpointUuid]
  );

  const endpointName = result.rows[0]?.name || '';
  cache.set(cacheKey, endpointName);
  return endpointName || undefined;
}

async function resolveDisplayFields(params: {
  deviceType: string;
  deviceName: string;
  metric: string;
  affectedAgents?: string[];
  agentUuid?: string;
  cache: Map<string, string>;
}): Promise<{ deviceName: string; metric: string }> {
  const { deviceType, deviceName, metric, affectedAgents, agentUuid, cache } = params;

  if (deviceType === 'system') {
    return { deviceName, metric };
  }

  const match = metric.match(ENDPOINT_METRIC_REGEX);
  if (!match) {
    return { deviceName, metric }; 
  }

  const [, endpointUuid, metricSuffix] = match;
  const resolvedEndpointName = await resolveEndpointDisplayName(
    agentUuid || affectedAgents?.find((value) => typeof value === 'string' && value.length > 0),
    endpointUuid,
    cache
  );

  return {
    deviceName: resolvedEndpointName || deviceName,
    metric: metricSuffix,
  };
}

/**
 * GET /api/v1/anomaly-incidents
 *
 * List anomaly incidents with filters and pagination
 *
 * Query params:
 * - status: 'open' | 'active' | 'resolved' (optional)
 * - severity: 'info' | 'warning' | 'critical' (optional)
 * - deviceName: Filter by monitored device name (optional)
 * - deviceType: Filter by device type (optional, modbus|opcua|bacnet|mqtt|system)
 * - metric: Filter by metric name (optional)
 * - startTime: Start time in milliseconds (optional)
 * - endTime: End time in milliseconds (optional)
 * - limit: Max results (default 50)
 * - offset: Pagination offset (default 0)
 */
router.get('/anomaly-incidents', async (req, res) => {
  try {
    const { status, severity, deviceName, deviceUuid, deviceType, deviceState, metric, startTime, endTime, limit = 50, offset = 0 } = req.query;

    const filters: IncidentFilters = {
      status: status as 'open' | 'active' | 'resolved' | undefined,
      severity: severity as 'info' | 'warning' | 'critical' | undefined,
      deviceName: deviceName as string | undefined,
      deviceUuid: deviceUuid as string | undefined,
      deviceType: deviceType as string | undefined,
      deviceState: deviceState as 'running' | 'idle' | 'fault' | 'unknown' | undefined,
      metric: metric as string | undefined,
      startTime: startTime ? parseInt(startTime as string) : undefined,
      endTime: endTime ? parseInt(endTime as string) : undefined,
      limit: Math.min(parseInt(limit as string) || 50, 500), // Cap at 500
      offset: parseInt(offset as string) || 0,
    };

    // Build WHERE clause
    let whereConditions: string[] = ['1=1'];
    const queryParams: any[] = [];

    if (filters.status) {
      whereConditions.push(`ai.status = $${queryParams.length + 1}`);
      queryParams.push(filters.status);
    }

    if (filters.severity) {
      whereConditions.push(`ai.severity = $${queryParams.length + 1}`);
      queryParams.push(filters.severity);
    }

    if (filters.deviceName) {
      whereConditions.push(`ai.device_name = $${queryParams.length + 1}`);
      queryParams.push(filters.deviceName);
    }

    if (filters.deviceUuid) {
      whereConditions.push(`ai.agent_uuid = $${queryParams.length + 1}`);
      queryParams.push(filters.deviceUuid);
    }

    if (filters.deviceType) {
      whereConditions.push(`ai.device_type = $${queryParams.length + 1}`);
      queryParams.push(filters.deviceType);
    }

    if (filters.deviceState) {
      whereConditions.push(`COALESCE((
        SELECT ae.baseline->>'deviceState'
        FROM anomaly_events ae
        WHERE ae.fingerprint = ai.fingerprint
        ORDER BY ae.timestamp_ms DESC
        LIMIT 1
      ), 'unknown') = $${queryParams.length + 1}`);
      queryParams.push(filters.deviceState);
    }

    if (filters.metric) {
      whereConditions.push(`ai.metric = $${queryParams.length + 1}`);
      queryParams.push(filters.metric);
    }

    if (filters.startTime !== undefined) {
      whereConditions.push(`ai.first_seen >= $${queryParams.length + 1}`);
      queryParams.push(filters.startTime);
    }

    if (filters.endTime !== undefined) {
      whereConditions.push(`ai.last_seen <= $${queryParams.length + 1}`);
      queryParams.push(filters.endTime);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total FROM anomaly_incidents ai
      WHERE ${whereClause}
    `;
    const countResult = await query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0]?.total || 0);

    // Get incidents with pagination
    const incidentsQuery = `
      SELECT
        ai.incident_id,
        ai.fingerprint,
        ai.device_name,
        ai.agent_uuid,
        ai.device_type,
        COALESCE((
          SELECT ae.baseline->>'deviceState'
          FROM anomaly_events ae
          WHERE ae.fingerprint = ai.fingerprint
          ORDER BY ae.timestamp_ms DESC
          LIMIT 1
        ), 'unknown') AS device_state,
        ai.metric,
        ai.severity,
        ai.affected_agents,
        ai.affected_agents,
        ai.first_seen,
        ai.last_seen,
        ai.max_anomaly_score,
        ai.max_confidence,
        ai.event_count,
        ai.status,
        ai.acknowledged_at,
        ai.acknowledged_by,
        ai.resolution_notes,
        ai.created_at,
        ai.updated_at
      FROM anomaly_incidents ai
      WHERE ${whereClause}
      ORDER BY ai.first_seen DESC
      LIMIT $${queryParams.length + 1}
      OFFSET $${queryParams.length + 2}
    `;

    queryParams.push(filters.limit);
    queryParams.push(filters.offset);

    const incidentsResult = await query(incidentsQuery, queryParams);
    const incidents = incidentsResult.rows;
    const endpointNameCache = new Map<string, string>();

    const mappedIncidents = await Promise.all(incidents.map(async (inc: any) => {
      const display = await resolveDisplayFields({
        deviceType: inc.device_type,
        deviceName: inc.device_name,
        metric: inc.metric,
        affectedAgents: inc.affected_agents || [],
        cache: endpointNameCache,
      });

      return {
        incident_id: inc.incident_id,
        fingerprint: inc.fingerprint,
        device_name: display.deviceName,
        agent_uuid: inc.agent_uuid || null,
        device_type: inc.device_type,
        device_state: inc.device_state || 'unknown',
        metric: display.metric,
        severity: inc.severity,
        affected_agents: inc.affected_agents || [],
        first_seen: parseInt(inc.first_seen),
        last_seen: parseInt(inc.last_seen),
        max_anomaly_score: parseFloat(inc.max_anomaly_score),
        max_confidence: parseFloat(inc.max_confidence),
        event_count: parseInt(inc.event_count),
        status: inc.status,
        acknowledged_at: inc.acknowledged_at,
        acknowledged_by: inc.acknowledged_by,
        resolution_notes: inc.resolution_notes,
        created_at: inc.created_at,
        updated_at: inc.updated_at,
      };
    }));

    res.json({
      success: true,
      incidents: mappedIncidents,
      total,
      hasMore: (filters.offset + filters.limit) < total,
    });
  } catch (error) {
    logger.error('Failed to get anomaly incidents', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve anomaly incidents',
    });
  }
});

/**
 * GET /api/v1/anomaly-incidents/stats
 *
 * Get incident statistics
 *
 * Query params:
 * - hours: Time window in hours (default 24)
 */
router.get('/anomaly-incidents/stats', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const timeWindowMs = hours * 60 * 60 * 1000;
    const startTime = Date.now() - timeWindowMs;

    const statsQuery = `
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE status = 'open') as open_count,
        COUNT(*) FILTER (WHERE status = 'active') as active_count,
        COUNT(*) FILTER (WHERE status = 'resolved') as resolved_count,
        COUNT(*) FILTER (WHERE severity = 'info') as info_count,
        COUNT(*) FILTER (WHERE severity = 'warning') as warning_count,
        COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
        COUNT(DISTINCT device_name) as affected_agents,
        COUNT(DISTINCT agent_uuid) as affected_endpoints
      FROM anomaly_incidents
      WHERE first_seen >= $1
    `;

    const result = await query(statsQuery, [startTime]);
    const stats = result.rows[0];

    // Get top metrics
    const topMetricsQuery = `
      SELECT
        metric,
        COUNT(*) as count
      FROM anomaly_incidents
      WHERE first_seen >= $1
      GROUP BY metric
      ORDER BY count DESC
      LIMIT 10
    `;

    const metricsResult = await query(topMetricsQuery, [startTime]);
    const topMetrics = metricsResult.rows;

    // Get top affected agents
    const topDevicesQuery = `
      SELECT
        device_name,
        agent_uuid,
        COUNT(*) as count
      FROM anomaly_incidents
      WHERE first_seen >= $1
      GROUP BY device_name, agent_uuid
      ORDER BY count DESC
      LIMIT 10
    `;

    const agentsResult = await query(topDevicesQuery, [startTime]);
    const topDevices = agentsResult.rows;

    res.json({
      success: true,
      stats: {
        total: parseInt(stats.total),
        byStatus: {
          open: parseInt(stats.open_count),
          active: parseInt(stats.active_count),
          resolved: parseInt(stats.resolved_count),
        },
        bySeverity: {
          info: parseInt(stats.info_count),
          warning: parseInt(stats.warning_count),
          critical: parseInt(stats.critical_count),
        },
        affectedDevices: parseInt(stats.affected_agents),
        affectedEndpoints: parseInt(stats.affected_endpoints),
        topMetrics: topMetrics.map((m: any) => ({
          metric: m.metric,
          count: parseInt(m.count),
        })),
        topDevices: topDevices.map((d: any) => ({
          deviceName: d.device_name,
          deviceUuid: d.agent_uuid || null,
          count: parseInt(d.count),
        })),
      },
    });
  } catch (error) {
    logger.error('Failed to get anomaly incident stats', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve incident statistics',
    });
  }
});

/**
 * GET /api/v1/anomaly-incidents/:incidentId
 *
 * Get single incident with full details including related events and alerts
 */
router.get('/anomaly-incidents/:incidentId', async (req, res) => {
  try {
    const { incidentId } = req.params;

    // Get incident
    const incidentQuery = `
      SELECT
        incident_id,
        fingerprint,
        device_name,
        agent_uuid,
        device_type,
        COALESCE((
          SELECT ae.baseline->>'deviceState'
          FROM anomaly_events ae
          WHERE ae.fingerprint = anomaly_incidents.fingerprint
          ORDER BY ae.timestamp_ms DESC
          LIMIT 1
        ), 'unknown') AS device_state,
        metric,
        severity,
        affected_devices,
        affected_agents,
        first_seen,
        last_seen,
        max_anomaly_score,
        max_confidence,
        event_count,
        status,
        acknowledged_at,
        acknowledged_by,
        resolution_notes,
        created_at,
        updated_at
      FROM anomaly_incidents
      WHERE incident_id = $1
    `;

    const incidentResult = await query(incidentQuery, [incidentId]);
    const incident = incidentResult.rows[0];

    if (!incident) {
      return res.status(404).json({
        success: false,
        error: 'Incident not found',
      });
    }

    // Get related events
    const eventsQuery = `
      SELECT
        msg_id,
        agent_uuid,
        device_name,
        device_type,
        metric,
        timestamp_ms,
        observed_value,
        baseline,
        anomaly_score,
        confidence,
        severity,
        deviation,
        triggered_by,
        expected_range
      FROM anomaly_events
      WHERE fingerprint = $1
      ORDER BY timestamp_ms DESC
      LIMIT 100
    `;

    const eventsResult = await query(eventsQuery, [incident.fingerprint]);
    const events = eventsResult.rows;

    // Get related alerts
    const alertsQuery = `
      SELECT
        alert_id,
        severity,
        device_name,
        device_uuid,
        metric,
        affected_devices,
        max_anomaly_score,
        message,
        created_at
      FROM anomaly_alerts
      WHERE incident_id = $1
      ORDER BY created_at DESC
    `;

    const alertsResult = await query(alertsQuery, [incidentId]);
    const alerts = alertsResult.rows;
    const endpointNameCache = new Map<string, string>();

    // Extract agent_uuid from the incident record (populated during event ingestion)
    const affectedAgents = incident.affected_agents || [];
    const deviceUuid = incident.agent_uuid || null;

    const incidentDisplay = await resolveDisplayFields({
      deviceType: incident.device_type,
      deviceName: incident.device_name,
      metric: incident.metric,
      affectedAgents,
      cache: endpointNameCache,
    });

    const mappedEvents = await Promise.all(events.map(async (e: any) => {
      const eventDisplay = await resolveDisplayFields({
        deviceType: e.device_type,
        deviceName: e.device_name,
        metric: e.metric,
        agentUuid: e.agent_uuid,
        cache: endpointNameCache,
      });

      return {
        msg_id: e.msg_id,
        agent_uuid: e.agent_uuid,
        device_name: eventDisplay.deviceName,
        device_type: e.device_type,
        device_state: (e.baseline && typeof e.baseline === 'object' && e.baseline.deviceState) ? e.baseline.deviceState : 'unknown',
        metric: eventDisplay.metric,
        timestamp_ms: parseInt(e.timestamp_ms),
        observed_value: parseFloat(e.observed_value),
        baseline: e.baseline,
        anomaly_score: parseFloat(e.anomaly_score),
        confidence: parseFloat(e.confidence),
        severity: e.severity,
        deviation: parseFloat(e.deviation),
        triggered_by: e.triggered_by,
        expected_range: e.expected_range,
      };
    }));

    res.json({
      success: true,
      incident: {
        incident_id: incident.incident_id,
        fingerprint: incident.fingerprint,
        device_name: incidentDisplay.deviceName,
        agent_uuid: deviceUuid,
        device_type: incident.device_type,
        device_state: incident.device_state || 'unknown',
        metric: incidentDisplay.metric,
        severity: incident.severity,
        affected_agents: incident.affected_agents || [],
        first_seen: parseInt(incident.first_seen),
        last_seen: parseInt(incident.last_seen),
        max_anomaly_score: parseFloat(incident.max_anomaly_score),
        max_confidence: parseFloat(incident.max_confidence),
        event_count: parseInt(incident.event_count),
        status: incident.status,
        acknowledged_at: incident.acknowledged_at,
        acknowledged_by: incident.acknowledged_by,
        resolution_notes: incident.resolution_notes,
        created_at: incident.created_at,
        updated_at: incident.updated_at,
      },
      events: mappedEvents,
      alerts: alerts.map((a: any) => ({
        alert_id: a.alert_id,
        severity: a.severity,
        device_name: a.device_name,
        device_uuid: a.device_uuid || null,
        metric: a.metric,
        affected_agents: a.affected_devices || [],
        max_anomaly_score: parseFloat(a.max_anomaly_score),
        message: a.message,
        created_at: a.created_at,
      })),
    });
  } catch (error) {
    logger.error('Failed to get incident details', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve incident details',
    });
  }
});

/**
 * PATCH /api/v1/anomaly-incidents/:incidentId/resolve
 *
 * Mark incident as resolved with optional notes
 *
 * Body:
 * {
 *   resolvedBy: string (username or user ID),
 *   notes: string (optional)
 * }
 */
router.patch('/anomaly-incidents/:incidentId/resolve', async (req, res) => {
  try {
    const { incidentId } = req.params;
    const { resolvedBy, notes } = req.body;

    if (!resolvedBy) {
      return res.status(400).json({
        success: false,
        error: 'resolvedBy is required',
      });
    }

    const updateQuery = `
      UPDATE anomaly_incidents
      SET
        status = 'resolved',
        acknowledged_at = NOW(),
        acknowledged_by = $1,
        resolution_notes = $2,
        updated_at = NOW()
      WHERE incident_id = $3
      RETURNING
        incident_id,
        fingerprint,
        device_name,
        agent_uuid,
        device_type,
        metric,
        severity,
        affected_agents,
        affected_agents,
        first_seen,
        last_seen,
        max_anomaly_score,
        max_confidence,
        event_count,
        status,
        acknowledged_at,
        acknowledged_by,
        resolution_notes,
        created_at,
        updated_at
    `;

    const result = await query(updateQuery, [resolvedBy, notes || null, incidentId]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Incident not found',
      });
    }

    const incident = result.rows[0];

    // Clear Redis cache to prevent reopening
    try {
      const { redisClient } = await import('../redis/client');
      await redisClient.connect();
      const redis = redisClient.getClient();
      if (redis) {
        const incidentKey = `incident:${incident.fingerprint}`;
        await redis.del(incidentKey);
        logger.info('Cleared Redis cache for resolved incident', {
          incidentId,
          fingerprint: incident.fingerprint,
        });
      }
    } catch (redisError) {
      logger.warn('Failed to clear Redis cache on resolution', {
        incidentId,
        error: redisError instanceof Error ? redisError.message : String(redisError),
      });
      // Don't fail resolution if Redis cleanup fails
    }

    logger.info(`Incident ${incidentId} resolved by ${resolvedBy}`, {
      incidentId,
      resolvedBy,
      notes,
    });

    res.json({
      success: true,
      incident: {
        incident_id: incident.incident_id,
        fingerprint: incident.fingerprint,
        device_name: incident.device_name,
        agent_uuid: incident.agent_uuid || null,
        device_type: incident.device_type,
        metric: incident.metric,
        severity: incident.severity,
        affected_agents: incident.affected_agents || [],
        first_seen: incident.first_seen,
        last_seen: incident.last_seen,
        max_anomaly_score: parseFloat(incident.max_anomaly_score),
        max_confidence: parseFloat(incident.max_confidence),
        event_count: parseInt(incident.event_count),
        status: incident.status,
        acknowledged_at: incident.acknowledged_at,
        acknowledged_by: incident.acknowledged_by,
        resolution_notes: incident.resolution_notes,
        created_at: incident.created_at,
        updated_at: incident.updated_at,
      },
    });
  } catch (error) {
    logger.error('Failed to resolve incident', error);
    res.status(500).json({
      success: false,
      error: 'Failed to resolve incident',
    });
  }
});

export default router;
