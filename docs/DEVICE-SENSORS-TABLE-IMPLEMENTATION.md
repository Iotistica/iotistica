# Device Sensors Table Implementation

**Date**: November 2, 2025  
**Pattern**: Dual-Write with Config as Source of Truth

## Overview

Implemented a relational database table `endpoints` to store sensor configurations alongside the existing config-based approach in `device_target_state.config.protocolAdapterDevices`.

### Why This Approach?

**Problem**: Storing sensors only in JSONB config field has limitations:
- ❌ Can't efficiently query/filter sensors
- ❌ No historical tracking of changes
- ❌ No relational integrity (foreign keys)
- ❌ Poor indexing performance

**Solution**: Dual-write pattern
- ✅ Config remains source of truth for agent
- ✅ Database table for querying/display
- ✅ Bidirectional sync keeps both in sync
- ✅ No breaking changes to agent

## Architecture

```
User Action (Add Sensor)
        ↓
Dashboard → updatePendingConfig
        ↓
Save Draft → API
        ↓
    [DATABASE DUAL WRITE]
        ├─→ device_target_state.config.protocolAdapterDevices (Agent pulls this)
        └─→ endpoints table (API queries this)
        ↓
Sync → Agent pulls config
        ↓
Agent applies configuration
        ↓
Agent reports health → protocol_adapter_health_history (separate)
```

## Database Schema

### Table: `endpoints`

```sql
CREATE TABLE endpoints (
    id SERIAL PRIMARY KEY,
    device_uuid UUID NOT NULL REFERENCES devices(uuid) ON DELETE CASCADE,
    
    -- Sensor identification
    name VARCHAR(255) NOT NULL,
    protocol VARCHAR(50) NOT NULL, -- modbus, can, opcua, mqtt, etc.
    
    -- Configuration
    enabled BOOLEAN NOT NULL DEFAULT true,
    poll_interval INTEGER NOT NULL DEFAULT 5000,
    connection JSONB NOT NULL,
    data_points JSONB NOT NULL DEFAULT '[]'::jsonb,
    
    -- Metadata
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(255),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Sync tracking
    synced_to_config BOOLEAN NOT NULL DEFAULT true,
    config_version INTEGER, -- Tracks which target state version
    
    CONSTRAINT uq_device_sensor_name UNIQUE (device_uuid, name)
);
```

**Indexes**:
- `idx_endpoints_device_uuid` - Query by device
- `idx_endpoints_protocol` - Filter by protocol type
- `idx_endpoints_enabled` - Filter active sensors
- `idx_endpoints_device_protocol` - Composite query
- `idx_endpoints_sync` - Track sync status

## Implementation Files

### 1. Migration
**File**: `api/database/migrations/039_create_endpoints_table.sql`
- Creates `endpoints` table
- Adds indexes
- Grants permissions
- Sets up timestamp trigger

### 2. Sync Service
**File**: `api/src/services/device-sensor-sync.ts`
**Class**: `DeviceSensorSyncService`

**Key Methods**:

```typescript
// Sync config → table (after Save Draft)
async syncConfigToTable(
  deviceUuid: string,
  configDevices: SensorDeviceConfig[],
  configVersion: number,
  userId?: string
): Promise<void>

// Sync table → config (after API add/update)
async syncTableToConfig(
  deviceUuid: string,
  userId?: string
): Promise<{ version: number, config: any }>

// CRUD operations with dual-write
async addSensor(deviceUuid, sensor, userId): Promise<any>
async updateSensor(deviceUuid, name, updates, userId): Promise<any>
async deleteSensor(deviceUuid, name, userId): Promise<any>
async getSensors(deviceUuid, protocol?): Promise<any[]>
```

### 3. API Routes
**File**: `api/src/routes/protocol-devices.ts` (endpoint names unchanged for backward compatibility)

**Endpoints**:
```
GET    /api/v1/devices/:uuid/protocol-devices          # List sensors
POST   /api/v1/devices/:uuid/protocol-devices          # Add sensor
PUT    /api/v1/devices/:uuid/protocol-devices/:name    # Update sensor
DELETE /api/v1/devices/:uuid/protocol-devices/:name    # Delete sensor
```

## Data Flow

### Add Sensor Flow

