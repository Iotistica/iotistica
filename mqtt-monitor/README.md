# MQTT Monitor Service

Real-time MQTT topic monitoring service with automatic schema generation, metrics tracking, and broker statistics. This microservice monitors all MQTT messages, generates JSON schemas from payloads, tracks message rates, and persists data to PostgreSQL for historical analysis.

## Features

- **Topic Tree Monitoring**: Hierarchical view of all MQTT topics with message counts
- **Automatic Schema Generation**: Detects JSON/XML/string/binary payloads and generates schemas
- **Real-time Metrics**: Message rates, throughput, client counts, subscription tracking
- **Broker Statistics**: Complete $SYS topic monitoring from MQTT broker
- **Database Persistence**: Historical data storage in PostgreSQL
- **Time-windowed Queries**: Filter topics and metrics by time ranges
- **Schema Evolution Tracking**: Track how message schemas change over time

## Architecture

This service is part of the Iotistic IoT platform microservices architecture and is accessed through the API gateway (main API service on port 3002). It runs internally on port 3500 and is not exposed externally.

```
Dashboard → API Gateway (3002) → MQTT Monitor (3500:internal) → PostgreSQL
                                       ↓
                                   Mosquitto (1883)
```

## Environment Variables

```bash
# Service Configuration
PORT=3500
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info

# Database Configuration
DB_HOST=postgres
DB_PORT=5432
DB_NAME=iotistic
DB_USER=postgres
DB_PASSWORD=postgres
DB_POOL_SIZE=10

# MQTT Broker Configuration
MQTT_BROKER_URL=mqtt://mosquitto:1883
MQTT_USERNAME=admin
MQTT_PASSWORD=your_password

# Monitor Configuration
MQTT_PERSIST_DB=true
MQTT_DB_SYNC_INTERVAL=30000
MQTT_METRICS_UPDATE_INTERVAL=5000
MQTT_TOPIC_TREE_UPDATE_INTERVAL=5000
MQTT_IGNORE_RETAINED=false
```

## API Endpoints

All endpoints are prefixed with `/api/v1`

### Status & Control

#### `GET /status`
Get monitor connection status and basic statistics.

**Response**:
```json
{
  "success": true,
  "data": {
    "connected": true,
    "topicCount": 42,
    "messageCount": 15234
  }
}
```

#### `POST /start`
Start the MQTT monitor (if stopped).

#### `POST /stop`
Stop the MQTT monitor gracefully.

### Topic Monitoring

#### `GET /topic-tree`
Get hierarchical topic tree with full structure.

**Response**: Complete nested topic tree with metadata.

#### `GET /topics`
Get flattened list of topics with message counts and schemas.

**Query Parameters**:
- `timeWindow`: Filter by time window (`1h`, `6h`, `24h`, `7d`, `30d`, `all`)
- `minutes`: Alternative time filter in minutes (e.g., `60` for last hour)

**Response**:
```json
{
  "success": true,
  "count": 15,
  "data": [
    {
      "topic": "sensor/temperature",
      "messageCount": 1234,
      "sessionCount": 45,
      "lastMessage": "{\"temp\":23.5,\"unit\":\"C\"}",
      "messageType": "json",
      "schema": {
        "type": "object",
        "properties": {
          "temp": {"type": "number"},
          "unit": {"type": "string"}
        }
      },
      "lastModified": 1699999999999
    }
  ],
  "timeWindow": "1h",
  "filteredFrom": "2025-01-15T10:00:00Z"
}
```

#### `GET /topics/:topic/schema`
Get schema for a specific topic.

**Example**: `GET /api/v1/topics/sensor/temperature/schema`

**Response**:
```json
{
  "success": true,
  "data": {
    "topic": "sensor/temperature",
    "messageType": "json",
    "schema": {
      "type": "object",
      "properties": {
        "temp": {"type": "number"},
        "unit": {"type": "string"}
      }
    }
  }
}
```

### Metrics & Statistics

#### `GET /metrics`
Get real-time broker metrics.

**Response**:
```json
{
  "success": true,
  "data": {
    "messageRate": {
      "published": [0, 5, 10, 15, 20],
      "received": [0, 5, 10, 15, 20],
      "current": {
        "published": 20,
        "received": 20
      }
    },
    "throughput": {
      "inbound": [10, 15, 20, 25, 30],
      "outbound": [10, 15, 20, 25, 30],
      "current": {
        "inbound": 30,
        "outbound": 30
      }
    },
    "clients": 5,
    "subscriptions": 12,
    "retainedMessages": 8,
    "totalMessages": {
      "sent": 15234,
      "received": 15230
    },
    "timestamp": 1699999999999
  }
}
```

#### `GET /system-stats`
Get raw $SYS topic statistics from broker.

#### `GET /stats`
Get comprehensive statistics (combines metrics + system stats + schema info).

#### `GET /dashboard`
Get all dashboard data in one call (optimized for UI).

### Database Queries

#### `GET /database/topics`
Query topics from PostgreSQL (historical data).

**Query Parameters**:
- `limit`: Maximum number of results (default: 100)
- `messageType`: Filter by type (`json`, `xml`, `string`, `binary`)
- `hasSchema`: Filter by schema presence (`true`, `false`)

#### `GET /database/stats/summary`
Get statistics summary from database.

