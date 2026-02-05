# Prometheus Exporter Integration - Implementation Summary

## Overview

Successfully integrated Prometheus metrics export into the `mqtt-monitor` service, consolidating functionality from the standalone `mqtt-exporter` service.

## What Was Added

### 1. PrometheusExporter Class (`src/services/prometheus.ts`)

New TypeScript class that manages Prometheus metrics:

**Features:**
- Registry management with `prom-client`
- 20+ metrics covering broker stats, rates, topics, and monitoring health
- Histogram tracking for performance monitoring
- Label support for per-topic metrics
- Content type helper for HTTP responses

**Key Metrics:**
- **Connection**: `mqtt_monitor_connected`
- **Broker Stats**: clients, subscriptions, messages, bytes
- **Rates**: message rate (published/received), throughput (inbound/outbound)
- **Topics**: total topics, total messages, per-topic schemas
- **Monitoring**: sampling rate, degraded mode, dropped payloads
- **Performance**: metrics update duration histogram

### 2. Integration into MQTTMonitorService

**Modified Files:**
- `src/services/monitor.ts` - Main service integration
- `src/index.ts` - HTTP endpoint

**Integration Points:**
1. Constructor: Initialize `PrometheusExporter` instance
2. Connection events: Update connection status on connect/disconnect
3. Metrics calculation: Update broker metrics every 5 seconds
4. Sampling events: Record sampled messages with reason labels
5. Degraded mode: Track backpressure status

**New Public Methods:**
```typescript
async getPrometheusMetrics(): Promise<string>
getPrometheusContentType(): string
getTopicCount(): number
getMessageCount(): number
```

**Exported Interfaces:**
- `BrokerStats` - For Prometheus type definitions
- `CalculatedMetrics` - For metrics update method

### 3. HTTP Endpoint

**Route:** `GET /metrics`

**Features:**
- Returns Prometheus-formatted metrics
- Sets correct `Content-Type` header
- Error handling with 503/500 status codes
- Integrated with existing Express server (port 3500)

## Testing Results

Successfully tested with local deployment:

```
✅ Metrics endpoint accessible: http://localhost:3500/metrics
✅ Connection status: mqtt_monitor_connected 1
✅ Broker metrics: 1 client, 2 subscriptions, 53 retained messages
✅ Topic metrics: 1458 topics, 351,988 messages
✅ Performance: < 1ms metrics update duration
✅ Histogram buckets: Properly configured (0.001s to 1s)
```

## Benefits Over Standalone mqtt-exporter

1. **Consolidated Deployment**: No separate container needed
2. **Richer Metrics**: Access to internal monitor state (sampling, schemas, degraded mode)
3. **Delta-Based Rates**: More accurate calculations using 15-sample rolling window
4. **Performance Tracking**: Built-in histogram for metrics update duration
5. **Real-Time Sampling Stats**: Counter increments on every sampled message
6. **Per-Topic Metrics**: Schema version and confidence tracking

## Architecture

### Data Flow

```
MQTT Messages
    ↓
MessageCollector → MessageAggregator
    ↓                     ↓
UpdateTopicTree    recordSampledMessage()
    ↓                     ↓
CalculateMetrics → updateBrokerMetrics()
    ↓                     ↓
/metrics endpoint ← getMetrics()
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| `PrometheusExporter` | Metric definitions, updates, formatting |
| `MQTTMonitorService` | Data source, lifecycle management |
| `MessageAggregator` | Sampling event recording |
| `Express /metrics route` | HTTP exposure |

## Files Changed

### New Files
- `mqtt-monitor/src/services/prometheus.ts` (320 lines)
- `mqtt-monitor/docs/PROMETHEUS.md` (documentation)

### Modified Files
- `mqtt-monitor/package.json` (added `prom-client@^15.1.0`)
- `mqtt-monitor/src/services/monitor.ts`:
  - Imported `PrometheusExporter`
  - Exported `BrokerStats`, `CalculatedMetrics` interfaces
  - Added `prometheusExporter` field
  - Added Prometheus update calls in connection events
  - Added Prometheus update calls in metrics calculation
  - Added sampling recording in aggregator
  - Added public methods for metrics access
- `mqtt-monitor/src/index.ts`:
  - Added `GET /metrics` route
  - Added `monitorServiceInstance` global
  - Wired monitor instance to metrics endpoint

## Deployment Instructions

### 1. Install Dependencies

```bash
cd mqtt-monitor
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Start Service

```bash
npm start
```

### 4. Verify Metrics

```bash
curl http://localhost:3500/metrics
```

### 5. Configure Prometheus Scraper

```yaml
scrape_configs:
  - job_name: 'mqtt-monitor'
    scrape_interval: 15s
    static_configs:
      - targets: ['mqtt-monitor:3500']
```

## Migration from mqtt-exporter

### Breaking Changes

1. **Port Change**: 9234 → 3500
2. **Metric Names**: `mqtt_broker_connected` → `mqtt_monitor_connected`
3. **New Metrics**: Added 10+ monitor-specific metrics
4. **Per-Topic Metrics**: Now include schema version and confidence

### Migration Steps

1. Update Prometheus scrape configs (change port to 3500)
2. Update Grafana dashboards (rename metric queries)
3. Remove `mqtt-exporter` from Docker Compose / Kubernetes deployments
4. Update alerting rules with new metric names

## Performance Characteristics

- **Metrics Update**: < 1ms (tracked by histogram)
- **Memory**: Minimal overhead (~4KB per 1000 metrics)
- **Topic-Level Metrics**: Cleared and regenerated on each scrape (no memory leaks)
- **Scrape Frequency**: Safe to scrape every 15 seconds

## Next Steps

1. ✅ Implement Prometheus exporter
2. ✅ Test with local MQTT broker
3. ✅ Create documentation
4. 🔄 Update Grafana dashboards with new metrics
5. 🔄 Create example alerting rules
6. 🔄 Deploy to production environment
7. 🔄 Remove mqtt-exporter service from deployment manifests

## Example Grafana Queries

### Connection Uptime
```promql
avg_over_time(mqtt_monitor_connected[1h]) * 100
```

### Message Rate Trend
```promql
rate(mqtt_broker_messages_received_total[5m])
```

### Sampling Efficiency
```promql
rate(mqtt_monitor_sampled_messages_total[5m]) / rate(mqtt_monitor_messages_total[5m])
```

### Degraded Mode Events
```promql
changes(mqtt_monitor_degraded_mode[1h])
```

## Troubleshooting

### Issue: Metrics endpoint returns 503
**Cause**: Service not yet initialized  
**Fix**: Wait for "MQTT Monitor Service listening on..." log message

### Issue: Missing per-topic metrics
**Cause**: No active topics being monitored  
**Fix**: Verify MQTT messages are being published and captured

### Issue: High metrics_update_duration
**Cause**: Large number of topics or database contention  
**Fix**: Check `mqtt_monitor_degraded_mode`, optimize database queries

## References

- [Prometheus Metrics Documentation](docs/PROMETHEUS.md)
- [PrometheusExporter Source](src/services/prometheus.ts)
- [prom-client Library](https://github.com/siimon/prom-client)
