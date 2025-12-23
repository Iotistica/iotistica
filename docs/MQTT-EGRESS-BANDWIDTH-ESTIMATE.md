# MQTT Egress Bandwidth Estimation

**Last Updated:** 2025-12-23  
**Agent Version:** 1.0.197

## Terminology

- **Device:** Physical edge hardware (Raspberry Pi, x86_64 machine) running the agent
- **Agent:** The Iotistic agent software running on the device (one agent per device)
- **Endpoint:** A protocol adapter (Modbus, OPC UA) configured within the agent
  - **Example:** One agent can connect to 5 Modbus PLCs = 5 endpoints in one agent

**All bandwidth estimates below are per device/agent instance.**

**Important:** "5 Modbus devices" means one agent with 5 Modbus endpoint configurations, not 5 separate agents.

---

## Summary

Based on current agent configuration and typical deployment scenarios, estimated MQTT egress bandwidth ranges from **~500 KB/day** (minimal) to **~50 MB/day** (heavy industrial) **per agent instance**.

---

## Configuration Defaults

### Agent State Reporting Intervals

From `agent/src/config/agent-config.ts` and `agent/src/device-manager/sync.ts`:

| Metric | Default Interval | Purpose |
|--------|-----------------|---------|
| **Target State Poll** | 60s | Check for cloud configuration changes |
| **Device Report** | 60s | Send current state (apps, config, endpoints) |
| **System Metrics** | 5min (300s) | CPU, memory, storage, temperature, network |

### Sensor Publishing Intervals

From `agent/src/features/sensor-publish/types.ts`:

| Parameter | Default Value | Purpose |
|-----------|--------------|---------|
| **Publish Interval** | 30s (30,000ms) | MQTT publishing frequency per endpoint |
| **Buffer Capacity** | 1 MB | Max buffer size (increased for large OPC UA messages) |
| **Poll Interval (OPC UA)** | 5s (example) | How often to read from OPC UA server |
| **Poll Interval (Modbus)** | 10s (default `addrPollSec`) | How often to read from Modbus device |

---

## Payload Size Analysis

### 1. Agent State Reporting

#### Device Report (Every 60s)

**Minimal Report** (no config changes, no metrics):
```json
{
  "abc-123-uuid": {
    "apps": {},
    "is_online": true,
    "version": 1
  }
}
```
**Size:** ~100 bytes compressed (~60 bytes gzip)

**Full Report with Config** (first report or config changed):
```json
{
  "abc-123-uuid": {
    "apps": {...},
    "is_online": true,
    "version": 1,
    "config": {
      "endpoints": [
        {
          "name": "plc-001",
          "protocol": "opcua",
          "pollInterval": 5000,
          "connection": {...},
          "dataPoints": [...]
        }
      ],
      "network": {...},
      "features": {...}
    },
    "endpoints_health": [...]
  }
}
```
**Size:** ~3-15 KB (depends on endpoint count)

**Metrics Report** (every 5min):
```json
{
  "abc-123-uuid": {
    "apps": {},
    "is_online": true,
    "version": 1,
    "cpu_usage": 23.5,
    "memory_usage": 512000000,
    "memory_total": 1024000000,
    "storage_usage": 5368709120,
    "storage_total": 32212254720,
    "temperature": 45.2,
    "uptime": 86400,
    "top_processes": [...],
    "network_interfaces": [...],
    "sensor_health": {...},
    "vpn_health": {...}
  }
}
```
**Size:** ~4-8 KB (depends on process count and network interfaces)

#### Estimated Report Bandwidth

| Scenario | Size per Report | Frequency | Daily Reports | Daily Bandwidth |
|----------|----------------|-----------|---------------|-----------------|
| **Minimal** (no changes) | 60 bytes | 60s | 1,440 | ~86 KB/day |
| **Typical** (occasional config) | 2 KB average | 60s | 1,440 | ~2.8 MB/day |
| **Heavy** (frequent changes) | 5 KB average | 60s | 1,440 | ~7 MB/day |
| **Metrics cycle** | +4 KB | 300s (5min) | 288 | +1.1 MB/day |

**Total Agent Reporting:** ~1-4 MB/day typical, ~8 MB/day maximum

---

### 2. Sensor Data Publishing (Modbus/OPC UA)

#### OPC UA Data Points

From `opcua-config.example.json`:
- **Device 1 (plc-001):** 4 data points, 5s poll interval
- **Device 2 (scada-gateway):** 3 data points, 2s poll interval

**Single OPC UA Reading** (4 data points):
```json
{
  "timestamp": "2025-12-23T10:30:00.123Z",
  "device": "plc-001",
  "temperature": 23.5,
  "pressure": 1.02,
  "flow_rate": 45.6,
  "valve_status": true
}
```
**Size:** ~150-200 bytes uncompressed (~120 bytes with gzip)

#### Modbus Data Points

