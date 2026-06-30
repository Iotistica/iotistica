# Iotistica

Connect industrial assets, process data at the edge, and deliver trusted telemetry to your cloud or the Iotistica platform. The agent runs on any Linux edge device, bridges industrial protocols, orchestrates Docker workloads, and streams telemetry upstream. Agent Pro adds fleet management, remote shell, MQTT broker monitoring, anomaly detection, and managed cloud ingestion.

**[iotistica.com](https://iotistica.com) · [Solutions & Pricing](https://iotistica.com/solutions.html)**

![Dashboard](https://docs.iotistica.com/img/agent/dashboard.JPG)

---

## Offerings

| | Community | Agent Pro | Pro + Ingestion |
|---|---|---|---|
| Edge runtime & admin UI | ✓ | ✓ | ✓ |
| Industrial protocol support | ✓ | ✓ | ✓ |
| Publish to any MQTT broker | ✓ | ✓ | ✓ |
| Docker container orchestration | ✓ | ✓ | ✓ |
| Fleet management & remote shell | — | ✓ | ✓ |
| On-device anomaly detection | — | ✓ | ✓ |
| **MQTT broker monitor** | — | ✓ | ✓ |
| Publish to InfluxDB, Azure, AWS, GCP | — | ✓ | ✓ |
| Managed cloud ingestion & time-series storage | — | — | ✓ |
| 24/7 support | — | ✓ | ✓ |
| License | Apache 2.0 | Commercial | Commercial |

See **[iotistica.com/solutions.html](https://iotistica.com/solutions.html)** for full feature details and pricing.

---

## What's in this repo

| Directory | Description |
|-----------|-------------|
| `agent/` | Edge runtime deployed on IoT hardware (Node.js 20 / TypeScript) |
| `mosquitto-agent/` | MQTT broker auth sidecar |
| `influxdb/` | InfluxDB configuration |
| `grafana/` | Grafana dashboards |

---

## Agent

The agent is the core component. It runs on edge hardware and handles:

- **Container orchestration** — pulls Docker images, reconciles running containers against a desired target state
- **Industrial protocols** — Modbus TCP/RTU, OPC UA, BACnet, MQTT broker
- **Data publishing** — forwards sensor readings to MQTT and configurable upstream destinations
- **Cloud sync** — polls target state every 60s, reports current state every 10s, buffers to SQLite during outages
- **Device discovery** — scans networks for industrial devices and auto-registers endpoints
- **Offline-first** — continues operating without cloud connectivity; all state changes buffer and flush on reconnect

> **Pro features** — fleet management, remote shell, MQTT broker monitor, anomaly detection, and cloud destinations (InfluxDB, Azure IoT Hub, AWS IoT Core, GCP) require [Iotistica Agent Pro](https://iotistica.com/solutions.html).

### Admin UI

The agent ships a local admin UI (Vue 3 + Ant Design Vue) served at `http://<device>:48481/admin/`.

![Endpoints](https://docs.iotistica.com/img/agent/endpoints.JPG)

![Applications](https://docs.iotistica.com/img/agent/applications.JPG)

---

## MQTT Broker Monitor ✦ Pro

Agent Pro includes a live MQTT broker monitor — browse every active topic, inspect message payloads in real time, and track client counts and throughput without leaving the admin UI.

![MQTT Broker Monitor showing metric cards, topic tree, and message payload viewer](https://docs.iotistica.com/img/agent/mqtt.JPG)

The monitor connects to the local Mosquitto broker and refreshes every five seconds:

- **Metric cards** — connected clients, active topic count, inbound and outbound message rates
- **Topic tree** — every active topic grouped by path segments, with live filtering and per-topic message counts
- **Message viewer** — full payload for the selected topic, formatted as JSON where possible, with QoS and retain flag
- **MQTT Users** — manage per-device broker credentials with topic-pattern isolation and read/write access control

> MQTT broker monitoring is available in **Agent Pro**. [Compare plans →](https://iotistica.com/solutions.html)

---

## Quick Start

### Standalone (no cloud)

Run the agent fully offline with local configuration:

```bash
cd agent
cp .env.example .env        # set DATA_DIR, LOG_DIR, etc.
npm install
npm run build
STANDALONE=true node dist/app.js
```

Open the admin UI at `http://localhost:48481/admin/`.

### Docker (recommended)

```bash
docker build -t iotistica-agent ./agent

docker run -d \
  --name iotistica-agent \
  -p 48481:48484 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/data:/data \
  -e STANDALONE=true \
  iotistica-agent
```

### Cloud-connected

```bash
docker run -d \
  --name iotistica-agent \
  -p 48481:48484 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v $(pwd)/data:/data \
  -e IOTISTICA_API=https://api.iotistica.io \
  -e PROVISIONING_KEY=your-one-time-key \
  iotistica-agent
```

On first boot, the agent runs a three-phase provisioning protocol (register → Ed25519 proof-of-possession → discard key) and then syncs state continuously.

---

## Key Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `STANDALONE` | `false` | Set to `true` to disable all cloud sync and run fully offline |
| `IOTISTICA_API` | — | Iotistica Cloud API base URL |
| `PROVISIONING_KEY` | — | One-time provisioning token (not needed after first boot) |
| `MQTT_BROKER_URL` | — | Cloud MQTT broker URL for real-time state push |
| `DEVICE_API_PORT` | `48484` | Local HTTP API port |
| `DATA_DIR` | — | Writable directory for SQLite database and keys |
| `LOG_DIR` | — | Log file directory |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ENABLE_AUTH` | `false` | Require `X-Api-Key` header on Device API |
| `API_KEY` | — | API key value when `ENABLE_AUTH=true` |

---

## Architecture

```
Cloud desired state (MQTT / REST)
          │
     StateManager          ← SQLite (persistent, offline-buffered)
          │
   Reconciliation loop
          │
   Docker containers / Protocol adapters (current state)
          │
   Data publishing pipeline
          │
   Upstream destinations (MQTT · InfluxDB · Azure · AWS · GCP)
```

The agent is **offline-first**. When the cloud is unreachable:
- All outgoing state reports buffer to SQLite and flush when connectivity returns
- Sensor data publishing buffers per-destination, drops oldest when full (configurable, default 10 000 records)
- Target state from the last successful pull remains in effect — containers keep running

---

## Agent Startup Phases

```
node dist/app.js
  └─ src/app.ts
       └─ agent.init()   6-phase async init:
            1. core       DB, StateManager, ConfigManager
            2. logging    AgentLogger (local + cloud backends)
            3. infra      ContainerManager, MQTT, HTTP client
            4. device     Provisioning, Device API (port 48484)
            5. features   Discovery, remote access, jobs (Pro)
            6. sync       Cloud polling + reporting
```

---

## Device API

The agent exposes a local REST API on port 48484. Every action in the admin UI is backed by this API.

```
GET  /ping
GET  /v1/healthy
GET  /v1/readiness
GET  /v1/health/report
GET  /v1/buffer/status
GET  /v1/device
GET  /v1/apps
POST /v1/apps
POST /v1/provision
GET  /v1/endpoints
POST /v1/endpoints
GET  /v1/logs
GET  /v1/settings
...
```

---

## Industrial Protocols

| Protocol | Transport | Notes |
|----------|-----------|-------|
| Modbus | TCP, RTU (serial) | Register read/write, multi-device polling |
| OPC UA | TCP | Address space browsing, security modes, session auth |
| BACnet | IP | Object discovery, COV subscriptions |
| MQTT | TCP/TLS | Acts as subscriber on a local broker |

---

## Data Publishing Formats

Three payload formats are available per subscription:

| Format | Best for |
|--------|----------|
| `custom` | Iotistica Cloud, custom consumers — full batch envelope with quality codes and msgId deduplication |
| `tags` | Generic MQTT consumers — flat tag list with Unix-ms timestamp |
| `ecp` | Typed time-series databases — explicit type metadata, omits BAD/null values |

Compression options: `json`, `msgpack`, `json+deflate`, `msgpack+deflate`.

---

## Security

- **Provisioning** — Ed25519 proof-of-possession key exchange; provisioning token destroyed after use; UUID immutable post-registration
- **Credential storage** — AES-256-GCM with unique IV per record; master key at `chmod 0600`
- **Remote shell** — HMAC-SHA256 on every command, 30s anti-replay window, device UUID binding, shell allowlist, privilege drop to UID 1000 *(Pro)*
- **Firewall** — custom `IOTISTIC-FIREWALL` iptables chain; Device API blocked externally; MQTT restricted to LAN + Docker subnets; IPv4 + IPv6

---

## Development

```bash
# Install dependencies
cd agent && npm install

# Build
npm run build               # tsc → dist/

# Development (watch mode)
npm run dev                 # tsx watch src/app.ts

# Tests
npm test                    # Jest unit tests
npm run test:integration    # Integration tests (requires running SQLite)
```

### Admin UI

```bash
cd agent/admin
npm install
npm run dev     # Vite dev server at http://localhost:5173
npm run build   # Build into agent/admin/dist/
```

---

## License

The Community Edition is licensed under [Apache 2.0](LICENSE).

Iotistica Agent Pro is a commercial extension distributed as a private npm package. See [iotistica.com/solutions.html](https://iotistica.com/solutions.html) for details.

---

## Support

- **Issues**: [GitHub Issues](https://github.com/Iotistica/iotistica/issues)
- **Documentation**: [docs.iotistica.com](https://docs.iotistica.com)
- **Pro & Ingestion**: [iotistica.com/solutions.html](https://iotistica.com/solutions.html)
