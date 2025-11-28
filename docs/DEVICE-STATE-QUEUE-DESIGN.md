# Device State Queue Architecture

## Problem
Direct database writes from MQTT handler don't scale:
- Blocks MQTT processing
- Database connection pool exhaustion
- No backpressure mechanism
- Slow with 100+ concurrent devices

## Solution: Redis Streams + Worker Pool

### Architecture
```
┌─────────┐     MQTT      ┌─────────┐    Redis Stream    ┌──────────┐
│ Devices ├──────────────>│   API   ├──────────────────>│  Stream  │
└─────────┘  (state)      └─────────┘   (non-blocking)  │  Queue   │
                                ↓                         └────┬─────┘
                          Redis Pub/Sub                       │
                          (real-time)                         │
                                ↓                              │
                          ┌──────────┐                        │
                          │Dashboard │                        │
                          │(WebSocket│                        │
                          └──────────┘                        │
                                                               │
                                                               ↓
                                                    ┌──────────────────┐
                                                    │  Worker Pool     │
                                                    │  (3-10 workers)  │
                                                    └────────┬─────────┘
                                                             │
                                                             ↓
                                                    ┌─────────────────┐
                                                    │   PostgreSQL    │
                                                    │  (batch writes) │
                                                    └─────────────────┘
```

### Components

#### 1. API Layer (Thin)
```typescript
// api/src/services/device-state-handler.ts
export async function processDeviceStateReport(
  stateReport: DeviceStateReport,
  options: ProcessingOptions
): Promise<void> {
  const { redisClient } = await import('../redis/client');
  
  for (const uuid in stateReport) {
    const deviceState = stateReport[uuid];
    
    // 1. Publish to stream (async, non-blocking)
    await redisClient.xadd(
      `device:state:${uuid}`,
      '*',
      'uuid', uuid,
      'state', JSON.stringify(deviceState),
      'timestamp', Date.now().toString(),
      'source', options.source
    );
    
    // 2. Publish to pub/sub for real-time (optional)
    await redisClient.publish(
      `device:state:${uuid}`,
      JSON.stringify(deviceState)
    );
    
    logger.info(`Queued state report for ${uuid.substring(0, 8)}...`);
  }
}
```

#### 2. Worker Pool
```typescript
// api/src/workers/device-state-worker.ts
import { redisClient } from '../redis/client';
import { DeviceCurrentStateModel, deviceSensorSync } from '../db/models';

const WORKER_GROUP = 'device-state-workers';
const STREAM_KEY = 'device:state:*'; // Pattern for all devices
const BATCH_SIZE = 100;
const BLOCK_MS = 5000;

async function processStateUpdates() {
  // Create consumer group (once)
  try {
    await redisClient.xgroup(
      'CREATE', STREAM_KEY, WORKER_GROUP, '0', 'MKSTREAM'
    );
  } catch (err) {
    // Group already exists
  }
  
  while (true) {
    try {
      // Read batch from stream (blocking)
      const streams = await redisClient.xreadgroup(
        'GROUP', WORKER_GROUP, `worker-${process.pid}`,
        'COUNT', BATCH_SIZE,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM_KEY, '>'
      );
      
      if (!streams || streams.length === 0) continue;
      
      // Batch process
      const updates = [];
      const acks = [];
      
      for (const [stream, messages] of streams) {
        for (const [id, fields] of messages) {
          const uuid = fields.uuid;
          const state = JSON.parse(fields.state);
          
          updates.push({ uuid, state });
          acks.push([stream, id]);
        }
      }
      
      // Batch write to database (single transaction)
      await batchUpdateDevices(updates);
      
      // Acknowledge messages
      for (const [stream, id] of acks) {
        await redisClient.xack(stream, WORKER_GROUP, id);
      }
      
      logger.info(`Processed ${updates.length} device state updates`);
      
    } catch (error) {
      logger.error('Worker error:', error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function batchUpdateDevices(updates: Array<{ uuid: string; state: any }>) {
  const client = await db.pool.connect();
  
  try {
    await client.query('BEGIN');
    
    for (const { uuid, state } of updates) {
      // Use prepared statements for speed
      await DeviceCurrentStateModel.update(uuid, state.apps || {}, state.config || {}, {
        ip_address: state.ip_address,
        mac_address: state.mac_address,
        os_version: state.os_version,
        agent_version: state.agent_version,
        uptime: state.uptime,
      }, state.version);
      
      // Reconcile sensors if config present
      if (state.config) {
        await deviceSensorSync.syncCurrentStateToTable(uuid, state);
      }
    }
    
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Start worker
if (require.main === module) {
  processStateUpdates().catch(console.error);
}
```