**Typical Modbus Reading** (10 registers):
```json
{
  "timestamp": "2025-12-23T10:30:00.123Z",
  "device": "modbus-rtu-001",
  "registers": [
    {"addr": 40001, "value": 235},
    {"addr": 40002, "value": 1020},
    ...
  ]
}
```
**Size:** ~250-400 bytes uncompressed (~180 bytes with gzip)

#### Publishing Calculation

**Default:** 30s publish interval (not poll interval!)

| Protocol | Data Points | Publish Interval | Size per Msg | Daily Messages | Daily Bandwidth |
|----------|-------------|------------------|--------------|----------------|-----------------|
| **OPC UA (1 device)** | 4 | 30s | 200 bytes | 2,880 | ~576 KB/day |
| **OPC UA (2 devices)** | 7 total | 30s | 350 bytes | 2,880 | ~1 MB/day |
| **Modbus (1 device)** | 10 registers | 30s | 400 bytes | 2,880 | ~1.15 MB/day |
| **Modbus (5 devices)** | 50 registers | 30s | 2 KB | 2,880 | ~5.7 MB/day |

**Note:** Poll interval (5s for OPC UA) determines how often data is **collected** from the device. Publish interval (30s default) determines how often data is **sent to MQTT**. The system buffers intermediate readings.

---

### 3. Buffer Overflow Protection

From `agent/src/features/sensor-publish/sensor.ts`:
- **Buffer Capacity:** 1 MB (default, configurable)
- **Behavior:** Drops oldest data when buffer full
- **Logging:** Warns on overflow (not sent to MQTT)

**Impact:** In high-volume scenarios (e.g., 1s poll + 1s publish), buffer prevents unbounded memory growth but data loss is possible.

---

## Total Bandwidth Estimates

### Scenario 1: Minimal Deployment
- **Agent reporting:** Minimal (86 KB/day)
- **Endpoints:** 0 (no sensors configured)
- **Total per agent:** ~86 KB/day (~2.6 MB/month)

### Scenario 2: Light Industrial
- **Agent reporting:** Typical (3.9 MB/day)
- **Endpoints:** 1 OPC UA endpoint with 4 data points, 30s publish
- **Total per agent:** ~4.5 MB/day (~135 MB/month)

### Scenario 3: Medium Industrial
- **Agent reporting:** Typical with frequent config changes (5 MB/day)
- **Endpoints:** 2 OPC UA + 2 Modbus endpoints (4 total in one agent)
  - OPC UA: 7 data points, 30s publish = ~1 MB/day
  - Modbus: 20 registers, 30s publish = ~2.3 MB/day
- **Total per agent:** ~8.3 MB/day (~250 MB/month)

### Scenario 4: Heavy Industrial
- **Agent reporting:** Heavy with metrics (8 MB/day)
- **Endpoints:** 5 Modbus endpoints (all in one agent), 50 registers total, 10s publish
  - 50 registers × ~400 bytes × 8,640 msgs/day = ~17 MB/day
- **Total per agent:** ~25 MB/day (~750 MB/month)
- **Example:** One Raspberry Pi connecting to 5 different Modbus PLCs on the factory floor

### Scenario 5: Extreme Edge Case
- **Agent reporting:** Heavy (8 MB/day)
- **Endpoints:** 10 endpoints in one agent, 100 data points total, 5s publish
  - 100 points × ~300 bytes × 17,280 msgs/day = ~52 MB/day
- **Total per agent:** ~60 MB/day (~1.8 GB/month)
- **Example:** One edge gateway polling 10 industrial devices

---

## Optimization Recommendations

### 1. Increase Publish Interval
**Current:** 30s default  
**Recommendation:** 60s for most deployments (halves sensor bandwidth)

```json
{
  "publishInterval": 60000
}
```

### 2. Enable MQTT Compression
**Impact:** ~40-60% reduction on JSON payloads

### 3. Delta Compression
**Current:** Config change detection via hashing  
**Future:** Send only changed data points (e.g., only send temperature if it changed >0.5°C)

### 4. Batch Publishing
**Current:** Individual messages per device  
**Future:** Combine multiple devices into single MQTT message

### 5. Adjust Metrics Interval
**Current:** 5min (300s)  
**Recommendation:** 15min for stable deployments (reduces metrics bandwidth by 67%)

```json
{
  "metricsIntervalMs": 900000
}
```

---

## MQTT QoS Impact

From typical agent implementation:
- **QoS 0** (at most once): No overhead
- **QoS 1** (at least once): ~2 bytes overhead + ACK packet
- **QoS 2** (exactly once): ~4 bytes overhead + 2 ACK packets

**Recommendation:** Use QoS 1 for sensor data (small overhead, reliable delivery)

---

## Network Overhead

