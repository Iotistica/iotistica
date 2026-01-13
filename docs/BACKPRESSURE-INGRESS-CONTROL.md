# Backpressure & Burst Control at Ingress Points

**Problem**: 50+ Modbus devices coming online simultaneously overwhelm API ingestion, causing Redis OOM and data loss.

**Root Cause**: No admission control at ingress - devices push unlimited data regardless of API/Redis capacity.

---

## Current Architecture (No Backpressure)

```
50 Modbus Devices → Agent (publish) → MQTT → API (no limits) → Redis (OOM) → PostgreSQL
                     unlimited          unlimited   ❌ no control      💥
```

**Failure Mode**:
- All 50 devices start publishing simultaneously
- MQTT broker accepts all messages (no backpressure)
- API processes all messages (no rate limiting)
- Redis ingestion stream fills up
- Redis OOM kills pod
- All data dropped

---

## Target Architecture (With Backpressure)

```
50 Modbus Devices → Agent (publish) → MQTT → API Ingress Control → Redis → PostgreSQL
                     batched           QoS 1   rate limit         bounded   batched
                                       ↓       token bucket       streams
                                    PUBACK     shed load
                                    delay      circuit breaker
```

**Key Principle**: **Backpressure propagates backward from API to agents via MQTT PUBACK delays**

---

## Ingress Points (Where to Apply Control)

### 1. **MQTT Message Handler** (Primary - Highest Priority)
**File**: `api/src/mqtt/mqtt-manager.ts`

**Current**: Accepts all messages immediately, no throttling

**Problem**:
```typescript
// No rate limiting - processes unlimited messages
handleMessage(topic, payload) {
  await processMessage(); // ❌ No backpressure
}
```

**Strategy**: Token bucket rate limiter per device + global limit

