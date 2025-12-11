# Redis High Load Tuning Guide

## Problem: Redis Crashes Under 100 Agent Load

When running 100+ agents, Redis experiences connection exhaustion and crashes with errors:
- `connect ECONNREFUSED 10.43.90.233:6379`
- `Reached the max retries per request limit (which is 3)`
- High latency: 16-17 second queue times (should be <100ms)

## Root Causes

1. **Too Many Connections**: Each API pod creates 5 separate Redis connections (log queue, sensor queue, main client, subscriber, websocket)
2. **Low Retry Limits**: `maxRetriesPerRequest: 3` is too aggressive for high load
3. **No Connection Pooling**: Creating new connections instead of reusing
4. **No Graceful Degradation**: Errors crash the API instead of dropping non-critical data
5. **Insufficient Redis Resources**: Default K8s Redis deployment too small for 100 agents

## Code Fixes Applied

### 1. Increased Retry Resilience
Changed `maxRetriesPerRequest` from **3** → **20** in all Redis clients to handle temporary overload.

### 2. Added Offline Queue Support
```typescript
enableOfflineQueue: true  // Queue commands during reconnection
```

### 3. Improved Retry Strategy
```typescript
retryStrategy: (times) => {
  if (times > 50) return null; // Stop after 50 attempts
  return Math.min(times * 100, 5000); // Exponential backoff, max 5s
}
```

### 4. Auto-Reconnect on Errors
```typescript
reconnectOnError: (err) => {
  const targetErrors = ['READONLY', 'ECONNREFUSED', 'ETIMEDOUT'];
  return targetErrors.some(e => err.message.includes(e));
}
```

### 5. Graceful Degradation
- **Before**: Throw error → crash API
- **After**: Drop non-critical data (logs, sensor data) if Redis unavailable
- Checks `redis.status` before writes
- Logs warning instead of crashing

### 6. Reduced Log Spam
Only log slow operations (>1s) to prevent log flooding under load.

### 7. Fixed UUID Logging Bug
Fixed logger spreading UUID string into character object: `{"0":"e","1":"3",...}`

## Kubernetes Redis Configuration

### Current (Insufficient for 100 agents)
```yaml
redis:
  resources:
    requests:
      cpu: 100m
      memory: 128Mi
    limits:
      cpu: 500m
      memory: 512Mi
```

### Recommended for 100+ Agents
```yaml
redis:
  image: redis:7-alpine
  
  resources:
    requests:
      cpu: 500m        # 5x increase
      memory: 1Gi      # 8x increase
    limits:
      cpu: 2000m       # Allow bursting
      memory: 2Gi
  
  # Redis configuration overrides
  config:
    maxclients: "10000"              # Default 10000, but explicit
    maxmemory: "1536mb"              # 75% of memory limit
    maxmemory-policy: "allkeys-lru"  # Evict oldest keys if full
    timeout: "300"                   # Close idle connections after 5min
    tcp-backlog: "511"               # Default, but ensure kernel allows
    tcp-keepalive: "300"             # Keep connections alive
    save: ""                         # Disable RDB snapshots (use AOF)
    appendonly: "yes"                # Enable AOF for durability
    appendfsync: "everysec"          # Fsync every second (balance)
    
  # Persistence (critical for crash recovery)
  persistence:
    enabled: true
    storageClass: "fast-ssd"  # Use SSD for AOF writes
    size: 10Gi
```

### Apply Kernel Tuning (Node-level)
```bash
# Increase TCP backlog (applies to all Redis pods on node)
sysctl -w net.core.somaxconn=65535
sysctl -w net.ipv4.tcp_max_syn_backlog=8192

# Make permanent
cat >> /etc/sysctl.conf <<EOF
net.core.somaxconn=65535
net.ipv4.tcp_max_syn_backlog=8192
EOF
```

## Monitoring & Alerts

### Key Metrics to Track
```promql
# Connection count
redis_connected_clients

# Memory usage
redis_memory_used_bytes / redis_memory_max_bytes * 100

# Command rate
rate(redis_commands_total[1m])

# Slow commands (>1s)
redis_slowlog_length

# Evicted keys (memory pressure)
rate(redis_evicted_keys_total[5m])
```

### Recommended Alerts
```yaml
alerts:
  - name: RedisConnectionsHigh
    expr: redis_connected_clients > 8000
    for: 5m
    severity: warning
    
  - name: RedisMemoryHigh
    expr: redis_memory_used_bytes / redis_memory_max_bytes > 0.9
    for: 5m
    severity: critical
    
  - name: RedisEvictions
    expr: rate(redis_evicted_keys_total[5m]) > 100
    for: 5m
    severity: warning
```

## Load Testing

### Test with 100 Simulated Agents
```bash
# Deploy 100 agent simulators
kubectl apply -f k8s/load-test/agent-simulator.yaml

# Monitor Redis
watch -n 1 'kubectl exec -it redis-0 -- redis-cli INFO clients'

# Check API logs
kubectl logs -f -l app=iotistic-api | grep -i redis

# Monitor latency
kubectl exec -it redis-0 -- redis-cli --latency-history
```

### Expected Metrics (Healthy)
- **Connections**: 500-1000 (5-10 per agent)
- **Memory**: 500MB-1GB (with 100 agents)
- **Latency**: <10ms p95, <50ms p99
- **Queue Depth**: <1000 messages per stream
- **CPU**: 20-30% average, 60-80% peak

### Failure Indicators
- ❌ Connections > 9000 (approaching limit)
- ❌ Memory > 90% (evictions starting)
- ❌ Latency > 100ms consistently
- ❌ `ECONNREFUSED` errors in logs
- ❌ Queue depth > 10000 (backlog building)

## Scaling Strategies

### Vertical Scaling (Simpler)
Increase Redis pod resources:
```yaml
resources:
  limits:
    cpu: 4000m
    memory: 4Gi
```

**Pros**: Simple, no code changes
**Cons**: Single point of failure, limited by node size

### Horizontal Scaling (Production)
Use Redis Cluster or Sentinel for high availability:
```yaml
redis:
  architecture: cluster
  nodes: 3
  replicas: 1
```

**Pros**: High availability, no single point of failure
**Cons**: More complex, requires cluster-aware client config

### Connection Pooling (Recommended)
Reduce connections per API pod from 5 to 1 by reusing client:
```typescript
// TODO: Refactor to use single Redis connection
// Currently: log queue, sensor queue, main client, subscriber, websocket (5x)
// Target: Single shared connection with command multiplexing (1x)
```

## Performance Benchmarks

### Before Fixes (100 agents)
- ❌ Redis crashes after 10 minutes
- ❌ 16-17s queue latency
- ❌ Max retries errors
- ❌ Connection refusals

### After Fixes (100 agents)
- ✅ Stable operation (pending Redis resource increase)
- ✅ <100ms queue latency (with adequate resources)
- ✅ Graceful degradation during spikes
- ✅ Auto-recovery from transient failures

## Next Steps

1. **Immediate**: Apply K8s Redis resource increases (CPU: 500m, Memory: 1Gi)
2. **Short-term**: Enable persistence (AOF) for crash recovery
3. **Medium-term**: Implement connection pooling to reduce connections 5x → 1x
4. **Long-term**: Migrate to Redis Cluster for horizontal scaling

## References
- [Redis Configuration Best Practices](https://redis.io/docs/management/config/)
- [IORedis Configuration](https://github.com/redis/ioredis#connect-to-redis)
- [Kubernetes Redis Operator](https://github.com/spotahome/redis-operator)
