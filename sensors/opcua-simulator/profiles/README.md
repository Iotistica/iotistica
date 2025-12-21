# OPC UA Simulator Profiles

## Overview

Profiles define sensor configurations for the OPC UA simulator. Each profile is a JSON file that specifies which sensors to simulate, their behavior, and organization.

## Profile Structure

```json
{
  "name": "Profile Name",
  "description": "Description of this profile",
  "sensors": [
    {
      "folder": "Folder name in OPC UA tree",
      "prefix": "Node name prefix",
      "model": "Sensor model type",
      "count": 5,
      "unit": "Unit of measurement",
      "config": {
        "base": 25.0,
        "variation": 5.0,
        "noise": 0.5,
        "period": 30.0,
        "min_value": -50.0,
        "max_value": 150.0
      }
    }
  ]
}
```

## Available Sensor Models

### temperature
Simulates temperature sensors with sinusoidal variation
- **Config**: base, variation, noise, period, min_value, max_value
- **Typical base**: 25°C
- **Typical variation**: ±5°C
- **Typical period**: 30s

### pressure
Simulates pressure sensors
- **Config**: base, variation, noise, period, min_value, max_value
- **Typical base**: 1100 mbar
- **Typical variation**: ±50 mbar
- **Typical period**: 45s

### flow
Simulates flow rate sensors
- **Config**: base, variation, noise, period, min_value, max_value
- **Typical base**: 50 L/min
- **Typical variation**: ±30 L/min
- **Typical period**: 20s

### level
Simulates level/tank sensors
- **Config**: base, variation, noise, period, min_value, max_value
- **Typical base**: 500 mm
- **Typical variation**: ±200 mm
- **Typical period**: 40s

### vibration
Simulates vibration sensors with occasional spikes
- **Config**: base, variation, noise, period, spike_probability, min_value, max_value
- **Typical base**: 20 mm/s
- **Typical variation**: ±15 mm/s
- **spike_probability**: 0.05 (5% chance of spike)

### power
Simulates power consumption sensors
- **Config**: base, variation, noise, period, min_value, max_value
- **Typical base**: 5000 W
- **Typical variation**: ±2000 W
- **Typical period**: 25s

### oscillating
Simple oscillating test sensor
- **Config**: base, variation, noise, period
- **No min/max constraints**

## Creating Custom Profiles

### Example: Small Workshop

Create `workshop.json`:

```json
{
  "name": "Workshop",
  "description": "Small workshop with basic monitoring",
  "sensors": [
    {
      "folder": "Environment",
      "prefix": "Room",
      "model": "temperature",
      "count": 3,
      "unit": "°C",
      "config": {
        "base": 22.0,
        "variation": 2.0,
        "noise": 0.3,
        "period": 60.0,
        "min_value": 10.0,
        "max_value": 35.0
      }
    },
    {
      "folder": "Equipment",
      "prefix": "Machine",
      "model": "vibration",
      "count": 2,
      "unit": "mm/s",
      "config": {
        "base": 15.0,
        "variation": 8.0,
        "noise": 0.5,
        "period": 10.0,
        "spike_probability": 0.02,
        "min_value": 0.0,
        "max_value": 50.0
      }
    }
  ]
}
```

### Example: Customer-Specific Factory

Create `customer-acme.json`:

```json
{
  "name": "ACME Factory",
  "description": "ACME Corp production line monitoring",
  "sensors": [
    {
      "folder": "ProductionLine1",
      "prefix": "Zone",
      "model": "temperature",
      "count": 8,
      "unit": "°C",
      "config": {
        "base": 80.0,
        "variation": 10.0,
        "noise": 1.0,
        "period": 30.0,
        "min_value": 0.0,
        "max_value": 200.0
      }
    },
    {
      "folder": "ProductionLine1",
      "prefix": "Conveyor",
      "model": "power",
      "count": 4,
      "unit": "W",
      "config": {
        "base": 3000.0,
        "variation": 1000.0,
        "noise": 100.0,
        "period": 20.0,
        "min_value": 0.0,
        "max_value": 8000.0
      }
    }
  ]
}
```

## Using Custom Profiles

### Command Line
```bash
python opcua_simulator.py custom-profile-name
```

### Docker Compose
```yaml
services:
  opcua-simulator:
    # ... other config
    command: python opcua_simulator.py customer-acme
    volumes:
      - ./profiles:/app/profiles:ro  # Mount custom profiles
```

## Profile Validation

Profiles are validated on load:
- ✅ Required fields: name, sensors
- ✅ Each sensor must have: folder, prefix, model, count
- ✅ Model must exist in MODEL_REGISTRY
- ✅ Config parameters validated per model type
- ❌ Invalid profiles will show clear error messages

## Built-in Profiles

### factory.json
Standard industrial factory with 6 sensor types, 25 total sensors

### test.json
Minimal testing profile with 2 sensor types, 4 total sensors

## Version Control

Store customer profiles in version control:
```
profiles/
├── factory.json          # Default
├── test.json             # Testing
├── customer-acme.json    # Customer-specific
├── customer-beta.json
└── workshop.json         # Custom scenarios
```

## Benefits

- ✅ **No code changes** required for new configurations
- ✅ **Customer-specific** simulations without branching
- ✅ **Version controlled** configurations
- ✅ **Easy testing** of different scenarios
- ✅ **Non-developers** can create profiles
- ✅ **Aligns** with Modbus simulator approach
