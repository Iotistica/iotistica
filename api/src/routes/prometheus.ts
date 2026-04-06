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
 * - endpoint_reading{agent_uuid, device_name, metric_name, protocol, unit} - Latest endpoint value
 * - endpoint_reading_timestamp{agent_uuid, metric_name, protocol} - Unix timestamp of last reading
 * - device_status{agent_uuid, device_name} - Device online status (1=online, 0=offline)
 */

import express from 'express';
import { query } from '../db/connection';
import { logger } from '../utils/logger';
import { metrics } from '../services/ingestion/metrics';

export const router = express.Router();

/**
 * Prometheus metrics endpoint
 * GET /metrics
 * 
 * Returns latest sensor readings for all agents in Prometheus text format
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
        SELECT DISTINCT ON (agent_uuid, device_name, metric_name)
          agent_uuid,
          device_name,
          metric_name,
          protocol,
          last_value,
          EXTRACT(EPOCH FROM last_time) as timestamp_unix
        FROM readings_hourly
        ORDER BY agent_uuid, device_name, metric_name, bucket DESC
      )
      SELECT 
        r.agent_uuid,
        r.device_name,
        r.metric_name,
        r.protocol,
        r.last_value as value,
        '' as unit,  -- Unit not tracked in aggregate
        r.timestamp_unix,
        CASE 
          WHEN d.last_connectivity_event > NOW() - INTERVAL '5 minutes' THEN 1
          ELSE 0
        END as device_online
      FROM latest_hourly r
      LEFT JOIN agents d ON d.uuid = r.agent_uuid
      LIMIT 10000
    `);

    const readings = readingsResult.rows;

    logger.info('Prometheus metrics query result', {
      rowCount: readings.length,
      sampleRow: readings[0]
    });

    // Track agents we've seen for status metrics
    const agentsStatus = new Map<string, { name: string; online: number }>();

    // Generate metrics for each reading
    for (const reading of readings) {
      const {
        agent_uuid,
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
      const sanitizedDeviceUuid = agent_uuid.replace(/-/g, '_');
      const sanitizedDeviceName = (device_name || 'unknown').replace(/[^a-zA-Z0-9_]/g, '_');
      const sanitizedMetricName = metric_name.replace(/[^a-zA-Z0-9_]/g, '_');
      const sanitizedProtocol = protocol.replace(/[^a-zA-Z0-9_]/g, '_');
      const sanitizedUnit = (unit || '').replace(/[^a-zA-Z0-9_]/g, '_');

      // Endpoint reading value
      lines.push(
        `endpoint_reading{agent_uuid="${sanitizedDeviceUuid}",device_name="${sanitizedDeviceName}",metric_name="${sanitizedMetricName}",protocol="${sanitizedProtocol}",unit="${sanitizedUnit}"} ${value}`
      );

      // Timestamp of reading
      lines.push(
        `endpoint_reading_timestamp{agent_uuid="${sanitizedDeviceUuid}",metric_name="${sanitizedMetricName}",protocol="${sanitizedProtocol}"} ${timestamp_unix}`
      );

      // Track device status
      if (!agentsStatus.has(agent_uuid)) {
        agentsStatus.set(agent_uuid, {
          name: sanitizedDeviceName,
          online: device_online
        });
      }
    }

    // Add device status metrics
    lines.push('');
    for (const [uuid, status] of agentsStatus.entries()) {
      const sanitizedUuid = uuid.replace(/-/g, '_');
      lines.push(
        `device_status{agent_uuid="${sanitizedUuid}",device_name="${status.name}"} ${status.online}`
      );
    }

    // Ingestion pipeline metrics
    lines.push('');
    lines.push('# HELP iotistic_ingestion_stream_length Current number of messages in the ingestion stream backlog');
    lines.push('# TYPE iotistic_ingestion_stream_length gauge');
    lines.push(`iotistic_ingestion_stream_length ${metrics.streamLength}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_worker_lag Undelivered messages in the consumer group (stream lag)');
    lines.push('# TYPE iotistic_ingestion_worker_lag gauge');
    lines.push(`iotistic_ingestion_worker_lag ${metrics.workerLag}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_pending_count Delivered but unacknowledged messages (PEL size)');
    lines.push('# TYPE iotistic_ingestion_pending_count gauge');
    lines.push(`iotistic_ingestion_pending_count ${metrics.pendingMessages}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_dlq_length Number of messages in the dead-letter queue');
    lines.push('# TYPE iotistic_ingestion_dlq_length gauge');
    lines.push(`iotistic_ingestion_dlq_length ${metrics.dlqLength}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_worker_count Number of active ingestion worker loops');
    lines.push('# TYPE iotistic_ingestion_worker_count gauge');
    lines.push(`iotistic_ingestion_worker_count ${metrics.workerCount}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_redis_connected Redis connectivity status (1=connected, 0=disconnected)');
    lines.push('# TYPE iotistic_ingestion_redis_connected gauge');
    lines.push(`iotistic_ingestion_redis_connected ${metrics.redisConnected}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_redis_memory_used_bytes Redis memory currently in use (bytes)');
    lines.push('# TYPE iotistic_ingestion_redis_memory_used_bytes gauge');
    lines.push(`iotistic_ingestion_redis_memory_used_bytes ${metrics.redisMemoryUsedBytes}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_redis_memory_max_bytes Redis maxmemory configuration in bytes (0=unlimited)');
    lines.push('# TYPE iotistic_ingestion_redis_memory_max_bytes gauge');
    lines.push(`iotistic_ingestion_redis_memory_max_bytes ${metrics.redisMemoryMaxBytes}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_batch_latency_p95_ms P95 Redis pipeline flush duration (ms)');
    lines.push('# TYPE iotistic_ingestion_batch_latency_p95_ms gauge');
    lines.push(`iotistic_ingestion_batch_latency_p95_ms ${metrics.getBatchLatencyP95()}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_insert_latency_p95_ms P95 TimescaleDB batch insert duration (ms)');
    lines.push('# TYPE iotistic_ingestion_insert_latency_p95_ms gauge');
    lines.push(`iotistic_ingestion_insert_latency_p95_ms ${metrics.getInsertLatencyP95()}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_dwell_latency_p95_ms P95 message dwell time in Redis stream before processing (ms)');
    lines.push('# TYPE iotistic_ingestion_dwell_latency_p95_ms gauge');
    lines.push(`iotistic_ingestion_dwell_latency_p95_ms ${metrics.getDwellLatencyP95()}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_messages_processed_total Total messages successfully committed to database');
    lines.push('# TYPE iotistic_ingestion_messages_processed_total counter');
    lines.push(`iotistic_ingestion_messages_processed_total ${metrics.messagesProcessed}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_readings_inserted_total Total sensor reading rows inserted into TimescaleDB');
    lines.push('# TYPE iotistic_ingestion_readings_inserted_total counter');
    lines.push(`iotistic_ingestion_readings_inserted_total ${metrics.readingsInserted}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_messages_failed_total Total messages that failed normalization');
    lines.push('# TYPE iotistic_ingestion_messages_failed_total counter');
    lines.push(`iotistic_ingestion_messages_failed_total ${metrics.messagesFailed}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_messages_dropped_total Total messages dropped due to OOM pressure');
    lines.push('# TYPE iotistic_ingestion_messages_dropped_total counter');
    lines.push(`iotistic_ingestion_messages_dropped_total ${metrics.messagesDropped}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_oom_errors_total Total OOM errors on Redis pipeline flush');
    lines.push('# TYPE iotistic_ingestion_oom_errors_total counter');
    lines.push(`iotistic_ingestion_oom_errors_total ${metrics.oomErrors}`);
    lines.push('');
    lines.push('# HELP iotistic_ingestion_redis_reconnects_total Total Redis reconnection events');
    lines.push('# TYPE iotistic_ingestion_redis_reconnects_total counter');
    lines.push(`iotistic_ingestion_redis_reconnects_total ${metrics.redisReconnects}`);

    // Send response
    res.send(lines.join('\n') + '\n');

    logger.debug('Prometheus metrics exported', {
      readings: readings.length,
      agents: agentsStatus.size
    });

  } catch (error: any) {
    logger.error('Error generating Prometheus metrics', { error: error.message });
    res.status(500).send('# Error generating metrics\n');
  }
});

export default router;
