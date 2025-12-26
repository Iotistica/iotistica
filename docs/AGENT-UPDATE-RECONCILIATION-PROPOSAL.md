# Agent Update Reconciliation Proposal

**Status**: Proposal  
**Version**: 1.0  
**Date**: 2025-01-23  
**Author**: AI Assistant

## Executive Summary

Proposes migrating from imperative command-style agent updates (MQTT commands) to declarative reconciliation-based updates (desired state synchronization). This aligns agent updates with the existing StateReconciler pattern used for container orchestration, enabling self-healing, automatic retries, and simplified state management.

## Current Architecture (Command-Style)

### How It Works

1. **Cloud sends MQTT command**:
   ```json
   {
     "action": "update",
     "version": "1.0.230",
     "issued_at": 1737678000,
     "expires_at": 1737681600,
     "signature": "hmac-sha256...",
     "scheduled_time": "2025-01-24T02:00:00Z",
     "force": false
   }
   ```

2. **Agent receives** on `iot/device/{uuid}/agent/update` topic

3. **AgentUpdater validates**:
   - Signature verification (HMAC-SHA256)
   - Version format (semver)
   - Downgrade protection
   - Rate limiting (24-hour window)
   - Pre-flight checks (disk, connectivity, power)

4. **Update executes**:
   - Spawn update script
   - systemd restarts agent
   - Status file written on success

### Strengths

- ✅ Production-hardened security (signature verification, integrity checks)
- ✅ Pre-flight validation (disk space, connectivity, power)
- ✅ Persistent scheduling (survives restarts)
- ✅ Rate limiting (24-hour cooldown)
- ✅ Status tracking (`update-status.json`)

### Weaknesses

- ❌ **One-shot execution**: If agent offline when command sent, update missed
- ❌ **No self-healing**: Failed updates require manual intervention
- ❌ **Stateless**: No persistent desired state in database
- ❌ **MQTT dependency**: Requires broker connectivity
- ❌ **Inconsistent with containers**: Containers use reconciliation, updates use commands

## Proposed Architecture (Reconciliation-Style)

### How It Works

1. **Cloud sets desired state** in `device_target_state.config.agent` field:
   ```json
   {
     "apps": { /* container apps */ },
     "config": {
       "agent": {
         "version": "1.0.230",
         "update_scheduled_at": "2025-01-24T02:00:00Z",
         "update_force": false,
         "update_signature": "hmac-sha256..."
       },
       "endpoints": [ /* existing endpoints */ ],
       "intervals": { /* existing intervals */ },
       "logging": { /* existing logging */ }
     }
   }
   ```

2. **Agent polls target state** via CloudSync (existing 60s interval)

3. **StateReconciler compares** current vs desired agent version

4. **AgentUpdater reconciles**:
   - If `current_version != target_version` → trigger update
   - Reuses existing security checks (signature, pre-flight, rate limit)
   - Respects `update_scheduled_at` for delayed execution
   - Honors `update_force` to override downgrade protection

