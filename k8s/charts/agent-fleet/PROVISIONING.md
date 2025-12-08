# Agent Fleet Provisioning Guide

Complete guide for provisioning agent fleets with API-based registration.

## Overview

Each agent in the fleet must register with the cloud API using a unique provisioning key. The provisioning flow:

1. **Generate Keys**: Use API to generate N provisioning keys for the fleet
2. **Create Secret**: Store keys in Kubernetes Secret (indexed by pod ordinal)
3. **Deploy Fleet**: Helm chart deploys StatefulSet, each pod gets its provisioning key
4. **Agent Registration**: On startup, agent reads `PROVISIONING_KEY_{index}` and registers with API

## Provisioning API

### Endpoint

```
POST /api/v1/provisioning-keys/generate
```

### Request Body

```json
{
  "fleetId": "k8s-fleet-production",
  "newKey": false,
  "metadata": {
    "index": 0,
    "environment": "production",
    "cluster": "us-east-1"
  }
}
```

### Response

```json
{
  "key": "pvk_abc123def456...",
  "fleetId": "k8s-fleet-production",
  "expiresAt": "2025-12-31T23:59:59Z",
  "metadata": {
    "index": 0
  }
}
```

### Parameters

- **fleetId**: Fleet identifier (groups agents logically)
- **newKey**: `false` = reuse fleet keys, `true` = generate new keys each time
- **metadata**: Optional metadata attached to the provisioning record

## Step 1: Generate Provisioning Keys

### Using Bash Script

```bash
# Basic usage (10 keys)
./scripts/generate-provisioning-keys.sh 10

# With custom API and fleet
./scripts/generate-provisioning-keys.sh \
  100 \
  https://api.iotistic.com \
  k8s-fleet-production \
  $AUTH_TOKEN > keys.env

# Keys are output in format:
# PROVISIONING_KEY_0=pvk_abc123...
# PROVISIONING_KEY_1=pvk_def456...
# PROVISIONING_KEY_2=pvk_ghi789...
```

### Using PowerShell Script

```powershell
# Basic usage (10 keys)
.\scripts\generate-provisioning-keys.ps1 -Count 10

# With custom API and fleet
.\scripts\generate-provisioning-keys.ps1 `
  -Count 100 `
  -ApiUrl "https://api.iotistic.com" `
  -FleetId "k8s-fleet-production" `
  -AuthToken $env:AUTH_TOKEN | Out-File -Encoding utf8 keys.env

# Check output
Get-Content keys.env
```

### Manual API Calls

```bash
# Generate single key
curl -X POST https://api.iotistic.com/api/v1/provisioning-keys/generate \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fleetId": "k8s-fleet-production",
    "newKey": false,
    "metadata": {"index": 0}
  }'

# Generate multiple keys with loop
for i in {0..99}; do
  echo -n "PROVISIONING_KEY_$i="
  curl -s -X POST https://api.iotistic.com/api/v1/provisioning-keys/generate \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"fleetId\": \"k8s-fleet-production\", \"newKey\": false, \"metadata\": {\"index\": $i}}" \
    | jq -r '.key'
done > keys.env
```

## Step 2: Create Kubernetes Secret

### From Environment File

```bash
# Create secret from generated keys
kubectl create secret generic agent-provisioning-keys \
  --from-env-file=keys.env \
  -n agent-fleet

# Verify secret created
kubectl get secret agent-provisioning-keys -n agent-fleet

# View keys (base64 decoded)
kubectl get secret agent-provisioning-keys -n agent-fleet \
  -o jsonpath='{.data.PROVISIONING_KEY_0}' | base64 -d
```

### From Literal Values

```bash
# Create secret with literal values
kubectl create secret generic agent-provisioning-keys \
  --from-literal=PROVISIONING_KEY_0="pvk_abc123..." \
  --from-literal=PROVISIONING_KEY_1="pvk_def456..." \
  --from-literal=PROVISIONING_KEY_2="pvk_ghi789..." \
  -n agent-fleet
```