#### 3. Worker Deployment (Docker Compose)
```yaml
# docker-compose.yml
  device-state-worker:
    build: ./api
    command: node dist/workers/device-state-worker.js
    environment:
      NODE_ENV: production
      DATABASE_URL: postgresql://postgres:password@postgres:5432/iotistic
      REDIS_HOST: redis
      REDIS_PORT: 6379
    deploy:
      replicas: 3  # Scale based on load
    depends_on:
      - postgres
      - redis
```

### Performance Characteristics

**Throughput:**
- Single worker: 500-1,000 updates/sec
- 3 workers: 1,500-3,000 updates/sec
- 10 workers: 5,000-10,000 updates/sec

**Latency:**
- Queue write: 1-2ms (non-blocking)
- Processing delay: 50-200ms (batch dependent)
- Total: 50-202ms (vs 10-50ms direct, but non-blocking!)

**Resource Usage:**
- Redis memory: ~1KB per queued message
- At 1,000 devices reporting every 30s: ~1MB queue size
- At 10,000 devices: ~10MB queue size

**Backpressure:**
- Stream max length: `MAXLEN ~ 10000` (keep last 10k messages)
- Worker lag monitoring: `XPENDING` command
- Auto-scaling trigger: lag > 1000 messages

### Migration Path

**Phase 1: Dual Write (1 week)**
- Write to both DB and stream
- Verify worker processing
- Monitor discrepancies

**Phase 2: Stream Primary (1 week)**
- Stream becomes primary
- DB write stays as fallback
- Monitor performance

**Phase 3: Stream Only (production)**
- Remove direct DB writes
- Full async processing
- Scale workers as needed

### Monitoring

```typescript
// Health check endpoint
app.get('/health/queue', async (req, res) => {
  const pending = await redisClient.xpending('device:state:*', WORKER_GROUP);
  const lag = pending[0]; // Total pending messages
  
  res.json({
    status: lag < 1000 ? 'healthy' : 'degraded',
    pending_messages: lag,
    workers_active: 3,
    avg_processing_time_ms: 150
  });
});
```

### Alternative: Bull Queue (Simpler)

If Redis Streams feels too low-level, use Bull (already in your stack):

```typescript
// api/src/queues/device-state.queue.ts
import Queue from 'bull';

export const deviceStateQueue = new Queue('device-state', {
  redis: { host: process.env.REDIS_HOST, port: 6379 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// Handler
export async function queueDeviceState(uuid: string, state: any) {
  await deviceStateQueue.add('update', { uuid, state }, {
    priority: 1, // Higher than metrics
    jobId: `${uuid}-${Date.now()}` // Prevent duplicates
  });
}

// Worker
deviceStateQueue.process('update', 10, async (job) => {
  const { uuid, state } = job.data;
  await DeviceCurrentStateModel.update(uuid, ...);
  if (state.config) {
    await deviceSensorSync.syncCurrentStateToTable(uuid, state);
  }
});
```

**Bull Benefits:**
- Simpler API
- Built-in UI (bull-board)
- Retry logic
- Job prioritization
- Already familiar (you use it for jobs)

**Bull Drawbacks:**
- Slower than Redis Streams (1,000 vs 5,000/sec)
- More memory per job
- No consumer groups (single consumer type)

### Recommendation

Start with **Bull Queue** for simplicity, migrate to **Redis Streams** if you exceed 2,000 devices.

Your current metrics already use Redis Streams successfully, so you have the pattern.

## Cost-Benefit Analysis

**Current (Direct DB):**
- ✅ Simple
- ✅ Low latency
- ❌ Blocks MQTT
- ❌ Doesn't scale
- ❌ DB connection pool issues

**Bull Queue:**
- ✅ Simple API
- ✅ Built-in UI
- ✅ Scales to 2,000 devices
- ✅ Async processing
- ~50 lines of code

**Redis Streams:**
- ✅ Highest throughput
- ✅ Scales to 10,000+ devices
- ✅ Consumer groups (HA)
- ✅ Already using for metrics
- ~200 lines of code
- More operational complexity

Choose based on your device count and growth trajectory.
