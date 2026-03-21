/**
 * Readings Service
 * 
 * Service layer for interacting with the readings hypertable (TimescaleDB).
 * Replaces sensor-data.service.ts with optimized queries.
 */

import { query } from '../db/connection';
import logger from '../utils/logger';

export interface Reading {
  time: Date;
  agent_uuid: string;
  metric_name: string;
  value: number | null;
  quality: string;
  unit: string | null;
  protocol: string;
  extra: Record<string, any>;
}

export interface ReadingInsert {
  agent_uuid: string;  // AGENT/infrastructure UUID
  metric_name: string;
  value: number | null;
  quality?: string;
  unit?: string;
  protocol: string;
  extra?: ReadingExtra;  // endpoint_uuid, agent_uuid (asset), device_name, protocol metadata
  time?: Date;
  anomaly_score?: number;
  anomaly_threshold?: number;
  baseline_samples?: number;
  detection_methods?: any;
}

export interface ReadingExtra {
  endpoint_uuid?: string;      // Endpoint/sensor UUID (connection point)
  agent_uuid?: string;        // Stable device/asset UUID (business entity)
  device_name?: string;        // Device/asset name
  ingested_at?: string;        // ISO timestamp when ingested
  [key: string]: any;          // Protocol-specific metadata (slave_id, location, scale, etc)
}

export interface TimeSeriesQuery {
  agent_uuid?: string;        // Agent UUID (infrastructure entity)
  endpoint_uuid?: string;    // Endpoint UUID (connection point)
  asset_uuid?: string;       // Asset UUID (business entity, stored in extra.agent_uuid)
  metric_name?: string;
  protocol?: string;
  start_time?: Date;
  end_time?: Date;
  limit?: number;
}

export class ReadingsService {
  private lastRefreshTime: number = 0;
  private readonly REFRESH_THROTTLE_MS = 60000; // Max once per minute
  private readonly COLUMNS_PER_INSERT_ROW = 12;
  private readonly MAX_BIND_PARAMS_PER_QUERY = 60000; // Keep below PostgreSQL protocol/driver limits
  private readonly MAX_ROWS_PER_BULK_INSERT = Math.max(1, Math.floor(this.MAX_BIND_PARAMS_PER_QUERY / this.COLUMNS_PER_INSERT_ROW));

  /**
   * Refresh materialized views (throttled)
   * Called after bulk insert when new device data is detected
   */
  private async refreshMetricCatalog(): Promise<void> {
    const now = Date.now();
    
    // Throttle: only refresh once per minute
    if (now - this.lastRefreshTime < this.REFRESH_THROTTLE_MS) {
      return;
    }

    try {
      await query('SELECT refresh_all_catalog_views()');
      this.lastRefreshTime = now;
      logger.debug('Refreshed metric catalog views');
    } catch (error) {
      logger.error('Failed to refresh metric catalog views:', error);
    }
  }

  /**
   * Insert single reading
   */
  async insert(reading: ReadingInsert): Promise<void> {
    const {
      agent_uuid,
      metric_name,
      value,
      quality = 'good',
      unit = null,
      protocol,
      extra = {},
      time = new Date()
    } = reading;

    await query(
      `INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`,
      [time, agent_uuid, metric_name, value, quality, unit, protocol, JSON.stringify(extra)]
    );
  }

