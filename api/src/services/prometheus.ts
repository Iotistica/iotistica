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

const CACHE_TTL_MS = 15_000;
let cachedOutput = '';
let cachedAt = 0;

export async function renderEndpointPrometheusMetrics(): Promise<string> {
  if (cachedOutput && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedOutput;
  }

  const lines: string[] = [];

  lines.push('# HELP endpoint_reading Latest endpoint reading value');
  lines.push('# TYPE endpoint_reading gauge');
  lines.push('# HELP endpoint_reading_timestamp Unix timestamp of last endpoint reading');
  lines.push('# TYPE endpoint_reading_timestamp gauge');
  lines.push('# HELP device_status Device online status (1=online, 0=offline)');
  lines.push('# TYPE device_status gauge');
  lines.push('');

  const readingsResult = await query<ReadingRow>(`
    SELECT
      el.agent_uuid,
      el.device_name,
      el.metric_name,
      el.protocol,
      el.value AS last_value,
      COALESCE(el.unit, '') AS unit,
      EXTRACT(EPOCH FROM el.time) AS timestamp_unix,
      CASE
        WHEN a.is_online IS NOT NULL THEN CASE WHEN a.is_online THEN 1 ELSE 0 END
        ELSE 1
      END AS device_online
    FROM readings_latest el
    LEFT JOIN agents a ON el.agent_uuid = a.uuid
    WHERE el.quality = 'good'
  `);

  const readings = readingsResult.rows;

  logger.debug('Prometheus metrics query result', {
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

  const output = `${lines.join('\n')}\n`;
  cachedOutput = output;
  cachedAt = Date.now();

  return output;
}
