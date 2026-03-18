# Sensor Status Badge System

## Overview

The sensor status badge system provides clear, real-time visibility into the state of each sensor endpoint. The system tracks three key dimensions: **desired state** (what the user wants), **actual state** (what's running on the device), and **deployment state** (the sync process between them).

## Core Concepts

### 1. State Fields

#### `enabled` (Boolean - Desired State)
- **Location**: `endpoints.enabled` column
- **Updated**: Immediately when user toggles the switch
- **Meaning**: What the user **wants** - the target configuration
- **Examples**:
  - `enabled: true` → User wants sensor running
  - `enabled: false` → User wants sensor stopped

#### `health_connected` (Boolean - Actual State) ✅ **SOURCE OF TRUTH**
- **Location**: `endpoints.health_connected` column
- **Updated**: By agent when reporting runtime state
- **Meaning**: What's **actually running** on the device right now
- **Examples**:
  - `health_connected: true` → Sensor is actively polling/running
  - `health_connected: false` → Sensor is stopped/offline
  - `health_connected: null` → No health data yet (new sensor)

#### `deployment_status` (String - Sync State)
- **Location**: `endpoints.deployment_status` column
- **Updated**: During deployment/sync operations
- **Meaning**: Status of syncing desired state to actual state
- **Values**:
  - `draft` - Newly created, not saved to database yet
  - `saved-draft` - Saved to `device_target_state` but not synced to agent
  - `pending` - Deployment triggered, waiting for agent to apply changes
  - `deployed` - Agent confirmed changes applied successfully
  - `failed` - Deployment failed (error occurred)
  - `reconciling` - Agent is reconciling differences

## Status Badge Priority Hierarchy

The badge system follows a strict priority order to show the most important information first:

### Priority 1: Deployment Lifecycle (Highest)
Shows states that require user action or indicate deployment is in progress.

1. **Draft** (Gray)
   - Condition: `deployment_status === 'draft'`
   - Meaning: Sensor created in UI but not saved to database
   - User Action: Click "Save Draft" to persist

2. **Draft (Saved)** (Gray)
   - Condition: `deployment_status === 'saved-draft'`
   - Meaning: Saved to `device_target_state` but not synced to agent
   - User Action: Click "Sync" to deploy

3. **Deploying** (Blue) ⭐
   - Condition: `deployment_status === 'pending'`
   - Meaning: Sync triggered, agent is applying changes
   - User Action: Wait for agent to complete

4. **Deploy Failed** (Red)
   - Condition: `deployment_status === 'failed'`
   - Meaning: Agent could not apply configuration
   - User Action: Check error, fix issue, retry

5. **Reconciling** (Teal)
   - Condition: `deployment_status === 'reconciling'`
   - Meaning: Agent detected drift, reconciling state
   - User Action: None (automatic)

### Priority 2: Out-of-Sync Detection
Shows when desired state doesn't match actual state.

6. **Needs Sync** (Yellow) ⚠️
   - Condition: `(enabled && health_connected === false) || (!enabled && health_connected === true)`
   - Meaning: User's toggle setting doesn't match what's running on device
   - User Action: Click "Sync" to align states
   - Examples:
     - User disabled sensor but agent still has it running
     - User enabled sensor but agent hasn't started it yet

### Priority 3: Disabled State
Shows when sensor is intentionally turned off.

7. **Disabled** (Gray)
   - Condition: `!enabled` (and in sync)
   - Meaning: User turned off sensor, agent confirmed it's stopped
   - User Action: Toggle ON to enable

### Priority 4: Health Status (Lowest - Only for Enabled Sensors)
Shows operational health for sensors that should be running.

8. **Error** (Red)
   - Condition: `enabled && (lastError || errorCount > 0)`
   - Meaning: Sensor enabled but experiencing errors
   - User Action: Investigate error details

9. **Active** (Green) ✅
   - Condition: `enabled && health_connected === true && healthy === true`
   - Meaning: Sensor running and functioning correctly
   - User Action: None (healthy state)

10. **Offline** (Orange)
    - Condition: `enabled && (health_connected === false || !healthy)`
    - Meaning: Sensor should be running but is not responding
    - User Action: Check connection, device status

## Deployment Flow

### Scenario 1: Disabling a Sensor

```
Initial State:
  enabled: true
  health_connected: true
  deployment_status: deployed
  Badge: "Active" (green)

User clicks toggle OFF:
  enabled: false                    ← Database updated immediately
  health_connected: true             ← Agent still has it running (not updated yet)
  deployment_status: deployed        ← Still deployed
  Badge: "Needs Sync" (yellow)       ← Detected mismatch!

User clicks "Sync":
  enabled: false
  health_connected: true             ← Still running
  deployment_status: pending         ← Marked as pending (out-of-sync detected)
  Badge: "Deploying" (blue)

Agent stops sensor and reports back:
  enabled: false
  health_connected: false            ← Agent confirms stopped
  deployment_status: deployed        ← Marked as deployed
  Badge: "Disabled" (gray)           ← In sync, disabled
```

### Scenario 2: Enabling a Sensor

```
Initial State:
  enabled: false
  health_connected: false
  deployment_status: deployed
  Badge: "Disabled" (gray)

User clicks toggle ON:
  enabled: true                      ← Database updated immediately
  health_connected: false            ← Agent still has it stopped
  deployment_status: deployed
  Badge: "Needs Sync" (yellow)       ← Detected mismatch!

User clicks "Sync":
  enabled: true
  health_connected: false            ← Still stopped
  deployment_status: pending         ← Marked as pending
  Badge: "Deploying" (blue)

Agent starts sensor and reports back:
  enabled: true
  health_connected: true             ← Agent confirms running
  deployment_status: deployed
  Badge: "Active" (green) or "Offline" (orange)  ← Based on actual connectivity
```

### Scenario 3: Adding a New Sensor

```
User adds sensor in UI (not saved yet):
  (Only in React state, not in database)
  deployment_status: draft
  Badge: "Draft" (gray)

User clicks "Save Draft":
  (Saved to device_target_state table)
  deployment_status: saved-draft
  Badge: "Draft (Saved)" (gray)

User clicks "Sync":
  (Copied to endpoints table)
  enabled: true
  health_connected: null             ← No health data yet
  deployment_status: pending
  Badge: "Deploying" (blue)

Agent creates sensor and reports back:
  enabled: true
  health_connected: true             ← Agent confirms running
  deployment_status: deployed
  Badge: "Active" (green) or "Offline" (orange)
```

## Out-of-Sync Detection Logic

The system detects out-of-sync situations by comparing desired state vs actual state:

```typescript
// In api/src/services/device-endpoints.ts (syncConfigToTable)

// Get existing sensor from database
const existing = existingByUuid.get(endpoint.uuid);

// Detect configuration changes (enabled, poll_interval, connection, data_points)
const hasChanged = !existing || 
  existing.enabled !== endpoint.enabled ||
  existing.poll_interval !== endpoint.pollInterval ||
  JSON.stringify(existing.connection) !== JSON.stringify(endpoint.connection) ||
  JSON.stringify(existing.data_points) !== JSON.stringify(endpoint.dataPoints);

// Detect out-of-sync: enabled state doesn't match agent's actual state
const isOutOfSync = existing && 
  existing.health_connected !== null && 
  existing.enabled !== existing.health_connected;

// Mark as 'pending' if changed OR out of sync
const deploymentStatus = isReconciliation 
  ? 'deployed' 
  : (hasChanged || isOutOfSync ? 'pending' : existing?.deployment_status || 'deployed');
```

### Why This Matters

**Without out-of-sync detection:**
- User disables sensor → Database updated to `enabled: false`
- Click "Sync" → Compares config (enabled: false) with database (enabled: false)
- No change detected → Deployment status stays "deployed"
- Badge shows "Disabled" even though agent still has it running ❌

**With out-of-sync detection:**
- User disables sensor → Database updated to `enabled: false`
- Click "Sync" → Compares `enabled: false` with `health_connected: true`
- Mismatch detected → `isOutOfSync = true`
- Deployment status set to "pending"
- Badge shows "Deploying" (blue) ✅

## Badge Color Scheme

| Badge | Color | Hex | Meaning |
|-------|-------|-----|---------|
| Draft | Gray | `bg-zinc-700` | Not yet saved/synced |
| Draft (Saved) | Gray | `bg-zinc-700` | Saved but not deployed |
| Deploying | Blue | `bg-blue-500` | Sync in progress |
| Needs Sync | Yellow | `#ca8a04` | Out of sync, action needed |
| Disabled | Gray | `bg-gray-500` | Intentionally turned off |
| Active | Green | `bg-green-500` | Healthy and running |
| Offline | Orange | `bg-orange-500` | Should be running but isn't |
| Error | Red | `bg-red-500` | Experiencing errors |
| Deploy Failed | Dark Red | `bg-red-600` | Deployment failed |
| Reconciling | Teal | `bg-teal-500` | Auto-reconciliation |

**Color Logic:**
- **Yellow**: Action required (Needs Sync - matches Sync button color)
- **Blue**: Process in progress (Deploying)
- **Green**: Success/healthy state (Active)
- **Orange**: Warning/degraded state (Offline)
- **Red**: Error/failure state (Error, Deploy Failed)
- **Gray**: Neutral/disabled state (Draft, Disabled)
- **Teal**: System operation (Reconciling)

## Frontend Badge Logic

```typescript
// dashboard/src/pages/SensorsPage.tsx

const getStatusBadge = (sensor: Sensor) => {
  const deploymentStatus = sensor.deploymentStatus;
  
  // Priority 1: Deployment lifecycle (highest priority)
  if (deploymentStatus === 'draft') return <Badge>Draft</Badge>;
  if (deploymentStatus === 'saved-draft') return <Badge>Draft (Saved)</Badge>;
  if (deploymentStatus === 'pending') return <Badge>Deploying</Badge>;
  if (deploymentStatus === 'failed') return <Badge>Deploy Failed</Badge>;
  if (deploymentStatus === 'reconciling') return <Badge>Reconciling</Badge>;
  
  // Priority 2: Out-of-sync detection
  const needsSync = 
    (sensor.enabled && sensor.state === 'DISCONNECTED' && deploymentStatus === 'deployed') ||
    (!sensor.enabled && sensor.state === 'CONNECTED' && deploymentStatus === 'deployed');
  
  if (needsSync) return <span style={{...}}>Needs Sync</span>;
  
  // Priority 3: Disabled state
  if (!sensor.enabled) return <Badge>Disabled</Badge>;
  
  // Priority 4: Health status (only for enabled sensors)
  if (sensor.lastError || errorCount > 0) return <Badge>Error</Badge>;
  if (sensor.state === 'CONNECTED' && sensor.healthy) return <Badge>Active</Badge>;
  if (!sensor.healthy || sensor.state === 'DISCONNECTED') return <Badge>Offline</Badge>;
  
  return <Badge>Unknown</Badge>;
};
```

## Key Takeaways

1. **`health_connected` is the source of truth** for what's actually running on the device
2. **`enabled` is the desired state** set by the user
3. **Out-of-sync detection** compares enabled vs health_connected to trigger deployments
4. **Badge priority** ensures the most important information is always shown first
5. **"Needs Sync" appears when** enabled ≠ health_connected (even if database is updated)
6. **Symmetric behavior** - works the same for enabling and disabling sensors

## Database Schema

```sql
CREATE TABLE endpoints (
  -- Identity
  id SERIAL PRIMARY KEY,
  uuid UUID UNIQUE,
  device_uuid UUID REFERENCES devices(uuid),
  name VARCHAR(255),
  protocol VARCHAR(50),
  
  -- Configuration (Desired State)
  enabled BOOLEAN DEFAULT true,           -- What user wants
  poll_interval INTEGER,
  connection JSONB,
  data_points JSONB,
  
  -- Deployment Tracking
  deployment_status VARCHAR(50),          -- draft, pending, deployed, failed
  last_deployed_at TIMESTAMPTZ,
  deployment_error TEXT,
  
  -- Health Data (Actual State) - Updated by Agent
  health_status VARCHAR(50),              -- connected, disconnected, error, disabled
  health_connected BOOLEAN,               -- What's actually running (SOURCE OF TRUTH)
  health_last_poll TIMESTAMPTZ,
  health_error_count INTEGER,
  health_last_error TEXT,
  health_updated_at TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

## Agent Integration

### Agent Reports State

```typescript
// Agent collects endpoint health
const endpointsHealth = await endpoints.getAllDeviceStatuses();

// Example health data
{
  "temperature-sensor": {
    "protocol": "modbus",
    "status": "connected",           // or "disconnected", "error", "disabled"
    "connected": true,               // boolean state
    "lastPoll": "2026-01-17T10:30:00Z",
    "errorCount": 0,
    "lastError": null
  }
}

// Send to cloud API
await cloudSync.reportState({
  endpointsHealth
});
```

### API Updates Health

```typescript
// api/src/services/device-endpoints.ts

await updateEndpointHealth(deviceUuid, endpointsHealth);

// Updates endpoints table:
// - health_status = status
// - health_connected = connected
// - health_last_poll = lastPoll
// - health_error_count = errorCount
// - health_last_error = lastError
// - health_updated_at = NOW()
```

## Testing Scenarios

### Test 1: Disable Sensor
1. Start with sensor enabled and running (Active badge)
2. Toggle OFF → Badge should show "Needs Sync" (yellow)
3. Click "Sync" → Badge should show "Deploying" (blue)
4. Wait for agent → Badge should show "Disabled" (gray)

### Test 2: Enable Sensor
1. Start with sensor disabled (Disabled badge)
2. Toggle ON → Badge should show "Needs Sync" (yellow)
3. Click "Sync" → Badge should show "Deploying" (blue)
4. Wait for agent → Badge should show "Active" (green) or "Offline" (orange)

### Test 3: Add New Sensor
1. Click "Add Sensor" → Badge shows "Draft" (gray)
2. Click "Save Draft" → Badge shows "Draft (Saved)" (gray)
3. Click "Sync" → Badge shows "Deploying" (blue)
4. Wait for agent → Badge shows "Active" or "Offline"

### Test 4: Agent Stops Responding
1. Sensor is running (Active badge)
2. Agent loses connection to sensor
3. Agent reports `health_connected: false`
4. Badge changes to "Offline" (orange)
5. User doesn't need to do anything - agent will auto-reconnect

## Common Issues

### Issue: Toggle switch doesn't trigger "Deploying" badge
**Symptom**: Click toggle, badge shows "Disabled" but never "Deploying"

**Cause**: Out-of-sync detection not working (missing `health_connected` comparison)

**Fix**: Ensure `syncConfigToTable()` checks `isOutOfSync`:
```typescript
const isOutOfSync = existing && existing.health_connected !== null && 
  existing.enabled !== existing.health_connected;
```

### Issue: Badge stuck on "Deploying"
**Symptom**: Badge shows "Deploying" forever

**Possible Causes**:
1. Agent not running → Check agent status
2. Agent not reporting state → Check agent logs
3. Deployment failed silently → Check `deployment_error` column

**Debug**:
```sql
SELECT name, enabled, health_connected, deployment_status, deployment_error
FROM endpoints 
WHERE device_uuid = '<uuid>';
```

### Issue: "Needs Sync" appears unexpectedly
**Symptom**: Badge shows "Needs Sync" when everything seems in sync

**Cause**: Actual state (`health_connected`) doesn't match desired state (`enabled`)

**Expected Behavior**: This is correct! It means the agent's state is out of sync with the user's toggle setting. Click "Sync" to align them.

---

**Document Version**: 1.0  
**Last Updated**: January 17, 2026  
**Related Files**:
- `api/src/services/device-endpoints.ts` - Sync logic and out-of-sync detection
- `dashboard/src/pages/SensorsPage.tsx` - Badge rendering logic
- `api/database/migrations/125_add_endpoint_health_to_endpoints.sql` - Health columns