5. **Self-healing loop**:
   - If update fails, next reconciliation retry automatically
   - Agent reports current version in state
   - Backend compares reported vs desired
   - Dashboard shows drift/reconciliation status

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│ Cloud API (device_target_state)                                    │
│ ┌───────────────────────────────────────────────────────────────┐   │
│ │ {                                                             │   │
│ │   "apps": { "1001": {...} },                                 │   │
│ │   "config": {                                                 │   │
│ │     "agent": {                                                │   │
│ │       "version": "1.0.230",          ← Desired agent version │   │
│ │       "update_scheduled_at": "...",  ← Schedule (optional)   │   │
│ │       "update_force": false,         ← Override checks       │   │
│ │       "update_signature": "..."      ← HMAC verification     │   │
│ │     }                                                         │   │
│ │   }                                                           │   │
│ │ }                                                             │   │
│ └───────────────────────────────────────────────────────────────┘   │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           │ 1. GET /api/v1/device/:uuid/state (60s poll)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Agent (Device)                                                      │
│                                                                     │
│ ┌─────────────────────┐                                            │
│ │ CloudSync           │ 2. Fetch target state                      │
│ │ - Poll: 60s         │    (ETag cached, no download if unchanged) │
│ └──────────┬──────────┘                                            │
│            │                                                        │
│            │ 3. Pass to StateReconciler                            │
│            ▼                                                        │
│ ┌─────────────────────┐                                            │
│ │ StateReconciler     │ 4. Delegate reconciliation                 │
│ │ - Containers        │ ──────────────┐                            │
│ │ - Config            │               │                            │
│ │ - Agent Version ◄───┼───────────────┘                            │
│ └──────────┬──────────┘                                            │
│            │                                                        │
│            │ 5. Reconcile agent version                            │
│            ▼                                                        │
│ ┌─────────────────────┐                                            │
│ │ AgentUpdater        │ 6. Compare versions                        │
│ │                     │    current: 1.0.229                        │
│ │                     │    target:  1.0.230                        │
│ │                     │    action:  UPDATE NEEDED                  │
│ │                     │                                            │
│ │ 7. Run Security Checks:                                         │
│ │    - Signature verification (HMAC-SHA256)                       │
│ │    - Rate limiting (24-hour window)                             │
│ │    - Pre-flight (disk, connectivity, power)                     │
│ │    - Scheduled time check (defer if not yet)                    │
│ │                                                                 │
│ │ 8. Execute Update:                                              │
│ │    - Spawn update script                                        │
│ │    - systemd restarts agent                                     │
│ │    - Status file written                                        │
│ └─────────────────────┘                                            │
│            │                                                        │
│            │ 9. Report current state                               │
│            ▼                                                        │
│ ┌─────────────────────┐                                            │
│ │ DeviceState Report  │ 10. PATCH /api/v1/device/:uuid/state       │
│ │ {                   │     { agent_version: "1.0.230" }           │
│ │   agent_version,    │                                            │
│ │   apps,             │                                            │
│ │   metrics           │                                            │
│ │ }                   │                                            │
│ └─────────────────────┘                                            │
└──────────────────────────────────────────────────────────────────┬─┘
                           │
                           │ 11. Update devices.agent_version
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│ Backend Verification                                                │
│ - Compare devices.agent_version (actual) vs                         │
│   device_target_state.config.agent.version (desired)                │
│ - Dashboard shows drift status                                      │
│ - Alert if reconciliation fails repeatedly                          │
└─────────────────────────────────────────────────────────────────────┘
```

## Implementation Plan

### Phase 1: Foundation (1-2 days)

**Goal**: Enable agent to report current version, fix "unknown" issue

#### 1.1 Add Version to Agent State Reports

**File**: `agent/src/device-manager/sync.ts`

**Change**: Include `agent_version` in device state reports

```typescript
// Lines 1100-1140: buildDeviceStateReport()
private buildDeviceStateReport(): DeviceStateReport {
  const deviceInfo = this.deviceManager.getDeviceInfo();
  const currentState = this.stateReconciler.getCurrentState();
  
  // Get agent version from AgentUpdater
  const agentVersion = this.agentUpdater.getCurrentVersion();
  
  return {
    [deviceInfo.uuid]: {
      apps: currentState.apps,
      config: currentState.config,
      version: this.currentVersion,
      
      // Add agent version
      agent_version: agentVersion,  // ← NEW
      
      // Metrics (existing)
      cpu_usage: metrics.cpu_usage,
      memory_usage: metrics.memory_usage,
      // ... rest of metrics
    }
  };
}
```

**New dependency**: Pass `AgentUpdater` instance to `CloudSync` constructor

```typescript
// agent/src/agent.ts (line 1003)
this.cloudSync = new CloudSync(
  this.stateReconciler,
  this,
  {
    cloudApiEndpoint: this.config.cloudApiEndpoint,
    pollInterval: this.config.targetStatePollIntervalMs,
    reportInterval: this.config.deviceReportIntervalMs,
    metricsInterval: this.config.metricsIntervalMs,
  },
  this.logger,
  this.agentUpdater  // ← NEW: Pass updater instance
);
```

**Update CloudSync constructor**:

```typescript
// agent/src/device-manager/sync.ts (line 183)
constructor(
  stateReconciler: StateReconciler,
  deviceManager: DeviceManager,
  config: CloudSyncConfig,
  logger?: AgentLogger,
  httpClient?: HttpClient,
  agentUpdater?: AgentUpdater  // ← NEW
) {
  super();
  this.stateReconciler = stateReconciler;
  this.deviceManager = deviceManager;
  this.logger = logger;
  this.agentUpdater = agentUpdater;  // ← NEW
  // ... rest of constructor
}
```

**Add public method to AgentUpdater**:

```typescript
// agent/src/updater.ts
public getCurrentVersion(): string {
  return this.detectBinaryVersion();
}
```

**Expected Outcome**: Backend `devices.agent_version` field populated correctly (fixes "unknown")

#### 1.2 Cloud-Controlled Agent Version Policy

**Design Decision**: Use `system_config` table (cloud state), not env vars

**Why**: 
- ✅ Cloud can change policy without redeploying devices
- ✅ Single source of truth for version requirements
- ✅ Bootstrap (provisioning) reads from same source
- ❌ Env vars are static, tied to deployment, hard to rotate

**Migration**: `api/database/migrations/109_add_required_agent_version.sql`

```sql
INSERT INTO system_config (config_key, config_value)
VALUES ('required_agent_version', '1.0.230')
ON CONFLICT (config_key) DO NOTHING;
```

**Provisioning Logic**: `api/src/services/provisioning.service.ts`

```typescript
private async createDefaultTargetState(deviceUuid: string, agentVersion?: string): Promise<void> {
  const targetState = await DeviceTargetStateModel.get(deviceUuid);
  if (!targetState) {
    const licenseData = await configService.get('license_data');
    const { apps, config } = await generateDefaultTargetStateV2(licenseData);
    
    // Get required version from cloud policy (NOT env var)
    const requiredAgentVersion = await configService.get('required_agent_version');
    
    // Set target to required version (cloud authority, not agent's current)
    config.agent = {
      version: requiredAgentVersion || agentVersion || 'latest'
    };
    
    // Log warning if mismatch (agent will auto-update on first poll)
    if (requiredAgentVersion && agentVersion && requiredAgentVersion !== agentVersion) {
      logger.warn('Agent version mismatch at provisioning', {
        deviceUuid,
        agentVersion,
        requiredVersion: requiredAgentVersion,
        action: 'will_auto_update_on_first_poll'
      });
    }
    
    await DeviceTargetStateModel.set(deviceUuid, apps, config, false);
  }
}
```

**Flow**:
```
1. Agent provisions: "I'm 1.0.220"
2. Cloud reads: required_agent_version = "1.0.230"
3. Cloud sets: target_state.config.agent.version = "1.0.230"
4. Provisioning succeeds (no rejection)
5. Agent polls (60s) → sees desired 1.0.230 ≠ current 1.0.220
6. Phase 2 reconciles → auto-update
```

**To update policy** (no redeployment needed):
```sql
UPDATE system_config 
SET config_value = '1.0.231', updated_at = NOW() 
WHERE config_key = 'required_agent_version';

