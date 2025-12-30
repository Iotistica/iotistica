---
applyTo: 'agent/src/features/endpoints/modbus/**,agent/src/config/agent-config.ts,agent/src/features/discovery/modbus.discovery.ts'
description: 'Comprehensive guide for Modbus protocol implementation in the IoT platform. Covers configuration, data flow, register reading, batching optimization, and quality management.'
---

# Modbus Functionality Instructions

## Overview

The Modbus implementation supports **TCP** and **RTU** (serial) communication with industrial devices. The system uses a declarative configuration model where cloud-defined data points are transformed into agent-level register definitions with automatic function code resolution.

**Supported Function Codes:**
- `1` - READ_COILS (boolean, read/write)
- `2` - READ_DISCRETE_INPUTS (boolean, read-only)
- `3` - READ_HOLDING_REGISTERS (numeric, read/write)
- `4` - READ_INPUT_REGISTERS (numeric, read-only)

## Architecture Patterns

### 1. Configuration Data Flow

**Cloud Config (V2 Format)** → **Agent Config Transform** → **Discovery** → **Database** → **Adapter Startup**

#### Stage 1: Cloud Configuration (V2 Format)
```json
{
  "protocols": {
    "modbus": {
      "enabled": true,
      "profile": "COMAP",
      "connection": {
        "host": "10.0.0.60",
        "port": 502,
        "timeoutMs": 2000
      },
      "addressing": {
        "slaveRange": { "start": 1, "end": 10 }
      },
      "points": {
        "engine_rpm": {
          "type": "holding",
          "address": 99,
          "dataType": "uint16",
          "unit": "RPM"
        },
        "alarm_1": {
          "type": "coil",
          "address": 0,
          "dataType": "boolean"
        }
      }
    }
  }
}
```

**Critical Fields:**
- `type`: Register type - `"holding"`, `"input"`, `"coil"`, `"discrete"`
- `address`: Modbus register address (protocol-level, NOT zero-indexed)
- `dataType`: Data type - `"uint16"`, `"int16"`, `"uint32"`, `"int32"`, `"float32"`, `"boolean"`
- `unit`: Measurement unit (e.g., "RPM", "V", "A", "°C")

#### Stage 2: Agent Config Transformation

**File:** `agent/src/config/agent-config.ts` (lines 150-185)

Converts V2 `points` object → V1 `profileDataPoints` array:

```typescript
getModbusConfig() {
  const points = cloud?.protocols?.modbus?.points || {};
  
  const profileDataPoints = Object.entries(points).map(([name, point]) => ({
    name,
    ...point  // Spreads: type, address, dataType, unit
  }));
  
  return {
    enabled: cloud?.protocols?.modbus?.enabled ?? false,
    profile: cloud?.protocols?.modbus?.profile,
    connection: cloud?.protocols?.modbus?.connection,
    addressing: cloud?.protocols?.modbus?.addressing,
    profileDataPoints  // V1 format array
  };
}
```

**Key Behavior:** The `type` field is preserved during transformation for fallback conversion.

#### Stage 3: Discovery Plugin

**File:** `agent/src/features/discovery/modbus.discovery.ts` (line 143)

Saves `profileDataPoints` to database as `data_points` field:

```typescript
const discovered = await this.endpointModel.create({
  uuid: device.uuid,
  name: device.name,
  protocol: 'modbus',
  connection: device.connection,
  data_points: dataPoints,  // Array from profileDataPoints
  metadata: device.metadata
});
```

**Database Storage:** SQLite `endpoints` table stores `data_points` as JSON TEXT.

#### Stage 4: Adapter Startup with Type → Function Code Conversion

**File:** `agent/src/features/endpoints/sensors-feature.ts` (lines 158-175)

**CRITICAL PATTERN:** Fallback conversion when `functionCode` is missing:

