# Config-Driven Profiles Implementation

## Summary

Successfully implemented JSON-based profile configuration for the OPC UA simulator, replacing hard-coded Python dictionaries with flexible JSON files.

## What Changed

### Before (Hard-coded)
```python
# lib/profiles.py
FACTORY_PROFILE = SensorProfile(
    name="Factory",
    sensors=[
        {'folder': 'Temperature', 'model': 'temperature', 'count': 5, 'unit': '°C'},
        # ... more hard-coded sensors
    ]
)
```

### After (JSON-driven)
```json
{
  "name": "Factory",
  "description": "Standard industrial factory",
  "sensors": [
    {
      "folder": "Temperature",
      "prefix": "Sensor",
      "model": "temperature",
      "count": 5,
      "unit": "°C",
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

## Key Features

### 1. **Automatic Profile Discovery**
- All `*.json` files in `profiles/` directory are automatically loaded
- Profile name = filename (e.g., `factory.json` → `factory`)
- No code changes needed to add new profiles

### 2. **Config Override System**
- Each sensor group can override model defaults via `config` object
- Customize: `base`, `variation`, `noise`, `period`, `min_value`, `max_value`
- Models provide sensible defaults if config not specified

### 3. **Profile Validation**
- Required fields checked: `name`, `sensors`
- Each sensor group validated: `folder`, `prefix`, `model`, `count`
- Model type must exist in `MODEL_REGISTRY`
- Clear error messages on validation failure

### 4. **Backward Compatible**
- Existing code works unchanged
- `get_profile('factory')` still returns `SensorProfile` object
- Same data structure, different loading mechanism

## File Structure

```
sensors/opcua-simulator/
├── profiles/
│   ├── factory.json         # 25 sensors, 6 types (default)
│   ├── test.json             # 4 sensors, 2 types (testing)
│   ├── workshop.json         # 7 sensors, 3 types (example)
│   └── README.md             # Profile documentation
├── lib/
│   ├── profiles.py           # JSON loading + validation
│   ├── models.py             # Config-aware sensor models
│   ├── nodes.py              # Uses sensor config
│   ├── types.py              # Sensor dataclass (includes config)
│   └── updater.py            # Initializes models with config
└── opcua_simulator.py        # Entry point (unchanged)
```

## Built-in Profiles

### factory.json
**Purpose**: Standard industrial factory simulation  
**Sensors**: 25 total (5 temp, 5 pressure, 5 flow, 3 level, 4 vibration, 3 power)  
**Use Case**: Default profile, comprehensive monitoring

### test.json
**Purpose**: Minimal testing profile  
**Sensors**: 4 total (2 temp, 2 pressure)  
**Use Case**: Quick tests, development

### workshop.json
**Purpose**: Small workshop example  
**Sensors**: 7 total (3 environment temp, 2 machine vibration, 2 power)  
**Use Case**: Demonstrates custom configuration

## Usage Examples

### Command Line
```bash
# Use factory profile (default)
python opcua_simulator.py

# Use test profile
python opcua_simulator.py test

# Use workshop profile
python opcua_simulator.py workshop
```

### Docker Compose
```yaml
services:
  opcua-simulator:
    image: opcua-simulator:latest
    command: python opcua_simulator.py workshop
    volumes:
      - ./profiles:/app/profiles:ro  # Optional: mount custom profiles
```

### Custom Profile in Docker
```bash
# Create custom profile
echo '{...}' > profiles/customer-acme.json

# Rebuild container
docker compose up -d opcua-simulator --build

