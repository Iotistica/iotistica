# Advanced Readings Query

**Endpoint**: `POST /api/v1/readings/query`  
**Auth**: JWT required  

The advanced query endpoint executes one or more sub-queries in a single request against the `readings` TimescaleDB hypertable. Each sub-query can independently apply downsampling, rate/derivative calculation, tag-based filtering, group-by dimensions, and percentile aggregation.

---

## Request body

```json
{
  "start": "<time>",
  "end": "<time>",
  "queries": [ <SubQuery>, ... ]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `start` | string | Yes | ISO 8601 timestamp or relative offset (`1h-ago`, `7d-ago`, `30m-ago`) |
| `end` | string | No | ISO 8601 or relative offset. Defaults to `now`. |
| `queries` | SubQuery[] | Yes | 1–20 sub-queries executed in parallel |

### SubQuery fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `metric` | string | — | Metric name. Must match `[a-zA-Z0-9_.-]+` |
| `agent_uuids` | string[] | — | Restrict to specific agents. Required unless `filters` narrows scope |
| `aggregator` | `avg\|sum\|min\|max\|last\|count` | `avg` | Aggregation applied per bucket |
| `downsample` | string | `1h-avg` | `<N><unit>-<fn>` — e.g. `15m-avg`, `1h-max`, `5m-sum` |
| `rate` | boolean | `false` | Return per-second rate of change instead of raw value |
| `rate_options` | object | — | Counter rollover settings (see below) |
| `filters` | TagFilter[] | — | Tag-based filter and/or group-by rules |
| `percentiles` | number[] | — | Return percentile columns instead of value. e.g. `[50, 95, 99]` |

### TagFilter fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `exact\|wildcard\|regexp` | Match type. Wildcard maps `*` → `%`, `?` → `_` (SQL LIKE). Regexp uses POSIX. |
| `tagk` | string | `protocol` (direct column) or any key in the `extra` JSONB (e.g. `device_name`, `site_id`) |
| `filter` | string | The value, pattern, or expression to match |
| `group_by` | boolean | Split results into one series per unique value of this tag |

### RateOptions fields

| Field | Type | Description |
|-------|------|-------------|
| `counter` | boolean | Metric is a monotonic counter (handles rollover). Default: `false` |
| `counter_max` | number | Counter maximum value before rollover. Default: `2^53` |
| `reset_value` | number | Value emitted when a reset is detected (non-counter mode). Default: point dropped |

---

## Response shape

```json
{
  "query_count": 2,
  "start": "1h-ago",
  "end": "now",
  "results": [
    [ <SubQueryResult>, ... ],
    [ <SubQueryResult>, ... ]
  ]
}
```

Each element of `results` corresponds to one sub-query. A sub-query returns one result object per unique `(agent_uuid, group_by_tag_values)` combination.

```json
{
  "metric": "power_kwh",
  "agent_uuid": "3fa85f64-...",
  "tags": { "device_name": "pump_01" },
  "dps": [
    { "time": "2026-04-19T00:00:00.000Z", "value": 4.72 },
    { "time": "2026-04-19T01:00:00.000Z", "value": 4.85 }
  ]
}
```

For percentile queries, `dps` contains percentile keys instead of `value`:

```json
{
  "dps": [
    { "time": "2026-04-19T00:00:00.000Z", "p50": 0.12, "p95": 0.34, "p99": 0.89 }
  ]
}
```

---

## Examples

### 1. Simple multi-metric fetch

Fetch temperature and humidity for one agent over the last 6 hours, downsampled to 15-minute averages.

```json
{
  "start": "6h-ago",
  "queries": [
    {
      "metric": "temperature",
      "agent_uuids": ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
      "downsample": "15m-avg"
    },
    {
      "metric": "humidity",
      "agent_uuids": ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
      "downsample": "15m-avg"
    }
  ]
}
```

**Use case**: Dashboard page that needs two panels — a single round-trip instead of two sequential requests. Useful for Digital Twin pages rendering 8–12 metrics simultaneously.

---

### 2. Rate calculation — energy meter (kWh counter)

A Modbus energy meter stores cumulative kWh. The raw counter value is meaningless for trending. This query converts it to instantaneous power in kW.

```json
{
  "start": "24h-ago",
  "queries": [
    {
      "metric": "energy_kwh",
      "agent_uuids": ["3fa85f64-5717-4562-b3fc-2c963f66afa6"],
      "downsample": "1h-avg",
      "rate": true,
      "rate_options": {
        "counter": true,
        "counter_max": 999999
      }
    }
  ]
}
```

**Why `counter: true`**: The energy meter resets to 0 when it overflows at 999,999 kWh. Without this flag, the rollover would produce a massive negative spike. With it, the corrected delta is `(999999 - prev + current) / elapsed_seconds`.

**Returned unit**: kWh/second → multiply client-side by 3600 to get kW average over the bucket.

---

### 3. Rate calculation — gas pulse counter

A gas meter sends pulse counts (each pulse = 0.001 m³). You want flow rate in m³/hour to detect abnormal consumption.

```json
{
  "start": "7d-ago",
  "queries": [
    {
      "metric": "gas_pulses",
      "agent_uuids": ["9c40a5b2-..."],
      "downsample": "1h-sum",
      "aggregator": "sum",
      "rate": false
    }
  ]
}
```

Note: use `aggregator: "sum"` with `downsample: "1h-sum"` here — sum the pulses per hour, multiply by 0.001 on the client. For per-second flow rate: set `rate: true`, `downsample: "5m-sum"`.

---

### 4. Wildcard tag filter — all pumps on a site

You have 12 Modbus pump controllers. Their `device_name` (stored in `extra`) follows the pattern `pump_01`, `pump_02`, etc. Query the average power draw across all of them as a single aggregated series.

```json
{
  "start": "1h-ago",
  "queries": [
    {
      "metric": "power_w",
      "filters": [
        {
          "type": "wildcard",
          "tagk": "device_name",
          "filter": "pump_*"
        }
      ],
      "downsample": "5m-avg",
      "aggregator": "avg"
    }
  ]
}
```

**Result**: One time series averaged across all matching pumps. Useful for fleet-level dashboards.

---

### 5. Group-by — per-pump power breakdown

Same pump fleet, but split into one series per pump to compare individual performance.

```json
{
  "start": "1h-ago",
  "queries": [
    {
      "metric": "power_w",
      "filters": [
        {
          "type": "wildcard",
          "tagk": "device_name",
          "filter": "pump_*",
          "group_by": true
        }
      ],
      "downsample": "5m-avg"
    }
  ]
}
```

**Result**: 12 separate `SubQueryResult` objects, each with `tags: { device_name: "pump_01" }` etc. Useful for detecting which pump is underperforming against the fleet baseline.

---

### 6. Group-by on protocol — compare Modbus vs OPC UA readings

You have sensors reporting the same metric via different protocols. This shows whether there is a systematic offset between them.

```json
{
  "start": "24h-ago",
  "queries": [
    {
      "metric": "temperature",
      "agent_uuids": ["3fa85f64-..."],
      "filters": [
        {
          "type": "regexp",
          "tagk": "protocol",
          "filter": "^(modbus|opcua)$",
          "group_by": true
        }
      ],
      "downsample": "15m-avg"
    }
  ]
}
```

**Result**: Two series — one for `protocol: modbus`, one for `protocol: opcua`. Useful for sensor calibration validation.

---

### 7. Percentile query — vibration analysis for predictive maintenance

A vibration sensor samples at 100Hz and is pre-aggregated to 1-minute readings. You want to know not just the average vibration but the P95/P99 to catch resonance spikes that predict bearing failure.

```json
{
  "start": "7d-ago",
  "queries": [
    {
      "metric": "vibration_mm_s",
      "agent_uuids": ["9c40a5b2-..."],
      "downsample": "1h-avg",
      "percentiles": [50, 90, 95, 99]
    }
  ]
}
```

**Response dps example**:
```json
{ "time": "2026-04-19T00:00:00.000Z", "p50": 0.12, "p90": 0.31, "p95": 0.52, "p99": 1.87 }
```

**Interpretation**: P50=0.12 looks healthy. P99=1.87 is 15× the median — a spike pattern consistent with loosening bearing. This anomaly is completely invisible in average-based queries.

---

### 8. Percentile query — API response latency SLA monitoring

Your agent reports round-trip polling latency in milliseconds. SLA requires P95 < 500ms.

```json
{
  "start": "24h-ago",
  "queries": [
    {
      "metric": "poll_latency_ms",
      "filters": [
        { "type": "exact", "tagk": "site_id", "filter": "site-london-01" }
      ],
      "downsample": "15m-avg",
      "percentiles": [50, 95, 99]
    }
  ]
}
```

---

### 9. Combined: rate + group-by per device + percentile (two sub-queries)

A real-world dashboard for a cooling plant: show per-chiller power draw (rate from kWh counter) and vibration P99 for the last 8 hours.

```json
{
  "start": "8h-ago",
  "queries": [
    {
      "metric": "energy_kwh",
      "filters": [
        {
          "type": "wildcard",
          "tagk": "device_name",
          "filter": "chiller_*",
          "group_by": true
        }
      ],
      "downsample": "15m-avg",
      "rate": true,
      "rate_options": { "counter": true, "counter_max": 999999 }
    },
    {
      "metric": "vibration_mm_s",
      "filters": [
        {
          "type": "wildcard",
          "tagk": "device_name",
          "filter": "chiller_*",
          "group_by": true
        }
      ],
      "downsample": "15m-avg",
      "percentiles": [95, 99]
    }
  ]
}
```

**Result**: `results[0]` = N power-rate series (one per chiller). `results[1]` = N percentile series (one per chiller). Both returned in one HTTP round-trip.

---

## Downsample interval reference

| Format | Interval | Example |
|--------|----------|---------|
| `Ns-fn` | N seconds | `30s-avg` |
| `Nm-fn` | N minutes | `5m-max` |
| `Nh-fn` | N hours | `1h-sum` |
| `Nd-fn` | N days | `1d-avg` |
| `Nw-fn` | N weeks | `1w-avg` |

Supported aggregation functions: `avg`, `sum`, `min`, `max`, `last`, `count`.

---

## Constraints and limits

| Parameter | Limit |
|-----------|-------|
| Sub-queries per request | 20 |
| Filters per sub-query | 10 |
| Percentile values per sub-query | 10 |
| Agent UUIDs per sub-query | No hard limit (consider performance) |
| `rate` + `percentiles` combined | Not allowed (use separate sub-queries) |
| `tagk` format | `[a-zA-Z0-9_.-]+` (rejects special chars) |

---

## Performance notes

- Sub-queries run in parallel (`Promise.all`). N sub-queries do not add N× latency.
- Percentile queries scan raw `readings` rows within the time window. For windows > 7 days with high-frequency metrics, prefer the pre-aggregated `readings_hourly` or `readings_daily` endpoints for `avg/min/max`.
- Adding `agent_uuids` is the most effective way to reduce scan cost. Without it, the query scans all agents matching only the tag filters.
- `group_by` on a high-cardinality JSONB field (e.g. `device_uuid`) returns many result objects — cap the time window or add additional `agent_uuids` to avoid large responses.
