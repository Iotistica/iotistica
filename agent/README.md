# Iotistic Agent

Edge device agent for the Iotistic IoT platform. Provides container orchestration, cloud synchronization, device provisioning, and real-time monitoring for IoT devices running on Raspberry Pi, x86_64, and other edge hardware.

## 🎯 Quick Start

### CLI Tool - iotctl

The agent includes a powerful CLI tool for device management:

```bash
# Inside the Docker container

# Provisioning commands
iotctl provision <key>            # Provision with cloud (--api, --name, --type options)
iotctl provision status           # Check provisioning state
iotctl deprovision                # Remove cloud registration (keeps UUID/deviceApiKey)
iotctl factory-reset              # WARNING: Complete wipe! Deletes everything

# Configuration commands
iotctl config show                # Show all configuration
iotctl config set-api <url>       # Update cloud API endpoint
iotctl config get-api             # Show current API endpoint
iotctl config set <key> <value>   # Set any config value
iotctl config get <key>           # Get specific config value
iotctl config reset               # Reset to defaults

# Device management
iotctl status                     # Device health and status
iotctl diagnostics                # Run full system diagnostics (API, DB, MQTT, cloud)
iotctl diag                       # Short alias for diagnostics
iotctl restart                    # Restart the agent
iotctl logs --follow              # View agent logs (use from host: docker logs -f agent-1)
iotctl logs -n 50                 # Show last 50 log lines

# Application-level commands (manage entire stacks)
iotctl apps list                  # List all apps and services
iotctl apps start 1001            # Start all services in app
iotctl apps stop 1001             # Stop all services in app
iotctl apps restart 1001          # Restart entire app stack
iotctl apps info 1001             # Show app details
iotctl apps purge 1001            # Remove app + volumes

# Service-level commands (manage individual containers)
iotctl services list              # List all services/containers
iotctl services list 1001         # Services in specific app
iotctl services start web-1       # Start one container
iotctl services stop api-2        # Stop one container
iotctl services restart db-1      # Restart one container
iotctl services logs web-1 -f     # Follow container logs
iotctl services info web-1        # Detailed service info

# System
iotctl help                       # Show all commands
iotctl version                    # Show CLI version
```

**Key Features:**
- ✅ REST client to Device API (port 48484 by default)
- ✅ Structured logging (no emojis, JSON context)
- ✅ Provisioning with two-phase authentication
- ✅ Factory reset support
- ✅ No config files - all data from Device API/database
- ✅ **Dual-level control**: Apps (stacks) + Services (containers)

**Architecture:**
- **App** = Collection of one or more services (like docker-compose stack)
- **Service** = Individual Docker container
- **Apps commands** = Manage entire stacks (all containers in app)
- **Services commands** = Manage individual containers

**Example Workflow:**
```bash
# Check device status
docker exec agent-1 iotctl status
# [INFO] Agent running {"uuid":"1dc6ce29-be81-49ee-aad7-b2d317a96fbb"}
# [INFO] Applications {"configured":0,"runningServices":0}

# List all apps and their services
docker exec agent-1 iotctl apps list

# List individual services
docker exec agent-1 iotctl services list

# Start entire app stack
docker exec agent-1 iotctl apps start 1001

# Restart just one service in the stack
docker exec agent-1 iotctl services restart myapp-web-1

# Follow logs from specific service
docker exec agent-1 iotctl services logs myapp-api-2 -f
```

### Anomaly Detection (Edge AI)

Real-time anomaly detection monitors device metrics using multiple ML algorithms running **locally on the device** (no cloud dependency):

**Monitored Metrics:**
- **System**: CPU usage, CPU temperature, memory usage, storage usage, network metrics
- **Sensors**: Custom sensor data via MQTT (temperature, humidity, pressure, gas, etc.)
- **Quality Tracking**: Data quality indicators (GOOD/UNCERTAIN/BAD)

**Detection Algorithms:**
1. **Z-Score** - Statistical deviation from baseline (σ > 3)
2. **MAD (Median Absolute Deviation)** - Robust outlier detection
3. **IQR (Interquartile Range)** - Quartile-based outliers (1.5× IQR rule)
4. **Rate of Change** - Sudden spikes/drops detection
5. **ML Predictions** - LSTM-based time-series forecasting (optional)

**Configuration:**
```bash
# Environment variables
ANOMALY_DETECTION_ENABLED=true           # Enable/disable anomaly detection
ANOMALY_WINDOW_SIZE=100                  # Samples for baseline calculation
ANOMALY_SENSITIVITY=medium               # low|medium|high (affects thresholds)
ANOMALY_ML_ENABLED=false                 # Enable LSTM predictions (experimental)
```

**Automatic Cloud Reporting:**
```typescript
// Agent automatically reports anomalies to cloud every 60s
CloudSync.getSummaryForReport(10);  // Last 10 anomalies included in report
```

**Example Anomaly Output:**
```json
{
  "timestamp": 1736985600000,
  "source": "system",
  "metric": "memory_percent",
  "value": 95.2,
  "method": "zscore",
  "severity": "critical",
  "confidence": 0.95,
  "deviation": 16.97,
  "quality": "GOOD",
  "threshold": 3.0
}
```

**Severity Levels:**
- `info` - Minor deviation (notification only)
- `warning` - Moderate deviation (attention needed)
- `critical` - Major deviation (immediate action required)

**Integration with Simulation:**
- Anomaly detection works seamlessly with simulation mode
- Test detection algorithms by injecting controlled anomalies
- Verify cloud reporting without real hardware

**Wiring:**
- System metrics automatically fed to anomaly detector
- Sensor data can be fed via `AnomalyDetectionService.processDataPoint()`
- Results stored in memory (last 1000 anomalies) + sent to cloud

### Simulation Mode

Unified testing framework for realistic sensor data and anomaly injection:

**Configuration:**
```bash
# docker-compose.yml
SIMULATION_MODE=true
SIMULATION_CONFIG='{"scenarios":{"anomaly_injection":{"enabled":true,"metrics":["cpu_temp","memory_percent"],"pattern":"spike","intervalMs":30000,"magnitude":3},"sensor_data":{"enabled":true,"pattern":"realistic","publishIntervalMs":10000}}}'
```

**Features:**
- 📊 **Realistic sensor data** - BME688-style temperature, humidity, pressure, gas readings
- 🔥 **Anomaly injection** - Configurable spikes, drops, or drift patterns
- 🎭 **Multiple patterns** - Random, sine wave, realistic variations
- ⏱️ **Configurable intervals** - Control data generation frequency
- 🎯 **Metric targeting** - Inject anomalies into specific metrics

**Patterns:**
- `spike` - Sudden short-lived increases
- `drop` - Sudden short-lived decreases  
- `drift` - Gradual trending changes
- `random` - Chaotic variations
- `sine` - Cyclical patterns

**Use Cases:**
- Testing anomaly detection algorithms
- Stress testing cloud sync
- UI/dashboard development without hardware
- CI/CD integration testing

## ⚡ Performance Optimizations

### System Metrics Collection

**Graceful Degradation** - Never crash, always return data:

Every metric collection is wrapped in a safe executor that prevents exceptions from propagating. If any single metric fails (sensor offline, permission denied, etc.), the system returns a sensible fallback value and continues collection:

```typescript
const safe = async <T>(fn: () => Promise<T>, fallback: T) => {
  try { return await fn(); }
  catch { return fallback; }
};

// Example: Memory collection fails? Return zeros instead of crashing
const memory = await safe(getMemoryInfo, { used: 0, total: 0, percent: 0 });
```

**Why This Matters:**
- **Edge Reliability**: Sensors fail, hardware glitches - partial data is better than no data
- **Never Crash**: Metrics collection always succeeds, even with failing hardware
- **Production Ready**: Cloud gets the data it can, logs the rest
- **Debugging Friendly**: Fallback values (0, null, [], 'unknown') are easily identifiable

**Fallback Values:**
- `cpuUsage`: 0
- `cpuTemp`: null (may not exist on all platforms)
- `cpuCores`: 1
- `memoryInfo`: { used: 0, total: 0, percent: 0 }
- `storageInfo`: { used: null, total: null, percent: null }
- `uptime`: 0
- `hostname`: 'unknown'
- `undervolted`: false
- `networkInterfaces`: []
- `topProcesses`: []

**Static Value Caching** - Immutable or rarely-changing system properties are cached to dramatically improve performance on subsequent calls:

**Truly Static Values** (cached indefinitely after first retrieval):
- `hostname` - Device hostname (never changes)
- `cpuCores` - Number of CPU cores (never changes)

**Semi-Static Values** (cached with auto-expiry):
- `networkInterfaces` - Network interface configuration (30-second TTL)
  - Auto-expires to detect WiFi SSID changes, VPN connections, docker0 appearance, etc.

