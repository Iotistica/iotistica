# Prometheus Metrics Integration for Grafana

## Overview

The API exposes endpoint readings in Prometheus format for scraping and visualization in Grafana. This enables real-time monitoring of modbus, SNMP, and other protocol data without additional export services.

## Architecture

```
Devices (agents)
  └─> MQTT (endpoint data)
       └─> API (MQTT handler)
            └─> Redis Streams (queue)
                 └─> PostgreSQL/TimescaleDB (readings hypertable)
                      └─> /metrics endpoint (Prometheus exporter)
                           └─> Prometheus (scraper)
                                └─> Grafana (visualization)
```

## TimescaleDB Optimizations

The `/metrics` endpoint leverages TimescaleDB hypertable features for high performance:

- **Time-based partitioning**: 1-day chunks for fast time-range queries
- **Hypertable indexes**: Optimized `(device_uuid, time DESC)` and `(metric_name, time DESC)` indexes
- **Compression**: Data older than 7 days is automatically compressed
- **Quality filtering**: Only `quality='good'` readings are exported (filters out bad/uncertain data)
- **Efficient DISTINCT ON**: Uses time-partitioned indexes for latest value retrieval

**Performance**: Can handle 100+ devices with 10,000+ metrics in < 100ms query time.

## Metrics Endpoint

**URL**: `GET /metrics`  
**Format**: Prometheus text format  
**Authentication**: None (standard for Prometheus exporters)

### Example Response

```
# HELP endpoint_reading Latest endpoint reading value
# TYPE endpoint_reading gauge
# HELP endpoint_reading_timestamp Unix timestamp of last endpoint reading
# TYPE endpoint_reading_timestamp gauge
# HELP device_status Device online status (1=online, 0=offline)
# TYPE device_status gauge

endpoint_reading{device_uuid="abc123",device_name="Factory_Floor",metric_name="temperature",protocol="modbus",unit="celsius"} 23.5
endpoint_reading_timestamp{device_uuid="abc123",metric_name="temperature",protocol="modbus"} 1704902400

device_status{device_uuid="abc123",device_name="Factory_Floor"} 1
```

## Metrics Exposed

### 1. `endpoint_reading` (Gauge)
Latest endpoint value for each device/metric combination.

**Labels**:
- `device_uuid` - Unique device identifier (hyphens replaced with underscores)
- `device_name` - Human-readable device name
- `metric_name` - Metric identifier (modbus register, SNMP OID, endpoint name, etc.)
- `protocol` - Protocol used (modbus, snmp, mqtt, opcua, etc.)
- `unit` - Unit of measurement (celsius, percent, bytes, etc.)

**Example Query**:
```promql
# Current temperature from all devices
endpoint_reading{metric_name="temperature"}

# All modbus readings from specific device
endpoint_reading{device_uuid="abc123",protocol="modbus"}

# SNMP network traffic
endpoint_reading{protocol="snmp",metric_name=~".*bytes.*"}
```

### 2. `endpoint_reading_timestamp` (Gauge)
Unix timestamp (seconds) of when the reading was taken. Useful for detecting stale data.

**Labels**:
- `device_uuid`
- `metric_name`
- `protocol`

**Example Query**:
```promql
# Readings older than 5 minutes
(time() - endpoint_reading_timestamp) > 300
```

### 3. `device_status` (Gauge)
Device online status (1=online, 0=offline). Based on last_seen_at timestamp.

**Labels**:
- `device_uuid`
- `device_name`

**Example Query**:
```promql
# All offline devices
device_status == 0
```

## Prometheus Configuration

### Basic Scrape Config

Add this to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'iotistic-endpoints'
    scrape_interval: 30s
    static_configs:
      - targets: ['api:3002']  # Docker Compose
      # Or for Kubernetes NodePort:
      # - targets: ['10.27.27.160:30002']
```

### Kubernetes ServiceMonitor

If using Prometheus Operator, the ServiceMonitor is automatically created when `api.monitoring.enabled=true`:

```yaml
# k8s/charts/iotistic/values.yaml
api:
  monitoring:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    labels:
      # Match your Prometheus serviceMonitorSelector
      release: prometheus
```

**Note**: ServiceMonitor requires `monitoring.coreos.com/v1` CRD. Install with:

```bash
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
```

## Grafana Dashboards

### Adding Prometheus Data Source

1. Open Grafana → **Configuration** → **Data Sources**
2. Click **Add data source** → Select **Prometheus**
3. Set URL: `http://prometheus:9090` (or your Prometheus URL)
4. Click **Save & Test**

### Example Panels

#### Temperature Over Time
```promql
endpoint_reading{metric_name="temperature"}
```
- **Visualization**: Time Series
- **Legend**: `{{device_name}} - {{protocol}}`

#### Modbus Register Values
```promql
endpoint_reading{protocol="modbus"}
```
- **Visualization**: Time Series or Stat
- **Legend**: `{{device_name}} - {{metric_name}}`

#### SNMP Network Traffic
```promql
rate(endpoint_reading{protocol="snmp",metric_name=~".*bytes.*"}[5m])
```
- **Visualization**: Time Series
- **Unit**: bytes/sec
- **Legend**: `{{device_name}} - {{metric_name}}`

#### Device Online Status
```promql
device_status
```
- **Visualization**: Stat or Table
- **Thresholds**: Red < 1, Green = 1

#### Stale Data Alert
```promql
(time() - endpoint_reading_timestamp) > 300
```
- **Visualization**: Stat
- **Alert**: Warning if value > 0