**Response**:
```json
{
  "success": true,
  "data": {
    "total_topics": 42,
    "topics_with_schemas": 35,
    "json_topics": 30,
    "xml_topics": 2,
    "string_topics": 5,
    "binary_topics": 5,
    "total_messages": "152345",
    "last_activity": "2025-01-15T10:30:00Z"
  }
}
```

#### `GET /database/schema-history/:topic`
Get schema evolution history for a topic.

**Example**: `GET /api/v1/database/schema-history/sensor/temperature`

#### `GET /recent-activity`
Get recent message counts for all topics (time-windowed).

**Query Parameters**:
- `window`: Time window in minutes (`5`, `15`, `30`, `60`)

#### `GET /topics/:topic/recent-activity`
Get recent activity for a specific topic with data points.

### Database Sync

#### `POST /sync`
Manually trigger database sync (force flush).

## Database Schema

The service uses the following PostgreSQL tables:

- `mqtt_topics`: Topic metadata, schemas, message counts
- `mqtt_schema_history`: Schema evolution tracking
- `mqtt_broker_stats`: Broker statistics snapshots
- `mqtt_topic_metrics`: Time-windowed metrics for analysis

## Docker Deployment

### Standalone

```bash
docker build -t iotistic/mqtt-monitor:latest .
docker run -d \
  --name mqtt-monitor \
  -p 3500:3500 \
  -e MQTT_BROKER_URL=mqtt://mosquitto:1883 \
  -e DB_HOST=postgres \
  -e DB_PASSWORD=your_password \
  iotistic/mqtt-monitor:latest
```

### Docker Compose

The service is configured for internal-only access via the API gateway:

```yaml
mqtt-monitor:
  build: ./mqtt-monitor
  container_name: iotistic-mqtt-monitor
  restart: unless-stopped
  expose:
    - "3500"  # Internal only, not exposed externally
  environment:
    - PORT=3500
    - MQTT_BROKER_URL=mqtt://mosquitto:1883
    - DB_HOST=postgres
    - DB_PASSWORD=${DB_PASSWORD}
  depends_on:
    - postgres
    - mosquitto
  networks:
    - iotistic-net
```

Access via API gateway:
```bash
# Through API gateway (external access)
curl http://localhost:3002/api/v1/mqtt-monitor/status

# Direct access (internal only, for debugging)
docker exec -it iotistic-mqtt-monitor curl http://localhost:3500/api/v1/status
```

## Development

### Local Setup

```bash
# Install dependencies
npm install

# Create a local .env file if you need custom settings
# Example: PORT=3500

# Run in development mode
npm run dev

# Build TypeScript
npm run build

# Run production build
npm start
```

### Testing

```bash
# Check service health
curl http://localhost:3500/health

# Get monitor status
curl http://localhost:3500/api/v1/status

# Get all topics
curl http://localhost:3500/api/v1/topics

# Get topics from last hour
curl "http://localhost:3500/api/v1/topics?timeWindow=1h"

# Get comprehensive stats
curl http://localhost:3500/api/v1/stats
```

## Monitoring

### Health Checks

- `/health`: Basic health check (returns 200 if service is running)
- `/ready`: Readiness check (returns 200 when fully initialized)
- `/api/v1/status`: Monitor connection status and statistics

### Logs

The service uses Winston for structured logging:

```
2025-01-15 10:30:00 [INFO]: Starting MQTT Monitor Service
2025-01-15 10:30:01 [INFO]: Database connection established
2025-01-15 10:30:02 [INFO]: Connecting to mqtt://mosquitto:1883
2025-01-15 10:30:03 [INFO]: Connected to mqtt://mosquitto:1883
2025-01-15 10:30:03 [INFO]: Subscribed to all topics (#)
2025-01-15 10:30:03 [INFO]: Subscribed to $SYS topics
2025-01-15 10:30:03 [INFO]: MQTT Monitor Service listening on 0.0.0.0:3500
```

## Performance

- **Memory**: Approximately 100-200MB for 1000 active topics
- **CPU**: Minimal (< 5%) during normal operation
- **Database Sync**: Configurable interval (default 30s)
- **Metrics Update**: Configurable interval (default 5s)

## Integration with Dashboard

The dashboard accesses MQTT Monitor via the API gateway:

```typescript
// Dashboard API configuration
const MQTT_MONITOR_BASE = `${API_BASE_URL}/mqtt-monitor`;

// Fetch topic tree
const response = await fetch(`${MQTT_MONITOR_BASE}/topic-tree`);

// Fetch metrics
const metrics = await fetch(`${MQTT_MONITOR_BASE}/metrics`);

// Fetch recent topics
const topics = await fetch(`${MQTT_MONITOR_BASE}/topics?timeWindow=1h`);
```

## Troubleshooting

### Monitor not connecting to MQTT broker

Check MQTT credentials and broker availability:
```bash
docker logs iotistic-mqtt-monitor 2>&1 | grep -i "mqtt\|connect"
```

### Database persistence not working

Verify PostgreSQL connection and table existence:
```bash
# Check database connection
docker exec -it iotistic-postgres psql -U postgres -d iotistic -c "\dt mqtt_*"

# Check logs
docker logs iotistic-mqtt-monitor 2>&1 | grep -i "database\|persist"
```

### High memory usage

Reduce retention of in-memory topic tree:
```bash
# Restart with lower sync interval to persist data more frequently
MQTT_DB_SYNC_INTERVAL=10000  # 10 seconds instead of 30
```

## License

MIT License - Part of the Iotistic IoT Platform
