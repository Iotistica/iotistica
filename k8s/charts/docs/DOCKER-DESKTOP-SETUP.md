# Docker Desktop K8s - Validated Installation Steps

This document contains the **exact steps tested and validated** on Docker Desktop Kubernetes.

## Prerequisites

- ✅ Docker Desktop with Kubernetes enabled
- ✅ kubectl installed and configured
- ❌ Helm NOT required (all steps use kubectl)

## Step-by-Step Installation

### 1. Install ServiceMonitor CRD (REQUIRED)

```powershell
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml

# Verify
kubectl get crd servicemonitors.monitoring.coreos.com
```

**Why**: Customer deployments fail without this CRD.

---

### 2. Install Prometheus Operator Stack

```powershell
# Create monitoring namespace
kubectl create namespace monitoring

# Install Prometheus Operator
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/bundle.yaml

# Install Prometheus CRD
kubectl apply --server-side -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_prometheuses.yaml

# Restart operator to detect new CRDs
kubectl rollout restart deployment prometheus-operator -n default

# Wait 10 seconds
Start-Sleep -Seconds 10
```

---

### 3. Deploy Prometheus & Grafana

```powershell
# Apply monitoring stack
kubectl apply -f c:\Users\Dan\zemfyre-sensor\charts\monitoring-stack.yaml

# Wait for pods to start
Start-Sleep -Seconds 15

# Verify
kubectl get pods -n monitoring
```

**Expected Output**:
```
NAME                       READY   STATUS    RESTARTS   AGE
grafana-7675c654b4-qf4nm   1/1     Running   0          2m
prometheus-prometheus-0    2/2     Running   0          2m
```

---

### 4. Access Grafana

```powershell
# Port-forward Grafana
kubectl port-forward -n monitoring svc/grafana 3000:3000
```

**Open**: http://localhost:3000  
**Credentials**: admin/admin

---

### 5. Deploy Customer Instance (via Billing API)

```powershell
# Make sure billing service is running
cd c:\Users\Dan\zemfyre-sensor\billing
npm run dev

# In another terminal, trigger signup
curl -X POST http://localhost:3100/api/customers/signup `
  -H "Content-Type: application/json" `
  -d '{
    "email": "test@example.com",
    "password": "Pass123!",
    "company_name": "Test Corp"
  }'

# Check deployment
kubectl get pods -A | Select-String customer
```

---

### 6. View Customer Metrics in Grafana

1. Open Grafana: http://localhost:3000
2. Login: admin/admin
3. Navigate: **Explore** (compass icon)
4. Select datasource: **Prometheus**
5. Query examples:

```promql
# All customer metrics
{namespace="customer-aff0bb68"}

# API metrics
up{job="customer-aff0bb68-api"}

# MQTT metrics
{job="customer-aff0bb68-mosquitto"}

# PostgreSQL metrics
{job="customer-aff0bb68-postgres"}
```

---

## Troubleshooting

### Prometheus Not Creating Pods

**Symptom**: `kubectl get pods -n monitoring` doesn't show `prometheus-prometheus-0`

**Fix**:
```powershell
# Restart the operator
kubectl rollout restart deployment prometheus-operator -n default

# Wait and check
Start-Sleep -Seconds 10
kubectl get pods -n monitoring
```

### ServiceMonitor CRD Missing Error

**Symptom**: Customer deployment fails with "no matches for kind 'ServiceMonitor'"

**Fix**:
```powershell
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml
```

### Grafana Shows No Data

**Check**:
1. Prometheus is scraping: http://localhost:9090/targets
2. ServiceMonitor exists: `kubectl get servicemonitor -n customer-xxx`
3. Customer pods are running: `kubectl get pods -n customer-xxx`

---

## Verification Checklist

- [ ] ServiceMonitor CRD installed
- [ ] Prometheus Operator running (in `default` namespace)
- [ ] Prometheus pod running (2/2 in `monitoring` namespace)
- [ ] Grafana pod running (1/1 in `monitoring` namespace)
- [ ] Customer namespace deployed
- [ ] Customer ServiceMonitor created
- [ ] Grafana accessible at http://localhost:3000
- [ ] Customer metrics visible in Grafana Explore

---

## Quick Commands Reference

```powershell
# Check all resources
kubectl get all -n monitoring
kubectl get all -n customer-aff0bb68

# View logs
kubectl logs -n default deployment/prometheus-operator
kubectl logs -n monitoring prometheus-prometheus-0 -c prometheus

# Port-forward services
kubectl port-forward -n monitoring svc/grafana 3000:3000
kubectl port-forward -n monitoring svc/prometheus 9090:9090

# Delete and retry
kubectl delete -f c:\Users\Dan\zemfyre-sensor\charts\monitoring-stack.yaml
kubectl apply -f c:\Users\Dan\zemfyre-sensor\charts\monitoring-stack.yaml
```

---

## Files Created

- `charts/monitoring-stack.yaml` - Prometheus + Grafana deployment manifest
- `charts/cluster-setup.ps1` - Automated setup script (updated)
- `charts/README.md` - Complete documentation (updated)

---

## Production Notes

For production Kubernetes clusters (not Docker Desktop):

1. **Storage**: Update PVC storage class in `monitoring-stack.yaml`
2. **Ingress**: Add Ingress resources for Grafana/Prometheus
3. **TLS**: Enable cert-manager for HTTPS
4. **Auth**: Configure OAuth/LDAP for Grafana
5. **Retention**: Adjust Prometheus retention from 30d based on needs
6. **Resources**: Increase CPU/memory limits for production load

---

**Last Validated**: October 23, 2025  
**Environment**: Docker Desktop 4.x with Kubernetes 1.32.3  
**Tested By**: Dan  
**Status**: ✅ Working