-- All new provisions will now require 1.0.231
-- Existing devices: update their target_state manually or via bulk update
```

**Expected Outcome**: Cloud controls version policy, agents auto-update to comply

#### 1.3 API Endpoint for Setting Desired Agent Version

**File**: `api/src/routes/devices.ts`

**New endpoint**: `PUT /api/v1/devices/:uuid/agent-version`

```typescript
/**
 * Set desired agent version (reconciliation-based update)
 * PUT /api/v1/devices/:uuid/agent-version
 * Body: {
 *   version: "1.0.230",
 *   scheduled_at?: "2025-01-24T02:00:00Z",
 *   force?: false
 * }
 */
router.put('/devices/:uuid/agent-version', async (req, res) => {
  try {
    const { uuid } = req.params;
    const { version, scheduled_at, force = false } = req.body;
    
    // Validate version format (semver)
    const semverRegex = /^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/;
    if (!semverRegex.test(version)) {
      return res.status(400).json({
        error: 'Invalid version format',
        message: 'Version must be semver format (e.g., 1.0.230)'
      });
    }
    
    // Get device
    const device = await DeviceModel.getByUuid(uuid);
    if (!device) {
      return res.status(404).json({
        error: 'Device not found',
        message: `Device ${uuid} not found`
      });
    }
    
    // Get current target state
    const targetState = await DeviceTargetStateModel.get(uuid);
    if (!targetState) {
      return res.status(404).json({
        error: 'Target state not found',
        message: `No target state for device ${uuid}`
      });
    }
    
    // Generate signature (HMAC-SHA256)
    const updateSecret = process.env.AGENT_UPDATE_SECRET || 'default-secret-change-me';
    const payload = JSON.stringify({ version, scheduled_at, force });
    const signature = crypto
      .createHmac('sha256', updateSecret)
      .update(payload)
      .digest('hex');
    
    // Update target state config
    const updatedConfig = {
      ...targetState.config,
      agent: {
        version,
        update_scheduled_at: scheduled_at || null,
        update_force: force,
        update_signature: signature
      }
    };
    
    // Save to database (increments version)
    await DeviceTargetStateModel.set(uuid, targetState.apps, updatedConfig);
    
    logger.info('Agent version update scheduled', {
      deviceUuid: uuid,
      currentVersion: device.agent_version,
      targetVersion: version,
      scheduledAt: scheduled_at,
      force
    });
    
    res.json({
      success: true,
      message: 'Agent version update scheduled',
      current_version: device.agent_version,
      target_version: version,
      scheduled_at: scheduled_at || 'immediately',
      force,
      eta_seconds: scheduled_at
        ? Math.max(0, Math.floor((new Date(scheduled_at).getTime() - Date.now()) / 1000))
        : 60  // Next poll interval
    });
  } catch (error: any) {
    logger.error('Error scheduling agent update', {
      error: error.message,
      stack: error.stack,
      deviceId: req.params.uuid
    });
    res.status(500).json({
      error: 'Failed to schedule agent update',
      message: error.message
    });
  }
});
```

**Expected Outcome**: Cloud can set desired agent version via REST API

### Phase 2: Reconciliation Logic (2-3 days)

#### 2.1 Add Agent Reconciliation to StateReconciler

**File**: `agent/src/drivers/state-reconciler.ts`

**Change**: Extend `DeviceState` interface to include agent metadata

```typescript
export interface DeviceState {
  apps: { [appId: string]: any };
  config: {
    agent?: {
      version?: string;
      update_scheduled_at?: string;
      update_force?: boolean;
      update_signature?: string;
    };
    endpoints?: any[];
    intervals?: any;
    logging?: any;
    features?: any;
  };
}
```

**Add reconciliation method**:

```typescript
/**
 * Reconcile agent version with target state
 */
