# Virtual Agent Implementation Plan

## Overview
Enable users to deploy containerized agents to Kubernetes clusters directly from the dashboard, without physical hardware installation. Virtual agents will use the same provisioning system as physical agents but deploy via Kubernetes API instead of manual installation scripts. Provisioning keys are generated server-side and injected directly into pod environments - never exposed to the client.

## Architecture Decision

**Core Principle**: Extend existing provisioning service with conditional logic based on `device_type`

```typescript
// Flow Decision Point
if (device_type === 'virtual') {
  → Generate provisioning key (server-side)
  → Deploy to K8s via Kubernetes API (@kubernetes/client-node)
  → Inject key into pod environment (via K8s Secret)
  → Agent auto-provisions on startup
  → Key never sent to client
} else {
  → Generate provisioning key
  → Return key to user
  → User installs manually
}
```

**Deployment Mechanism**: Direct Kubernetes API instead of Helm
- **Why**: Single-pod deployments don't need Helm's multi-resource management
- **Library**: `@kubernetes/client-node` (~2MB vs Helm's ~50MB)
- **Benefits**: Lightweight, programmatic control, better error handling
- **RBAC**: Minimal permissions (Deployment, Secret, Pod read access only)

## Key Constraints
- ✅ No database migration needed ('virtual' is new type, not replacement)
- ✅ Reuse existing provisioning service (no duplication)
- ✅ Physical agent flow remains unchanged
- ✅ Use Kubernetes API for deployment (no Helm dependency)
- ✅ Virtual agents self-provision (no manual intervention)
- ✅ Provisioning keys generated server-side (never exposed to client)
- ✅ Keys injected via K8s Secrets (encrypted at rest)

---

## Implementation Phases

### Phase 1: TypeScript Types & Database Schema (No Migration)

**Files to Update**:
- `api/src/db/models.ts`

**Changes**:
```typescript
// Add 'virtual' to device type enum
export type DeviceType = 'gateway' | 'sensor' | 'server' | 'virtual';

// Add new fields to Device interface
export interface Device {
  // ... existing fields
  deployment_namespace?: string | null;
  deployment_status?: 'pending' | 'deploying' | 'running' | 'failed' | 'terminated' | null;
  k8s_pod_name?: string | null;
  helm_release_name?: string | null;
}
```

**Database Columns** (already exist or will be added via ALTER):
```sql
-- These columns may already exist, add if missing:
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deployment_namespace VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS deployment_status VARCHAR(50);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS k8s_pod_name VARCHAR(255);
ALTER TABLE devices ADD COLUMN IF NOT EXISTS helm_release_name VARCHAR(255);

-- Index for efficient queries
CREATE INDEX IF NOT EXISTS idx_devices_virtual 
  ON devices(device_type, deployment_status) 
  WHERE device_type = 'virtual';
```

---

### Phase 2: Virtual Agent Deployer Service

**New File**: `api/src/services/virtual-agent-deployer.ts`

**Dependencies**: `@kubernetes/client-node` (~2MB npm package)

**Responsibilities**:
- Deploy single agent pod via Kubernetes API
- Create K8s Secret with provisioning key (never sent to client)
- Create Deployment resource with single replica
- Track deployment status
- Destroy/cleanup virtual agents (Deployment + Secret)
- Query pod health status

**Key Methods**:
- `deploy(config)` - Create Secret + Deployment via K8s API
- `destroy(deviceUuid)` - Delete Deployment + Secret
- `getStatus(deviceUuid)` - Get current deployment state from K8s API

**Configuration**:
```typescript
interface VirtualAgentConfig {
  deviceUuid: string;
  deviceName: string;
  provisioningKey: string; // Generated server-side, injected to pod
  fleetId: string;
  namespace?: string; // defaults to 'virtual-agents'
  resourceLimits?: {
    cpu: string; // default: '1000m'
    memory: string; // default: '2Gi'
  };
}
```

**Implementation Pattern**:
```typescript
import { KubeConfig, AppsV1Api, CoreV1Api } from '@kubernetes/client-node';

export class VirtualAgentDeployer {
  private k8s: { apps: AppsV1Api; core: CoreV1Api };

  constructor() {
    const kc = new KubeConfig();
    kc.loadFromCluster(); // Or loadFromDefault() for local dev
    this.k8s = {
      apps: kc.makeApiClient(AppsV1Api),
      core: kc.makeApiClient(CoreV1Api)
    };
  }

  async deploy(config: VirtualAgentConfig): Promise<void> {
    const name = `agent-${config.deviceUuid.substring(0, 8)}`;
    const namespace = config.namespace || 'virtual-agents';

    // 1. Create Secret with provisioning key
    await this.k8s.core.createNamespacedSecret(namespace, {
      metadata: { name: `${name}-prov-key` },
      stringData: { provisioningKey: config.provisioningKey }
    });

    // 2. Create Deployment (single pod)
    await this.k8s.apps.createNamespacedDeployment(namespace, {
      metadata: { 
        name,
        labels: { app: 'virtual-agent', deviceUuid: config.deviceUuid }
      },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: name } },
        template: {
          metadata: { labels: { app: name } },
          spec: {
            containers: [{
              name: 'agent',
              image: 'iotistic/agent:latest',
              env: [
                { name: 'DEVICE_UUID', value: config.deviceUuid },
                { name: 'FLEET_ID', value: config.fleetId },
                { name: 'REQUIRE_PROVISIONING', value: 'true' },
                { name: 'IS_VIRTUAL_AGENT', value: 'true' },
                { name: 'CLOUD_API_URL', value: process.env.CLOUD_API_URL },
                { 
                  name: 'PROVISIONING_KEY',
                  valueFrom: { 
                    secretKeyRef: { 
                      name: `${name}-prov-key`,
                      key: 'provisioningKey'
                    }
                  }
                }
              ],
              resources: {
                requests: { cpu: '200m', memory: '512Mi' },
                limits: { 
                  cpu: config.resourceLimits?.cpu || '1000m',
                  memory: config.resourceLimits?.memory || '2Gi'
                }
              }
            }]
          }
        }
      }
    });
  }
}
```

**Error Handling**:
- Update `deployment_status` to 'failed' on errors
- Catch K8s API exceptions (401, 403, 409, 500)
- Log full error response from K8s API
- Rollback on timeout (5 min) - delete Secret + Deployment
- Retry logic with exponential backoff (optional, future enhancement)

---

### Phase 3: Update Provisioning Service

**File**: `api/src/services/provisioning.service.ts`

**Changes**:
1. Add optional fields to `RegistrationRequest`:
   ```typescript
   export interface RegistrationRequest {
     // ... existing fields
     isVirtual?: boolean;
     namespace?: string;
   }
   ```

2. Add conditional logic in `registerDevice()`:
   ```typescript
   public async registerDevice(data: RegistrationRequest): Promise<ProvisioningResponse> {
     // ... existing validation
     
     if (data.deviceType === 'virtual' || data.isVirtual) {
       // VIRTUAL AGENT FLOW
       // 1. Generate provisioning key (server-side, never sent to client)
       const provisioningKey = this.generateProvisioningKey();
       const hashedKey = await this.hashProvisioningKey(provisioningKey);
       
       // 2. Create device record (pending state, store hashed key)
       const device = await this.createDeviceRecord({
         ...data,
         provisioningKeyHash: hashedKey,
         deploymentStatus: 'pending'
       });
       
       // 3. Trigger async K8s deployment (plaintext key injected to pod)
       await this.virtualAgentDeployer.deploy({
         deviceUuid: device.uuid,
         deviceName: device.name,
         provisioningKey, // Plaintext, only exists in pod env
         fleetId: data.fleetId || 'default-fleet',
         namespace: data.namespace || 'virtual-agents'
       });
       
       // 4. Update status to 'deploying'
       await this.updateDeviceStatus(device.uuid, 'deploying');
       
       // 5. Agent self-provisions on startup (using key from env)
       // 6. Return minimal response (key never sent to client)
       return {
         message: 'Virtual agent deployment initiated',
         deviceUuid: device.uuid,
         status: 'deploying'
       };
     } else {
       // PHYSICAL AGENT FLOW (unchanged)
       // ... existing code that returns key to user
     }
   }
   ```

**Return Types**:
- Physical: Full `ProvisioningResponse` with provisioning key, MQTT creds, VPN config
- Virtual: Minimal response (`{ message: 'Virtual agent deployment initiated', deviceUuid: 'xxx', status: 'deploying' }`)
  - **Security**: Provisioning key NEVER returned to client for virtual agents

**State Transitions**:
```
Virtual Agent:
  pending → deploying → running → [online when provisioned]
  
Physical Agent:
  pending → registered → [online when connected]
```

---

### Phase 4: API Routes

**File**: `api/src/routes/devices.ts`

**New Endpoints**:

#### 1. POST `/api/v1/devices/virtual`
Create and deploy virtual agent
```json
{
  "deviceName": "virtual-agent-001",
  "namespace": "virtual-agents",  // optional
  "fleetId": "default-fleet"      // optional
}
```
Response (202 Accepted):
```json
{
  "message": "Virtual agent deployment initiated",
  "deviceUuid": "abc-123...",
  "status": "deploying"
}
```

#### 2. GET `/api/v1/devices/:uuid/deployment-status`
Get deployment status
```json
{
  "status": "running",
  "namespace": "virtual-agents",
  "podName": "agent-abc12345-xxxxx",
  "helmRelease": "agent-abc12345",
  "isOnline": true,
  "deviceStatus": "online"
}
```

#### 3. DELETE `/api/v1/devices/:uuid/virtual`
Destroy virtual agent (removes pod)
```json
{
  "message": "Virtual agent destroyed"
}
```

**Authorization**: All endpoints require valid JWT token

---

### Phase 5: Dashboard UI Updates

**File**: `dashboard/src/components/AddEditDeviceDialog.tsx`

**Changes**:

1. **Add Deployment Type Selector**:
   ```tsx
   const [deploymentType, setDeploymentType] = useState<'physical' | 'virtual'>('physical');
   ```

2. **Conditional UI Rendering**:
   - **Physical**: Show provisioning key + install command (existing)
   - **Virtual**: Show namespace input + deployment info message

3. **Split Save Logic**:
   ```typescript
   if (deploymentType === 'virtual') {
     // Call POST /api/v1/devices/virtual
   } else {
     // Existing physical agent flow
   }
   ```

4. **Add Visual Indicators**:
   - Server icon for physical
   - Cloud/Container icon for virtual
   - Info alert explaining virtual agent behavior

**New Component** (optional): `VirtualAgentStatusBadge.tsx`
- Show deployment status with live polling
- Color-coded badges (deploying=blue, running=green, failed=red)
- Display pod name and namespace

---

### Phase 6: Kubernetes RBAC Configuration

**Required Permissions** for API service account (Minimal - K8s API only):

**File**: `k8s/rbac/api-virtual-agent-rbac.yaml`

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: api-virtual-agent-deployer
  namespace: api

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: virtual-agent-deployer
rules:
  # Namespace management (optional - only if API creates namespaces)
  - apiGroups: [""]
    resources: ["namespaces"]
    verbs: ["create", "get", "list"]
  
  # Pod management (for status queries only)
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list"]
  
  # Deployment management (create/delete virtual agents)
  - apiGroups: ["apps"]
    resources: ["deployments"]
    verbs: ["create", "get", "list", "update", "delete"]
  
  # Secret management (for provisioning keys)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["create", "get", "delete"]

---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: api-virtual-agent-deployer-binding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: virtual-agent-deployer
subjects:
  - kind: ServiceAccount
    name: api-virtual-agent-deployer
    namespace: api
```

**API Deployment Update**:
```yaml
# api deployment spec
spec:
  template:
    spec:
      serviceAccountName: api-virtual-agent-deployer
```

---

## Environment Variables

### API Service
```bash
# Virtual agent deployment
VIRTUAL_AGENT_NAMESPACE=virtual-agents  # default namespace
AGENT_IMAGE=iotistic/agent:latest      # container image
AGENT_IMAGE_PULL_POLICY=Always         # or IfNotPresent

# Cloud endpoints (passed to agents via env vars)
CLOUD_API_URL=https://api1.iotistica.com:443
MQTT_BROKER_URL=mqtts://mqtt1.iotistica.com:8883

# Kubernetes access
# In-cluster: Uses service account token (no config needed)
# Outside cluster: Set KUBECONFIG=/path/to/kubeconfig

# Resource limits (optional overrides)
VIRTUAL_AGENT_CPU_REQUEST=200m
VIRTUAL_AGENT_CPU_LIMIT=1000m
VIRTUAL_AGENT_MEMORY_REQUEST=512Mi
VIRTUAL_AGENT_MEMORY_LIMIT=2Gi
```

### Dashboard
```bash
# No new env vars needed - uses existing API_URL
```

---

## Testing Strategy

### Unit Tests
- `virtual-agent-deployer.test.ts`
  - Mock K8s API client methods
  - Test Secret creation with provisioning keys
  - Test Deployment manifest generation
  - Test error handling (K8s API exceptions)
  - Test cleanup (Secret + Deployment deletion)

### Integration Tests
- Deploy virtual agent to test cluster
- Verify provisioning flow
- Test status polling
- Test destroy operation

### E2E Tests
- Create virtual agent from dashboard
- Wait for deployment
- Verify agent appears online
- Destroy agent
- Verify cleanup

### Load Testing
- Deploy 10 virtual agents concurrently
- Measure deployment time
- Monitor resource usage
- Test API rate limiting

---

## Rollout Plan

### Week 1: Backend Foundation
- [ ] Create `virtual-agent-deployer.ts` service
- [ ] Add TypeScript types
- [ ] Update `provisioning.service.ts` with conditional logic
- [ ] Write unit tests

### Week 2: API Endpoints
- [ ] Add `/devices/virtual` routes
- [ ] Add deployment status endpoint
- [ ] Set up RBAC in K8s
- [ ] Test with curl/Postman

### Week 3: Dashboard UI
- [ ] Update `AddEditDeviceDialog.tsx`
- [ ] Add deployment type selector
- [ ] Create status badge component
- [ ] Test create/destroy flow

### Week 4: Testing & Docs
- [ ] Integration tests
- [ ] E2E tests from dashboard
- [ ] Update API documentation
- [ ] User guide for virtual agents
- [ ] Performance testing

---

## Success Criteria

- ✅ User can create virtual agent from dashboard
- ✅ Virtual agent deploys to K8s within 2 minutes
- ✅ Virtual agent auto-provisions and appears online
- ✅ Deployment status visible in UI (real-time)
- ✅ Virtual agent can be destroyed cleanly
- ✅ Physical agent flow remains unchanged
- ✅ No manual steps required (fully automated)
- ✅ Support 50+ concurrent virtual agents

---

## Risk Mitigation

### Risk: K8s API deployment failures
**Mitigation**: 
- Implement timeout (5 min)
- Update status to 'failed' with error message
- Catch specific K8s errors (409 Conflict, 403 Forbidden, etc.)
- Allow retry via dashboard
- Log full K8s API error response for debugging
- Automatic rollback (delete Secret + Deployment on failure)

### Risk: Namespace conflicts
**Mitigation**:
- Use unique namespace per customer/tenant
- Check namespace availability before deploy
- Clean up namespaces on agent destroy

### Risk: Resource exhaustion
**Mitigation**:
- Set strict resource limits per agent
- Monitor cluster capacity
- Implement quota limits per customer
- Alert on high resource usage

### Risk: Provisioning key leakage
**Mitigation**:
- **Server-side generation**: Keys NEVER sent to client for virtual agents
- **K8s Secret storage**: Encrypted at rest, injected via pod env
- **Ephemeral key lifetime**: Only exists in pod memory (deleted on pod termination)
- **Database hashing**: Only hashed keys stored in DB (bcrypt/argon2)
- One-time use provisioning keys (invalidated after first use)
- Keys expire after 24 hours (for physical agents)
- Audit log all key generation and validation events

---

## Future Enhancements

### Phase 2 Features (Post-MVP)
- [ ] Virtual agent templates (with pre-configured simulators)
- [ ] Bulk deployment (deploy N agents)
- [ ] Auto-scaling (scale replicas based on load)
- [ ] Multi-cluster support
- [ ] GitHub Actions deployment option
- [ ] Deployment rollback capability
- [ ] Resource usage monitoring per agent
- [ ] Cost tracking per virtual agent

### GitOps Integration
- [ ] ArgoCD application manifests
- [ ] FluxCD Helm releases
- [ ] Automatic drift detection
- [ ] Deployment history tracking

---

## Open Questions

1. **Namespace Strategy**: One namespace per customer or shared `virtual-agents` namespace?
   - **Recommendation**: Start with shared namespace, add multi-tenancy later

2. **Deployment Mechanism**: Helm vs K8s API?
   - **Decision**: Use K8s API directly via `@kubernetes/client-node`
   - **Rationale**: Lighter footprint (2MB vs 50MB), simpler for single pods, programmatic control

3. **Provisioning Key Lifecycle**: Generate new key per virtual agent or reuse fleet key?
   - **Recommendation**: Generate unique key per agent for security

4. **Deployment Async Pattern**: Fire-and-forget or worker queue?
   - **Recommendation**: Start with fire-and-forget, add Bull queue if needed

5. **Monitoring**: Expose Prometheus metrics for virtual agents?
   - **Recommendation**: Yes, use existing agent metrics

---

## Dependencies

### NPM Packages (API)
```json
{
  "dependencies": {
    "@kubernetes/client-node": "^0.20.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0"
  }
}
```

**Package Size**: ~2MB (vs Helm binary ~50MB)

### Infrastructure
- ✅ Kubernetes cluster (existing)
- ✅ API service account with RBAC permissions
- ✅ In-cluster access OR kubeconfig (for local dev)
- ⚠️ Namespace quotas configured (optional)
- ⚠️ Pod Security Policies (optional)

### External Services
- ✅ Cloud API (existing)
- ✅ MQTT broker (existing)
- ✅ PostgreSQL (existing)
- ⚠️ Prometheus (optional, for metrics)

---

## Metrics to Track

### Deployment Metrics
- Average deployment time (target: <2 min)
- Deployment success rate (target: >95%)
- Concurrent deployments supported
- Time to first provisioning

### Operational Metrics
- Active virtual agents count
- Resource usage per agent (CPU, memory)
- Failed deployments per day
- Average agent uptime

### Business Metrics
- Virtual vs physical agent ratio
- Time saved vs manual installation
- Customer adoption rate
- Support tickets related to virtual agents

---

## Documentation Requirements

### Developer Docs
- [ ] API endpoint specifications (OpenAPI)
- [ ] Virtual agent deployer service architecture (K8s API approach)
- [ ] Kubernetes API client usage guide
- [ ] RBAC setup instructions (minimal permissions)
- [ ] Provisioning key security model (server-side generation)

### User Docs
- [ ] "Creating a Virtual Agent" tutorial
- [ ] Virtual vs Physical agent comparison
- [ ] Troubleshooting deployment failures
- [ ] Resource limits and quotas guide
- [ ] Security: Why virtual agents don't show provisioning keys

### Operations Docs
- [ ] Cluster capacity planning
- [ ] Backup and disaster recovery
- [ ] Scaling virtual agent deployments
- [ ] Cost optimization strategies

---

## Appendix: Code Snippets

### Example K8s Resources Created

**Secret** (provisioning key - never sent to client):
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: agent-abc12345-prov-key
  namespace: virtual-agents
type: Opaque
stringData:
  provisioningKey: pk_xxx...  # Generated server-side, injected to pod
```

**Deployment** (single pod):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: agent-abc12345
  namespace: virtual-agents
  labels:
    app: virtual-agent
    deviceUuid: abc-123-def-456
spec:
  replicas: 1
  selector:
    matchLabels:
      app: agent-abc12345
  template:
    metadata:
      labels:
        app: agent-abc12345
    spec:
      containers:
      - name: agent
        image: iotistic/agent:latest
        imagePullPolicy: Always
        env:
        - name: DEVICE_UUID
          value: abc-123-def-456
        - name: FLEET_ID
          value: default-fleet
        - name: REQUIRE_PROVISIONING
          value: "true"
        - name: IS_VIRTUAL_AGENT
          value: "true"
        - name: CLOUD_API_URL
          value: https://api1.iotistica.com:443
        - name: MQTT_BROKER_URL
          value: mqtts://mqtt1.iotistica.com:8883
        - name: PROVISIONING_KEY
          valueFrom:
            secretKeyRef:
              name: agent-abc12345-prov-key
              key: provisioningKey
        resources:
          requests:
            cpu: 200m
            memory: 512Mi
          limits:
            cpu: 1000m
            memory: 2Gi
```

### Example API Response Flow
```typescript
// 1. Create virtual agent
POST /api/v1/devices/virtual
→ 202 Accepted { deviceUuid: "...", status: "deploying" }

// 2. Poll status (every 5s)
GET /api/v1/devices/:uuid/deployment-status
→ 200 OK { status: "deploying", namespace: "...", podName: null }
→ 200 OK { status: "running", namespace: "...", podName: "agent-abc-xyz" }

// 3. Agent provisions itself
→ Device status changes to "online" in devices list

// 4. Destroy (optional)
DELETE /api/v1/devices/:uuid/virtual
→ 200 OK { message: "Virtual agent destroyed" }
```

---

## Sign-off

**Prepared by**: AI Assistant  
**Date**: February 6, 2026  
**Status**: Updated - Ready for Implementation  
**Architecture**: K8s API (`@kubernetes/client-node`) instead of Helm  
**Security Model**: Server-side provisioning key generation (client never sees keys)  
**Next Steps**: Review with team, prioritize phases, begin Week 1 implementation

---

## Key Design Decisions

### 1. Deployment Mechanism: K8s API vs Helm
**Decision**: Use `@kubernetes/client-node` library for direct Kubernetes API calls

**Rationale**:
- **Lightweight**: 2MB npm package vs 50MB Helm binary
- **Programmatic Control**: Full TypeScript control over resource creation
- **Simpler for Single Pods**: Virtual agents are simple single-pod deployments
- **Better Error Handling**: Native TypeScript try/catch vs parsing CLI output
- **Lower Security Surface**: Minimal RBAC permissions needed
- **No External Dependencies**: No Helm binary lifecycle management

**Trade-offs**:
- ❌ Manual resource management (no Helm chart templating)
- ✅ But virtual agents have fixed structure (Deployment + Secret only)
- ✅ Easier to test (mock K8s client vs mocking shell commands)

### 2. Provisioning Key Security: Server-Side Generation
**Decision**: Generate provisioning keys in backend, inject to pods via K8s Secrets

**Rationale**:
- **Security**: Keys never exposed to client/browser
- **Consistency**: Same provisioning flow for virtual and physical agents
- **Auditability**: All key generation logged server-side
- **Encryption**: K8s Secrets encrypted at rest
- **Ephemeral**: Keys only exist in pod memory (deleted on termination)

**Implementation**:
```typescript
// Backend generates key
const provisioningKey = generateProvisioningKey();
const hashedKey = await hashProvisioningKey(provisioningKey);

// Save hash to database
await db.devices.update({ provisioningKeyHash: hashedKey });

// Inject plaintext to K8s Secret (encrypted at rest)
await k8s.core.createNamespacedSecret(namespace, {
  stringData: { provisioningKey } // Pod reads from env
});

// Client never sees the key!
return { message: 'Deployment initiated', deviceUuid };
```

**Key Flow**:
1. User clicks "Create Virtual Agent" in dashboard
2. API generates provisioning key (server-side)
3. API hashes key → stores in database
4. API creates K8s Secret (plaintext key)
5. API creates Deployment (references Secret via env)
6. Pod starts → reads key from env → provisions itself
7. Client only sees "deployment initiated" message

**Security Properties**:
- ✅ Key never traverses network to client
- ✅ Database stores only hashed keys (bcrypt/argon2)
- ✅ K8s encrypts Secrets at rest
- ✅ Pods read keys from memory (ephemeral)
- ✅ One-time use (invalidated after provisioning)
- ✅ Audit log all key operations
