# MQTT Endpoint Schema

JSON Schema for configuring MQTT device endpoints in the Iotistic platform. This schema is used for target state reconciliation between cloud and edge agents.

## Table of Contents

- [JSON Schema Definition](#json-schema-definition)
- [Configuration Examples](#configuration-examples)
- [Data Types](#data-types)
- [Wildcard Patterns](#wildcard-patterns)
- [Discovery vs Runtime](#discovery-vs-runtime)
- [Best Practices](#best-practices)

## JSON Schema Definition

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "MQTT Device Endpoint",
  "description": "MQTT endpoint configuration for target state reconciliation",
  "type": "object",
  "required": ["name", "protocol", "enabled", "connection", "dataPoints"],
  "properties": {
    "uuid": {
      "type": "string",
      "format": "uuid",
      "description": "Stable identifier for cloud/edge sync (auto-generated if not provided)"
    },
    "name": {
      "type": "string",
      "minLength": 1,
      "description": "Unique device name (e.g., 'mqtt-esp32-sensor-01')"
    },
    "protocol": {
      "type": "string",
      "enum": ["mqtt"],
      "description": "Must be 'mqtt'"
    },
    "enabled": {
      "type": "boolean",
      "description": "Enable/disable this endpoint"
    },
    "poll_interval": {
      "type": "integer",
      "minimum": 100,
      "maximum": 300000,
      "default": 5000,
      "description": "Not used for MQTT (event-driven), kept for schema consistency"
    },
    "connection": {
      "type": "object",
      "required": ["brokerUrl"],
      "properties": {
        "brokerUrl": {
          "type": "string",
          "format": "uri",
          "pattern": "^mqtts?://",
          "description": "MQTT broker URL (e.g., 'mqtt://mosquitto:1883' or 'mqtts://broker:8883')",
          "examples": [
            "mqtt://mosquitto:1883",
            "mqtt://192.168.1.100:1883",
            "mqtts://mqtt.example.com:8883"
          ]
        },
        "username": {
          "type": "string",
          "description": "MQTT authentication username (optional)"
        },
        "password": {
          "type": "string",
          "description": "MQTT authentication password (optional)"
        },
        "clientId": {
          "type": "string",
          "description": "MQTT client ID (auto-generated if not provided)"
        },
        "qos": {
          "type": "integer",
          "enum": [0, 1, 2],
          "default": 0,
          "description": "Quality of Service level (0=at most once, 1=at least once, 2=exactly once)"
        },
        "topics": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Topics for discovery validation (used by getDiscoveryTargets)"
        }
      },
      "additionalProperties": false
    },
    "dataPoints": {
      "type": "array",
      "minItems": 1,
      "description": "MQTT topic subscriptions and data point configurations",
      "items": {
        "type": "object",
        "required": ["name", "topic", "dataType"],
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "description": "Data point name (e.g., 'temperature', 'humidity')",
            "examples": ["temperature", "humidity", "pressure"]
          },
          "topic": {
            "type": "string",
            "minLength": 1,
            "description": "MQTT topic to subscribe to (supports wildcards: +, #)",
            "examples": [
              "sensor/temperature",
              "device/esp32/+/data",
              "sensors/#"
            ]
          },
          "dataType": {
            "type": "string",
            "enum": [
              "number",
              "boolean",
              "string",
              "json",
              "int32",
              "uint32",
              "float32",
              "int16",
              "uint16",
              "float",
              "double",
              "integer"
            ],
            "description": "Data type - broad types from discovery (number, boolean, string, json) or specific types for manual config (int32, float32, etc.)"
          },
          "unit": {
            "type": "string",
            "description": "Unit of measurement (optional)",
            "examples": ["°C", "°F", "%", "hPa", "ppm"]
          },
          "metric": {
            "type": "string",
            "description": "Metric name (defaults to topic if not specified)"
          },
          "deviceId": {
            "type": "string",
            "description": "Optional device identifier for data source tracking"
          },
          "enabled": {
            "type": "boolean",
            "default": true,
            "description": "Enable/disable this specific topic subscription"
          }
        },
        "additionalProperties": false
      }
    },
    "metadata": {
      "type": "object",
      "description": "Additional protocol-specific metadata (optional)",
      "properties": {
        "description": {
          "type": "string",
          "description": "Human-readable description"
        },
        "location": {
          "type": "string",
          "description": "Physical location"
        },
        "tags": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "description": "Tags for categorization"
        }
      },
      "additionalProperties": true
    }
  },
  "additionalProperties": false
}
```

## Configuration Examples

### Basic Environmental Sensor

```json
{
  "name": "mqtt-esp32-sensor-01",
  "protocol": "mqtt",
  "enabled": true,
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883"
  },
  "dataPoints": [
    {
      "name": "temperature",
      "topic": "sensor/esp32/temperature",
      "dataType": "float32",
      "unit": "°C"
    },
    {
      "name": "humidity",
      "topic": "sensor/esp32/humidity",
      "dataType": "float32",
      "unit": "%"
    }
  ]
}
```

### Authenticated Connection with QoS

```json
{
  "uuid": "550e8400-e29b-41d4-a716-446655440001",
  "name": "mqtt-secure-sensor",
  "protocol": "mqtt",
  "enabled": true,
  "connection": {
    "brokerUrl": "mqtts://mqtt.example.com:8883",
    "username": "sensor_user",
    "password": "secret_pass",
    "clientId": "iotistic-sensor-01",
    "qos": 1
  },
  "dataPoints": [
    {
      "name": "temperature",
      "topic": "sensors/room1/temp",
      "dataType": "float32",
      "unit": "°C",
      "enabled": true
    }
  ],
  "metadata": {
    "description": "Secure MQTT sensor with authentication",
    "location": "Server Room 1",
    "tags": ["secure", "production"]
  }
}
```

### Wildcard Topic Subscriptions

```json
{
  "name": "mqtt-multi-sensor",
  "protocol": "mqtt",
  "enabled": true,
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "qos": 1
  },
  "dataPoints": [
    {
      "name": "all_temperatures",
      "topic": "building/+/temperature",
      "dataType": "number",
      "unit": "°C",
      "metric": "temperature"
    },
    {
      "name": "all_sensors",
      "topic": "sensors/#",
      "dataType": "json",
      "metric": "sensor_data"
    }
  ]
}
```

### IoT Device with Multiple Metrics

```json
{
  "name": "mqtt-iot-device-floor2",
  "protocol": "mqtt",
  "enabled": true,
  "connection": {
    "brokerUrl": "mqtt://192.168.1.100:1883",
    "username": "iot_device",
    "password": "device_pass",
    "qos": 1
  },
  "dataPoints": [
    {
      "name": "temperature",
      "topic": "floor2/device01/temperature",
      "dataType": "float32",
      "unit": "°C",
      "deviceId": "device01"
    },
    {
      "name": "humidity",
      "topic": "floor2/device01/humidity",
      "dataType": "float32",
      "unit": "%",
      "deviceId": "device01"
    },
    {
      "name": "pressure",
      "topic": "floor2/device01/pressure",
      "dataType": "float32",
      "unit": "hPa",
      "deviceId": "device01"
    },
    {
      "name": "air_quality",
      "topic": "floor2/device01/airquality",
      "dataType": "int32",
      "unit": "ppm",
      "deviceId": "device01"
    },
    {
      "name": "device_status",
      "topic": "floor2/device01/status",
      "dataType": "json",
      "deviceId": "device01"
    }
  ],
  "metadata": {
    "description": "Multi-sensor IoT device on floor 2",
    "location": "Floor 2, Room 201",
    "tags": ["environmental", "multi-sensor", "floor2"]
  }
}
```

### Discovery Configuration

```json
{
  "name": "mqtt-discovery-target",
  "protocol": "mqtt",
  "enabled": true,
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "topics": [
      "sensor/temperature",
      "sensor/humidity",
      "device/status"
    ]
  },
  "dataPoints": []
}
```

**Note**: When `connection.topics` is provided and `dataPoints` is empty, this endpoint is used for discovery validation. The discovery service will verify these topics receive data and suggest them as candidates for configuration.

## Data Types

### Broad Types (Discovery)

These are safely inferred during discovery and recommended for auto-detected devices:

| Type | Description | Examples |
|------|-------------|----------|
| `number` | Any numeric value | `23.5`, `100`, `-15.2` |
| `boolean` | True/false values | `true`, `false`, `1`, `0` |
| `string` | Text data | `"active"`, `"sensor-01"` |
| `json` | Complex JSON objects | `{"temp": 23, "unit": "C"}` |

### Specific Types (Manual Configuration)

Use these when you know the exact data format from the device:

| Type | Description | Range | Bytes |
|------|-------------|-------|-------|
| `int16` | Signed 16-bit integer | -32,768 to 32,767 | 2 |
| `uint16` | Unsigned 16-bit integer | 0 to 65,535 | 2 |
| `int32` | Signed 32-bit integer | -2,147,483,648 to 2,147,483,647 | 4 |
| `uint32` | Unsigned 32-bit integer | 0 to 4,294,967,295 | 4 |
| `float32` | 32-bit floating point | ±1.5 × 10^-45 to ±3.4 × 10^38 | 4 |
| `float` | Alias for `float32` | Same as float32 | 4 |
| `double` | 64-bit floating point | ±5.0 × 10^-324 to ±1.7 × 10^308 | 8 |
| `integer` | Generic integer | Same as int32 | 4 |

**Best Practice**: Start with broad types from discovery, then refine to specific types based on device specifications.

## Wildcard Patterns

MQTT supports two wildcard characters in topic subscriptions:

### Single-Level Wildcard (`+`)

Matches exactly one topic level:

```json
{
  "topic": "building/+/temperature"
}
```

**Matches**:
- `building/floor1/temperature` ✅
- `building/floor2/temperature` ✅
- `building/basement/temperature` ✅

**Does NOT match**:
- `building/temperature` ❌ (missing level)
- `building/floor1/room1/temperature` ❌ (too many levels)

### Multi-Level Wildcard (`#`)

