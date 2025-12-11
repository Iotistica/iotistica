# API Memory Leak Troubleshooting

## Problem: Heap Out of Memory with 100 Agents

**Symptoms:**
```
FATAL ERROR: Ineffective mark-compacts near heap limit
Allocation failed - JavaScript heap out of memory
Mark-Compact 500.4MB -> 496.8MB (no memory freed)
```

## Root Causes

### 1. **Insufficient Heap Size** (FIXED)
- **Default**: Node.js uses ~512MB heap by default
- **100 agents**: Each agent sends logs (1KB/s) + state (10KB/30s) + metrics (5KB/60s)
- **Memory needed**: ~1-2GB for buffers, caches, and queues
- **Fix**: `NODE_OPTIONS=--max-old-space-size=2048` (2GB heap)

### 2. **Redis Connection Buildup**
- **Issue**: 5 Redis connections per API pod × multiple reconnects = connection leak
- **Symptoms**: Memory grows steadily, connections not released
- **Fix**: Applied in redis-*-queue.ts - graceful degradation, offline queue enabled

### 3. **MQTT Message Backlog**
- **Issue**: During Redis outage, MQTT messages queue in memory
- **Symptoms**: Rapid memory growth when Redis is down
- **Fix**: Graceful degradation - drop messages instead of buffering

### 4. **Device Auth Cache**
- **Issue**: Auth cache grows unbounded (5min TTL but no max size)
- **Potential fix**: Add LRU cache with max size (e.g., 10k devices)

## Immediate Fixes Applied

### 1. Increased Heap Size (Dockerfile)
```dockerfile
ENV NODE_OPTIONS="--max-old-space-size=2048"
```

### 2. Redis Resilience
```typescript
// redis-log-queue.ts, redis-sensor-queue.ts
maxRetriesPerRequest: 20  // Was 3
enableOfflineQueue: true  // Queue commands during reconnect
```

### 3. Graceful Degradation
```typescript
// Check Redis status before writes
if (this.redis.status !== 'ready' && this.redis.status !== 'connect') {
  logger.warn('Redis not ready, dropping logs');
  return; // Don't accumulate in memory
}
```

## Monitoring Commands

### Check Current Memory Usage
```bash
# Inside API container
kubectl exec -it <api-pod> -- node -e "console.log(process.memoryUsage())"

# Expected output (healthy):
# heapUsed: 200-500MB (with 2GB limit)
# heapTotal: 300-700MB
# external: 50-100MB
# arrayBuffers: 10-50MB
```

### Monitor in Real-Time
```bash
# Memory trend over time
kubectl top pod <api-pod> --containers

# Expected: 200-800MB RSS under normal load (100 agents)
# Alert if: >1.5GB sustained
```

### Check Redis Connection Count
```bash
kubectl exec -it redis-0 -- redis-cli CLIENT LIST | wc -l

# Expected: 5-20 connections (1 API pod × 5 clients + monitoring)
# Alert if: >100 connections (leak)
```

### Check Redis Memory Usage
```bash
kubectl exec -it redis-0 -- redis-cli INFO memory

# Key metrics:
# used_memory_human: Should be <500MB with 100 agents
# used_memory_peak_human: Historical peak
# mem_fragmentation_ratio: Should be 1.0-1.5 (>2.0 = fragmentation)
```

## Load Test Results

### Before Fixes
- ❌ Crashed after 10 minutes
- ❌ Memory: 500MB → OOM
- ❌ Redis errors: Connection refused
- ❌ Agents offline: 21+ devices

### After Fixes (Expected)
- ✅ Stable operation
- ✅ Memory: 300-700MB (within 2GB limit)
- ✅ No Redis connection errors
- ✅ Graceful degradation during spikes

## Memory Budget (100 Agents)

| Component | Memory | Description |
|-----------|--------|-------------|
| Base Node.js | 50MB | V8 overhead |
| Express + Routes | 30MB | HTTP framework |
| Database Pool | 50MB | PostgreSQL connections (10 pool) |
| Redis Clients | 100MB | 5 connections × 20MB each |
| MQTT Client | 50MB | Message buffers |
| Log Queue Buffer | 200MB | Batching buffer (50 logs × 100 devices) |
| Sensor Queue Buffer | 200MB | Batching buffer (100 readings × 100 devices) |
| Auth Cache | 50MB | Device auth records (5min TTL) |
| Websockets | 100MB | Real-time connections (if any) |
| **Total Baseline** | **830MB** | Steady-state usage |
| **Peak (Spikes)** | **1.2GB** | During mass state reports |
| **Configured Limit** | **2GB** | 70% headroom for safety |

## Prevention Checklist

- [x] Heap size increased to 2GB
- [x] Redis retry limits increased
- [x] Graceful degradation for non-critical data
- [x] Connection monitoring (Redis, PostgreSQL)
- [ ] TODO: Add LRU cache for device auth (max 10k entries)
- [ ] TODO: Add memory monitoring alerts (Prometheus)
- [ ] TODO: Stream processing for high-volume endpoints

## Emergency Recovery

If API crashes again:

1. **Immediate**: Restart API pod (triggers fresh heap)
   ```bash
   kubectl delete pod <api-pod>
   ```

2. **Temporary**: Reduce agent count to 50
   ```bash
   kubectl scale deployment agent-simulator --replicas=50
   ```

3. **Investigation**: Check heap dump (if enabled)
   ```bash
   # Add to Dockerfile for debugging:
   ENV NODE_OPTIONS="--max-old-space-size=2048 --heapsnapshot-signal=SIGUSR2"
   
   # Trigger heap dump:
   kubectl exec -it <api-pod> -- kill -SIGUSR2 1
   ```

4. **Analysis**: Review logs for patterns
   ```bash
   kubectl logs <api-pod> | grep -E "warn|error" | tail -100
   ```

## Long-Term Solutions

### 1. Horizontal Scaling
Instead of vertical (more memory), add more API pods:
```yaml
replicas: 2  # Load balance across 2 pods
resources:
  limits:
    memory: 1Gi  # Each pod uses less memory
```

### 2. Stream Processing
For very high load (1000+ agents), use separate worker pods:
```yaml
# api-deployment.yaml - Handles HTTP only
replicas: 2
memory: 1Gi

# log-worker-deployment.yaml - Processes log queue
replicas: 2
memory: 512Mi

# sensor-worker-deployment.yaml - Processes sensor queue
replicas: 2
memory: 512Mi
```

### 3. Connection Pooling
Reduce Redis connections from 5 to 1 per pod:
```typescript
// TODO: Refactor to single shared Redis client
// Instead of: log queue, sensor queue, main client, subscriber, websocket
// Use: Single client with command multiplexing
```

## References
- [Node.js Memory Management](https://nodejs.org/en/docs/guides/simple-profiling/)
- [V8 Heap Limits](https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-megabytes)
- [IORedis Connection Pooling](https://github.com/redis/ioredis#connection-pooling)