private async reconcileAgentVersion(targetState: DeviceState): Promise<void> {
  const agentConfig = targetState.config?.agent;
  
  if (!agentConfig || !agentConfig.version) {
    // No agent update requested
    return;
  }
  
  // Get current version from AgentUpdater
  const currentVersion = this.agentUpdater.getCurrentVersion();
  
  if (currentVersion === agentConfig.version) {
    // Already at desired version
    this.logger?.debugSync('Agent already at desired version', {
      component: LogComponents.stateReconciler,
      currentVersion,
      targetVersion: agentConfig.version
    });
    return;
  }
  
  // Delegate to AgentUpdater for reconciliation
  await this.agentUpdater.reconcileVersion({
    targetVersion: agentConfig.version,
    scheduledAt: agentConfig.update_scheduled_at,
    force: agentConfig.update_force || false,
    signature: agentConfig.update_signature
  });
}
```

**Call from setTarget**:

```typescript
async setTarget(targetState: DeviceState): Promise<void> {
  // ... existing validation
  
  // Save target state to database
  await this.persistTargetState(targetState);
  
  // Reconcile containers (existing)
  await this.containerManager.setTarget(targetState.apps);
  
  // Reconcile device config (existing)
  await this.configManager.setTarget(targetState.config);
  
  // Reconcile agent version (NEW)
  await this.reconcileAgentVersion(targetState);
  
  // Emit events (existing)
  this.emit('target-state-changed', targetState);
  this.emit('reconciliation-complete');
}
```

**Expected Outcome**: Agent reconciliation triggered when target state changes

#### 2.2 Extend AgentUpdater with Reconciliation Method

**File**: `agent/src/updater.ts`

**New method**:

```typescript
/**
 * Reconcile current version with target version (declarative updates)
 * Called by StateReconciler during reconciliation loop
 */
