# Agent-Side Ingress Control at Protocol Adapter Level

**Problem**: 50 Modbus devices starting simultaneously read registers at full speed → sensor-publish overwhelmed → MQTT broker flooded → API OOM

**Solution**: Rate limit at the SOURCE - protocol adapter level (before sensor-publish even sees the data)

---

## Current Pipeline (No Control)

```
Modbus Device → Modbus Adapter → Sensor Publish → MQTT → API
                (read 100Hz)      (batch 5s)              ❌ overload
                unlimited         unlimited
```

**Failure Cascade**:
1. **50 Modbus adapters** start simultaneously
2. Each reads **10 registers @ 100Hz** = 1000 readings/sec per device
3. **Total**: 50,000 readings/sec hitting sensor-publish
4. Sensor-publish buffers fill → memory pressure
5. MQTT publishes flood broker → API can't keep up
6. Redis OOM → system crash

---

## Target Pipeline (Controlled at Source)

```
Modbus Device → Modbus Adapter → Sensor Publish → MQTT → API
                (throttled)       (batch 5s)              ✅ stable
                ↓
                Rate Limiter
                (adaptive polling)
```

**Key Insight**: Control the **read rate** from devices, not the publish rate

---

## Protocol Adapter Architecture

### Current Adapters

| Adapter | File | Read Pattern | Current Control |
|---------|------|--------------|-----------------|
| **Modbus** | `agent/src/features/endpoints/modbus/` | Polling loop | Fixed interval ❌ |
| **OPC UA** | `agent/src/features/endpoints/opcua/` | Subscription | Fixed rate ❌ |
| **SNMP** | `agent/src/features/endpoints/snmp/` | Polling loop | Fixed interval ❌ |
| **CAN** | `agent/src/features/endpoints/can/` | Event-driven | No control ❌ |

**Problem**: All use **fixed intervals** - no adaptation to system load

---

## Implementation Strategy

### Phase 1: Add Adaptive Polling to Modbus Adapter (Highest Priority)

#### 1.1 Current Modbus Polling Logic

**File**: `agent/src/features/endpoints/modbus/modbus-endpoint.ts`

**Current Pattern**:
```typescript
// Fixed interval polling - no backpressure awareness
setInterval(async () => {
  const registers = await this.readRegisters(); // 10 registers
  this.sendToSensorPublish(registers); // Always sends
}, 1000); // Fixed 1Hz
```

**Problems**:
- No awareness of sensor-publish queue depth
- No adaptation to CPU/memory pressure
- All 50 devices poll simultaneously on startup

#### 1.2 Proposed: Adaptive Polling with Backpressure

**File**: `agent/src/features/endpoints/modbus/adaptive-poller.ts` (NEW)

```typescript
/**
 * Adaptive Polling Controller
 * 
 * Adjusts Modbus read rate based on:
 * 1. Sensor-publish queue depth (backpressure)
 * 2. System CPU/memory load
 * 3. MQTT publish success rate
 * 4. Time-of-day (optional: slower at night)
 */
class AdaptivePoller {
  private baseIntervalMs: number;      // Configured base interval (e.g., 1000ms)
  private currentIntervalMs: number;   // Adaptive interval (increases under load)
  private minIntervalMs: number = 100; // Never faster than 100ms
  private maxIntervalMs: number = 60000; // Never slower than 1 minute
  
  constructor(baseIntervalMs: number) {
    this.baseIntervalMs = baseIntervalMs;
    this.currentIntervalMs = baseIntervalMs;
  }
  
  /**
   * Calculate next poll interval based on system state
   */
  getNextInterval(systemState: SystemState): number {
    let multiplier = 1.0;
    
    // 1. Check sensor-publish queue depth (CRITICAL)
    if (systemState.sensorPublishQueueDepth > 1000) {
      // Queue backing up - slow down aggressively
      multiplier *= 5.0;
    } else if (systemState.sensorPublishQueueDepth > 500) {
      // Queue filling - slow down moderately
      multiplier *= 2.0;
    } else if (systemState.sensorPublishQueueDepth < 100) {
      // Queue draining - can speed up
      multiplier *= 0.8;
    }
    
    // 2. Check system CPU load
    if (systemState.cpuPercent > 80) {
      multiplier *= 3.0; // High CPU - reduce polling
    } else if (systemState.cpuPercent > 60) {
      multiplier *= 1.5;
    }
    
    // 3. Check system memory pressure
    if (systemState.memoryPercent > 90) {
      multiplier *= 4.0; // Critical memory - stop creating data
    } else if (systemState.memoryPercent > 75) {
      multiplier *= 2.0;
    }
    
    // 4. Check MQTT publish success rate (last 10 publishes)
    if (systemState.mqttSuccessRate < 0.5) {
      multiplier *= 3.0; // MQTT failing - slow down source
    }
    
    // Calculate new interval
    this.currentIntervalMs = Math.min(
      this.maxIntervalMs,
      Math.max(this.minIntervalMs, this.baseIntervalMs * multiplier)
    );
    
    return this.currentIntervalMs;
  }
  
  /**
   * Get current adaptive state for logging
   */
  getState(): AdaptiveState {
    return {
      baseIntervalMs: this.baseIntervalMs,
      currentIntervalMs: this.currentIntervalMs,
      slowdownFactor: this.currentIntervalMs / this.baseIntervalMs,
      isThrottled: this.currentIntervalMs > this.baseIntervalMs * 1.5
    };
  }
}

interface SystemState {
  sensorPublishQueueDepth: number;  // Messages waiting in sensor-publish
  cpuPercent: number;               // Current CPU usage (0-100)
  memoryPercent: number;            // Current memory usage (0-100)
  mqttSuccessRate: number;          // Recent MQTT publish success (0-1)
}
```

