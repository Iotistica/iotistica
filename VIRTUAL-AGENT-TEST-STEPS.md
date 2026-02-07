# Virtual Agent End-to-End Testing Steps

## Prerequisites
✅ Dashboard running on http://localhost:8080
✅ API running in Docker (port 4002)
✅ PostgreSQL running
✅ Kubernetes enabled in Docker Desktop

## Step 1: Clean Slate (Run in PowerShell)

```powershell
# Delete existing virtual agent deployments
kubectl delete deployments -n virtual-agents --all 2>$null

# Clean database (remove old virtual agents)
docker exec iotistic-postgres psql -U postgres -d iotistic -c "DELETE FROM devices WHERE device_type = 'virtual';"

# Clean provisioning keys
docker exec iotistic-postgres psql -U postgres -d iotistic -c "DELETE FROM provisioning_keys WHERE max_devices = 1;"
```

## Step 2: Create Virtual Agent via Dashboard

1. Open dashboard: http://localhost:8080
2. Navigate to "Devices" section
3. Click "Add Device" or similar
4. Select device type: **Virtual Agent**
5. Fill in:
   - Device Name: `test-virtual-agent-001`
   - Fleet ID: (optional or create new fleet)
   - Namespace: `virtual-agents`
6. Click "Create" or "Deploy"

## Step 3: Monitor Deployment (Run in PowerShell)

```powershell
# Watch pod creation
kubectl get pods -n virtual-agents --watch

# In another terminal, follow logs (once pod starts)
kubectl logs -n virtual-agents -l app=iotistic-agent --follow
```

**Expected Pod Lifecycle:**
```
NAME                                    READY   STATUS
iotistic-agent-<uuid>-<hash>           0/1     ContainerCreating
iotistic-agent-<uuid>-<hash>           1/1     Running
```

## Step 4: Verify Success Criteria

### A. Check Database - Only ONE Device Created
```powershell
docker exec iotistic-postgres psql -U postgres -d iotistic -c "SELECT uuid, device_name, device_type, provisioning_state, status FROM devices WHERE device_type = 'virtual' ORDER BY created_at DESC LIMIT 5;"
```

**Expected Result:**
```
                 uuid                 |      device_name       | device_type | provisioning_state | status
--------------------------------------+------------------------+-------------+-------------------+--------
 2a7875c1-7e03-4f89-b7f7-cc8171940f6a | test-virtual-agent-001 | virtual     | provisioned       | online
```

✅ **SUCCESS**: Only 1 device record
❌ **FAILURE**: 2 devices (one with NULL device_name) = UUID bug still present

### B. Check UUID Matches Environment Variable
```powershell
# Get pod's DEVICE_UUID
kubectl get pod -n virtual-agents -l app=iotistic-agent -o jsonpath='{.items[0].spec.containers[0].env[?(@.name=="DEVICE_UUID")].value}'

# Compare with database UUID (should match exactly)
```

### C. Check Agent Logs for Registration Success
```powershell
kubectl logs -n virtual-agents -l app=iotistic-agent --tail 100 | Select-String -Pattern "registration|provisioning|uuid"
```

**Expected Log Patterns:**
```
✅ "uuid":"2a7875c1-7e03-4f89-b7f7-cc8171940f6a" (correct)
✅ "Registering device with API"
✅ "Device registered successfully"
✅ "Connecting to MQTT broker"

❌ "Provisioning key limit exceeded" (provisioning key bug)
❌ Different UUIDs in log vs env var (UUID bug)
```

### D. Check Dashboard Device Status
1. Refresh dashboard devices page
2. Find `test-virtual-agent-001`
3. Status should show: **Online** (green)

## Step 5: Troubleshooting Commands

### If Pod Won't Start
```powershell
# Check pod events
kubectl describe pod -n virtual-agents -l app=iotistic-agent

# Check deployment
kubectl get deployment -n virtual-agents
kubectl describe deployment -n virtual-agents
```

### If Agent Can't Connect to API
```powershell
# Check environment variables in pod
kubectl exec -n virtual-agents -it $(kubectl get pod -n virtual-agents -l app=iotistic-agent -o jsonpath='{.items[0].metadata.name}') -- env | Select-String "CLOUD_API|MQTT|DEVICE_UUID"

# Expected:
# CLOUD_API_ENDPOINT=http://host.docker.internal:4002
# MQTT_BROKER_URL=mqtt://host.docker.internal:5883
# DEVICE_UUID=<uuid-from-dashboard>
```

### If Provisioning Key Error
```powershell
# Check provisioning key usage
docker exec iotistic-postgres psql -U postgres -d iotistic -c "SELECT key_hash, max_devices, current_device_count, created_at FROM provisioning_keys WHERE max_devices = 1 ORDER BY created_at DESC LIMIT 5;"

# If current_device_count >= max_devices, key is consumed
```

## Success Criteria Summary

✅ Single device record in database (no duplicates)
✅ Device UUID matches pod's DEVICE_UUID env var
✅ Agent logs show successful registration
✅ No "provisioning key limit exceeded" errors
✅ Device status shows "online" in dashboard
✅ Pod status is "Running"

## Known Issues to Watch For

1. **Dual Device Creation** (Bug #7 fix verification)
   - Symptom: Two devices created, one with NULL device_name
   - Cause: Agent ignoring DEVICE_UUID env var
   - Fix Status: Should be fixed in latest agent image

2. **Provisioning Key Already Consumed**
   - Symptom: "Provisioning key limit exceeded" error
   - Cause: Dashboard might increment key counter when creating device
   - Investigation: Check api/src/routes/devices.ts virtual agent path

3. **Network Connectivity**
   - Symptom: "fetch failed" in agent logs
   - Cause: Wrong API URL (localhost vs host.docker.internal)
   - Fix Status: Should be fixed in VirtualAgentDeployer

## Next Steps After Successful Test

1. Document working configuration
2. Deploy to production Kubernetes cluster
3. Update production RBAC (virtual-agent-rbac.yaml)
4. Update agent image registry for production
5. Configure monitoring and alerting
