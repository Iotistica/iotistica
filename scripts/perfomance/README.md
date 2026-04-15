# Performance Load Tests

Scripts for load-testing the full Iotistica ingestion pipeline.

## Prerequisites

- Docker running with `iotistic-redis`, `iotistic-mosquitto`, `iotistic-api`, and `iotistic-ingestion` containers
- `.env` file in the repo root with at minimum `REDIS_PASSWORD` and `MQTT_PASSWORD`
- Node.js on PATH (for `mqtt-persistent-publisher.cjs`)

---

## Scripts

### `load-test-mqtt.ps1` — Full pipeline via MQTT

Publishes `DeviceDataEntry` messages through the MQTT broker, exercising the complete path:

```
this script → iotistic-mosquitto → iotistic-api (MQTT handler) → Redis Stream → ingestion worker → TimescaleDB
```

Health metrics are scraped directly from the ingestion container's `/metrics` endpoint.

```powershell
# Quickstart: 1000 messages, 10 agents, max speed
.\scripts\perfomance\load-test-mqtt.ps1

# Sustained ramp: 5000 messages at 200 msg/s with 20 agents
.\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 5000 -AgentCount 20 -RatePerSecond 200

# Large burst: 10 readings per message, custom batch size
.\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 10000 -MetricsPerMessage 10 -BatchSize 500

# Explicit tenant + port (useful when auto-discovery fails)
.\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 5000 -TenantId "73eddd385ce8" -MqttPort 5883

# Auth0 environment: pass a JWT from the browser DevTools Network tab
.\scripts\perfomance\load-test-mqtt.ps1 -MessageCount 2000 -JwtToken "eyJhbGci..."
```

**Key parameters:**

| Parameter | Default | Description |
|---|---|---|
| `-MessageCount` | 1000 | Total messages to inject |
| `-AgentCount` | 10 | Number of distinct agent UUIDs |
| `-MetricsPerMessage` | 5 | Readings per message |
| `-RatePerSecond` | 0 (max) | Target inject rate |
| `-BatchSize` | 200 | Messages per agent before forced flush |
| `-BatchTimeMs` | 0 | Max dwell time (ms) before forced flush |
| `-TenantId` | auto | 12-char hex tenant ID |
| `-MqttPort` | env/5883 | External MQTT broker port |

---

### `load-test-ingestion.ps1` — Direct Redis stream injection

Writes messages directly into the Redis ingestion stream, bypassing MQTT and the API entirely. Useful for isolating the ingestion worker and DB write path.

```powershell
# Basic burst
.\scripts\perfomance\load-test-ingestion.ps1

# 10 000 messages at 500 msg/s across 20 agents
.\scripts\perfomance\load-test-ingestion.ps1 -MessageCount 10000 -AgentCount 20 -RatePerSecond 500

# Explicit stream key
.\scripts\perfomance\load-test-ingestion.ps1 -MessageCount 5000 `
    -StreamKey "tenant:{73eddd385ce8}:agent:devices:ingestion"

# Local-auth (no Auth0) — auto-acquires JWT via username/password login
.\scripts\perfomance\load-test-ingestion.ps1 -MessageCount 1000 -Username admin -Password secret
```

**Key parameters:**

| Parameter | Default | Description |
|---|---|---|
| `-MessageCount` | 1000 | Total messages to inject |
| `-AgentCount` | 10 | Distinct agent UUIDs |
| `-MetricsPerMessage` | 5 | Readings per message |
| `-RatePerSecond` | 0 (max) | Target inject rate |
| `-StreamKey` | auto | Redis stream key (auto-discovered) |

---

### `load-test-mqtt-cloud.ps1` — Cloud / Kubernetes

Same MQTT flow as `load-test-mqtt.ps1` but targets a live Kubernetes namespace (e.g. `demo`). Credentials and tenant ID are read from Kubernetes secrets automatically.

```powershell
# Demo namespace, 1000 messages
.\scripts\perfomance\load-test-mqtt-cloud.ps1 -Namespace demo

# Ramp test on demo at 100 msg/s
.\scripts\perfomance\load-test-mqtt-cloud.ps1 -Namespace demo -MessageCount 5000 -RatePerSecond 100

# Explicit MQTT host and port
.\scripts\perfomance\load-test-mqtt-cloud.ps1 -Namespace demo `
    -MqttHost demo-mqtt.iotistica.com -MqttPort 8883
```

---

### `profile-ingestion.ps1` — CPU profiling under load

Restarts the ingestion container with V8 `--cpu-prof` enabled, runs the MQTT load test for a fixed duration, stops the container (which writes the profile), copies the `.cpuprofile` to `./profiles/`, then reopens ingestion normally. The profile is opened automatically in VS Code's built-in JavaScript Profile Viewer.

```powershell
# Default: 60s at 300 msg/s, 20 agents
.\scripts\perfomance\profile-ingestion.ps1

# 2-minute ramp at 500 msg/s, 50 agents
.\scripts\perfomance\profile-ingestion.ps1 -DurationSec 120 -RatePerSecond 500 -AgentCount 50

# Profile only — do not restart ingestion after (inspect container first)
.\scripts\perfomance\profile-ingestion.ps1 -SkipReopen
```

Saved profiles land in `./profiles/*.cpuprofile`.

---

## Health metrics columns

All scripts print a live metrics row during and after injection:

```
HH:mm:ss | msg=<injected>/<total> rd=<readings>/<total> | rate=<msg/s> | stream=<len> lag=<ms>  pending=<n> workers=<n> procΔ=<n> insΔ=<n> dropΔ=<n>  dwellP95=<ms>ms batchP95=<ms>ms
```

| Column | Meaning |
|---|---|
| `msg` | Messages injected / total target |
| `rd` | Readings injected / total target |
| `rate` | Actual inject rate (msg/s) |
| `stream` | Redis stream backlog length |
| `lag` | Consumer group lag (ms) — red >20s, yellow >5s |
| `pending` | Unacknowledged in-flight messages |
| `workers` | Active autoscale worker count |
| `procΔ` | Messages processed since baseline |
| `insΔ` | DB rows inserted since baseline |
| `dropΔ` | Messages dropped since baseline (red if >0) |
| `dwellP95` | p95 stream dwell time (ms) |
| `batchP95` | p95 DB batch latency (ms) |

---

## Useful Redis commands

```powershell
# Check stream length
docker exec iotistic-redis redis-cli --no-auth-warning -a "$env:REDIS_PASSWORD" `
    XLEN "tenant:{73eddd385ce8}:agent:devices:ingestion"

# Inspect DLQ
docker exec iotistic-redis redis-cli --no-auth-warning -a "$env:REDIS_PASSWORD" `
    XRANGE "tenant:{73eddd385ce8}:agent:devices:dlq" - + COUNT 5

# Consumer group lag
docker exec iotistic-redis redis-cli --no-auth-warning -a "$env:REDIS_PASSWORD" `
    XINFO GROUPS "tenant:{73eddd385ce8}:agent:devices:ingestion"
```
