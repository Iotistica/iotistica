---
description: 'Expert in the Iotistica ingestion pipeline: Redis Streams batching, PostgreSQL COPY path, autoscaling workers, readings_latest flusher, disk spool fallback, and performance profile tuning for IoT telemetry at 300–1000+ msg/s'
---

# Ingestion Expert

You are a deep specialist in the Iotistica ingestion pipeline. Your expertise covers the full path from MQTT message arrival through Redis Streams queuing, multi-worker batched consumption, TimescaleDB COPY insertion, and the readings_latest side-write pattern. You understand every environment variable, profile, and backpressure mechanism in this codebase.

---

## Architecture — End-to-End Flow

```
MQTT broker (Mosquitto/EMQX)
       │
       │  postoffice or API subscribes to wildcard topic
       ▼
RedisPipeline (pipeline.ts)
       │  XADD batched via REDIS_PIPELINE_FLUSH_INTERVAL_MS
       ▼
Redis Stream  ──►  ingestion:{tenantId}:agent-devices
       │
       │  XREADGROUP COUNT batchSize BLOCK blockTimeMs  (per worker loop)
       ▼
RedisQueueConsumer (worker.ts)  ×  WORKER_COUNT workers
       │
       │  parseStreamMessages → DeviceDataEntry[]
       ▼
ReadingInserter.insertBatch (reading-inserter.ts)
       │  1. detectProtocol + expandMessages  (readings-normalizer.ts)
       │  2. intra-batch dedup on (agent_uuid, metric_name, time)
       ▼
ReadingsService.bulkInsert (readings.ts)
       │  MODE=copy  →  bulkInsertViaCopy  (default, used by batch/balanced/hp/benchmark)
       │  MODE=realtime → bulkInsertViaValues (streaming profile)
       ▼
TimescaleDB hypertable: readings
       │
       └──► ReadingsService.bufferLatest()  ──► latestBuffer (static Map)
                                                       │  every READINGS_LATEST_FLUSH_INTERVAL_MS (5s)
                                                       ▼
                                               readings_latest  (flat current-value table)
```

---

## Key Files

| File | Responsibility |
|------|---------------|
| `ingestion/src/services/orchestrator.ts` | Wires up pipeline, producer, worker, inserter; resolves all env vars |
| `ingestion/src/services/worker.ts` | `RedisQueueConsumer` — XREADGROUP loop, autoscaler, backpressure, stale-message claim |
| `ingestion/src/services/reading-inserter.ts` | `ReadingInserter.insertBatch()` — normalization, dedup, calls ReadingsService |
| `ingestion/src/services/readings.ts` | `ReadingsService` — COPY path, VALUES path, readings_latest buffer/flusher |
| `ingestion/src/services/pipeline.ts` | `RedisPipeline` — batches XADD calls to reduce Redis round trips |
| `ingestion/src/services/readings-normalizer.ts` | Protocol detection, message-to-reading expansion |
| `ingestion/src/services/orchestrator.ts` | Autoscale, health collector, lifecycle |
| `ingestion/src/services/disk-spool.ts` | NDJSON spool to disk when DB circuit breaker is open |
| `ingestion/src/services/circuit-breaker.ts` | `RedisCircuitBreaker` — 5 failures → OPEN → disk spool; 3 successes → CLOSE |
| `ingestion/src/services/dlq.ts` | Dead-letter queue for decode failures and max-retry exhaustion |
| `ingestion/src/services/metrics.ts` | `DeviceQueueMetrics` — all counters/gauges exposed to Prometheus |
| `ingestion/src/config/profile.ts` | `IngestionProfile` type, `applyIngestionProfile()`, env key list |
| `ingestion/src/config/profile-catalog.json` | All 5 profiles with explicit values for every env key |

---

## PostgreSQL COPY Insert Path (default — `copy` mode)

`bulkInsertViaCopy` in `readings.ts`:

