# COMAP Generator Controller Simulator

A realistic COMAP (ComAp) generator controller simulator for testing Modbus TCP discovery, data collection, and MQTT publishing in the Iotistic platform.

## Features

- **Realistic Generator Physics**
  - RPM ↔ Frequency correlation (synchronous generator)
  - 3-phase power calculations with load-dependent behavior
  - Voltage regulation under load
  - Thermal model with time constant
  - Fuel consumption based on load

- **State Machine**
  - OFF → STARTING → RUNNING → COOLING → OFF cycle
  - FAULT state for alarm conditions
  - Configurable state transition timing

- **Modbus TCP Interface**
  - 16 holding registers (telemetry)
  - 4 coil registers (alarms)
  - 3 input registers (additional metrics)
  - Multi-slave support (1-10 devices)

- **Fault Simulation**
  - Overspeed alarm (RPM > 2000)
  - Low oil pressure alarm (< 20 psi)
  - High temperature alarm (> 105°C)
  - Overload alarm (> 110% rated power)

## Quick Start

### Docker (Recommended)

```bash
# Build the image
docker build -t comap-simulator:latest sensors/comap-simulator/

# Run with default settings (3 slaves on port 502)
docker run -p 502:502 comap-simulator:latest

# Run with custom configuration
docker run -p 5502:502 \
  -e MODBUS_PORT=502 \
  -e MODBUS_SLAVES=1 \
  -e GENERATOR_RATED_KW=200 \
  -e AUTO_START=true \
  comap-simulator:latest
```

### Docker Compose

Add to `docker-compose.e2e.yml`:

```yaml
services:
  comap-simulator:
    build: ./sensors/comap-simulator
    container_name: iotistic-comap-simulator
    hostname: comap-simulator
    ports:
      - "5502:502"
    environment:
      - MODBUS_PORT=502
      - MODBUS_SLAVES=3
      - AUTO_START=true
      - STATE_CHANGE_INTERVAL=300
    networks:
      - iotistic
    restart: unless-stopped
```

```bash
docker-compose -f docker-compose.e2e.yml up -d comap-simulator
```

### Local Development

```bash
cd sensors/comap-simulator

# Install dependencies
pip install -r requirements.txt

# Run simulator
python comap_simulator.py
```

## Configuration

Configure via environment variables:

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MODBUS_PORT` | int | 502 | Modbus TCP port |
| `MODBUS_SLAVES` | int | 3 | Number of slave IDs |
| `MODBUS_SLAVE_START` | int | 1 | Starting slave ID |
| `GENERATOR_RATED_KW` | int | 100 | Rated power output (kW) |
| `GENERATOR_RATED_VOLTAGE` | int | 240 | Line-to-line voltage (V) |
| `GENERATOR_FUEL_TANK_L` | int | 200 | Fuel tank capacity (liters) |
| `AUTO_START` | bool | false | Auto-start on launch |
| `STATE_CHANGE_INTERVAL` | int | 300 | Seconds between state changes |
| `NOISE_PERCENT` | float | 1.0 | Random noise percentage |
| `INJECT_OVERSPEED` | bool | false | Inject overspeed fault |
| `INJECT_LOW_OIL` | bool | false | Inject low oil fault |
| `INJECT_HIGH_TEMP` | bool | false | Inject high temp fault |
| `INJECT_OVERLOAD` | bool | false | Inject overload fault |

## Register Map

### Holding Registers (Read-Only Telemetry)

| Address | Name | Type | Unit | Description |
|---------|------|------|------|-------------|
| 100 | engine_rpm | uint16 | RPM | Engine speed |
| 110 | gen_voltage_a | uint16 | V | Phase A voltage |
| 111 | gen_voltage_b | uint16 | V | Phase B voltage |
| 112 | gen_voltage_c | uint16 | V | Phase C voltage |
| 120 | gen_current_a | uint16 | A × 10 | Phase A current |
| 121 | gen_current_b | uint16 | A × 10 | Phase B current |
| 122 | gen_current_c | uint16 | A × 10 | Phase C current |
| 130 | frequency | uint16 | 0.01 Hz | Output frequency |
| 140 | power_kw | uint16 | kW | Active power |
| 150 | engine_temp | int16 | °C | Coolant temperature |
| 160 | fuel_level | uint16 | % | Fuel tank level |
| 170 | oil_pressure | uint16 | psi × 10 | Oil pressure |
| 180 | battery_voltage | uint16 | V × 10 | Battery voltage |
| 190-191 | run_hours | uint32 | hours | Total run hours |
| 200 | power_factor | uint16 | 0.001 | Power factor |

### Coil Registers (Alarm States)

| Address | Name | Description |
|---------|------|-------------|
| 0 | alarm_overspeed | Overspeed alarm (RPM > 2000) |
| 1 | alarm_low_oil | Low oil pressure (< 20 psi) |
| 2 | alarm_high_temp | High temperature (> 105°C) |
| 3 | alarm_overload | Overload (> 110% rated) |

### Input Registers (Additional Metrics)

| Address | Name | Type | Unit | Description |
|---------|------|------|------|-------------|
| 0 | exhaust_temp | int16 | °C | Exhaust gas temperature |
| 1 | intake_temp | int16 | °C | Intake air temperature |
| 2 | fuel_rate | uint16 | L/hr × 10 | Fuel consumption rate |

## Testing with Modbus Client

```bash
# Read engine RPM (register 100, slave 1)
mbpoll -a 1 -r 100 -c 1 -t 4 localhost

