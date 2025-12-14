# Prometheus Setup Guide - Connecting to Iotistic API Metrics

## Your Current Setup

You already have:
- ✅ Prometheus Operator in `monitoring` namespace
- ✅ Grafana configured with Prometheus datasource
- ✅ API `/metrics` endpoint exposing TimescaleDB readings

## Quick Setup (Automatic Discovery)

The API already has a ServiceMonitor configured. Just verify it's enabled:

### 1. Check ServiceMonitor Configuration

```bash
# Verify ServiceMonitor is enabled in values.yaml
cat k8s/charts/iotistic/values.yaml | grep -A 5 "monitoring:"
```

Should show:
```yaml
monitoring:
  enabled: true
  interval: 30s
  scrapeTimeout: 10s
```

### 2. Deploy/Upgrade Iotistic Stack

```bash
# If using Helm
helm upgrade iotistic ./k8s/charts/iotistic -n iotistic

# Or if using kubectl
kubectl apply -f k8s/charts/iotistic/templates/servicemonitor.yaml
```

### 3. Verify ServiceMonitor is Created

```bash
kubectl get servicemonitor -n iotistic

# Should show:
# NAME             AGE
# iotistic-api     1m
```

### 4. Check Prometheus Targets

```bash
# Port-forward Prometheus UI
kubectl port-forward -n monitoring svc/prometheus 9090:9090

# Open browser: http://localhost:9090/targets
# Look for "iotistic/iotistic-api" - should show "UP"
```

### 5. Access Grafana

```bash
# Port-forward Grafana
kubectl port-forward -n monitoring svc/grafana 3000:3000

# Login: http://localhost:3000
# User: admin
# Password: admin
```

### 6. Test Prometheus Query in Grafana

1. Go to **Explore** (compass icon)
2. Select **Prometheus** datasource
3. Enter query:
```promql
endpoint_reading
```
4. Click **Run Query** - you should see your endpoint metrics!

## Manual Setup (If ServiceMonitor Doesn't Work)

If you don't have Prometheus Operator or ServiceMonitor CRD installed:

### Option A: Add Static Scrape Config to Prometheus

Create a ConfigMap with scrape config:

```yaml
# prometheus-scrape-config.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: prometheus-additional-scrape-configs
  namespace: monitoring
data:
  additional-scrape-configs.yaml: |
    - job_name: 'iotistic-api'
      scrape_interval: 30s
      scrape_timeout: 10s
      static_configs:
        - targets: ['iotistic-api.iotistic.svc:3002']
          labels:
            namespace: 'iotistic'
            service: 'api'
```

Apply it:
```bash
kubectl apply -f prometheus-scrape-config.yaml
```

Update Prometheus to use it:
```bash
# Edit Prometheus spec to include additional config
kubectl edit prometheus prometheus -n monitoring

# Add under spec:
spec:
  additionalScrapeConfigs:
    name: prometheus-additional-scrape-configs
    key: additional-scrape-configs.yaml
```

### Option B: Use Grafana Direct Datasource (No Prometheus)

If you want to bypass Prometheus and query API directly:

**Note**: This is NOT recommended - Prometheus provides better performance, caching, and query language.

1. In Grafana, go to **Configuration** → **Data Sources**
2. Click **Add data source** → Select **Prometheus**
3. Set URL: `http://iotistic-api.iotistic.svc:3002`
4. Click **Save & Test**

This will make Grafana scrape `/metrics` directly from the API.

## Troubleshooting

### ServiceMonitor Not Found

**Error**: `no matches for kind 'ServiceMonitor'`

**Fix**: Install ServiceMonitor CRD:
```bash
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
```

### Prometheus Not Discovering ServiceMonitor

**Check 1**: Verify Prometheus selector matches ServiceMonitor labels:
```bash
# Check Prometheus serviceMonitorSelector
kubectl get prometheus prometheus -n monitoring -o yaml | grep -A 5 serviceMonitorSelector

# Check ServiceMonitor labels
kubectl get servicemonitor iotistic-api -n iotistic -o yaml | grep -A 5 labels
```

**Fix**: Update ServiceMonitor labels in `values.yaml`:
```yaml
api:
  monitoring:
    labels:
      release: prometheus  # Match your Prometheus selector
```

**Check 2**: Verify Prometheus has namespace access:
```bash
# Check if Prometheus can access iotistic namespace
kubectl get prometheus prometheus -n monitoring -o yaml | grep -A 3 serviceMonitorNamespaceSelector
```

Should show:
```yaml
serviceMonitorNamespaceSelector: {}  # Empty = all namespaces
```

### Metrics Not Appearing

**Check 1**: Verify API is running and exposing metrics:
```bash
# Test /metrics endpoint
kubectl exec -it -n iotistic deployment/iotistic-api -- curl localhost:3002/metrics

# Should return Prometheus text format
```