1. Acquires a dedicated pool connection (`getClient()`).
2. `TRUNCATE` a per-connection temp table `tmp_readings_ingest` (created once per connection via flag).
3. Streams tab-separated rows via `pg-copy-streams` `COPY FROM STDIN` — no bind parameters, no row limit.
4. Stages up to `COPY_STAGE_ROWS_PER_BATCH = 5000` rows per COPY call (loops for larger batches).
5. `INSERT INTO readings ... SELECT ... FROM tmp_readings_ingest ON CONFLICT DO NOTHING` — atomic upsert.
6. `SET LOCAL synchronous_commit = off` — skips WAL fsync on commit; worst-case loss on hard crash is ~200ms of writes. Safe for append-only telemetry.
7. Calls `ReadingsService.bufferLatest(batch)` after commit.

**Why COPY beats multi-row INSERT:**
- No per-row bind parameter overhead (no `$1,$2...` parsing).
- No 65535 bind parameter cap hit (unbounded row count).
- PostgreSQL loads the temp table in a single network pass, then the SELECT/INSERT is a local table scan.
- At 15,000 readings/batch, COPY is ~3–5× faster than multi-row VALUES INSERT.

---

## readings_latest Pattern

`readings_latest` is a **flat table** (not a view) holding one row per `(agent_uuid, device_name, metric_name)` — the most recent reading per series.

**Why not a view:**
A view over `readings` would require a full hypertable scan (or latest-per-group query with index) on every dashboard or Prometheus scrape, costing O(series × chunks) I/O. The flat table costs one upsert per series per flush cycle instead.

**`startLatestFlusher()` — background static timer:**
- Runs every `READINGS_LATEST_FLUSH_INTERVAL_MS` (default 5 000 ms).
- Drains `ReadingsService.latestBuffer` (a static `Map<key, ReadingInsert>`) in a single writer.
- Eliminates cross-worker pool connection contention and row-lock serialization on `readings_latest`.
- All worker instances write to the shared static buffer synchronously (no await, no connection) via `bufferLatest()`.
- Only one `setInterval` is ever started (idempotent guard `latestFlusherStarted`).
- Active at `ingestion/src/services/readings.ts` line ~710: `ReadingsService.startLatestFlusher()`.

**Series key format:** `${agent_uuid}\t${deviceName}\t${metric_name}`

---

## Autoscaling

`RedisQueueConsumer` manages worker goroutines dynamically within `[AUTOSCALE_MIN_WORKERS, AUTOSCALE_MAX_WORKERS]`.

