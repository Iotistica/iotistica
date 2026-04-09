/**
 * Prometheus Metrics Exporter
 *
 * Exposes endpoint readings in Prometheus format for scraping.
 * Endpoint: GET /metrics
 *
 * Uses TimescaleDB hypertable (readings) for optimal time-series performance:
 * - Leverages time-based partitioning for fast queries
 * - Filters on quality='good' for reliable data
 * - Uses hypertable indexes for efficient DISTINCT ON
 *
 * Metrics exposed:
 * - endpoint_reading{agent_uuid, device_name, metric_name, protocol, unit} - Latest endpoint value
 * - endpoint_reading_timestamp{agent_uuid, metric_name, protocol} - Unix timestamp of last reading
 * - device_status{agent_uuid, device_name} - Device online status (1=online, 0=offline)
 */
import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/connection';
import { logger } from '../utils/logger';

interface ReadingRow {
  agent_uuid: string;
  device_name: string | null;
  metric_name: string;
  protocol: string;
  last_value: number | string | null;
  unit: string | null;
  timestamp_unix: number | string;
  device_online: number;
}

function sanitizeLabel(value: string | null | undefined): string {
  return (value || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.get('/metrics', async (_req, reply) => {
    try {
      const lines: string[] = [];

      lines.push('# HELP endpoint_reading Latest endpoint reading value');
      lines.push('# TYPE endpoint_reading gauge');
      lines.push('# HELP endpoint_reading_timestamp Unix timestamp of last endpoint reading');
      lines.push('# TYPE endpoint_reading_timestamp gauge');
      lines.push('# HELP device_status Device online status (1=online, 0=offline)');
      lines.push('# TYPE device_status gauge');
      lines.push('');

      const readingsResult = await query<ReadingRow>(`
        SELECT DISTINCT ON (r.agent_uuid, device_name, r.metric_name)
          r.agent_uuid,
          COALESCE(
            NULLIF(r.extra->>'deviceName', ''),
            NULLIF(r.extra->>'device_name', ''),
            'unknown'
          ) AS device_name,
          r.metric_name,
          r.protocol,
          r.value AS last_value,
          '' AS unit,
          EXTRACT(EPOCH FROM r.time) AS timestamp_unix,
          CASE
            WHEN d.last_connectivity_event > NOW() - INTERVAL '5 minutes' THEN 1
            ELSE 0
          END AS device_online
        FROM readings r
        LEFT JOIN agents d ON d.uuid = r.agent_uuid
        WHERE r.time > NOW() - INTERVAL '2 hours'
          AND r.quality = 'good'
        ORDER BY r.agent_uuid, device_name, r.metric_name, r.time DESC
        LIMIT 10000
      `);

      const readings = readingsResult.rows;

      logger.info('Prometheus metrics query result', {
        rowCount: readings.length,
        sampleRow: readings[0],
      });

      const agentsStatus = new Map<string, { name: string; online: number }>();

      for (const reading of readings) {
        const numericValue = Number.parseFloat(String(reading.last_value));
        if (reading.last_value === null || Number.isNaN(numericValue)) {
          continue;
        }

        const sanitizedDeviceUuid = reading.agent_uuid.replace(/-/g, '_');
        const sanitizedDeviceName = sanitizeLabel(reading.device_name);
        const sanitizedMetricName = sanitizeLabel(reading.metric_name);
        const sanitizedProtocol = sanitizeLabel(reading.protocol);
        const sanitizedUnit = sanitizeLabel(reading.unit || '');

        lines.push(
          `endpoint_reading{agent_uuid="${sanitizedDeviceUuid}",device_name="${sanitizedDeviceName}",metric_name="${sanitizedMetricName}",protocol="${sanitizedProtocol}",unit="${sanitizedUnit}"} ${numericValue}`
        );

        lines.push(
          `endpoint_reading_timestamp{agent_uuid="${sanitizedDeviceUuid}",metric_name="${sanitizedMetricName}",protocol="${sanitizedProtocol}"} ${reading.timestamp_unix}`
        );

        if (!agentsStatus.has(reading.agent_uuid)) {
          agentsStatus.set(reading.agent_uuid, {
            name: sanitizedDeviceName,
            online: reading.device_online,
          });
        }
      }

      lines.push('');
      for (const [uuid, status] of agentsStatus.entries()) {
        const sanitizedUuid = uuid.replace(/-/g, '_');
        lines.push(
          `device_status{agent_uuid="${sanitizedUuid}",device_name="${status.name}"} ${status.online}`
        );
      }
      logger.debug('Prometheus metrics exported', {
        readings: readings.length,
        agents: agentsStatus.size,
      });

      return reply
        .header('Content-Type', 'text/plain; version=0.0.4')
        .send(`${lines.join('\n')}\n`);
    } catch (error: unknown) {
      logger.error('Error generating Prometheus metrics', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return reply.status(500)
        .header('Content-Type', 'text/plain; version=0.0.4')
        .send('# Error generating metrics\n');
    }
  });
};

export default plugin;