**Dynamic Values** (fetched every collection):
- `cpuUsage`, `cpuTemp` - Current CPU state
- `memoryInfo` - Current RAM usage
- `storageInfo` - Current disk usage
- `uptime` - System uptime

**Performance Results:**
- **First collection**: ~2100ms (caches static values)
- **Subsequent collections**: ~400-800ms (13x faster!)
- **Overall improvement**: 92% reduction from original 5000ms baseline

**Platform-Specific Optimizations:**

**Process Collection** - Expensive `topProcesses` data collection is platform-aware:
```bash
# Default behavior:
# - Windows (development): Processes DISABLED (slow on Windows)
# - Linux (production): Processes ENABLED (fast on Linux)

# Override via environment variable:
COLLECT_TOP_PROCESSES=true   # Force enable (e.g., Windows debugging)
COLLECT_TOP_PROCESSES=false  # Force disable (e.g., Linux resource constraints)
```

**Timing Instrumentation:**
- All metric collection operations timed automatically
- Operations >500ms logged with detailed breakdown
- Top 10 slowest operations shown for visibility
- Helps identify platform-specific performance issues

**Garbage Collection Optimization:**
- **Zero-allocation hot paths** where possible
- Single-pass filter+score+sort in `getTopProcesses` (no intermediate arrays)
- Pre-allocated result arrays to avoid dynamic resizing
- In-place sorting to reduce memory pressure

**Platform CPU Normalization:**
- **Critical Fix**: systeminformation reports CPU differently across platforms
  - **Linux/Unix**: CPU % is per-core (e.g., 400% on 4-core system means 100% per core)
  - **Windows**: CPU % is per-system (e.g., 100% max total)
- **Solution**: Normalize Linux CPU by dividing by core count
- **Result**: Fair process comparison across all platforms
- **Example**: 100% CPU on one core = 25% on 4-core system (comparable to Windows)

**Before (incorrect comparison)**:
```typescript
// Linux process using 400% (1 core fully loaded on 4-core)
// Windows process using 25% (same workload)
// These look vastly different but are equivalent!
```

**After (normalized)**:
```typescript
const normalizedCpu = proc.cpu / cpuCoreCount;  // Linux only
// Both platforms now report 25% for same workload
// Fair scoring and ranking across platforms
```

**Before (multiple allocations)**:
```typescript
const filtered = processes.filter(...)  // New array #1
const sorted = filtered.sort(...)       // Mutates but creates comparisons
const top10 = sorted.slice(0, 10)       // New array #2
const formatted = top10.map(...)        // New array #3
```

**After (minimal allocations)**:
```typescript
const scored = [];                      // Single working array
for (const proc of processes) {
  // Inline filter + score calculation
}
scored.sort(...)                        // In-place sort
// Direct format into pre-allocated result
```

**Why This Matters:**
- Reduced GC pressure on resource-constrained devices
- Lower CPU usage during metrics collection
- More predictable latency (fewer GC pauses)
- Critical for edge devices with limited RAM
- Accurate process ranking regardless of platform

**Why This Matters:**
- Windows development: Sub-second metrics without sacrificing functionality
- Linux production: Full process data + fast performance
- Raspberry Pi: Optimized for resource-constrained edge devices

### OS-Specific Extended Metrics

**Enhanced platform-specific metrics** provide deeper insights into system behavior beyond standard monitoring:

**Linux Extended Metrics:**

1. **Load Average** (`load_average: number[]`)
   - 1, 5, and 15-minute load averages from `os.loadavg()`
   - Measures system resource demand over time
   - Example: `[0.5, 0.8, 1.2]` indicates increasing load

2. **Disk I/O** (`disk_io: { read: number; write: number }`)
   - Real-time disk operations per second
   - Uses `systeminformation.disksIO()`
   - Helps identify I/O bottlenecks

3. **CPU Throttling** (`cpu_throttling: { current_freq: number; max_freq: number }`)
   - Current vs. maximum CPU frequency (MHz)
   - Reads from `/sys/devices/system/cpu/cpu0/cpufreq/`
   - Detects thermal throttling or power-saving modes
   - Example: `{ current_freq: 1800, max_freq: 2400 }` = 75% max speed

**Windows Extended Metrics:**

1. **GPU Temperature** (`gpu_temp: number`)
   - Graphics card temperature in Celsius
   - Queries `MSAcpi_ThermalZoneTemperature` via WMI
   - Requires elevated privileges on some systems
   - Returns `undefined` if unavailable

2. **Disk Metrics** (`disk_metrics: { read_ops: number; write_ops: number }`)
   - Disk read/write operations per second
   - Uses `systeminformation.disksIO()`
   - Monitors storage subsystem activity

**Usage Example:**
```typescript
const metrics = await getSystemMetrics();

if (metrics.extended) {
  // Linux-specific
  if (metrics.extended.load_average) {
    const [load1, load5, load15] = metrics.extended.load_average;
    console.log(`Load: ${load1.toFixed(2)} (1m), ${load5.toFixed(2)} (5m)`);
  }
  
  if (metrics.extended.cpu_throttling) {
    const { current_freq, max_freq } = metrics.extended.cpu_throttling;
    const throttlePercent = ((max_freq - current_freq) / max_freq * 100).toFixed(1);
    console.log(`CPU throttled by ${throttlePercent}%`);
  }
  
  // Windows-specific
  if (metrics.extended.gpu_temp !== undefined) {
    console.log(`GPU Temperature: ${metrics.extended.gpu_temp}°C`);
  }
}
```

**Why This Matters:**
- **Performance Diagnosis**: Load average and disk I/O reveal system bottlenecks
- **Thermal Management**: CPU throttling and GPU temps detect overheating
- **Platform Optimization**: Leverage OS-specific APIs for richer telemetry
- **Graceful Degradation**: All extended metrics optional - returns `undefined` if unavailable
- **Production Insights**: Go beyond basic metrics without sacrificing reliability

## 🔐 MQTTS/TLS Setup

Secure MQTT communication with TLS encryption using self-signed or commercial certificates.

### Overview

The agent supports MQTTS (MQTT over TLS) with automatic certificate handling during provisioning. When a device is provisioned, it receives:
- Broker URL (`mqtts://mosquitto:8883`)
- MQTT credentials (username/password)
- **Broker configuration** including CA certificate for TLS verification

### Architecture Flow

```
1. API Database (PostgreSQL)
   └── system_config table
       └── mqtt.brokers.1 (JSONB)
           └── Contains: host, port, protocol, caCert, useTls, verifyCertificate

2. Provisioning (API → Agent)
   └── POST /api/provisioning/v2/register
       └── Response includes mqtt.brokerConfig with CA certificate

3. Agent Storage (SQLite)
   └── device table
       └── mqttBrokerConfig column (JSON string)
           └── Stores: protocol, host, port, useTls, caCert, verifyCertificate

4. Agent MQTT Connection
   └── agent.ts: initializeMqttManager()
       └── Reads mqttBrokerConfig from database
       └── Applies TLS options: { ca: caCert, rejectUnauthorized: verifyCertificate }
```

### Setup Steps

#### 1. Generate CA Certificate (Self-Signed)

```bash
# Create certs directory
mkdir -p certs

# Generate CA private key and certificate
openssl req -new -x509 -days 365 -extensions v3_ca \
  -keyout certs/ca.key -out certs/ca.crt \
  -subj "/CN=Iotistic CA"

# Generate server certificate signed by CA
openssl genrsa -out certs/server.key 2048
openssl req -new -out certs/server.csr -key certs/server.key \
  -subj "/CN=mosquitto"
openssl x509 -req -in certs/server.csr -CA certs/ca.crt \
  -CAkey certs/ca.key -CAcreateserial -out certs/server.crt \
  -days 365
```

#### 2. Configure Mosquitto Broker

```conf
# mosquitto/mosquitto.conf

# Standard MQTT (port 1883)
listener 1883
protocol mqtt
allow_anonymous false

# MQTTS with TLS (port 8883)
listener 8883
protocol mqtt
cafile /mosquitto/certs/ca.crt
certfile /mosquitto/certs/server.crt
keyfile /mosquitto/certs/server.key
require_certificate false
use_identity_as_username false
allow_anonymous false

# Authentication backend (PostgreSQL)
auth_plugin /mosquitto/go-auth.so
auth_opt_backends postgres
auth_opt_pg_host postgres
auth_opt_pg_port 5432
auth_opt_pg_dbname iotistic
auth_opt_pg_user postgres
auth_opt_pg_password password
auth_opt_pg_userquery SELECT password_hash FROM mqtt_users WHERE username = $1 AND enabled = TRUE LIMIT 1
auth_opt_pg_aclquery SELECT 1 FROM mqtt_acls WHERE username = $1 AND topic = $2 AND rw >= $3 LIMIT 1
```