### Sample Dashboard JSON

```json
{
  "dashboard": {
    "title": "IoT Endpoint Monitoring",
    "panels": [
      {
        "title": "Temperature Readings",
        "targets": [
          {
            "expr": "endpoint_reading{metric_name=\"temperature\"}",
            "legendFormat": "{{device_name}} - {{data_point}}"
          }
        ],
        "type": "timeseries"
      }
    ]
  }
}
```

## Performance Considerations

### Data Volume

The `/metrics` endpoint returns latest readings for all devices (last 1 hour, max 10,000 readings). For large fleets:

- **Light load** (< 50 devices): 30-second scrape interval is fine
- **Medium load** (50-200 devices): 60-second scrape interval
- **Heavy load** (200+ devices): 120-second scrape interval or use metric relabeling

### Query Optimization

The SQL query is optimized for TimescaleDB hypertables:
```sql
-- DISTINCT ON: Get only latest reading per metric (uses time index)
-- Time filter: Only last 1 hour (leverages time-based partitioning)
-- Quality filter: Only 'good' data (excludes bad/uncertain readings)
-- Limit: Max 10,000 readings (prevent memory overflow)
```

**TimescaleDB Performance Benefits**:
- Time-based partitioning: Query scans only recent chunks (1-day chunks)
- Compressed older data: Data > 7 days is compressed (10x space savings)
- Optimized indexes: `(device_uuid, time DESC)` for fast DISTINCT ON
- Native time-series: Built for high-cardinality time-series data

### Scrape Timeout

Default timeout is 10 seconds. If scraping fails with timeout:

```yaml
# Prometheus config
scrape_configs:
  - job_name: 'iotistic-endpoints'
    scrape_timeout: 30s  # Increase for large fleets
```

## Troubleshooting

### No Metrics Appear

**Check 1**: Verify endpoint is accessible:
```bash
curl http://localhost:3002/metrics
```

**Check 2**: Verify Prometheus is scraping:
```promql
# In Prometheus UI (http://localhost:9090)
up{job="iotistic-endpoints"}
```

**Check 3**: Check Prometheus targets:
- Open `http://localhost:9090/targets`
- Look for `iotistic-endpoints` job
- Status should be **UP**

### Empty Response from /metrics

**Cause**: No endpoint readings in last hour or database is empty.

**Fix**: Verify data is flowing:
```bash
# Check TimescaleDB hypertable
psql -U postgres -d iotistic -c "SELECT COUNT(*) FROM readings WHERE time > NOW() - INTERVAL '1 hour';"

# Check for good quality data
psql -U postgres -d iotistic -c "SELECT COUNT(*) FROM readings WHERE quality = 'good' AND time > NOW() - INTERVAL '1 hour';"

# Check Redis queue
redis-cli XLEN device:endpoints
```

### ServiceMonitor Not Working

**Error**: `no matches for kind 'ServiceMonitor'`

**Fix**: Install ServiceMonitor CRD:
```bash
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
```

**Verify**: Check Prometheus logs for scrape targets:
```bash
kubectl logs -n monitoring prometheus-<pod-name>
```

### Metrics Not Updating

**Cause**: Prometheus caching or scrape interval too long.

**Fix**:
1. Reduce scrape interval (30s → 15s)
2. Force refresh in Grafana (click **Refresh** icon)
3. Check timestamp: `endpoint_reading_timestamp` should be recent

### Label Too Long Error

**Error**: Prometheus rejects metrics with long labels.

**Cause**: Device name or endpoint name > 128 chars.

**Fix**: Sanitization is already applied (special chars replaced with `_`). If issue persists, truncate in query:
```sql
SUBSTRING(device_name, 1, 50) as device_name
```

## Comparison: JSON API vs Prometheus

| Feature | JSON API (`/api/v1/devices/:uuid/metrics`) | Prometheus (`/metrics`) |
|---------|---------------------------------------------|--------------------------|
| **Format** | JSON | Prometheus text |
| **Use Case** | Single device historical data | All devices real-time monitoring |
| **Grafana** | Needs JSON plugin | Native support |
| **Scraping** | Manual polling | Automatic (Prometheus) |
| **Filtering** | Query params (`period`, `limit`) | PromQL |
| **Time Range** | Custom (30min, 6h, 12h, 24h) | Last 1 hour |
| **Device Filter** | One device per request | All devices |
| **Best For** | API integrations, device details | Dashboards, alerting, multi-device |

## Example Grafana Queries

### Modbus Temperature Trend
```promql
avg_over_time(endpoint_reading{protocol="modbus",metric_name="temperature"}[5m])
```

### High Temperature Alert
```promql
endpoint_reading{metric_name="temperature"} > 50
```

### Device Uptime Percentage
```promql
avg_over_time(device_status[1h]) * 100
```

### Network Traffic Rate (SNMP)
```promql
rate(endpoint_reading{protocol="snmp",metric_name=~".*bytes.*"}[1m])
```

### Protocol Distribution
```promql
count(endpoint_reading) by (protocol)
```

## Further Reading

- [Prometheus Querying Basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Grafana Prometheus Data Source](https://grafana.com/docs/grafana/latest/datasources/prometheus/)
- [ServiceMonitor CRD Documentation](https://github.com/prometheus-operator/prometheus-operator/blob/main/Documentation/user-guides/getting-started.md)
- [PromQL Examples](https://prometheus.io/docs/prometheus/latest/querying/examples/)

