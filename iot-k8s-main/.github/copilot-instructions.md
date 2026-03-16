# Copilot Instructions for iot-k8s

This guide helps AI agents understand the architecture, workflows, and conventions in the IoT Kubernetes platform.

## Architecture Overview

**Three-tier structure:**
1. **Iotistica App** - Main platform (API, Dashboard, MQTT broker, databases)
   - Deployed per client/environment namespace via Helm
   - Multi-environment support: `demo`, `client-<hex-id>` (e.g., `client-0ff9b7ec4c3a`)
   - See: [charts/iotistica-app/](charts/iotistica-app/)

2. **Agent Fleet** - Scalable IoT device simulation/agents
   - Kubernetes StatefulSet (not Deployment) with two containers per pod:
     - **Agent** container - IoT device agent (port 48484)
     - **Modbus Simulator** sidecar - Modbus TCP simulator (port 502)
   - Agents connect to local simulator via `localhost:502`
   - See: [charts/agent-fleet/](charts/agent-fleet/)

3. **GitOps Control** - ArgoCD Applications
   - Each client namespace has one Application (e.g., `client-0ff9b7ec4c3a`)
   - Source: `charts/iotistica-app` with environment-specific values
   - See: [argocd/clients/](argocd/clients/)

## Critical File Patterns

### Environment-Specific Values
```
charts/iotistica-app/values/
├── demo/
│   └── values.yaml          # Dev/testing defaults (ClusterIP, no Redis)
├── client-0ff9b7ec4c3a/
│   └── values.yaml          # Client production config (LoadBalancer, caching)
└── [client-<hex-id>/]       # Pattern for all client deployments
```

**Key rule**: Each environment/client has its own values file. Never hardcode client-specific config in templates.

### Helm Templating Conventions
- Use `_helpers.tpl` for shared template macros (pod labels, connection strings)
- PostgreSQL connection string: `{{ include "iotistic.postgres.connectionString" . }}`
- Selector labels: `{{ include "iotistic.selectorLabels" . }}` for consistency
- Fleet labels: Add `app.kubernetes.io/fleet` to agent-fleet pods for fleet identity

## Common Workflows

### Deploy a New Client Environment
1. **Create values file**: `cp charts/iotistica-app/values/demo/ charts/iotistica-app/values/client-<new-id>/`
2. **Create ArgoCD Application**: `cp argocd/clients/client-0ff9b7ec4c3a.yaml argocd/clients/client-<new-id>.yaml` and update namespace/valueFile paths
3. **Validate Helm**: `helm template client-<new-id> charts/iotistica-app -f charts/iotistica-app/values/client-<new-id>/values.yaml --debug`
4. **Sync ArgoCD**: ArgoCD auto-syncs or manual `argocd app sync client-<new-id>`

### Generate Agent Provisioning Keys
Keys are **required** before agent fleet deployment (StatefulSet needs them in a secret).
```bash
# Bash (Linux/Mac)
./charts/agent-fleet/scripts/generate-provisioning-keys.sh 100 https://api.iotistic.com k8s-fleet-prod $TOKEN > keys.env

# PowerShell (Windows)
.\charts\agent-fleet\scripts\generate-provisioning-keys.ps1 -Count 100 -ApiUrl "https://api.iotistic.com" -FleetId "k8s-fleet-prod" -AuthToken $env:API_TOKEN
```
Then create secret: `kubectl create secret generic agent-provisioning-keys --from-env-file=keys.env -n agent-fleet`

### Scale Agent Fleet
Use StatefulSet scaling (not Helm replica changes, though both work):
```bash
kubectl scale statefulset agent-fleet --replicas=50 -n agent-fleet
# Or via Helm upgrade: helm upgrade agent-fleet ./charts/agent-fleet --set fleet.replicaCount=50
```

