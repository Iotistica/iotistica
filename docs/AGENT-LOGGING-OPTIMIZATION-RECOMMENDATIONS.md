# Agent Logging Optimization Recommendations

## Executive Summary

Analysis of agent logging revealed **141 info-level log statements** across the codebase. Many of these are high-frequency, low-value logs that should be reduced to debug level or removed entirely to reduce cloud server load.

**Key Findings:**
- **Socket server connection logs** generate excessive noise (every client connect/disconnect)
- **Protocol adapter lifecycle logs** are verbose during startup/shutdown
- **Jobs feature** logs too many routine operations
- **Sensor publish** logs every sensor enable/disable/interval change
- **OPC-UA adapter** has 14+ info logs per device connection

**Estimated Impact:**
- **Current**: ~50-200 info logs per minute on active device (depends on # of sensors)
- **After optimization**: ~10-30 info logs per minute (60-85% reduction)
- **Cloud storage savings**: 70-80% reduction in log volume uploaded

---

## Category 1: REMOVE COMPLETELY (High Frequency, No Value)

### Socket Server Connection Events
**File**: `agent/src/features/endpoints/common/socket-server.ts`

```typescript
// Lines 157, 166, 171 - REMOVE these info logs
this.logger.info(`New client connected to socket server`);
this.logger.info('Client disconnected from socket server');
this.logger.info('Client ended connection to socket server');
```

**Rationale:**
- These fire **every time** Sensor Publish or any client connects
- With 10+ sensors, this is 30+ logs per minute during normal operation
- No actionable value - socket errors are already logged as warnings
- **Recommendation**: **DELETE** all three lines (keep only the `warn` for errors)

---

## Category 2: CHANGE TO DEBUG (Useful for troubleshooting, not routine ops)

### 2.1 Protocol Adapter Lifecycle

**File**: `agent/src/features/endpoints/base.ts`

```typescript
// Lines 94, 104, 124, 142, 236 - Change to DEBUG
this.logger.info(`Starting ${this.getProtocolName()} adapter...`);
this.logger.info(`${this.getProtocolName()} adapter started successfully`);
this.logger.info(`Stopping ${this.getProtocolName()} adapter...`);
this.logger.info(`${this.getProtocolName()} adapter stopped successfully`);
this.logger.info(`Device initialized: ${device.name}`);
```

**Rationale:**
- These fire during agent startup/shutdown and protocol reloads
- With 3 protocols (Modbus, OPC-UA, SNMP), that's 12+ logs per startup
- Useful for debugging, but routine during normal operation
- **Recommendation**: Change all 5 to `logger.debug()`

---

### 2.2 Modbus Adapter Routine Operations

**File**: `agent/src/features/endpoints/modbus/adapter.ts`

```typescript
// Lines 79, 97, 140, 163, 203, 220, 481 - Change to DEBUG
this.logger.info('Stopping Modbus Adapter...');
this.logger.info('Modbus Adapter stopped successfully');
this.logger.info(`Device ${deviceName} enabled`);
this.logger.info(`Device ${deviceName} disabled`);
this.logger.info(`Initializing device: ${deviceConfig.name}`);
this.logger.info(`Device ${deviceConfig.name} initialized successfully`);
this.logger.info(`Retrying connection to device: ${deviceConfig.name}`);
```

**Rationale:**
- Enable/disable events rarely happen (already emitted as events)
- Initialization is logged once per startup (debug-worthy)
- Retry logs are verbose during connection issues (already have error logs)
- **Recommendation**: Change all 7 to `logger.debug()`

---

### 2.3 Modbus Client Connection Logs

**File**: `agent/src/features/endpoints/modbus/client.ts`

```typescript
// Lines 87, 145, 174 - Change to DEBUG
this.logger.info(`Connecting to Modbus device: ${this.device.name}`);
this.logger.info(`Connected to Modbus device: ${this.device.name}`);
this.logger.info(`Disconnected from Modbus device: ${this.device.name}`);
```

**Rationale:**
- With 10 Modbus devices polling every 30s, disconnect/reconnect is normal
- Connection errors are already logged separately
- **Recommendation**: Keep only "Connected" as INFO, change others to DEBUG

---

### 2.4 OPC-UA Adapter Verbose Logging

**File**: `agent/src/features/endpoints/opcua/opcua-adapter.ts`

```typescript
// Lines 150, 190, 237, 650, 698, 731, 737, 754, 805, 925, 953, 975, 1048, 1055
// Change to DEBUG (14 total logs)

this.logger.info(`Validating ${dataPoints.length} NodeIDs for ${deviceName}...`);
this.logger.info(`✓ All ${valid.length} NodeIDs validated successfully for ${deviceName}`);
this.logger.info(`Created subscription for ${deviceName}`);
this.logger.info('Selected endpoint', { ... });
this.logger.info(`Connecting to OPC-UA device: ${device.name}`);
this.logger.info(`Attempting connection to ${connectUrl}`, { ... });
this.logger.info(`Connected to ${connectUrl}`);
this.logger.info(`Session established for device: ${device.name}`);
this.logger.info(`Subscription mode enabled for ${device.name} - using real-time streaming`);
this.logger.info(`Scheduling reconnect for ${device.name}`, { ... });
this.logger.info(`Attempting reconnect to OPC-UA device: ${device.name}`, { ... });
this.logger.info(`Reconnected successfully to ${device.name}`);
this.logger.info(`Disconnecting OPC-UA device: ${deviceName}`);
this.logger.info(`Disconnected from device: ${deviceName}`);
```

**Rationale:**
- OPC-UA is the **most verbose** protocol (14 info logs per device)
- Validation, connection, subscription all happen during startup
- Reconnect logs are verbose during network issues (errors already logged)
- **Recommendation**: Change all 14 to `logger.debug()` - errors are already logged separately

---

### 2.5 Sensor Publish Routine Operations

**File**: `agent/src/features/sensor-publish/sensor-publish-feature.ts`

```typescript
// Lines 75, 111, 116, 226, 251, 280 - Change to DEBUG
this.logger.info(`Starting Sensor Publish feature with ${sensorConfig.endpoints.length} sensors`);
this.logger.info(`Sensor '${config.name}' connected`);
this.logger.info(`Sensor '${config.name}' disconnected`);
this.logger.info(`Sensor '${sensorName}' enabled`);
this.logger.info(`Sensor '${sensorName}' disabled`);
this.logger.info(`Updated interval for '${sensorName}': ${intervalMs}ms`);
```

**Rationale:**
- Connect/disconnect happens frequently during normal operation (not errors)
- Enable/disable are config changes (rare, but not errors)
- Interval updates are config changes (rare)
- **Recommendation**: Change all 6 to `logger.debug()`

---

### 2.6 Jobs Feature Routine Logs

**File**: `agent/src/features/jobs/src/monitor.ts`

```typescript
// Lines 137, 155, 162, 175, 197, 209, 236, 301, 316, 331, 577, 589, 600
// Change to DEBUG (13 total logs)

this.logger.info(`Initializing Jobs Feature - pollingIntervalMs: ...`);
this.logger.info(`Jobs Feature started - Mode: ...`);
this.logger.info(`Stopping Jobs Feature`);
this.logger.info(`HTTP polling stopped`);
this.logger.info(`Starting HTTP polling (interval: ${pollingIntervalMs}ms)`);
this.logger.info(`HTTP polling started`);
this.logger.info(`Received job from HTTP polling: ${cloudJob.job_id}`);
this.logger.info(`Initializing MQTT job notifications (primary)`);
this.logger.info(`MQTT job notifications initialized`);
this.logger.info(`No pending jobs available`);
this.logger.info(`MQTT connected - HTTP polling paused (MQTT-primary mode)`);
this.logger.info(`MQTT reconnected - switching to MQTT-primary mode`);
this.logger.info(`Connection monitor started - Initial mode: ...`);
```

**Rationale:**
- Initialization logs are verbose during startup (once per boot)
- "No pending jobs" fires **every HTTP poll** when idle (30s interval = 2 logs/min)
- MQTT mode switching is routine during network transitions
- **Recommendation**: Keep ONLY "Received job from HTTP/MQTT" as INFO, change rest to DEBUG

**Exception**: Lines 419, 479 - Keep as INFO
```typescript
this.logger.info(`Starting execution of job ${jobData.jobId}`);
this.logger.info(`Job ${jobData.jobId} completed with status: ${finalStatus}`);
```
These are **critical business events** - keep as INFO.

---

### 2.7 Bootstrap Feature Initialization

**File**: `agent/src/bootstrap/init.ts`

```typescript
// Lines 149, 167, 238, 246, 343, 349, 362, 588, 635, 679, 729
// Change to DEBUG (11 total logs)

logger.infoSync('Jobs Feature initialized', { ... });
logger.infoSync('Initializing Sensor Publish Feature', { ... });
logger.infoSync('Configured edge AI anomaly detection for sensor data', { ... });
logger.infoSync('Sensor Publish Feature initialized', { ... });
logger.infoSync('No protocols enabled, skipping Protocol Adapters initialization', { ... });
logger.infoSync('Initializing Protocol Adapters', { ... });
logger.infoSync('Protocol Adapters initialized', { ... });
logger.infoSync('Initializing Sensor Config Handler', { ... });
logger.infoSync('Sensor Config Handler initialized', { ... });
logger.infoSync('Firewall disabled by environment variable', { ... });
logger.infoSync('Firewall initialized', { ... });
```

**Rationale:**
- All feature initialization happens **once per boot**
- Useful for debugging startup issues, but verbose in production
- Errors during initialization are already logged separately
- **Recommendation**: Change all 11 to `logger.debugSync()`

**Exception**: Lines 382, 413, 432, 444, 464, 473, 493 - Keep as INFO (auto-reload events)
These are **important runtime events** (not just startup):
```typescript
logger.infoSync('Setting up protocol adapter event listener', { ... });
logger.infoSync('New enabled endpoint discovered, reloading Sensor Publish', { ... });
logger.infoSync('Sensor Publish reloaded successfully', { ... });
logger.infoSync('Endpoint auto-reload watcher initialized', { ... });
logger.infoSync('Protocol configuration changed, reinitializing', { ... });
logger.infoSync('Stopped existing protocol adapters', { ... });
logger.infoSync('Reinitializing Sensor Publish after protocol adapter changes', { ... });
```

---

### 2.8 Agent Core Initialization

**File**: `agent/src/agent.ts`

```typescript
// Lines 250, 302, 355, 367, 430, 442, 501, 562 - Change to DEBUG
this.agentLogger.infoSync("Device Agent initialized successfully", { ... });
this.agentLogger.infoSync("Cloud log backend initialized", { ... });
this.agentLogger.infoSync("Device provisioned successfully", { ... });
this.agentLogger.infoSync("System information detected", { ... });
this.agentLogger.infoSync("Updating agent version", { ... });
this.agentLogger.infoSync("Device manager initialized", { ... });
this.agentLogger.infoSync("MQTT TLS enabled", { ... });
this.agentLogger.infoSync("Log monitor attached to container manager", { ... });
```

**Rationale:**
- All initialization logs (once per boot)
- Useful for debugging, but verbose in production
- **Recommendation**: Change all 8 to `logger.debugSync()`

**Exception**: Lines 386, 517 - Keep as INFO (important events)
```typescript
this.agentLogger.infoSync("Device auto-provisioned successfully", { ... }); // Auto-provision is rare
this.agentLogger.infoSync("MQTT Manager connected", { ... }); // Critical connectivity event
```

**Exception**: Lines 409, 416 - Keep as INFO (mode switches)
```typescript
this.agentLogger.infoSync("Running in local mode (no cloud connection)", { ... });
this.agentLogger.infoSync("Switching to local mode (no cloud connection)", { ... });
```

---

### 2.9 Agent Updater

**File**: `agent/src/updater.ts`

```typescript
// Lines 73, 107, 127 - Change to DEBUG
this.logger.infoSync("MQTT update listener initialized", { ... });
this.logger.infoSync("Agent update command received", { ... });
this.logger.infoSync("Update scheduled for later", { ... });
```

**Rationale:**
- Initialization is once per boot
- Update commands are rare (once per update cycle)
- **Recommendation**: Change to `logger.debugSync()`

**Exception**: Lines 169, 220, 235 - Keep as INFO (critical update events)
```typescript
this.logger.infoSync("Starting agent self-update", { ... });
this.logger.infoSync("Executing update script", { ... });
this.logger.infoSync("Update script executed", { ... });
```

---

### 2.10 Firewall Routine Logs

**File**: `agent/src/network/firewall.ts`

```typescript
// Lines 63, 74, 315, 329, 352, 392 - Change to DEBUG
this.logger.infoSync('Firewall disabled by configuration', { ... });
this.logger.infoSync('Firewall initialized successfully', { ... });
this.logger.infoSync('Updating firewall mode', { ... });
this.logger.infoSync('Updating firewall configuration', { ... });
this.logger.infoSync('Stopping firewall', { ... });
this.logger.infoSync('Firewall stopped', { ... });
```

**Rationale:**
- Initialization/shutdown are once per boot
- Mode/config updates are rare
- **Recommendation**: Change all 6 to `logger.debugSync()`

---

### 2.11 SNMP Client Sessions

**File**: `agent/src/features/endpoints/snmp/client.ts`

```typescript
// Line 47 - Change to DEBUG
this.logger.info(`SNMP session created for ${this.config.name}`);
```

**Rationale:**
- Logged once per device during initialization
- **Recommendation**: Change to `logger.debug()`

---

### 2.12 Endpoint Index Duplicate Logs

**File**: `agent/src/features/endpoints/index.ts`

```typescript
// Lines 101, 110, 190, 198, 207, 278, 289, 298, 328, 351, 377, 386, 400
// These are DUPLICATES of logs in sensors-feature.ts and base.ts
// Change to DEBUG or REMOVE
```

**Rationale:**
- These appear to be duplicates of logs already in other files
- **Recommendation**: Review and either remove or change to DEBUG

---

## Category 3: KEEP AS INFO (Critical Business Events)

### 3.1 Job Execution (KEEP)
```typescript
// agent/src/features/jobs/src/monitor.ts
this.logger.info(`Starting execution of job ${jobData.jobId}`); // Line 419
this.logger.info(`Job ${jobData.jobId} completed with status: ${finalStatus}`); // Line 479
```

### 3.2 Auto-Reload Events (KEEP)
```typescript
// agent/src/bootstrap/init.ts
logger.infoSync('New enabled endpoint discovered, reloading Sensor Publish', { ... }); // Line 413
logger.infoSync('Sensor Publish reloaded successfully', { ... }); // Line 432
logger.infoSync('Protocol configuration changed, reinitializing', { ... }); // Line 464
```

### 3.3 Connection State Changes (KEEP)
```typescript
// agent/src/agent.ts
this.agentLogger.infoSync("MQTT Manager connected", { ... }); // Line 517
this.agentLogger.infoSync("Running in local mode (no cloud connection)", { ... }); // Line 409

// agent/src/network/connection-monitor.ts
this.logger.infoSync('Connection restored (both poll and report successful)', { ... }); // Line 112
```

### 3.4 Update Events (KEEP)
```typescript
// agent/src/updater.ts
this.logger.infoSync("Starting agent self-update", { ... }); // Line 169
this.logger.infoSync("Update script executed", { ... }); // Line 235
```

### 3.5 Provisioning (KEEP)
```typescript
// agent/src/agent.ts
this.agentLogger.infoSync("Device auto-provisioned successfully", { ... }); // Line 386
```

---

## Category 4: SPECIAL CASES

### 4.1 API Middleware Logging

**File**: `agent/src/api/middleware/logging.ts`

```typescript
// Line 36
logger.infoSync(logMessage, context);
```

**Analysis:**
- This logs **every HTTP request** to the Device API
- High frequency if Grafana or external tools poll the API
- **Recommendation**: Consider changing to DEBUG or adding sampling (e.g., log 10% of requests)

---

### 4.2 Connection Monitor Restoration

**File**: `agent/src/network/connection-monitor.ts`

```typescript
// Line 112 - KEEP as INFO
this.logger.infoSync('Connection restored (both poll and report successful)', { ... });
```

**Rationale:**
- This is a **critical recovery event** (device back online)
- Should remain visible in production logs
- **Recommendation**: Keep as INFO

---

### 4.3 Base Feature MQTT Connection

**File**: `agent/src/features/base-feature.ts`

```typescript
// Line 133 - KEEP as INFO
this.logger.info('MQTT connection established');
```

**Rationale:**
- Critical connectivity event for features
- **Recommendation**: Keep as INFO

**Change to DEBUG**:
```typescript
// Lines 179, 184, 200, 203 - Change to DEBUG
this.logger.info('Starting feature...');
this.logger.info('Feature started successfully');
this.logger.info('Stopping feature...');
this.logger.info('Feature stopped successfully');
```

---

## Summary of Changes

### **Total Info Logs Analyzed**: 141

### **Recommended Changes**:
| Category | Count | Action |
|----------|-------|--------|
| **Remove Completely** | 3 | DELETE (socket server connection logs) |
| **Change to DEBUG** | 108 | Change `logger.info()` → `logger.debug()` |
| **Keep as INFO** | 30 | No change (critical business events) |

### **Files Affected** (22 total):
1. ✅ `socket-server.ts` - REMOVE 3 logs
2. ✅ `base.ts` - Change 5 to DEBUG
3. ✅ `modbus/adapter.ts` - Change 7 to DEBUG
4. ✅ `modbus/client.ts` - Change 2 to DEBUG, keep 1 INFO
5. ✅ `opcua/opcua-adapter.ts` - Change 14 to DEBUG
6. ✅ `sensor-publish-feature.ts` - Change 6 to DEBUG
7. ✅ `jobs/monitor.ts` - Change 11 to DEBUG, keep 2 INFO
8. ✅ `bootstrap/init.ts` - Change 11 to DEBUG, keep 7 INFO
9. ✅ `agent.ts` - Change 8 to DEBUG, keep 4 INFO
10. ✅ `updater.ts` - Change 3 to DEBUG, keep 3 INFO
11. ✅ `firewall.ts` - Change 6 to DEBUG
12. ✅ `snmp/client.ts` - Change 1 to DEBUG
13. ✅ `sensors-feature.ts` - Change ~12 to DEBUG
14. ✅ `index.ts` (endpoints) - Change ~13 to DEBUG or remove duplicates
15. ✅ `base-feature.ts` - Change 4 to DEBUG, keep 1 INFO
16. ✅ `api/middleware/logging.ts` - Consider sampling
17. ⚠️ Other files with minor changes

---

## Estimated Impact

### **Before Optimization**:
- Typical agent startup: ~80-100 info logs
- Routine operation (10 sensors): ~50-200 info logs/min
- Socket server noise: ~30 logs/min
- Protocol adapter verbosity: ~20 logs/min

### **After Optimization**:
- Typical agent startup: ~15-20 info logs (business events only)
- Routine operation: ~10-30 info logs/min (70% reduction)
- Socket server noise: 0 logs (removed)
- Protocol adapter verbosity: 0 logs (debug only)

### **Cloud Storage Savings**:
- **Current**: ~10,000 info logs/day → ~2MB/day (compressed)
- **After**: ~2,000 info logs/day → ~400KB/day (compressed)
- **Savings**: **80% reduction** in cloud log storage

### **CloudBackend Sampling** (Current):
- Info logs: 10% sampled (9 out of 10 dropped)
- Debug logs: 1% sampled (99 out of 100 dropped)

Even with sampling, reducing info logs to debug means **99% of routine logs stay local**, further reducing cloud load.

---

## Implementation Priority

### **Phase 1** (Immediate - High Impact):
1. ✅ **REMOVE** socket server connection logs (3 deletions)
2. ✅ **Change to DEBUG**: OPC-UA adapter (14 logs)
3. ✅ **Change to DEBUG**: Jobs feature routine logs (11 logs)
4. ✅ **Change to DEBUG**: Bootstrap initialization (11 logs)

**Impact**: ~40 logs removed/reduced (30% reduction)

### **Phase 2** (Next - Medium Impact):
5. ✅ **Change to DEBUG**: Protocol adapter lifecycle (5 logs)
6. ✅ **Change to DEBUG**: Modbus adapter (7 logs)
7. ✅ **Change to DEBUG**: Sensor publish (6 logs)
8. ✅ **Change to DEBUG**: Agent core (8 logs)

**Impact**: ~26 logs reduced (20% reduction)

### **Phase 3** (Final - Low Impact):
9. ✅ **Change to DEBUG**: Remaining files (firewall, updater, SNMP, etc.)
10. ✅ **Review duplicates** in endpoints/index.ts
11. ✅ **Consider sampling** for API middleware

**Impact**: ~42 logs reduced/reviewed (30% reduction)

---

## Testing Checklist

After implementing changes:

- [ ] Verify agent still logs critical events (job execution, auto-reload, MQTT connection)
- [ ] Confirm socket server connection logs are gone (noise eliminated)
- [ ] Test debug mode (`LOG_LEVEL=debug`) shows all protocol details
- [ ] Check cloud log volume reduced by 70-80%
- [ ] Ensure error logs still fire correctly (unchanged)
- [ ] Test startup logs are minimal (15-20 info logs)
- [ ] Verify connection restoration still logs at INFO level

---

## Notes

- **LOG_LEVEL=debug** should still show all logs for troubleshooting
- **CloudBackend sampling** provides additional reduction (10% info, 1% debug)
- **Critical business events** (jobs, updates, auto-reload) remain at INFO
- **Connection state changes** (MQTT, VPN, cloud) remain at INFO
- **Routine operations** (protocol adapters, sensors, features) move to DEBUG
- **Socket noise** (client connections) removed entirely

---

## Implementation Example

**Before**:
```typescript
// agent/src/features/endpoints/common/socket-server.ts:157
this.logger.info(`New client connected to socket server`);
```

**After**:
```typescript
// REMOVED - no log needed for routine connections
```

---

**Before**:
```typescript
// agent/src/features/endpoints/opcua/opcua-adapter.ts:150
this.logger.info(`Validating ${dataPoints.length} NodeIDs for ${deviceName}...`);
```

**After**:
```typescript
this.logger.debug(`Validating ${dataPoints.length} NodeIDs for ${deviceName}...`);
```

---

**Before**:
```typescript
// agent/src/bootstrap/init.ts:149
logger.infoSync('Jobs Feature initialized', { component: LogComponents.agent });
```

**After**:
```typescript
logger.debugSync('Jobs Feature initialized', { component: LogComponents.agent });
```

---

## Appendix: Full List of Changes

See individual category sections above for complete file paths and line numbers.

Total changes: **111 edits** across **22 files**
- 3 deletions (socket server)
- 108 info→debug changes
- 30 kept as info (critical events)
