# Centralized Health Arbiter Integration

## Overview

Integrated centralized health management system to prevent subsystem failures from being masked. The **HealthArbiter** class provides a single source of truth for all agent subsystem health, enabling:

1. **Health-gated systemd watchdog** - Withholds pings when ANY critical subsystem fails
2. **Comprehensive telemetry** - Detailed health reports for cloud logging
3. **Automatic recovery** - systemd restarts agent on partial failures (MQTT down, VPN disconnected, memory leak, etc.)
4. **Failure correlation** - Prevents false healthy signals when subsystems are interdependent

## Architecture

### Health Arbiter (`agent/src/health/health-arbiter.ts`)

**Core Responsibilities:**
- Subsystem registration with critical/non-critical flags
- Centralized `isHealthy()` for watchdog integration
- Detailed `getHealthReport()` for telemetry
- Periodic health checks (optional)

**Key Pattern:**
```typescript
// Returns false if ANY critical subsystem is unhealthy
async isHealthy(): Promise<boolean>
```

### Integration Points

#### 1. Application Startup (`agent/src/app.ts`)

```typescript
// Create health arbiter BEFORE agent.init()
const health = new HealthArbiter();

// Register memory subsystem (critical)
health.registerSubsystem('memory', () => healthcheck(), {
  critical: true,
  description: 'V8 heap memory health - detects leaks via growth rate analysis'
});

// Start watchdog with centralized health check
const stopWatchdog = startWatchdog(() => health.isHealthy());

// After agent.init() - set logger
agent.init().then(() => {
  health.setLogger(agent.agentLogger);
  notifyReady(); // Systemd ready notification
});
```

#### 2. Graceful Shutdown

```typescript
async function gracefulShutdown(signal: string) {
  await notifySystemd('STOPPING=1'); // Notify systemd
  health.stop();                      // Stop health checks
  stopWatchdog();                     // Stop watchdog
  await agent.stop();                 // Stop agent
  process.exit(0);
}
```

## Subsystem Registration

### Currently Integrated

**Memory Health** (Critical):
- Uses existing `healthcheck()` from `agent/src/system/memory.ts`
- Detects leaks via adaptive thresholds (heap, external, survivor growth)
- Failure triggers systemd restart (prevents OOM kills)

### TODO: Add Incrementally

**MQTT Health** (Critical):
```typescript
health.registerSubsystem('mqtt', () => mqttClient?.connected ?? false, {
  critical: true,
  description: 'MQTT broker connection'
});
```

**VPN Health** (Critical):
```typescript
health.registerSubsystem('vpn', () => vpnTunnel?.isConnected() ?? false, {
  critical: true,
  description: 'OpenVPN tunnel to cloud'
});
```

**CloudSync Health** (Critical):
```typescript
health.registerSubsystem('cloudSync', () => cloudSync?.isHealthy() ?? false, {
  critical: true,
  description: 'Cloud state synchronization'
});
```

**Discovery Service** (Non-Critical):
```typescript
health.registerSubsystem('discovery', () => discoveryService?.isResponsive() ?? false, {
  critical: false, // Degraded mode acceptable
  description: 'Protocol discovery (Modbus, OPC-UA, etc.)'
});
```

## Health Arbiter API

### Subsystem Registration

```typescript
registerSubsystem(
  name: string,
  checkFn: () => boolean | Promise<boolean>,
  options: {
    critical?: boolean;        // If true, failure causes overall unhealthy
    description?: string;       // Human-readable description
    checkIntervalMs?: number;   // Check interval (default: 30s)
  }
): void
```

### Health Checks

```typescript
// For watchdog - returns false if ANY critical subsystem unhealthy
async isHealthy(): Promise<boolean>

// For telemetry - detailed health report
getHealthReport(): HealthReport
```

### Lifecycle Management

```typescript
// Start periodic background checks (optional)
startPeriodicChecks(intervalMs?: number): void

// Stop periodic checks
stopPeriodicChecks(): void

// Full cleanup (call during shutdown)
stop(): void

// Set logger after agent init
setLogger(logger: AgentLogger): void
```

### Health Report Structure