```typescript
const typeMap: Record<string, number> = {
  'coil': 1,           // READ_COILS
  'discrete': 2,       // READ_DISCRETE_INPUTS
  'holding': 3,        // READ_HOLDING_REGISTERS
  'input': 4          // READ_INPUT_REGISTERS
};

const registers = endpoint.data_points.map(dp => ({
  name: dp.name,
  address: dp.address,
  dataType: dp.dataType,
  unit: dp.unit,
  // Fallback: Use type → functionCode conversion if functionCode missing
  functionCode: dp.functionCode ?? typeMap[dp.type?.toLowerCase()] ?? 3,
  count: dp.count || 1
}));
```

**Why This Matters:**
- Endpoints discovered BEFORE profile configured → `data_points` = `[]`
- Endpoints discovered AFTER profile configured → `data_points` has type field
- Fallback ensures backward compatibility and handles missing functionCode

### 2. Register Reading Architecture

**File:** `agent/src/features/endpoints/modbus/client.ts`

#### Batch Optimization Strategy

**Method:** `readAllRegisters()` (lines 190-260)

**Flow:**
1. **Group by Function Code** (line 201): Separates coils, discretes, holding, input registers
2. **Optimize Batches** (line 205): Groups contiguous addresses within same function code
3. **Batch Read** (line 231): Single Modbus request for contiguous registers
4. **Fallback** (line 247): Individual reads if batch fails

**Batching Rules:**
```typescript
private optimizeBatches(registers: any[]): any[][] {
  // Sort by address
  const sorted = [...registers].sort((a, b) => a.address - b.address);
  
  // Allow gaps up to 2 registers (reading extra is faster than separate requests)
  const canBatch = gap <= 2 && totalCount <= 125; // Modbus max 125 registers
  
  // Start new batch if gap too large or batch exceeds limit
}
```

**Performance Impact:**
- Single request for 11 contiguous holding registers (addresses 99-159 with gaps)
- Reduces network overhead from 11 requests → 1-2 requests
- Timeout applies to entire batch (default 5000ms)

#### Function Code Routing

**Method:** `readBatchRaw()` (lines 377-395)

```typescript
switch (functionCode) {
  case ModbusFunctionCode.READ_COILS:
    return await this.client.readCoils(address, count);
  case ModbusFunctionCode.READ_DISCRETE_INPUTS:
    return await this.client.readDiscreteInputs(address, count);
  case ModbusFunctionCode.READ_HOLDING_REGISTERS:
    return await this.client.readHoldingRegisters(address, count);
  case ModbusFunctionCode.READ_INPUT_REGISTERS:
    return await this.client.readInputRegisters(address, count);
}
```

**Critical:** Each function code uses different Modbus command. Mixing function codes in a batch will fail.

### 3. Data Parsing Patterns

#### Numeric Registers (Holding/Input)

**Method:** `parseRegisterData()` (lines 612-680)

**Supported Data Types:**
```typescript
switch (register.dataType) {
  case ModbusDataType.UINT16:
    return data.data[0];  // Single 16-bit unsigned
  case ModbusDataType.INT16:
    return (data.data[0] << 16) >> 16;  // Sign extend
  case ModbusDataType.UINT32:
    return (data.data[0] << 16) | data.data[1];  // Big-endian 32-bit
  case ModbusDataType.INT32:
    return ((data.data[0] << 16) | data.data[1]) | 0;  // Signed 32-bit
  case ModbusDataType.FLOAT32:
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt16BE(data.data[0], 0);
    buffer.writeUInt16BE(data.data[1], 2);
    return buffer.readFloatBE(0);
  case ModbusDataType.STRING:
    // Convert register array to ASCII string
}
```

**Byte Order:** Big-endian (network byte order) by default. Most industrial devices use this format.

#### Boolean Registers (Coils/Discrete Inputs)

**Method:** `parseCoilData()` (lines 599-604)

```typescript
private parseCoilData(data: any, register: any): boolean {
  if (register.dataType === ModbusDataType.BOOLEAN) {
    return data.data[0] || false;  // Convert to boolean, default false
  }
  throw new Error(`Invalid data type ${register.dataType} for coil/discrete input`);
}
```

