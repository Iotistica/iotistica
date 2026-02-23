/**
 * Anomaly Alerts API Routes
 *
 * Endpoints for querying and managing anomaly alerts
 * from the edge AI anomaly detection system.
 */

import { Router } from 'express';
import { query } from '../db/connection';
import logger from '../utils/logger';

const router = Router();

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
router.get('/alerts', async (req, res) => {
  try {
    const { severity, startTime, endTime, limit = 100, offset = 0 } = req.query;

    const filters = {
      severity: severity as string | undefined,
      startTime: startTime ? parseInt(startTime as string) : undefined,
      endTime: endTime ? parseInt(endTime as string) : undefined,
      limit: Math.min(parseInt(limit as string) || 100, 500), // Cap at 500
      offset: parseInt(offset as string) || 0,
    };

    // Build WHERE clause
    let whereConditions: string[] = ['1=1'];
    const queryParams: any[] = [];

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
    const countResult = await query(countQuery, queryParams);
    const total = parseInt(countResult.rows[0]?.total || 0);

    // Get alerts with pagination
    const alertsQuery = `
      SELECT
        alert_id,
        incident_id,
        severity,
        device_name,
        metric,
        affected_devices,
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

    const alertsResult = await query(alertsQuery, queryParams);
    const alerts = alertsResult.rows;

    res.json({
      success: true,
      alerts: alerts.map((alert: any) => ({
        alert_id: alert.alert_id,
        incident_id: alert.incident_id,
        severity: alert.severity,
        device_name: alert.device_name,
        metric: alert.metric,
        affected_devices: alert.affected_devices || [],
        max_anomaly_score: parseFloat(alert.max_anomaly_score),
        message: alert.message,
        channels: alert.channels || {},
        created_at: alert.created_at,
      })),
      total,
      hasMore: (filters.offset + filters.limit) < total,
    });
  } catch (error) {
    logger.error('Failed to get anomaly alerts', error);
    res.status(500).json({
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
router.get('/alerts/:alertId', async (req, res) => {
  try {
    const { alertId } = req.params;

    // Get alert
    const alertQuery = `
      SELECT
        alert_id,
        incident_id,
        severity,
        device_name,
        metric,
        affected_devices,
        max_anomaly_score,
        message,
        channels,
        created_at
      FROM anomaly_alerts
      WHERE alert_id = $1
    `;

    const alertResult = await query(alertQuery, [alertId]);
    const alert = alertResult.rows[0];

    if (!alert) {
      return res.status(404).json({
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

      const incidentResult = await query(incidentQuery, [alert.incident_id]);
      if (incidentResult.rows.length > 0) {
        const inc = incidentResult.rows[0];
        incident = {
          incident_id: inc.incident_id,
          fingerprint: inc.fingerprint,
          device_name: inc.device_name,
          device_type: inc.device_type,
          metric: inc.metric,
          severity: inc.severity,
          affected_devices: inc.affected_devices || [],
          affected_agents: inc.affected_agents || [],
          first_seen: inc.first_seen,
          last_seen: inc.last_seen,
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
      }
    }

    res.json({
      success: true,
      alert: {
        alert_id: alert.alert_id,
        incident_id: alert.incident_id,
        severity: alert.severity,
        device_name: alert.device_name,
        metric: alert.metric,
        affected_devices: alert.affected_devices || [],
        max_anomaly_score: parseFloat(alert.max_anomaly_score),
        message: alert.message,
        channels: alert.channels || {},
        created_at: alert.created_at,
      },
      incident,
    });
  } catch (error) {
    logger.error('Failed to get alert details', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve alert details',
    });
  }
});

export default router;