```typescript
interface HealthReport {
  overall: boolean;           // Overall health (all critical subsystems healthy)
  subsystems: Array<{
    name: string;
    healthy: boolean;
    critical: boolean;
    description?: string;
    lastCheck: number;        // Unix timestamp
    lastError?: string;
    consecutiveFailures: number;
  }>;
  unhealthySubsystems: string[];  // All unhealthy subsystem names
  criticalFailures: string[];     // Critical subsystem names that are unhealthy
}
```

## Watchdog Integration

### Health-Gated Behavior

**Before HealthArbiter:**
```typescript
// Watchdog only checked event loop responsiveness
startWatchdog(); // Pings systemd every 5-10s unconditionally
```

**After HealthArbiter:**
```typescript
// Watchdog checks ALL critical subsystems
startWatchdog(() => health.isHealthy());

// Pings withheld if:
// - Memory leak detected (healthcheck() fails)
// - MQTT disconnected (TODO)
// - VPN tunnel down (TODO)
// - CloudSync stale (TODO)
// - Event loop blocked (drift detection)
// - CPU pegged (drift detection)
```

### Systemd Restart Flow

```
1. Critical subsystem fails (e.g., MQTT disconnects)
   ↓
2. health.isHealthy() returns false
   ↓
3. Watchdog withholds WATCHDOG=1 ping
   ↓
4. systemd detects timeout (WATCHDOG_USEC expired)
   ↓
5. systemd sends SIGTERM → graceful shutdown
   ↓
6. systemd restarts agent (RestartSec=5s)
   ↓
7. Agent reinitializes, reconnects MQTT, VPN, etc.
```

## Observability

### Health State Logging

**Subsystem Recovery:**
```
[INFO] Subsystem recovered | subsystem=mqtt, critical=true, previousFailures=3
```

**Health Check Failure:**
```
[ERROR] Subsystem health check failed | subsystem=vpn, critical=true, consecutiveFailures=2
```

**Overall Health Failure:**
```
[DEBUG] Overall health check failed | failedSubsystem=cloudSync, consecutiveFailures=5
```

### Watchdog Logging

**Skip Due to Unhealthy:**
```
[ERROR] Watchdog ping skipped - health check failed | subsystem=memory, reason=heap_leak_detected
```

**Skip Due to Drift:**
```
[ERROR] Watchdog ping skipped - timing drift detected | driftMs=12000, expectedIntervalMs=5000
```

**Resume After Skips:**
```
[INFO] Watchdog ping resumed after skips | previousSkips=3
```

## Testing Strategy

### Unit Tests

```typescript
// agent/test/health-arbiter.test.ts (TODO)
describe('HealthArbiter', () => {
  it('should return false when critical subsystem fails', async () => {
    const health = new HealthArbiter();
    health.registerSubsystem('test', () => false, { critical: true });
    expect(await health.isHealthy()).toBe(false);
  });
  
  it('should return true when only non-critical subsystem fails', async () => {
    const health = new HealthArbiter();
    health.registerSubsystem('test', () => false, { critical: false });
    expect(await health.isHealthy()).toBe(true);
  });
  
  it('should handle async health checks', async () => {
    const health = new HealthArbiter();
    health.registerSubsystem('async', async () => {
      await new Promise(r => setTimeout(r, 100));
      return true;
    }, { critical: true });
    expect(await health.isHealthy()).toBe(true);
  });
});
```

### Integration Tests

```typescript
// agent/test/watchdog-integration.test.ts (TODO)
describe('Watchdog + HealthArbiter', () => {
  it('should withhold ping when health check fails', async () => {
    // Mock systemd socket, verify WATCHDOG=1 not sent when unhealthy
  });
  
  it('should resume pings when health recovers', async () => {
    // Verify consecutive skip counter resets
  });
});
```

### Manual Testing

**Trigger Memory Leak:**
```bash
# Watch logs for memory health failure → watchdog skip → systemd restart
journalctl -u iotistic-agent -f | grep -E "health|watchdog"
```

