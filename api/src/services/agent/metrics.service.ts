import { query } from '../../db/connection';
import logger from '../../utils/logger';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface GetAgentsParams {
  protocol?: string;
  agentUuid?: string;
}

export interface GetCatalogParams {
  deviceUuid?: string;
  protocol?: string;
  agentUuid?: string;
  metricName?: string;
}

export interface GetLatestParams {
  deviceUuid: string;
  metricName?: string;
  agentUuid?: string;
}

export type TimeRange = '1m' | '1h' | '6h' | '12h' | '24h' | '7d' | '30d';
export type Aggregation = 'auto' | '1min' | '1hour' | '1day';
export type RefreshView = 'catalog' | 'agents' | 'latest' | 'all';

const RAW_ZOOM_MAX_WINDOW_MS = 15 * 60 * 1000;
const RAW_ZOOM_BUCKET_INTERVAL = '5 seconds';

export interface RefreshViewsResult {
  accepted: true;
  alreadyInProgress: boolean;
  view: RefreshView;
}

const REFRESH_ACTIVE_LEASE_SECONDS = 120;
const REFRESH_COOLDOWN_SECONDS = 60;
const REFRESH_LEASE_KEY = 'metric_catalog';
const refreshInFlightByKey = new Map<string, Promise<void>>();

export interface GetTimeseriesParams {
  deviceUuid: string;
  metricName: string;
  timeRange: TimeRange;
  aggregation: Aggregation;
  agentUuid?: string;
  startTime?: Date;
  endTime?: Date;
}

interface QueryWindow {
  startTime: Date;
  endTime: Date;
  spanMs: number;
}

interface ViewSource {
  kind: 'view';
  viewName: string;
  aggregationLevel: string;
}

interface RawSource {
  kind: 'raw';
  bucketInterval: string;
  aggregationLevel: string;
}

type TimeseriesSource = ViewSource | RawSource;

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

export async function getAgents(params: GetAgentsParams) {
  const { protocol, agentUuid } = params;

  let sql = `
    WITH filtered_endpoint_devices AS (
      SELECT *
      FROM endpoint_devices ed
      WHERE ed.device_uuid IS NOT NULL
  `;

  const sqlParams: any[] = [];
  let idx = 0;

  if (protocol) {
    sqlParams.push(protocol);
    sql += ` AND ed.protocol = $${++idx}`;
  }
  if (agentUuid) {
    sqlParams.push(agentUuid);
    sql += ` AND ed.agent_uuid = $${++idx}`;
  }

  sql += `
    ),
    metrics AS (
      SELECT
        ed.device_uuid,
        ed.protocol,
        COUNT(DISTINCT metric)::int                        AS metric_count,
        COALESCE(
          ARRAY_AGG(DISTINCT metric ORDER BY metric),
          ARRAY[]::text[]
        )                                                  AS available_metrics
      FROM filtered_endpoint_devices ed
      CROSS JOIN LATERAL unnest(COALESCE(ed.available_metrics, ARRAY[]::text[])) AS metric
      GROUP BY ed.device_uuid, ed.protocol
    )
    SELECT
      ed.device_uuid::text                                AS device_uuid,
      COALESCE(NULLIF(ed.device_name, ''), 'Unknown device')
                                                          AS device_name,
      ed.protocol,
      MAX(ed.last_seen)                                   AS last_seen,
      COALESCE(MAX(m.metric_count), 0)::int               AS metric_count,
      COALESCE(MAX(m.available_metrics), ARRAY[]::text[]) AS available_metrics,
      COALESCE(AVG(ed.overall_quality_percentage), 0)     AS overall_quality_percentage,
      COUNT(DISTINCT ed.agent_uuid)::int                  AS agent_count,
      ARRAY_AGG(DISTINCT ed.agent_uuid::text ORDER BY ed.agent_uuid::text)
                                                          AS agent_uuids,
      ARRAY_AGG(
        DISTINCT COALESCE(NULLIF(a.name, ''), NULLIF(ed.agent_name, ''), ('Agent ' || left(ed.agent_uuid::text, 8)))
        ORDER BY COALESCE(NULLIF(a.name, ''), NULLIF(ed.agent_name, ''), ('Agent ' || left(ed.agent_uuid::text, 8)))
      )                                                   AS agent_names,
      COALESCE(
        jsonb_agg(
          DISTINCT jsonb_build_object(
            'deviceUuid',   ed.device_uuid::text,
            'endpointUuid', ed.endpoint_uuid::text,
            'agentUuid',    ed.agent_uuid::text,
            'agentName',    COALESCE(NULLIF(a.name, ''), NULLIF(ed.agent_name, ''), ('Agent ' || left(ed.agent_uuid::text, 8))),
            'endpointName', ep.name
          )
        ) FILTER (WHERE ed.endpoint_uuid IS NOT NULL),
        '[]'::jsonb
      )                                                   AS source_refs
    FROM filtered_endpoint_devices ed
    LEFT JOIN metrics m
      ON m.device_uuid = ed.device_uuid
     AND m.protocol = ed.protocol
    LEFT JOIN agents a ON a.uuid = ed.agent_uuid
    LEFT JOIN endpoints ep ON ep.uuid = ed.endpoint_uuid
  `;

  sql += ` GROUP BY ed.device_uuid, COALESCE(NULLIF(ed.device_name, ''), 'Unknown device'), ed.protocol`;
  sql += ` ORDER BY last_seen DESC NULLS LAST`;

  const result = await query(sql, sqlParams);
  return result.rows;
}

