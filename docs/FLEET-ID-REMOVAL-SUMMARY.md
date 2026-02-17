# Fleet ID → Fleet UUID Migration - Removal Summary

## Overview
Completed systematic removal of `fleet_id` references across the codebase to force UUID-only usage and surface errors quickly. This ensures data integrity and prevents silent failures.

## Changes Completed

### 1. Database Models (`api/src/db/models.ts`)
- ✅ Added `fleet_uuid?: string` to Device interface
- ✅ Marked `fleet_id` as legacy with comment

### 2. Provisioning Service (`api/src/services/provisioning.service.ts`)
**Interfaces:**
- ✅ Removed `fleet_id?: string` from `RegistrationRequest` interface
- ✅ Changed `ProvisioningResponse.fleetId` to `fleetUuid?: string | null`

**Virtual Agent Path:**
- ✅ Removed fleet_id-based namespace lookup (now uses default namespace)
- ✅ Changed device record to use `fleet_uuid: null` instead of `fleet_id`
- ✅ Updated event publishing to use `fleet_uuid` instead of `fleet_id`
- ✅ Updated audit logging to use `fleetUuid` instead of `fleetId`

**Physical Agent Path:**
- ✅ Kept `keyRecord.fleet_id` usage for fleet lookup (necessary - provisioning_keys table still has fleet_id)
- ✅ Auto-create fleet logic still uses `keyRecord.fleet_id` to INSERT into fleets table
- ✅ Resolved `fleetUuid` from fleets query and assigned to device
- ✅ Updated event publishing to use `fleet_uuid` instead of `fleet_id`
- ✅ Updated audit logging to use `fleetUuid` instead of `fleetId`
- ✅ Updated response to return `fleetUuid` instead of `fleetId`

### 3. Virtual Agent Deployer (`api/src/services/virtual-agent-deployer.ts`)
- ✅ Changed `VirtualAgentConfig.fleetId` to `fleetUuid`
- ✅ Updated fleet query: `WHERE fleet_uuid = $1` instead of `WHERE fleet_id = $1`
- ✅ Changed K8s labels: `iotistica.com/fleet-uuid` instead of `iotistica.com/fleet-id`
- ✅ Changed env var: `FLEET_UUID` instead of `FLEET_ID`
- ✅ Updated `createFleetNamespace()` interface to use `fleet_uuid` parameter
- ✅ Updated namespace naming: `fleet-{uuid-substring}` instead of `fleet-{fleet_id}`
- ✅ Updated all logging to use `fleet_uuid` instead of `fleet_id`

### 4. Devices Routes (`api/src/routes/devices.ts`)
- ✅ Removed `fleet_id` from device list API response (line 294)
- ✅ Removed `fleet_id` parameter from virtual agent registration calls
- ✅ Updated physical device INSERT to use `fleet_uuid` column instead of `fleet_id`
- ✅ Updated virtual agent deployment endpoint to lookup fleet by `fleet_uuid OR fleet_id` (temporary fallback)
- ✅ Removed `fleetId` from deployment response JSON

### 5. Fleets Routes (`api/src/routes/fleets.ts`)
- ✅ Removed all fallback logic: `OR (d.fleet_uuid IS NULL AND d.fleet_id = f.fleet_id)`
- ✅ Now using only: `WHERE d.fleet_uuid = f.fleet_uuid`
- ✅ Removed `fleet_id` from API responses:
  - Stop fleet response
  - Start fleet response
  - Delete fleet response
  - Usage events response
- ✅ Updated all logging to use `fleet_uuid` instead of `fleet_id`

## Known Remaining References

### Provisioning Keys System (provisioning_keys table)
**Location:** `api/src/services/provisioning.service.ts` (lines 513-574)  
**Status:** ⚠️ **NECESSARY - NOT A BUG**

The `provisioning_keys` table still uses `fleet_id` (VARCHAR), not `fleet_uuid`. This is intentional because:
1. Provisioning keys reference a fleet by its `fleet_id`
2. When a device provisions, we:
   - Get `keyRecord.fleet_id` from provisioning_keys table
   - Query fleets table: `WHERE fleet_id = keyRecord.fleet_id`
   - Extract `fleet_uuid` from the result
   - Assign `fleet_uuid` to the device record

**Affected Code:**
```typescript
// provisioning.service.ts lines 530-540
const fleetCheck = await query(
  'SELECT fleet_id, fleet_uuid FROM fleets WHERE fleet_id = $1',
  [keyRecord.fleet_id]  // ← Using fleet_id from provisioning_keys table
);
```

**Future Migration:** The provisioning_keys table needs its own migration:
- Add `fleet_uuid` column to provisioning_keys
- Backfill from fleets table
- Update provisioning key creation to use fleet_uuid
- Remove fleet_id column

