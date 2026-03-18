# Device Soft Delete Pattern with Agent Reconciliation

## Overview

Device deletion in the IoT platform uses a **soft delete pattern with agent reconciliation** to ensure devices are properly stopped before being removed from the system. This prevents orphaned processes and ensures clean state synchronization between the cloud and edge devices.

## The Problem

Hard delete (immediate removal) causes issues:
- Device removed from target state immediately
- Agent continues polling the device until next sync
- No confirmation that agent actually stopped the device
- Potential for orphaned processes or inconsistent state
- Race conditions between database and agent state

## The Solution: Soft Delete with Reconciliation

### Step-by-Step Flow

```
1. User clicks "Delete" in Dashboard
   ↓
2. API marks device with deployment_status='pending_deletion'
   - Device kept in database with enabled=false
   - Version incremented (triggers agent sync)
   - Target state version bumped to notify agent
   ↓
3. Agent picks up new target state
   - Sees device marked for deletion
   - Stops polling the device
   - Removes from current state
   ↓
4. Agent reports current state (next sync cycle)
   - Device no longer in endpoints list
   ↓
5. API detects device stopped (reconciliation)
   - Device is pending_deletion + NOT in agent state
   - Hard delete triggered automatically
   - Removed from database and target state config
```

## Implementation Details

### API Endpoints

#### DELETE /api/v1/devices/:uuid/sensors/:name (Soft Delete)

**File**: `api/src/routes/device-sensors.ts`

```typescript
router.delete('/devices/:uuid/sensors/:name', async (req, res) => {
  // Calls deviceSensorSync.deleteEndpoint()
  // Returns: { status: 'pending_deletion', message: '...' }
});
```

**Service**: `api/src/services/device-endpoints.ts`

```typescript
async deleteEndpoint(deviceUuid, sensorIdentifier, userId) {
  // 1. Find sensor to delete
  // 2. Mark deployment_status='pending_deletion' in database
  // 3. Set enabled=false
  // 4. Increment target state version
  // 5. Publish 'device_sensor.pending_deletion' event
  // 6. Return pending status
}
```

### Hard Delete (Reconciliation Triggered)

**Service**: `api/src/services/device-endpoints.ts`

```typescript
async hardDeleteEndpoint(deviceUuid, sensorIdentifier, userId) {
  // 1. Remove from target state config.endpoints
  // 2. Delete from endpoints table
  // 3. Increment version
  // 4. Publish 'device_sensor.deleted' event
}
```

### Reconciliation Logic

**Service**: `api/src/services/device-endpoints.ts`

```typescript
async syncCurrentStateToTable(deviceUuid, currentState) {
  // 1. Sync agent's current state to table
  
  // 2. CRITICAL: Check for pending_deletion devices
  const pendingDeletion = await query(
    `SELECT uuid, name FROM endpoints 
     WHERE device_uuid = $1 AND deployment_status = 'pending_deletion'`
  );
  
  // 3. If device is pending_deletion AND NOT in agent's state → hard delete
  for (const device of pendingDeletion.rows) {
    if (!agentEndpointNames.has(device.name)) {
      await this.hardDeleteEndpoint(deviceUuid, device.uuid, 'agent-reconciliation');
    }
  }
}
```

## Database Schema

### deployment_status Values

```typescript
type DeploymentStatus = 
  | 'pending'           // Waiting for initial deployment
  | 'deployed'          // Successfully deployed and running
  | 'reconciling'       // Agent is applying changes
  | 'failed'            // Deployment failed
  | 'discovered'        // Agent found device (initial state)
  | 'pending_deletion'  // Marked for deletion, waiting for agent to stop
  | 'draft'             // Not yet saved
  | 'saved-draft';      // Saved but not deployed
```

### Key Fields

```sql
CREATE TABLE endpoints (
  id SERIAL PRIMARY KEY,
  device_uuid UUID NOT NULL,
  uuid UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  deployment_status VARCHAR(50),  -- 'pending_deletion' marks for soft delete
  enabled BOOLEAN,                 -- Set to false when pending_deletion
  -- ... other fields
);
```

## Dashboard UI

### Visual Indicators

**File**: `dashboard/src/pages/SensorsPage.tsx`

```typescript
// Badge shows "Pending Deletion" status
if (deploymentStatus === 'pending_deletion') {
  return (
    <Badge className="bg-orange-600 text-white">
      Pending Deletion
    </Badge>
  );
}

// Status message
{sensor.deploymentStatus === 'pending_deletion' && (
  <div className="text-orange-600">
    Marked for deletion - Click Sync to confirm removal on agent
  </div>
)}

// Edit button disabled
<Button
  disabled={sensor.deploymentStatus === 'pending_deletion'}
>
  Edit
</Button>
```

### Delete Handler

```typescript
const handleDeleteProtocolDevice = async (deviceName: string) => {
  // 1. Call DELETE API (soft delete)
  const response = await fetch(`/api/devices/${uuid}/sensors/${deviceName}`, {
    method: 'DELETE'
  });
  
  // 2. Refresh sensor list (shows pending_deletion status)
  await fetchSensors();
  
  // 3. Notify user to click Sync
  toast.success('Sensor marked for deletion - Click Sync to confirm on agent');
};
```

## Agent Side Handling

### Expected Behavior

