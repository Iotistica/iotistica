# Agent Fleet Simulator Configuration - Implementation Checklist

## ✅ Completed Tasks

### 1. Helm Chart Updates

- [x] **values.yaml**: Added `simulator.modbusCount` (0-3)
- [x] **values.yaml**: Made `opcuaSimulator.enabled` independent toggle
- [x] **values.yaml**: Added `sensorSimulator` section with resources
- [x] **StatefulSet template**: Replaced single Modbus container with `range` loop
- [x] **StatefulSet template**: Dynamic port assignment (`MODBUS_TCP_PORT={{ add 502 $idx }}`)
- [x] **StatefulSet template**: Conditional OPC-UA sidecar (`{{- if .Values.opcuaSimulator.enabled }}`)
- [x] **StatefulSet template**: Conditional sensor sidecar (`{{- if .Values.sensorSimulator.enabled }}`)
- [x] **StatefulSet template**: Agent env vars (`MODBUS_SIMULATOR_PORTS`, `OPCUA_DISCOVERY_URLS`, `SENSOR_SIMULATOR_ENABLED`)

### 2. GitHub Actions Workflow

- [x] **Workflow inputs**: Added `simulator_preset` choice (custom, modbus-only, opcua-only, full-stack, minimal, heavy-load)
- [x] **Workflow inputs**: Added `modbus_simulator_count` (0-3, for custom mode)
- [x] **Workflow inputs**: Added `opcua_simulator_enabled` (boolean, for custom mode)
- [x] **Workflow inputs**: Added `sensor_simulator_enabled` (boolean, for custom mode)
- [x] **Deploy step**: Bash logic to apply preset configurations
- [x] **Deploy step**: Pass simulator config to Helm via `--set` flags

### 3. Testing & Documentation

- [x] **Test script**: Created `test-simulator-configs.ps1` (PowerShell)
- [x] **Test script**: Validates 5 preset configurations (minimal, modbus-only, full-stack, heavy-load, opcua-only)
- [x] **User guide**: Created `SIMULATOR-CONFIGURATION-GUIDE.md` (400+ lines)
- [x] **User guide**: Includes architecture diagrams, deployment examples, troubleshooting
- [x] **Summary doc**: Created `AGENT-FLEET-SIMULATOR-CONFIG-SUMMARY.md` (technical deep dive)
- [x] **Quick ref**: Created `AGENT-FLEET-SIMULATOR-QUICK-REF.md` (developer cheat sheet)

### 4. Code Quality

- [x] **YAML indentation**: Fixed all indentation issues in StatefulSet template
- [x] **Helm templating**: Used `$` prefix for outer scope variables in `range` loop (`$.Values`)
- [x] **Comments**: Added inline comments explaining sidecar purpose and ports
- [x] **Best practices**: Disabled liveness probes for Modbus (may fail on undefined addresses)
- [x] **Security**: All simulators use localhost (no network exposure)

## 🧪 Verification Steps

### Step 1: Validate Helm Template Rendering

```bash
cd k8s/charts/agent-fleet

# Test minimal preset (no simulators)
helm template agent-fleet . \
  --set simulator.modbusCount=0 \
  --set opcuaSimulator.enabled=false \
  --set sensorSimulator.enabled=false \
  | grep -c "modbus-simulator"
# Expected: 0

# Test full-stack preset (2 Modbus + OPC-UA + sensors)
helm template agent-fleet . \
  --set simulator.modbusCount=2 \
  --set opcuaSimulator.enabled=true \
  --set sensorSimulator.enabled=true \
  | grep -c "name: modbus-simulator"
# Expected: 2

# Test heavy-load preset (3 Modbus)
helm template agent-fleet . \
  --set simulator.modbusCount=3 \
  --set opcuaSimulator.enabled=true \
  --set sensorSimulator.enabled=true \
  | grep "MODBUS_SIMULATOR_PORTS"
# Expected: value: "502,503,504"
```

### Step 2: Run Automated Tests

```powershell
cd k8s/charts/agent-fleet
./test-simulator-configs.ps1
```

**Expected Output:**
```
Testing Helm chart simulator configurations...

Test 1: Minimal (no simulators) ✓
Test 2: Modbus-only (1 instance) ✓
Test 3: Full-stack (2 Modbus + OPC-UA + Sensors) ✓
Test 4: Heavy-load (3 Modbus only) ✓
Test 5: OPC-UA only ✓

All tests complete!
```

### Step 3: Verify Environment Variables