Matches zero or more topic levels (must be last character):

```json
{
  "topic": "sensors/#"
}
```

**Matches**:
- `sensors/` ✅
- `sensors/temperature` ✅
- `sensors/room1/temperature` ✅
- `sensors/floor2/room3/device1/temp` ✅

**Invalid**:
- `sensors/#/temperature` ❌ (`#` must be last)

### Wildcard Best Practices

1. **Be specific when possible** - `sensor/esp32/temperature` is better than `sensor/#`
2. **Use `+` for known structure** - `building/+/temperature` for multiple buildings
3. **Avoid broad wildcards** - `#` subscribes to ALL topics (performance impact)
4. **Test patterns** - Verify wildcards match expected topics only

## Discovery vs Runtime

### Discovery Phase

Used to validate topics receive data before creating full configuration:

```json
{
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883",
    "topics": ["sensor/temp", "sensor/humidity"]
  },
  "dataPoints": []
}
```

**What happens**:
1. Agent subscribes to specified topics
2. Listens for 10 seconds (configurable)
3. Reports which topics received messages
4. Suggests broad data types based on payload

### Runtime Phase

Full configuration with specific data points:

```json
{
  "connection": {
    "brokerUrl": "mqtt://mosquitto:1883"
  },
  "dataPoints": [
    {
      "name": "temperature",
      "topic": "sensor/temp",
      "dataType": "float32",
      "unit": "°C"
    }
  ]
}
```