```typescript
// 1. User adds sensor in Dashboard
updatePendingConfig(deviceUuid, 'protocolAdapterDevices', [
  ...existingDevices,
  newSensor
]);

// 2. User clicks "Save Draft" → API receives POST
await deviceSensorSync.addSensor(uuid, sensorConfig, userId);

// 3. Sync service performs dual-write:
//    a) INSERT into endpoints table
const sensorId = await query('INSERT INTO endpoints ...');

//    b) Sync table → config (updates target_state)
const syncResult = await syncTableToConfig(deviceUuid, userId);

// 4. Agent polls target state
const state = await fetch(`/api/v1/devices/${uuid}/state`);
// Gets: { config: { protocolAdapterDevices: [...] } }

// 5. Agent applies configuration
// 6. Agent reports health → protocol_adapter_health_history
```

### Query Sensors Flow

```typescript
// Dashboard queries sensors
const response = await fetch(`/api/v1/devices/${uuid}/protocol-devices`);

// API reads from table (fast, indexed)
const sensors = await deviceSensorSync.getSensors(uuid);

// Returns:
{
  devices: [
    {
      id: 1,
      name: "Modbus Temperature",
      protocol: "modbus",
      enabled: true,
      pollInterval: 5000,
      connection: { host: "192.168.1.10", port: 502 },
      dataPoints: [{ address: 40001, type: "holding" }],
      metadata: {},
      createdAt: "2025-11-02T...",
      syncedToConfig: true,
      configVersion: 42
    }
  ],
  count: 1
}
```

## Sync Tracking

**Fields**:
- `synced_to_config`: Boolean flag indicating sync status
- `config_version`: Target state version this record came from

**When does sync happen?**

1. **Config → Table**: After `Save Draft` (future enhancement)
2. **Table → Config**: After API `POST/PUT/DELETE`

**Conflict Resolution**: 
- Config is always source of truth
- Table tracks which version it synced from
- If mismatch detected, resync from config

## Testing

### Run Migration

```bash
cd api
psql -U postgres -d iotistic -f database/migrations/039_create_endpoints_table.sql
```

### Test Add Sensor

```bash
curl -X POST http://localhost:4002/api/v1/devices/{uuid}/protocol-devices \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Modbus Temperature Sensor",
    "protocol": "modbus",
    "enabled": true,
    "pollInterval": 5000,
    "connection": {
      "host": "192.168.1.100",
      "port": 502,
      "slaveId": 1
    },
    "dataPoints": [
      {
        "address": 40001,
        "type": "holding",
        "dataType": "float32",
        "name": "temperature"
      }
    ]
  }'
```

### Test Query Sensors

```bash
curl http://localhost:4002/api/v1/devices/{uuid}/protocol-devices
```

### Verify Dual-Write

```sql
-- Check table
SELECT * FROM endpoints WHERE device_uuid = '{uuid}';

-- Check config
SELECT config->'protocolAdapterDevices' 
FROM device_target_state 
WHERE device_uuid = '{uuid}';
```

## Benefits

✅ **Fast Queries**: Indexed table for UI display  
✅ **Relational Integrity**: Foreign keys to devices  
✅ **Historical Tracking**: Can add audit table later  
✅ **No Breaking Changes**: Agent still uses config  
✅ **Backward Compatible**: API endpoints unchanged  
✅ **Feature Rich**: Can add columns without changing config schema  
✅ **Performance**: Joins, filters, sorts all efficient  

## Future Enhancements

1. **Audit Trail**: `endpoints_history` table for change tracking
2. **Validation**: Database constraints for connection/register schemas
3. **Auto-Sync**: Webhook on Save Draft to trigger syncConfigToTable
4. **Bulk Operations**: Import/export sensors via SQL
5. **Advanced Queries**: Complex filters (e.g., "all Modbus sensors with errors")

## Migration Path

**For existing deployments**:

1. Run migration to create table
2. One-time sync of existing config → table:
   ```typescript
   for (const device of allDevices) {
     const config = await getTargetState(device.uuid);
     if (config.protocolAdapterDevices) {
       await deviceSensorSync.syncConfigToTable(
         device.uuid,
         config.protocolAdapterDevices,
         config.version
       );
     }
   }
   ```
3. Future adds/edits automatically dual-write

## Notes

- **Table name**: `endpoints` (not `protocol_adapter_devices` - obsolete term)
- **Service name**: `DeviceSensorSyncService` (renamed from protocol-device-sync)
- **API endpoints**: Keep existing `/protocol-devices` for backward compatibility
- **Config field**: Still uses `protocolAdapterDevices` for agent compatibility
