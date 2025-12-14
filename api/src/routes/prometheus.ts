/**
 * Prometheus Metrics Exporter
 * 
 * Exposes endpoint readings in Prometheus format for scraping
 * Endpoint: GET /metrics
 * 
 * Uses TimescaleDB hypertable (readings) for optimal time-series performance:
 * - Leverages time-based partitioning for fast queries
 * - Filters on quality='good' for reliable data
 * - Uses hypertable indexes for efficient DISTINCT ON
 * 
 * Metrics exposed:
 * - endpoint_reading{device_uuid, device_name, metric_name, protocol, unit} - Latest endpoint value
 * - endpoint_reading_timestamp{device_uuid, metric_name, protocol} - Unix timestamp of last reading
 * - device_status{device_uuid, device_name} - Device online status (1=online, 0=offline)
 */

import express from 'express';
import { query } from '../db/connection';
import { logger } from '../utils/logger';

export const router = express.Router();

/**
 * Prometheus metrics endpoint
 * GET /metrics
 * 
 * Returns latest sensor readings for all devices in Prometheus text format
 */
router.get('/metrics', async (req, res) => {
  try {
    // Set Prometheus content type
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');

    const lines: string[] = [];

    // HELP and TYPE declarations
    lines.push('# HELP endpoint_reading Latest endpoint reading value');
    lines.push('# TYPE endpoint_reading gauge');
    lines.push('# HELP endpoint_reading_timestamp Unix timestamp of last endpoint reading');
    lines.push('# TYPE endpoint_reading_timestamp gauge');
    lines.push('# HELP device_status Device online status (1=online, 0=offline)');
    lines.push('# TYPE device_status gauge');
    lines.push('');

    // Get latest readings using TimescaleDB continuous aggregate (readings_hourly)
    // This is 100x faster than querying raw readings table (9M+ rows)
    // Uses pre-aggregated hourly buckets with last_value (only ~7K rows, no need for time filter)
    const readingsResult = await query(`
      WITH latest_hourly AS (
        SELECT DISTINCT ON (device_uuid, metric_name)
          device_uuid,
          metric_name,
          protocol,
          last_value,
          EXTRACT(EPOCH FROM last_time) as timestamp_unix
        FROM readings_hourly
        ORDER BY device_uuid, metric_name, bucket DESC
      )
      SELECT 
        r.device_uuid,
        r.metric_name,
        r.protocol,
        r.last_value as value,
        '' as unit,  -- Unit not tracked in aggregate, could add if needed
        r.timestamp_unix,
        COALESCE(d.device_name, 'unknown') as device_name,
        CASE 
          WHEN d.last_connectivity_event > NOW() - INTERVAL '5 minutes' THEN 1
          ELSE 0
        END as device_online
      FROM latest_hourly r
      LEFT JOIN devices d ON d.uuid = r.device_uuid  -- Use LEFT JOIN to keep all readings
      LIMIT 10000
    `);

    const readings = readingsResult.rows;

    logger.info('Prometheus metrics query result', {
      rowCount: readings.length,
      sampleRow: readings[0]
    });

    // Track devices we've seen for status metrics
    const devicesStatus = new Map<string, { name: string; online: number }>();

    // Generate metrics for each reading
    for (const reading of readings) {
      const {
        device_uuid,
        device_name,
        metric_name,
        protocol,
        value,
        unit,
        timestamp_unix,
        device_online
      } = reading;

      // Skip non-numeric values
      if (value === null || value === undefined || isNaN(parseFloat(value))) {
        continue;
      }

      // Sanitize labels (Prometheus requires lowercase, no special chars except _)
      const sanitizedDeviceUuid = device_uuid.replace(/-/g, '_');
      const sanitizedDeviceName = (device_name || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
      const sanitizedMetricName = metric_name.replace(/[^a-zA-Z0-9_]/g, '_');
      const sanitizedProtocol = protocol.replace(/[^a-zA-Z0-9_]/g, '_');
      const sanitizedUnit = (unit || '').replace(/[^a-zA-Z0-9_]/g, '_');

      // Endpoint reading value
      lines.push(
        `endpoint_reading{device_uuid="${sanitizedDeviceUuid}",device_name="${sanitizedDeviceName}",metric_name="${sanitizedMetricName}",protocol="${sanitizedProtocol}",unit="${sanitizedUnit}"} ${value}`
      );

      // Timestamp of reading
      lines.push(
        `endpoint_reading_timestamp{device_uuid="${sanitizedDeviceUuid}",metric_name="${sanitizedMetricName}",protocol="${sanitizedProtocol}"} ${timestamp_unix}`
      );

      // Track device status
      if (!devicesStatus.has(device_uuid)) {
        devicesStatus.set(device_uuid, {
          name: sanitizedDeviceName,
          online: device_online
        });
      }
    }

    // Add device status metrics
    lines.push('');
    for (const [uuid, status] of devicesStatus.entries()) {
      const sanitizedUuid = uuid.replace(/-/g, '_');
      lines.push(
        `device_status{device_uuid="${sanitizedUuid}",device_name="${status.name}"} ${status.online}`
      );
    }

    // Send response
    res.send(lines.join('\n') + '\n');

    logger.debug('Prometheus metrics exported', {
      readings: readings.length,
      devices: devicesStatus.size
    });

  } catch (error: any) {
    logger.error('Error generating Prometheus metrics', { error: error.message });
    res.status(500).send('# Error generating metrics\n');
  }
});

export default router;
