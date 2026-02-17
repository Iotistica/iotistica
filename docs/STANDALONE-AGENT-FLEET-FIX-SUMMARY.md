# Fleet Assignment Fix - Summary

## Issue
Standalone agents not visible in dashboard after provisioning because:
1. Devices have `fleet_id` assigned from provisioning key
2. No corresponding fleet record exists in `fleets` table
3. Dashboard queries can't join devices → fleets

## Root Cause
Provisioning key creation (`/api/v1/provisioning-keys/generate`) only creates a `provisioning_keys` record with a `fleet_id` string, but never creates the corresponding `fleets` table record.

## Solution Implemented

### 1. Auto-Create Fleet During Provisioning ✅
**File:** `api/src/services/provisioning.service.ts` (lines ~530)

Added logic before device creation:
- Check if `fleet_id` exists in `fleets` table
- If not, auto-create fleet record with minimal metadata
- Continue with device provisioning (non-fatal if fleet creation fails)

**Example:**
```typescript
// Check fleet exists
const fleetCheck = await query('SELECT fleet_id FROM fleets WHERE fleet_id = $1', [keyRecord.fleet_id]);

if (fleetCheck.rows.length === 0) {
  // Auto-create fleet
  await query(`INSERT INTO fleets (fleet_id, fleet_name, customer_id, fleet_type, ...) VALUES ...`);
}
```

### 2. Backfill Migration for Existing Devices ✅
**File:** `api/database/migrations/151_backfill_missing_fleets.sql`

Creates fleet records for devices that already exist with orphaned `fleet_id`:
- Identifies devices with `fleet_id` but no matching fleet
- Creates fleet records with friendly names
- Determines fleet type from device types (virtual/physical/mixed)
- Uses earliest device creation date as fleet creation date

## Deployment Steps

### Step 1: Run Database Migration
```bash
cd api
npx knex migrate:latest
```

**Expected Output:**
```
================================================
Fleet Backfill Migration
================================================
Devices without matching fleet: 3
Fleet records to be created: 2

================================================
Migration Results:
================================================
✓ Successfully created 2 fleet record(s)

Created Fleets:
  - Default Fleet (physical) - 2 device(s)
  - Test Fleet Ab12 (physical) - 1 device(s)
================================================
✓ All devices now have matching fleet records
```

### Step 2: Rebuild & Deploy API
```bash
cd api
docker build -t iotistic/api:v0.0.1-rc.21 .

# If using Kubernetes
kubectl set image deployment/demo-release-iotistic-api api=iotistic/api:v0.0.1-rc.21 -n demo
kubectl rollout status deployment/demo-release-iotistic-api -n demo
```

### Step 3: Verify Fix

**Check database:**
```sql
-- Verify all devices now have matching fleets
SELECT 
  d.uuid, 
  d.device_name, 
  d.fleet_id, 
  f.fleet_name,
  f.fleet_type
FROM devices d
LEFT JOIN fleets f ON d.fleet_id = f.fleet_id
WHERE d.is_active = true
ORDER BY d.fleet_id;

-- Should show NO nulls in fleet_name/fleet_type columns
```

**Test provisioning new device:**
```bash
# Generate key
curl -X POST http://localhost:3002/api/v1/provisioning-keys/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"fleetId": "new-test-fleet"}'

# Provision device
curl -X POST http://localhost:3002/api/v1/device/register \
  -H "Content-Type: application/json" \
  -d '{
    "uuid": "new-test-device-uuid",
    "deviceName": "New Test Device",
    "deviceType": "physical",
    "deviceApiKey": "test-key",
    "provisioningApiKey": "KEY_FROM_PREVIOUS_STEP"
  }'

# Verify fleet was auto-created
psql -c "SELECT * FROM fleets WHERE fleet_id = 'new-test-fleet';"
```

**Check dashboard:**
- Navigate to Fleets page
- Should see all fleets including "Default Fleet"
- Each fleet should show correct device count
- Click on fleet → should show devices

## Files Changed

1. **api/src/services/provisioning.service.ts** (Modified)
   - Added auto-fleet-creation logic before device provisioning

2. **api/database/migrations/151_backfill_missing_fleets.sql** (New)
   - Backfills fleet records for existing devices

3. **docs/STANDALONE-AGENT-FLEET-ASSIGNMENT-FIX.md** (New)
   - Complete analysis and documentation

4. **docs/STANDALONE-AGENT-FLEET-FIX-SUMMARY.md** (This file)
   - Quick deployment guide

## Expected Behavior After Fix

### Before Fix ❌
- Device provisioned successfully
- Device has `fleet_id` = "default-fleet"
- Dashboard shows device count = 0 (can't find fleet)
- Fleet list empty or missing device count
- API `/api/v1/devices` returns device with `fleet_id`
- But `/api/v1/fleets` doesn't include the device

### After Fix ✅
- Device provisioned successfully
- Fleet auto-created (if doesn't exist)
- Dashboard shows correct device count
- Device appears in fleet list
- Both API endpoints consistent
- New devices automatically get fleet records

## Rollback (If Needed)

If something goes wrong, you can rollback:

```bash
# Rollback migration
cd api
npx knex migrate:rollback

# Redeploy previous API version
kubectl set image deployment/demo-release-iotistic-api api=iotistic/api:v0.0.1-rc.20 -n demo
```

## Testing Checklist

- [ ] Migration runs successfully
- [ ] Existing devices now have fleet records
- [ ] New device provisioning auto-creates fleet
- [ ] Dashboard shows devices in fleets
- [ ] Fleet list shows correct device counts
- [ ] No errors in API logs
- [ ] Both virtual and standalone agents work

## Notes

- Fleet creation is **non-fatal** during provisioning - if it fails, device still provisions
- Migration is **idempotent** - safe to run multiple times (uses ON CONFLICT DO NOTHING)
- Fleet names auto-generated from fleet_id ("default-fleet" → "Default Fleet")
- Default customer ID used for single-tenant deployments: `00000000-0000-0000-0000-000000000001`

## Status
✅ Code implemented
✅ Migration created
⏳ Awaiting deployment
⏳ Awaiting testing

---
**Last Updated:** 2026-02-17