#### 1.3 Integrate with Modbus Endpoint

**File**: `agent/src/features/endpoints/modbus/modbus-endpoint.ts`

```typescript
import { AdaptivePoller } from './adaptive-poller';
import { getCpuUsage, getMemoryUsage } from '../../../system/metrics';

class ModbusEndpoint {
  private poller: AdaptivePoller;
  private pollingTimer: NodeJS.Timeout | null = null;
  
  async start() {
    // Initialize adaptive poller
    this.poller = new AdaptivePoller(this.config.pollIntervalMs || 1000);
    
    // Start adaptive polling loop
    this.scheduleNextPoll();
  }
  
  private scheduleNextPoll() {
    if (this.stopped) return;
    
    // Get current system state
    const systemState: SystemState = {
      sensorPublishQueueDepth: this.getSensorPublishQueueDepth(),
      cpuPercent: getCpuUsage(),
      memoryPercent: getMemoryUsage(),
      mqttSuccessRate: this.getMqttSuccessRate()
    };
    
    // Calculate adaptive interval
    const nextIntervalMs = this.poller.getNextInterval(systemState);
    
    // Log throttling if significant
    const state = this.poller.getState();
    if (state.isThrottled) {
      this.logger?.warn('Modbus polling throttled due to system load', {
        connection: this.config.name,
        baseIntervalMs: state.baseIntervalMs,
        currentIntervalMs: state.currentIntervalMs,
        slowdownFactor: state.slowdownFactor.toFixed(2),
        queueDepth: systemState.sensorPublishQueueDepth,
        cpuPercent: systemState.cpuPercent,
        memoryPercent: systemState.memoryPercent
      });
    }
    
    // Schedule next poll
    this.pollingTimer = setTimeout(async () => {
      await this.poll();
      this.scheduleNextPoll(); // Recursive - calculates next interval each time
    }, nextIntervalMs);
  }
  
  private async poll() {
    try {
      // Read Modbus registers
      const readings = await this.readRegisters();
      
      // Send to sensor-publish (may be throttled by sensor-publish itself)
      await this.sendToSensorPublish(readings);
      
    } catch (err) {
      this.logger?.error('Modbus poll error', { error: err.message });
    }
  }
  
  /**
   * Get current sensor-publish queue depth
   * This is the KEY metric for backpressure
   */
  private getSensorPublishQueueDepth(): number {
    // Access sensor-publish instance's messageBatch.messages.length
    // This tells us how backed up the publish queue is
    return this.sensorPublish?.getQueueDepth() || 0;
  }
  
  /**
   * Get recent MQTT publish success rate
   */
  private getMqttSuccessRate(): number {
    // Track last 10 publish attempts
    // Return ratio of successful publishes
    return this.mqttStats.getSuccessRate();
  }
}
```

#### 1.4 Expose Queue Depth from Sensor-Publish

