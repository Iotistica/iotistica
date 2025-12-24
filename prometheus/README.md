# Prometheus & Grafana Monitoring Setup

This directory contains the configuration for the Iotistic Platform monitoring stack using Prometheus and Grafana.

## Overview

The monitoring stack consists of:
- **Prometheus**: Time-series database that scrapes metrics from the API's `/metrics` endpoint
- **Grafana**: Visualization and dashboarding platform for viewing metrics

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌─────────────┐
│   API       │      │  Prometheus  │      │   Grafana   │
│             │──────▶              │──────▶             │
│ /metrics    │      │   (Scraper)  │      │    (UI)     │
│ endpoint    │      │              │      │             │
└─────────────┘      └──────────────┘      └─────────────┘
     │                      │                      │
     │                      │                      │
readings_hourly         prometheus-data        grafana-data
(TimescaleDB)           (Time-series)         (Dashboards)
```

## Data Flow

1. **API Metrics**: The API exposes metrics at `http://api:3002/metrics` in Prometheus format
   - Data source: `readings_hourly` TimescaleDB continuous aggregate (optimized from 9M+ raw readings to ~7K aggregated rows)
   - Metrics: `endpoint_reading`, `endpoint_reading_timestamp`, `device_status`
   - Labels: `device_uuid`, `device_name`, `metric_name`, `protocol`, `unit`

2. **Prometheus Scraping**: Prometheus scrapes the API every 30 seconds
   - Configuration: `prometheus/prometheus.yml`
   - Storage: 30-day retention in `prometheus-data` volume
   - Targets: API, self-monitoring

3. **Grafana Visualization**: Grafana connects to Prometheus as a datasource
   - Pre-configured datasource: `http://prometheus:9090`
   - Pre-loaded dashboards in `grafana/provisioning/dashboards/`
   - Access: `http://localhost:3001` (default)

## Quick Start

1. **Start the monitoring stack**:
   ```bash
   docker-compose up -d prometheus grafana
   ```

2. **Access Grafana**:
   - URL: http://localhost:3001
   - Default credentials: admin/admin (change on first login)
   - Prometheus datasource is pre-configured

3. **Access Prometheus**:
   - URL: http://localhost:9090
   - Explore metrics at http://localhost:9090/graph
   - View targets at http://localhost:9090/targets

## Configuration

### Environment Variables

Configure the following in your `.env` file or docker-compose environment:

```bash
# Prometheus
PROMETHEUS_PORT_EXT=9090          # External port for Prometheus UI

# Grafana
GRAFANA_PORT_EXT=3001             # External port for Grafana UI (3000 might conflict with dashboard)
GRAFANA_ADMIN_USER=admin          # Grafana admin username
GRAFANA_ADMIN_PASSWORD=admin      # Grafana admin password (CHANGE THIS!)
GRAFANA_ROOT_URL=http://localhost:3001  # Grafana root URL
```

### Prometheus Configuration

Edit `prometheus/prometheus.yml` to customize:
- Scrape intervals (default: 30s)
- Retention period (default: 30 days)
- Additional scrape targets
- Alert rules (optional)

### Grafana Datasources

Datasources are auto-provisioned from `grafana/provisioning/datasources/prometheus.yml`:
- **Name**: Prometheus
- **URL**: http://prometheus:9090
- **Type**: Prometheus
- **Default**: Yes

### Grafana Dashboards

Dashboards are auto-provisioned from `grafana/provisioning/dashboards/`:
- **iotistic-overview.json**: Main platform dashboard with:
  - Device Endpoint Readings (time-series graph)
  - Device Status (gauge)
  - Devices by Protocol (pie chart)
  - Device Statistics (stats)
  - Metrics Distribution (donut chart)
  - All Device Readings (table)

To add custom dashboards:
1. Create a new `.json` dashboard file in `grafana/provisioning/dashboards/`
2. Restart Grafana: `docker-compose restart grafana`
3. Dashboard will auto-load within 10 seconds

## Available Metrics

The API exposes the following Prometheus metrics:

### endpoint_reading
**Type**: Gauge  
**Description**: Current reading value from device endpoints  
**Labels**:
- `device_uuid`: Unique device identifier
- `device_name`: Human-readable device name
- `metric_name`: Name of the metric (e.g., "temperature", "pressure")
- `protocol`: Communication protocol (e.g., "modbus", "opcua")
- `unit`: Unit of measurement (e.g., "°C", "Pa")

**Example**:
```
endpoint_reading{device_uuid="abc-123",device_name="Sensor-01",metric_name="temperature",protocol="modbus",unit="°C"} 23.5
```

### endpoint_reading_timestamp
**Type**: Gauge  
**Description**: Unix timestamp of the last reading  
**Labels**: Same as `endpoint_reading`

**Example**:
```
endpoint_reading_timestamp{device_uuid="abc-123",device_name="Sensor-01",metric_name="temperature",protocol="modbus",unit="°C"} 1705334400
```