export async function getCatalog(params: GetCatalogParams) {
  const { deviceUuid, protocol, agentUuid, metricName } = params;

  let sql = `
    SELECT
      agent_uuid,
      agent_name,
      device_uuid,
      device_name,
      endpoint_uuid,
      protocol,
      metric_name,
      unit,
      sample_count,
      first_seen,
      last_seen,
      avg_value,
      min_value,
      max_value,
      stddev_value,
      quality_percentage,
      avg_anomaly_score,
      max_anomaly_score,
      anomaly_count
    FROM metric_catalog
    WHERE 1=1
  `;

  const sqlParams: any[] = [];
  let idx = 0;

  if (deviceUuid) {
    sqlParams.push(deviceUuid);
    sql += ` AND device_uuid = $${++idx}`;
  }
  if (protocol) {
    sqlParams.push(protocol);
    sql += ` AND protocol = $${++idx}`;
  }
  if (agentUuid) {
    sqlParams.push(agentUuid);
    sql += ` AND agent_uuid = $${++idx}`;
  }
  if (metricName) {
    sqlParams.push(metricName);
    sql += ` AND metric_name = $${++idx}`;
  }

  sql += ` ORDER BY device_uuid, metric_name`;

  const result = await query(sql, sqlParams);
  return result.rows;
}

export async function getLatestReadings(params: GetLatestParams) {
  const { deviceUuid, metricName, agentUuid } = params;

  let sql = `
    SELECT
      agent_uuid,
      device_uuid,
      device_name,
      metric_name,
      time,
      value,
      quality,
      unit,
      protocol,
      ingested_at,
      endpoint_uuid,
      anomaly_score,
      anomaly_threshold,
      agent_name,
      agent_is_online
    FROM latest_readings
    WHERE device_uuid = $1
  `;

  const sqlParams: any[] = [deviceUuid];
  let idx = 1;

  if (metricName) {
    sqlParams.push(metricName);
    sql += ` AND metric_name = $${++idx}`;
  }
  if (agentUuid) {
    sqlParams.push(agentUuid);
    sql += ` AND agent_uuid = $${++idx}`;
  }

  sql += ` ORDER BY metric_name`;

  const result = await query(sql, sqlParams);
  return result.rows;
}