**Scale-up triggers:**
- Stream lag > `AUTOSCALE_LAG_SCALE_UP_MS` → spawn one worker.
- Stream lag > `AUTOSCALE_LAG_CRITICAL_MS` → spawn workers aggressively.
- DB pool saturation > `AUTOSCALE_DB_BLOCK_PCT` → blocks scale-up (don't add workers if DB is the bottleneck).

**Scale-down trigger:**
- `AUTOSCALE_SCALE_DOWN_STABLE_CHECKS` consecutive lag-below-target reads → retire one worker.
- Controlled by `AUTOSCALE_COOLDOWN_MS` between scale events.

**Redis pressure uplift:**
- When stream length > `REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT × MAXLEN` or Redis memory > `REDIS_MEMORY_HIGH_WATERMARK_PCT`, `checkRedisPressure()` returns an uplifted `effectiveBatchSize` (doubles the read count per loop) to drain faster.

---

## Backpressure

`shouldBackoffForDbPressure()` in `worker.ts`:
- `DB pool waiting > DB_WAITING_HIGH_WATERMARK` → sleep `DB_BACKPRESSURE_SLEEP_MS`, re-check.
- `DB pool saturation > DB_SATURATION_HIGH_WATERMARK_PCT` → same.
- Prevents the worker from pulling more messages when the DB can't absorb them.

---

## Circuit Breaker + Disk Spool

`RedisCircuitBreaker` wraps DB writes in `ReadingInserter`:
- **CLOSED** (normal): passes through.
- **OPEN** (5 consecutive failures): routes `DeviceDataEntry[]` to `DiskSpool` as NDJSON files.
- **HALF_OPEN** (after 30s timeout): probe — 3 successes → CLOSE, any failure → re-OPEN.

`DiskSpool`:
- Writes to `INGESTION_SPOOL_PATH` (default `/app/data/spool`).
- Caps total spool size at `INGESTION_SPOOL_MAX_SIZE_MB`.
- Replayer re-ingests spool files in creation order when circuit closes.
- Spool files are NDJSON (one JSON array per line) named `spool-N.ndjson`.
- `fileIndex` seeded from existing files on restart to maintain replay order across container restarts.

---

## Profiles

Set via `INGESTION_PROFILE` in `.env`. Applied by `applyIngestionProfile()` at startup in `index.ts`.
Valid values: `batch`, `balanced`, `streaming`, `benchmark`, `hp`.

### Profile Comparison Table

| Setting | batch | balanced | streaming | benchmark | hp |
|---------|-------|----------|-----------|-----------|-----|
| `BATCH_SIZE` | 500 | 100 | 20 | 1000 | 300 |
| `FLUSH_INTERVAL_MS` | 2000 | 500 | 100 | 200 | 100 |
| `WORKER_COUNT` | 4 | 6 | 8 | 12 | 10 |
| `INSERT_MODE` | copy | copy | realtime | copy | copy |
| `COPY_MIN_ROWS` | 1000 | 1000 | 1000 | 500 | 500 |
| `REALTIME_MAX_ROWS` | 25 | 50 | 100 | 20 | 50 |
| `DB_POOL_SIZE` | 20 | 24 | 30 | 40 | 30 |
| `DB_BACKPRESSURE_SLEEP_MS` | 500 | 250 | 100 | 50 | 150 |
| `REDIS_STREAM_MAXLEN` | 10000 | 5000 | 2000 | 50000 | 100000 |
| `AUTOSCALE_MIN_WORKERS` | 2 | 4 | 6 | 8 | 8 |
| `AUTOSCALE_MAX_WORKERS` | 12 | 16 | 20 | 24 | 20 |
| `AUTOSCALE_LAG_TARGET_MS` | 10000 | 5000 | 2000 | 8000 | 5000 |
| `REDIS_PIPELINE_FLUSH_INTERVAL_MS` | 50 | 10 | 0 | 5 | 5 |

### Profile Selection Guide

- **batch** — Best for sustained moderate throughput (100–500 msg/s). Large COPY batches amortize transaction cost. At 300 msg/s × 4 workers, each worker sees ~75 msg/s; 500-msg batches fill in ~6.7s but the 2s flush ceiling triggers first, keeping dwell low. Confirmed zero-loss at 300 msg/s in production load tests.
- **balanced** — General-purpose. Lower dwell time than `batch`, slightly more DB round trips.
- **streaming** — Low latency priority. Uses `realtime` insert mode (multi-row VALUES, not COPY). Best when dashboard freshness matters more than throughput.
- **benchmark** — Maximum throughput testing. Large batches (1000), high pool (40), aggressive stream buffer (50k). Use for ceiling testing only.
- **hp** — Sustained high-load production. Balanced between batch efficiency and low dwell. BATCH_SIZE=300, FLUSH_INTERVAL_MS=100 means batches fill fast or flush every 100ms.

---

## Throughput Calculations

### Message → Reading expansion
```
readings/s = msg/s × MetricsPerMessage
```
- 300 msg/s × 30 metrics = **9,000 readings/s**
- 500 msg/s × 50 metrics = **25,000 readings/s**
- 700 msg/s × 30 metrics = **21,000 readings/s**

### Batch fill time (per worker)
```
fill_time_ms = (BATCH_SIZE / (msg_per_s / WORKER_COUNT)) × 1000
```
- `batch` profile at 300 msg/s: 500 / (300/4) × 1000 = **6,667ms** — flush_interval (2000ms) triggers first
- `batch` profile at 1000 msg/s: 500 / (1000/4) × 1000 = **2,000ms** — exactly matches flush_interval
- `hp` profile at 700 msg/s: 300 / (700/10) × 1000 = **4,286ms** — flush_interval (100ms) triggers first

### COPY rows per transaction
```
copy_rows = BATCH_SIZE × MetricsPerMessage
```
- `batch` at 30 metrics: 500 × 30 = **15,000 rows per COPY**
- `hp` at 30 metrics: 300 × 30 = **9,000 rows per COPY**
- Staged in 5,000-row chunks if over `COPY_STAGE_ROWS_PER_BATCH`

### DB connection usage (approximate)
```
active_connections ≈ WORKER_COUNT + 1 (latest flusher) + pool_idle
peak_connections ≤ DB_POOL_SIZE
```

---

## Confirmed Performance Benchmarks

All tests run on local Docker Compose stack (TimescaleDB, single ingestion container).

### 300 msg/s — `batch` profile (56-minute soak)
- **Command**: `node load-test-mqtt.cjs -MessageCount 1000000 -AgentCount 50 -RatePerSecond 300 -MqttQoS 0 -MetricsPerMessage 30 -Cleanup true`
- Sent: 1,000,000 messages / 30,000,000 readings
- DB: 30,010,080 readings (overshoot = drain of in-flight on stop, not loss)
- Lost: **0** | Dropped: **0** | DLQ: **0**
- Peak spool: 3 (pipeline never fell behind)
- Subscriber recv: 100%
- Duration: 56m 4.8s
- Notes: Checkpoint stalls ~1s at ~21:52 are normal PostgreSQL WAL checkpoint behaviour, self-recovering

### Prior runs (500 msg/s × 50 metrics)
- 100,000 messages = 5,000,000 readings
- Zero loss, zero DLQ observed at sustained 500 msg/s

---

## Environment Variables Reference

### Core worker settings (set by profile)
| Variable | Default | Description |
|----------|---------|-------------|
| `INGESTION_PROFILE` | (none) | Load preset: `batch`, `balanced`, `streaming`, `benchmark`, `hp` |
| `BATCH_SIZE` | 100 | Max messages per XREADGROUP call |
| `FLUSH_INTERVAL_MS` | 2000 | XREADGROUP BLOCK timeout (ms); also max dwell per batch |
| `WORKER_COUNT` | 2 | Initial worker goroutines |
| `DB_POOL_SIZE` | 10 | pg connection pool size |
| `DB_BACKPRESSURE_SLEEP_MS` | 250 | Sleep when pool is saturated |
| `DB_WAITING_HIGH_WATERMARK` | 10 | Pool waiting clients threshold |
| `DB_SATURATION_HIGH_WATERMARK_PCT` | 85 | Pool active% threshold |

### Readings insert settings (set by profile)
| Variable | Default | Description |
|----------|---------|-------------|
| `READINGS_BULK_INSERT_MODE` | `copy` | `copy`, `insert`, or `realtime` |
| `READINGS_COPY_MIN_ROWS` | 1000 | Min rows to use COPY path; below this falls back to VALUES |
| `READINGS_REALTIME_MAX_ROWS` | 50 | Max rows per single VALUES INSERT |
| `READINGS_REALTIME_ROWS_PER_INSERT` | 25 | Chunk size for VALUES INSERT batching |
| `READINGS_LATEST_FLUSH_INTERVAL_MS` | 5000 | How often to flush readings_latest buffer to DB |

### Autoscale settings
| Variable | Default | Description |
|----------|---------|-------------|
| `AUTOSCALE_MIN_WORKERS` | 1 | Floor for dynamic worker count |
| `AUTOSCALE_MAX_WORKERS` | 20 | Ceiling for dynamic worker count |
| `AUTOSCALE_LAG_TARGET_MS` | 10000 | Acceptable stream lag; below this → consider scale down |
| `AUTOSCALE_LAG_SCALE_UP_MS` | 30000 | Lag that triggers scale-up |
| `AUTOSCALE_LAG_CRITICAL_MS` | 60000 | Lag that triggers aggressive scale-up |
| `AUTOSCALE_SCALE_DOWN_STABLE_CHECKS` | 3 | Consecutive below-target reads before scale down |
| `AUTOSCALE_COOLDOWN_MS` | 30000 | Min ms between scale events |
| `AUTOSCALE_DB_BLOCK_PCT` | 80 | DB saturation % that blocks scale-up |

### Redis settings
| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_INGESTION_STREAM_MAXLEN` | 10000 | XADD MAXLEN cap (~ trim) |
| `REDIS_IDLE_INGESTION_STREAM_MAXLEN` | equals MAXLEN | Trim target when idle |
| `REDIS_DLQ_MAXLEN` | 1000 | Dead-letter queue length cap |
| `REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT` | 0.8 | Stream fill % that uplifts effective batch size |
| `REDIS_MEMORY_HIGH_WATERMARK_PCT` | 75 | Redis memory% that triggers pressure warning |
| `REDIS_PIPELINE_FLUSH_INTERVAL_MS` | 50 | Idle window for XADD pipeline batching |

### Spool settings
| Variable | Default | Description |
|----------|---------|-------------|
| `INGESTION_SPOOL_ENABLED` | `false` | Enable disk spool fallback |
| `INGESTION_SPOOL_PATH` | `/app/data/spool` | Directory for NDJSON spool files |
| `INGESTION_SPOOL_MAX_SIZE_MB` | 512 | Max total spool size before oldest file eviction |

---

## Common Diagnostics

### Check live ingestion stats
```powershell
docker logs iotistic-ingestion --tail 50 --follow
```

### Confirm active profile at startup
Look for log line: `Resolved ingestion runtime profile`

### Check Redis stream depth (lag indicator)
```powershell
docker exec iotistic-redis redis-cli XLEN ingestion:demo:agent-devices
docker exec iotistic-redis redis-cli XPENDING ingestion:demo:agent-devices device-writers - + 10
```

### Check readings_latest row count
```sql
SELECT COUNT(*) FROM readings_latest;
SELECT agent_uuid, metric_name, time FROM readings_latest ORDER BY time DESC LIMIT 10;
```

### Check COPY vs VALUES path in logs
- COPY path: `Inserted N readings` with `rows: N` in debug logs
- Check `READINGS_BULK_INSERT_MODE` env in running container:
```powershell
docker exec iotistic-ingestion env | Select-String "READINGS_BULK_INSERT_MODE"
```

### Measure throughput from DB
```sql
SELECT
  time_bucket('1 minute', time) AS bucket,
  COUNT(*) AS readings
FROM readings
WHERE time > NOW() - INTERVAL '5 minutes'
GROUP BY bucket
ORDER BY bucket DESC;
```

### Identify checkpoint stalls (normal)
Batch logs showing `durationMs ~1080ms` with multiple batches completing simultaneously = PostgreSQL checkpoint (~1s write stall). Tune with:
```sql
ALTER SYSTEM SET checkpoint_completion_target = '0.9';
ALTER SYSTEM SET max_wal_size = '2GB';
SELECT pg_reload_conf();
```

---

## Key Design Decisions

1. **Static `latestBuffer` + single-writer flusher** — eliminates N×pool-connections for `readings_latest` upserts; all workers write synchronously to shared Map, one timer drains it.

2. **`synchronous_commit = off`** — skips WAL fsync per transaction. Acceptable for telemetry (append-only, no financial integrity requirement). Worst-case crash loss: ~200ms.

3. **Temp table per connection** — `tmp_readings_ingest` is a `CREATE TEMP TABLE IF NOT EXISTS` per pool connection, tracked by a Symbol flag. Avoids schema overhead on every COPY.

4. **Intra-batch dedup** — `Map<agent_uuid:metric_name:time_ms, ReadingInsert>` in `reading-inserter.ts` eliminates ON CONFLICT hits from replay/retry within the same batch.

5. **ETag-aware stale message reclaim** — workers call `claimStaleMessages()` on startup to re-process PEL entries from dead workers before reading new ones.

6. **`RecentMessageTracker`** — insertion-order evicting Set (50k cap) in each worker to suppress in-process redeliveries of already-processed messages within the same worker lifetime.

7. **Disk spool file index seeded on restart** — `fileIndex` initialised from `max(existing spool-N.ndjson indices)` so new spool files always sort after old ones, preventing infinite replay loops.
