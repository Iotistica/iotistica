/**
 * Anomaly Incidents API Routes
 *
 * Endpoints for querying, viewing, and managing anomaly incidents (correlated anomaly events)
 * from the edge AI anomaly detection system.
 */
import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

type IncidentStatus = 'open' | 'active' | 'resolved';
type IncidentSeverity = 'info' | 'warning' | 'critical';
type DeviceState = 'running' | 'idle' | 'fault' | 'unknown';

interface IncidentFilters {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  deviceName?: string;
  deviceUuid?: string;
  deviceType?: string;
  deviceState?: DeviceState;
  metric?: string;
  startTime?: number;
  endTime?: number;
  limit: number;
  offset: number;
}

type IncidentListQuerystring = {
  status?: IncidentStatus;
  severity?: IncidentSeverity;
  deviceName?: string;
  deviceUuid?: string;
  deviceType?: string;
  deviceState?: DeviceState;
  metric?: string;
  startTime?: string | number;
  endTime?: string | number;
  limit?: string | number;
  offset?: string | number;
};

type StatsQuerystring = {
  hours?: string | number;
};

type IncidentIdParams = {
  incidentId: string;
};

type ResolveIncidentBody = {
  resolvedBy?: string;
  notes?: string;
};

type CountRow = {
  total: string | number;
};

type IncidentRow = {
  incident_id: string;
  fingerprint: string;
  device_name: string;
  agent_uuid: string | null;
  device_type: string;
  device_state?: string | null;
  metric: string;
  severity: string;
  affected_agents: string[] | null;
  first_seen: string | number;
  last_seen: string | number;
  max_anomaly_score: string | number;
  max_confidence: string | number;
  event_count: string | number;
  status: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
};

type StatsRow = {
  total: string | number;
  open_count: string | number;
  active_count: string | number;
  resolved_count: string | number;
  info_count: string | number;
  warning_count: string | number;
  critical_count: string | number;
  affected_agents: string | number;
  affected_endpoints: string | number;
};

type TopMetricRow = {
  metric: string;
  count: string | number;
};

type TopDeviceRow = {
  device_name: string;
  agent_uuid: string | null;
  count: string | number;
};

type EventBaseline = {
  deviceState?: string;
  [key: string]: unknown;
};

type EventRow = {
  msg_id: string;
  agent_uuid: string | null;
  device_name: string;
  device_type: string;
  metric: string;
  timestamp_ms: string | number;
  observed_value: string | number;
  baseline: EventBaseline | null;
  anomaly_score: string | number;
  confidence: string | number;
  severity: string;
  deviation: string | number;
  triggered_by: string | null;
  expected_range: unknown;
};

type AlertRow = {
  alert_id: string;
  severity: string;
  device_name: string;
  device_uuid: string | null;
  metric: string;
  affected_devices: string[] | null;
  max_anomaly_score: string | number;
  message: string;
  created_at: string;
};

const ENDPOINT_METRIC_REGEX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(.+)$/i;

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