### Using YAML Manifest

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: agent-provisioning-keys
  namespace: agent-fleet
type: Opaque
stringData:
  PROVISIONING_KEY_0: "pvk_abc123..."
  PROVISIONING_KEY_1: "pvk_def456..."
  PROVISIONING_KEY_2: "pvk_ghi789..."
  # ... add all keys
```

Apply:
```bash
kubectl apply -f provisioning-keys.yaml
```

## Step 3: Deploy Agent Fleet

### Basic Deployment

```bash
helm install agent-fleet ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=10 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=k8s-fleet-production \
  --set provisioning.existingSecret=agent-provisioning-keys \
  -n agent-fleet --create-namespace
```

### Production Deployment

```bash
helm install agent-fleet-prod ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=100 \
  --set fleet.cloudApiEndpoint=https://api.iotistic.com \
  --set fleet.fleetId=k8s-fleet-production \
  --set provisioning.apiUrl=https://api.iotistic.com \
  --set provisioning.existingSecret=agent-provisioning-keys \
  --set provisioning.required=true \
  --set monitoring.serviceMonitor.enabled=true \
  -n agent-fleet-prod --create-namespace
```

## Step 4: Verify Agent Registration

### Check Pod Status

```bash
# Wait for all pods to be ready
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=agent-fleet \
  -n agent-fleet --timeout=600s

# List all pods
kubectl get pods -n agent-fleet
```

### Check Agent Provisioning Status

```bash
# Check first agent
kubectl exec agent-fleet-0 -c agent -n agent-fleet -- \
  curl -s localhost:48484/v2/device | jq '{uuid, status, provisioned}'

# Check all agents
for i in {0..9}; do
  echo "Agent $i:"
  kubectl exec agent-fleet-$i -c agent -n agent-fleet -- \
    curl -s localhost:48484/v2/device | jq -r '.status'
done
```

Expected output: `provisioned` or `online`

### Check Agent Logs

```bash
# View provisioning logs (first pod)
kubectl logs agent-fleet-0 -c agent -n agent-fleet | grep -i provision

# Expected log entries:
# ✅ Provisioning successful
# ✅ Device registered with cloud API
# ✅ Agent UUID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## How Provisioning Works

### Environment Variables (Per Pod)

The StatefulSet template uses `envFrom` to load all provisioning keys from the secret:

```yaml
envFrom:
  - secretRef:
      name: agent-provisioning-keys
```

This makes all keys available as environment variables:
- `PROVISIONING_KEY_0`
- `PROVISIONING_KEY_1`
- `PROVISIONING_KEY_2`
- etc.

### Agent Key Selection

Each agent pod extracts its ordinal index from the pod name and selects the corresponding key:

```javascript
// In agent code (agent/src/provisioning/index.ts)
const podName = process.env.POD_NAME || process.env.HOSTNAME;
const podIndex = podName.match(/-(\d+)$/)?.[1] || '0';
const provisioningKey = process.env[`PROVISIONING_KEY_${podIndex}`];

if (!provisioningKey) {
  throw new Error(`No provisioning key found for pod index ${podIndex}`);
}
```

**Example**:
- Pod `agent-fleet-0` → reads `PROVISIONING_KEY_0`
- Pod `agent-fleet-42` → reads `PROVISIONING_KEY_42`
- Pod `agent-fleet-99` → reads `PROVISIONING_KEY_99`

### Registration Flow

```
1. Agent starts → reads POD_NAME
2. Extract index → agent-fleet-42 → index=42
3. Load key → PROVISIONING_KEY_42
4. Call API → POST /api/v1/devices/register
   Body: {
     "provisioningKey": "pvk_...",
     "fleetId": "k8s-fleet-production",
     "metadata": {
       "podName": "agent-fleet-42",
       "namespace": "agent-fleet",
       "cluster": "us-east-1"
     }
   }
5. API validates → creates device record
6. Agent receives → UUID, configuration
7. Agent starts → begins normal operation
```

