# Azure AKS Deployment Guide for Iotistic

Complete guide for deploying the Iotistic platform to Azure Kubernetes Service (AKS).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Option 1: Quick Start (All-in-K8s)](#option-1-quick-start-all-in-k8s)
- [Option 2: Hybrid (Azure PaaS + K8s)](#option-2-hybrid-azure-paas--k8s)
- [Post-Deployment](#post-deployment)
- [Monitoring & Observability](#monitoring--observability)
- [Security Hardening](#security-hardening)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

### 1. Azure CLI

```bash
# Install Azure CLI
# Windows (PowerShell):
winget install -e --id Microsoft.AzureCLI

# Or download from: https://aka.ms/installazurecliwindows

# Login to Azure
az login

# Set subscription
az account set --subscription "YOUR_SUBSCRIPTION_ID"
```

### 2. kubectl

```bash
# Windows (PowerShell):
winget install -e --id Kubernetes.kubectl

# Verify installation
kubectl version --client
```

### 3. Helm

```bash
# Windows (PowerShell):
winget install -e --id Helm.Helm

# Verify installation
helm version
```

### 4. Azure Container Registry (ACR)

```bash
# Create resource group
az group create --name iotistic-rg --location eastus

# Create ACR
az acr create --resource-group iotistic-rg \
  --name iotisticacr \
  --sku Standard

# Login to ACR
az acr login --name iotisticacr
```

### 5. Build and Push Images

```bash
# Build and push API image
cd api
docker build -t iotisticacr.azurecr.io/iotistic/api:v1.0.0 .
docker push iotisticacr.azurecr.io/iotistic/api:v1.0.0

# Build and push Dashboard image
cd ../dashboard
docker build -t iotisticacr.azurecr.io/iotistic/dashboard:v1.0.0 .
docker push iotisticacr.azurecr.io/iotistic/dashboard:v1.0.0

# Update values-aks.yaml with ACR registry
# api.image.repository: iotisticacr.azurecr.io/iotistic/api
# dashboard.image.repository: iotisticacr.azurecr.io/iotistic/dashboard
```

---

## Option 1: Quick Start (All-in-K8s)

Deploy everything in Kubernetes (PostgreSQL, Redis, Mosquitto as containers).

### Step 1: Create AKS Cluster

```bash
# Create AKS cluster with recommended settings
az aks create \
  --resource-group iotistic-rg \
  --name iotistic-aks \
  --node-count 3 \
  --node-vm-size Standard_D4s_v3 \
  --enable-addons monitoring \
  --enable-managed-identity \
  --network-plugin azure \
  --network-policy azure \
  --zones 1 2 3 \
  --enable-cluster-autoscaler \
  --min-count 3 \
  --max-count 10 \
  --attach-acr iotisticacr

# Get credentials
az aks get-credentials --resource-group iotistic-rg --name iotistic-aks
```

**Cluster Specs Explained:**
- `Standard_D4s_v3`: 4 vCPUs, 16GB RAM (good for moderate workloads)
- `--zones 1 2 3`: High availability across availability zones
- `--enable-cluster-autoscaler`: Auto-scale nodes based on demand
- `--attach-acr`: Direct ACR integration (no imagePullSecrets needed)

### Step 2: Install NGINX Ingress Controller

```bash
# Add NGINX Ingress Helm repo
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update

# Install NGINX Ingress
helm install nginx-ingress ingress-nginx/ingress-nginx \
  --namespace ingress-nginx \
  --create-namespace \
  --set controller.service.type=LoadBalancer \
  --set controller.service.annotations."service\.beta\.kubernetes\.io/azure-load-balancer-health-probe-request-path"=/healthz
```

**Get Ingress External IP:**
```bash
kubectl get svc -n ingress-nginx nginx-ingress-ingress-nginx-controller
# Wait for EXTERNAL-IP (Azure Load Balancer provisioning takes ~2 min)
```

### Step 3: Install cert-manager (for SSL)

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.13.0/cert-manager.yaml

# Wait for cert-manager to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=cert-manager -n cert-manager --timeout=300s

# Create Let's Encrypt ClusterIssuer
cat <<EOF | kubectl apply -f -
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: your-email@example.com  # CHANGE THIS
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: nginx
EOF
```

### Step 4: Update values-aks.yaml

```bash
cd k8s/charts/iotistic

# Edit values-aks.yaml:
# 1. Update image repositories to ACR:
#    api.image.repository: iotisticacr.azurecr.io/iotistic/api
#    dashboard.image.repository: iotisticacr.azurecr.io/iotistic/dashboard
#
# 2. Update image tags:
#    api.image.tag: v1.0.0
#    dashboard.image.tag: v1.0.0
#
# 3. Set strong PostgreSQL password:
#    postgres.password: "YOUR_STRONG_PASSWORD_HERE"
#
# 4. Update ingress host:
#    ingress.host: iotistic.yourdomain.com
#
# 5. Update cert-manager email in ClusterIssuer (above)
```

### Step 5: Deploy Iotistic

```bash
# Install Helm chart
helm install iotistic . \
  --namespace iotistic \
  --create-namespace \
  -f values-aks.yaml

# Wait for all pods to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=iotistic -n iotistic --timeout=600s

# Check deployment status
kubectl get pods -n iotistic
kubectl get svc -n iotistic
kubectl get ingress -n iotistic
```

### Step 6: Configure DNS

```bash
# Get Ingress Controller's External IP
INGRESS_IP=$(kubectl get svc -n ingress-nginx nginx-ingress-ingress-nginx-controller -o jsonpath='{.status.loadBalancer.ingress[0].ip}')

echo "Configure DNS A record:"
echo "iotistic.yourdomain.com -> $INGRESS_IP"
```

**DNS Configuration:**
- Go to your DNS provider (Azure DNS, Cloudflare, etc.)
- Add A record: `iotistic.yourdomain.com` → `<INGRESS_IP>`
- Wait for DNS propagation (~5-10 minutes)

### Step 7: Verify Deployment

```bash
# Check certificate (may take 2-3 minutes to provision)
kubectl get certificate -n iotistic

# Access application
echo "Dashboard: https://iotistic.yourdomain.com"
echo "API: https://iotistic.yourdomain.com/api"

# Test API health
curl https://iotistic.yourdomain.com/api/health
```

---

## Option 2: Hybrid (Azure PaaS + K8s)

Use Azure managed services (recommended for production).

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│ AKS Cluster (Compute Layer)                             │
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│ │     API     │  │  Dashboard  │  │  Mosquitto  │     │
│ └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────────────────────────────────┘
         │                    │                 │
         ▼                    ▼                 ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│ Azure Database   │  │ Azure Cache      │  │ Azure Key Vault  │
│ for PostgreSQL   │  │ for Redis        │  │ (Secrets)        │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

### Benefits

- ✅ **Fully managed**: No database/cache maintenance
- ✅ **Auto backups**: Point-in-time restore
- ✅ **High availability**: Built-in replication
- ✅ **Auto scaling**: Elastic compute resources
- ✅ **Security**: Private endpoints, encryption at rest
- ✅ **Cost**: Pay-per-use, reserved pricing available

### Step 1: Create Azure Database for PostgreSQL

```bash
# Create PostgreSQL server
az postgres flexible-server create \
  --resource-group iotistic-rg \
  --name iotistic-postgres \
  --location eastus \
  --admin-user iotisticadmin \
  --admin-password "YOUR_STRONG_PASSWORD" \
  --sku-name Standard_D4s_v3 \
  --tier GeneralPurpose \
  --storage-size 128 \
  --version 16 \
  --high-availability Enabled \
  --zone 1

# Create database
az postgres flexible-server db create \
  --resource-group iotistic-rg \
  --server-name iotistic-postgres \
  --database-name iotistic

# Configure firewall (allow AKS subnet)
az postgres flexible-server firewall-rule create \
  --resource-group iotistic-rg \
  --name iotistic-postgres \
  --rule-name AllowAKS \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 255.255.255.255
  # IMPORTANT: Restrict to AKS subnet CIDR in production!

# Get connection string
az postgres flexible-server show \
  --resource-group iotistic-rg \
  --name iotistic-postgres \
  --query "fullyQualifiedDomainName" -o tsv
# Output: iotistic-postgres.postgres.database.azure.com
```

### Step 2: Create Azure Cache for Redis

```bash
# Create Redis cache
az redis create \
  --resource-group iotistic-rg \
  --name iotistic-redis \
  --location eastus \
  --sku Standard \
  --vm-size c1 \
  --enable-non-ssl-port false

# Get connection details
az redis show \
  --resource-group iotistic-rg \
  --name iotistic-redis \
  --query "{hostname:hostName,port:sslPort}" -o json

# Get access keys
az redis list-keys \
  --resource-group iotistic-rg \
  --name iotistic-redis \
  --query "primaryKey" -o tsv
```

### Step 3: Create Azure Key Vault (for secrets)

```bash
# Create Key Vault
az keyvault create \
  --resource-group iotistic-rg \
  --name iotistic-kv \
  --location eastus \
  --enable-rbac-authorization false

# Store secrets
az keyvault secret set \
  --vault-name iotistic-kv \
  --name postgres-password \
  --value "YOUR_POSTGRES_PASSWORD"

az keyvault secret set \
  --vault-name iotistic-kv \
  --name redis-password \
  --value "YOUR_REDIS_PRIMARY_KEY"

# Enable AKS to access Key Vault
az aks enable-addons \
  --resource-group iotistic-rg \
  --name iotistic-aks \
  --addons azure-keyvault-secrets-provider
```

### Step 4: Configure Helm Values for PaaS

Create `values-aks-paas.yaml`:

```yaml
# Disable in-cluster databases
postgres:
  enabled: false

redis:
  enabled: false

# API configuration with Azure PaaS
api:
  image:
    repository: iotisticacr.azurecr.io/iotistic/api
    tag: v1.0.0
  replicas: 3
  env:
    # PostgreSQL connection
    DB_HOST: iotistic-postgres.postgres.database.azure.com
    DB_PORT: "5432"
    DB_NAME: iotistic
    DB_USER: iotisticadmin
    DB_PASSWORD: "YOUR_POSTGRES_PASSWORD"  # Or use Key Vault CSI
    DB_SSL: "true"
    
    # Redis connection
    REDIS_HOST: iotistic-redis.redis.cache.windows.net
    REDIS_PORT: "6380"
    REDIS_PASSWORD: "YOUR_REDIS_KEY"  # Or use Key Vault CSI
    REDIS_TLS: "true"

dashboard:
  image:
    repository: iotisticacr.azurecr.io/iotistic/dashboard
    tag: v1.0.0
  replicas: 2

mosquitto:
  enabled: true  # Keep Mosquitto in K8s
  serviceType: LoadBalancer

ingress:
  enabled: true
  className: nginx
  host: iotistic.yourdomain.com
  tls:
    enabled: true
```

### Step 5: Deploy with PaaS

```bash
helm install iotistic . \
  --namespace iotistic \
  --create-namespace \
  -f values-aks-paas.yaml
```

---

## Post-Deployment

### 1. Configure Horizontal Pod Autoscaler (HPA)

```bash
# Enable metrics server (if not already enabled)
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml

# Create HPA for API
kubectl autoscale deployment iotistic-api \
  --namespace iotistic \
  --cpu-percent=70 \
  --min=2 \
  --max=10

# Create HPA for Dashboard
kubectl autoscale deployment iotistic-dashboard \
  --namespace iotistic \
  --cpu-percent=70 \
  --min=2 \
  --max=5

# Check HPA status
kubectl get hpa -n iotistic
```

### 2. Configure Pod Disruption Budgets (PDB)

```bash
cat <<EOF | kubectl apply -f -
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: iotistic-api-pdb
  namespace: iotistic
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/component: api
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: iotistic-dashboard-pdb
  namespace: iotistic
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app.kubernetes.io/component: dashboard
EOF
```

### 3. Configure Pod Anti-Affinity (spread across zones)

Add to `values-aks.yaml`:

```yaml
api:
  affinity:
    podAntiAffinity:
      preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          labelSelector:
            matchExpressions:
            - key: app.kubernetes.io/component
              operator: In
              values:
              - api
          topologyKey: topology.kubernetes.io/zone
```

---

## Monitoring & Observability

### 1. Azure Monitor Container Insights

```bash
# Enable Container Insights (if not already enabled)
az aks enable-addons \
  --resource-group iotistic-rg \
  --name iotistic-aks \
  --addons monitoring

# View logs in Azure Portal:
# AKS cluster → Monitoring → Insights → Containers
```

### 2. Install Prometheus + Grafana

```bash
# Add Prometheus Community Helm repo
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update

# Install kube-prometheus-stack
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  --set prometheus.prometheusSpec.serviceMonitorSelectorNilUsesHelmValues=false

# Access Grafana
kubectl port-forward -n monitoring svc/prometheus-grafana 3000:80

# Get Grafana admin password
kubectl get secret -n monitoring prometheus-grafana -o jsonpath="{.data.admin-password}" | base64 --decode
```

### 3. Application Insights Integration

```bash
# Create Application Insights
az monitor app-insights component create \
  --app iotistic-appinsights \
  --location eastus \
  --resource-group iotistic-rg \
  --application-type web

# Get instrumentation key
az monitor app-insights component show \
  --app iotistic-appinsights \
  --resource-group iotistic-rg \
  --query "instrumentationKey" -o tsv

# Add to values-aks.yaml:
# api.env.APPINSIGHTS_INSTRUMENTATIONKEY: "<instrumentation-key>"
```

---

## Security Hardening

### 1. Enable Azure AD Integration

```bash
# Enable Azure AD integration
az aks update \
  --resource-group iotistic-rg \
  --name iotistic-aks \
  --enable-aad \
  --aad-admin-group-object-ids <your-admin-group-id>
```

### 2. Enable Pod Security Standards

```bash
# Apply Pod Security Standards
kubectl label namespace iotistic \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/audit=restricted \
  pod-security.kubernetes.io/warn=restricted
```

### 3. Network Policies

Ensure `networkPolicy.enabled: true` in `values-aks.yaml`.

### 4. Use Azure Key Vault for Secrets

See Option 2 (Hybrid) for Key Vault integration.

---

## Troubleshooting

### Pods Not Starting

```bash
# Check pod status
kubectl get pods -n iotistic

# Describe pod for events
kubectl describe pod <pod-name> -n iotistic

# Check logs
kubectl logs <pod-name> -n iotistic

# Common issues:
# - Image pull errors: Check ACR integration
# - CrashLoopBackOff: Check application logs
# - Pending: Check resource quotas and node capacity
```

### Database Connection Issues

```bash
# Test PostgreSQL connection from pod
kubectl run -it --rm psql-test --image=postgres:16-alpine --restart=Never -- \
  psql -h iotistic-postgres.postgres.database.azure.com \
       -U iotisticadmin \
       -d iotistic

# Check firewall rules
az postgres flexible-server firewall-rule list \
  --resource-group iotistic-rg \
  --name iotistic-postgres
```

### SSL Certificate Not Provisioning

```bash
# Check certificate status
kubectl describe certificate -n iotistic

# Check cert-manager logs
kubectl logs -n cert-manager deployment/cert-manager -f

# Common issues:
# - DNS not propagated yet (wait 10-15 minutes)
# - Ingress not routing correctly
# - Let's Encrypt rate limits (5 certificates per domain per week)
```

### Ingress Not Working

```bash
# Check ingress status
kubectl get ingress -n iotistic

# Check NGINX Ingress logs
kubectl logs -n ingress-nginx deployment/nginx-ingress-ingress-nginx-controller -f

# Test from inside cluster
kubectl run -it --rm curl-test --image=curlimages/curl --restart=Never -- \
  curl -v http://iotistic-api:3002/health
```

---

## Cost Optimization

### 1. Use Spot VMs for Dev/Test

```bash
# Create node pool with Spot VMs
az aks nodepool add \
  --resource-group iotistic-rg \
  --cluster-name iotistic-aks \
  --name spotpool \
  --priority Spot \
  --eviction-policy Delete \
  --spot-max-price -1 \
  --node-count 2 \
  --min-count 1 \
  --max-count 5 \
  --enable-cluster-autoscaler

# Label pods to use spot pool
kubectl label deployment iotistic-api node-pool=spot -n iotistic
```

### 2. Enable Cluster Autoscaler

Already enabled in cluster creation. Adjust min/max:

```bash
az aks nodepool update \
  --resource-group iotistic-rg \
  --cluster-name iotistic-aks \
  --name nodepool1 \
  --min-count 2 \
  --max-count 10
```

### 3. Use Reserved Instances

For production workloads with predictable usage, purchase Azure Reserved VM Instances (1 or 3 year commitment) for up to 72% savings.

---

## Useful Commands

```bash
# Get cluster credentials
az aks get-credentials --resource-group iotistic-rg --name iotistic-aks

# Scale deployment
kubectl scale deployment iotistic-api --replicas=5 -n iotistic

# Restart deployment
kubectl rollout restart deployment/iotistic-api -n iotistic

# View resource usage
kubectl top nodes
kubectl top pods -n iotistic

# Upgrade Helm chart
helm upgrade iotistic . -f values-aks.yaml --namespace iotistic

# Uninstall
helm uninstall iotistic --namespace iotistic
kubectl delete namespace iotistic

# Delete AKS cluster (WARNING: destructive)
az aks delete --resource-group iotistic-rg --name iotistic-aks --yes --no-wait
```

---

## Next Steps

1. **Set up CI/CD**: Use Azure DevOps or GitHub Actions for automated deployments
2. **Configure Backups**: Use Azure Backup for persistent data
3. **Set up Alerts**: Configure Azure Monitor alerts for critical metrics
4. **Performance Testing**: Use Azure Load Testing to validate performance
5. **Disaster Recovery**: Set up geo-replication and backup strategies

---

## Support & Resources

- [AKS Documentation](https://docs.microsoft.com/en-us/azure/aks/)
- [Azure Database for PostgreSQL](https://docs.microsoft.com/en-us/azure/postgresql/)
- [Azure Cache for Redis](https://docs.microsoft.com/en-us/azure/azure-cache-for-redis/)
- [NGINX Ingress Controller](https://kubernetes.github.io/ingress-nginx/)
- [cert-manager](https://cert-manager.io/docs/)

---

**Copyright © 2025 Iotistic Team**