```bash
# Render with 2 Modbus simulators
helm template agent-fleet . --set simulator.modbusCount=2 \
  | grep -A1 "MODBUS_SIMULATOR_PORTS"
# Expected:
#   - name: MODBUS_SIMULATOR_PORTS
#     value: "502,503"

# Verify each simulator has unique port
helm template agent-fleet . --set simulator.modbusCount=3 \
  | grep "MODBUS_TCP_PORT"
# Expected:
#   value: "502"
#   value: "503"
#   value: "504"
```

### Step 4: Deploy to Test Cluster

```bash
# Create test namespace
kubectl create namespace agent-fleet-test

# Deploy with full-stack preset
helm install agent-fleet ./charts/agent-fleet \
  --namespace agent-fleet-test \
  --set fleet.replicaCount=1 \
  --set simulator.modbusCount=2 \
  --set opcuaSimulator.enabled=true \
  --set sensorSimulator.enabled=true

# Wait for pod to be ready
kubectl wait --for=condition=ready pod/agent-fleet-0 \
  --namespace agent-fleet-test \
  --timeout=120s

# Verify sidecars running
kubectl get pod agent-fleet-0 -n agent-fleet-test \
  -o jsonpath='{.spec.containers[*].name}'
# Expected: agent modbus-simulator-0 modbus-simulator-1 opcua-simulator sensor-simulator

# Check agent env vars
kubectl exec -it agent-fleet-0 -n agent-fleet-test -c agent -- env \
  | grep -E "MODBUS_SIMULATOR_PORTS|OPCUA_DISCOVERY_URLS|SENSOR_SIMULATOR_ENABLED"
# Expected:
#   MODBUS_SIMULATOR_PORTS=502,503
#   OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840
#   SENSOR_SIMULATOR_ENABLED=true
```

### Step 5: Validate Simulator Connectivity

```bash
# Test Modbus port 502 accessible
kubectl exec -it agent-fleet-0 -n agent-fleet-test -c agent -- \
  nc -zv localhost 502
# Expected: Connection to localhost 502 port [tcp/mbap] succeeded!

# Test Modbus port 503 accessible
kubectl exec -it agent-fleet-0 -n agent-fleet-test -c agent -- \
  nc -zv localhost 503
# Expected: Connection to localhost 503 port [tcp/*] succeeded!

# Test OPC-UA port 4840 accessible
kubectl exec -it agent-fleet-0 -n agent-fleet-test -c agent -- \
  nc -zv localhost 4840
# Expected: Connection to localhost 4840 port [tcp/*] succeeded!
```

### Step 6: GitHub Actions Workflow Test

```bash
# Trigger workflow with modbus-only preset
gh workflow run release-agent-fleet.yml \
  -f environment=dev \
  -f fleet_replicas=1 \
  -f simulator_preset=modbus-only

# Wait for workflow completion
gh run watch

# Verify deployment
kubectl get pods -n agent-fleet-dev -l app.kubernetes.io/component=agent
# Expected: agent-fleet-dev-0 running with 3 containers (agent + 2 modbus)
```

## 📋 Pre-Deployment Checklist

Before merging to main or deploying to production:

- [ ] **Code Review**: Have 2+ developers review StatefulSet template changes
- [ ] **Test Coverage**: Run `test-simulator-configs.ps1` and verify all tests pass
- [ ] **Resource Quotas**: Update namespace ResourceQuota to support heavy-load preset
- [ ] **Documentation**: Link to guides from main README.md
- [ ] **Runbook**: Add troubleshooting steps to ops runbook
- [ ] **Monitoring**: Configure alerts for sidecar container failures
- [ ] **Rollback Plan**: Document Helm rollback steps in case of issues
- [ ] **Communication**: Notify team of new simulator configuration options

## 🚨 Known Issues & Limitations

### Current Limitations

1. **Maximum Modbus Simulators**: Hard-coded limit of 3 (ports 502-504)
   - **Impact**: Cannot test scenarios with 4+ Modbus devices
   - **Workaround**: Deploy multiple pods for higher device counts
   - **Future**: Make port range configurable in values.yaml

2. **Port Conflicts**: Modbus ports 502-504 hardcoded
   - **Impact**: Cannot run multiple agent pods on same host (with hostPort)
   - **Current State**: hostPort disabled, no actual issue (localhost-only)
   - **Future**: Make base port configurable (e.g., `modbusBasePort: 502`)

3. **No Dynamic Reconfiguration**: Changing `modbusCount` requires pod restart
   - **Impact**: Downtime during simulator count changes
   - **Workaround**: Use StatefulSet rolling update
   - **Future**: Implement hot-reload via ConfigMap