When agent receives target state with `pending_deletion` device:

1. **Detect deletion**: Device exists in current state but marked for deletion
2. **Stop polling**: Gracefully stop the protocol adapter
3. **Remove from state**: Remove from `current_state.config.endpoints`
4. **Report state**: Send updated current state to cloud (without deleted device)
5. **Cloud detects**: API sees device missing from agent state → triggers hard delete

### Implementation Requirements

**File**: `agent/src/features/endpoints/state-reconciler.ts` (or similar)

```typescript
async reconcileEndpoints(targetEndpoints: Endpoint[], currentEndpoints: Endpoint[]) {
  // 1. Identify devices marked for deletion
  const toDelete = currentEndpoints.filter(current => {
    const target = targetEndpoints.find(t => t.uuid === current.uuid);
    return target?.deploymentStatus === 'pending_deletion';
  });
  
  // 2. Stop each device
  for (const device of toDelete) {
    await protocolManager.stopDevice(device.uuid);
    logger.info(`Stopped device "${device.name}" (pending_deletion)`);
  }
  
  // 3. Remove from current state
  const newState = currentEndpoints.filter(
    e => !toDelete.find(d => d.uuid === e.uuid)
  );
  
  // 4. Report updated state to cloud
  await reportCurrentState(newState);
}
```

## Workflow Diagrams

### User Deletes Device

```
User → Dashboard → API → Database
                     ↓
              Mark pending_deletion
                     ↓
              Increment version
                     ↓
              needs_deployment=true
```

### Agent Sync Cycle

```
Agent polls target state
       ↓
Sees pending_deletion device
       ↓
Stops protocol adapter
       ↓
Removes from current state
       ↓
Reports current state to cloud
       ↓
API reconciliation detects missing device
       ↓
Hard delete triggered
       ↓
Removed from database & config
```

## Testing Scenarios

### Scenario 1: Normal Delete

1. User deletes Modbus device "power_meter_1"
2. UI shows "Pending Deletion" badge
3. Edit button disabled
4. User clicks "Sync" button
5. Agent stops polling power_meter_1
6. Agent reports state without power_meter_1
7. API auto-deletes from database
8. UI refreshes, device gone

### Scenario 2: Agent Offline During Delete

1. User deletes device while agent offline
2. Device marked `pending_deletion` in database
3. UI shows "Pending Deletion" badge
4. Agent comes back online
5. Agent syncs target state
6. Agent stops device and reports state
7. API hard deletes on next reconciliation

### Scenario 3: Concurrent Delete

1. User deletes device A
2. Before agent syncs, user deletes device B
3. Both marked `pending_deletion`
4. Agent syncs once, sees both
5. Agent stops both devices
6. Agent reports state without A or B
7. API hard deletes both in same reconciliation

## Benefits

1. **Clean State**: Agent confirms device stopped before removal
2. **No Orphans**: Protocol adapters properly shut down
3. **Audit Trail**: Deletion tracked through deployment_status
4. **User Feedback**: Clear UI indication of deletion in progress
5. **Resilient**: Works even if agent is offline (deletion happens on next sync)
6. **Atomic**: Hard delete only happens after agent confirmation

## Edge Cases

### Device Never Stops

If agent fails to stop device (e.g., protocol error):
- Device remains `pending_deletion` indefinitely
- Agent keeps reporting it in current state
- Hard delete never triggered
- **Solution**: Implement timeout or manual cleanup job

### Agent Reports Device After Deletion

If agent resurrects device (e.g., auto-discovery):
- Device gets re-added as 'discovered'
- User needs to delete again
- **Prevention**: Disable auto-discovery for deleted devices

### Multiple Agents (Future)

For multi-agent scenarios:
- Each agent has independent current state
- Deletion only completes when ALL agents confirm stopped
- Requires tracking per-agent reconciliation

## Migration Notes

### Existing Hard Delete Code

The old `deleteEndpoint` method performed:
```typescript
// OLD: Hard delete (removed)
config.endpoints = existingDevices.filter(d => d.uuid !== uuid);
await syncConfigToTable(deviceUuid, existingDevices, ...); // Deletes from table
```

**Migration**: Existing code replaced with soft delete pattern. No database migration needed - `deployment_status` column already exists.

### API Response Change

**Before**:
```json
{ "version": 123, "status": "ok" }
```

**After**:
```json
{ 
  "version": 124, 
  "status": "pending_deletion",
  "message": "Sensor marked for deletion - will be removed after agent confirmation"
}
```

## Future Enhancements

1. **Deletion Timeout**: Auto-cleanup after 24h if agent never confirms
2. **Force Delete API**: Emergency hard delete without waiting
3. **Bulk Delete**: Delete multiple devices in one operation
4. **Deletion Events**: Webhook notifications for deletion lifecycle
5. **Audit Logging**: Track who deleted, when, and confirmation timestamp

---

**Status**: ✅ Implemented  
**Version**: 1.0  
**Last Updated**: 2026-01-21  
**Related Files**:
- `api/src/services/device-endpoints.ts` - Soft delete + hard delete logic
- `api/src/routes/device-sensors.ts` - DELETE endpoint
- `dashboard/src/pages/SensorsPage.tsx` - UI delete handler
- `dashboard/src/components/sensors/EditSensorDialog.tsx` - Delete button
