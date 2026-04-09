# Ingestion Pipeline: Stress Test Results & Client Sizing Guide

**Last updated:** April 6, 2026  
**Applies to:** API ingestion worker (`api/src/services/ingestion/`), Redis stream pipeline, TimescaleDB (CNPG)

---

## Table of Contents

1. [Pipeline Architecture](#1-pipeline-architecture)
2. [Stress Test Environment](#2-stress-test-environment)
3. [Stress Test Results](#3-stress-test-results)
4. [What the Numbers Mean](#4-what-the-numbers-mean)
5. [Environment Variables Reference](#5-environment-variables-reference)
6. [Client Sizing Framework](#6-client-sizing-framework)
7. [Tier Reference](#7-tier-reference)
8. [Kubernetes Resource Recommendations](#8-kubernetes-resource-recommendations)
9. [Common Footguns](#9-common-footguns)

---

## 1. Pipeline Architecture

```
Edge Agent (Raspberry Pi / x86)
  │  publishes readings via MQTT or HTTPS
  ▼
API  ──XADD──▶  Redis Stream  (tenant:{id}:agent:devices:ingestion)
                     │
              XREADGROUP BLOCK
                     │
              ┌──────┴──────────────────────────────────┐
              │  Worker Pool (WORKER_COUNT base)         │
              │  • each worker owns a dedicated Redis    │
              │    connection (workerRedis)              │
              │  • reads COUNT=BATCH_SIZE entries        │
              │  • resolves device UUIDs → DB IDs        │
              │  • bulk-inserts via COPY FROM STDIN      │
              │  • ACKs with same workerRedis connection │
              └──────────────────────────────────────────┘
                     │
              TimescaleDB (CNPG)
              readings hypertable
```

**Key design decisions:**

- Each worker uses its **own dedicated Redis connection** for both XREADGROUP and XACK.  
  Sharing a connection across workers caused 4–5 second XACK serialization (old bug, fixed).
- Inserts use **COPY FROM STDIN** (not individual INSERTs), which is 5–10× faster for bulk writes.
- The worker autoscaler adjusts goroutine count within a single API pod based on stream lag.
- The HPA (Horizontal Pod Autoscaler) scales pods based on CPU/memory; both mechanisms stack.
- A disk spool (`DISK_SPOOL_ENABLED`) absorbs entries when Redis memory is under pressure.

---

## 2. Stress Test Environment

### Infrastructure (local Docker, April 2026)

| Component | Config |
|-----------|--------|
| Redis | `redis:7-alpine`, 512 MB `maxmemory`, `noeviction` |
| PostgreSQL | Local Docker, single node (not CNPG) |
| API | `WORKER_COUNT=6`, `AUTOSCALE_MAX_WORKERS=20` |
| Stream MAXLEN | `10,000` (default demo value) |
| Batch size | `500` (doubles to `1000` under pressure) |
| Insert mode | `COPY FROM STDIN` (`BULK_INSERT_MODE=copy`) |

### Test tool

```powershell
# scripts/load-test-ingestion.ps1
# Injects messages directly into the Redis stream (bypasses MQTT and API HTTP layer)
.\scripts\load-test-ingestion.ps1 `
  -MessageCount 2000000 `
  -AgentCount 39 `
  -StreamKey "tenant:{73eddd385ce8}:agent:devices:ingestion"
```

**Message structure**: 1 Redis entry = 1 device UUID + 5 metric readings  
(temperature, humidity, pressure, vibration, plus cycling: current/voltage/co₂/flow/rpm/power)

So: **2,000,000 messages × 5 metrics = 10,000,000 TimescaleDB rows** in a full run.

The `AgentCount=39` creates 39 distinct device UUIDs round-robined across all messages.  
It does **not** mean 39 running agent processes — it simulates the UUID distribution of a real fleet.

---

## 3. Stress Test Results

### Baseline: steady-state (normal injection rate)

Workers drain the stream faster than the load tool can inject.

| Metric | Observed value |
|--------|---------------|
| `durationMs` per batch (25 entries) | **12–21 ms** |
| `ackMs` (XACK time) | **0–3 ms** |
| `insertMs` (COPY to DB) | **13–25 ms** for 125 rows |
| `readingsPerSecond` per worker | **1,000–1,900** |
| Stream `lag` | **0** |
| Stream `pending` | **0** |
| Active workers at steady state | **1–2 of 6** (others block on XREADGROUP) |

### Backpressure test: API stopped, stream pre-filled to MAXLEN

Stream filled to cap (**50,000 entries** with MAXLEN=50,000).  
API restarted — measured drain behavior:

| Metric | Observed value |
|--------|---------------|
| Stream length at start | 50,000 |
| `workerLag` on first health check | 300 ms |
| `durationMs` per batch under load | 12–150 ms (variable DB latency) |
| `insertMs` under 6-way concurrent COPY | 50–765 ms |
| Time to drain 50k entries | ~30–60 seconds |
| Autoscaler triggered? | **No** — lag never reached `LAG_SCALE_UP_MS=5000` |

**Key finding:** 6 workers on production CNPG (4 vCPU/8 Gi) will be significantly faster.  
The local Docker postgres bottleneck (concurrent COPY saturation) is not representative of production.

### The XACK bottleneck (historical, fixed)

Before the fix, all 6 workers shared `this.redis` for XACK while each had its own `workerRedis` for XREADGROUP. Commands serialized on the shared connection.

| Metric | Before fix | After fix |
|--------|-----------|-----------|
| `ackMs` | **4,900 ms** | **0–3 ms** |
| `durationMs` per batch | **5,000 ms** | **12–21 ms** |
| Speedup | — | **250–300×** |

Fix: pass `workerRedis` through `processBatch(entries, workerRedis)` and `xackBatch(ids, workerRedis)` so each worker owns its full read → process → ack cycle on one connection.

---

## 4. What the Numbers Mean

### "2,000,000 messages / 39 agents" in context

The load test is a **pipeline stress benchmark**, not a production simulation.  
Mapping to real deployments:

| Scenario | readings/sec | Time to 2M messages |
|----------|-------------|---------------------|
| 39 agents, 1 device each, 5s poll | 7.8 | ~71 hours |
| 39 agents, 10 devices, 5s poll | 78 | ~7 hours |
| 39 agents, 10 devices, 1s poll | 390 | ~85 min |
| 39 agents, 50 devices, 5s poll | 390 | ~85 min |
| 39 agents, 50 devices, 1s poll | 1,950 | ~17 min |

### Why autoscaling did not trigger

`AUTOSCALE_LAG_SCALE_UP_MS=5,000 ms` — a worker is only added when the oldest  
unprocessed entry in the stream is more than 5 seconds old.

At steady state, lag was **< 300 ms**. To trigger autoscaling you need a sustained injection  
rate that exceeds what 6 workers can drain. On local Docker that requires the stream to be  
pre-filled beyond what MAXLEN allows before the API starts.

On production CNPG (faster DB), the threshold to trigger autoscaling is even higher.

### Default `REDIS_INGESTION_STREAM_MAXLEN=10,000` is too small for production

At 500 readings/sec, MAXLEN=10,000 holds only **20 seconds** of buffer.  
If the API restarts or DB is briefly slow, entries are trimmed and **permanently lost**.

Use the formula: `MAXLEN = readings_per_sec × desired_buffer_sec`

For a 5-minute recovery window at 500 r/s: `500 × 300 = 150,000`

---

## 5. Environment Variables Reference

All variables are read at startup in `ingestion/src/services/redis-device-queue.ts`.

### Worker pool

| Variable | Code default | Demo values.yaml | Description |
|----------|-------------|-----------------|-------------|
| `WORKER_COUNT` | `2` | `6` | Base worker goroutines started at boot |
| `BATCH_SIZE` | `100` | `500` | Entries per XREADGROUP read (doubles under pressure, max 5000) |
| `FLUSH_INTERVAL_MS` | `2000` | `2000` | XREADGROUP BLOCK timeout (ms) — how long a worker waits for new entries |
| `MAX_RETRIES` | `3` | — | Retry attempts before moving entry to DLQ |

### Autoscaler

| Variable | Code default | Demo values.yaml | Description |
|----------|-------------|-----------------|-------------|
| `AUTOSCALE_MIN_WORKERS` | `1` | `1` | Floor: workers never drop below this |
| `AUTOSCALE_MAX_WORKERS` | `20` | `20` | Ceiling: workers never exceed this per pod |
| `AUTOSCALE_LAG_SCALE_UP_MS` | `30000` | `5000` | Add a worker when oldest pending entry age > this |
| `AUTOSCALE_LAG_CRITICAL_MS` | `60000` | `15000` | Scale to max workers immediately |
| `AUTOSCALE_LAG_TARGET_MS` | `10000` | — | Target lag; scale down toward this |
| `AUTOSCALE_SCALE_DOWN_STABLE_CHECKS` | `3` | — | Consecutive checks below target before scale-down |
| `AUTOSCALE_COOLDOWN_MS` | `30000` | `5000` | Minimum time between scale events |
| `AUTOSCALE_DB_BLOCK_PCT` | `80` | — | Scale up if DB blocking connections exceed this % |

### DB backpressure

| Variable | Code default | Demo values.yaml | Description |
|----------|-------------|-----------------|-------------|
| `DB_WAITING_HIGH_WATERMARK` | `10` | `5` | Scale down if >N connections waiting for DB |
| `DB_SATURATION_HIGH_WATERMARK_PCT` | `85` | `70` | Scale down if DB saturation > this % |
| `DB_BACKPRESSURE_SLEEP_MS` | `250` | `500` | Sleep between batches when DB is saturated |

### Redis stream caps

| Variable | Code default | Demo values.yaml | Description |
|----------|-------------|-----------------|-------------|
| `REDIS_INGESTION_STREAM_MAXLEN` | `10000` | `10000` | Max entries in ingestion stream (TRIM on XADD) |
| `REDIS_PROCESSING_STREAM_MAXLEN` | — | `100000` | Max entries in processing stream |
| `REDIS_DLQ_MAXLEN` | `1000` | `1000` | Max entries in dead-letter queue |
| `REDIS_DEVICE_STREAM_HIGH_WATERMARK_PCT` | `0.8` | `0.8` | Warn when stream > 80% of MAXLEN |
| `REDIS_MEMORY_HIGH_WATERMARK_PCT` | `75` | `75` | Warn when Redis memory > 75% of maxmemory |

### Disk spool

| Variable | Code default | Demo values.yaml | Description |
|----------|-------------|-----------------|-------------|
| `DISK_SPOOL_ENABLED` | `false` | `true` | Enable disk overflow when Redis memory pressure is high |
| `DISK_SPOOL_PATH` | `/tmp/iotistic-spool` | `/var/lib/iotistic/spool` | Spool directory (use a PVC in K8s) |
| `DISK_SPOOL_MAX_SIZE_MB` | `500` | `1000` | Max disk spool size before backpressure |

---

## 6. Client Sizing Framework

### Discovery questions

Ask these four questions before recommending a tier:

1. **How many physical edge agents?** (Raspberry Pi boxes / x86 servers)
2. **How many PLC/device endpoints per agent?** (typically 5–50 for Modbus/OPC-UA)
3. **How many registers/data points per device?** (typically 5–100)
4. **What poll interval?** (1s = critical process; 5–30s = standard; 60s+ = slow sensors)

### Formula

```
readings/sec = agents × devices_per_agent × registers_per_device / pollInterval_sec

rows/day     = readings/sec × 86,400

MAXLEN (5-min buffer) = readings/sec × 300
```

### Example calculations

| Client profile | Formula | readings/sec | rows/day | Tier |
|----------------|---------|-------------|---------|------|
| 3 agents, 10 PLCs, 10 regs, 10s poll | 3×10×10/10 | 30 | 2.6M | Starter |
| 5 agents, 20 PLCs, 15 regs, 5s poll | 5×20×15/5 | 300 | 26M | Starter |
| 20 agents, 25 PLCs, 15 regs, 5s poll | 20×25×15/5 | 1,500 | 130M | Standard |
| 50 agents, 30 PLCs, 20 regs, 5s poll | 50×30×20/5 | 6,000 | 518M | Standard–Enterprise |
| 100 agents, 50 PLCs, 20 regs, 2s poll | 100×50×20/2 | 50,000 | 4.3B | Enterprise |

### Agent adapter defaults (from source)

| Adapter | Default `pollInterval` | Typical devices/agent |
|---------|----------------------|----------------------|
| Modbus TCP | 5,000 ms | 5–50 PLCs |
| OPC-UA | 5,000 ms | 10–200 nodes |
| MQTT | event-driven | 1–∞ topics |
| BACnet | 5,000 ms | 5–100 objects |
| SNMP | per-config | 1–20 devices |

**Agent publish interval:** `publishInterval=30,000 ms` (default) — the agent batches all readings  
collected in a 30s window before flushing to the API. This means latency from poll to TimescaleDB  
is up to 30 seconds under normal operation.

---

## 7. Tier Reference

Overlay files are in `iot-k8s/charts/iotistica-app/values/tiers/`.  
Apply on top of a client's base values file:

```bash
helm upgrade <release> charts/iotistica-app \
  -f charts/iotistica-app/values/<client>/values.yaml \
  -f charts/iotistica-app/values/tiers/standard.yaml \
  -n <namespace>
```

### Summary comparison

| Parameter | Starter | Standard | Enterprise |
|-----------|---------|----------|------------|
| readings/sec (target) | < 500 | 500–5,000 | 5,000–50,000 |
| rows/day | < 43M | 43M–432M | 432M–4.3B |
| `WORKER_COUNT` | 6 | 10 | 20 |
| `AUTOSCALE_MAX_WORKERS` | 10 | 20 | 20 (+ HPA pods) |
| `REDIS_INGESTION_STREAM_MAXLEN` | 60,000 | 600,000 | 1,200,000 |
| `redis.maxMemory` | 512 MB | 2 GB | 8 GB |
| API CPU request / limit | 250m / 1000m | 1000m / 2000m | 2000m / 4000m |
| API memory request / limit | 256Mi / 1Gi | 512Mi / 2Gi | 1Gi / 4Gi |
| API `replicas` | 1 | 2 | 4 |
| HPA enabled | No | Yes (max 4) | Yes (max 10) |
| `DB_POOL_SIZE` | 10 | 20 | 20–25 |
| CNPG instances | 1 | 2 | 3 |
| CNPG CPU | 1000m | 4000m | 8000m |
| CNPG memory | 2 Gi | 8 Gi | 32 Gi |
| CNPG storage | 20 Gi | 100 Gi | 500 Gi+ |

### Storage estimation

```
compressed_rows_per_day = rows/day / compression_ratio
                        = rows/day / 15   (typical TimescaleDB IoT compression)

storage_GB = compressed_rows_per_day × retention_days × bytes_per_compressed_row
           = (rows/day / 15) × retention_days × 60
```

Example: Standard tier, 130M rows/day, 90-day retention:
```
(130,000,000 / 15) × 90 × 60 = ~46 GB
→ 100 Gi CNPG storage is comfortable
```

Enable compression policy (recommended for all tiers):
```sql
SELECT add_compression_policy('readings', INTERVAL '7 days');
```

---

## 8. Kubernetes Resource Recommendations

### API pod sizing logic

```
cpu_request = (WORKER_COUNT × 80m) + 200m_Node.js_overhead
cpu_limit   = (AUTOSCALE_MAX_WORKERS × 300m) + 300m_overhead
              (or set HPA and keep limit at 2–4 vCPU)

memory_request = 256Mi base + (WORKER_COUNT × 20Mi per worker channel)
memory_limit   = request × 3  (Node.js heap can spike during batch processing)
```

### CNPG (TimescaleDB) sizing logic

```
shared_buffers = memory / 4
effective_cache_size = memory × 0.75
work_mem = memory / max_connections / 2
```

Critical settings for IoT ingestion workloads:

```yaml
synchronous_commit: off     # safe for IoT telemetry; saves ~200ms/write
wal_compression: lz4        # reduces WAL volume ~50%
max_wal_size: 8GB           # prevents checkpoint pressure during bulk inserts
checkpoint_completion_target: 0.9
```

### PgBouncer pooler sizing

```
default_pool_size ≥ CNPG_max_connections / 2
max_client_conn   ≥ (API_replicas × API_pods_max × DB_POOL_SIZE) × 2
```

Example: 4 pods × 25 pool size × 2 buffer = 200 → set `max_client_conn: 400`

### Redis sizing

```
maxMemory ≥ REDIS_INGESTION_STREAM_MAXLEN × 500B × 3  (3× headroom)
```

Example: MAXLEN=600,000 → `600,000 × 500B × 3 = 900MB` → set `maxMemory: 2gb`

---

## 9. Common Footguns

### 1. REDIS_INGESTION_STREAM_MAXLEN too small

**Symptom:** Entries are silently dropped when Redis trims the stream faster than the API processes.  
**How to detect:** `XLEN stream` never grows despite high injection rate; TimescaleDB row count grows slower than expected.  
**Fix:** `MAXLEN = readings_per_sec × 300` (5-minute buffer minimum).

### 2. AUTOSCALE_LAG thresholds not adjusted from demo defaults

**Symptom:** Workers don't autoscale even under heavy load because `LAG_SCALE_UP_MS=30000` (code default) requires 30 seconds of lag before adding a worker.  
**Fix:** Set `AUTOSCALE_LAG_SCALE_UP_MS: "5000"` for production (as in demo values.yaml).

### 3. Shared Redis connection for XACK (historical — fixed)

**Symptom:** `ackMs` in logs is 4,000–6,000 ms; `durationMs` per batch is 5 seconds even with fast DB.  
**Root cause:** Multiple workers sharing `this.redis` for XACK — commands serialize.  
**Fix:** Pass per-worker connection (`workerRedis`) to `processBatch` and `xackBatch`. Fixed April 2026.

### 4. DB pool exhaustion under autoscaling

**Symptom:** `DB_POOL_SIZE` connections are all in use; workers queue behind DB pool instead of processing.  
**How to detect:** `DB_WAITING_HIGH_WATERMARK` exceeded; `insertMs` spikes to seconds.  
**Fix:** Set `DB_POOL_SIZE ≥ WORKER_COUNT + 5` to ensure workers are never pool-starved.

### 5. BULK_INSERT_MODE not set to 'copy'

**Symptom:** Insert throughput is 5–10× lower than expected; `insertMs` is 500ms+ for small batches.  
**Fix:** Ensure `BULK_INSERT_MODE=copy` (or leave unset — `copy` is the default in `readings.service.ts`).

### 6. TimescaleDB continuous aggregates missing for dashboard

**Symptom:** Dashboard time-series queries time out or take > 5 seconds on large datasets.  
**Fix:** Create continuous aggregates for the intervals your dashboards query (hourly, daily):

```sql
CREATE MATERIALIZED VIEW readings_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', time) AS bucket,
       device_id, metric_name,
       avg(value) AS avg_val, max(value) AS max_val, min(value) AS min_val
FROM readings
GROUP BY bucket, device_id, metric_name;

SELECT add_continuous_aggregate_policy('readings_hourly', ...);
```

---

## Appendix: Load test commands

```powershell
# Standard load test (sustained injection, no rate limit)
.\scripts\load-test-ingestion.ps1 `
  -MessageCount 200000 `
  -AgentCount 39 `
  -StreamKey "tenant:{73eddd385ce8}:agent:devices:ingestion"

# Sustained rate test (forces autoscaler to react)
.\scripts\load-test-ingestion.ps1 `
  -MessageCount 1000000 `
  -AgentCount 39 `
  -RatePerSecond 5000 `
  -StreamKey "tenant:{73eddd385ce8}:agent:devices:ingestion"

# Pre-fill then start API (backpressure test)
# 1. Stop API:   docker compose stop api
# 2. Run test until stream fills to MAXLEN
# 3. Start API:  docker compose up -d api
# 4. Monitor:    docker logs iotistic-api -f 2>&1 | Select-String "durationMs|lag|autoscale"
```

```powershell
# Monitor stream health
docker exec iotistic-redis redis-cli -a local-dev-redis-change-me `
  XINFO GROUPS "tenant:{73eddd385ce8}:agent:devices:ingestion" `
  2>&1 | Where-Object { $_ -notmatch "Warning" }

# Monitor active consumers (workers)
docker exec iotistic-redis redis-cli -a local-dev-redis-change-me `
  XINFO CONSUMERS "tenant:{73eddd385ce8}:agent:devices:ingestion" `
  "73eddd385ce8:device-writers" `
  2>&1 | Where-Object { $_ -notmatch "Warning" }

# Stream length watch
while ($true) {
  $len = docker exec iotistic-redis redis-cli -a local-dev-redis-change-me `
    XLEN "tenant:{73eddd385ce8}:agent:devices:ingestion" 2>&1 | Where-Object { $_ -notmatch "Warning" }
  Write-Host "$(Get-Date -Format HH:mm:ss)  len=$len"
  Start-Sleep 3
}
```
