# Modbus Simulator with Web GUI

Vendor-aware Modbus TCP simulator with real-time control interface.

## Features

- **Vendor-Agnostic**: Automatically adapts to any vendor in `dataPoints.json`
- **Real-time Control**: Adjust register values via web interface
- **Scenario Presets**: Apply common scenarios (Normal, High Load, Fault, Unstable)
- **Dynamic Data Points**: GUI auto-generates controls based on vendor config
- **Shared State**: Web GUI and Modbus server share register overrides

## Quick Start

```bash
# Build and run
docker-compose up modbus-simulator

# Access Web GUI
http://localhost:5001

# Test Modbus connection
docker exec -it iotistic-modbus-sim python -c "
from pymodbus.client import ModbusTcpClient
client = ModbusTcpClient('localhost', port=502)
result = client.read_holding_registers(100, 5, slave=1)
print(result.registers)
"
```

## Environment Variables

- `MODBUS_VENDOR`: Vendor to simulate (default: `Generic`)
- `MODBUS_SLAVES`: Number of slave IDs (default: `3`)
- `MODBUS_PORT`: Modbus TCP port (default: `502`)
- `MODBUS_API_URL`: API URL to fetch vendor data (default: `http://api:3002`)
- `MODBUS_VENDOR_JSON`: Fallback JSON file path (default: `./vendors/dataPoints.json`)
- `GUI_PORT`: Web GUI port (default: `5000`)
- `GUI_HOST`: Web GUI host (default: `0.0.0.0`)

## Adding New Vendors

Just add to `dataPoints.json` - GUI adapts automatically:

```json
{
  "MyVendor": {
    "dataPoints": [
      {
        "name": "temperature",
        "address": 200,
        "type": "holding",
        "dataType": "uint16",
        "base": 25,
        "noise_pct": 0.10
      }
    ]
  }
}
```

## Web GUI Usage

1. **Select Vendor**: Choose from dropdown (COMAP, Generic, etc.)
2. **Adjust Values**: Use sliders to set base value and noise percentage
3. **Apply Scenarios**: Quick presets for testing
4. **Monitor Status**: Real-time display of active overrides

## Architecture

```
┌─────────────────────┐
│   Web GUI (Flask)   │  Port 5000
│   - Control Panel   │
│   - REST API        │
└──────────┬──────────┘
           │
           │ Shared State
           │ (REGISTER_OVERRIDES)
           │
┌──────────┴──────────┐
│  Modbus Server      │  Port 502
│  (pymodbus)         │
│  - Reads overrides  │
│  - Generates data   │
└─────────────────────┘
```

## API Endpoints

- `GET /` - Web GUI
- `GET /api/vendors` - List available vendors
- `GET /api/datapoints/<vendor>` - Get vendor data points
- `GET /api/status` - Simulator status
- `GET /api/overrides` - Current register overrides
- `PUT /api/overrides/<address>` - Set override
- `DELETE /api/overrides/<address>` - Remove override
- `DELETE /api/overrides` - Clear all overrides
- `POST /api/scenario/<name>` - Apply scenario (normal, high_load, fault, unstable)
