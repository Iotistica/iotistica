# Prometheus Metrics Exporter

The MQTT Monitor service exposes comprehensive metrics in Prometheus format for monitoring and alerting.

## Endpoint

```
GET /metrics
```

**Content-Type:** `text/plain; charset=utf-8`

## Available Metrics

### Connection Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mqtt_monitor_connected` | Gauge | MQTT broker connection status (1 = connected, 0 = disconnected) |

### Broker Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mqtt_broker_clients_connected` | Gauge | Currently connected clients |
| `mqtt_broker_subscriptions` | Gauge | Active subscriptions |
| `mqtt_broker_retained_messages` | Gauge | Retained messages count |
| `mqtt_broker_messages_sent_total` | Gauge | Total messages sent by broker |
| `mqtt_broker_messages_received_total` | Gauge | Total messages received by broker |
| `mqtt_broker_bytes_sent_total` | Gauge | Total bytes sent by broker |
| `mqtt_broker_bytes_received_total` | Gauge | Total bytes received by broker |

### Rate Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mqtt_broker_message_rate_published` | Gauge | Current message rate published (messages/second) |
| `mqtt_broker_message_rate_received` | Gauge | Current message rate received (messages/second) |
| `mqtt_broker_throughput_inbound_kbps` | Gauge | Current inbound throughput (KB/sec) |
| `mqtt_broker_throughput_outbound_kbps` | Gauge | Current outbound throughput (KB/sec) |

### Topic Tree Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mqtt_monitor_topics_total` | Gauge | Total number of topics being monitored |
| `mqtt_monitor_messages_total` | Gauge | Total number of messages processed |

### Monitoring Service Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `mqtt_monitor_sampled_messages_total` | Counter | Total number of sampled messages (rate-limited) | `reason` (rate_limit, degraded_mode) |
| `mqtt_monitor_degraded_mode` | Gauge | Degraded mode status (1 = active, 0 = normal) | - |
| `mqtt_monitor_dropped_payloads_total` | Counter | Total number of dropped payloads due to backpressure | - |

### Topic-Level Metrics

| Metric | Type | Description | Labels |
|--------|------|-------------|--------|
| `mqtt_topic_messages_total` | Counter | Total messages per topic | `topic`, `message_type` |
| `mqtt_topic_bytes_total` | Counter | Total bytes per topic | `topic` |
| `mqtt_topic_schema_version` | Gauge | Schema version for JSON topics | `topic` |
| `mqtt_topic_schema_confidence` | Gauge | Schema confidence (0-1) based on stability | `topic` |

### Performance Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `mqtt_monitor_metrics_update_duration_seconds` | Histogram | Duration of metrics update operations |

## Usage Examples

### Prometheus Scrape Configuration

```yaml
scrape_configs:
  - job_name: 'mqtt-monitor'
    scrape_interval: 15s
    static_configs:
      - targets: ['mqtt-monitor:3500']
```

### Sample cURL Request

```bash
curl http://localhost:3500/metrics
```

### Sample Output

```
# HELP mqtt_monitor_connected MQTT broker connection status (1 = connected, 0 = disconnected)
# TYPE mqtt_monitor_connected gauge
mqtt_monitor_connected 1

# HELP mqtt_broker_clients_connected Currently connected clients
# TYPE mqtt_broker_clients_connected gauge
mqtt_broker_clients_connected 1

# HELP mqtt_broker_message_rate_published Current message rate published (messages/second)
# TYPE mqtt_broker_message_rate_published gauge
mqtt_broker_message_rate_published 42

# HELP mqtt_monitor_topics_total Total number of topics being monitored
# TYPE mqtt_monitor_topics_total gauge
mqtt_monitor_topics_total 1458

# HELP mqtt_monitor_sampled_messages_total Total number of sampled messages (rate-limited)
# TYPE mqtt_monitor_sampled_messages_total counter
mqtt_monitor_sampled_messages_total{reason="rate_limit"} 12453
```

## Grafana Dashboard

### Example Queries

**Connection Status:**
```promql
mqtt_monitor_connected
```

**Message Rate:**
```promql
rate(mqtt_broker_messages_received_total[5m])
```

**Throughput:**
```promql
mqtt_broker_throughput_inbound_kbps
```

**Active Topics:**
```promql
mqtt_monitor_topics_total
```

**Sampling Rate:**
```promql
rate(mqtt_monitor_sampled_messages_total[5m])
```

**Degraded Mode Status:**
```promql
mqtt_monitor_degraded_mode
```

### Sample Dashboard Panels

#### 1. Connection Status (Single Stat)
- Query: `mqtt_monitor_connected`
- Thresholds: 0 = red, 1 = green

#### 2. Message Rate (Graph)
- Query: `mqtt_broker_message_rate_published` and `mqtt_broker_message_rate_received`
- Legend: Published vs Received

#### 3. Throughput (Graph)
- Query: `mqtt_broker_throughput_inbound_kbps` and `mqtt_broker_throughput_outbound_kbps`
- Legend: Inbound vs Outbound

#### 4. Active Topics (Single Stat)
- Query: `mqtt_monitor_topics_total`