function resolveView(timeRange: TimeRange, aggregation: Aggregation): { viewName: string } {
  if (aggregation !== 'auto') {
    const map: Record<string, string> = { '1min': 'readings_1m', '1hour': 'readings_1h', '1day': 'readings_daily' };
    const viewName = map[aggregation];
    if (!viewName) throw new Error(`Invalid aggregation level: ${aggregation}`);
    return { viewName };
  }

  const map: Record<TimeRange, { viewName: string }> = {
    '1m':  { viewName: 'readings_1m' },
    '1h':  { viewName: 'readings_1m' },
    '6h':  { viewName: 'readings_1m' },
    '12h': { viewName: 'readings_1h' },
    '24h': { viewName: 'readings_1h' },
    '7d':  { viewName: 'readings_hourly' },
    '30d': { viewName: 'readings_daily' },
  };
  return map[timeRange];
}

function resolveStartTime(timeRange: TimeRange, now = new Date()): Date {
  const nowMs = now.getTime();
  const rangeMsByTimeRange: Record<TimeRange, number> = {
    '1m': 60 * 1000,
    '1h': 60 * 60 * 1000,
    '6h': 6 * 60 * 60 * 1000,
    '12h': 12 * 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  };

  return new Date(nowMs - rangeMsByTimeRange[timeRange]);
}

function inferTimeRangeFromSpan(spanMs: number): TimeRange {
  if (spanMs <= 60 * 1000) {
    return '1m';
  }
  if (spanMs <= 60 * 60 * 1000) {
    return '1h';
  }
  if (spanMs <= 6 * 60 * 60 * 1000) {
    return '6h';
  }
  if (spanMs <= 12 * 60 * 60 * 1000) {
    return '12h';
  }
  if (spanMs <= 24 * 60 * 60 * 1000) {
    return '24h';
  }
  if (spanMs <= 7 * 24 * 60 * 60 * 1000) {
    return '7d';
  }
  return '30d';
}

function resolveQueryWindow(timeRange: TimeRange, startTime?: Date, endTime?: Date): QueryWindow {
  const resolvedEndTime = endTime ?? new Date();
  const resolvedStartTime = startTime ?? resolveStartTime(timeRange, resolvedEndTime);
  const spanMs = resolvedEndTime.getTime() - resolvedStartTime.getTime();

  if (!Number.isFinite(spanMs) || spanMs <= 0) {
    throw new Error('Invalid timeseries window: endTime must be greater than startTime.');
  }

  return {
    startTime: resolvedStartTime,
    endTime: resolvedEndTime,
    spanMs,
  };
}

function resolveTimeseriesSource(queryWindow: QueryWindow, aggregation: Aggregation): TimeseriesSource {
  if (aggregation !== 'auto') {
    const map: Record<Exclude<Aggregation, 'auto'>, ViewSource> = {
      '1min': { kind: 'view', viewName: 'readings_1m', aggregationLevel: '1m' },
      '1hour': { kind: 'view', viewName: 'readings_1h', aggregationLevel: '1h' },
      '1day': { kind: 'view', viewName: 'readings_daily', aggregationLevel: 'daily' },
    };
    return map[aggregation];
  }

  if (queryWindow.spanMs <= RAW_ZOOM_MAX_WINDOW_MS) {
    return {
      kind: 'raw',
      bucketInterval: RAW_ZOOM_BUCKET_INTERVAL,
      aggregationLevel: '5s',
    };
  }

  const inferredTimeRange = inferTimeRangeFromSpan(queryWindow.spanMs);
  const { viewName } = resolveView(inferredTimeRange, 'auto');

  return {
    kind: 'view',
    viewName,
    aggregationLevel: viewName.replace('readings_', ''),
  };
}

function buildViewBucketExpr(viewName: string, timeExpr: string): string {
  if (viewName === 'readings_daily') {
    return `time_bucket('1 day', ${timeExpr})`;
  }

  if (viewName === 'readings_1h' || viewName === 'readings_hourly') {
    return `time_bucket('1 hour', ${timeExpr})`;
  }

  return `time_bucket('1 minute', ${timeExpr})`;
}