#### 3. Store CA Certificate in API Database

```sql
-- Run migration 057 or manually insert
UPDATE system_config
SET value = jsonb_set(
  value,
  '{caCert}',
  to_jsonb('-----BEGIN CERTIFICATE-----
...your CA certificate content...
-----END CERTIFICATE-----'::text)
)
WHERE key = 'mqtt.brokers.1';
```

Or use the migration:
```bash
cd api
npx knex migrate:latest  # Runs 057_add_mqtt_ca_certificate.sql
```

#### 4. Verify API Sends CA Certificate

Check `api/src/utils/mqtt-broker-config.ts`:
```typescript
export function formatBrokerConfigForClient(config: any) {
  return {
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    useTls: config.useTls ?? config.use_tls,
    verifyCertificate: config.verifyCertificate ?? config.verify_certificate,
    // CA certificate included for TLS
    ...(config.caCert && { caCert: config.caCert }),
    // Other fields...
  };
}
```

#### 5. Agent Applies TLS Options

Check `agent/src/agent.ts`:
```typescript
// Build MQTT connection options
const mqttOptions: any = {
  clientId: `device_${this.deviceInfo.uuid}`,
  username: mqttUsername,
  password: mqttPassword,
};

// Add TLS options if broker config specifies TLS
if (this.deviceInfo.mqttBrokerConfig?.useTls && 
    this.deviceInfo.mqttBrokerConfig.caCert) {
  mqttOptions.ca = this.deviceInfo.mqttBrokerConfig.caCert; // String (PEM format)
  mqttOptions.rejectUnauthorized = this.deviceInfo.mqttBrokerConfig.verifyCertificate;
}

await mqttManager.connect(mqttBrokerUrl, mqttOptions);
```

### Provisioning with MQTTS

#### New Device Provisioning

```bash
# Start agent with provisioning key
docker run -e PROVISIONING_API_KEY=your-key \
  -e CLOUD_API_ENDPOINT=http://api:3002 \
  iotistic/agent:latest

# Agent auto-provisions and receives:
# - mqtt.brokerConfig.protocol = "mqtts"
# - mqtt.brokerConfig.host = "mosquitto"
# - mqtt.brokerConfig.port = 8883
# - mqtt.brokerConfig.caCert = "-----BEGIN CERTIFICATE-----\n..."
# - mqtt.brokerConfig.useTls = true
# - mqtt.brokerConfig.verifyCertificate = true
```

#### Re-Provisioning Existing Devices

If you added MQTTS **after** devices were already provisioned:

```bash
# Option 1: Delete device database (forces re-provisioning)
docker exec agent-1 rm /app/data/device.sqlite
docker restart agent-1

# Option 2: Manual database update (advanced)
docker exec agent-1 sqlite3 /app/data/device.sqlite
# UPDATE device SET mqttBrokerConfig = '{"protocol":"mqtts",...}';
```

### Verification

#### Check Agent Logs

```bash
docker logs agent-1 | grep -i "mqtt\|tls"

# Expected output:
# MQTT TLS enabled {"protocol":"mqtts","verifyCertificate":true,"hasCaCert":true}
# MQTT Manager connected {"brokerUrl":"mqtts://mosquitto:8883"}
```

#### Check Agent Database

```bash
# Create check script
cat > check-mqtt-config.js << 'EOF'
const Database = require('better-sqlite3');
const db = new Database('/app/data/device.sqlite');
const row = db.prepare('SELECT mqttBrokerConfig FROM device LIMIT 1').get();
console.log(JSON.stringify(JSON.parse(row.mqttBrokerConfig), null, 2));
EOF

# Run inside container
docker exec agent-1 node /app/check-mqtt-config.js

# Expected output:
# {
#   "protocol": "mqtts",
#   "host": "mosquitto",
#   "port": 8883,
#   "useTls": true,
#   "caCert": "-----BEGIN CERTIFICATE-----\n...",
#   "verifyCertificate": true
# }
```

#### Test MQTTS Connection

```bash
# Install mosquitto clients
apt-get install mosquitto-clients

# Test with CA certificate
mosquitto_pub -h localhost -p 8883 \
  --cafile ./certs/ca.crt \
  -u device_uuid -P mqtt_password \
  -t test -m "Hello MQTTS"

# Should succeed with no certificate errors
```

### Troubleshooting

#### Error: "self-signed certificate in certificate chain"

**Cause**: Agent doesn't have CA certificate or not applying TLS options.

**Fix**:
1. Check API database has CA cert: `SELECT value->'caCert' FROM system_config WHERE key = 'mqtt.brokers.1'`
2. Check agent database: Run check script above
3. Verify agent code applies TLS: Look for "MQTT TLS enabled" in logs
4. Re-provision device if needed

#### Error: "unable to verify the first certificate"

**Cause**: CA certificate doesn't match server certificate.

**Fix**:
1. Regenerate server cert signed by same CA
2. Ensure Mosquitto using correct `cafile`, `certfile`, `keyfile`
3. Restart Mosquitto: `docker restart iotistic-mosquitto`

#### Error: "ECONNREFUSED" on port 8883

**Cause**: Mosquitto not listening on MQTTS port.

**Fix**:
1. Check Mosquitto config has `listener 8883` section
2. Verify port exposed: `docker port iotistic-mosquitto 8883`
3. Check Mosquitto logs: `docker logs iotistic-mosquitto`

#### Missing CA Certificate in Provisioning Response

**Cause**: `formatBrokerConfigForClient()` not handling camelCase fields.

**Fix**: Update `api/src/utils/mqtt-broker-config.ts`:
```typescript
export function formatBrokerConfigForClient(config: any) {
  const caCert = config.caCert ?? config.ca_cert ?? null;
  return {
    // ... other fields
    ...(caCert && { caCert })
  };
}
```

### Production Considerations

**Certificate Rotation**:
- Update CA cert in `system_config` table
- Re-provision devices OR push new config via cloud sync
- Mosquitto auto-reloads on SIGHUP

**Client Certificates** (mutual TLS):
- Set `require_certificate true` in Mosquitto config
- Generate client certs for each device
- Include `clientCert` and `clientKey` in broker config

**Commercial Certificates**:
- Use Let's Encrypt or commercial CA instead of self-signed
- Update `caCert` in database to trusted root CA
- Clients automatically trust well-known CAs