### Debug ArgoCD Sync Failures
**Common error**: Helm template evaluation fails (e.g., nil pointer in `.Values.api.publicKey.SecretName`)
- Check all `SecretName` fields are objects, not strings (see [charts/iotistica-app/values/client-0ff9b7ec4c3a/values.yaml](charts/iotistica-app/values/client-0ff9b7ec4c3a/values.yaml) for correct structure)
- Run: `helm template <release> charts/iotistica-app -f <values-file> --debug` to see rendered YAML
- Compare working values file with failing one (e.g., `demo/values.yaml` vs `client-xxx/values.yaml`)

## Project-Specific Conventions

### Naming
- **Client IDs**: Hex format (`client-0ff9b7ec4c3a`, `client-23963d1ee84e`) for customer segregation
- **Namespace**: Matches client ID (`namespace: client-0ff9b7ec4c3a` in values)
- **Fleet ID**: Human-readable, used for agent grouping (e.g., `k8s-fleet-production`, `load-test-fleet`)

### Secret Management
All sensitive data via Kubernetes Secrets, never in values:
- `api.sql.SecretName: "sql-credentials-demo"`
- `api.mqtt.SecretName: "mqtt-credentials-demo"`
- `api.jwt.SecretName: "api-jwt-demo"`
- `api.openai.SecretName: "openai-credentials-master"` (shared across clients)

### Pod Security & Kyverno Policies
- **Kyverno policies** ([kyverno/policies.yaml](kyverno/policies.yaml)) enforce RBAC restrictions AI/API cannot bypass
- **ClusterRole whitelist**: Only `iotistic-fleet-namespace-manager` allowed (defined in [cluster-rbac/cluster-roles.yaml](cluster-rbac/cluster-roles.yaml))
- **Safe permissions**: Secrets create/get/update (no delete), Pods delete (restart), no wildcard perms
- **Implication**: API cannot create arbitrary roles; pre-defined roles bound at deployment time

## Resource Requirements

For **100 agents** (StatefulSet):
- CPU: 20 cores request + overhead ≈ 24 cores total
- Memory: 38.4 GB request + overhead ≈ 46 GB
- Storage: 100 GB (1 GiB per agent for SQLite)
- **Recommended**: 3-4 nodes × (8 vCPU / 16 GB RAM) with spot instances for cost savings

See [charts/agent-fleet/README.md#resource-requirements](charts/agent-fleet/README.md#L190) for small/medium fleet sizing.

## Key Dependencies & Integrations

| Component | Port | Pattern |
|-----------|------|---------|
| Agent | 48484 | HTTP health/status endpoint |
| Modbus Simulator | 502 | **Sidecar only** (localhost), agent connects via loopback |
| Mosquitto | 1883, 8883, 9001 | MQTT broker (sidecar per client app) |
| PostgreSQL | 5432 | Per-environment DB (service: `<release>-postgres`) |
| Redis | 6379 | Optional caching (shared across fleet if `redis.enabled: true`) |

**Agent ↔ API**: Uses provisioning keys from secret mounted at `/provisioning-keys/` to authenticate.

## Testing Checklist

Before merging environment/client changes:
1. **Helm validation**: `helm lint charts/iotistica-app && helm lint charts/agent-fleet`
2. **Template render**: `helm template <release> charts/iotistica-app -f values/<env>/ --debug` (no errors)
3. **ArgoCD sync**: If ArgoCD Application exists, verify `argocd app sync` succeeds
4. **Secret readiness**: Verify required secrets exist in target namespace before sync
5. **Pod startup**: Monitor first pod logs: `kubectl logs <pod> -n <namespace> --tail=50`

## Quick Reference

- **Add client**: Create values dir + ArgoCD app, run helm validate checklist
- **Generate keys**: Run provisioning script, create secret, verify format
- **Scale fleet**: `kubectl scale statefulset agent-fleet --replicas=N`
- **Check heap usage**: `kubectl top pods -n agent-fleet` (per-agent memory footprint)
- **View agent status**: `kubectl exec agent-fleet-0 -c agent -n agent-fleet -- curl -s localhost:48484/v2/device`

---

**Last Updated**: March 2, 2026  
**Scope**: iot-k8s repository (Helm charts, ArgoCD configs, cluster policies)