**Note:** Coils return single boolean value. Batch reads return array of booleans.

### 4. Quality Management (OPC UA Standard)

#### Quality Codes

**Interface:** `SensorDataPoint` (agent/src/features/endpoints/types.ts:20-28)

```typescript
export interface SensorDataPoint {
  deviceName: string;
  registerName: string;
  value: number | boolean | string | null;  // null when quality is BAD
  unit: string;
  timestamp: string;
  quality: 'GOOD' | 'BAD' | 'UNCERTAIN';  // OPC UA quality codes
  qualityCode?: string;  // Error code when quality is BAD
}
```

**Quality States:**
- `GOOD`: Successful read, value is valid
- `BAD`: Failed read, value is `null`, `qualityCode` indicates error
- `UNCERTAIN`: Partial success or degraded quality

#### Error Code Mapping

**Method:** `extractQualityCode()` (lines 506-558)

**Fatal Serial Errors** (requires immediate reconnection):
- `BROKEN_PIPE` - Device disconnected (EPIPE)
- `IO_ERROR` - Serial port disappeared (EIO)
- `DEVICE_NOT_CONFIGURED` - Device not configured (ENXIO)
- `NO_SUCH_DEVICE` - Device removed (ENODEV)
- `PORT_NOT_OPEN` - Port closed unexpectedly

**Modbus Exception Codes:**
- `ILLEGAL_FUNCTION` - Exception Code 1 (unsupported function)
- `ILLEGAL_ADDRESS` - Exception Code 2 (invalid register address)
- `ILLEGAL_VALUE` - Exception Code 3 (invalid data value)
- `DEVICE_FAILURE` - Exception Code 4 (device malfunction)
- `ACKNOWLEDGE` - Exception Code 5 (long-running operation)
- `DEVICE_BUSY` - Exception Code 6 (device busy, retry)
- `NEGATIVE_ACK` - Exception Code 7 (request rejected)
- `MEMORY_ERROR` - Exception Code 8 (memory parity error)

**Network Errors:**
- `TIMEOUT` - Request timeout (ETIMEDOUT)
- `CONNECTION_REFUSED` - Connection refused (ECONNREFUSED)
- `HOST_UNREACHABLE` - Host unreachable (EHOSTUNREACH)
- `CONNECTION_RESET` - Connection reset (ECONNRESET)

**Auto-Retry Logic:**
```typescript
// DEVICE_BUSY (Exception 6) triggers automatic retry
if (errorMessage.includes('Exception Code: 6')) {
  if (retryCount < maxRetries) {
    await sleep(retryDelay);  // 100ms delay
    return await this.readRegisterWithRetry(register, retryCount + 1);
  }
}
```

### 5. Connection Management

#### TCP Connection Pattern

**File:** `agent/src/features/endpoints/modbus/client.ts` (lines 90-130)

```typescript
async connect(): Promise<void> {
  if (this.device.connection.type === 'tcp') {
    this.client = new ModbusRTU();
    await this.client.connectTCP(
      this.device.connection.host,
      { port: this.device.connection.port }
    );
    this.client.setID(this.device.slaveId);
    this.client.setTimeout(this.device.connection.timeout || 5000);
  }
}
```

**Best Practices:**
- Always set timeout (default 5000ms, configurable)
- Set slave ID AFTER connection established
- Use mutex lock for concurrent read protection

#### Serial (RTU) Connection Pattern

```typescript
if (this.device.connection.type === 'serial') {
  this.client = new ModbusRTU();
  await this.client.connectRTUBuffered(
    this.device.connection.port,  // e.g., '/dev/ttyUSB0', 'COM3'
    { 
      baudRate: this.device.connection.baudRate || 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none'
    }
  );
  this.client.setID(this.device.slaveId);
  this.client.setTimeout(this.device.connection.timeout || 5000);
}
```

**Serial Parameters:**
- Default baud: 9600 (common: 9600, 19200, 38400, 115200)
- Data bits: 8 (standard)
- Stop bits: 1 (standard)
- Parity: none (or 'even', 'odd')