**Check 2**: Verify data exists in TimescaleDB:
```bash
kubectl exec -it -n iotistic deployment/iotistic-postgres -- \
  psql -U postgres -d iotistic -c "SELECT COUNT(*) FROM readings WHERE time > NOW() - INTERVAL '1 hour';"
```

**Check 3**: Check Prometheus logs:
```bash
kubectl logs -n monitoring prometheus-prometheus-0 | grep -i iotistic
```

### Connection Refused / Timeout

**Check 1**: Verify service is accessible:
```bash
# From within cluster
kubectl run -it --rm debug --image=curlimages/curl --restart=Never -- \
  curl http://iotistic-api.iotistic.svc:3002/metrics
```

**Check 2**: Verify service port matches:
```bash
kubectl get svc iotistic-api -n iotistic

# Should show:
# NAME           TYPE       CLUSTER-IP      EXTERNAL-IP   PORT(S)
# iotistic-api   ClusterIP  10.43.x.x       <none>        3002/TCP
```

## Grafana Dashboard Examples

Once connected, create dashboards with these queries:

### Panel 1: Temperature Over Time
```promql
endpoint_reading{metric_name="temperature"}
```
- **Visualization**: Time Series
- **Legend**: `{{device_name}} - {{protocol}}`

### Panel 2: All Modbus Readings
```promql
endpoint_reading{protocol="modbus"}
```
- **Visualization**: Time Series
- **Legend**: `{{device_name}} - {{metric_name}}`

### Panel 3: Device Status
```promql
device_status
```
- **Visualization**: Stat
- **Thresholds**: Red < 1, Green = 1
- **Value Mappings**: 0=Offline, 1=Online

### Panel 4: SNMP Network Traffic Rate
```promql
rate(endpoint_reading{protocol="snmp",metric_name=~".*bytes.*"}[5m])
```
- **Visualization**: Time Series
- **Unit**: bytes/sec

### Panel 5: High Temperature Alert
```promql
endpoint_reading{metric_name="temperature"} > 50
```
- **Visualization**: Stat
- **Thresholds**: Orange > 50, Red > 60

## Quick Test Script

Save this as `test-prometheus-setup.sh`:

```bash
#!/bin/bash

echo "=== Testing Prometheus/Grafana Setup ==="

# Check if ServiceMonitor exists
echo -e "\n1. Checking ServiceMonitor..."
kubectl get servicemonitor -n iotistic iotistic-api &>/dev/null && \
  echo "✅ ServiceMonitor exists" || \
  echo "❌ ServiceMonitor not found"

# Check if API metrics endpoint works
echo -e "\n2. Testing API /metrics endpoint..."
kubectl exec -n iotistic deployment/iotistic-api -- curl -s localhost:3002/metrics | head -n 10 &>/dev/null && \
  echo "✅ API /metrics endpoint working" || \
  echo "❌ API /metrics endpoint failed"

# Check Prometheus targets
echo -e "\n3. Checking Prometheus targets..."
kubectl port-forward -n monitoring svc/prometheus 9090:9090 &>/dev/null &
PF_PID=$!
sleep 2
curl -s http://localhost:9090/api/v1/targets | grep -q "iotistic-api" && \
  echo "✅ Prometheus scraping API" || \
  echo "❌ Prometheus not scraping API"
kill $PF_PID 2>/dev/null

# Check if data exists
echo -e "\n4. Checking TimescaleDB data..."
kubectl exec -n iotistic deployment/iotistic-postgres -- \
  psql -U postgres -d iotistic -t -c "SELECT COUNT(*) FROM readings WHERE time > NOW() - INTERVAL '1 hour';" | \
  grep -q "[1-9]" && \
  echo "✅ Recent data exists" || \
  echo "❌ No recent data found"

echo -e "\n=== Setup Complete ==="
echo "Access Grafana: kubectl port-forward -n monitoring svc/grafana 3000:3000"
echo "Then open: http://localhost:3000 (admin/admin)"
```

Make it executable:
```bash
chmod +x test-prometheus-setup.sh
./test-prometheus-setup.sh
```

## Next Steps

1. ✅ Verify ServiceMonitor is enabled (`monitoring.enabled: true`)
2. ✅ Deploy/upgrade Helm chart
3. ✅ Check Prometheus targets (should show "UP")
4. ✅ Open Grafana and test query: `endpoint_reading`
5. ✅ Create dashboards for your modbus/SNMP endpoints

## Reference

- Prometheus UI: `http://prometheus.monitoring.svc:9090`
- Grafana UI: `http://grafana.monitoring.svc:3000`
- API Metrics: `http://iotistic-api.iotistic.svc:3002/metrics`
- ServiceMonitor: `kubectl get servicemonitor -n iotistic`