**File**: `agent/src/features/sensor-publish/publish.ts`

```typescript
export class Sensor extends EventEmitter {
  // ... existing code
  
  /**
   * Get current queue depth (for backpressure signaling)
   * Exposed to protocol adapters for adaptive polling
   */
  public getQueueDepth(): number {
    return this.messageBatch.messages.length;
  }
  
  /**
   * Get queue depth as percentage of max batch size
   */
  public getQueuePressure(): number {
    return (this.messageBatch.messages.length / MAX_BATCH_MESSAGES) * 100;
  }
  
  /**
   * Check if queue is under pressure (>50% full)
   */
  public isBackpressured(): boolean {
    return this.getQueuePressure() > 50;
  }
}
```

---

### Phase 2: Startup Jitter (Prevent Thundering Herd)

**Problem**: All 50 Modbus devices start polling simultaneously → synchronized burst every poll interval

**Solution**: Add random startup delay (jitter)

#### 2.1 Jittered Startup

**File**: `agent/src/features/endpoints/modbus/modbus-endpoint.ts`

```typescript
async start() {
  // Add random startup delay (0-5 seconds jitter)
  const maxJitterMs = 5000;
  const jitterMs = Math.random() * maxJitterMs;
  
  this.logger?.info('Starting Modbus endpoint with startup jitter', {
    connection: this.config.name,
    jitterMs: Math.round(jitterMs)
  });
  
  await new Promise(resolve => setTimeout(resolve, jitterMs));
  
  // Now start adaptive polling
  this.poller = new AdaptivePoller(this.config.pollIntervalMs || 1000);
  this.scheduleNextPoll();
}
```

**Effect**: 50 devices spread their first poll over 5 seconds instead of all hitting at t=0

**Configuration**:
```bash
# Environment variable
MODBUS_STARTUP_JITTER_MS=5000  # Default 5 seconds
```

---

### Phase 3: Per-Connection Rate Limiting

**Problem**: One Modbus connection with 100 registers shouldn't starve another connection with 5 registers

**Solution**: Per-connection token bucket

#### 3.1 Per-Connection Token Bucket

**File**: `agent/src/features/endpoints/modbus/connection-rate-limiter.ts` (NEW)

```typescript
/**
 * Per-Connection Rate Limiter
 * Ensures fair scheduling across multiple Modbus connections
 */
class ConnectionRateLimiter {
  private buckets: Map<string, TokenBucket>;
  private readonly maxReadingsPerSecPerConnection: number;
  
  constructor(maxReadingsPerSecPerConnection: number = 100) {
    this.buckets = new Map();
    this.maxReadingsPerSecPerConnection = maxReadingsPerSecPerConnection;
  }
  
  /**
   * Try to acquire tokens for a Modbus read
   * @param connectionName - Modbus connection identifier
   * @param registerCount - Number of registers to read
   * @returns true if allowed, false if rate limited
   */
  async tryAcquire(connectionName: string, registerCount: number): Promise<boolean> {
    let bucket = this.buckets.get(connectionName);
    
    if (!bucket) {
      bucket = new TokenBucket(
        this.maxReadingsPerSecPerConnection,
        this.maxReadingsPerSecPerConnection,
        connectionName
      );
      this.buckets.set(connectionName, bucket);
    }
    
    // Cost = number of registers (1 register = 1 token)
    const allowed = bucket.tryConsume(registerCount);
    
    if (!allowed) {
      // Rate limited - calculate backoff
      const backoffMs = bucket.calculateBackoffMs();
      
      this.logger?.debug('Modbus connection rate limited', {
        connection: connectionName,
        registerCount,
        backoffMs,
        tokensAvailable: bucket.getTokens()
      });
    }
    
    return allowed;
  }
}
```

#### 3.2 Integrate with Modbus Endpoint

```typescript
class ModbusEndpoint {
  private rateLimiter: ConnectionRateLimiter;
  
  async start() {
    // Initialize per-connection rate limiter
    const maxReadingsPerSec = parseInt(process.env.MODBUS_MAX_READINGS_PER_SEC || '100', 10);
    this.rateLimiter = new ConnectionRateLimiter(maxReadingsPerSec);
    
    // ... rest of startup
  }
  
  private async poll() {
    // Calculate how many registers we're about to read
    const registerCount = this.config.registers?.length || 0;
    
    // Check rate limit BEFORE reading Modbus
    const allowed = await this.rateLimiter.tryAcquire(this.config.name, registerCount);
    
    if (!allowed) {
      this.logger?.warn('Modbus poll skipped - rate limited', {
        connection: this.config.name,
        registerCount
      });
      return; // Skip this poll cycle
    }
    
    // Proceed with Modbus read
    const readings = await this.readRegisters();
    await this.sendToSensorPublish(readings);
  }
}
```