### 6. Address Offset Handling

**CRITICAL:** Modbus addressing conventions vary by vendor.

**pymodbus Simulator Pattern:**
```python
# Simulator compensates for pymodbus +1 offset
address = address - 1
```

**Agent Pattern:**
```typescript
// Agent uses protocol-level addresses (as documented by device manufacturer)
// NO automatic offset applied - uses exact address from cloud config
const register = {
  name: 'engine_rpm',
  address: 99  // Exactly as specified in device manual
};
```

**Common Offset Patterns:**
- **Protocol-level addressing** (0-based): Modbus spec, most libraries
- **PLC-level addressing** (1-based): Schneider, Allen-Bradley
- **40001-based addressing**: Traditional Modbus (40001 = holding register 0)

**Rule:** Always use addresses as documented in device manual. Let simulator/device handle offset compensation.

## Best Practices

### 1. Configuration

**DO:**
```json
{
  "type": "holding",        // Lowercase, matches typeMap
  "address": 99,            // Exact address from device manual
  "dataType": "uint16",     // Lowercase, matches enum
  "unit": "RPM"             // Human-readable unit
}
```

**DON'T:**
```json
{
  "type": "Holding",        // Capitalized - typeMap lookup fails
  "address": "99",          // String - will fail parseInt
  "dataType": "UINT16",     // Uppercase - enum mismatch
  "functionCode": 3         // Redundant - auto-derived from type
}
```

### 2. Error Handling

**DO:** Always check quality before using value:
```typescript
if (dataPoint.quality === 'GOOD') {
  console.log(`${dataPoint.registerName}: ${dataPoint.value} ${dataPoint.unit}`);
} else {
  console.error(`${dataPoint.registerName}: ${dataPoint.qualityCode}`);
}
```

**DON'T:** Assume value is always valid:
```typescript
// BAD: value may be null when quality is BAD
const rpm = dataPoint.value * 1.5;  // TypeError if value is null
```

### 3. Batching Optimization

**DO:** Group registers with similar addresses under same function code:
```json
{
  "gen_voltage_a": { "type": "holding", "address": 109 },
  "gen_voltage_b": { "type": "holding", "address": 110 },
  "gen_voltage_c": { "type": "holding", "address": 111 }
}
```
Result: Single batch read for addresses 109-111 (3 registers in 1 request)

**DON'T:** Mix function codes expecting batching:
```json
{
  "voltage": { "type": "holding", "address": 109 },
  "alarm": { "type": "coil", "address": 110 }  // Different FC - separate request
}
```

### 4. Data Type Selection

**DO:** Match data type to device specification:
```json
{
  "temperature": { "dataType": "int16" },   // Supports negative values
  "pressure": { "dataType": "uint16" },     // Always positive
  "power_factor": { "dataType": "float32" } // Decimal precision
}
```

**DON'T:** Use oversized types:
```json
{
  "alarm_count": { "dataType": "uint32" }  // BAD: uint16 sufficient for count
}
```

### 5. Timeout Configuration

**DO:** Set timeouts based on network latency:
```json
{
  "connection": {
    "timeoutMs": 5000   // TCP: 5s, Serial: 1-2s, Slow networks: 10s
  }
}
```

**DON'T:** Use infinite timeouts:
```json
{
  "connection": {
    "timeoutMs": 0  // BAD: Hangs forever on network issues
  }
}
```

## Known Issues and Limitations

### 1. Boolean/Coil Data Points (KNOWN ISSUE)

**Status:** Currently non-functional - coil values appear as NULL in database

**Symptoms:**
- Configuration correct (`type:"coil"`, `dataType:"boolean"`)
- No read errors in logs
- Holding registers work correctly
- Coils return NULL/empty in database

**Suspected Causes:**
- Boolean values may be filtered during SensorDataPoint emission
- MQTT JSON serialization issue with booleans
- API database INSERT may not handle boolean type
- PostgreSQL column type mismatch

**Workaround:** Use holding registers for boolean values (0/1) until resolved