#### 5. Sampling Activity (Graph)
- Query: `rate(mqtt_monitor_sampled_messages_total[5m])`
- Legend by reason: `rate_limit` vs `degraded_mode`

#### 6. System Health (Table)
- Queries:
  - `mqtt_broker_clients_connected`
  - `mqtt_broker_subscriptions`
  - `mqtt_monitor_degraded_mode`

## Alerting Rules

### Connection Loss Alert

```yaml
groups:
  - name: mqtt_monitor
    rules:
      - alert: MQTTBrokerDisconnected
        expr: mqtt_monitor_connected == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "MQTT Monitor disconnected from broker"
          description: "MQTT Monitor has been disconnected for more than 1 minute"
```

### High Sampling Rate Alert

```yaml
- alert: HighMQTTSamplingRate
  expr: rate(mqtt_monitor_sampled_messages_total[5m]) > 100
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "High MQTT message sampling rate"
    description: "MQTT Monitor is sampling {{ $value }} messages/sec (indicates high message volume)"
```

### Degraded Mode Alert

```yaml
- alert: MQTTMonitorDegradedMode
  expr: mqtt_monitor_degraded_mode == 1
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "MQTT Monitor in degraded mode"
    description: "MQTT Monitor has entered degraded mode due to high load"
```

## Performance Considerations

### Metric Update Frequency

- **Broker metrics**: Updated every 5 seconds (configurable via `MQTT_METRICS_UPDATE_INTERVAL`)
- **Topic tree metrics**: Updated every 5 seconds (configurable via `MQTT_TOPIC_TREE_UPDATE_INTERVAL`)
- **Sampling counters**: Updated in real-time as messages are sampled

### Memory Impact

- Topic-level metrics (`mqtt_topic_*`) are **cleared and regenerated** on each scrape to avoid memory leaks
- Only topics with active messages are included in metrics
- Schema metrics are only exported for JSON topics

### Scrape Performance

- Metrics generation is typically < 1ms (tracked by `mqtt_monitor_metrics_update_duration_seconds`)
- Safe to scrape every 15 seconds
- No blocking operations during metrics export

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MQTT_METRICS_UPDATE_INTERVAL` | 5000 | How often to recalculate broker metrics (ms) |
| `MQTT_TOPIC_TREE_UPDATE_INTERVAL` | 5000 | How often to update topic tree (ms) |
| `MQTT_EVENT_LOOP_LAG_THRESHOLD` | 100 | Event loop lag threshold for degraded mode (ms) |

## Architecture

### PrometheusExporter Class

Located in `src/services/prometheus.ts`, this class:

1. Creates a Prometheus registry with all metric definitions
2. Provides methods to update metrics from monitor data
3. Exposes formatted metrics via `getMetrics()` method
4. Integrates with `MQTTMonitorService` lifecycle

### Integration Points

- **Connection events**: Updates `mqtt_monitor_connected` on connect/disconnect
- **Metrics calculation**: Updates broker/rate metrics every 5 seconds
- **Sampling events**: Increments `mqtt_monitor_sampled_messages_total` on rate limiting
- **Degraded mode**: Updates `mqtt_monitor_degraded_mode` on backpressure

### Data Flow

```
MQTT Messages
    ↓
MessageCollector → MessageAggregator → (sampling decision)
    ↓                                        ↓
UpdateTopicTree                    PrometheusExporter.recordSampledMessage()
    ↓
CalculateMetrics → PrometheusExporter.updateBrokerMetrics()
    ↓
/metrics endpoint → PrometheusExporter.getMetrics()
```

## Migration from mqtt-exporter

This Prometheus integration **replaces** the standalone `mqtt-exporter` service. Benefits:

1. **Consolidated deployment**: No separate exporter container needed
2. **Richer metrics**: Access to all monitor internal state (sampling, schemas, degraded mode)
3. **Delta-based rates**: More accurate message/throughput rates using 15-sample rolling window
4. **Performance metrics**: Histogram of metrics update duration

### Breaking Changes

- Port changed from 9234 (mqtt-exporter) to 3500 (mqtt-monitor)
- Metric names updated (e.g., `mqtt_broker_connected` → `mqtt_monitor_connected`)
- Added per-topic metrics with labels
- Added monitoring-specific metrics (sampling, degraded mode)

## Troubleshooting

### Metrics endpoint returns 503

**Issue**: Service not yet initialized

**Solution**: Wait for log message "MQTT Monitor Service listening on..."

### Missing topic-level metrics

**Issue**: No active topics being monitored

**Solution**: Verify topics are being published to and captured by monitor

### High metrics update duration

**Issue**: `mqtt_monitor_metrics_update_duration_seconds` histogram shows slow updates

**Solution**: Check for:
- Large number of topics (>10,000)
- Database sync contention
- Event loop lag (check `mqtt_monitor_degraded_mode`)

### Stale metrics after topic deletion

**Issue**: Topic-level metrics show deleted topics

**Solution**: Topic metrics are cleared on each scrape. If stale metrics persist, check Prometheus retention settings.

## References

- [Prometheus Exposition Formats](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/naming/)
- [prom-client Library](https://github.com/siimon/prom-client)
- [Grafana Prometheus Integration](https://grafana.com/docs/grafana/latest/datasources/prometheus/)
