## Message Buffer - Offline Resilience

### Overview

Local database buffering for sensor/endpoint data when MQTT is unavailable. Implements offline queue pattern from AWS IoT Greengrass and Azure IoT Edge.

### Architecture

```
Sensor/Endpoint
      │
      ├─ MQTT Connected?
      │  ├─ YES → Publish to MQTT
      │  └─ NO  → Buffer to device.sqlite
      │
      ├─ message_buffer table (FIFO queue)
      │  ├─ Max 10,000 records (configurable)
      │  ├─ Max 50 MB (configurable)
      │  └─ 72-hour TTL (configurable)
      │
      └─ BufferSync Service
         ├─ Polls every 30s when MQTT online
         ├─ Batch flush (100 records/batch)
         └─ Max 3 retries per message
```

### Database Schema

#### `message_buffer` Table
Stores queued sensor data messages.

| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER | Primary key |
| endpoint_name | TEXT | Name of endpoint/sensor |
| topic | TEXT | MQTT topic to publish to |
| qos | INTEGER | MQTT QoS level (default: 1) |
| payload | TEXT | JSON payload |
| payload_bytes | INTEGER | Size in bytes for quota tracking |
| retry_count | INTEGER | Number of publish attempts |
| last_retry_at | TIMESTAMP | Last retry timestamp |
| last_error | TEXT | Last publish error message |
| created_at | TIMESTAMP | Enqueue timestamp |
| expires_at | TIMESTAMP | TTL expiration |

#### `message_buffer_metadata` Table
Tracks buffer statistics and configuration.

| Key | Default | Description |
|-----|---------|-------------|
| max_records | 10000 | Max records before dropping oldest |
| max_bytes | 52428800 | Max buffer size (50 MB) |
| ttl_hours | 72 | Data expiration time (3 days) |
| total_buffered | 0 | Lifetime messages buffered |
| total_flushed | 0 | Lifetime messages flushed |
| total_dropped | 0 | Lifetime messages dropped |

### Features

#### 1. Automatic Buffering
When MQTT is unavailable, sensor data is automatically queued to local database:

```typescript
// In sensor.ts publishBatch()
if (!mqttManager.isConnected()) {
  await MessageBufferModel.enqueue({
    endpoint_name: this.getSensorName(),
    topic: `iot/device/${deviceUuid}/endpoints/${mqttTopic}`,
    qos: 1,
    payload: JSON.stringify(data),
    payload_bytes: Buffer.byteLength(payload, 'utf8')
  });
}
```

#### 2. Automatic Flush on Reconnect
Buffer automatically flushes when MQTT reconnects:

```typescript
mqttManager.on('connect', () => bufferSync.requestFlush());
```

#### 3. Quota Enforcement
Prevents unbounded growth:
- **Record limit**: Drops oldest when > 10,000 records
- **Byte limit**: Drops oldest when > 50 MB
- **TTL limit**: Expires records older than 72 hours

#### 4. Retry Logic
Failed publishes are retried with tracking:
- Max 3 retries per message
- Exponential backoff (handled by MQTT client)
- After max retries, message is dropped

#### 5. Statistics Tracking
Lifetime counters for monitoring:
```typescript
const stats = await SensorBufferModel.getStats();
// {
//   current_count: 150,
//   current_bytes: 45000,
//   total_buffered: 5000,
//   total_flushed: 4850,
//   total_dropped: 0,
//   oldest_record_age_hours: 2
// }
```

### Configuration

#### Environment Variables
```bash
# Buffer sync settings (optional)
BUFFER_FLUSH_INTERVAL_MS=30000    # 30 seconds
BUFFER_FLUSH_BATCH_SIZE=100       # 100 records per batch
BUFFER_MAX_RETRIES=3              # Max retries per message
BUFFER_CLEANUP_INTERVAL_MS=3600000 # 1 hour
```

#### Database Metadata
Update quotas directly in database:

```sql
-- Increase max records to 20,000
UPDATE message_buffer_metadata 
SET value = '20000' 
WHERE key = 'max_records';

-- Increase max size to 100 MB
UPDATE message_buffer_metadata 
SET value = '104857600' 
WHERE key = 'max_bytes';

-- Reduce TTL to 24 hours
UPDATE message_buffer_metadata 
SET value = '24' 
WHERE key = 'ttl_hours';
```

### Usage

#### Check Buffer Status
```typescript
import { MessageBufferModel } from './db/models';

// Get current stats
const stats = await MessageBufferModel.getStats();
console.log(`Buffered messages: ${stats.current_count}`);
console.log(`Total flushed: ${stats.total_flushed}`);
```

#### Manual Flush
```typescript
// Request immediate flush (non-blocking)
bufferSync.requestFlush();
```

#### Manual Cleanup
```typescript
// Remove expired records
const deleted = await MessageBufferModel.cleanupExpired();
console.log(`Deleted ${deleted} expired records`);
```

#### Clear Buffer (Testing)
```typescript
// Clear all buffered data
await MessageBufferModel.clear();
```

### Monitoring

#### Log Messages
Buffer sync logs key events:

```
[INFO] MQTT not connected, buffering 5 messages from endpoint 'sensor1'
[INFO] MQTT connected - initiating buffer flush
[INFO] Buffer flush batch completed (processed: 100, successful: 98, failed: 2)
[INFO] Buffer flush completed (totalFlushed: 500)
[INFO] Cleaned up expired buffer records (deleted: 15)
```

#### Statistics Queries
```sql
-- Current queue size
SELECT COUNT(*) as buffered_count, 
       SUM(payload_bytes) as buffered_bytes
FROM message_buffer;

-- Records by endpoint
SELECT endpoint_name, 
       COUNT(*) as count, 
       MAX(created_at) as latest
FROM message_buffer
GROUP BY endpoint_name;

-- Failed retries
SELECT endpoint_name, topic, retry_count, last_error
FROM message_buffer
WHERE retry_count > 0
ORDER BY retry_count DESC
LIMIT 10;

-- Lifetime statistics
SELECT * FROM message_buffer_metadata;
```

### Behavioral Notes

1. **MQTT Disabled**: If device is not provisioned with MQTT broker config, buffering is also disabled
2. **Edge AI**: Anomaly scores are still calculated locally even when buffered (enriched in payload)
3. **Ordering**: FIFO queue ensures oldest messages flush first
4. **Graceful Degradation**: If buffering fails, sensor continues operating but data is lost
5. **Memory Efficiency**: Batch processing prevents loading entire queue into memory

### Migration

Database migration automatically creates tables on first run:

```bash
# Apply migration
cd agent && npm run migrate

# Rollback (drops buffer tables)
cd agent && npm run migrate:rollback
```

### Comparison to Industry Standards

| Feature | Iotistic | AWS Greengrass | Azure IoT Edge |
|---------|----------|----------------|----------------|
| Max buffer size | 50 MB | 2.5 GB | Configurable |
| Offline duration | 72 hours TTL | Days/weeks | Days/weeks |
| Storage | SQLite | Disk queue | Time-series DB |
| Retry logic | 3 retries | Exponential backoff | Infinite retries |
| Quota enforcement | Record + byte limits | Size only | Retention policy |

### Future Enhancements

- [ ] Compression of buffered payloads (gzip)
- [ ] Priority queues (critical vs normal)
- [ ] Configurable backoff strategies
- [ ] Buffer metrics exposed via Device API
- [ ] Integration with system monitoring