async function resolveEndpointDisplayName(
  agentUuid: string | undefined,
  endpointUuid: string,
  cache: Map<string, string>
): Promise<string | undefined> {
  if (!agentUuid) {
    return undefined;
  }

  const cacheKey = `${agentUuid}:${endpointUuid}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    return cached || undefined;
  }

  const result = await query<{ name: string }>(
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

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.addHook('preHandler', jwtAuth);

  fastify.get<{ Querystring: IncidentListQuerystring }>('/anomaly-incidents', async (req, reply) => {
    try {
      const { status, severity, deviceName, deviceUuid, deviceType, deviceState, metric, startTime, endTime, limit = 50, offset = 0 } = req.query;

      const filters: IncidentFilters = {
        status,
        severity,
        deviceName,
        deviceUuid,
        deviceType,
        deviceState,
        metric,
        startTime: startTime !== undefined ? parseNumericQuery(startTime, 0) : undefined,
        endTime: endTime !== undefined ? parseNumericQuery(endTime, 0) : undefined,
        limit: Math.min(parseNumericQuery(limit, 50), 500),
        offset: parseNumericQuery(offset, 0),
      };

      const whereConditions: string[] = ['1=1'];
      const queryParams: Array<string | number> = [];

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

      const countQuery = `
        SELECT COUNT(*) as total FROM anomaly_incidents ai
        WHERE ${whereClause}
      `;
      const countResult = await query<CountRow>(countQuery, queryParams);
      const total = Number.parseInt(String(countResult.rows[0]?.total ?? 0), 10);

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

      const incidentsResult = await query<IncidentRow>(incidentsQuery, queryParams);
      const endpointNameCache = new Map<string, string>();

      const mappedIncidents = await Promise.all(incidentsResult.rows.map(async (incident) => {
        const display = await resolveDisplayFields({
          deviceType: incident.device_type,
          deviceName: incident.device_name,
          metric: incident.metric,
          affectedAgents: incident.affected_agents || [],
          cache: endpointNameCache,
        });

        return {
          incident_id: incident.incident_id,
          fingerprint: incident.fingerprint,
          device_name: display.deviceName,
          agent_uuid: incident.agent_uuid || null,
          device_type: incident.device_type,
          device_state: incident.device_state || 'unknown',
          metric: display.metric,
          severity: incident.severity,
          affected_agents: incident.affected_agents || [],
          first_seen: Number.parseInt(String(incident.first_seen), 10),
          last_seen: Number.parseInt(String(incident.last_seen), 10),
          max_anomaly_score: Number.parseFloat(String(incident.max_anomaly_score)),
          max_confidence: Number.parseFloat(String(incident.max_confidence)),
          event_count: Number.parseInt(String(incident.event_count), 10),
          status: incident.status,
          acknowledged_at: incident.acknowledged_at,
          acknowledged_by: incident.acknowledged_by,
          resolution_notes: incident.resolution_notes,
          created_at: incident.created_at,
          updated_at: incident.updated_at,
        };
      }));

      reply.send({
        success: true,
        incidents: mappedIncidents,
        total,
        hasMore: (filters.offset + filters.limit) < total,
      });
    } catch (error) {
      logger.error('Failed to get anomaly incidents', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve anomaly incidents',
      });
    }
  });

  fastify.get<{ Querystring: StatsQuerystring }>('/anomaly-incidents/stats', async (req, reply) => {
    try {
      const hours = parseNumericQuery(req.query.hours, 24);
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

      const result = await query<StatsRow>(statsQuery, [startTime]);
      const stats = result.rows[0];

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

      const metricsResult = await query<TopMetricRow>(topMetricsQuery, [startTime]);
      const topMetrics = metricsResult.rows;

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

      const agentsResult = await query<TopDeviceRow>(topDevicesQuery, [startTime]);
      const topDevices = agentsResult.rows;

      reply.send({
        success: true,
        stats: {
          total: Number.parseInt(String(stats.total), 10),
          byStatus: {
            open: Number.parseInt(String(stats.open_count), 10),
            active: Number.parseInt(String(stats.active_count), 10),
            resolved: Number.parseInt(String(stats.resolved_count), 10),
          },
          bySeverity: {
            info: Number.parseInt(String(stats.info_count), 10),
            warning: Number.parseInt(String(stats.warning_count), 10),
            critical: Number.parseInt(String(stats.critical_count), 10),
          },
          affectedDevices: Number.parseInt(String(stats.affected_agents), 10),
          affectedEndpoints: Number.parseInt(String(stats.affected_endpoints), 10),
          topMetrics: topMetrics.map((metricRow) => ({
            metric: metricRow.metric,
            count: Number.parseInt(String(metricRow.count), 10),
          })),
          topDevices: topDevices.map((device) => ({
            deviceName: device.device_name,
            deviceUuid: device.agent_uuid || null,
            count: Number.parseInt(String(device.count), 10),
          })),
        },
      });
    } catch (error) {
      logger.error('Failed to get anomaly incident stats', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve incident statistics',
      });
    }
  });

  fastify.get<{ Params: IncidentIdParams }>('/anomaly-incidents/:incidentId', async (req, reply) => {
    try {
      const { incidentId } = req.params;

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

      const incidentResult = await query<IncidentRow>(incidentQuery, [incidentId]);
      const incident = incidentResult.rows[0];

      if (!incident) {
        return reply.status(404).send({
          success: false,
          error: 'Incident not found',
        });
      }

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

      const eventsResult = await query<EventRow>(eventsQuery, [incident.fingerprint]);
      const events = eventsResult.rows;

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

      const alertsResult = await query<AlertRow>(alertsQuery, [incidentId]);
      const alerts = alertsResult.rows;
      const endpointNameCache = new Map<string, string>();

      const affectedAgents = incident.affected_agents || [];
      const deviceUuid = incident.agent_uuid || null;

      const incidentDisplay = await resolveDisplayFields({
        deviceType: incident.device_type,
        deviceName: incident.device_name,
        metric: incident.metric,
        affectedAgents,
        cache: endpointNameCache,
      });

      const mappedEvents = await Promise.all(events.map(async (event) => {
        const eventDisplay = await resolveDisplayFields({
          deviceType: event.device_type,
          deviceName: event.device_name,
          metric: event.metric,
          agentUuid: event.agent_uuid || undefined,
          cache: endpointNameCache,
        });

        return {
          msg_id: event.msg_id,
          agent_uuid: event.agent_uuid,
          device_name: eventDisplay.deviceName,
          device_type: event.device_type,
          device_state: event.baseline?.deviceState || 'unknown',
          metric: eventDisplay.metric,
          timestamp_ms: Number.parseInt(String(event.timestamp_ms), 10),
          observed_value: Number.parseFloat(String(event.observed_value)),
          baseline: event.baseline,
          anomaly_score: Number.parseFloat(String(event.anomaly_score)),
          confidence: Number.parseFloat(String(event.confidence)),
          severity: event.severity,
          deviation: Number.parseFloat(String(event.deviation)),
          triggered_by: event.triggered_by,
          expected_range: event.expected_range,
        };
      }));

      reply.send({
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
          first_seen: Number.parseInt(String(incident.first_seen), 10),
          last_seen: Number.parseInt(String(incident.last_seen), 10),
          max_anomaly_score: Number.parseFloat(String(incident.max_anomaly_score)),
          max_confidence: Number.parseFloat(String(incident.max_confidence)),
          event_count: Number.parseInt(String(incident.event_count), 10),
          status: incident.status,
          acknowledged_at: incident.acknowledged_at,
          acknowledged_by: incident.acknowledged_by,
          resolution_notes: incident.resolution_notes,
          created_at: incident.created_at,
          updated_at: incident.updated_at,
        },
        events: mappedEvents,
        alerts: alerts.map((alert) => ({
          alert_id: alert.alert_id,
          severity: alert.severity,
          device_name: alert.device_name,
          device_uuid: alert.device_uuid || null,
          metric: alert.metric,
          affected_agents: alert.affected_devices || [],
          max_anomaly_score: Number.parseFloat(String(alert.max_anomaly_score)),
          message: alert.message,
          created_at: alert.created_at,
        })),
      });
    } catch (error) {
      logger.error('Failed to get incident details', error);
      reply.status(500).send({
        success: false,
        error: 'Failed to retrieve incident details',
      });
    }
  });

  fastify.patch<{ Params: IncidentIdParams; Body: ResolveIncidentBody }>('/anomaly-incidents/:incidentId/resolve', async (req, reply) => {
    try {
      const { incidentId } = req.params;
      const { resolvedBy, notes } = req.body;

      if (!resolvedBy) {
        return reply.status(400).send({
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

      const result = await query<IncidentRow>(updateQuery, [resolvedBy, notes || null, incidentId]);

      if (result.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: 'Incident not found',
        });
      }

      const incident = result.rows[0];

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
      }

      logger.info(`Incident ${incidentId} resolved by ${resolvedBy}`, {
        incidentId,
        resolvedBy,
        notes,
      });

      reply.send({
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
          max_anomaly_score: Number.parseFloat(String(incident.max_anomaly_score)),
          max_confidence: Number.parseFloat(String(incident.max_confidence)),
          event_count: Number.parseInt(String(incident.event_count), 10),
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
      reply.status(500).send({
        success: false,
        error: 'Failed to resolve incident',
      });
    }
  });
};

export default plugin;