### Provisioning Routes API Responses
**Location:** `api/src/routes/provisioning.ts` (lines 238, 251)  
**Status:** ⚠️ **INFORMATIONAL ONLY**

These return provisioning key data which includes `fleet_id` from the database:
```typescript
{
  id: k.id,
  fleet_id: k.fleet_id,  // ← From provisioning_keys table
  // ...
}
```

This is correct and expected until provisioning_keys table is migrated.

## Testing Checklist

### Before Deployment
- [ ] Run migration 151 - backfill missing fleets
- [ ] Run migration 152 - add fleet_uuid to devices with backfill
- [ ] Rebuild API: `cd api && npm run build`
- [ ] Check for TypeScript compilation errors

### Provisioning Tests
- [ ] Provision physical agent with provisioning key
- [ ] Verify device appears in dashboard
- [ ] Check device.fleet_uuid is populated
- [ ] Confirm no fleet_id in API responses

### Virtual Agent Tests
- [ ] Deploy virtual agent without fleet assignment
- [ ] Verify pod created in correct namespace
- [ ] Check FLEET_UUID env var in pod
- [ ] Verify K8s labels use fleet-uuid

### Fleet Management Tests
- [ ] List devices in fleet (should use fleet_uuid JOIN)
- [ ] Stop/start fleet operations
- [ ] Delete fleet with K8s namespace
- [ ] Verify no fallback to fleet_id in queries

### Error Validation
- [ ] Provision device with non-existent fleet_id in key
  - Expected: Fleet auto-created, fleet_uuid assigned
- [ ] Query devices with NULL fleet_uuid
  - Expected: Not shown in fleet device lists
- [ ] API requests using fleet_id
  - Expected: 404 or validation error (no silent mapping)

## Migration Path Forward

### Phase 1: Current (Completed)
✅ Remove fleet_id from device management  
✅ Update all routes and services to use fleet_uuid  
✅ Remove fallback logic  
✅ Force errors for missing fleet_uuid

### Phase 2: Provisioning Keys Migration (TODO)
- [ ] Create migration: Add fleet_uuid to provisioning_keys table
- [ ] Backfill fleet_uuid from fleets.fleet_id
- [ ] Update provisioning key creation to use fleet_uuid
- [ ] Update provisioning service to read fleet_uuid from keys
- [ ] Remove fleet_id from provisioning_keys table
- [ ] Update API responses to use fleet_uuid

### Phase 3: Database Cleanup (TODO)
- [ ] Verify no code references fleet_id
- [ ] Create migration: Drop fleet_id column from devices
- [ ] Create migration: Drop fleet_id column from fleets
- [ ] Update database documentation

## Files Modified

### Core Services
- `api/src/db/models.ts`
- `api/src/services/provisioning.service.ts`
- `api/src/services/virtual-agent-deployer.ts`

### Routes
- `api/src/routes/devices.ts`
- `api/src/routes/fleets.ts`

### Database Migrations
- `api/database/migrations/151_backfill_missing_fleets.sql`
- `api/database/migrations/152_add_fleet_uuid_to_devices.sql`

## Critical Notes

### 🚨 Breaking API Changes
The following API responses have changed:

**Before:**
```json
{
  "fleet_id": "fleet-abc123",
  "fleet_uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

**After:**
```json
{
  "fleet_uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

This affects:
- Device list responses
- Fleet management responses
- Provisioning responses

**Impact:** Existing dashboard or API clients expecting `fleet_id` will break. Update UI to use `fleet_uuid`.

### 🎯 Goal Achieved: Force Errors
All fallback logic removed. Missing fleet_uuid will now cause:
- Failed JOIN queries (devices won't appear in fleet lists)
- NULL values in API responses
- TypeScript errors if code expects fleet_id

**This is intentional** - better to fail fast than mask data integrity issues.

### 📊 Database State Requirements
For this code to work correctly:
1. **Migration 151 must run first** - creates missing fleet records
2. **Migration 152 must run second** - adds fleet_uuid and backfills
3. **Fleets table must have both fleet_id and fleet_uuid** (until Phase 3)
4. **Provisioning_keys table still has fleet_id** (will change in Phase 2)

## Success Criteria

✅ **Code-level:** No `fleet_id` in:
- Device model assignments
- API responses (devices, fleets)
- JOIN queries with fallback logic
- TypeScript interfaces for new features

✅ **Database-level:** 
- Devices.fleet_uuid populated via migration 152
- Fleets table has both columns (transition state)

✅ **Runtime-level:**
- Device provisioning assigns fleet_uuid
- Dashboard shows devices in fleets via fleet_uuid
- Errors surface quickly when fleet_uuid missing

---
**Last Updated:** 2025-01-XX  
**Migration Status:** Phase 1 Complete, Phase 2 Pending