---

### Phase 4: Global Agent-Wide Rate Limiting

**Problem**: Even with per-connection limits, 50 connections × 100 readings/sec = 5000 readings/sec might overload agent

**Solution**: Global agent rate limiter (all connections share tokens)

#### 4.1 Global Rate Limiter

**File**: `agent/src/features/endpoints/global-rate-limiter.ts` (NEW)

```typescript
/**
 * Global Agent Rate Limiter
 * Shared across ALL protocol adapters (Modbus, OPC UA, SNMP, etc.)
 * Prevents agent from overloading itself regardless of connection count
 */
class GlobalAgentRateLimiter {
  private static instance: GlobalAgentRateLimiter;
  private globalBucket: TokenBucket;
  
  private constructor() {
    const maxReadingsPerSec = parseInt(process.env.AGENT_MAX_READINGS_PER_SEC || '1000', 10);
    this.globalBucket = new TokenBucket(maxReadingsPerSec, maxReadingsPerSec, 'agent-global');
  }
  
  static getInstance(): GlobalAgentRateLimiter {
    if (!GlobalAgentRateLimiter.instance) {
      GlobalAgentRateLimiter.instance = new GlobalAgentRateLimiter();
    }
    return GlobalAgentRateLimiter.instance;
  }
  
  async tryAcquire(cost: number, source: string): Promise<boolean> {
    const allowed = this.globalBucket.tryConsume(cost);
    
    if (!allowed) {
      console.log(`[Global Rate Limit] ${source} throttled (cost: ${cost}, tokens: ${this.globalBucket.getTokens()})`);
    }
    
    return allowed;
  }
}
```

#### 4.2 Use in All Protocol Adapters

**Modbus**:
```typescript
private async poll() {
  const registerCount = this.config.registers?.length || 0;
  
  // 1. Check global agent limit (ALL protocols compete for these tokens)
  const globalAllowed = await GlobalAgentRateLimiter.getInstance()
    .tryAcquire(registerCount, `modbus:${this.config.name}`);
  
  if (!globalAllowed) return; // Globally throttled
  
  // 2. Check per-connection limit
  const connAllowed = await this.rateLimiter.tryAcquire(this.config.name, registerCount);
  
  if (!connAllowed) return; // Connection throttled
  
  // 3. Proceed with read
  const readings = await this.readRegisters();
  await this.sendToSensorPublish(readings);
}
```

**OPC UA** (same pattern):
```typescript
private async onDataChange(nodeId: string, value: any) {
  // Check global limit before processing OPC UA subscription update
  const allowed = await GlobalAgentRateLimiter.getInstance()
    .tryAcquire(1, `opcua:${this.config.name}`);
  
  if (!allowed) return; // Drop this update
  
  await this.sendToSensorPublish({ nodeId, value });
}
```

---

## Configuration Matrix

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `MODBUS_STARTUP_JITTER_MS` | 5000 | Random startup delay (0-N ms) |
| `MODBUS_MAX_READINGS_PER_SEC` | 100 | Per-connection rate limit |
| `AGENT_MAX_READINGS_PER_SEC` | 1000 | Global agent rate limit |
| `ADAPTIVE_POLLING_ENABLED` | true | Enable adaptive polling |
| `ADAPTIVE_POLLING_CPU_THRESHOLD` | 80 | Slowdown when CPU >N% |
| `ADAPTIVE_POLLING_MEMORY_THRESHOLD` | 75 | Slowdown when memory >N% |
| `ADAPTIVE_POLLING_QUEUE_THRESHOLD` | 500 | Slowdown when queue >N messages |

---

## Monitoring Metrics

### Per-Connection Metrics
```typescript
modbus_poll_interval_ms{connection="plc1"}           // Current adaptive interval
modbus_poll_throttled_total{connection="plc1"}      // Times throttled
modbus_readings_per_sec{connection="plc1"}          // Current read rate
modbus_queue_depth{connection="plc1"}               // Sensor-publish queue depth
```

