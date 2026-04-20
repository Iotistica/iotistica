/**
 * Advanced Query Service
 *
 * Executes OpenTSDB-inspired sub-queries against the readings hypertable.
 * Supports: rate/derivative, multi-metric, tag-based wildcard filtering,
 * group-by, and histogram/percentile queries.
 */

import { query } from '../../db/connection';

// ── Public types ─────────────────────────────────────────────────────────────

export type Aggregator = 'avg' | 'sum' | 'min' | 'max' | 'last' | 'count';

export interface RateOptions {
  /**
   * Treat the metric as a monotonic counter that can roll over.
   * Negative deltas are corrected using counter_max.
   */
  counter?: boolean;
  /** Maximum counter value before rollover. Defaults to 2^53. */
  counter_max?: number;
  /** Rate value emitted when a reset is detected and counter=false. Default: null (point dropped). */
  reset_value?: number;
}

export interface TagFilter {
  /** How to match: exact string, SQL LIKE wildcard (* → %, ? → _), or POSIX regexp. */
  type: 'exact' | 'wildcard' | 'regexp';
  /**
   * Tag key. Built-in column: 'protocol'.
   * Any other key is looked up inside the extra JSONB object (e.g. 'device_name', 'site_id').
   * Must match /^[a-zA-Z0-9_.-]+$/.
   */
  tagk: string;
  /** The filter value or pattern. */
  filter: string;
  /** When true the result is split into one series per unique value of this tag. */
  group_by?: boolean;
}

export interface SubQuery {
  /** Metric name to query. Must match /^[a-zA-Z0-9_.-]+$/. */
  metric: string;
  /** Restrict to specific agent UUIDs. At least one of agent_uuids or filters should narrow scope. */
  agent_uuids?: string[];
  /** Aggregation function applied after downsampling. Default: 'avg'. */
  aggregator?: Aggregator;
  /**
   * Downsample interval + function.
   * Format: "<N><unit>-<fn>", e.g. "1h-avg", "15m-max", "5m-sum".
   * Units: s=second, m=minute, h=hour, d=day, w=week. Default: "1h-avg".
   */
  downsample?: string;
  /** Return rate of change per second instead of raw aggregated values. */
  rate?: boolean;
  /** Fine-tune rate/counter behaviour. Only used when rate=true. */
  rate_options?: RateOptions;
  /** Tag-based filters and group-by dimensions. */
  filters?: TagFilter[];
  /**
   * Return percentile values in place of the aggregated value.
   * Values are 0–100, e.g. [50, 95, 99].
   * Cannot be combined with rate=true.
   */
  percentiles?: number[];
}

export interface AdvancedQueryInput {
  /** ISO 8601 timestamp or relative offset (e.g. "1h-ago", "7d-ago"). */
  start: string;
  /** ISO 8601 end time. Defaults to now. */
  end?: string;
  /** One or more sub-queries executed in parallel. */
  queries: SubQuery[];
}

export interface DataPoint {
  time: string;
  value: number;
}

export interface PercentileDataPoint {
  time: string;
  [pKey: string]: number | string; // e.g. "p50", "p95", "p99"
}

export interface SubQueryResult {
  metric: string;
  agent_uuid: string;
  tags: Record<string, string>;
  dps: DataPoint[];
}

export interface PercentileSubQueryResult {
  metric: string;
  agent_uuid: string;
  tags: Record<string, string>;
  dps: PercentileDataPoint[];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const RELATIVE_RE = /^(\d+)(s|m|h|d|w)-ago$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
};

function parseTime(t: string): Date {
  const rel = RELATIVE_RE.exec(t);
  if (rel) return new Date(Date.now() - parseInt(rel[1], 10) * (UNIT_MS[rel[2]] ?? 0));
  const d = new Date(t);
  if (isNaN(d.getTime())) throw new Error(`Invalid time value: ${t}`);
  return d;
}

const DOWNSAMPLE_RE = /^(\d+)(s|m|h|d|w)-(\w+)$/;
const UNIT_SQL: Record<string, string> = {
  s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week',
};
const VALID_AGGREGATORS = new Set<string>(['avg', 'sum', 'min', 'max', 'last', 'count']);

function parseDownsample(ds?: string): { interval: string; fn: Aggregator } {
  if (!ds) return { interval: '1 hour', fn: 'avg' };
  const m = DOWNSAMPLE_RE.exec(ds);
  if (!m) return { interval: '1 hour', fn: 'avg' };
  const interval = `${m[1]} ${UNIT_SQL[m[2]] ?? 'hour'}`;
  const fn = VALID_AGGREGATORS.has(m[3]) ? (m[3] as Aggregator) : 'avg';
  return { interval, fn };
}