**Disconnect MQTT (after MQTT subsystem added):**
```bash
sudo systemctl stop mosquitto
# Expect: Health check fails → watchdog withheld → systemd restarts agent
```

## Benefits vs. Previous Architecture

### Before HealthArbiter

**Problem:** Each subsystem tracked health independently
- MQTT could fail silently while watchdog said "healthy"
- Memory leak detected but VPN down → false healthy signal
- No correlation between subsystem failures

**Impact:**
- Agent appeared healthy but couldn't communicate with cloud
- Manual intervention required to diagnose partial failures
- systemd restart only triggered on full deadlock

### After HealthArbiter

**Solution:** Single source of truth for all subsystems
- ANY critical subsystem failure → overall unhealthy
- Watchdog withholds ping → automatic systemd restart
- Detailed health report for cloud telemetry

**Impact:**
- Automatic recovery from partial failures (MQTT down, VPN disconnected, etc.)
- Prevents false healthy signals
- Comprehensive diagnostics via getHealthReport()

## Incremental Rollout Plan

### Phase 1: Memory Health (COMPLETE ✅)
- Integrated memory leak detection with health arbiter
- Health-gated watchdog functional
- Build passing, ready for testing

### Phase 2: MQTT Health (Next)
- Add MQTT subsystem registration in `agent.init()`
- Check `mqttClient.connected` state
- Test: Disconnect MQTT → verify systemd restart

### Phase 3: VPN Health
- Add VPN subsystem registration
- Check tunnel connectivity (ping test or connection state)
- Test: Kill VPN → verify restart

### Phase 4: CloudSync Health
- Add CloudSync subsystem registration
- Check last successful sync time (stale threshold: 5 minutes)
- Test: Block cloud API → verify restart

### Phase 5: Discovery Service (Non-Critical)
- Add Discovery subsystem as **non-critical**
- Verify agent continues when Discovery fails
- Test: Discovery hang → agent stays healthy (degraded mode)

### Phase 6: Cloud Telemetry
- Send `getHealthReport()` to cloud every 60s
- Dashboard: Real-time health visualization
- Alerts: Critical subsystem failures

## Configuration

### Systemd Unit (install.sh)

```ini
[Unit]
Description=Iotistic Device Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify                    # Enables watchdog
NotifyAccess=main              # Only main process can notify
WatchdogSec=15                 # Restart if no ping for 15s
Restart=always
RestartSec=5
TimeoutStopSec=20

# Resource limits (edge device protection)
MemoryMax=300M
TasksMax=512
CPUQuota=80%

# Security hardening
ProtectSystem=strict
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

### Environment Variables

```bash
# Logging
LOG_LEVEL=info                # Reduce to 'warn' for production (less noise)
CLOUD_LOGGING_ENABLED=true    # Upload logs + health reports to cloud

# Watchdog
WATCHDOG_USEC=15000000        # 15s timeout (set by systemd)

# Health checks
HEALTH_CHECK_INTERVAL_MS=30000  # Periodic checks every 30s (optional)
```

## Implementation Files

### Core Files Modified/Created
- `agent/src/health/health-arbiter.ts` - **NEW** (365 lines) - HealthArbiter class
- `agent/src/app.ts` - Updated startup/shutdown integration
- `agent/src/agent.ts` - Made `agentLogger` public
- `agent/src/system/systemd-watchdog.ts` - Added async health check support
- `agent/src/system/memory.ts` - Already had async `healthcheck()` (no changes)

### Documentation
- `agent/docs/HEALTH-ARBITER-INTEGRATION.md` - This file

## Related Documentation

- [Memory Monitoring Architecture](./MEMORY-MONITORING.md) (TODO)
- [Systemd Watchdog Implementation](./SYSTEMD-WATCHDOG.md) (TODO)
- [Agent Self-Update System](../docs/AGENT-UPDATE-SYSTEM.md)
- [Cloud Logging Integration](../docs/CLOUD-LOGGING-IMPROVEMENTS.md)

---

**Status:** Phase 1 Complete ✅ (Memory health integrated, build passing)  
**Next:** Phase 2 - Add MQTT subsystem health  
**Outcome:** Production-ready automatic recovery from partial failures