async function queryFromAggregateView(args: {
  deviceUuid: string;
  metricName: string;
  agentUuid?: string;
  viewName: string;
  queryWindow: QueryWindow;
}) {
  const { deviceUuid, metricName, agentUuid, viewName, queryWindow } = args;
  const buildBucketExpr = (timeExpr: string) => buildViewBucketExpr(viewName, timeExpr);
  const qualityCol = (viewName === 'readings_hourly' || viewName === 'readings_daily')
    ? 'NULL::float as quality_ratio'
    : 'quality_ratio';
  const anomalyCol = viewName === 'readings_1m'
    ? 'max_anomaly_score as anomaly_score'
    : 'NULL::float as anomaly_score';
  const anomalyEventTimeExpr = 'to_timestamp(ae.timestamp_ms::double precision / 1000.0)';
  const anomalyBucketExpr = buildBucketExpr(anomalyEventTimeExpr);
  const aggregateJoinBucketExpr = buildBucketExpr('a.time');

  let filteredWhereSql = `
    WHERE device_uuid = $1::text
      AND metric_name = $2
  `;
  let anomalyWhereSql = `
    WHERE ae.device_uuid = $1::text
      AND ae.metric = $2
  `;

  const sqlParams: unknown[] = [deviceUuid, metricName];
  let idx = 2;

  sqlParams.push(queryWindow.startTime);
  filteredWhereSql += ` AND bucket >= $${++idx}::timestamptz`;
  anomalyWhereSql += ` AND to_timestamp(ae.timestamp_ms::double precision / 1000.0) >= $${idx}::timestamptz`;

  sqlParams.push(queryWindow.endTime);
  filteredWhereSql += ` AND bucket <= $${++idx}::timestamptz`;
  anomalyWhereSql += ` AND to_timestamp(ae.timestamp_ms::double precision / 1000.0) <= $${idx}::timestamptz`;

  if (agentUuid) {
    sqlParams.push(agentUuid);
    filteredWhereSql += ` AND agent_uuid = $${++idx}::uuid`;
    anomalyWhereSql += ` AND ae.agent_uuid = $${idx}::text`;
  }

  const sql = `
    WITH filtered AS (
      SELECT
        bucket,
        agent_uuid,
        device_uuid,
        endpoint_uuid,
        avg_value,
        min_value,
        max_value,
        sample_count,
        ${qualityCol},
        ${anomalyCol}
      FROM ${viewName}
      ${filteredWhereSql}
    ),
    aggregated AS (
      SELECT
        bucket AS time,
        agent_uuid,
        device_uuid,
        endpoint_uuid,
        CASE
          WHEN SUM(sample_count) > 0 THEN SUM(avg_value * sample_count)::double precision / SUM(sample_count)
          ELSE AVG(avg_value)
        END AS avg_value,
        MIN(min_value)              AS min_value,
        MAX(max_value)              AS max_value,
        SUM(sample_count)::bigint   AS sample_count,
        MAX(quality_ratio)          AS quality_ratio,
        MAX(anomaly_score)          AS anomaly_score
      FROM filtered
      GROUP BY bucket, agent_uuid, device_uuid, endpoint_uuid
    ),
    anomaly_buckets AS (
      SELECT
        ${anomalyBucketExpr}                    AS bucket,
        COUNT(*)::int                           AS anomaly_event_count,
        MAX(ae.anomaly_score)::double precision AS anomaly_score,
        MAX(ae.confidence)::double precision    AS anomaly_confidence
      FROM anomaly_events ae
      ${anomalyWhereSql}
      GROUP BY 1
    )
    SELECT
      a.time,
      a.agent_uuid,
      a.device_uuid,
      a.endpoint_uuid,
      a.avg_value,
      a.min_value,
      a.max_value,
      a.sample_count,
      a.quality_ratio,
      COALESCE(a.anomaly_score, ab.anomaly_score) AS anomaly_score,
      ab.anomaly_confidence,
      COALESCE(ab.anomaly_event_count, 0)::int    AS anomaly_event_count
    FROM aggregated a
    LEFT JOIN anomaly_buckets ab ON ab.bucket = ${aggregateJoinBucketExpr}
    ORDER BY a.time ASC
  `;

  return query(sql, sqlParams);
}