public async reconcileVersion(params: {
  targetVersion: string;
  scheduledAt?: string;
  force?: boolean;
  signature?: string;
}): Promise<void> {
  const { targetVersion, scheduledAt, force = false, signature } = params;
  
  this.logger?.infoSync('Reconciling agent version', {
    component: LogComponents.agent,
    operation: 'reconcile-version',
    currentVersion: this.detectBinaryVersion(),
    targetVersion,
    scheduledAt,
    force
  });
  
  // Construct equivalent MQTT update command
  // This reuses ALL existing security checks (signature, rate limit, pre-flight)
  const updateCommand = {
    action: 'update',
    version: targetVersion,
    issued_at: Math.floor(Date.now() / 1000),
    scheduled_time: scheduledAt,
    force,
    signature: signature || ''
  };
  
  // Delegate to existing performUpdate() method
  // This ensures identical security validation as MQTT-triggered updates
  await this.performUpdate(updateCommand);
}
```

**Key Design Decision**: Reuse existing `performUpdate()` method to ensure:
- ✅ Same signature verification
- ✅ Same rate limiting
- ✅ Same pre-flight checks
- ✅ Same scheduled time handling
- ✅ Same update script execution
- ✅ Same status file tracking

**Expected Outcome**: Reconciliation-triggered updates have identical security as MQTT updates

### Phase 3: Hybrid Model (1 day)

**Goal**: Support BOTH command-style and reconciliation-style updates

#### 3.1 Update Cloud MQTT Handler

**File**: `api/src/mqtt/handlers.ts`

**Change**: When sending MQTT update command, ALSO set target state

```typescript
/**
 * Trigger agent update via MQTT command
 * (Hybrid: Send command + set target state for reconciliation fallback)
 */
export async function triggerAgentUpdate(deviceUuid: string, version: string, options?: {
  scheduledAt?: string;
  force?: boolean;
}) {
  // Generate signature
  const updateSecret = process.env.AGENT_UPDATE_SECRET || 'default-secret-change-me';
  const payload = {
    action: 'update',
    version,
    issued_at: Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 3600,  // 1 hour
    scheduled_time: options?.scheduledAt,
    force: options?.force || false
  };
  const signature = crypto
    .createHmac('sha256', updateSecret)
    .update(JSON.stringify(payload))
    .digest('hex');
  
  const command = { ...payload, signature };
  
  // 1. Send MQTT command (existing behavior)
  const topic = `iot/device/${deviceUuid}/agent/update`;
  await mqttClient.publish(topic, JSON.stringify(command), {
    qos: 1,
    retain: true
  });
  
  // 2. Set target state (NEW: fallback for reconciliation)
  const targetState = await DeviceTargetStateModel.get(deviceUuid);
  if (targetState) {
    const updatedConfig = {
      ...targetState.config,
      agent: {
        version,
        update_scheduled_at: options?.scheduledAt || null,
        update_force: options?.force || false,
        update_signature: signature
      }
    };
    
    await DeviceTargetStateModel.set(deviceUuid, targetState.apps, updatedConfig);
    
    logger.info('Agent update triggered (hybrid mode)', {
      deviceUuid,
      version,
      mqttSent: true,
      targetStateSet: true
    });
  }
}
```

**Expected Outcome**: 
- If agent online → MQTT command executes immediately
- If agent offline → Reconciliation picks up on next poll
- Best of both worlds: instant execution + eventual consistency

### Phase 4: Dashboard Integration (1 day)

#### 4.1 Device Details Page

**File**: `dashboard/src/pages/DeviceDetailsPage.tsx`

**Add agent version status**:

```tsx
// Show current vs desired agent version
<Box>
  <Typography variant="h6">Agent Version</Typography>
  <Grid container spacing={2}>
    <Grid item xs={6}>
      <Typography variant="body2" color="textSecondary">Current</Typography>
      <Typography variant="h6">{device.agent_version || 'unknown'}</Typography>
    </Grid>
    <Grid item xs={6}>
      <Typography variant="body2" color="textSecondary">Target</Typography>
      <Typography variant="h6">
        {device.target_state?.config?.agent?.version || 'not set'}
      </Typography>
    </Grid>
  </Grid>
  
  {/* Drift indicator */}
  {device.agent_version !== device.target_state?.config?.agent?.version && (
    <Alert severity="warning" sx={{ mt: 2 }}>
      Agent version drift detected. Reconciliation in progress...
    </Alert>
  )}
  
  {/* Update button */}
  <Button
    variant="contained"
    onClick={() => handleAgentUpdate()}
    disabled={updating}
  >
    Update Agent
  </Button>