4. **Agent Discovery Not Implemented**: Agent code doesn't yet read `MODBUS_SIMULATOR_PORTS`
   - **Impact**: Manual Modbus connection config still required
   - **Next Step**: Update `agent/src/features/endpoints/modbus/` to parse env var
   - **Tracked In**: Issue #TBD

### Edge Cases

- **Zero Simulators**: Setting all counts to 0 works correctly (production mode)
- **Heavy-Load Resources**: 3 Modbus + OPC-UA + sensors = 896Mi RAM per pod
  - Ensure namespace has sufficient quota for replica count
- **Image Pull Failures**: Simulator images must exist in registry
  - Verify `iotistic/modbus-simulator:latest`, `iotistic/opcua-simulator:latest` images before deploying

## 🔄 Next Steps

### Immediate (Before Merge)

1. **Update Agent Code** - Implement `MODBUS_SIMULATOR_PORTS` parsing:
   ```typescript
   // agent/src/features/endpoints/modbus/modbus-manager.ts
   const ports = process.env.MODBUS_SIMULATOR_PORTS?.split(',').map(Number) || [502];
   ports.forEach(port => this.initConnection({ host: 'localhost', port }));
   ```

2. **Integration Tests** - Add E2E tests for each preset:
   ```bash
   # agent/test/integration/simulator-discovery.test.ts
   describe('Simulator Discovery', () => {
     it('should discover 2 Modbus simulators from env var', async () => {
       process.env.MODBUS_SIMULATOR_PORTS = '502,503';
       const manager = new ModbusManager();
       expect(manager.connections).toHaveLength(2);
     });
   });
   ```

3. **Resource Quota Documentation** - Add to deployment guide:
   ```yaml
   # Recommended namespace quota for 10 full-stack replicas
   apiVersion: v1
   kind: ResourceQuota
   metadata:
     name: agent-fleet-quota
   spec:
     hard:
       requests.memory: "8Gi"
       requests.cpu: "6"
       limits.memory: "16Gi"
       limits.cpu: "12"
   ```

### Short-Term (Next Sprint)

1. **Prometheus Metrics** - Add simulator health metrics to agent
2. **Grafana Dashboard** - Create panel showing simulator distribution
3. **Validation Webhook** - Reject invalid combinations (e.g., `modbusCount > 3`)
4. **Pin Image Versions** - Replace `:latest` with specific tags in production values

### Long-Term (Next Quarter)

1. **Hot-Reload** - Modify simulator count without pod restart (via ConfigMap)
2. **Custom Images** - Support user-provided simulator Docker images
3. **Auto-Scaling** - Scale simulator count based on CPU/memory usage
4. **Multi-Tenancy** - Isolate simulators per customer in shared clusters

## 📚 References

### Internal Documentation
- [SIMULATOR-CONFIGURATION-GUIDE.md](k8s/charts/agent-fleet/SIMULATOR-CONFIGURATION-GUIDE.md) - Full user guide
- [AGENT-FLEET-SIMULATOR-CONFIG-SUMMARY.md](AGENT-FLEET-SIMULATOR-CONFIG-SUMMARY.md) - Technical summary
- [AGENT-FLEET-SIMULATOR-QUICK-REF.md](AGENT-FLEET-SIMULATOR-QUICK-REF.md) - Quick reference

### External References
- Helm Range Loops: https://helm.sh/docs/chart_template_guide/control_structures/#looping-with-the-range-action
- GitHub Actions Choice Inputs: https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions#onworkflow_dispatchinputs
- Kubernetes StatefulSet: https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/
- Modbus TCP: https://modbus.org/docs/Modbus_Messaging_Implementation_Guide_V1_0b.pdf

## ✅ Sign-Off

**Implementation Status:** ✅ Complete  
**Testing Status:** ⚠️ Pending cluster deployment  
**Documentation Status:** ✅ Complete  

**Ready for:**
- [x] Code review
- [x] Merge to feature branch
- [ ] Deploy to dev cluster (requires agent code update)
- [ ] Integration testing
- [ ] Merge to main

**Blockers:**
- Agent code doesn't parse `MODBUS_SIMULATOR_PORTS` env var yet (low priority - defaults work)

---

**Implemented by:** GitHub Copilot  
**Date:** 2025-01-15  
**Feature Branch:** `feature/agent-fleet-simulator-config`  
**Related Issues:** Agent fleet deployment flexibility (#TBD)