**What happens**:
1. Agent subscribes to all `dataPoints[].topic` values
2. Receives messages continuously
3. Parses payload according to `dataType`
4. Forwards to cloud with quality indicators

## Best Practices

### 1. Naming Conventions

```json
{
  "name": "mqtt-{device-type}-{location}-{id}",
  "dataPoints": [
    {
      "name": "{metric}",
      "metric": "{metric}",
      "topic": "{namespace}/{device}/{metric}"
    }
  ]
}
```

**Examples**:
- `mqtt-esp32-floor2-01`
- `mqtt-plc-warehouse-controller`
- `mqtt-sensor-outdoor-temp`

### 2. Topic Structure

Use hierarchical topics for organization:

```
{namespace}/{location}/{device}/{metric}
```

**Examples**:
- `sensors/floor1/room101/temperature`
- `devices/production/plc001/status`
- `building/basement/hvac/setpoint`

### 3. QoS Selection

| QoS | Use Case | Trade-off |
|-----|----------|-----------|
| 0 | High-frequency sensor data, acceptable loss | Fast, no guarantee |
| 1 | Important metrics, duplicate tolerance | Reliable, possible duplicates |
| 2 | Critical commands, no duplicates allowed | Slowest, guaranteed delivery |

**Recommendation**: Use QoS 1 for most sensor data (good balance).