### Global Metrics
```typescript
agent_global_rate_limited_total                     // Global throttling events
agent_active_connections_total                      // Active protocol connections
agent_total_readings_per_sec                        // Aggregate read rate
sensor_publish_queue_depth_total                    // All queues combined
```

---

## Testing Plan

### Test 1: 50 Modbus Connections Simultaneous Start

**Setup**:
```bash
# Generate 50 Modbus configs
./scripts/generate-modbus-configs.sh 50

# Start agent
ADAPTIVE_POLLING_ENABLED=true \
MODBUS_STARTUP_JITTER_MS=5000 \
AGENT_MAX_READINGS_PER_SEC=1000 \
npm start
```

**Expected Behavior**:
- ✅ Connections start over 5 seconds (jitter)
- ✅ Initial burst absorbed by adaptive polling
- ✅ Queue depth stays <500 messages
- ✅ CPU stays <80%
- ✅ No sensor-publish OOM
- ✅ Stable throughput: ~1000 readings/sec

### Test 2: Sustained Load (24 Hours)

**Monitor**:
- Adaptive interval changes over time
- CPU/memory stability
- Sensor-publish queue depth
- MQTT publish success rate
- No memory leaks

### Test 3: Burst Recovery

**Scenario**: Kill MQTT broker for 5 minutes

**Expected**:
- Adaptive polling slows down (MQTT failures detected)
- Queue drains slowly during outage
- When MQTT recovers: adaptive polling speeds back up
- No data loss (sensor-publish buffer holds data)

---

## Implementation Phases

### Week 1: Foundation
- [ ] Implement `AdaptivePoller` class
- [ ] Implement `TokenBucket` class
- [ ] Implement `ConnectionRateLimiter`
- [ ] Unit tests

### Week 2: Modbus Integration
- [ ] Integrate adaptive poller with Modbus endpoint
- [ ] Add startup jitter
- [ ] Add per-connection rate limiting
- [ ] Test with 10 connections

### Week 3: Global Rate Limiting
- [ ] Implement `GlobalAgentRateLimiter`
- [ ] Integrate with all protocol adapters (Modbus, OPC UA, SNMP)
- [ ] Test with 50 connections

### Week 4: Production Testing
- [ ] Deploy to staging
- [ ] 24-hour soak test
- [ ] Burst test (50 connections start)
- [ ] MQTT outage recovery test

### Week 5: Rollout
- [ ] Deploy to production with conservative limits
- [ ] Monitor metrics for 1 week
- [ ] Tune limits based on data
- [ ] Document runbook

---

## Why This Approach Works

✅ **Early Control**: Rate limit at the SOURCE (Modbus read) not the SINK (MQTT publish)

✅ **Adaptive**: System automatically slows down under load, speeds up when healthy

✅ **Fair**: Per-connection limits prevent one device from starving others

✅ **Global Protection**: Agent-wide limit prevents self-overload regardless of connection count

✅ **Jitter**: Startup randomization prevents thundering herd

✅ **Backpressure Aware**: Monitors sensor-publish queue depth (direct feedback loop)

✅ **No Data Loss**: Adapts rate instead of dropping data

---

## Comparison to API-Side Rate Limiting

| Approach | Pros | Cons |
|----------|------|------|
| **Agent-Side** (this plan) | ✅ Prevents creating excess data<br>✅ Protects agent CPU/memory<br>✅ Reduces network traffic<br>✅ Works offline | ❌ Per-agent configuration |
| **API-Side** (MQTT handler) | ✅ Centralized control<br>✅ Protects API/Redis | ❌ Data already created<br>❌ Wasted network bandwidth |

**Best Practice**: Use BOTH
- **Agent-side**: First line of defense (this plan)
- **API-side**: Second line of defense (MQTT rate limiter)

---

## Success Criteria

✅ 50 Modbus connections can start simultaneously without overload  
✅ Sensor-publish queue depth stays <500 messages  
✅ Agent CPU stays <80% during steady state  
✅ Agent memory stays <75% during steady state  
✅ No MQTT publish failures due to burst  
✅ Adaptive polling responds to system load within 10 seconds  
✅ Fair scheduling: no single connection monopolizes resources  
