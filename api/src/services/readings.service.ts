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
  device_uuid: string;
  metric_name: string;
  value: number | null;
  quality: string;
  unit: string | null;
  protocol: string;
  extra: Record<string, any>;
}

export interface ReadingInsert {
  device_uuid: string;
  metric_name: string;
  value: number | null;
  quality?: string;
  unit?: string;
  protocol: string;
  extra?: Record<string, any>;
  time?: Date;
  anomaly_score?: number;
  anomaly_threshold?: number;
  baseline_samples?: number;
  detection_methods?: any;
}

export interface TimeSeriesQuery {
  device_uuid?: string;
  metric_name?: string;
  protocol?: string;
  start_time?: Date;
  end_time?: Date;
  limit?: number;
}

export class ReadingsService {
  /**
   * Insert single reading
   */
  async insert(reading: ReadingInsert): Promise<void> {
    const {
      device_uuid,
      metric_name,
      value,
      quality = 'good',
      unit = null,
      protocol,
      extra = {},
      time = new Date()
    } = reading;

    await query(
      `INSERT INTO readings (time, device_uuid, metric_name, value, quality, unit, protocol, extra)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (device_uuid, metric_name, time) DO NOTHING`,
      [time, device_uuid, metric_name, value, quality, unit, protocol, JSON.stringify(extra)]
    );
  }

  /**
   * Bulk insert readings (more efficient)
   */
  async bulkInsert(readings: ReadingInsert[]): Promise<number> {
    if (readings.length === 0) return 0;

    const values: any[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    readings.forEach((reading, i) => {
      const {
        device_uuid,
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
        device_uuid, 
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
      `INSERT INTO readings (time, device_uuid, metric_name, value, quality, unit, protocol, extra, anomaly_score, anomaly_threshold, baseline_samples, detection_methods)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (device_uuid, metric_name, time) DO NOTHING
       RETURNING *`,
      values
    );

    return result.rows.length;
  }

  /**
   * Get latest value for each metric (device)
   */
  async getLatest(device_uuid: string, metric_names?: string[]): Promise<Reading[]> {
    let sql = `
      SELECT DISTINCT ON (metric_name)
        time,
        device_uuid,
        metric_name,
        value,
        quality,
        unit,
        protocol,
        extra
      FROM readings
      WHERE device_uuid = $1
    `;
    const params: any[] = [device_uuid];

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
      device_uuid,
      metric_name,
      protocol,
      start_time,
      end_time,
      limit = 1000
    } = queryParams;

    let sql = 'SELECT * FROM readings WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (device_uuid) {
      sql += ` AND device_uuid = $${paramIndex++}`;
      params.push(device_uuid);
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
    device_uuid: string,
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
       WHERE device_uuid = $1
         AND metric_name = $2
         AND bucket >= $3
         AND bucket <= $4
       ORDER BY bucket DESC`,
      [device_uuid, metric_name, start_time, end_time]
    );

    return result.rows;
  }

  /**
   * Get daily aggregates (uses continuous aggregate - fast!)
   */
  async getDailyAggregates(
    device_uuid: string,
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
       WHERE device_uuid = $1
         AND metric_name = $2
         AND bucket >= $3
         AND bucket <= $4
       ORDER BY bucket DESC`,
      [device_uuid, metric_name, start_time, end_time]
    );

    return result.rows;
  }

  /**
   * Get metrics summary for a device
   */
  async getMetricsSummary(device_uuid: string): Promise<any[]> {
    const result = await query(
      `SELECT
        metric_name,
        protocol,
        unit,
        COUNT(*) as total_readings,
        MAX(time) as last_reading_time,
        MIN(time) as first_reading_time
       FROM readings
       WHERE device_uuid = $1
       GROUP BY metric_name, protocol, unit
       ORDER BY last_reading_time DESC`,
      [device_uuid]
    );

    return result.rows;
  }

  /**
   * Delete readings for a device (respects retention policy)
   */
  async deleteByDevice(device_uuid: string): Promise<number> {
    const result = await query(
      'DELETE FROM readings WHERE device_uuid = $1',
      [device_uuid]
    );

    return result.rowCount || 0;
  }

  /**
   * Delete specific metric readings
   */
  async deleteMetric(device_uuid: string, metric_name: string): Promise<number> {
    const result = await query(
      'DELETE FROM readings WHERE device_uuid = $1 AND metric_name = $2',
      [device_uuid, metric_name]
    );

    return result.rowCount || 0;
  }

  /**
   * Get device anomaly summary (last 24 hours)
   * @param device_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getDeviceAnomalySummary(device_uuid?: string, deviceName?: string): Promise<any[]> {
    let sql = 'SELECT * FROM device_anomaly_summary WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (device_uuid) {
      sql += ` AND device_uuid = $${paramIndex++}`;
      params.push(device_uuid);
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
   * @param device_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getHourlyAnomalyScores(
    device_uuid?: string,
    deviceName?: string,
    metric_name?: string,
    start_time?: Date,
    end_time?: Date,
    limit: number = 24
  ): Promise<any[]> {
    let sql = `
      SELECT
        bucket,
        device_uuid,
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

    if (device_uuid) {
      sql += ` AND device_uuid = $${paramIndex++}`;
      params.push(device_uuid);
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
   * @param device_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getDailyAnomalyScores(
    device_uuid?: string,
    deviceName?: string,
    metric_name?: string,
    start_time?: Date,
    end_time?: Date,
    limit: number = 30
  ): Promise<any[]> {
    let sql = `
      SELECT
        bucket,
        device_uuid,
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

    if (device_uuid) {
      sql += ` AND device_uuid = $${paramIndex++}`;
      params.push(device_uuid);
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
   * @param device_uuid - Edge gateway UUID (optional if deviceName provided)
   * @param deviceName - Monitored device name (e.g., 'COMAP-Main-Controller')
   */
  async getTopAnomalousMetrics(
    device_uuid?: string,
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

    if (device_uuid) {
      sql += ` AND device_uuid = $${paramIndex++}`;
      params.push(device_uuid);
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