</Box>
```

**Add update handler**:

```tsx
const handleAgentUpdate = async () => {
  const version = prompt('Enter target agent version (e.g., 1.0.230):');
  if (!version) return;
  
  setUpdating(true);
  try {
    await fetch(`/api/v1/devices/${device.uuid}/agent-version`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version })
    });
    
    toast.success(`Agent update scheduled to ${version}`);
    // Refresh device details
    loadDevice();
  } catch (error) {
    toast.error(`Failed to schedule update: ${error.message}`);
  } finally {
    setUpdating(false);
  }
};
```

**Expected Outcome**: Dashboard shows drift status and allows scheduling updates

## Benefits of Reconciliation Model

### 1. Self-Healing

**Problem**: Agent offline when MQTT command sent → update missed

**Solution**: Target state persists in database, next poll picks up automatically

**Example**:
```
10:00 AM - Cloud sends MQTT update to v1.0.230
10:00 AM - Agent offline (network outage)
10:05 AM - MQTT message expires/lost
11:00 AM - Agent comes online
11:01 AM - Polls target state → sees v1.0.230 desired
11:02 AM - Reconciles → triggers update automatically
```

### 2. Eventual Consistency

**Problem**: Failed updates require manual re-trigger

**Solution**: Reconciliation loop retries automatically until success

**Example**:
```
Attempt 1 (11:00 AM): Update fails (disk space)
Attempt 2 (11:01 AM): Reconciliation retries → still fails
[Admin frees disk space]
Attempt 3 (11:02 AM): Reconciliation retries → succeeds
```

### 3. Audit Trail

**Problem**: No history of desired vs actual version over time

**Solution**: Database tracks target state changes, device reports actual version

**Example**:
```sql
SELECT 
  d.agent_version AS actual,
  dts.config->>'agent'->>'version' AS desired,
  dts.updated_at AS changed_at,
  dts.deployed_by AS changed_by
FROM devices d
JOIN device_target_state dts ON d.uuid = dts.device_uuid
WHERE d.uuid = 'abc-123';
```

### 4. Rollback Support

**Problem**: Manual rollback requires re-sending MQTT command

**Solution**: Change target state in database, reconciliation handles rest

**Example**:
```bash
# Rollback to previous version
curl -X PUT /api/v1/devices/abc-123/agent-version \
  -d '{"version": "1.0.228"}'

# Agent reconciles on next poll → rolls back automatically
```

### 5. Consistency with Container Management

**Problem**: Containers use declarative reconciliation, updates use imperative commands

**Solution**: Both use same StateReconciler pattern

**Before**:
```typescript
// Containers: Declarative (reconciliation)
stateReconciler.setTarget({ apps: {...} });

// Agent: Imperative (command)
mqtt.publish('agent/update', { version: '1.0.230' });
```

**After**:
```typescript
// BOTH: Declarative (reconciliation)
stateReconciler.setTarget({
  apps: {...},
  config: { agent: { version: '1.0.230' } }
});
```

## Security Considerations

### Signature Verification

**Challenge**: How to sign target state in database (no MQTT message)?

**Solution**: Backend generates HMAC signature when setting target state

```typescript
// Backend generates signature
const payload = JSON.stringify({ version, scheduled_at, force });
const signature = crypto.createHmac('sha256', updateSecret).update(payload).digest('hex');

