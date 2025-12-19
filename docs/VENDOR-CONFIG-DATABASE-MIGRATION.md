# Vendor Configuration Migration - Database-Backed Solution

## Problem
- Static `dataPoints.json` file requires Docker rebuilds to update
- File sync issues between host and container
- Hardcoded paths (`/app/dist/config/vendors/dataPoints.json`)
- Not flexible - can't update vendor configs dynamically

## Solution: Database-Backed Vendor Configs

### Architecture
```
┌─────────────────────────────────────────────────────────┐
│ PostgreSQL Database                                     │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ vendor_configs table                                │ │
│ │ - vendor_name (COMAP, Generic, etc.)                │ │
│ │ - protocol (modbus, opcua, snmp)                    │ │
│ │ - data_points (JSONB array)                         │ │
│ │ - metadata (JSONB)                                  │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                        ▲
                        │ SQL queries
                        │
┌───────────────────────┴─────────────────────────────────┐
│ VendorConfigModel                                       │
│ - get(vendor, protocol)                                 │
│ - listByProtocol(protocol)                              │
│ - getVendorMap(protocol) ← backward compatible         │
│ - upsert(vendor, protocol, dataPoints, metadata)        │
└─────────────────────────────────────────────────────────┘
                        ▲
                        │
        ┌───────────────┴──────────────────┐
        │                                   │
┌───────┴───────────┐           ┌──────────┴──────────┐
│ ModbusDiscovery   │           │ API Routes          │
│ - Loads from DB   │           │ GET /api/vendors    │
│ - No file I/O     │           │ POST /api/vendors   │
└───────────────────┘           │ DELETE /api/vendors │
                                └─────────────────────┘
```

### Implementation Files

1. **Migration**: `api/database/migrations/112_create_vendor_configs.sql`
   - Creates `vendor_configs` table
   - Seeds COMAP and Generic configs
   - Auto-updates `updated_at` timestamp

2. **Model**: `agent/src/db/models/vendor-config.model.ts`
   - CRUD operations for vendor configs
   - `getVendorMap()` for backward compatibility

3. **API Routes**: `api/src/routes/vendors.ts`
   - `GET /api/v1/vendors?protocol=modbus` - List vendors
   - `GET /api/v1/vendors/:name` - Get vendor config
   - `POST /api/v1/vendors` - Create/update vendor
   - `DELETE /api/v1/vendors/:name` - Delete vendor

4. **Discovery Update**: `agent/src/features/discovery/modbus.discovery.ts`
   - Replaced file read with database query
   - Graceful fallback on DB errors

### Migration Steps

```bash
# 1. Run migration to create table and seed data
cd api
npx knex migrate:latest

# 2. Verify data
docker exec iotistic-postgres psql -U postgres -d iotistic -c "SELECT vendor_name, protocol, jsonb_array_length(data_points) as dp_count FROM vendor_configs;"

# 3. Rebuild agent (removes file dependency)
cd ../agent
npm run build

# 4. Restart containers
docker-compose restart agent api

# 5. Test vendor API
curl http://localhost:3002/api/v1/vendors?protocol=modbus
curl http://localhost:3002/api/v1/vendors/COMAP
```

### Benefits

✅ **Dynamic Updates**: Add/modify vendors via API without container rebuilds
✅ **Single Source of Truth**: Database is authoritative, no file sync issues  
✅ **Multi-Tenant Ready**: Each customer can have custom vendor configs
✅ **Version History**: Track changes via database timestamps
✅ **API-First**: Integrate with dashboard UI for vendor management
✅ **No File Paths**: No hardcoded `/app/dist/config/vendors/` paths
✅ **Backward Compatible**: `getVendorMap()` returns same format as before

### Usage Examples

#### Add New Vendor via API
```bash
curl -X POST http://localhost:3002/api/v1/vendors \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_name": "Siemens",
    "protocol": "modbus",
    "data_points": [
      {"name": "pressure", "address": 100, "type": "holding", "dataType": "float32"}
    ],
    "metadata": {
      "description": "Siemens PLC",
      "vendorUrl": "https://siemens.com"
    }
  }'
```

#### Update COMAP Configuration
```bash
curl -X POST http://localhost:3002/api/v1/vendors \
  -H "Content-Type: application/json" \
  -d '{
    "vendor_name": "COMAP",
    "protocol": "modbus",
    "data_points": [
      {"name": "engine_rpm", "address": 100, "type": "holding", "dataType": "uint16"},
      {"name": "new_register", "address": 200, "type": "holding", "dataType": "uint16"}
    ]
  }'
```

#### Agent Discovery (Automatic)
```typescript
// In modbus.discovery.ts - automatically uses DB
const vendorMap = await VendorConfigModel.getVendorMap('modbus');
const dataPoints = vendorMap['COMAP']?.dataPoints || [];
// Discovery uses data points to auto-configure devices
```

### File Cleanup (After Migration)

Once verified working, you can optionally remove:
- ❌ `config/vendors/dataPoints.json` (no longer used)
- ❌ File copy logic in `agent/package.json` (`copy:vendors` script)
- ❌ Dockerfile COPY config logic (line 42)

**Note**: Keep files temporarily for backward compatibility testing.

### Dashboard Integration (Future)

Create UI in dashboard for vendor management:
```typescript
// dashboard/src/pages/VendorManagementPage.tsx
- List vendors (GET /api/vendors)
- Add/Edit vendor form (POST /api/vendors)
- Delete vendor button (DELETE /api/vendors/:name)
- Data point editor (JSON or form-based)
```

### Troubleshooting

**Issue**: Agent can't connect to database
**Fix**: Ensure DATABASE_URL env var is set in agent container

**Issue**: Migration fails (table exists)
**Fix**: Drop table first: `DROP TABLE IF EXISTS vendor_configs CASCADE;`

**Issue**: Discovery still uses file
**Fix**: Rebuild agent: `cd agent && npm run build && docker-compose restart agent`

## Summary

This migration eliminates static file dependency and provides a flexible, API-driven vendor configuration system. No more Docker rebuilds or file syncing - just update via API and devices pick up changes on next discovery cycle.