**Certificate Expiration**:
- Monitor expiration dates
- Automate renewal (certbot for Let's Encrypt)
- Plan device update rollout before expiry

## 🔄 Cloud Sync Reliability

Robust cloud communication with automatic failure recovery and protection mechanisms.

### Circuit Breaker Protection

The agent implements circuit breakers for both poll and report operations to prevent hammering the cloud API during outages:

**Configuration:**
- **Failure Threshold**: 10 consecutive failures
- **Cooldown Period**: 5 minutes
- **Auto-Reset**: Circuit closes on first success after cooldown

**How It Works:**
```typescript
// Poll loop protection
if (pollCircuit.isOpen()) {
  // Skip operation, cooling down
  logger.warn('Poll circuit breaker open', {
    cooldownRemainingSec: circuit.getCooldownRemaining() / 1000,
    failureCount: circuit.getFailureCount()
  });
  return;
}

try {
  await pollTargetState();
  pollCircuit.recordSuccess(); // Reset counter
} catch (error) {
  const opened = pollCircuit.recordFailure();
  if (opened) {
    logger.error('Circuit breaker tripped - stopping polls for 5min');
  }
}
```

**Benefits:**
- Stops wasting resources on unreachable API
- Prevents log spam during prolonged outages
- Automatic recovery when API returns
- Independent circuits for poll/report (isolation)

### Request Deduplication

Async locks prevent overlapping requests if operations take longer than the poll/report interval:

**Problem Scenario:**
```
00:00 - Poll starts (takes 90s due to slow network)
01:00 - Timer fires, another poll attempts to start
01:30 - First poll still running, second poll blocked
```

**Solution:**
```typescript
// Before executing
if (pollLock.isLocked()) {
  logger.warn('Poll already in progress, skipping');
  return; // Prevents overlap
}

// Execute with lock
await pollLock.tryExecute(async () => {
  await pollTargetState(); // Guaranteed single execution
});
```

**Benefits:**
- No duplicate API calls
- No race conditions
- Predictable resource usage
- Clean error messages

### Error Counter Capping

Error counters are capped at 10 attempts to prevent overflow and extremely long backoff delays:

```typescript
// Before
this.pollErrors++; // Could increment forever

// After
this.pollErrors = Math.min(this.pollErrors + 1, 10); // Capped at 10
```

**Backoff Schedule** (with 15s base, 2x multiplier, 15min max):
| Attempt | Delay (without jitter) |
|---------|------------------------|
| 1       | 15s                    |
| 2       | 30s                    |
| 3       | 60s (1min)             |
| 4       | 120s (2min)            |
| 5       | 240s (4min)            |
| 6       | 480s (8min)            |
| 7+      | 900s (15min) - capped  |

**Benefits:**
- Prevents integer overflow
- Reasonable max retry delay (15min)
- Predictable behavior
- Faster recovery after long outages

### Combined Protection

All three mechanisms work together for robust failure handling:

```typescript
// Example: API down for 30 minutes

// 00:00 - Poll fails (attempt 1, backoff 15s)
// 00:15 - Poll fails (attempt 2, backoff 30s)
// 00:45 - Poll fails (attempt 3, backoff 1min)
// ... continues with exponential backoff ...
// 10:00 - Poll fails (attempt 10, circuit opens)
// 10:00 - Circuit breaker activated (5min cooldown)
// 15:00 - Circuit cooldown expires, resume polling
// 15:00 - Poll succeeds, all counters reset

// During this time:
// - No duplicate requests (async lock)
// - Backoff capped at 15min (error cap)
// - Stopped trying after 10 failures (circuit breaker)
```

### Monitoring

All protection mechanisms emit detailed logs for visibility:

```json
{
  "component": "cloudSync",
  "operation": "poll-circuit-open",
  "cooldownRemainingSec": 180,
  "failureCount": 10
}

{
  "component": "cloudSync", 
  "operation": "poll-circuit-trip",
  "consecutiveFailures": 10,
  "cooldownMs": 300000,
  "cooldownMin": 5
}

{
  "component": "cloudSync",
  "operation": "poll-skip-locked"
}
```

### Configuration

All protection is automatic with sensible defaults:

```typescript
// Circuit breaker (in constructor)
this.pollCircuit = new CircuitBreaker(
  10,              // maxFailures
  5 * 60 * 1000    // cooldownMs (5 minutes)
);

// Error counter cap (in loop)
this.pollErrors = Math.min(this.pollErrors + 1, 10);

// Async lock (automatic)
this.pollLock = new AsyncLock();
```

No environment variables needed - works out of the box!

### Utilities

All protection utilities are reusable via `retry-policy.ts`:

```typescript
import { CircuitBreaker, AsyncLock, isAuthError } from '../utils/retry-policy';

// Circuit breaker
const circuit = new CircuitBreaker(10, 5 * 60 * 1000);
if (circuit.isOpen()) { /* skip */ }

// Async lock
const lock = new AsyncLock();
await lock.tryExecute(async () => { /* protected operation */ });

// Error classification
if (isAuthError(error)) { /* refresh credentials */ }
```

### Dynamic Configuration Updates

The agent supports **hot-reloading** of configuration from cloud target state without requiring a restart. Configuration changes are detected during the poll cycle and applied immediately via event-driven handlers.

#### Supported Dynamic Updates

| Configuration Type | Update Method | Restart Required? |
|-------------------|---------------|-------------------|
| **Log Level** | `setLogLevel()` | ❌ No - Immediate |
| **Protocol Enabled/Disabled** | Database update | ❌ No - Next discovery cycle |
| **Container Reconciliation Interval** | Timer restart | ❌ No - Next iteration |
| **Memory Monitoring** | Service restart | ❌ No - Immediate |
| **Poll Interval** | `updateIntervals()` | ❌ No - Next poll |
| **Report Interval** | `updateIntervals()` | ❌ No - Next report |
| **Metrics Interval** | `updateIntervals()` | ❌ No - Next metrics |
| **Discovery Intervals** | Event emission | ❌ No - Timer restart |

#### How It Works

**1. Cloud API updates target state:**
```json
{
  "config": {
    "intervals": {
      "targetStatePollIntervalMs": 30000,
      "deviceReportIntervalMs": 60000,
      "metricsIntervalMs": 300000
    },
    "logging": {
      "logLevel": "debug"
    }
  }
}
```

**2. Agent polls and detects changes:**
```typescript
// CloudSync polls target state every 60s (default)
const newTargetState = await pollTargetState();
await stateReconciler.setTarget(newTargetState); // Triggers reconciliation
```

**3. StateReconciler emits granular events:**
```typescript
// Events emitted when config fields change
stateReconciler.emit('intervals-changed', { old, new });
stateReconciler.emit('logging-config-changed', { old, new });
stateReconciler.emit('protocol-config-changed', { old, new });
stateReconciler.emit('memory-config-changed', { old, new });
```

**4. AgentConfig handlers apply changes:**
```typescript
// Logging updates
handleLoggingConfigChanges() {
  this.logger.setLogLevel(newLevel); // ✅ Immediate effect
}

// Interval updates
handleIntervalsChanges() {
  this.cloudSync.updateIntervals({
    pollInterval: newPollInterval,
    reportInterval: newReportInterval,
    metricsInterval: newMetricsInterval
  }); // ✅ Next iteration uses new intervals
}
```

**Example: Changing Log Level**
```bash
# Cloud API updates device config
PATCH /api/devices/{uuid}/config
{
  "logging": { "logLevel": "debug" }
}

# Agent polls within 60s (default poll interval)
# StateReconciler detects change
# AgentConfig applies immediately
# ✅ Debug logs start appearing without restart!
```

**Example: Changing Poll Interval**
```bash
# Cloud API updates intervals
PATCH /api/devices/{uuid}/config
{
  "intervals": { "targetStatePollIntervalMs": 15000 }
}

# Agent polls within current interval (e.g., 60s)
# StateReconciler detects change
# CloudSync.updateIntervals() called
# ✅ Next poll happens in 15s instead of 60s!
```

**Benefits:**
- Zero-downtime configuration changes
- Immediate effect for critical settings (log level, monitoring)
- Gradual rollout (changes apply on next iteration, not mid-operation)
- No manual SSH/container access required
- Centralized configuration management from cloud dashboard

For transport handoff and local buffering behavior, see `docs/transport-switch-buffering-review.md`.

---

## 🐳 Docker Integration

Deploy, update, and manage containers with full Docker and Kubernetes support.

### Quick Start (30 seconds)

```bash
# Make sure Docker is running
docker ps

# Deploy your first container!
npx tsx quick-start.ts

# Visit http://localhost:8080
```

### Features

✅ **Docker Integration** - Uses dockerode for actual Docker operations  
✅ **State Reconciliation** - Automatically calculates and applies changes  
✅ **Multi-Container Apps** - Deploy complex stacks (like docker-compose)  
✅ **Rolling Updates** - Zero-downtime container updates  
✅ **REST API** - Control via HTTP (see `api/` folder)  
✅ **Simulated Mode** - Test without Docker  

---


## Project Structure

```
standalone-application-manager/
├── src/
│   ├── application-manager.ts  # Main application manager logic
│   ├── app.ts                  # App class for managing application state
│   ├── composition-steps.ts    # Composition step generation and execution
│   ├── types.ts                # TypeScript type definitions
│   ├── stubs.ts                # Stub implementations for dependencies
│   └── index.ts                # Main entry point
├── examples/
│   └── basic-usage.ts          # Example usage
├── package.json
├── tsconfig.json
└── README.md
```

## Installation

```bash
cd standalone-application-manager
npm install
```

## Building

```bash
npm run build
```

This will compile the TypeScript files to JavaScript in the `dist/` directory.

## Testing

Run the test suite to verify the application manager works correctly:

```bash
# Install test runner
npm install -D tsx

# Run simple test
npx tsx test/simple-test.ts

# Run test with mock data
npx tsx test/mock-data-test.ts

# Run comprehensive test
npx tsx test/basic-test.ts
```

See [test/README.md](test/README.md) for more testing options.

## Usage

### Basic Example

```typescript
import applicationManager from 'standalone-application-manager';

// Initialize the application manager
await applicationManager.initialized();

// Get current applications
const currentApps = await applicationManager.getCurrentApps();

// Get target applications (from your configuration source)
const targetApps = await applicationManager.getTargetApps();

// Calculate required steps to reach target state
const steps = await applicationManager.getRequiredSteps(
	currentApps,
	targetApps,
	false, // keepImages
	false, // keepVolumes
	false  // force
);

// Execute each step
for (const step of steps) {
	await applicationManager.executeStep(step);
}
```

### Listening to Events

```typescript
// Listen for application state changes
applicationManager.on('change', (report) => {
	console.log('Application state changed:', report);
});
```

## Key Concepts

### Applications

Applications are composed of:
- **Services**: Docker containers running your application code
- **Networks**: Network configurations for inter-service communication
- **Volumes**: Persistent storage for application data

### Composition Steps

The application manager generates "composition steps" that represent atomic operations needed to transition from the current state to the target state. Step types include:

- `fetch`: Download a container image
- `start`: Start a service
- `stop`: Stop a service
- `kill`: Kill a service (forceful stop)
- `remove`: Remove a stopped service
- `createNetwork`: Create a network
- `createVolume`: Create a volume
- `removeNetwork`: Remove a network
- `removeVolume`: Remove a volume
- `updateMetadata`: Update service metadata
- `takeLock`: Acquire update locks
- `releaseLock`: Release update locks

### Update Strategies

The manager supports different update strategies:
- **Download then kill**: Download new image first, then replace
- **Kill then download**: Stop service first, then download
- **Delete then download**: Remove everything first (for major changes)
- **Handover**: Gradual transition between versions

## Architecture

### Simplified Design

This standalone version uses stub implementations for external dependencies like:
- Database operations (replaced with in-memory or no-op stubs)
- Docker API calls (stubbed for demonstration)
- System configuration (using defaults)
- Logging infrastructure (console-based)

### Extension Points

To use this in production, you would need to implement:

1. **Docker Integration**: Replace stubs in `stubs.ts` with real Docker API calls using `dockerode`
2. **Database**: Implement actual persistence for target state and configuration
3. **Network Layer**: Implement real network management
4. **Volume Management**: Implement real volume lifecycle management
5. **Image Management**: Implement real image download, delta updates, and cleanup
6. **Service Manager**: Implement actual container lifecycle management
7. **Logging**: Integrate with your logging infrastructure

## API Reference

### Main Functions

#### `initialized(): Promise<void>`
Initializes the application manager. Must be called before other operations.

#### `getCurrentApps(): Promise<InstancedAppState>`
Returns the current state of all applications.

#### `getTargetApps(): Promise<TargetApps>`
Returns the desired target state for applications.

#### `getRequiredSteps(currentApps, targetApps, keepImages?, keepVolumes?, force?): Promise<CompositionStep[]>`
Calculates the steps needed to transition from current to target state.

Parameters:
- `currentApps`: Current application state
- `targetApps`: Desired application state
- `keepImages`: Don't remove unused images (optional, default: false)
- `keepVolumes`: Don't remove unused volumes (optional, default: false)
- `force`: Force updates even if locked (optional, default: false)

#### `executeStep(step, options?): Promise<void>`
Executes a single composition step.

#### `setTarget(apps, source, transaction): Promise<void>`
Sets the target state for applications.

#### `getState(): Promise<AppState>`
Returns the current state formatted for reporting.

### Events

The application manager emits the following events:

- `change`: Emitted when application state changes

## Development

### Project Setup

1. Clone or extract to a separate folder
2. Install dependencies: `npm install`
3. Build: `npm run build`
4. Watch mode: `npm run watch`

### Testing

Currently, this is a demonstration extraction. To make it production-ready:

1. Implement actual Docker operations
2. Add comprehensive unit tests
3. Add integration tests with real Docker daemon
4. Implement error handling and retry logic
5. Add monitoring and observability

## Limitations

This standalone version is a simplified extraction that:
- Uses stub implementations for external dependencies
- Lacks full error handling
- Requires additional work to be production-ready


## 🔍 Protocol Discovery

**Automatic device discovery** for industrial protocols with two-phase architecture and periodic scanning.

### Discovery Features

- **Auto-discovery on boot** - Finds devices on first startup
- **Periodic light scans** - Fast ping-only checks every 4 hours (default)
- **Periodic full scans** - Deep validation with device info every 24 hours (default)
- **Manual triggers** - On-demand discovery via API/CLI
- **Multi-protocol support** - Modbus, OPC-UA, CAN Bus
- **SQLite persistence** - Discovered devices saved to database
- **Rate limiting** - Prevents excessive scanning (min 1 hour between scheduled scans)

### Two-Phase Discovery Architecture

**Phase 1 - Fast Discovery** (ping only):
- Quick scan to detect responding devices
- No deep validation or device info reads
- Minimal network overhead
- Used for scheduled light scans

**Phase 2 - Deep Validation** (optional):
- Reads device identification and metadata
- Validates protocol compliance
- Slower but comprehensive
- Used for first boot and periodic full scans

### Configuration

```bash
# Environment variables
ENABLE_FIRST_BOOT_DISCOVERY=true          # Run discovery on agent startup
ENABLE_PERIODIC_DISCOVERY=true            # Enable scheduled discovery (default: true)
DISCOVERY_LIGHT_INTERVAL_MS=14400000      # Light scan interval (4 hours default)
DISCOVERY_FULL_INTERVAL_MS=86400000       # Full scan interval (24 hours default)

# Modbus-specific
MODBUS_TCP_HOST=192.168.1.100             # Modbus TCP host to scan
MODBUS_TCP_PORT=502                       # Modbus TCP port (default: 502)
MODBUS_SERIAL_PORT=/dev/ttyUSB0           # Serial port for RTU (optional)
MODBUS_BAUD_RATE=9600                     # Serial baud rate (default: 9600)
MODBUS_SLAVE_RANGE_START=1                # Start of slave ID range
MODBUS_SLAVE_RANGE_END=247                # End of slave ID range
MODBUS_TIMEOUT=2000                       # Timeout per slave scan (ms)

# OPC-UA-specific
OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840  # OPC-UA server URLs (comma-separated)

# CAN-specific
CAN_INTERFACE=can0                        # CAN bus interface
```

### Discovery Schedule

| Trigger | Timing | Validation | Use Case |
|---------|--------|------------|----------|
| **First Boot** | On startup | Full (with device info) | Initial device inventory |
| **Light Scan** | Every 4 hours | None (ping only) | Detect online/offline changes |
| **Full Scan** | Every 24 hours | Full (with device info) | Update device metadata |
| **Manual** | On demand | Configurable | Troubleshooting, testing |

### Discovered Device Storage

Devices are automatically saved to SQLite `sensors` table with:
- Unique fingerprint (protocol + connection details)
- Protocol type (modbus, opcua, can)
- Connection info (host, port, slave ID, etc.)
- Device metadata (vendor, model, firmware)
- Discovery timestamp
- Status: `enabled=false` (requires manual enablement)

### Best Practices

**Industrial IoT Requirements:**
- ✅ Detect new devices added to network
- ✅ Identify failed/offline devices
- ✅ Handle IP address changes
- ✅ Support hot-swapped equipment
- ✅ Minimize network overhead with two-phase scans

**Why Periodic Discovery Matters:**
Discovery only on boot is **not sufficient** for industrial environments where:
- Devices are added during maintenance
- Network configurations change
- Equipment fails and needs replacement
- Hot-swap scenarios are common

## 📡 Protocol Adapters

Industrial protocol adapters for sensor data collection with production-grade reliability and performance.

### Supported Protocols

- **Modbus TCP/RTU** - Industry-standard PLC/sensor communication ✅ **Production Ready**
- **OPC-UA** - Industrial IoT standard ✅ **Integrated**
- **CAN Bus** - Automotive and industrial networking (planned)

### Modbus TCP/RTU Adapter

**Production-ready Modbus client** with all industry best practices implemented:

#### Key Features

✅ **Connection Types**: TCP, RTU (serial), ASCII  
✅ **Data Types**: UINT16, INT16, UINT32, INT32, FLOAT32, STRING  
✅ **Function Codes**: 1 (Coils), 2 (Discrete Inputs), 3 (Holding), 4 (Input)  
✅ **Byte Ordering**: ABCD, CDAB, BADC, DCBA (32-bit values)  
✅ **Batch Optimization**: 10x-100x faster with intelligent register grouping  
✅ **Concurrency Control**: Mutex lock prevents frame corruption  
✅ **Exception Handling**: All 8 Modbus exceptions with auto-retry  
✅ **Exponential Backoff**: Smart reconnection (5s → 60s)  
✅ **Health Tracking**: Timestamps for monitoring/alerting  
✅ **TCP Keep-Alive**: Prevents gateway timeouts (30s interval)  

#### Configuration

```json
{
  "name": "modbus-device-1",
  "enabled": true,
  "protocol": "modbus",
  "connection": {
    "type": "TCP",
    "host": "192.168.1.100",
    "port": 502,
    "timeout": 5000
  },
  "registers": [
    {
      "name": "temperature",
      "address": 0,
      "functionCode": 3,
      "dataType": "uint16",
      "byteOrder": "ABCD",
      "scale": 0.1,
      "offset": 0,
      "unit": "°C"
    },
    {
      "name": "pressure",
      "address": 10,
      "functionCode": 3,
      "dataType": "float32",
      "byteOrder": "CDAB",
      "unit": "bar"
    }
  ],
  "pollInterval": 5000
}
```

#### Data Types & Byte Ordering

**16-bit Values** (uint16, int16):
- Always big-endian (Modbus standard)
- Single register

**32-bit Values** (uint32, int32, float32):
- Two consecutive registers
- Configurable byte order:
  - **ABCD** (Big-endian) - Default, most common
  - **CDAB** (Word-swapped) - Common in some PLCs
  - **BADC** (Byte-swapped) - Rare
  - **DCBA** (Little-endian) - Least common

**STRING Values**:
- Multi-register ASCII/UTF-8 strings
- Configurable encoding: `ascii`, `utf8`, `latin1`, `binary`
- Automatic null terminator removal and trimming
- Example: `"encoding": "utf8"` for international characters

#### Batch Read Optimization

**Critical Performance Enhancement** - Groups contiguous registers into single requests:

**Before (Individual Reads)**:
```typescript
// Reading 10 registers = 10 separate Modbus requests
readRegister(0);   // Request 1
readRegister(1);   // Request 2
readRegister(2);   // Request 3
// ... 10 requests total (slow!)
```

**After (Batch Reads)**:
```typescript
// Same 10 registers = 1 Modbus request
readRegisterBatch([0,1,2,3,4,5,6,7,8,9]);  // Single request (10x-100x faster!)
```

**How It Works**:
1. Groups registers by function code
2. Sorts by address
3. Finds contiguous blocks (allows 2-register gaps)
4. Respects 125-register Modbus limit
5. Automatic fallback to individual reads if batch fails

**Performance Results**:
- 10 registers: **10x faster** (1 request vs 10)
- 50 registers: **50x faster** (2-3 requests vs 50)
- 100 registers: **100x faster** (1 request vs 100)

**Configuration**:
- Enabled by default (no config needed)
- Automatic gap tolerance (up to 2 unused registers)
- Smart function code grouping (FC3 and FC4 batched separately)

#### Modbus Exception Handling

**Comprehensive exception detection** with auto-retry for transient errors:

| Code | Name | Description | Auto-Retry |
|------|------|-------------|------------|
| 1 | ILLEGAL_FUNCTION | Unsupported function code | ❌ No |
| 2 | ILLEGAL_DATA_ADDRESS | Invalid register address | ❌ No |
| 3 | ILLEGAL_DATA_VALUE | Invalid data value | ❌ No |
| 4 | SLAVE_DEVICE_FAILURE | Device hardware error | ❌ No |
| 5 | ACKNOWLEDGE | Device busy (long operation) | ✅ Yes (3 attempts) |
| 6 | SLAVE_DEVICE_BUSY | Device temporarily busy | ✅ Yes (3 attempts) |
| 7 | NEGATIVE_ACKNOWLEDGE | Cannot perform request | ❌ No |
| 8 | MEMORY_PARITY_ERROR | Memory parity error | ❌ No |

**Auto-Retry Logic**:
- Exception 6 (DEVICE_BUSY): 3 attempts, 100ms delay
- Exception 5 (ACKNOWLEDGE): 3 attempts, 100ms delay
- All others: Marked as BAD quality, logged, no retry

#### Concurrency Protection

**Critical: modbus-serial library is NOT thread-safe!**

**Mutex Lock Pattern**:
```typescript
// All reads wrapped in lock to prevent concurrent access
await this.lock(() => this.client.readHoldingRegisters(addr, count));

// Without lock (WRONG - will corrupt frames):
Promise.all([
  client.readHoldingRegisters(0, 1),  // Frame corruption!
  client.readHoldingRegisters(10, 1)  // Frame corruption!
]);
```

**Benefits**:
- Prevents frame corruption
- Serializes all requests
- Works with batch optimization
- Zero configuration needed

#### Reconnection & Backoff

**Exponential backoff** prevents log spam during prolonged outages:

| Attempt | Delay |
|---------|-------|
| 1 | 5 seconds |
| 2 | 10 seconds |
| 3 | 20 seconds |
| 4 | 40 seconds |
| 5+ | 60 seconds (max) |

**Features**:
- Auto-reset on successful connection
- Consecutive failure tracking
- Fatal error detection (EPIPE, EIO, ENXIO, ENODEV)
- Immediate reconnect on USB disconnect

#### TCP Keep-Alive

**Prevents gateway/firewall timeouts** on idle TCP connections:

**How It Works**:
```typescript
// Every 30 seconds (TCP only, not RTU)
setInterval(() => {
  if (connected) {
    client.readHoldingRegisters(0, 1).catch(() => {});
  }
}, 30000);
```

**Benefits**:
- Prevents NAT session timeouts
- Maintains persistent TCP tunnels
- Non-blocking (unref timer)
- Silent failures (keep-alive is best-effort)
- Only enabled for TCP (RTU doesn't need it)

#### Health Monitoring

**Comprehensive health metrics** for monitoring and alerting:

```typescript
const health = client.getHealthStats();

// Returns:
{
  connected: true,
  lastSuccessfulRead: Date,      // Last successful register read
  lastConnectionSuccess: Date,    // Last successful connection
  secondsSinceLastRead: 15,       // Age of last read
  secondsSinceLastConnection: 30, // Age of last connection
  consecutiveFailures: 0,         // Failure streak
  currentRetryDelay: 5000         // Next retry delay (ms)
}
```

**Use Cases**:
- Alerting: Trigger if `secondsSinceLastRead > 300` (5min)
- Dashboard: Display connection health
- Debugging: Identify stuck devices
- Capacity planning: Track failure rates

#### External Timeout Wrapper

**Prevents indefinite hangs** on network issues:

```typescript
// All operations wrapped with timeout
await withTimeout(
  client.readHoldingRegisters(0, 10),
  5000,  // Timeout from config
  'readHoldingRegisters'
);

// Without timeout (WRONG - could hang forever):
await client.readHoldingRegisters(0, 10);  // May never return!
```

**Benefits**:
- Prevents agent lockup
- Configurable per-device
- Clear timeout errors
- Works with mutex lock

#### Data Quality Indicators

**OPC-UA style quality codes** for sensor data:

```typescript
{
  "timestamp": 1736985600000,
  "value": 23.5,
  "quality": "GOOD",      // GOOD | UNCERTAIN | BAD
  "qualityDetail": null   // Optional: "MODBUS_EXCEPTION_6", "TIMEOUT", etc.
}
```

**Quality Mapping**:
- `GOOD`: Successful read
- `UNCERTAIN`: Timeout, network error (retried but succeeded)
- `BAD`: Modbus exception, fatal error, unparseable value

#### Named Pipe Integration

**Seamless data flow** to Sensor Publish service:

```
Protocol Adapter (Modbus)
  ↓ Reads every 5s
SocketServer (buffers data)
  ↓ Writes to Named Pipe (\\.\pipe\modbus)
Sensor Publish
  ↓ Reads from pipe, batches (12 messages or 60s)
MQTT Broker
  ↓ Publishes to cloud
API Handler
  ↓ Stores to PostgreSQL (sensor_data table)
```

**Named Pipe Config** (in endpoint_outputs table):
```json
{
  "protocol": "modbus",
  "socket_path": "\\\\.\\pipe\\modbus",
  "delimiter": "\n",
  "data_format": "json"
}
```

#### Error Handling Examples

**Connection Timeout**:
```typescript
// Error: "Operation 'connect' timed out after 5000ms"
// → Triggers reconnection with exponential backoff
```

**Modbus Exception 6 (Device Busy)**:
```typescript
// Error: "Modbus Exception 6: SLAVE_DEVICE_BUSY"
// → Auto-retry 3 times (100ms delay)
// → If still fails: quality = "BAD", logged
```

**USB Disconnect (RTU)**:
```typescript
// Error: "ENODEV" or "ENXIO"
// → Detected as fatal error
// → Immediate reconnection attempt
// → No backoff delay on first attempt
```

**Network Partition (TCP)**:
```typescript
// Keep-alive ping fails
// → Silent failure (debug log only)
// → Real reads will detect issue
// → Triggers reconnection with backoff
```

#### Production Checklist

✅ All 8 Modbus exceptions handled  
✅ Batch optimization enabled (10x-100x faster)  
✅ Mutex lock prevents concurrent access  
✅ Exponential backoff (5s → 60s)  
✅ External timeout wrapper  
✅ Fatal error detection (USB disconnect)  
✅ TCP keep-alive (30s interval)  
✅ Health tracking (timestamps, stats)  
✅ Quality indicators (GOOD/UNCERTAIN/BAD)  
✅ String encoding support (UTF-8, ASCII, etc.)  
✅ Backward compatibility (old configs work)  

#### Migration from Old Configs

**Old Config** (still works):
```json
{
  "dataType": "float32",
  "endianness": "big"  // Deprecated but supported
}
```

**New Config** (recommended):
```json
{
  "dataType": "float32",
  "byteOrder": "ABCD"  // Industry-standard notation
}
```

**Mapping**:
- `endianness: "big"` → `byteOrder: "ABCD"`
- `endianness: "little"` → `byteOrder: "DCBA"`

#### File Locations

- **Types**: `agent/src/features/adapters/modbus/types.ts`
- **Client**: `agent/src/features/adapters/modbus/client.ts`
- **Adapter**: `agent/src/features/adapters/modbus/adapter.ts`
- **Socket Server**: `agent/src/features/adapters/modbus/socket-server.ts`

### OPC-UA Adapter

**Industrial IoT standard** with secure connections and complex data types:

#### Key Features

✅ **Connection Types**: TCP with security modes  
✅ **Security**: None, Sign, SignAndEncrypt  
✅ **Authentication**: Username/password, X.509 certificates  
✅ **Data Types**: Number, String, Boolean, Object  
✅ **Endpoint Discovery**: Automatic security validation and transport profile filtering  
✅ **Subscriptions**: Real-time value change notifications  
✅ **Reconnection**: Exponential backoff on failure (5s → 60s)  
✅ **Session Monitoring**: Tracks session_closed, keepalive, keepalive_failure events  
✅ **Concurrency Control**: Mutex lock per device prevents session corruption  
✅ **Quality Mapping**: Normalized error codes (SESSION_CLOSED, TIMEOUT, etc.)  
✅ **Read Retry**: Automatic retry on transient errors (3 attempts, 100ms delay)  
✅ **Subscription Streaming**: Real-time event-driven data collection (optional, better than polling)  
✅ **NodeID Validation**: Pre-validates all NodeIDs on connection, filters invalid nodes automatically

#### NodeID Pre-Validation

**What it does**:
- Validates every configured NodeID when session is created
- Attempts to read each node to verify it exists and is accessible
- Caches valid NodeIDs for the session lifetime
- Automatically filters invalid nodes from reads and subscriptions
- Logs detailed validation results

**Benefits**:
- ✅ **Fail Fast**: Detect misconfigured NodeIDs immediately on connection
- ✅ **Better Errors**: Clear messages like "NodeID 'ns=2;s=Temp' does not exist" 
- ✅ **Prevents Runtime Failures**: Invalid nodes never reach read/subscription operations
- ✅ **Production Ready**: Gracefully handles partial failures (some valid, some invalid)

**Example Logs**:
```
[INFO] Validating 10 NodeIDs for plc-001...
[DEBUG] ✓ NodeID validated: ns=2;s=Temperature (temperature)
[WARN] ✗ NodeID validation failed: ns=2;s=InvalidNode (pressure) - BadNodeIdUnknown
[INFO] ✓ All 9 NodeIDs validated successfully for plc-001
[WARN] NodeID validation complete: 9 valid, 1 invalid
```

**Behavior**:
- If **all** NodeIDs are invalid → Connection fails with error
- If **some** NodeIDs are invalid → Connection succeeds, invalid nodes skipped
- Re-validates on reconnection (handles dynamic server changes)

#### Polling vs Subscription Mode

**Polling Mode** (default):
- Agent reads values at fixed intervals (e.g., every 5 seconds)
- Simple, predictable resource usage
- May miss fast-changing values
- Use for: Slow PLCs, testing, simple monitoring

**Subscription Mode** (recommended for production):
- Server pushes data changes immediately
- Much more efficient for fast PLCs
- Never misses value changes
- Lower network traffic (only sends changes)
- Use for: High-speed PLCs, critical data, real-time monitoring

**Enable Subscription Mode**:
```json
{
  "connection": {
    "endpointUrl": "opc.tcp://10.0.0.60:4840",
    "useSubscription": true,           // Enable subscription streaming
    "publishingInterval": 1000,         // How often to publish batches (ms)
    "samplingInterval": 500             // How often to sample values (ms)
  }
}
```

**Performance Comparison**:
| Scenario | Polling (5s) | Subscription (500ms sampling) |
|----------|--------------|------------------------------|
| Fast PLC (100 values/sec) | Misses 99.8% of changes | Captures all changes |
| Network bandwidth | High (constant polling) | Low (only sends changes) |
| Latency | Up to 5 seconds | ~500ms (sampling interval) |
| CPU usage | Low | Medium (event processing) |

#### Configuration

```json
{
  "name": "plc-001",
  "enabled": true,
  "protocol": "opcua",
  "connection": {
    "endpointUrl": "opc.tcp://10.0.0.60:4840",
    "username": "admin",
    "password": "password",
    "securityMode": "None",
    "securityPolicy": "None",
    "connectionTimeout": 10000,
    "sessionTimeout": 60000,
    "keepAliveInterval": 5000,
    "useSubscription": false,        // Set to true for real-time streaming
    "publishingInterval": 1000,      // Only used if useSubscription=true
    "samplingInterval": 500          // Only used if useSubscription=true
  },
  "dataPoints": [
    {
      "name": "temperature",
      "nodeId": "ns=2;s=Temperature",
      "unit": "°C",
      "dataType": "number"
    },
    {
      "name": "pressure",
      "nodeId": "ns=2;s=Pressure",
      "unit": "bar",
      "dataType": "number",
      "scalingFactor": 0.01,
      "offset": 0
    }
  ],
  "pollInterval": 5000,
  "metadata": {
    "manufacturer": "Siemens",
    "model": "S7-1500",
    "applicationUri": "urn:example:plc001"
  }
}
```

#### Security Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **None** | No security | Development, trusted networks |
| **Sign** | Message signing only | Integrity verification |
| **SignAndEncrypt** | Signing + encryption | Secure production environments |

#### Security Policies

- **None** - No encryption
- **Basic128Rsa15** - RSA 1024-bit (deprecated)
- **Basic256** - RSA 2048-bit
- **Basic256Sha256** - RSA 2048-bit + SHA-256
- **Aes128_Sha256_RsaOaep** - AES 128-bit + SHA-256
- **Aes256_Sha256_RsaPss** - AES 256-bit + SHA-256 (recommended)

#### Node ID Formats

**String-based** (most common):
```javascript
"ns=2;s=Temperature"           // Namespace 2, string identifier
"ns=3;s=Building1.Room1.Temp"  // Hierarchical path
```

**Numeric-based**:
```javascript
"ns=2;i=1001"  // Namespace 2, integer identifier
"ns=0;i=2253"  // Standard OPC-UA node (CurrentTime)
```

**GUID-based**:
```javascript
"ns=2;g=550e8400-e29b-41d4-a716-446655440000"
```

#### Data Scaling

Apply scaling factors for unit conversion:

```json
{
  "name": "pressure",
  "nodeId": "ns=2;s=Pressure",
  "unit": "bar",
  "scalingFactor": 0.01,  // Convert mbar to bar
  "offset": 0
}
```

**Example**: Raw value `1013` → Scaled value `10.13 bar`

#### Named Pipe Integration

Same architecture as Modbus:

```
OPC-UA Adapter
  ↓ Connects to opc.tcp://...
  ↓ Reads data points via subscription
SocketServer (buffers data)
  ↓ Writes to Named Pipe (\\.\pipe\opcua)
Sensor Publish
  ↓ Reads from pipe, batches
MQTT Broker
  ↓ Publishes to cloud
API Handler
  ↓ Stores to PostgreSQL
```

#### Database Configuration

**sensors table** (device config):
```sql
INSERT INTO sensors (name, protocol, enabled, connection, data_points, poll_interval)
VALUES (
  'plc-001',
  'opcua',
  true,
  '{"endpointUrl": "opc.tcp://10.0.0.60:4840", ...}'::jsonb,
  '[{"name": "temperature", "nodeId": "ns=2;s=Temperature", ...}]'::jsonb,
  5000
);
```

**endpoint_outputs table** (pipe config - auto-created by migration):
```sql
-- Already created by migration 20251117000000_add_default_sensor_outputs.js
SELECT * FROM endpoint_outputs WHERE protocol = 'opcua';
-- socket_path: \\.\pipe\opcua (Windows) or /tmp/opcua.sock (Linux)
-- data_format: json
-- delimiter: \n
```

#### Error Handling

**Connection Errors**:
- Automatic reconnection with exponential backoff
- Logs connection failures with details

**Node Read Errors**:
- Bad status codes (e.g., BadNodeIdUnknown)
- Quality code set to `UNCERTAIN` or `BAD`
- Detailed error logging

**Session Timeout**:
- Automatic session renewal
- Keep-alive mechanism (configurable)

#### Production Checklist

✅ Security mode configured (Sign/SignAndEncrypt for production)  
✅ Valid username/password or X.509 certificates  
✅ Node IDs validated (use UaExpert to browse)  
✅ Session timeout appropriate for network latency  
✅ Keep-alive interval < session timeout  
✅ Named pipe created and readable  
✅ Sensor Publish enabled for OPC-UA protocol  

#### File Locations

- **Types**: `agent/src/features/adapters/opcua/types.ts`
- **Adapter**: `agent/src/features/adapters/opcua/opcua-adapter.ts`
- **Integration**: `agent/src/features/adapters/index.ts`

### CAN Bus Adapter (Planned)

**Automotive and industrial CAN network support** (coming soon):
- CAN 2.0A/2.0B
- CAN FD (flexible data rate)
- J1939 protocol decoding
- DBC file parsing

### OPC-UA Adapter (Planned)

**Industrial IoT standard**:
- Secure connections (X.509 certificates)
- Subscription-based updates
- Complex data types
- Historical data access

## 🔀 IPC Pub/Sub Routing

The agent uses an internal Unix socket / Windows Named Pipe server to route data between protocol adapters (Modbus, OPC-UA, BACnet, …) and downstream consumers (MQTT publisher, Azure IoT Hub, AWS IoT Core, custom forwarders). Adapters produce into a per-protocol socket server; consumers subscribe and receive only what they need.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                         IOTISTICA AGENT                              │
│                                                                      │
│  PROTOCOL ADAPTERS (Producers)                                       │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                │
│  │  Modbus │  │  OPC-UA │  │  BACnet │  │   SNMP  │                │
│  └────┬────┘  └────┬────┘  └────┬────┘  └────┬────┘                │
│       │            │            │             │                      │
│       ▼            ▼            ▼             ▼                      │
│  ┌───────────────────────────────────────────────────────────┐      │
│  │              IPC SocketServer (per protocol)              │      │
│  │   sendData(points, topic="modbus")                        │      │
│  │                                                           │      │
│  │   Topic index:  modbus → {ClientA, ClientC}               │      │
│  │                 opcua  → {ClientB}                        │      │
│  │                 *      → {ClientD}  (wildcard)            │      │
│  │                                                           │      │
│  │   Per-client routing rules applied before each send:      │      │
│  │   • include / exclude metrics & devices                   │      │
│  │   • quality filter  (GOOD / BAD / UNCERTAIN)              │      │
│  │   • minIntervalMs throttle                                │      │
│  │   • maxPointsPerMessage cap                               │      │
│  └───────────────────────────────────────────────────────────┘      │
│       │            │            │             │                      │
│       ▼            ▼            ▼             ▼                      │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐                │
│  │ClientA  │  │ClientB  │  │ClientC  │  │ClientD  │                │
│  │(Azure)  │  │(AWS)    │  │(Grafana)│  │(all *)  │                │
│  └─────────┘  └─────────┘  └─────────┘  └─────────┘                │
└──────────────────────────────────────────────────────────────────────┘
```

### Subscription Protocol

Every consumer performs a JSON handshake immediately on connect.

**Step 1** – Client connects to the socket path recorded in `endpoint_outputs.socket_path`.

**Step 2** – Client sends a subscription frame (newline-delimited JSON):

```json
{
  "subscribe": ["modbus"],
  "route": { ... }
}
```

- `subscribe`: list of protocol topics to receive. Empty array `[]` = wildcard — receive all topics.
- `route`: optional per-client routing rules (see below). Omit to receive everything unfiltered.

**Step 3** – Server confirms with the resolved rules:

```json
{
  "ok": true,
  "subscribed_to": ["modbus"],
  "routing": {
    "includeMetrics": [],
    "excludeMetrics": [],
    "includeDevices": [],
    "excludeDevices": [],
    "qualities": ["GOOD", "BAD", "UNCERTAIN"],
    "minIntervalMs": 0,
    "maxPointsPerMessage": 0
  }
}
```

**Step 4** – Server streams filtered data frames to this client only.

If the client does not send a subscription within 5 seconds the connection is closed and a warning is logged.

### Routing Rules (`route` object)

All fields are optional. Omitting a field applies no restriction for that dimension.

| Field | Type | Default | Description |
|---|---|---|---|
| `includeMetrics` | `string[]` | `[]` | Only forward points whose `metric` matches. Empty = allow all. |
| `excludeMetrics` | `string[]` | `[]` | Drop points whose `metric` matches. |
| `includeDevices` | `string[]` | `[]` | Only forward points from these `deviceName` values. Empty = allow all. |
| `excludeDevices` | `string[]` | `[]` | Drop points from these `deviceName` values. |
| `qualities` | `string[]` | `["GOOD","BAD","UNCERTAIN"]` | Only forward points whose `quality` is in this set. |
| `minIntervalMs` | `number` | `0` | Minimum ms between messages to this client. `0` = no throttle. Max `60000`. |
| `maxPointsPerMessage` | `number` | `0` | Truncate each message to at most this many points. `0` = no cap. Max `1000`. |

Rules are evaluated in this order for every outgoing message:

1. **minIntervalMs** throttle check — if the interval has not elapsed the entire batch is skipped and `lastSentAt` is not updated.
2. **qualities** filter — individual points whose quality is not in the allowed set are dropped.
3. **includeMetrics / excludeMetrics** — individual points are dropped by metric name.
4. **includeDevices / excludeDevices** — individual points are dropped by device name.
5. **maxPointsPerMessage** cap — batch is truncated to the first N remaining points.

If all points are filtered out after steps 2–4 no message is sent.

### Examples

#### Azure sink — Modbus temperature/humidity, GOOD quality, 5 s throttle

```json
{
  "subscribe": ["modbus"],
  "route": {
    "includeMetrics": ["temperature", "humidity"],
    "qualities": ["GOOD"],
    "minIntervalMs": 5000
  }
}
```

#### AWS sink — OPC-UA, exclude noisy test device, cap at 200 points/message

```json
{
  "subscribe": ["opcua"],
  "route": {
    "excludeDevices": ["opcua-pump-test"],
    "qualities": ["GOOD", "UNCERTAIN"],
    "maxPointsPerMessage": 200
  }
}
```

#### Analytics sink — all protocols, light 500 ms throttle

```json
{
  "subscribe": [],
  "route": {
    "minIntervalMs": 500
  }
}
```

#### Dashboard — GOOD quality only, named devices, multi-protocol

```json
{
  "subscribe": ["modbus", "bacnet"],
  "route": {
    "includeDevices": ["boiler-1", "boiler-2", "chiller-main"],
    "qualities": ["GOOD"]
  }
}
```

#### Alarm forwarder — BAD quality only across all protocols

```json
{
  "subscribe": [],
  "route": {
    "qualities": ["BAD"]
  }
}
```

### Multi-Cloud Routing (Modbus → Azure, OPC-UA → AWS)

Each cloud destination runs its own `DeviceConnection` pointed at a different socket path. The two adapter streams are completely independent.

**`endpoint_outputs` table** (one row per protocol):

```
protocol | socket_path                | delimiter | data_format
---------+----------------------------+-----------+------------
modbus   | /tmp/iotistica/modbus.sock | \n        | json
opcua    | /tmp/iotistica/opcua.sock  | \n        | json
bacnet   | /tmp/iotistica/bacnet.sock | \n        | json
```

**Azure publisher** connects to `/tmp/iotistica/modbus.sock` and subscribes:

```json
{ "subscribe": ["modbus"], "route": { "qualities": ["GOOD"] } }
```

**AWS publisher** connects to `/tmp/iotistica/opcua.sock` and subscribes:

```json
{ "subscribe": ["opcua"] }
```

The Modbus SocketServer never delivers to the AWS client; the OPC-UA SocketServer never delivers to the Azure client. Each client pays only for the data it requested.

### Connection Lifecycle

```
Client connects
  └─ Server: start 5 s handshake timer
      └─ Client sends: {"subscribe": [...], "route": {...}}
          └─ Server: cancel timer, parse rules, add to topic index
              └─ Server sends: {"ok": true, "subscribed_to": [...], "routing": {...}}
                  └─ Data flows: adapter → apply routing rules → client socket
                      └─ On disconnect / error: remove from all indices, destroy socket
```

### Flow Control and Backpressure

| Event | Action |
|---|---|
| Write failure (1st–2nd) | WARN logged, client kept |
| Write failure (3rd) | ERROR logged |
| Write failure (4th+) | Client removed, socket destroyed |
| `minIntervalMs` not elapsed | Entire batch skipped silently |
| `maxPointsPerMessage` exceeded | First N points sent, remainder dropped |

### Monitoring

`SocketServer.getSubscriptionStats()` returns a snapshot for health endpoints:

```typescript
{
  totalClients: 3,
  topicCounts: {
    "modbus": 2,
    "opcua": 1,
    "*": 1   // wildcard clients (subscribed with [])
  }
}
```

## License

Apache-2.0

## Contributing

Contributions welcome! Please open an issue or pull request on the [Iotistic repository](https://github.com/Iotistica/iotistic).