  /**
   * Bulk insert readings (more efficient)
   */
  async bulkInsert(readings: ReadingInsert[]): Promise<number> {
    if (readings.length === 0) return 0;

    let insertedTotal = 0;

    for (let i = 0; i < readings.length; i += this.MAX_ROWS_PER_BULK_INSERT) {
      const batch = readings.slice(i, i + this.MAX_ROWS_PER_BULK_INSERT);
      const values: any[] = [];
      const placeholders: string[] = [];
      let paramIndex = 1;

      batch.forEach((reading) => {
        const {
          agent_uuid,
          metric_name,
          value,
          quality = 'good',
          unit = null,
          protocol,
          extra = {},
          time = new Date(),
          anomaly_score,
          anomaly_threshold,
          baseline_samples,
          detection_methods
        } = reading;

        placeholders.push(
          `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
        );

        values.push(
          time,
          agent_uuid,
          metric_name,
          value,
          quality,
          unit,
          protocol,
          JSON.stringify(extra),
          anomaly_score !== undefined ? anomaly_score : null,
          anomaly_threshold !== undefined ? anomaly_threshold : null,
          baseline_samples !== undefined ? baseline_samples : null,
          detection_methods !== undefined ? JSON.stringify(detection_methods) : null
        );
      });

      const result = await query(
        `INSERT INTO readings (time, agent_uuid, metric_name, value, quality, unit, protocol, extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (agent_uuid, metric_name, time) DO NOTHING`,
        values
      );

      insertedTotal += result.rowCount || 0;
    }

    // Refresh metric catalog if readings contain deviceName (new agents detected)
    const hasDeviceNames = readings.some(r => r.extra?.deviceName);
    if (hasDeviceNames && insertedTotal > 0) {
      // Fire-and-forget (don't block on refresh)
      this.refreshMetricCatalog().catch(err => 
        logger.error('Background metric catalog refresh failed:', err)
      );
    }

    return insertedTotal;
  }

  /**
   * Get latest value for each metric (device)
   */
  async getLatest(agent_uuid: string, metric_names?: string[]): Promise<Reading[]> {
    let sql = `
      SELECT DISTINCT ON (metric_name)
        time,
        agent_uuid,
        metric_name,
        value,
        quality,
        unit,
        protocol,
        extra
      FROM readings
      WHERE agent_uuid = $1
    `;
    const params: any[] = [agent_uuid];

    if (metric_names && metric_names.length > 0) {
      sql += ` AND metric_name = ANY($2)`;
      params.push(metric_names);
    }

    sql += ` ORDER BY metric_name, time DESC`;

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Get time-series data (raw readings)
   */
  async getTimeSeries(queryParams: TimeSeriesQuery): Promise<Reading[]> {
    const {
      agent_uuid,
      metric_name,
      protocol,
      start_time,
      end_time,
      limit = 1000
    } = queryParams;

    let sql = 'SELECT * FROM readings WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (agent_uuid) {
      sql += ` AND agent_uuid = $${paramIndex++}`;
      params.push(agent_uuid);
    }

    if (metric_name) {
      sql += ` AND metric_name = $${paramIndex++}`;
      params.push(metric_name);
    }

    if (protocol) {
      sql += ` AND protocol = $${paramIndex++}`;
      params.push(protocol);
    }

    if (start_time) {
      sql += ` AND time >= $${paramIndex++}`;
      params.push(start_time);
    }

    if (end_time) {
      sql += ` AND time <= $${paramIndex++}`;
      params.push(end_time);
    }

    sql += ` ORDER BY time DESC LIMIT $${paramIndex++}`;
    params.push(limit);

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Get hourly aggregates (uses continuous aggregate - fast!)
   */
  async getHourlyAggregates(
    agent_uuid: string,
    metric_name: string,
    start_time: Date,
    end_time: Date
  ): Promise<any[]> {
    const result = await query(
      `SELECT
        bucket,
        device_name,
        avg_value,
        min_value,
        max_value,
        stddev_value,
        sample_count,
        last_value,
        first_value
       FROM readings_hourly
       WHERE agent_uuid = $1
         AND metric_name = $2
         AND bucket >= $3
         AND bucket <= $4
       ORDER BY bucket DESC`,
      [agent_uuid, metric_name, start_time, end_time]
    );

    return result.rows;
  }

  /**
   * Get daily aggregates (uses continuous aggregate - fast!)
   */
  async getDailyAggregates(
    agent_uuid: string,
    metric_name: string,
    start_time: Date,
    end_time: Date
  ): Promise<any[]> {
    const result = await query(
      `SELECT
        bucket,
        avg_value,
        min_value,
        max_value,
        stddev_value,
        sample_count
       FROM readings_daily
       WHERE agent_uuid = $1
         AND metric_name = $2
         AND bucket >= $3
         AND bucket <= $4
       ORDER BY bucket DESC`,
      [agent_uuid, metric_name, start_time, end_time]
    );

    return result.rows;
  }

  /**
   * Get metrics summary for a device
   */
  async getMetricsSummary(agent_uuid: string): Promise<any[]> {
    const result = await query(
      `SELECT
        metric_name,
        protocol,
        unit,
        COUNT(*) as total_readings,
        MAX(time) as last_reading_time,
        MIN(time) as first_reading_time
       FROM readings
       WHERE agent_uuid = $1
       GROUP BY metric_name, protocol, unit
       ORDER BY last_reading_time DESC`,
      [agent_uuid]
    );

    return result.rows;
  }

  /**
   * Delete readings for a device (respects retention policy)
   */
  async deleteByDevice(agent_uuid: string): Promise<number> {
    const result = await query(
      'DELETE FROM readings WHERE agent_uuid = $1',
      [agent_uuid]
    );

    return result.rowCount || 0;
  }

  /**
   * Delete specific metric readings
   */
  async deleteMetric(agent_uuid: string, metric_name: string): Promise<number> {
    const result = await query(
      'DELETE FROM readings WHERE agent_uuid = $1 AND metric_name = $2',
      [agent_uuid, metric_name]
    );

    return result.rowCount || 0;
  }

  /**
   * Get device anomaly summary (last 24 hours)
   * @param agent_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getDeviceAnomalySummary(agent_uuid?: string, deviceName?: string): Promise<any[]> {
    let sql = 'SELECT * FROM device_anomaly_summary WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (agent_uuid) {
      sql += ` AND agent_uuid = $${paramIndex++}`;
      params.push(agent_uuid);
    }

    if (deviceName) {
      sql += ` AND device_name = $${paramIndex++}`;
      params.push(deviceName);
    }

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Get hourly anomaly aggregates
   * @param agent_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getHourlyAnomalyScores(
    agent_uuid?: string,
    deviceName?: string,
    metric_name?: string,
    start_time?: Date,
    end_time?: Date,
    limit: number = 24
  ): Promise<any[]> {
    let sql = `
      SELECT
        bucket,
agent_uuid,
      device_name,
      metric_name,
      protocol,
      avg_anomaly_score,
      min_anomaly_score,
      max_anomaly_score,
      stddev_anomaly_score,
      scored_count,
      high_anomaly_count,
      high_anomaly_percent,
      last_anomaly_score,
      last_scored_time,
      avg_threshold,
      avg_baseline_samples
      FROM anomaly_scores_hourly
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (agent_uuid) {
      sql += ` AND agent_uuid = $${paramIndex++}`;
      params.push(agent_uuid);
    }

    if (deviceName) {
      sql += ` AND device_name = $${paramIndex++}`;
      params.push(deviceName);
    }

    if (metric_name) {
      sql += ` AND metric_name = $${paramIndex++}`;
      params.push(metric_name);
    }

    if (start_time) {
      sql += ` AND bucket >= $${paramIndex++}`;
      params.push(start_time);
    }

    if (end_time) {
      sql += ` AND bucket <= $${paramIndex++}`;
      params.push(end_time);
    }

    sql += ` ORDER BY bucket DESC LIMIT $${paramIndex++}`;
    params.push(limit);

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Get daily anomaly aggregates
   * @param agent_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getDailyAnomalyScores(
    agent_uuid?: string,
    deviceName?: string,
    metric_name?: string,
    start_time?: Date,
    end_time?: Date,
    limit: number = 30
  ): Promise<any[]> {
    let sql = `
      SELECT
        bucket,
agent_uuid,
      device_name,
      metric_name,
      protocol,
      avg_anomaly_score,
      min_anomaly_score,
      max_anomaly_score,
      stddev_anomaly_score,
      scored_count,
      critical_count,
      high_count,
      medium_count,
      low_count,
      critical_percent,
      high_plus_percent,
      avg_threshold,
      avg_baseline_samples
      FROM anomaly_scores_daily
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (agent_uuid) {
      sql += ` AND agent_uuid = $${paramIndex++}`;
      params.push(agent_uuid);
    }

    if (deviceName) {
      sql += ` AND device_name = $${paramIndex++}`;
      params.push(deviceName);
    }

    if (metric_name) {
      sql += ` AND metric_name = $${paramIndex++}`;
      params.push(metric_name);
    }

    if (start_time) {
      sql += ` AND bucket >= $${paramIndex++}`;
      params.push(start_time);
    }

    if (end_time) {
      sql += ` AND bucket <= $${paramIndex++}`;
      params.push(end_time);
    }

    sql += ` ORDER BY bucket DESC LIMIT $${paramIndex++}`;
    params.push(limit);

    const result = await query(sql, params);
    return result.rows;
  }

  /**
   * Get metrics with highest anomaly scores (per device)
   * @param agent_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getTopAnomalousMetrics(
    agent_uuid?: string,
    deviceName?: string,
    hours: number = 24,
    limit: number = 10
  ): Promise<any[]> {
    let sql = `
      SELECT
        extra->>'deviceName' as device_name,
        metric_name,
        protocol,
        AVG(anomaly_score) as avg_score,
        MAX(anomaly_score) as max_score,
        COUNT(*) as scored_count,
        COUNT(*) FILTER (WHERE anomaly_score > 0.7) as high_count,
        MAX(time) as last_scored_time
      FROM readings
      WHERE anomaly_score IS NOT NULL
        AND time > NOW() - INTERVAL '1 hour' * $1
    `;
    const params: any[] = [hours];
    let paramIndex = 2;

    if (agent_uuid) {
      sql += ` AND agent_uuid = $${paramIndex++}`;
      params.push(agent_uuid);
    }

    if (deviceName) {
      sql += ` AND extra->>'deviceName' = $${paramIndex++}`;
      params.push(deviceName);
    }

    sql += ` GROUP BY extra->>'deviceName', metric_name, protocol
             ORDER BY avg_score DESC
             LIMIT $${paramIndex++}`;
    params.push(limit);

    const result = await query(sql, params);
    return result.rows;
  }
}

export const readingsService = new ReadingsService();
