# Override-Only Pattern Implementation Summary

## What Changed

The target state `config.endpoints` now ONLY contains fields that **actually differ** from the discovered baseline, not hardcoded defaults.

## Key Changes

### 1. Database Schema (Migration Required)

**New columns in `device_sensors` table**:
```sql
discovered_connection JSONB       -- Original connection from discovery
discovered_data_points JSONB      -- Original data points from discovery  
discovered_enabled BOOLEAN        -- Original enabled state from discovery
discovered_poll_interval INTEGER  -- Original poll interval from discovery
```

**Migration files created**:
- `postgres/migrations/20260118_add_discovered_baseline_columns.sql` (PostgreSQL)
- `api/database/migrations/20260118000000_add_discovered_baseline_columns.js` (Knex)

### 2. API Changes (`api/src/services/device-endpoints.ts`)

**syncTableToConfig()**:
- Now compares current values against `discovered_*` baseline columns
- Only includes fields in config.endpoints if they DIFFER from discovered values
- No more hardcoded default comparisons (enabled !== false, pollInterval !== 5000)

**Logic**:
```typescript
// OLD (wrong)
if (row.enabled !== false) {  // Hardcoded default
  override.enabled = row.enabled;
}

// NEW (correct)
const discoveredEnabled = row.discovered_enabled ?? false;
if (row.enabled !== discoveredEnabled) {  // Compare to actual discovered value
  override.enabled = row.enabled;
}
```

### 3. Discovery Process (Needs Update)

**When discovery creates new endpoints**, it must populate discovered_* columns:

```typescript
// In discovery plugins (modbus, opcua, snmp)
await DeviceEndpointModel.create({
  name: 'device-1',
  protocol: 'modbus',
  enabled: false,
  poll_interval: 5000,
  connection: { host: '10.0.0.60', port: 503, slaveId: 1 },
  data_points: [...],
  
  // NEW: Store baseline for comparison
  discovered_enabled: false,
  discovered_poll_interval: 5000,
  discovered_connection: { host: '10.0.0.60', port: 503, slaveId: 1 },
  discovered_data_points: [...]
});
```

### 4. Agent Reconciliation (Needs Update)

**When agent reports current state**, it must preserve discovered_* columns:

```typescript
// In agent state reporting
// IMPORTANT: Only update runtime fields, preserve discovered_* baseline!
UPDATE device_sensors SET
  enabled = $1,
  poll_interval = $2,
  connection = $3,
  data_points = $4
  -- DON'T touch discovered_enabled, discovered_poll_interval, etc.
WHERE uuid = $5
```

## Files Modified

✅ **api/src/services/device-endpoints.ts**:
- syncConfigToTable() - Now applies overrides only
- syncTableToConfig() - Now compares against discovered baseline

✅ **dashboard/src/pages/SensorsPage.tsx**:
- handleToggleSensorEnabled() - Sends minimal override { uuid, enabled }

✅ **docs/ENDPOINT-CONFIGURATION-FLOW.md**:
- Updated architecture documentation
- Added discovered_* columns to schema

✅ **New migrations**:
- postgres/migrations/20260118_add_discovered_baseline_columns.sql
- api/database/migrations/20260118000000_add_discovered_baseline_columns.js

## Files Needing Updates

⏳ **agent/src/db/models/endpoint.model.ts**:
- `create()` - Populate discovered_* columns when creating endpoints
- `upsert()` - Preserve discovered_* columns on updates

⏳ **agent/src/features/discovery/**:
- modbus.discovery.ts - Pass discovered_* values to DeviceEndpointModel.create()
- opcua.discovery.ts - Pass discovered_* values to DeviceEndpointModel.create()
- snmp.discovery.ts - Pass discovered_* values to DeviceEndpointModel.create()

⏳ **api/src/services/device-state.ts**:
- processDeviceStateReport() - Ensure discovered_* columns aren't overwritten during reconciliation

⏳ **agent SQLite schema**:
- Add discovered_* columns to agent's local device_sensors table

## Testing Checklist

```bash
# 1. Run migration
cd api && npx knex migrate:latest

# 2. Trigger discovery
curl -X POST http://localhost:48484/api/v2/discovery/run

# 3. Check discovered_* columns are populated
SELECT name, enabled, discovered_enabled, poll_interval, discovered_poll_interval 
FROM device_sensors;

# 4. Toggle endpoint in dashboard
# Expected: config.endpoints = [{ uuid: "...", enabled: true }]

# 5. Check target state
SELECT config->'endpoints' FROM device_target_state;
# Should only show overrides, not full endpoints

# 6. Modify data points in UI
# Expected: config.endpoints = [{ uuid: "...", dataPoints: [...] }]

# 7. Re-run discovery
# Expected: discovered_* columns stay unchanged (baseline preserved)
```

## Benefits

1. **Minimal payload**: config.endpoints only contains actual user modifications
2. **Clear intent**: Easy to see what user changed vs. what was discovered
3. **Accurate sync**: No false positives (enabled=true in config only if user enabled it, not if discovery found it enabled)
4. **Future-proof**: Can detect drift between discovered and configured values

## Example Before/After

**Before** (incorrect - hardcoded defaults):
```json
// Discovery found: enabled=true, pollInterval=10000
// config.endpoints shows overrides:
[{
  "uuid": "abc-123",
  "enabled": true,         // Included because true !== false (hardcoded default)
  "pollInterval": 10000    // Included because 10000 !== 5000 (hardcoded default)
}]
// Problem: User never modified these! They're just what discovery found.
```

**After** (correct - baseline comparison):
```json
// Discovery found: enabled=true, pollInterval=10000
// Stored in: discovered_enabled=true, discovered_poll_interval=10000
// config.endpoints shows overrides:
[]
// Correct: User hasn't modified anything, so config is empty!

// User toggles enabled to false:
[{
  "uuid": "abc-123",
  "enabled": false  // Included because false !== true (discovered baseline)
}]
// Correct: Only includes what user actually changed!
```

## Migration Path

1. ✅ Run database migration (adds discovered_* columns)
2. ✅ Deploy API changes (syncTableToConfig compares against baseline)
3. ⏳ Update agent discovery (populate discovered_* on new endpoints)
4. ⏳ Update agent schema (add discovered_* columns to SQLite)
5. ⏳ Test full flow (discovery → toggle → deploy → verify)

## Next Steps

1. Run the migration: `cd api && npx knex migrate:latest`
2. Update agent endpoint model to populate discovered_* columns
3. Update discovery plugins to pass baseline values
4. Add discovered_* columns to agent SQLite schema
5. Test complete flow end-to-end
