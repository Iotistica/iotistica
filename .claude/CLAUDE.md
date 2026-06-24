# Iotistica — Project Overview

Monorepo for the **Iotistica IoT fleet management platform**. The main workspaces in this repo:

| Directory | Purpose |
|-----------|---------|
| `agent/` | Edge runtime deployed on IoT hardware (Node.js/TypeScript) |
| `mosquitto-agent/` | MQTT broker sidecar / auth agent |

---

## agent/ — Edge Runtime

**Version:** 1.0.508  
**Stack:** Node.js 20, TypeScript 5.9 (ES2022/Node16), SQLite (better-sqlite3), Express, MQTT v5, dockerode  
**Admin UI:** Vue 3 + Ant Design Vue + Vite (`agent/admin/`)

### What it does
Runs on edge hardware. Manages Docker containers, collects telemetry, bridges industrial devices (Modbus/OPC-UA/BACnet/SNMP/CAN), detects anomalies locally, and syncs state with the cloud over MQTT. Designed offline-first — buffers to SQLite during outages.

### Entry point & startup
```
node dist/app.js
  └─ src/app.ts          creates Agent + HealthArbiter + systemd watchdog
       └─ agent.init()   6-phase async init:
            1. core       DB, StateManager, ConfigManager
            2. logging    AgentLogger (local + cloud backends)
            3. infra      ContainerManager, MQTT, HTTP client
            4. device     Provisioning, Device API (port 48484)
            5. features   Anomaly, discovery, remote access, jobs
            6. sync       Cloud polling + reporting
```

### Key source directories
```
src/
  app.ts            Main entry point
  agent.ts          Orchestrator class
  init/             Phased initialization
  containers/       Docker orchestration & reconciliation
  mqtt/             MQTT connection, dictionary compression, routing
  sync/             Cloud state polling, device reporting, offline queue
  api/              Device REST API — Express, port 48484
  plugins/          Protocol adapters: Modbus, OPC-UA, BACnet, MQTT, SNMP, CAN
  anomaly/          Edge ML anomaly detection & alerting
  publish/          Publish targets: MQTT, Azure IoT, AWS IoT, GCP
  db/               SQLite models & migrations
  discovery/        Protocol discovery orchestration
  health/           HealthArbiter → systemd watchdog
  remote/           SSH tunneling + shell (node-pty)
  security/         Credentials, encryption, proof-of-possession
  network/          Firewall, VPN management
  system/           Memory leak detection, watchdog, system metrics
  logging/          Structured logging, cloud backend, log spooling
  core/             State machine, ConfigManager, AgentManager, socket server
```

### Architecture: state reconciliation
```
Cloud desired state (MQTT)
        ↓
   StateManager          ← SQLite (persistent)
        ↓
  Reconciliation loop
        ↓
  Docker containers / Protocol plugins (current state)
```

### Device API (port 48484)
```
GET  /ping / /healthy / /readiness
GET  /health/report
GET  /buffer/status
POST /provision
GET  /device/status
POST /containers/actions
GET  /logs
```

### Key env vars
```
STANDALONE=true           # disable cloud sync, run fully offline
IOTISTICA_API=<url>       # Iotistica Cloud API base URL
MQTT_BROKER_URL=<url>     # cloud MQTT broker URL
PROVISIONING_KEY=<key>    # one-time provisioning token
DEVICE_API_PORT=48484     # local HTTP API port (default 48484)
ANOMALY_DETECTION_ENABLED=true
DATA_DIR=<path>           # writable data directory
LOG_DIR=<path>
LOG_LEVEL=info
```

### Industrial protocols supported
Modbus TCP/RTU, OPC-UA, BACnet, SNMP, MQTT broker, CAN bus

### Cloud publish targets
Generic MQTT, Azure IoT Hub, AWS IoT Core, GCP IoT Core

### Build & run
```bash
npm run build          # tsc → dist/
npm run dev            # tsx watch src/app.ts
npm test               # Jest
docker build -t iotistica-agent .
```

### Resilience patterns
- Offline buffering: SQLite queue (`src/db/`) drains on MQTT reconnect
- Health arbiter drives systemd watchdog (30s checks)
- Memory leak detection → fatal shutdown if critical
- Exponential backoff on provisioning failures
- MQTT auto-reconnect with QoS 1

---

## mosquitto-agent/ — MQTT Auth Agent

Auth sidecar for the Mosquitto MQTT broker. See `mosquitto-agent/` for details.