**Investigation Notes:**
- `readCoils()` method exists and executes
- `parseCoilData()` returns boolean correctly
- Batch optimization groups coils separately from holding registers
- No evidence of coil values in MQTT messages or logs

### 2. Register Count Field

**Current Behavior:** `count` field defaults to 1 if not specified

**Limitation:** Multi-register data types (FLOAT32, UINT32, INT32, STRING) require explicit `count`:
```json
{
  "power": { 
    "dataType": "float32",
    "count": 2  // REQUIRED: Float32 uses 2 registers
  }
}
```

**Missing count:** Will read only 1 register, causing parse errors

### 3. Byte Order (Endianness)

**Current Implementation:** Big-endian (network byte order) only

**Limitation:** Some devices use little-endian or mixed-endian formats

**Example Issue:**
```
Device sends: [0x1234, 0x5678] (little-endian float32)
Agent parses:  0x12345678 (big-endian) = WRONG VALUE
```

**Future Enhancement:** Add `byteOrder` configuration field

## Testing Patterns

### 1. Simulator Testing

**Modbus Simulator:** `sensors/modbus-simulator/modbus_simulator.py`

```bash
# Start simulator
cd sensors/modbus-simulator
python modbus_simulator.py

# Simulator features:
# - Address compensation: address = address - 1 (pymodbus offset)
# - Realistic varying values around base values
# - Supports holding registers AND coils
```

### 2. Direct Register Read Test

```typescript
// Test individual register read
const value = await modbusClient.readRegisterWithRetry({
  name: 'test_register',
  address: 99,
  dataType: 'uint16',
  functionCode: 3,
  count: 1
});
console.log('Register value:', value);
```

### 3. Quality Code Simulation

```typescript
// Simulate timeout error
try {
  await modbusClient.readRegister(register);
} catch (error) {
  const qualityCode = this.extractQualityCode(error.message);
  console.log('Quality code:', qualityCode);  // Should be 'TIMEOUT'
}
```

## Debugging Checklist

When Modbus data points show as 0, NULL, or missing:

1. **Verify Configuration:**
   - [ ] `type` field is lowercase (`"holding"`, not `"Holding"`)
   - [ ] `address` matches device manual (protocol-level addressing)
   - [ ] `dataType` is valid enum value
   - [ ] Simulator running and accessible

2. **Check Database:**
   ```sql
   SELECT data_points FROM endpoints WHERE protocol = 'modbus';
   ```
   - [ ] `data_points` field is NOT empty array `[]`
   - [ ] Each point has `type` field (for fallback conversion)

3. **Verify Agent Logs:**
   ```bash
   docker logs agent-27 | grep -i "modbus\|exception\|error"
   ```
   - [ ] No connection errors
   - [ ] No exception codes (1-8)
   - [ ] Batch reads succeeding

4. **Check MQTT Messages:**
   ```bash
   docker exec iotistic-mqtt mosquitto_sub -t "sensors/#" -v
   ```
   - [ ] Messages contain expected register names
   - [ ] Values are non-zero
   - [ ] Quality is "GOOD"

5. **Validate Database Records:**
   ```sql
   SELECT metric_name, value, quality, time 
   FROM readings 
   WHERE device_uuid = '<uuid>' 
   ORDER BY time DESC LIMIT 20;
   ```
   - [ ] Records exist for all registers
   - [ ] Values are non-zero
   - [ ] Quality is 'good' (lowercase in database)

## References

- **Modbus Client Implementation:** `agent/src/features/endpoints/modbus/client.ts`
- **Config Transformation:** `agent/src/config/agent-config.ts` (lines 150-185)
- **Discovery Plugin:** `agent/src/features/discovery/modbus.discovery.ts`
- **Adapter Startup:** `agent/src/features/endpoints/sensors-feature.ts` (lines 158-175)
- **Type Definitions:** `agent/src/features/endpoints/types.ts`
- **Simulator:** `sensors/modbus-simulator/modbus_simulator.py`

---

<!-- End of Modbus Functionality Instructions -->