## Troubleshooting

### Pods Stuck in CrashLoopBackOff

**Symptom**: Pods restart repeatedly

**Check**:
```bash
kubectl logs agent-fleet-0 -c agent -n agent-fleet --previous
```

**Common Causes**:
1. **Missing provisioning key**: Secret doesn't have key for pod index
2. **Invalid key**: Key expired or already used
3. **API unreachable**: Network issues, firewall, DNS
4. **Wrong fleet ID**: FleetId in config doesn't match key's fleet

**Solutions**:
```bash
# 1. Verify secret has all required keys
kubectl get secret agent-provisioning-keys -n agent-fleet -o yaml | grep PROVISIONING_KEY

# 2. Check key format
kubectl get secret agent-provisioning-keys -n agent-fleet \
  -o jsonpath='{.data.PROVISIONING_KEY_0}' | base64 -d

# 3. Test API from pod
kubectl exec agent-fleet-0 -c agent -n agent-fleet -- \
  curl -v https://api.iotistic.com/health

# 4. Verify fleet ID matches
kubectl exec agent-fleet-0 -c agent -n agent-fleet -- env | grep FLEET_ID
```

### Provisioning Key Not Found

**Symptom**: Error: `No provisioning key found for pod index N`

**Cause**: Secret doesn't have `PROVISIONING_KEY_N`

**Solution**:
```bash
# Check how many keys exist
kubectl get secret agent-provisioning-keys -n agent-fleet -o yaml | grep PROVISIONING_KEY | wc -l

# If deploying 50 agents but only 10 keys exist, regenerate:
./scripts/generate-provisioning-keys.sh 50 > keys.env
kubectl delete secret agent-provisioning-keys -n agent-fleet
kubectl create secret generic agent-provisioning-keys --from-env-file=keys.env -n agent-fleet

# Restart StatefulSet
kubectl rollout restart statefulset agent-fleet -n agent-fleet
```

### API Returns 401 Unauthorized

**Symptom**: Provisioning fails with authentication error

**Cause**: Invalid or expired provisioning key

**Solution**:
```bash
# Regenerate keys with newKey=true
curl -X POST https://api.iotistic.com/api/v1/provisioning-keys/generate \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"fleetId": "k8s-fleet-production", "newKey": true}'

# Update secret and restart
```

### Wrong Pod Index Detected

**Symptom**: Agent reads wrong provisioning key

**Cause**: StatefulSet name changed or pod name parsing failed

**Check**:
```bash
# View pod name and hostname
kubectl exec agent-fleet-0 -c agent -n agent-fleet -- env | grep -E 'POD_NAME|HOSTNAME'

# Expected:
# POD_NAME=agent-fleet-0
# HOSTNAME=agent-fleet-0
```

## Best Practices

### 1. Key Rotation

Rotate provisioning keys periodically:

```bash
# Generate new keys
./scripts/generate-provisioning-keys.sh 100 \
  https://api.iotistic.com \
  k8s-fleet-production \
  $TOKEN > keys-new.env

# Create new secret
kubectl create secret generic agent-provisioning-keys-new \
  --from-env-file=keys-new.env -n agent-fleet

# Update Helm release
helm upgrade agent-fleet ./k8s/charts/agent-fleet \
  --set provisioning.existingSecret=agent-provisioning-keys-new \
  -n agent-fleet --reuse-values

# Delete old secret after verification
kubectl delete secret agent-provisioning-keys -n agent-fleet
```

### 2. Separate Fleets for Environments

```bash
# Dev fleet
fleetId=k8s-fleet-dev

# Staging fleet
fleetId=k8s-fleet-staging

# Production fleet
fleetId=k8s-fleet-production
```

### 3. Store Keys Securely