async function queryFromRawReadings(args: {
  deviceUuid: string;
  metricName: string;
  agentUuid?: string;
  bucketInterval: string;
  queryWindow: QueryWindow;
}) {
  const { deviceUuid, metricName, agentUuid, bucketInterval, queryWindow } = args;
  const bucketExpr = `time_bucket('${bucketInterval}', time)`;
  const anomalyBucketExpr = `time_bucket('${bucketInterval}', to_timestamp(ae.timestamp_ms::double precision / 1000.0))`;

  let filteredWhereSql = `
    WHERE COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')) = $1::text
      AND metric_name = $2
      AND time >= $3::timestamptz
      AND time <= $4::timestamptz
  `;
  let anomalyWhereSql = `
    WHERE ae.device_uuid = $1::text
      AND ae.metric = $2
      AND to_timestamp(ae.timestamp_ms::double precision / 1000.0) >= $3::timestamptz
      AND to_timestamp(ae.timestamp_ms::double precision / 1000.0) <= $4::timestamptz
  `;

  const sqlParams: unknown[] = [deviceUuid, metricName, queryWindow.startTime, queryWindow.endTime];
  let idx = 4;

  if (agentUuid) {
    sqlParams.push(agentUuid);
    filteredWhereSql += ` AND agent_uuid = $${++idx}::uuid`;
    anomalyWhereSql += ` AND ae.agent_uuid = $${idx}::text`;
  }

  const sql = `
    WITH filtered AS (
      SELECT
        time,
        agent_uuid,
        COALESCE(NULLIF(extra->>'device_uuid', ''), NULLIF(extra->>'deviceUuid', '')) AS device_uuid,
        COALESCE(NULLIF(extra->>'endpoint_uuid', ''), NULLIF(extra->>'endpointUuid', '')) AS endpoint_uuid,
        value,
        quality,
        anomaly_score
      FROM readings
      ${filteredWhereSql}
    ),
    aggregated AS (
      SELECT
        ${bucketExpr}                              AS time,
        agent_uuid,
        device_uuid,
        endpoint_uuid,
        AVG(value)::double precision               AS avg_value,
        MIN(value)::double precision               AS min_value,
        MAX(value)::double precision               AS max_value,
        COUNT(*)::bigint                           AS sample_count,
        SUM(CASE WHEN quality = 'good' THEN 1 ELSE 0 END)::double precision / NULLIF(COUNT(*), 0) AS quality_ratio,
        MAX(anomaly_score)::double precision       AS anomaly_score
      FROM filtered
      GROUP BY 1, 2, 3, 4
    ),
    anomaly_buckets AS (
      SELECT
        ${anomalyBucketExpr}                       AS bucket,
        COUNT(*)::int                              AS anomaly_event_count,
        MAX(ae.anomaly_score)::double precision    AS anomaly_score,
        MAX(ae.confidence)::double precision       AS anomaly_confidence
      FROM anomaly_events ae
      ${anomalyWhereSql}
      GROUP BY 1
    )
    SELECT
      a.time,
      a.agent_uuid,
      a.device_uuid,
      a.endpoint_uuid,
      a.avg_value,
      a.min_value,
      a.max_value,
      a.sample_count,
      a.quality_ratio,
      COALESCE(a.anomaly_score, ab.anomaly_score) AS anomaly_score,
      ab.anomaly_confidence,
      COALESCE(ab.anomaly_event_count, 0)::int    AS anomaly_event_count
    FROM aggregated a
    LEFT JOIN anomaly_buckets ab ON ab.bucket = a.time
    ORDER BY a.time ASC
  `;

  return query(sql, sqlParams);
}

