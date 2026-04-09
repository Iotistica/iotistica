/**
 * Readings Service
 *
 * API-side read/query service over the readings hypertable and derived views.
 * Write-side ingestion now lives in the dedicated ingestion service.
 */

import { query } from '../../db/connection';

export interface Reading {
  time: Date;
  agent_uuid: string;
  metric_name: string;
  value: number | null;
  quality: string;
  unit: string | null;
  protocol: string;
  extra: Record<string, unknown>;
}

export interface ReadingExtra {
  endpoint_uuid?: string;
  device_uuid?: string;
  device_name?: string;
  ingested_at?: string;
  [key: string]: unknown;
}

export interface TimeSeriesQuery {
  agent_uuid?: string;
  endpoint_uuid?: string;
  asset_uuid?: string;
  metric_name?: string;
  protocol?: string;
  start_time?: Date;
  end_time?: Date;
  limit?: number;
}

type QueryRow = Record<string, unknown>;

export class ReadingsService {
  async getLatest(agent_uuid: string, metric_names?: string[]): Promise<Reading[]> {
    let sql = `
      WITH metric_list AS (
        SELECT DISTINCT metric_name
        FROM readings
        WHERE agent_uuid = $1
      )
      SELECT
        r.time,
        r.agent_uuid,
        r.metric_name,
        r.value,
        r.quality,
        r.unit,
        r.protocol,
        r.extra
      FROM metric_list m
      CROSS JOIN LATERAL (
        SELECT
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
          AND metric_name = m.metric_name
        ORDER BY time DESC
        LIMIT 1
      ) r
    `;
    const params: Array<string | string[]> = [agent_uuid];

    if (metric_names && metric_names.length > 0) {
      sql = `
        WITH metric_list AS (
          SELECT DISTINCT m.metric_name
          FROM unnest($2::text[]) AS m(metric_name)
        )
        SELECT
          r.time,
          r.agent_uuid,
          r.metric_name,
          r.value,
          r.quality,
          r.unit,
          r.protocol,
          r.extra
        FROM metric_list m
        CROSS JOIN LATERAL (
          SELECT
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
            AND metric_name = m.metric_name
          ORDER BY time DESC
          LIMIT 1
        ) r
      `;
      params.push(metric_names);
    }

    sql += ' ORDER BY r.metric_name';

    const result = await query<Reading>(sql, params);
    return result.rows;
  }

  async getTimeSeries(queryParams: TimeSeriesQuery): Promise<Reading[]> {
    const { agent_uuid, metric_name, protocol, start_time, end_time, limit = 1000 } = queryParams;

    let sql = 'SELECT * FROM readings WHERE 1=1';
    const params: Array<string | Date | number> = [];
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

    const result = await query<Reading>(sql, params);
    return result.rows;
  }

  async getHourlyAggregates(
    agent_uuid: string,
    metric_name: string,
    start_time: Date,
    end_time: Date,
  ): Promise<QueryRow[]> {
    const result = await query<QueryRow>(
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
      [agent_uuid, metric_name, start_time, end_time],
    );

    return result.rows;
  }

  async getDailyAggregates(
    agent_uuid: string,
    metric_name: string,
    start_time: Date,
    end_time: Date,
  ): Promise<QueryRow[]> {
    const result = await query<QueryRow>(
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
      [agent_uuid, metric_name, start_time, end_time],
    );

    return result.rows;
  }

  async getMetricsSummary(agent_uuid: string): Promise<QueryRow[]> {
    const result = await query<QueryRow>(
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
      [agent_uuid],
    );

    return result.rows;
  }

  async getDeviceAnomalySummary(agent_uuid?: string, deviceName?: string): Promise<QueryRow[]> {
    let sql = 'SELECT * FROM device_anomaly_summary WHERE 1=1';
    const params: string[] = [];
    let paramIndex = 1;

    if (agent_uuid) {
      sql += ` AND agent_uuid = $${paramIndex++}`;
      params.push(agent_uuid);
    }

    if (deviceName) {
      sql += ` AND device_name = $${paramIndex++}`;
      params.push(deviceName);
    }

    const result = await query<QueryRow>(sql, params);
    return result.rows;
  }

  async getHourlyAnomalyScores(
    agent_uuid?: string,
    deviceName?: string,
    metric_name?: string,
    start_time?: Date,
    end_time?: Date,
    limit: number = 24,
  ): Promise<QueryRow[]> {
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
    const params: Array<string | Date | number> = [];
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

    const result = await query<QueryRow>(sql, params);
    return result.rows;
  }

  async getDailyAnomalyScores(
    agent_uuid?: string,
    deviceName?: string,
    metric_name?: string,
    start_time?: Date,
    end_time?: Date,
    limit: number = 30,
  ): Promise<QueryRow[]> {
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
    const params: Array<string | Date | number> = [];
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

    const result = await query<QueryRow>(sql, params);
    return result.rows;
  }

  async getTopAnomalousMetrics(
    agent_uuid?: string,
    deviceName?: string,
    hours: number = 24,
    limit: number = 10,
  ): Promise<QueryRow[]> {
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
    const params: Array<string | number> = [hours];
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

    const result = await query<QueryRow>(sql, params);
    return result.rows;
  }
}

export const readingsService = new ReadingsService();