```bash
# Use external secret management
# Example with AWS Secrets Manager:
kubectl create secret generic agent-provisioning-keys \
  --from-literal=PROVISIONING_KEY_0="$(aws secretsmanager get-secret-value \
    --secret-id agent-fleet-keys --query SecretString --output text | jq -r '.key0')"
```

### 4. Monitor Provisioning Success Rate

```promql
# Prometheus query
sum(rate(agent_provisioning_success_total[5m])) by (fleet_id) /
sum(rate(agent_provisioning_attempts_total[5m])) by (fleet_id)
```

### 5. Automate Key Generation in CI/CD

```yaml
# GitLab CI example
generate-provisioning-keys:
  script:
    - ./scripts/generate-provisioning-keys.sh 100 $API_URL $FLEET_ID $AUTH_TOKEN > keys.env
    - kubectl create secret generic agent-provisioning-keys --from-env-file=keys.env -n $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -
```

## API Reference

### Generate Provisioning Key

```http
POST /api/v1/provisioning-keys/generate
Content-Type: application/json
Authorization: Bearer {token}

{
  "fleetId": "k8s-fleet-production",
  "newKey": false,
  "metadata": {
    "index": 0,
    "environment": "production"
  }
}
```

Response:
```json
{
  "key": "pvk_1234567890abcdef",
  "fleetId": "k8s-fleet-production",
  "expiresAt": "2025-12-31T23:59:59Z",
  "metadata": {
    "index": 0,
    "environment": "production"
  }
}
```

### Register Device (Agent → API)

```http
POST /api/v1/devices/register
Content-Type: application/json

{
  "provisioningKey": "pvk_1234567890abcdef",
  "fleetId": "k8s-fleet-production",
  "metadata": {
    "podName": "agent-fleet-0",
    "namespace": "agent-fleet",
    "cluster": "us-east-1",
    "version": "1.2.3"
  }
}
```

Response:
```json
{
  "uuid": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  "status": "provisioned",
  "apiToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "config": {
    "pollInterval": 30000,
    "reportInterval": 60000
  }
}
```

## Example: Complete Deployment

```bash
#!/bin/bash
set -e

# Configuration
FLEET_ID="k8s-fleet-production"
API_URL="https://api.iotistic.com"
NAMESPACE="agent-fleet"
AGENT_COUNT=100
AUTH_TOKEN="${API_TOKEN}"

# 1. Generate provisioning keys
echo "Generating $AGENT_COUNT provisioning keys..."
./scripts/generate-provisioning-keys.sh \
  $AGENT_COUNT \
  $API_URL \
  $FLEET_ID \
  $AUTH_TOKEN > keys.env

# 2. Create namespace
kubectl create namespace $NAMESPACE --dry-run=client -o yaml | kubectl apply -f -

# 3. Create secret
echo "Creating provisioning keys secret..."
kubectl create secret generic agent-provisioning-keys \
  --from-env-file=keys.env \
  -n $NAMESPACE \
  --dry-run=client -o yaml | kubectl apply -f -

# 4. Deploy fleet
echo "Deploying agent fleet..."
helm upgrade --install agent-fleet ./k8s/charts/agent-fleet \
  --set fleet.replicaCount=$AGENT_COUNT \
  --set fleet.cloudApiEndpoint=$API_URL \
  --set fleet.fleetId=$FLEET_ID \
  --set provisioning.existingSecret=agent-provisioning-keys \
  --set provisioning.required=true \
  -n $NAMESPACE \
  --wait

# 5. Wait for pods
echo "Waiting for pods to be ready..."
kubectl wait --for=condition=ready pod -l app.kubernetes.io/name=agent-fleet \
  -n $NAMESPACE --timeout=600s

# 6. Verify provisioning
echo "Verifying agent provisioning..."
for i in $(seq 0 9); do
  STATUS=$(kubectl exec agent-fleet-$i -c agent -n $NAMESPACE -- \
    curl -s localhost:48484/v2/device | jq -r '.status')
  echo "Agent $i: $STATUS"
done

echo "✅ Deployment complete!"
```