function buildAggExpr(fn: Aggregator): string {
  if (fn === 'last') return 'last(value, time)'; // TimescaleDB last()
  if (fn === 'count') return 'COUNT(value)::double precision';
  return `${fn.toUpperCase()}(value)`;
}

function wildcardToLike(pattern: string): string {
  return pattern
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/\*/g, '%')
    .replace(/\?/g, '_');
}

/** Asserts tag key is safe for inline SQL (validated by Zod at the route layer too). */
function assertSafeTagKey(tagk: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(tagk)) {
    throw new Error(`Unsafe tag key rejected: ${tagk}`);
  }
}

function tagColExpr(tagk: string): string {
  assertSafeTagKey(tagk);
  if (tagk === 'protocol') return 'protocol';
  // Single quotes inside tagk are prevented by assertSafeTagKey (no ' in allowed chars)
  return `extra->>'${tagk}'`;
}

interface GbCol {
  innerExpr: string; // expression used in CTE / inner SELECT
  alias: string;     // positional alias gb_0, gb_1, …
  tagk: string;      // original key for output tags map
}

function buildGroupByCols(filters: TagFilter[]): GbCol[] {
  return filters
    .filter(f => f.group_by)
    .map((f, i) => ({
      innerExpr: tagColExpr(f.tagk),
      alias: `gb_${i}`,
      tagk: f.tagk,
    }));
}

type DbParams = Array<unknown>;

function appendFilterConditions(
  filters: TagFilter[],
  params: DbParams,
  pi: number,
): { conditions: string[]; nextPi: number } {
  const conditions: string[] = [];
  for (const f of filters) {
    const col = tagColExpr(f.tagk);
    switch (f.type) {
      case 'wildcard':
        params.push(wildcardToLike(f.filter));
        conditions.push(`${col} LIKE $${pi++}`);
        break;
      case 'regexp':
        params.push(f.filter);
        conditions.push(`${col} ~ $${pi++}`);
        break;
      default: // exact
        params.push(f.filter);
        conditions.push(`${col} = $${pi++}`);
    }
  }
  return { conditions, nextPi: pi };
}

type DbRow = Record<string, unknown>;

function groupRows(
  rows: DbRow[],
  metric: string,
  gbCols: GbCol[],
  isPercentile: boolean,
  percentiles: number[],
): (SubQueryResult | PercentileSubQueryResult)[] {
  const map = new Map<string, SubQueryResult | PercentileSubQueryResult>();

  for (const row of rows) {
    const agentUuid = String(row['agent_uuid'] ?? '');
    const tagValues = gbCols.map(c => String(row[c.alias] ?? ''));
    const key = [agentUuid, ...tagValues].join('\x00');

    if (!map.has(key)) {
      const tags: Record<string, string> = {};
      gbCols.forEach((c, i) => { tags[c.tagk] = tagValues[i]; });
      map.set(key, { metric, agent_uuid: agentUuid, tags, dps: [] });
    }

    const entry = map.get(key)!;
    const time = row['time'] instanceof Date
      ? row['time'].toISOString()
      : String(row['time']);

    if (isPercentile) {
      const dp: PercentileDataPoint = { time };
      for (const p of percentiles) {
        const k = `p${p}`;
        dp[k] = row[k] != null ? Number(row[k]) : 0;
      }
      (entry as PercentileSubQueryResult).dps.push(dp);
    } else {
      (entry as SubQueryResult).dps.push({
        time,
        value: row['value'] != null ? Number(row['value']) : 0,
      });
    }
  }

  return Array.from(map.values());
}

// ── Core query builder ────────────────────────────────────────────────────────

