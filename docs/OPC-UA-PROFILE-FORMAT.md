# OPC UA Profile Data Points Format

**Final Standard Format** - Enforced by API validation (IEC 62541 OPC UA Standards)

## Overview

OPC UA profiles define sensor groups that the simulator uses to create nodes in the OPC UA server. Discovery then browses these nodes and extracts semantic metric names for data collection.

## Profile Structure

### Complete Example

```json
{
  "profile_name": "TestFactory2",
  "protocol": "opcua",
  "data_points": [
    {
      "folder": "Production",
      "prefix": "Temperature_",
      "model": "temperature",
      "count": 3,
      "unit": "°C",
      "config": {
        "min": 18,
        "max": 35,
        "volatility": 0.5
      }
    },
    {
      "folder": "Production",
      "prefix": "Pressure_",
      "model": "pressure",
      "count": 2,
      "unit": "bar",
      "config": {
        "min": 0.8,
        "max": 1.2,
        "volatility": 0.1
      }
    },
    {
      "folder": "Production",
      "prefix": "Flow_",
      "model": "flow",
      "count": 1,
      "unit": "L/min",
      "config": {
        "min": 10,
        "max": 100,
        "volatility": 2.0
      }
    }
  ],
  "metadata": {
    "description": "Factory production monitoring sensors",
    "namespace": "urn:iotistic:testfactory2",
    "vendorUrl": "https://iotistic.com"
  }
}
```

## Data Point Fields

### Required Fields (Sensor Group)

| Field | Type | Format | Example | Description |
|-------|------|--------|---------|-------------|
| `folder` | string | Alphanumeric | `"Production"` | OPC UA folder/namespace where nodes are created |
| `prefix` | string | **`MetricType_`** | `"Temperature_"` | **MUST end with underscore**. Used to create node browserNames |
| `model` | string | **lowercase** | `"temperature"` | **MUST be lowercase**. Semantic metric name extracted by discovery |
| `count` | number | 1-100 | `3` | Number of sensor instances to generate |
| `unit` | string | Engineering unit | `"°C"`, `"bar"`, `"L/min"` | Physical unit of measurement |

### Optional Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `config.min` | number | 0 | Minimum sensor value |
| `config.max` | number | 100 | Maximum sensor value |
| `config.volatility` | number | 1.0 | How much sensor value changes per update |

## Naming Convention Rules (ENFORCED)

### 1. Prefix Format

**✅ Valid:**
- `"Temperature_"` (ends with underscore)
- `"Pressure_"` (PascalCase + underscore)
- `"Flow_Rate_"` (multiple words + underscore)

**❌ Invalid:**
- `"Temperature"` (missing underscore)
- `"Sensor_"` (not semantic)
- `"temp"` (too short, not descriptive)

**Error Message:**
```
Prefix "Temperature" must follow format "MetricType_" (e.g., "Temperature_", "Pressure_", "Flow_").
This ensures proper metric extraction following OPC UA standards.
```

### 2. Model Format

**✅ Valid:**
- `"temperature"` (lowercase, matches prefix)
- `"pressure"` (lowercase, matches prefix)
- `"flow_rate"` (lowercase with underscores)

**❌ Invalid:**
- `"Temperature"` (uppercase)
- `"TEMP"` (uppercase)
- `"temp-sensor"` (contains hyphen)

**Error Message:**
```
Model "Temperature" must be lowercase with underscores only (e.g., "temperature", "pressure", "flow_rate").
This is the semantic metric name used in data collection.
```

### 3. Prefix-Model Consistency (RECOMMENDED)

The `model` field should be the `prefix` without the trailing underscore, in lowercase:

| Prefix | Expected Model | Notes |
|--------|----------------|-------|
| `"Temperature_"` | `"temperature"` | ✅ Correct |
| `"Pressure_"` | `"pressure"` | ✅ Correct |
| `"Flow_Rate_"` | `"flow_rate"` | ✅ Correct |
| `"Temperature_"` | `"temp"` | ⚠️ Warning logged (inconsistent but allowed) |

## How It Works

### 1. Profile → Simulator

Simulator reads profile and creates OPC UA nodes:

```
Profile:
  { "prefix": "Temperature_", "model": "temperature", "count": 3 }

OPC UA Server Creates:
  ns=2;s=Production/Temperature_Sensor1  (browseName: "Temperature_Sensor1")
  ns=2;s=Production/Temperature_Sensor2  (browseName: "Temperature_Sensor2")
  ns=2;s=Production/Temperature_Sensor3  (browseName: "Temperature_Sensor3")
```

### 2. Discovery → Database

Discovery browses OPC UA server and extracts metric names:

```typescript
// Discovery finds: browseName = "Temperature_Sensor1"
const metricName = nodeName.split('_')[0].toLowerCase(); // → "temperature"

// Saves to database:
{
  nodeId: "ns=2;s=Production/Temperature_Sensor1",
  name: "temperature"  // ← Used by adapter!
}
```

### 3. Adapter → Data Collection