# Read all voltages (registers 110-112, slave 1)
mbpoll -a 1 -r 110 -c 3 -t 4 localhost

# Read alarms (coils 0-3, slave 1)
mbpoll -a 1 -r 0 -c 4 -t 0 localhost

# Monitor frequency in real-time
watch -n 1 'mbpoll -a 1 -r 130 -c 1 -t 4 localhost'
```

## State Machine

```
OFF → STARTING → RUNNING → COOLING → OFF
        ↓            ↓
      FAULT ←───────┘
```

**State Durations:**
- STARTING: 15 seconds (RPM ramp 0→1800)
- RUNNING: Configurable (default: 300 seconds)
- COOLING: 60 seconds (temperature decay)
- FAULT: Manual recovery required

## Generator Physics

### RPM to Frequency Conversion
```python
frequency_hz = (engine_rpm * poles) / 120
# For 2-pole generator: 1800 RPM = 60 Hz
```

### 3-Phase Power Calculation
```python
current_per_phase = power_kw * 1000 / (voltage_ll * √3 * pf)
# Example: 75kW @ 240V, PF=0.85 → 212A per phase
```

### Thermal Model
```python
temp_ss = ambient + (load_percent * 0.7)
dT/dt = (temp_ss - temp_current) / τ  # τ = 180 seconds
```

## Integration with Agent

The agent will discover COMAP devices via Modbus scanning:

```bash
# Agent discovers devices
docker exec iotistic-agent python -m agent.device-api.discovery

# Verify endpoints
docker exec iotistic-postgres psql -U postgres -d iotistic \
  -c "SELECT * FROM endpoints WHERE protocol='modbus' AND vendor='COMAP';"

# Start data collection
docker exec iotistic-agent python -m agent.data-collection.collectors.modbus_collector
```

## Architecture

```
┌─────────────────────────────────────┐
│   ComapGeneratorSimulator           │
│  ┌──────────────────────────────┐   │
│  │   State Machine              │   │
│  │  OFF → STARTING → RUNNING    │   │
│  │         ↓                     │   │
│  │       FAULT                   │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │   GeneratorPhysics           │   │
│  │  - RPM ↔ Frequency           │   │
│  │  - 3-phase power             │   │
│  │  - Thermal model             │   │
│  │  - Fuel consumption          │   │
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │   Modbus TCP Server          │   │
│  │  - Holding registers         │   │
│  │  - Coils (alarms)            │   │
│  │  - Input registers           │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Troubleshooting

### Port 502 Permission Denied

On Linux, ports < 1024 require root privileges:

```bash
# Option 1: Use high port (>1024)
docker run -p 5502:502 -e MODBUS_PORT=502 comap-simulator:latest

# Option 2: Run as root (not recommended)
docker run --user root -p 502:502 comap-simulator:latest
```

### No Response from Modbus Queries

Check firewall and verify container is running:

```bash
# Check container logs
docker logs iotistic-comap-simulator

# Test TCP connection
telnet localhost 502

# Verify Modbus response
mbpoll -a 1 -r 100 -c 1 -t 4 localhost
```

### Values Not Changing

Ensure simulator is updating (check logs for state transitions):

```bash
docker logs -f iotistic-comap-simulator
```

## Development

See [DESIGN.md](DESIGN.md) for complete architecture and implementation details.

### Running Tests

```bash
# Unit tests
pytest tests/test_physics.py
pytest tests/test_state_machine.py

# Integration tests
pytest tests/test_modbus_interface.py
```

## License

Part of the Iotistic IoT Platform - see main repository LICENSE.

## References

- [COMAP InteliGen NT Controller](https://www.comap-control.com)
- [Modbus Protocol Specification](https://modbus.org/specs.php)
- [Pymodbus Documentation](https://pymodbus.readthedocs.io/)
