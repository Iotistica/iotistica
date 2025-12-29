# Dictionary Decompression Bug Fix

## Problem Summary

**Symptom**: All sensor values in the `readings` table were NULL or 0, despite data flowing through the pipeline correctly.

**Affected Protocols**: OPC UA, Modbus (any protocol using dictionary compression with opaque arrays)

**Root Cause**: The API was not properly handling the dictionary-expanded opaque array message structure.

## Technical Details

### Data Flow

1. **Agent** publishes compressed MQTT messages using dictionary compression
2. **API** receives compressed message and expands it using `expandOpaqueArrays()`
3. Expanded structure: `{ messages: [{ timestamp, readings: [...] }] }`
4. **Handler** processes the message and queues it to Redis
5. **Redis Worker** processes queue and inserts to PostgreSQL

### The Bug

After dictionary expansion in `api/src/mqtt/mqtt-manager.ts`, the message had this structure:

```javascript
{
  messages: [
    {
      timestamp: "2025-12-29T12:30:00Z",
      readings: [
        { registerName: "temperature", value: 23.5, quality: "good", ... },
        { registerName: "pressure", value: 100.2, quality: "good", ... }
      ]
    }
  ]
}
```

**Problem 1**: In `mqtt-manager.ts` (line 928), the code extracted only the first message instead of preserving the batch structure:

```typescript
// BEFORE (WRONG):
const firstMessage = data.messages[0];
actualData = firstMessage;  // Lost the batch structure!
```

**Problem 2**: In `handlers.ts` (line 22), the code only checked for `messages` array, not `readings` array:

```typescript
// BEFORE (WRONG):
const isBatch = data.data && Array.isArray((data.data as any).messages);
```

This meant that after expansion, the structure `{ timestamp, readings: [...] }` was not recognized as a batch, so it fell through to single-message processing which expected a different format.

### The Fix

**File 1**: `api/src/mqtt/mqtt-manager.ts`

```typescript
// AFTER (CORRECT):
// Preserve the messages array structure for batch processing
actualData = {
  messages: data.messages,
  timestamp: data.messages[0]?.timestamp || timestamp
};
```

**File 2**: `api/src/mqtt/handlers.ts`

```typescript
// AFTER (CORRECT):
// Check for both formats
const isBatch = data.data && (
  Array.isArray((data.data as any).messages) || 
  Array.isArray((data.data as any).readings)
);

// Extract from either format
const messages = (batch.messages || batch.readings) as (string | object)[];
```

## Verification

### Before Fix
```sql
SELECT metric_name, value FROM readings WHERE protocol = 'modbus' LIMIT 5;
```
```
 metric_name | value 
-------------+-------
 fuel_level  |     0
 fuel_level  |     0
 engine_rpm  |     0
```

### After Fix
```sql
SELECT metric_name, value FROM readings WHERE protocol = 'opcua' LIMIT 5;
```
```
       metric_name        | value 
--------------------------+-------
 myvariable              | 32.85
 factory_temperature_sensor_1 | 28.79
 factory_temperature_sensor_2 | 30.32
 factory_temperature_sensor_3 | 29.63
 factory_temperature_sensor_4 | 28.69
```

## Impact

- **Fixed**: OPC UA sensor values now properly extracted and stored
- **Fixed**: Modbus register values now properly extracted and stored
- **Preserved**: Metadata (deviceName, quality, protocol, timestamps) was already working
- **Improved**: Batch processing now handles all messages in opaque array, not just the first one

## Testing

Run the integration test:

```powershell
.\test-opcua-data-integrity.ps1 -DeviceUuid "571406ce-c517-49e9-98ed-2d07990f706b"
```

Expected output:
```
✓ ALL CHECKS PASSED - Data integrity verified!
✓ OPC UA data flowing correctly through pipeline
✓ Numeric sensor data present (5 readings)
```

## Files Changed

1. `api/src/mqtt/mqtt-manager.ts` - Lines 920-945 (handleEndpointsData method)
2. `api/src/mqtt/handlers.ts` - Lines 19-31 (handleEndpointsData function)

## Related Issues

- Dictionary compression implementation: `api/src/mqtt/mqtt-manager.ts` (expandOpaqueArrays)
- Redis queue processing: `api/src/services/redis-sensor-queue.ts` (lines 332-366)
- Opaque array format: Agent publishes with fields ending in `[]` for arrays

## Lessons Learned

1. **Opaque array structure preservation is critical** - Don't extract nested data too early
2. **Multi-format support needed** - Handle both legacy (`messages`) and new (`readings`) formats
3. **Integration tests catch pipeline bugs** - The test script successfully identified this production issue
4. **Dictionary compression adds complexity** - Must carefully trace the entire expansion → processing → storage flow

## Deployment

After applying this fix:

1. Restart API service: `docker-compose restart api`
2. Wait 30-60 seconds for new data to flow through pipeline
3. Verify with integration test or direct database query

No database migration required - the schema was already correct. This was purely a data extraction bug in the application layer.
