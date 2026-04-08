/**
 * Anomaly Alerts API Routes
 *
 * Endpoints for querying and managing anomaly alerts
 * from the edge AI anomaly detection system.
 */
import type { FastifyPluginAsync } from 'fastify';
import { query } from '../db/connection';
import logger from '../utils/logger';
import { jwtAuth } from '../middleware/jwt-auth';

type AnomalyAlertsQuerystring = {
  severity?: string;
  startTime?: string | number;
  endTime?: string | number;
  limit?: string | number;
  offset?: string | number;
};

type AlertIdParams = {
  alertId: string;
};

type AlertRow = {
  alert_id: string;
  incident_id: string | null;
  severity: string;
  device_name: string;
  agent_uuid: string | null;
  metric: string;
  affected_agents: string[] | null;
  max_anomaly_score: string | number;
  message: string;
  channels: Record<string, unknown> | null;
  created_at: string;
};

type CountRow = {
  total: string | number;
};

type IncidentRow = {
  incident_id: string;
  fingerprint: string;
  device_name: string;
  device_type: string;
  metric: string;
  severity: string;
  affected_agents: string[] | null;
  first_seen: string;
  last_seen: string;
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

const plugin: FastifyPluginAsync = async (fastify) => {

// Apply JWT auth only to /anomaly-alerts routes (path-specific to avoid intercepting other routes)
fastify.addHook('preHandler', jwtAuth);
/**
 * GET /api/v1/anomaly-alerts
 *
 * List anomaly alerts with filters and pagination
 *
 * Query params:
 * - severity: 'info' | 'warning' | 'critical' (optional)
 * - startTime: Start time in milliseconds (optional)
 * - endTime: End time in milliseconds (optional)
 * - limit: Max results (default 100)
 * - offset: Pagination offset (default 0)
 */

fastify.get<{ Querystring: AnomalyAlertsQuerystring }>('/anomaly-alerts', async (req, reply) => {
  try {
    const { severity, startTime, endTime, limit = 100, offset = 0 } = req.query;

    const filters = {
      severity,
      startTime: startTime !== undefined ? parseNumericQuery(startTime, 0) : undefined,
      endTime: endTime !== undefined ? parseNumericQuery(endTime, 0) : undefined,
      limit: Math.min(parseNumericQuery(limit, 100), 500),
      offset: parseNumericQuery(offset, 0),
    };

    // Build WHERE clause
    let whereConditions: string[] = ['1=1'];
    const queryParams: Array<string | number> = [];

    if (filters.severity) {
      whereConditions.push(`aa.severity = $${queryParams.length + 1}`);
      queryParams.push(filters.severity);
    }

    if (filters.startTime !== undefined) {
      whereConditions.push(`aa.created_at >= to_timestamp($${queryParams.length + 1}/1000)`);
      queryParams.push(filters.startTime);
    }

    if (filters.endTime !== undefined) {
      whereConditions.push(`aa.created_at <= to_timestamp($${queryParams.length + 1}/1000)`);
      queryParams.push(filters.endTime);
    }

    const whereClause = whereConditions.join(' AND ');

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total FROM anomaly_alerts aa
      WHERE ${whereClause}
    `;
    const countResult = await query<CountRow>(countQuery, queryParams);
    const total = Number.parseInt(String(countResult.rows[0]?.total ?? 0), 10);

    // Get alerts with pagination
    const alertsQuery = `
      SELECT
        alert_id,
        incident_id,
        severity,
        device_name,        agent_uuid,        metric,
        affected_agents,
        max_anomaly_score,
        message,
        channels,
        created_at
      FROM anomaly_alerts
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${queryParams.length + 1}
      OFFSET $${queryParams.length + 2}
    `;

    queryParams.push(filters.limit);
    queryParams.push(filters.offset);

    const alertsResult = await query<AlertRow>(alertsQuery, queryParams);
    const alerts = alertsResult.rows;

    reply.send({
      success: true,
      alerts: alerts.map((alert) => ({
        alert_id: alert.alert_id,
        incident_id: alert.incident_id,
        severity: alert.severity,
        device_name: alert.device_name,
        agent_uuid: alert.agent_uuid || null,
        metric: alert.metric,
        affected_agents: alert.affected_agents || [],
        max_anomaly_score: Number.parseFloat(String(alert.max_anomaly_score)),
        message: alert.message,
        channels: alert.channels || {},
        created_at: alert.created_at,
      })),
      total,
      hasMore: (filters.offset + filters.limit) < total,
    });
  } catch (error) {
    logger.error('Failed to get anomaly alerts', error);
    reply.status(500).send({
      success: false,
      error: 'Failed to retrieve anomaly alerts',
    });
  }
});

/**
 * GET /api/v1/anomaly-alerts/:alertId
 *
 * Get single alert with incident context
 */

fastify.get<{ Params: AlertIdParams }>('/anomaly-alerts/:alertId', async (req, reply) => {
  try {
    const { alertId } = req.params;

    // Get alert
    const alertQuery = `
      SELECT
        alert_id,
        incident_id,
        severity,
        device_name,
        agent_uuid,
        metric,
        affected_agents,
        max_anomaly_score,
        message,
        channels,
        created_at
      FROM anomaly_alerts
      WHERE alert_id = $1
    `;

    const alertResult = await query<AlertRow>(alertQuery, [alertId]);
    const alert = alertResult.rows[0];

    if (!alert) {
      return reply.status(404).send({
        success: false,
        error: 'Alert not found',
      });
    }

    // Get incident context if exists
    let incident = null;
    if (alert.incident_id) {
      const incidentQuery = `
        SELECT
          incident_id,
          fingerprint,
          device_name,
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
        FROM anomaly_incidents
        WHERE incident_id = $1
      `;

      const incidentResult = await query<IncidentRow>(incidentQuery, [alert.incident_id]);
      if (incidentResult.rows.length > 0) {
        const inc = incidentResult.rows[0];
        incident = {
          incident_id: inc.incident_id,
          fingerprint: inc.fingerprint,
          device_name: inc.device_name,
          device_type: inc.device_type,
          metric: inc.metric,
          severity: inc.severity,
          affected_agents: inc.affected_agents || [],
          first_seen: inc.first_seen,
          last_seen: inc.last_seen,
          max_anomaly_score: Number.parseFloat(String(inc.max_anomaly_score)),
          max_confidence: Number.parseFloat(String(inc.max_confidence)),
          event_count: Number.parseInt(String(inc.event_count), 10),
          status: inc.status,
          acknowledged_at: inc.acknowledged_at,
          acknowledged_by: inc.acknowledged_by,
          resolution_notes: inc.resolution_notes,
          created_at: inc.created_at,
          updated_at: inc.updated_at,
        };
      }
    }

    reply.send({
      success: true,
      alert: {
        alert_id: alert.alert_id,
        incident_id: alert.incident_id,
        severity: alert.severity,
        device_name: alert.device_name,
        agent_uuid: alert.agent_uuid || null,
        metric: alert.metric,
        affected_agents: alert.affected_agents || [],
        max_anomaly_score: Number.parseFloat(String(alert.max_anomaly_score)),
        message: alert.message,
        channels: alert.channels || {},
        created_at: alert.created_at,
      },
      incident,
    });
  } catch (error) {
    logger.error('Failed to get alert details', error);
    reply.status(500).send({
      success: false,
      error: 'Failed to retrieve alert details',
    });
  }
});

};

export default plugin;