// Agent verifies signature (same as MQTT)
const isValid = timingSafeEqual(
  Buffer.from(signature, 'hex'),
  Buffer.from(targetState.config.agent.update_signature, 'hex')
);
```

**Benefit**: Identical security as MQTT command-style updates

### Rate Limiting

**Challenge**: Reconciliation loop runs every 60s, could retry too frequently

**Solution**: AgentUpdater maintains 24-hour cooldown (existing logic)

```typescript
// Reconciliation attempts update
await agentUpdater.reconcileVersion({ version: '1.0.230' });

// AgentUpdater checks last successful update
if (now - lastUpdateTime < 24 * 60 * 60 * 1000) {
  throw new Error('Rate limit: 24-hour cooldown active');
}

// Next reconciliation (60s later) will retry automatically after cooldown
```

**Benefit**: Self-healing without spam, respects rate limits

### Scheduled Updates

**Challenge**: Target state is always present, how to defer execution?

**Solution**: `update_scheduled_at` field controls when update executes

```typescript
if (targetState.config.agent.update_scheduled_at) {
  const scheduledTime = new Date(targetState.config.agent.update_scheduled_at);
  if (Date.now() < scheduledTime.getTime()) {
    // Not yet time, skip update but keep checking
    logger.debug('Update scheduled for future, waiting...');
    return;
  }
}

// Time reached, proceed with update
```

**Benefit**: Scheduled updates work identically to MQTT command style

## Migration Strategy

### Phase 1: Backward Compatibility (2 weeks)

1. **Week 1**: Implement agent version reporting (fixes "unknown")
   - Agent reports version in state
   - Backend updates `devices.agent_version`
   - Dashboard shows current version

2. **Week 2**: Add reconciliation alongside MQTT commands (hybrid mode)
   - MQTT commands still work (primary method)
   - Target state set automatically (fallback)
   - No breaking changes

### Phase 2: Gradual Rollout (2 weeks)

3. **Week 3**: Enable reconciliation for 10% of devices
   - Monitor logs for issues
   - Verify self-healing works
   - Compare success rates vs MQTT-only

4. **Week 4**: Expand to 50% of devices
   - Address any edge cases
   - Tune reconciliation intervals
   - Update documentation

### Phase 3: Full Migration (1 week)

5. **Week 5**: Enable reconciliation for 100% of devices
   - Deprecate direct MQTT update commands
   - All updates via target state API
   - Keep MQTT as notification channel (optional)

### Phase 4: Cleanup (1 week)

6. **Week 6**: Remove legacy MQTT command handler
   - Update documentation
   - Remove unused code
   - Final production validation

## Testing Strategy

### Unit Tests

```typescript
describe('AgentUpdater.reconcileVersion', () => {
  it('should trigger update when version mismatch', async () => {
    const updater = new AgentUpdater(config);
    jest.spyOn(updater, 'performUpdate');
    
    await updater.reconcileVersion({
      targetVersion: '1.0.230',
      signature: 'valid-signature'
    });
    
    expect(updater.performUpdate).toHaveBeenCalledWith({
      action: 'update',
      version: '1.0.230',
      signature: 'valid-signature'
    });
  });
  
  it('should skip update when versions match', async () => {
    const updater = new AgentUpdater(config);
    jest.spyOn(updater, 'performUpdate');
    
    // Set current version
    updater.currentVersion = '1.0.230';
    
    await updater.reconcileVersion({
      targetVersion: '1.0.230'
    });
    
    expect(updater.performUpdate).not.toHaveBeenCalled();
  });
  
  it('should respect rate limiting', async () => {
    const updater = new AgentUpdater(config);
    
    // First update succeeds
    await updater.reconcileVersion({ targetVersion: '1.0.230' });
    
    // Second update within 24 hours fails
    await expect(
      updater.reconcileVersion({ targetVersion: '1.0.231' })
    ).rejects.toThrow('Rate limit');
  });
});
```

### Integration Tests

```typescript
describe('Reconciliation E2E', () => {
  it('should self-heal after failed update', async () => {
    // Setup: Agent running v1.0.229
    const agent = await startAgent({ version: '1.0.229' });
    
    // Set target state to v1.0.230
    await setTargetState(agent.uuid, {
      config: { agent: { version: '1.0.230' } }
    });
    
    // Simulate failed update (disk space)
    mockDiskSpace(0);
    
    // Wait for reconciliation attempt 1 (fails)
    await delay(60000);
    expect(agent.version).toBe('1.0.229');
    
    // Fix disk space
    mockDiskSpace(1000 * 1024 * 1024);
    
    // Wait for reconciliation attempt 2 (succeeds)
    await delay(60000);
    expect(agent.version).toBe('1.0.230');
  });
});
```

## Monitoring & Alerting

### Metrics to Track

1. **Reconciliation Success Rate**:
   ```promql
   rate(agent_update_reconciliation_success_total[5m]) /
   rate(agent_update_reconciliation_attempts_total[5m])
   ```

2. **Version Drift Count**:
   ```sql
   SELECT COUNT(*) FROM devices d
   JOIN device_target_state dts ON d.uuid = dts.device_uuid
   WHERE d.agent_version != dts.config->>'agent'->>'version'
   ```

3. **Reconciliation Latency** (time from target set to update complete):
   ```promql
   histogram_quantile(0.95, 
     rate(agent_update_reconciliation_duration_seconds_bucket[5m])
   )
   ```

### Alerts

```yaml
groups:
  - name: agent_updates
    rules:
      - alert: AgentVersionDrift
        expr: |
          count(agent_version_drift == 1) > 5
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} devices stuck in version drift"
          
      - alert: ReconciliationFailure
        expr: |
          rate(agent_update_reconciliation_failure_total[5m]) > 0.1
        for: 15m
        labels:
          severity: critical
        annotations:
          summary: "Agent update reconciliation failing frequently"