Adapter reads nodes and publishes values:

```
MQTT Topic: sensor/temperature
Payload: { "value": 23.5, "unit": "°C" }
```

## Alternative Format: Manual Nodes

For pre-discovered nodes or static configurations:

```json
{
  "profile_name": "ManualConfig",
  "protocol": "opcua",
  "data_points": [
    {
      "name": "temperature",
      "nodeId": "ns=2;s=Production/Temperature_Sensor1"
    },
    {
      "name": "pressure",
      "nodeId": "ns=2;s=Production/Pressure_Sensor1"
    }
  ]
}
```

**Validation**: Each node must have `name` (metric) and `nodeId` (OPC UA identifier).

## API Endpoints

### Create/Update Profile

```bash
POST /api/v1/profiles
Content-Type: application/json

{
  "profile_name": "TestFactory2",
  "protocol": "opcua",
  "data_points": [
    {
      "folder": "Production",
      "prefix": "Temperature_",
      "model": "temperature",
      "count": 3,
      "unit": "°C",
      "config": { "min": 18, "max": 35 }
    }
  ],
  "metadata": {
    "description": "Test factory profile"
  }
}
```

**Response (Success):**
```json
{
  "status": "ok",
  "message": "Profile 'TestFactory2' configuration saved",
  "profile": { ... }
}
```

**Response (Validation Error):**
```json
{
  "error": "Invalid OPC UA prefix",
  "message": "Prefix \"Temperature\" must follow format \"MetricType_\" (e.g., \"Temperature_\", \"Pressure_\", \"Flow_\"). This ensures proper metric extraction following OPC UA standards."
}
```

### Get All Profiles (DataPoints Format)

```bash
GET /api/v1/profiles/datapoints?protocol=opcua
```

**Response:**
```json
{
  "TestFactory2": {
    "dataPoints": [ ... ],
    "metadata": { ... }
  },
  "ProductionLine": {
    "dataPoints": [ ... ]
  }
}
```

## Standard Metric Types

Common semantic metric names following IEC 62541:

| Metric Type | Prefix | Model | Unit Examples |
|-------------|--------|-------|---------------|
| Temperature | `Temperature_` | `temperature` | °C, °F, K |
| Pressure | `Pressure_` | `pressure` | bar, psi, Pa |
| Flow Rate | `Flow_` | `flow` | L/min, m³/h, GPM |
| Humidity | `Humidity_` | `humidity` | %, g/m³ |
| Voltage | `Voltage_` | `voltage` | V, mV, kV |
| Current | `Current_` | `current` | A, mA |
| Power | `Power_` | `power` | W, kW, MW |
| Speed | `Speed_` | `speed` | rpm, m/s, km/h |
| Level | `Level_` | `level` | m, cm, % |

## Migration from Old Format

**Old Format (Deprecated):**
```json
{
  "prefix": "Sensor_",
  "model": "sensor",
  "count": 3
}
```
Result: Metrics named "sensor" (not semantic) ❌

**New Format (Standard):**
```json
{
  "prefix": "Temperature_",
  "model": "temperature",
  "count": 3
}
```
Result: Metrics named "temperature" (semantic) ✅

## Troubleshooting

### Issue: "All NodeIDs failed validation"

**Cause**: Discovery found nodes but couldn't extract valid metric names.

**Solution**:
1. Check profile uses correct prefix format (`Temperature_` not `Temperature`)
2. Ensure model field is lowercase (`temperature` not `Temperature`)
3. Restart simulator to load updated profile
4. Re-run discovery to populate data_points

### Issue: Metrics Named "sensor" Instead of "temperature"

**Cause**: Using old profile format with `"Sensor_"` prefix.

**Solution**:
1. Update profile to use semantic prefix (`Temperature_` instead of `Sensor_`)
2. Update model field to match (`temperature` instead of `sensor`)
3. Restart simulator
4. Delete old device from database or re-run discovery

### Issue: Validation Error on Profile Save

**Cause**: Prefix or model doesn't follow OPC UA standards.

**Solution**:
1. Ensure prefix ends with underscore: `"Temperature_"`
2. Ensure model is lowercase: `"temperature"`
3. Prefix and model should match (e.g., `Temperature_` → `temperature`)

## References

- **OPC UA Standard**: IEC 62541 (OPC Unified Architecture)
- **Companion Specifications**: OPC UA for Devices (Part 100)
- **Discovery Implementation**: `agent/src/features/discovery/opcua.discovery.ts`
- **Profile Validation**: `api/src/routes/profiles.ts`
- **Adapter Logic**: `agent/src/features/endpoints/opcua/opcua.adapter.ts`

## Summary

**Key Takeaways:**
1. ✅ Prefix **MUST** end with underscore: `"Temperature_"`
2. ✅ Model **MUST** be lowercase: `"temperature"`
3. ✅ Model should match prefix (consistency warning if not)
4. ✅ Discovery extracts metric from browseName prefix (part before underscore)
5. ✅ Validation enforced at API level for data quality