export async function getTimeseries(params: GetTimeseriesParams) {
  const { deviceUuid, metricName, timeRange, aggregation, agentUuid, startTime, endTime } = params;
  const queryWindow = resolveQueryWindow(timeRange, startTime, endTime);
  const source = resolveTimeseriesSource(queryWindow, aggregation);

  const [dataResult, metaResult] = await Promise.all([
    source.kind === 'raw'
      ? queryFromRawReadings({
          deviceUuid,
          metricName,
          agentUuid,
          bucketInterval: source.bucketInterval,
          queryWindow,
        })
      : queryFromAggregateView({
          deviceUuid,
          metricName,
          agentUuid,
          viewName: source.viewName,
          queryWindow,
        }),
    query(
      `SELECT unit, protocol, quality_percentage
       FROM metric_catalog
       WHERE device_uuid = $1 AND metric_name = $2
       LIMIT 1`,
      [deviceUuid, metricName]
    ),
  ]);

  const metadata = metaResult.rows[0] || {};

  return {
    metric: {
      deviceUuid,
      metricName,
      unit: metadata.unit,
      protocol: metadata.protocol,
    },
    metadata: {
      sampleCount: dataResult.rows.length,
      startTime: dataResult.rows[0]?.time,
      endTime: dataResult.rows[dataResult.rows.length - 1]?.time,
      aggregationLevel: source.aggregationLevel,
      timeRange,
      qualityPercentage: metadata.quality_percentage,
    },
    data: dataResult.rows,
  };
}

export async function refreshViews(view: RefreshView): Promise<RefreshViewsResult> {
  const sqlMap: Record<RefreshView, string> = {
    catalog: 'SELECT refresh_metric_catalog()',
    agents:  'SELECT refresh_endpoint_devices()',
    latest:  'SELECT refresh_latest_readings()',
    all:     'SELECT refresh_all_catalog_views()',
  };

  if (refreshInFlightByKey.has(REFRESH_LEASE_KEY)) {
    return {
      accepted: true,
      alreadyInProgress: true,
      view,
    };
  }

  await query(
    `INSERT INTO refresh_control (key, last_refresh, lease_until)
     VALUES ($1, 'epoch', 'epoch')
     ON CONFLICT (key) DO NOTHING`,
    [REFRESH_LEASE_KEY]
  );

  const claim = await query(
    `UPDATE refresh_control
       SET last_refresh = NOW(),
           lease_until  = NOW() + make_interval(secs => $2)
     WHERE key = $1
       AND NOW() > lease_until
     RETURNING 1`,
    [REFRESH_LEASE_KEY, REFRESH_ACTIVE_LEASE_SECONDS]
  );

  if (claim.rowCount === 0) {
    return {
      accepted: true,
      alreadyInProgress: true,
      view,
    };
  }

  const refreshTask = (async () => {
    try {
      await query(sqlMap[view]);
      logger.info('Completed metrics view refresh', {
        view,
        leaseKey: REFRESH_LEASE_KEY,
      });
    } catch (error: any) {
      logger.error('Failed metrics view refresh', {
        view,
        leaseKey: REFRESH_LEASE_KEY,
        error: error?.message || String(error),
      });
    } finally {
      await query(
        `UPDATE refresh_control
           SET lease_until = NOW() + make_interval(secs => $2)
         WHERE key = $1`,
        [REFRESH_LEASE_KEY, REFRESH_COOLDOWN_SECONDS]
      ).catch((releaseError: any) => {
        logger.warn('Failed to release metrics refresh lease', {
          view,
          leaseKey: REFRESH_LEASE_KEY,
          error: releaseError?.message || String(releaseError),
        });
      });
      refreshInFlightByKey.delete(REFRESH_LEASE_KEY);
    }
  })();

  refreshInFlightByKey.set(REFRESH_LEASE_KEY, refreshTask);

  return {
    accepted: true,
    alreadyInProgress: false,
    view,
  };
}