# Use custom profile
docker compose run opcua-simulator python opcua_simulator.py customer-acme
```

## Creating Custom Profiles

### Example: High-Temperature Furnace Monitoring

Create `profiles/furnace.json`:
```json
{
  "name": "Furnace",
  "description": "High-temperature industrial furnace monitoring",
  "sensors": [
    {
      "folder": "Zones",
      "prefix": "Zone",
      "model": "temperature",
      "count": 8,
      "unit": "°C",
      "config": {
        "base": 800.0,
        "variation": 50.0,
        "noise": 10.0,
        "period": 45.0,
        "min_value": 0.0,
        "max_value": 1200.0
      }
    },
    {
      "folder": "Cooling",
      "prefix": "Fan",
      "model": "power",
      "count": 4,
      "unit": "W",
      "config": {
        "base": 2000.0,
        "variation": 500.0,
        "noise": 50.0,
        "period": 20.0,
        "min_value": 0.0,
        "max_value": 5000.0
      }
    }
  ]
}
```

Run: `python opcua_simulator.py furnace`

## Benefits

### For Developers
- ✅ No code changes for new configurations
- ✅ Easy to test different scenarios
- ✅ Clear separation of data and logic
- ✅ Type-safe with dataclasses
- ✅ Validated on load

### For Customers
- ✅ Customer-specific simulations without branching code
- ✅ Version control profiles separately
- ✅ Non-developers can create profiles
- ✅ Easy to share configurations
- ✅ Quick profile switching

### Architectural Alignment
- ✅ Matches Modbus simulator's JSON state approach
- ✅ Consistent pattern across simulators
- ✅ Infrastructure-as-code philosophy
- ✅ Testable and maintainable

## Technical Implementation

### SensorProfile.from_json()
```python
@classmethod
def from_json(cls, filepath: Path) -> 'SensorProfile':
    with open(filepath, 'r') as f:
        data = json.load(f)
    
    # Validation
    if 'name' not in data:
        raise ValueError(f"Profile missing 'name' field")
    
    # Validate sensor groups
    for sensor_group in data['sensors']:
        required = {'folder', 'prefix', 'model', 'count'}
        missing = required - set(sensor_group.keys())
        if missing:
            raise ValueError(f"Missing fields: {missing}")
    
    return cls(name=data['name'], 
               description=data.get('description', ''),
               sensors=data['sensors'])
```

### Model Config Merging
```python
class TemperatureSensor(SensorModel):
    def __init__(self, config: Dict[str, Any] = None):
        defaults = {
            'base': 25.0,
            'variation': 5.0,
            'noise': 0.5,
            'period': 30.0,
            'min': -50.0,
            'max': 150.0
        }
        # Merge config with defaults
        merged = {**defaults, **(config or {})}
        super().__init__(merged)
```

### get_model() with Config
```python
def get_model(model_type: str, config: Dict[str, Any] = None) -> SensorModel:
    if model_type not in MODEL_REGISTRY:
        raise ValueError(f"Unknown model type: {model_type}")
    return MODEL_REGISTRY[model_type](config)
```

## Next Steps

### Potential Enhancements
1. **YAML Support**: Load profiles from YAML files as well
2. **Profile Validation Schema**: JSON Schema for IDE autocomplete
3. **Hot Reload**: Reload profiles without restarting server
4. **Profile Inheritance**: Base profiles + overrides
5. **Dynamic Profile Switching**: REST API to switch profiles at runtime
6. **Web UI**: Visual profile editor

### Example: JSON Schema Validation
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "OPC UA Profile",
  "type": "object",
  "required": ["name", "sensors"],
  "properties": {
    "name": { "type": "string" },
    "description": { "type": "string" },
    "sensors": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["folder", "prefix", "model", "count"],
        "properties": {
          "folder": { "type": "string" },
          "prefix": { "type": "string" },
          "model": { "enum": ["temperature", "pressure", "flow", ...] },
          "count": { "type": "integer", "minimum": 1 },
          "unit": { "type": "string" },
          "config": { "type": "object" }
        }
      }
    }
  }
}
```

## Verification

Tested with:
- ✅ factory.json (25 sensors)
- ✅ test.json (4 sensors)
- ✅ workshop.json (7 sensors - custom config)
- ✅ Container build and deployment
- ✅ Config merging with defaults
- ✅ Profile validation

## Conclusion

The OPC UA simulator now supports **config-driven profiles** via JSON files, matching the flexibility and maintainability of the Modbus simulator. This enables:
- Customer-specific factory simulations
- Version-controlled configurations
- Easy scenario testing
- Non-developer profile creation

All without touching a single line of Python code.