### device_status
**Type**: Gauge  
**Description**: Device connectivity status (1 = online, 0 = offline)  
**Labels**: 
- `device_uuid`: Unique device identifier
- `device_name`: Human-readable device name

**Example**:
```
device_status{device_uuid="abc-123",device_name="Sensor-01"} 1
```

## Sample PromQL Queries

### Device Readings
```promql
# All endpoint readings
endpoint_reading

# Readings for a specific device
endpoint_reading{device_name="Sensor-01"}

# Temperature readings only
endpoint_reading{metric_name="temperature"}

# Modbus device readings
endpoint_reading{protocol="modbus"}
```

### Device Status
```promql
# All device statuses
device_status

# Count online devices
sum(device_status == 1)

# Count offline devices
sum(device_status == 0)

# Devices by protocol
count by (protocol) (endpoint_reading)
```

### Aggregations
```promql
# Average temperature across all devices
avg(endpoint_reading{metric_name="temperature"})

# Maximum pressure reading
max(endpoint_reading{metric_name="pressure"})

# Rate of change for a metric (per second)
rate(endpoint_reading{metric_name="flow"}[5m])
```

## Performance Considerations

1. **Data Source Optimization**: The API uses the `readings_hourly` TimescaleDB continuous aggregate for performance:
   - Raw table: 9M+ readings
   - Aggregate: ~7K rows
   - Significant performance improvement for queries

2. **Scrape Interval**: Default 30s balances between:
   - Data freshness
   - Database load
   - Storage requirements

3. **Retention Period**: Default 30 days:
   - Configurable in `prometheus.yml` (`--storage.tsdb.retention.time`)
   - Adjust based on storage capacity and requirements

4. **Storage Requirements**:
   - Estimate: ~1KB per sample
   - 3 metrics × 100 devices × 2,880 samples/day (30s interval) = ~860KB/day
   - 30 days ≈ 25MB for 100 devices

## Troubleshooting

### Prometheus not scraping metrics
1. Check API health: `curl http://localhost:4002/metrics`
2. Check Prometheus targets: http://localhost:9090/targets
3. Verify network connectivity: `docker exec iotistic-prometheus ping api`
4. Check Prometheus logs: `docker logs iotistic-prometheus`

### Grafana not showing data
1. Verify Prometheus datasource: Settings → Data Sources → Prometheus
2. Test datasource connection: Click "Save & Test"
3. Check Prometheus is running: `docker ps | grep prometheus`
4. Verify metrics exist: Navigate to Prometheus UI and query `endpoint_reading`

### Dashboard not loading
1. Check provisioning directory is mounted: `docker exec iotistic-grafana ls /etc/grafana/provisioning/dashboards`
2. Restart Grafana: `docker-compose restart grafana`
3. Check Grafana logs: `docker logs iotistic-grafana`

### High memory usage
1. Reduce scrape interval in `prometheus.yml` (e.g., 60s instead of 30s)
2. Reduce retention period (e.g., 15d instead of 30d)
3. Add resource limits in docker-compose.yml:
   ```yaml
   deploy:
     resources:
       limits:
         memory: 2G
   ```

## Adding Additional Exporters

To monitor additional components, uncomment the relevant sections in `prometheus/prometheus.yml`:

### Node Exporter (Host Metrics)
```yaml
# Add to docker-compose.yml
node-exporter:
  image: prom/node-exporter:latest
  container_name: node-exporter
  restart: unless-stopped
  ports:
    - "9100:9100"
  networks:
    - iotistic-net
```

### Postgres Exporter (Database Metrics)
```yaml
# Add to docker-compose.yml
postgres-exporter:
  image: prometheuscommunity/postgres-exporter:latest
  container_name: postgres-exporter
  restart: unless-stopped
  environment:
    DATA_SOURCE_NAME: "postgresql://postgres:iotistic42@postgres:5432/iotistic?sslmode=disable"
  ports:
    - "9187:9187"
  networks:
    - iotistic-net
```

### Redis Exporter (Cache Metrics)
```yaml
# Add to docker-compose.yml
redis-exporter:
  image: oliver006/redis_exporter:latest
  container_name: redis-exporter
  restart: unless-stopped
  environment:
    REDIS_ADDR: redis:6379
  ports:
    - "9121:9121"
  networks:
    - iotistic-net
```

## Security Considerations

1. **Change Default Credentials**: Update Grafana admin password on first login
2. **Network Isolation**: Keep services on the `iotistic-net` bridge network
3. **TLS/HTTPS**: Configure reverse proxy (nginx) for production deployments
4. **Authentication**: Enable Grafana OAuth or LDAP for team access
5. **Firewall**: Only expose necessary ports (3001 for Grafana, optionally 9090 for Prometheus)

## References

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Grafana Documentation](https://grafana.com/docs/)
- [PromQL Basics](https://prometheus.io/docs/prometheus/latest/querying/basics/)
- [Grafana Dashboard Best Practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