```

## Rollout Checklist

- [ ] Phase 1.1: Add version to agent state reports
- [ ] Phase 1.2: Extend target state schema
- [ ] Phase 1.3: Create API endpoint for setting desired version
- [ ] Phase 2.1: Add agent reconciliation to StateReconciler
- [ ] Phase 2.2: Extend AgentUpdater with reconcile method
- [ ] Phase 3.1: Update MQTT handler for hybrid mode
- [ ] Phase 4.1: Add dashboard UI for version management
- [ ] Unit tests for reconciliation logic
- [ ] Integration tests for self-healing
- [ ] Load testing with 1000+ devices
- [ ] Documentation update (API docs, runbooks)
- [ ] Monitoring dashboards (Grafana)
- [ ] Alerting rules (Prometheus)
- [ ] Gradual rollout plan (10% → 50% → 100%)
- [ ] Rollback plan (disable reconciliation, revert to MQTT)

## Open Questions

1. **Reconciliation Interval**: Should agent updates use same 60s poll as containers, or longer (e.g., 5min)?
   - **Recommendation**: Keep 60s for consistency, rate limiting prevents spam

2. **Conflict Resolution**: What if admin manually updates agent while reconciliation in progress?
   - **Recommendation**: Reconciliation wins, manual version reported as drift

3. **Signature Rotation**: How to handle signature key rotation without breaking in-flight updates?
   - **Recommendation**: Support multiple keys with key ID in signature

4. **Dashboard UX**: Should UI allow scheduling specific time, or just "update now"?
   - **Recommendation**: Both - simple "update now" button + advanced scheduling modal

5. **Metrics Retention**: How long to keep reconciliation metrics/logs?
   - **Recommendation**: 30 days (standard Prometheus retention)

## Conclusion

Migrating to reconciliation-based agent updates provides:

- ✅ **Self-healing**: Automatic retries on failure
- ✅ **Eventual consistency**: Updates happen when device reconnects
- ✅ **Simplified state**: One source of truth (database, not MQTT)
- ✅ **Better audit trail**: History of desired vs actual version
- ✅ **Consistency**: Same pattern as container orchestration

**Recommendation**: Implement hybrid model (Phase 1-3) to maintain backward compatibility while gaining reconciliation benefits. Fully deprecate MQTT commands only after 100% rollout success (Phase 4).

**Next Steps**:
1. Review proposal with team
2. Approve implementation plan
3. Start with Phase 1.1 (agent version reporting) - **quick win to fix "unknown" issue**
4. Iterate based on feedback

---

**Questions or feedback?** This is a proposal - all details subject to discussion and refinement.
