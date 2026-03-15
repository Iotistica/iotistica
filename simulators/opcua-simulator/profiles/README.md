# OPC UA Simulator Profiles

## Overview

Profiles define device configurations for the OPC UA simulator. Each profile is a JSON file that specifies which devices to simulate, their behavior, and their tree organization.

## Profile Structure

```json
{
  "name": "Profile Name",
  "description": "Description of this profile",
  "devices": [
    {
      "folder": "Folder name in OPC UA tree",
      "prefix": "Node name prefix",
      "model": "Device model type",
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

## Available Device Models

- `temperature`
- `pressure`
- `flow`
- `level`
- `vibration`
- `power`
- `oscillating`

Each model accepts a `config` override object. If omitted, model defaults are used.

## Validation Rules

Profiles are validated on load:

- Required fields: `name`, `devices`
- Each device group requires: `folder`, `prefix`, `model`, `count`
- `model` must exist in `MODEL_REGISTRY`

## Built-in Profiles

- `factory.json`: standard industrial profile
- `test.json`: minimal testing profile
- `workshop.json`: small workshop profile
- `smart-building.json`: multi-zone building profile

## Usage

```bash
python opcua_simulator.py factory
python opcua_simulator.py test
python opcua_simulator.py workshop
```
