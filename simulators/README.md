# Protocol Simulators

This directory contains Docker-based protocol simulators for testing the Iotistic agent's protocol adapters without physical hardware.

## Available Simulators

### 1. Modbus TCP Simulator (`modbus-simulator/`)
**Port**: 502  
**Container**: `iotistic-modbus-sim`

Simulates industrial Modbus TCP devices with realistic sensor data:
- **Holding Registers 0-9**: Temperature sensors (20-30°C, scaled by 10)
- **Holding Registers 10-19**: Pressure sensors (1000-1200 mbar)
- **Holding Registers 20-29**: Flow sensors (0-100 L/min)
- **Holding Registers 30-39**: Humidity sensors (0-100%)
- **Holding Registers 40-49**: Level sensors (0-1000 mm)
- **Holding Registers 50-59**: Power sensors (0-10000 W)
- **Holding Registers 60-69**: Vibration sensors (0-100 mm/s)
- **Holding Registers 70-79**: RPM sensors (1000-3000 RPM)
- **Coils 0-19**: Digital I/O

**Connection**: 
```
modbus://modbus-simulator:502
# Or from host: modbus://localhost:502
```

### 2. CAN Bus Simulator (`canbus-simulator/`)
**Port**: 11898 (CAN over TCP)  
**Container**: `iotistic-canbus-sim`

Simulates automotive/industrial CAN bus messages:
- **0x100**: Engine RPM (0-8000)
- **0x101**: Vehicle Speed (0-200 km/h)
- **0x102**: Engine Temperature (60-110°C)
- **0x103**: Throttle Position (0-100%)
- **0x104**: Fuel Level (0-100%)
- **0x105**: Battery Voltage (11.0-14.5V)
- **0x106**: Oil Pressure (200-600 kPa)
- **0x107**: Brake Pressure (0-1000 kPa)
- **0x108**: Coolant Temperature (60-105°C)
- **0x109**: Air Flow (0-500 kg/h)

**Connection**: 
```
tcp://canbus-simulator:11898
# Or from host: tcp://localhost:11898
```

### 3. OPC UA Simulator (`opcua-simulator/`)
**Port**: 4840  
**Container**: `iotistic-opcua-sim`

Simulates OPC UA server with hierarchical node structure:
- **Factory/Temperature/Sensor_1-5**: Temperature (°C)
- **Factory/Pressure/Sensor_1-5**: Pressure (mbar)
- **Factory/Flow/Sensor_1-5**: Flow (L/min)
- **Factory/Level/Tank_1-3**: Level (mm)
- **Factory/Vibration/Motor_1-4**: Vibration (mm/s)
- **Factory/Power/Line_1-3**: Power (W)

**Endpoint**: 
```
opc.tcp://opcua-simulator:4840/iotistic/simulator
# Or from host: opc.tcp://localhost:4840/iotistic/simulator
```

## Usage

### Start All Simulators
```bash
docker-compose up -d modbus-simulator canbus-simulator opcua-simulator
```

### Start Individual Simulator
```bash
# Modbus only
docker-compose up -d modbus-simulator

# CAN bus only
docker-compose up -d canbus-simulator

# OPC UA only
docker-compose up -d opcua-simulator
```

### View Logs
```bash
docker-compose logs -f modbus-simulator
docker-compose logs -f canbus-simulator
docker-compose logs -f opcua-simulator
```

### Stop Simulators
```bash
docker-compose down modbus-simulator canbus-simulator opcua-simulator
```

### Rebuild After Changes
```bash
docker-compose build modbus-simulator canbus-simulator opcua-simulator
docker-compose up -d modbus-simulator canbus-simulator opcua-simulator
```

## Testing with Agent

The agent's protocol adapters can connect to these simulators:

### 1. Configure Agent for Modbus
Edit agent config or target state:
```json
{
  "protocol": "modbus",
  "connection": {
    "host": "modbus-simulator",
    "port": 502,
    "type": "tcp"
  },
  "registers": [
    {"address": 0, "count": 10, "name": "temperature"},
    {"address": 10, "count": 10, "name": "pressure"}
  ]
}
```

### 2. Configure Agent for CAN Bus
```json
{
  "protocol": "can",
  "connection": {
    "interface": "tcp",
    "host": "canbus-simulator",
    "port": 11898
  },
  "filters": [
    {"can_id": "0x100", "name": "engine_rpm"},
    {"can_id": "0x101", "name": "vehicle_speed"}
  ]
}
```

### 3. Configure Agent for OPC UA
```json
{
  "protocol": "opcua",
  "connection": {
    "endpoint": "opc.tcp://opcua-simulator:4840/iotistic/simulator"
  },
  "nodes": [
    "Factory.Temperature.Sensor_1",
    "Factory.Pressure.Sensor_1"
  ]
}
```

## Data Patterns

All simulators generate **realistic dynamic data**:
- Sine wave variations with different periods
- Random noise for realistic fluctuations
- Value constraints (min/max limits)
- Occasional anomalies (vibration spikes)
- Time-based trends (fuel consumption)

## Architecture

```
┌─────────────────────────────────────────────┐
│         Docker Network (iotistic-net)       │
│                                             │
│  ┌──────────────┐      ┌──────────────┐   │
│  │   Modbus     │──502→│              │   │
│  │  Simulator   │      │              │   │
│  └──────────────┘      │              │   │
│                        │    Agent     │   │
│  ┌──────────────┐      │   Protocol   │   │
│  │   CAN Bus    │─11898→   Adapters   │   │
│  │  Simulator   │      │              │   │
│  └──────────────┘      │              │   │
│                        │              │   │
│  ┌──────────────┐      │              │   │
│  │   OPC UA     │─4840→│              │   │
│  │  Simulator   │      └──────────────┘   │
│  └──────────────┘                          │
│                                             │
└─────────────────────────────────────────────┘
```

## Development

### Modify Simulator Behavior

1. **Modbus**: Edit `modbus-simulator/modbus_simulator.py`
2. **CAN Bus**: Edit `canbus-simulator/canbus_simulator.py`
3. **OPC UA**: Edit `opcua-simulator/opcua_simulator.py`

### Add New Sensors

Each simulator is modular - add new sensor types by:
1. Adding data generation logic
2. Registering new addresses/IDs/nodes
3. Rebuilding the container

## Troubleshooting

### Connection Refused
```bash
# Check if simulator is running
docker ps | grep simulator

# Check logs for errors
docker-compose logs simulator-name

# Restart simulator
docker-compose restart simulator-name
```

### Wrong Data Format
- Verify agent protocol adapter configuration matches simulator output
- Check register addresses/CAN IDs/node paths
- Review simulator logs for data transmission

### Performance Issues
- Simulators update at ~1Hz (1 second intervals)
- CAN simulator sends 10 messages/second per CAN ID
- Reduce number of simultaneous connections if needed