### 4. Authentication

Always use authentication in production:

```json
{
  "connection": {
    "brokerUrl": "mqtts://broker:8883",
    "username": "device_id",
    "password": "secure_token"
  }
}
```

### 5. Data Type Selection

**Discovery → Manual refinement**:
1. Run discovery with broad types
2. Observe actual data formats
3. Update to specific types in production config

```json
// Discovery suggests
{ "dataType": "number" }

// Refine to specific type
{ "dataType": "float32" }
```

### 6. Topic Validation

Before deploying, verify topics:
1. Subscribe manually: `mosquitto_sub -h broker -t "sensor/+/temp"`
2. Publish test data: `mosquitto_pub -h broker -t "sensor/test/temp" -m "23.5"`
3. Confirm message format matches expected `dataType`

### 7. Metadata Usage

Use metadata for operational context:

```json
{
  "metadata": {
    "description": "Outdoor temperature sensor",
    "location": "Building A - North wall",
    "tags": ["outdoor", "critical", "temperature"],
    "installDate": "2026-01-15",
    "maintenanceSchedule": "quarterly"
  }
}
```

## Integration with Target State

### Cloud → Agent Flow

1. **Cloud API** sends target state with MQTT endpoint:
```json
{
  "device_uuid": "agent-uuid-123",
  "target_state": {
    "endpoints": [
      {
        "name": "mqtt-sensor-01",
        "protocol": "mqtt",
        "enabled": true,
        "connection": { ... },
        "dataPoints": [ ... ]
      }
    ]
  }
}
```

2. **Agent** receives via CloudSync service (polling or MQTT trigger)

3. **ConfigManager** validates schema and applies changes

4. **MQTT Adapter** creates/updates subscriptions:
   - Self-healing connection (survives broker downtime)
   - Subscribes to all `dataPoints[].topic`
   - Emits data events with quality indicators

5. **SensorsFeature** forwards data to cloud via SocketServer

### Self-Healing Architecture

The MQTT adapter uses a resilient pattern:

- **Creates client immediately** (doesn't wait for broker)
- **mqtt.js handles reconnection** automatically
- **Survives broker downtime** at startup
- **Event-driven state** tracking

This means you can push MQTT endpoint configurations even if the broker is temporarily unavailable - the agent will connect when the broker comes online.

## Troubleshooting

### Connection Issues

**Symptom**: Endpoint enabled but no data
**Check**:
1. Broker URL correct: `mqtt://mosquitto:1883`
2. Authentication credentials valid
3. Network connectivity: `ping mosquitto`
4. Broker running: `docker ps | grep mosquitto`

### Topic Subscription Issues

**Symptom**: Some topics receive data, others don't
**Check**:
1. Verify topic spelling (case-sensitive)
2. Test with mosquitto_sub: `mosquitto_sub -h broker -t "your/topic"`
3. Check wildcard patterns match expected topics
4. Verify QoS compatibility

### Data Type Mismatches

**Symptom**: Parse errors in logs
**Check**:
1. Actual payload format: `mosquitto_sub -h broker -t "topic" -v`
2. Expected `dataType` vs payload
3. Try broad type (`number`, `string`, `json`) first
4. Use `json` type for complex objects

### Discovery Not Finding Topics

**Symptom**: Discovery returns empty results
**Check**:
1. Topics actively publishing during discovery window (10s default)
2. Broker URL and credentials correct
3. Topics listed in `connection.topics` array
4. Increase sampling duration if needed

## Related Documentation

- [MQTT Architecture Review](../agent/MQTT-ARCHITECTURE-REVIEW.md) - Complete architecture overview
- [MQTT Discovery Plugin](../agent/src/features/discovery/mqtt.discovery.ts) - Discovery implementation
- [MQTT Adapter](../agent/src/features/adapters/mqtt/adapter.ts) - Runtime adapter implementation
- [Config Manager](../agent/src/device-manager/config.ts) - Target state reconciliation

## Schema Version

**Version**: 1.0.0  
**Last Updated**: 2026-02-27  
**Compatibility**: Agent v2.0+