### MQTT Protocol Overhead
- **MQTT header:** ~2-5 bytes per message
- **Topic length:** ~20-50 bytes (e.g., `device/abc-123/sensor/opcua`)
- **QoS ACKs:** ~2-4 bytes per message (QoS 1)

**Total overhead:** ~10-15% of payload size

### TCP/IP Overhead
- **TCP header:** 20 bytes
- **IP header:** 20 bytes
- **TLS (if enabled):** ~5-10% additional

**Total protocol overhead:** ~20-25% with TLS, ~15-20% without TLS

---

## Bandwidth Allocation by Type

For a **Medium Industrial** deployment (~8.3 MB/day):

| Type | Daily Bandwidth | Percentage |
|------|----------------|-----------|
| Sensor data (OPC UA/Modbus) | ~3.3 MB | 40% |
| Agent state reports | ~3.9 MB | 47% |
| System metrics | ~1.1 MB | 13% |
| **Total** | **8.3 MB** | **100%** |

---

## Cloud Sync Optimization (Already Implemented)

From `agent/src/device-manager/sync.ts`:

### Hash-Based Change Detection
- **Config changes:** Only send config if hash changed (saves ~90% on static deployments)
- **Endpoint health:** Only send if changed or on metrics cycle
- **Static fields:** OS version, agent version only on change

**Impact:** Reduces typical agent reporting from ~5 MB/day to ~1-2 MB/day on stable systems

### Conditional Metrics
- **Full metrics:** Only every 5min (not every 60s)
- **Partial state:** Lightweight updates between metrics cycles

**Impact:** Reduces bandwidth by ~75% compared to sending full metrics every 60s

---

## Cost Implications

### AWS IoT Core Pricing (Example)
- **Messaging:** $1.00 per million messages
- **Connectivity:** $0.08 per million connection-minutes

#### Medium Industrial Deployment
- **Messages/day:** ~3,200 (agent reports + sensor data)
- **Messages/month:** ~96,000
- **Messaging cost:** $0.096/month
- **Connectivity:** ~43,200 min/month = $3.46/month
- **Total:** ~$3.56/month/device

#### Heavy Industrial Deployment
- **Messages/day:** ~18,000
- **Messages/month:** ~540,000
- **Messaging cost:** $0.54/month
- **Connectivity:** $3.46/month
- **Total:** ~$4/month/device

**Note:** Actual costs vary by cloud provider. Azure IoT Hub and Google Cloud IoT are similar.

---

## Recommendations by Deployment Size

### Small Fleet (<10 devices)
- **Publish interval:** 30s (default)
- **Metrics interval:** 5min (default)
- **Estimated bandwidth:** 5-10 MB/day/device
- **Monthly data:** 150-300 MB/device

### Medium Fleet (10-100 devices)
- **Publish interval:** 60s
- **Metrics interval:** 10min
- **Estimated bandwidth:** 3-5 MB/day/device
- **Monthly data:** 90-150 MB/device

### Large Fleet (100+ devices)
- **Publish interval:** 120s
- **Metrics interval:** 15min
- **Conditional metrics:** Enable delta compression
- **Estimated bandwidth:** 1-3 MB/day/device
- **Monthly data:** 30-90 MB/device

---

## Monitoring Bandwidth Usage

### Agent-Side Metrics

Track in agent logs:
```typescript
// From device-manager/sync.ts
const payloadSize = JSON.stringify(stateReport).length;
this.logger?.infoSync('State report sent', {
  payloadBytes: payloadSize,
  payloadKB: (payloadSize / 1024).toFixed(2)
});
```

### Cloud-Side Aggregation

Collect from MQTT broker:
- Message count per device/hour
- Payload size distribution
- Topic breakdown (sensor vs. agent)

### Dashboard Metrics

Display:
- Daily egress per device
- Top bandwidth consumers
- Anomaly detection (sudden spikes)

---

## Future Optimizations

### 1. Protocol Buffers (Protobuf)
**Impact:** ~70% size reduction vs. JSON  
**Trade-off:** Requires schema management

### 2. Edge Analytics
**Impact:** Send aggregates (avg, min, max) instead of raw values  
**Example:** Send hourly summary instead of 120 individual readings

### 3. Adaptive Intervals
**Impact:** Increase intervals when values stable, decrease when changing  
**Example:** Temperature stable for 10min → switch to 5min polling

### 4. On-Demand Metrics
**Impact:** Only send full metrics when cloud requests  
**Trigger:** Cloud sends MQTT command `device/{uuid}/metrics/request`

---

## Conclusion

**Current Implementation:**
- Well-optimized with hash-based change detection
- Bandwidth-conscious defaults (60s report, 5min metrics)
- Buffer overflow protection prevents runaway memory

**Typical Bandwidth:** 1-10 MB/day per device, depending on sensor count and publish frequency

**Cost-Effective:** <$5/month/device for most deployments on AWS IoT Core

**Scalable:** Can support 1,000+ devices with current architecture without infrastructure changes