**Benefits**:
- Per-device fairness (one device can't starve others)
- Global capacity protection
- MQTT QoS 1 backpressure (delay PUBACK when over limit)

### 2. **Redis Sensor Queue Add** (Secondary)
**File**: `api/src/services/redis-sensor-queue.ts`

**Current**: Checks connection status but no admission control

**Strategy**: 
- Check Redis Stream length before accepting
- Reject when stream > 80% capacity
- Return error to caller (propagates to MQTT handler)

### 3. **MQTT Broker Level** (Defense in Depth)
**File**: `mosquitto/mosquitto.conf`

**Current**: No per-client limits

**Strategy**:
- `max_inflight_messages` per client
- `max_queued_messages` per client
- Client quotas via `mosquitto-go-auth`

---

## Implementation Plan

### Phase 1: MQTT Ingress Rate Limiting (Critical - Do First)

#### 1.1 Token Bucket Rate Limiter

**File**: `api/src/middleware/rate-limiter.ts` (NEW)

```typescript
/**
 * Token Bucket Rate Limiter for MQTT Ingress
 * 
 * Two levels:
 * 1. Per-device limit (100 msg/sec default)
 * 2. Global API limit (5000 msg/sec default)
 * 
 * When limit exceeded:
 * - Delay MQTT PUBACK (QoS 1 backpressure)
 * - Log warning
 * - Metrics: rate_limited_count, shed_count
 */

interface TokenBucket {
  tokens: number;
  capacity: number;
  refillRate: number;  // tokens per second
  lastRefill: number;
}

class IngressRateLimiter {
  private deviceBuckets: Map<string, TokenBucket>;
  private globalBucket: TokenBucket;
  
  async tryAcquire(deviceUuid: string, cost: number = 1): Promise<boolean> {
    // Check global limit first (fail fast)
    if (!this.tryAcquireGlobal(cost)) {
      metrics.globalRateLimited++;
      return false;
    }
    
    // Check per-device limit
    if (!this.tryAcquireDevice(deviceUuid, cost)) {
      metrics.deviceRateLimited++;
      return false;
    }
    
    return true;
  }
  
  // When rate limited: delay MQTT PUBACK
  async waitForCapacity(deviceUuid: string): Promise<void> {
    const waitMs = this.calculateBackoffMs(deviceUuid);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}
```

**Configuration**:
```bash
# Environment variables
INGRESS_RATE_LIMIT_PER_DEVICE=100    # msg/sec per device
INGRESS_RATE_LIMIT_GLOBAL=5000       # msg/sec total
INGRESS_BACKPRESSURE_ENABLED=true    # Delay PUBACK when over limit
INGRESS_SHED_WHEN_CRITICAL=true      # Drop messages when Redis >90% capacity
```

#### 1.2 Integrate with MQTT Handler

**File**: `api/src/mqtt/mqtt-manager.ts`

```typescript
import { ingressRateLimiter } from '../middleware/rate-limiter';

private async handleMessage(topic: string, payload: Buffer) {
  const deviceUuid = this.extractDeviceUuid(topic);
  
  // ADMISSION CONTROL: Check rate limit
  const allowed = await ingressRateLimiter.tryAcquire(deviceUuid);
  
  if (!allowed) {
    // BACKPRESSURE: Delay PUBACK (only works with QoS 1)
    if (process.env.INGRESS_BACKPRESSURE_ENABLED === 'true') {
      await ingressRateLimiter.waitForCapacity(deviceUuid);
      // Now process (delayed PUBACK signals backpressure to agent)
    } else {
      // LOAD SHEDDING: Drop message
      logger.warn('Ingress rate limit exceeded - shedding load', {
        deviceUuid: deviceUuid.substring(0, 8),
        rateLimitPerDevice: process.env.INGRESS_RATE_LIMIT_PER_DEVICE,
        rateLimitGlobal: process.env.INGRESS_RATE_LIMIT_GLOBAL
      });
      metrics.messagesDropped++;
      return; // Drop message
    }
  }
  
  // Check deduplication (existing code)
  // Process message (existing code)
}
```

**Why PUBACK delay works**:
- MQTT QoS 1: Client waits for PUBACK before sending next message
- Delayed PUBACK = natural backpressure to agent
- Agent publish queue backs up → agent slows down reading Modbus
- **Backpressure propagates all the way to sensors**

#### 1.3 Upgrade MQTT QoS to 1 (Required for Backpressure)

**Agent side**: `agent/src/features/sensor-publish/publish.ts`

```typescript
// Change QoS from 0 to 1 for backpressure
await this.mqttClient.publish(topic, payload, {
  qos: 1,  // Wait for PUBACK (was 0)
  retain: false
});
```

**Why QoS 1**:
- QoS 0: Fire and forget (no backpressure possible)
- QoS 1: At least once + PUBACK acknowledgment
- QoS 2: Exactly once (too slow for high volume)

---

### Phase 2: Redis Stream Capacity Checks

#### 2.1 Check Stream Length Before Accepting

**File**: `api/src/services/redis-sensor-queue.ts`

```typescript
async add(sensorData: SensorDataEntry[]): Promise<void> {
  // ADMISSION CONTROL: Check stream capacity
  const streamLength = await this.redisIngestion.xlen(this.streamKey);
  const capacityPercent = (streamLength / this.maxStreamLength) * 100;
  
  if (capacityPercent > 90) {
    // CRITICAL: Reject new messages
    throw new Error(`Redis stream at ${capacityPercent.toFixed(1)}% capacity - shedding load`);
  } else if (capacityPercent > 80) {
    // WARNING: Accept but log
    logger.warn('Redis stream capacity high', {
      streamLength,
      maxStreamLength: this.maxStreamLength,
      capacityPercent: capacityPercent.toFixed(1)
    });
  }
  
  // Existing circuit breaker + disk spool logic
  // ...
}
```

**Throw error propagates to MQTT handler** → triggers rate limiter backpressure

---

### Phase 3: MQTT Broker Quotas (Defense in Depth)

#### 3.1 Mosquitto Configuration

**File**: `mosquitto/mosquitto.conf`

```conf
# Per-client message rate limiting
max_inflight_messages 20        # Max unacked messages per client
max_queued_messages 1000        # Max queued messages per client (QoS >0)

# Connection limits
max_connections 1000            # Total connections
```

#### 3.2 Per-Device Quotas via PostgreSQL Auth

**File**: `mosquitto/mosquitto-go-auth` PostgreSQL schema

```sql
-- Add quota columns to mqtt_acls table
ALTER TABLE mqtt_acls ADD COLUMN max_msg_rate_per_sec INTEGER DEFAULT 100;
ALTER TABLE mqtt_acls ADD COLUMN max_queued_messages INTEGER DEFAULT 1000;

-- Example: Limit device to 100 msg/sec
UPDATE mqtt_acls 
SET max_msg_rate_per_sec = 100 
WHERE username = 'device-uuid-123';
```

**mosquitto-go-auth** enforces these limits at MQTT broker level

---

### Phase 4: Agent-Side Flow Control (Optional but Recommended)

#### 4.1 Detect PUBACK Delays

**File**: `agent/src/features/sensor-publish/publish.ts`

```typescript
/**
 * Track MQTT publish latency to detect API backpressure
 */
private async publishWithBackpressureDetection(topic: string, payload: Buffer) {
  const startTime = Date.now();
  
  await this.mqttClient.publish(topic, payload, { qos: 1 });
  
  const pubackLatency = Date.now() - startTime;
  
  if (pubackLatency > 1000) {
    // API is backpressured (PUBACK delayed)
    this.logger.warn('API backpressure detected - slowing publish rate', {
      pubackLatency,
      currentBatchInterval: this.config.publishIntervalMs
    });
    
    // ADAPTIVE: Increase batch interval (slow down)
    this.config.publishIntervalMs = Math.min(
      this.config.publishIntervalMs * 1.5,
      30000 // Max 30 seconds
    );
  } else if (pubackLatency < 100) {
    // API healthy - can speed up
    this.config.publishIntervalMs = Math.max(
      this.config.publishIntervalMs * 0.9,
      1000 // Min 1 second
    );
  }
}
```

**Adaptive rate control**:
- PUBACK fast → speed up publishing
- PUBACK slow → slow down publishing
- **Agent automatically adjusts to API capacity**

---

## Monitoring & Observability

### Metrics to Track

```typescript
// Prometheus metrics
ingress_rate_limit_total{device="uuid"}     // Total rate limited messages
ingress_global_rate_limit_total             // Global rate limits hit
ingress_shed_total                          // Messages dropped (load shedding)
ingress_puback_latency_seconds{device}      // PUBACK latency (backpressure indicator)
redis_stream_capacity_percent               // Stream fullness %
redis_circuit_breaker_state                 // CLOSED/OPEN/HALF_OPEN
```

### Alerts

```yaml
# Critical: Redis stream >80% capacity
- alert: RedisStreamCapacityHigh
  expr: redis_stream_capacity_percent > 80
  for: 5m
  annotations:
    summary: "Redis ingestion stream at {{ $value }}% capacity"
    
# Warning: High rate limiting
- alert: IngressRateLimitingHigh
  expr: rate(ingress_rate_limit_total[5m]) > 10
  for: 5m
  annotations:
    summary: "High rate limiting: {{ $value }} msg/s being throttled"
```

---

## Configuration Matrix

| Scenario | Per-Device Limit | Global Limit | PUBACK Delay | Load Shedding | Redis MAXLEN |
|----------|------------------|--------------|--------------|---------------|--------------|
| **Development** (5 devices) | 1000 msg/s | 5000 msg/s | Disabled | Disabled | 10k |
| **Production** (50 devices) | 100 msg/s | 5000 msg/s | **Enabled** | **Enabled** | 10k |
| **High Volume** (500 devices) | 50 msg/s | 10000 msg/s | **Enabled** | **Enabled** | 50k |

---

## Testing Plan

### 1. Burst Test: 50 Devices Simultaneous Start

```bash
# Start 50 simulator agents
./scripts/generate-agents.ps1 -Count 50 -BuildFromSource -Run

# Expected behavior:
# - Rate limiter kicks in after 5000 msg/s global limit
# - Per-device limit at 100 msg/s prevents single device monopoly
# - PUBACK delays propagate backpressure to agents
# - Redis stream stays <80% capacity
# - No OOM kills
```

### 2. Sustained Load Test: 24 Hour Soak

```bash
# Run 50 devices for 24 hours
# Monitor:
# - Redis memory usage (should be stable)
# - API CPU/memory (should be stable)
# - PostgreSQL ingestion rate
# - Disk spool usage (should be 0 when Redis healthy)
```

### 3. Redis Outage Simulation

```bash
# Kill Redis pod
kubectl delete pod -n client1 client1-release-iotistic-redis-0

# Expected behavior:
# - Circuit breaker opens after 5 failures
# - Disk spool activates
# - Rate limiter backs off (PUBACK delays increase)
# - Agents slow down automatically
# - When Redis recovers: spool replays, rate limiter resumes
```

---

## Rollout Plan

### Week 1: Foundation
- [ ] Implement token bucket rate limiter (`rate-limiter.ts`)
- [ ] Add metrics and logging
- [ ] Unit tests for rate limiter

### Week 2: MQTT Integration
- [ ] Integrate rate limiter with MQTT handler
- [ ] Change agent QoS to 1
- [ ] Test PUBACK delay backpressure

### Week 3: Redis Capacity Checks
- [ ] Add stream length checks to `redis-sensor-queue.ts`
- [ ] Add admission control errors
- [ ] Test load shedding

### Week 4: Production Testing
- [ ] Deploy to staging with 50 simulators
- [ ] 24-hour soak test
- [ ] Redis outage simulation
- [ ] Tune limits based on metrics

### Week 5: Production Rollout
- [ ] Deploy to production with conservative limits
- [ ] Monitor for 1 week
- [ ] Gradually increase limits based on capacity
- [ ] Document runbook for operators

---

## Tuning Guide

### How to Set Per-Device Limit

```bash
# Formula: (Expected readings per device) * (Safety margin)
# Example: Modbus device with 10 registers @ 1 Hz = 10 msg/s
# Safety margin: 10x = 100 msg/s per device

INGRESS_RATE_LIMIT_PER_DEVICE=100
```

### How to Set Global Limit

```bash
# Formula: (Number of devices) * (Per-device limit) * (Peak factor)
# Example: 50 devices * 100 msg/s * 0.5 (not all peak) = 2500 msg/s
# Add headroom: 2500 * 2 = 5000 msg/s

INGRESS_RATE_LIMIT_GLOBAL=5000
```

### How to Set Redis Stream MAXLEN

```bash
# Formula: (Ingestion rate) * (Buffer time in seconds)
# Example: 5000 msg/s * 60s buffer = 300k messages
# Conservative: 10k messages = ~2 seconds buffer

REDIS_INGESTION_STREAM_MAXLEN=10000
```

---

## FAQ

### Q: Why not just increase Redis memory?
**A**: Redis memory increase is necessary but not sufficient. Without admission control, burst load will eventually OOM Redis regardless of size.

### Q: Will PUBACK delays impact real-time monitoring?
**A**: Only when system is overloaded (desired behavior). Normal operation has <100ms PUBACK latency. When backpressured, 1-2 second delays prevent system crash.

### Q: What about QoS 0 (fire and forget)?
**A**: QoS 0 has no backpressure mechanism. Messages are sent without acknowledgment, so API can't signal capacity to agent. **Must use QoS 1 for backpressure.**

### Q: Can we rate limit at agent instead of API?
**A**: Agent rate limiting helps but doesn't protect against burst scenarios (50 agents starting simultaneously). **Ingress control at API is mandatory.**

### Q: What if disk spool fills up?
**A**: Disk spool has bounded size (1GB default). When full, oldest files are deleted (LRU eviction). This is by design - prevents disk full, accepts data loss over system crash.

---

## Success Metrics

✅ **Redis memory stable** - No OOM kills even with 50 devices  
✅ **API CPU/memory stable** - No spikes during burst  
✅ **Backpressure working** - PUBACK latency increases under load  
✅ **No data loss** - Disk spool stays empty when Redis healthy  
✅ **Fair scheduling** - No single device monopolizes API  
✅ **Fast recovery** - Circuit breaker closes within 30s after Redis recovery  

---

## References

- [MQTT QoS Levels](https://www.hivemq.com/blog/mqtt-essentials-part-6-mqtt-quality-of-service-levels/)
- [Token Bucket Algorithm](https://en.wikipedia.org/wiki/Token_bucket)
- [Redis Streams XLEN](https://redis.io/commands/xlen/)
- [Mosquitto max_inflight_messages](https://mosquitto.org/man/mosquitto-conf-5.html)