export async function executeSubQuery(
  sq: SubQuery,
  start: Date,
  end: Date,
): Promise<(SubQueryResult | PercentileSubQueryResult)[]> {
  const { interval, fn: dsFunc } = parseDownsample(sq.downsample);
  const aggregator = sq.aggregator ?? dsFunc;
  const isPercentile = (sq.percentiles?.length ?? 0) > 0;
  const isRate = sq.rate === true && !isPercentile;
  const gbCols = buildGroupByCols(sq.filters ?? []);

  // ── Build params ──
  const params: DbParams = [];
  let pi = 1;

  // Fixed positional params: $1 = interval, $2 = metric, $3 = start, $4 = end
  params.push(interval, sq.metric, start, end);
  pi = 5; // next free index

  const conditions: string[] = [
    `metric_name = $2`,
    `time >= $3`,
    `time <= $4`,
    `value IS NOT NULL`,
  ];

  if (sq.agent_uuids?.length) {
    params.push(sq.agent_uuids);
    conditions.push(`agent_uuid = ANY($${pi++}::uuid[])`);
  }

  const { conditions: filterConds, nextPi } = appendFilterConditions(
    sq.filters ?? [], params, pi,
  );
  pi = nextPi;
  conditions.push(...filterConds);

  const where = conditions.join('\n        AND ');

  // ── Group-by column fragments ──
  const gbInnerSelect = gbCols.map(c => `,\n          ${c.innerExpr} AS ${c.alias}`).join('');
  const gbGroupBy     = gbCols.map(c => `, ${c.alias}`).join('');
  const gbOuterSelect = gbCols.map(c => `, ${c.alias}`).join('');
  const gbPartition   = gbCols.map(c => `, ${c.alias}`).join('');

  let sql: string;

  if (isPercentile) {
    // ── Percentile path ──
    const pCols = sq.percentiles!.map(p => {
      params.push(p / 100);
      return `,\n        percentile_cont($${pi++}) WITHIN GROUP (ORDER BY value) AS "p${p}"`;
    });

    sql = `
      SELECT
        time_bucket($1::interval, time) AS time,
        agent_uuid,
        metric_name
        ${gbInnerSelect}
        ${pCols.join('')}
      FROM readings
      WHERE ${where}
      GROUP BY time_bucket($1::interval, time), agent_uuid, metric_name${gbGroupBy}
      ORDER BY time ASC
    `;

  } else if (isRate) {
    // ── Rate/derivative path ──
    const aggExpr = buildAggExpr(aggregator);
    const isCounter = sq.rate_options?.counter ?? false;
    const counterMax = sq.rate_options?.counter_max ?? Number.MAX_SAFE_INTEGER;

    // Inline the boolean literal (not user input — already typed as boolean)
    const counterMaxRef = isCounter ? `$${pi}` : 'NULL';
    if (isCounter) {
      params.push(counterMax);
      pi++;
    }

    sql = `
      WITH base AS (
        SELECT
          time_bucket($1::interval, time) AS time,
          agent_uuid,
          metric_name
          ${gbInnerSelect},
          ${aggExpr} AS agg_value
        FROM readings
        WHERE ${where}
        GROUP BY time_bucket($1::interval, time), agent_uuid, metric_name${gbGroupBy}
      )
      SELECT
        time,
        agent_uuid,
        metric_name
        ${gbOuterSelect},
        CASE
          WHEN LAG(agg_value) OVER w IS NULL THEN NULL
          WHEN agg_value >= LAG(agg_value) OVER w THEN
            (agg_value - LAG(agg_value) OVER w) /
            NULLIF(EXTRACT(EPOCH FROM (time - LAG(time) OVER w)), 0)
          WHEN ${isCounter ? `TRUE` : `FALSE`} THEN
            (${counterMaxRef}::double precision - LAG(agg_value) OVER w + agg_value) /
            NULLIF(EXTRACT(EPOCH FROM (time - LAG(time) OVER w)), 0)
          ELSE NULL
        END AS value
      FROM base
      WINDOW w AS (PARTITION BY agent_uuid, metric_name${gbPartition} ORDER BY time)
      ORDER BY time ASC
    `;

  } else {
    // ── Standard aggregate path ──
    const aggExpr = buildAggExpr(aggregator);

    sql = `
      SELECT
        time_bucket($1::interval, time) AS time,
        agent_uuid,
        metric_name
        ${gbInnerSelect},
        ${aggExpr} AS value
      FROM readings
      WHERE ${where}
      GROUP BY time_bucket($1::interval, time), agent_uuid, metric_name${gbGroupBy}
      ORDER BY time ASC
    `;
  }

  const dbResult = await query<DbRow>(sql, params);

  // Filter out NULL-value rate rows (first row per series, or reset points)
  const rows = isRate
    ? dbResult.rows.filter(r => r['value'] != null)
    : dbResult.rows;

  return groupRows(rows, sq.metric, gbCols, isPercentile, sq.percentiles ?? []);
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function executeQuery(
  input: AdvancedQueryInput,
): Promise<(SubQueryResult | PercentileSubQueryResult)[][]> {
  const start = parseTime(input.start);
  const end = input.end ? parseTime(input.end) : new Date();
  return Promise.all(input.queries.map(sq => executeSubQuery(sq, start, end)));
}
