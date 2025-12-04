# COMAP Generator Controller Simulator - Design Document

## Executive Summary

This document outlines the design for a COMAP (ComAp) generator controller simulator that will be used for testing Modbus TCP discovery, data collection, and MQTT publishing in the Iotistic platform. The simulator will emulate a realistic generator controller with proper physics modeling, state transitions, and parameter correlations.

**Key Features:**
- Realistic generator physics simulation (RPM → frequency correlation, load-dependent power)
- State machine implementation (Off, Starting, Running, Cooling, Fault)
- 3-phase electrical parameter simulation with proper correlations
- Alarm/fault condition modeling
- Configurable via environment variables
- Docker-based deployment

## Background

### COMAP Controllers
COMAP controllers are advanced electronic control systems for diesel and gas generators, widely used in:
- Data centers
- Industrial facilities
- Marine applications
- Critical infrastructure

**Typical Features:**
- Engine protection and monitoring
- Load management and power distribution
- Remote monitoring and control
- Parallel operation support
- Modbus RTU/TCP communication

### Current State

**Existing Infrastructure:**
1. **Generic Modbus Simulator** (`sensors/modbus-simulator/`)
   - Python-based TCP server (pymodbus)
   - Vendor-agnostic JSON configuration
   - Simple linear noise simulation
   - Multi-slave ID support
   - No state machine or realistic behavior

2. **Existing COMAP Configuration** (`config/vendors/dataPoints.json`)
   - Basic 15 register definition
   - 11 holding registers (engine metrics)
   - 4 coil registers (alarms)
   - Missing: Realistic ranges, scaling, units, correlations

3. **Genmon Project Insights** (jgyates/genmon)
   - Custom controller framework with JSON-driven configs
   - Rich metadata: titles, units, display formatting, validation
   - Register types: holding, input, coil, file (0x14)
   - No COMAP-specific controller found in repository

## Architecture Decision: Standalone vs Extension

### Option 1: Extend Generic Modbus Simulator ❌
**Pros:**
- Reuse existing infrastructure
- Shared configuration format
- Single deployment pattern

**Cons:**
- Complicates generic simulator with generator-specific logic
- State machine doesn't fit generic model
- Physics simulation pollutes vendor-agnostic code
- Harder to maintain separate concerns

### Option 2: Dedicated COMAP Simulator ✅ **RECOMMENDED**
**Pros:**
- Clean separation of concerns
- Generator-specific state machine implementation
- Realistic physics modeling without compromising generic simulator
- Independent evolution and testing
- Follows existing pattern (sensors/opcua-simulator/, sensors/canbus-simulator/)

**Cons:**
- Code duplication (acceptable for specialized simulators)
- Separate deployment configuration

**Decision:** Create dedicated `sensors/comap-simulator/` with generator-specific implementation.

## Enhanced Register Definitions

### Holding Registers (Read-Only Telemetry)

| Address | Name | Type | Range | Unit | Description | Correlation |
|---------|------|------|-------|------|-------------|-------------|
| 0x0064 (100) | engine_rpm | uint16 | 0-3000 | RPM | Engine speed | RPM = Frequency × 120 (60Hz 2-pole) |
| 0x006E (110) | gen_voltage_a | uint16 | 0-300 | V | Phase A voltage | Nominal 240V ±10% under load |
| 0x006F (111) | gen_voltage_b | uint16 | 0-300 | V | Phase B voltage | Balanced within 3% of phase A |
| 0x0070 (112) | gen_voltage_c | uint16 | 0-300 | V | Phase C voltage | Balanced within 3% of phase A |
| 0x0078 (120) | gen_current_a | uint16 | 0-500 | A × 10 | Phase A current (0.1A resolution) | Current = Power / (Voltage × √3 × PF) |
| 0x0079 (121) | gen_current_b | uint16 | 0-500 | A × 10 | Phase B current | Balanced within 5% under load |
| 0x007A (122) | gen_current_c | uint16 | 0-500 | A × 10 | Phase C current | Balanced within 5% under load |
| 0x0082 (130) | frequency | uint16 | 5000-6200 | 0.01 Hz | Output frequency | 60.00 Hz = 6000, tolerance ±0.5% |
| 0x008C (140) | power_kw | uint16 | 0-1000 | kW | Active power output | Sum of 3-phase power |
| 0x0096 (150) | engine_temp | int16 | -40 to 150 | °C | Coolant temperature | Rises to 85-95°C at full load |
| 0x00A0 (160) | fuel_level | uint16 | 0-100 | % | Fuel tank level | Decreases ~2%/hr at full load |
| 0x00AA (170) | oil_pressure | uint16 | 0-100 | psi × 10 | Engine oil pressure | 40-70 psi when running |
| 0x00B4 (180) | battery_voltage | uint16 | 0-300 | V × 10 | Battery voltage | 24V system: 22-28V range |
| 0x00BE (190) | run_hours | uint32 | 0-99999 | hours | Total engine run time | Increments while running |
| 0x00C8 (200) | power_factor | uint16 | 0-1000 | 0.001 | Power factor | Typical 0.8-0.95 lagging |

### Coil Registers (Alarm States - Read-Only for Monitoring)

| Address | Name | Description | Trigger Condition |
|---------|------|-------------|-------------------|
| 0x0000 (0) | alarm_overspeed | Engine overspeed alarm | RPM > 2000 (>66 Hz) |
| 0x0001 (1) | alarm_low_oil | Low oil pressure alarm | Oil pressure < 20 psi |
| 0x0002 (2) | alarm_high_temp | High coolant temperature | Coolant temp > 105°C |
| 0x0003 (3) | alarm_overload | Generator overload | Power > 110% of rated capacity |

### Input Registers (Additional Read-Only Metrics)

| Address | Name | Type | Range | Unit | Description |
|---------|------|------|-------|------|-------------|
| 0x0000 (0) | exhaust_temp | int16 | 0-800 | °C | Exhaust gas temperature |
| 0x0001 (1) | intake_temp | int16 | -40 to 80 | °C | Intake air temperature |
| 0x0002 (2) | fuel_rate | uint16 | 0-500 | L/hr × 10 | Fuel consumption rate |

## Generator State Machine

### States

```
┌─────────────┐
│     OFF     │ ◄─────────────────────────┐
│  (Stopped)  │                           │
└──────┬──────┘                           │
       │ Start Command                    │
       │ Preheat: 5s                      │
       ▼                                  │
┌─────────────┐                           │
│  STARTING   │                           │
│ (Cranking)  │                           │
└──────┬──────┘                           │
       │ RPM > 800 & Voltage > 200V       │
       │ Ramp Time: 10-15s                │
       ▼                                  │
┌─────────────┐                           │
│   RUNNING   │                           │
│  (Loaded)   │                           │
└──────┬──────┘                           │
       │ Stop Command                     │
       │ Cooldown Required                │
       ▼                                  │
┌─────────────┐                           │
│  COOLING    │                           │
│ (Unloaded)  │                           │
└──────┬──────┘                           │
       │ Cooldown Complete (60s)          │
       │                                  │
       └──────────────────────────────────┘

       ┌─────────────┐
       │    FAULT    │ (Any state can transition to FAULT)
       │  (Alarmed)  │
       └─────────────┘
           ▲
           │ Overspeed, Low Oil, High Temp, Overload
```

### State Transitions

| From State | To State | Trigger | Duration | Actions |
|------------|----------|---------|----------|---------|
| OFF | STARTING | External start command (simulated) | 0s | Begin preheat, enable fuel solenoid |
| STARTING | RUNNING | RPM > 800 & Voltage > 200V | 10-15s | Ramp RPM 0→1800, Voltage 0→240V |
| RUNNING | COOLING | Stop command or fault clear | 0s | Reduce load to 0%, maintain RPM |
| COOLING | OFF | Elapsed time > 60s | 60s | Ramp down RPM, shutdown |
| Any | FAULT | Alarm condition | 0s | Set alarm coil, maintain state |
| FAULT | Previous | Alarm clear | 0s | Clear alarm coil, resume |

### State Behaviors

**OFF:**
- RPM: 0
- Voltage: 0V
- Current: 0A
- Frequency: 0Hz
- Temperature: Ambient (20-30°C)
- Oil Pressure: 0 psi
- Battery Voltage: 24V (±2V)

**STARTING (Cranking):**
- RPM: Ramp 0 → 800 → 1800 over 10-15 seconds
- Voltage: Ramp 0 → 200 → 240V following RPM curve
- Current: 0A (no load during startup)
- Frequency: Ramp 0 → 60Hz (tracks RPM)
- Temperature: Rising slowly (ambient → 50°C)
- Oil Pressure: Ramp 0 → 50 psi
- Battery Voltage: Drops to 22V during crank, recovers to 26V

**RUNNING (Loaded):**
- RPM: 1800 ±10 (steady-state with ±0.5% noise)
- Voltage: 240V ±5% per phase (balanced within 3%)
- Current: Load-dependent (0-416A per phase for 100kW @ 240V)
- Frequency: 60.00 Hz ±0.2%
- Temperature: 85-95°C (load-dependent)
- Oil Pressure: 50-70 psi
- Battery Voltage: 26-28V (charging)
- Power Factor: 0.85 lagging (typical)

**COOLING (Unloaded Idle):**
- RPM: 1200 (reduced idle speed)
- Voltage: 230V (slightly reduced)
- Current: 0A (no load)
- Frequency: 50 Hz
- Temperature: Declining 95°C → 60°C over 60 seconds
- Oil Pressure: 40 psi
- Battery Voltage: 27V

**FAULT (Alarmed):**
- Maintains last state values
- Sets appropriate alarm coil(s)
- RPM may drop to 0 for critical faults (oil pressure)
- Requires manual reset or auto-recovery after cooldown

## Parameter Correlation Model

### Physics Relationships

**1. RPM ↔ Frequency (Synchronous Generator)**
```python
frequency_hz = (engine_rpm * poles) / 120
# For 2-pole generator at 60Hz:
engine_rpm = 1800  # RPM
frequency_hz = (1800 * 2) / 120 = 60.0 Hz
```

**2. 3-Phase Power Calculation**
```python
# Per-phase current (A) = Power (W) / (Voltage (V) × √3 × Power Factor)
current_per_phase = power_kw * 1000 / (voltage_ll * sqrt(3) * pf)

# Example: 75kW load, 240V line-to-line, PF=0.85
current_per_phase = 75000 / (240 * 1.732 * 0.85) ≈ 212A
```

**3. Voltage Regulation (Under Load)**
```python
# Voltage drops 2-3% per 25% load increase
voltage_a = 240 * (1 - (load_percent * 0.0003))
# At 75% load: 240 * (1 - 0.0225) = 234.6V
```

**4. Engine Temperature (Thermal Model)**
```python
# Steady-state temp proportional to load
temp_ss = ambient_temp + (load_percent * 0.7)  # °C
# 75% load: 25°C + (75 * 0.7) = 77.5°C

# Thermal time constant: τ = 180 seconds (3 minutes)
temp_rise_rate = (temp_ss - current_temp) / τ
```

**5. Fuel Consumption**
```python
# Diesel: ~0.3 L/kWh at rated load
fuel_rate_lph = power_kw * 0.3  # Liters per hour
# 75kW: 75 * 0.3 = 22.5 L/hr

# Tank depletion (200L tank)
fuel_level_percent -= (fuel_rate_lph / tank_capacity_l) * (time_step_s / 3600)
```

**6. 3-Phase Balance**
```python
# Introduce realistic imbalance (±2-5% on current, ±1-3% on voltage)
current_b = current_a * random.uniform(0.97, 1.03)
current_c = current_a * random.uniform(0.97, 1.03)
voltage_b = voltage_a * random.uniform(0.98, 1.02)
voltage_c = voltage_a * random.uniform(0.98, 1.02)
```

## Fault Simulation

### Alarm Triggers

| Alarm | Condition | Action | Recovery |
|-------|-----------|--------|----------|
| **Overspeed** | RPM > 2000 (66+ Hz) | Set coil 0, emergency shutdown | Manual reset after 30s cooldown |
| **Low Oil Pressure** | Oil pressure < 20 psi | Set coil 1, immediate shutdown | Restore pressure, manual restart |
| **High Temp** | Coolant > 105°C | Set coil 2, reduce load or shutdown | Cool down below 95°C |
| **Overload** | Power > 110kW (110%) | Set coil 3, shed load or trip | Reduce load below 100kW |

### Fault Injection (Testing)

```python
# Environment variable triggers
INJECT_OVERSPEED=1    # Force RPM to 2200 after 60s
INJECT_LOW_OIL=1      # Drop oil pressure to 15 psi after 120s
INJECT_HIGH_TEMP=1    # Ramp temp to 110°C over 5 minutes
INJECT_OVERLOAD=1     # Simulate 120kW load spike
```

## Configuration Options

### Environment Variables

| Variable | Type | Default | Description | Example |
|----------|------|---------|-------------|---------|
| `MODBUS_PORT` | int | 502 | Modbus TCP port | `5502` |
| `MODBUS_SLAVES` | int | 3 | Number of slave IDs | `1` |
| `MODBUS_SLAVE_START` | int | 1 | Starting slave ID | `10` |
| `GENERATOR_RATED_KW` | int | 100 | Rated power output | `200` |
| `GENERATOR_RATED_VOLTAGE` | int | 240 | Line-to-line voltage | `480` |
| `GENERATOR_FUEL_TANK_L` | int | 200 | Fuel tank capacity | `500` |
| `AUTO_START` | bool | false | Auto-start on launch | `true` |
| `STATE_CHANGE_INTERVAL` | int | 300 | Seconds between state changes | `600` |
| `NOISE_PERCENT` | float | 1.0 | Random noise percentage | `0.5` |
| `INJECT_OVERSPEED` | bool | false | Inject overspeed fault | `true` |
| `INJECT_LOW_OIL` | bool | false | Inject low oil fault | `true` |
| `INJECT_HIGH_TEMP` | bool | false | Inject high temp fault | `true` |
| `INJECT_OVERLOAD` | bool | false | Inject overload fault | `true` |

## File Structure

```
sensors/comap-simulator/
├── comap_simulator.py          # Main simulator with state machine
├── generator_physics.py        # Physics calculations (RPM, power, temp)
├── modbus_data_block.py        # Modbus register handler
├── config.py                   # Configuration loader
├── requirements.txt            # pymodbus==3.5.2
├── Dockerfile                  # Container image
├── README.md                   # Usage documentation
├── DESIGN.md                   # This document
└── tests/
    ├── test_state_machine.py   # State transition tests
    ├── test_physics.py         # Correlation tests
    └── test_faults.py          # Alarm condition tests
```

## Implementation Plan

### Phase 1: Core Simulator (MVP)
**Deliverables:**
1. `comap_simulator.py` - Main server with state machine
2. `generator_physics.py` - Basic physics (RPM→frequency, load→current)
3. Enhanced register definitions (15 → 20+ registers)
4. Dockerfile and docker-compose integration

**Acceptance Criteria:**
- Modbus TCP server responds on port 502
- State machine transitions correctly (OFF → STARTING → RUNNING → COOLING → OFF)
- Basic correlations work (RPM/frequency, voltage/current)
- Agent discovers COMAP devices

**Estimated Time:** 6-8 hours

### Phase 2: Physics Refinement
**Deliverables:**
1. 3-phase balance simulation
2. Thermal model (heating/cooling curves)
3. Fuel consumption modeling
4. Voltage regulation under load

**Acceptance Criteria:**
- 3-phase currents balanced within ±5%
- Temperature follows thermal time constant (τ = 180s)
- Fuel level decreases realistically
- Voltage drops 2-3% at full load

**Estimated Time:** 4-6 hours

### Phase 3: Fault Simulation
**Deliverables:**
1. Alarm trigger logic
2. Fault injection via environment variables
3. Emergency shutdown procedures
4. Fault recovery mechanisms

**Acceptance Criteria:**
- Alarms trigger at correct thresholds
- Fault injection works via environment variables
- Recovery procedures restore normal operation
- MQTT alarms published correctly

**Estimated Time:** 3-4 hours

### Phase 4: Testing & Documentation
**Deliverables:**
1. Unit tests for state machine
2. Integration tests with agent
3. Physics validation tests
4. README with examples

**Acceptance Criteria:**
- 80% code coverage
- Agent discovery and data collection validated
- All physics correlations verified
- Documentation complete

**Estimated Time:** 4-5 hours

**Total Estimated Time:** 17-23 hours

## Testing Strategy

### Unit Tests (pytest)
```python
# test_state_machine.py
def test_off_to_starting_transition():
    sim = ComapSimulator(auto_start=True)
    assert sim.state == GeneratorState.STARTING
    assert 0 < sim.engine_rpm < 800  # Cranking

def test_rpm_frequency_correlation():
    sim = ComapSimulator()
    sim.engine_rpm = 1800
    assert sim.frequency == pytest.approx(60.0, rel=0.01)

def test_3phase_power_calculation():
    sim = ComapSimulator()
    sim.set_load(75)  # 75kW
    assert sim.current_a == pytest.approx(212, rel=0.05)
```

### Integration Tests (with Agent)
```bash
# Start simulator
docker-compose -f docker-compose.e2e.yml up -d comap-simulator

# Run agent discovery
docker exec iotistic-agent python -m agent.device-api.discovery

# Verify endpoints saved
docker exec iotistic-postgres psql -U postgres -d iotistic \
  -c "SELECT * FROM endpoints WHERE protocol='modbus' AND vendor='COMAP';"

# Verify data collection
docker exec iotistic-agent python -m agent.data-collection.collectors.modbus_collector
```

### Physics Validation
```python
# Verify generator equations
def test_synchronous_generator_equation():
    # 2-pole, 60Hz = 1800 RPM
    assert (1800 * 2) / 120 == 60.0
    # 4-pole, 60Hz = 900 RPM
    assert (900 * 4) / 120 == 60.0

def test_power_triangle():
    P = 75  # kW (active power)
    pf = 0.85  # power factor
    S = P / pf  # kVA (apparent power)
    Q = math.sqrt(S**2 - P**2)  # kVAR (reactive power)
    assert S == pytest.approx(88.24, rel=0.01)
    assert Q == pytest.approx(46.47, rel=0.01)
```

## Docker Integration

### Dockerfile
```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .

EXPOSE 502

CMD ["python", "-u", "comap_simulator.py"]
```

### docker-compose.e2e.yml Addition
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
      - MODBUS_SLAVE_START=1
      - GENERATOR_RATED_KW=100
      - GENERATOR_RATED_VOLTAGE=240
      - AUTO_START=true
      - STATE_CHANGE_INTERVAL=300
      - NOISE_PERCENT=1.0
    networks:
      - iotistic
    restart: unless-stopped
```

## Success Metrics

1. **Functional:**
   - ✅ Agent discovers 3 COMAP slaves
   - ✅ All 20+ registers readable via Modbus TCP
   - ✅ State machine cycles correctly (OFF → STARTING → RUNNING → COOLING → OFF)
   - ✅ Alarms trigger at correct thresholds

2. **Physics Accuracy:**
   - ✅ RPM/frequency correlation within ±0.1 Hz
   - ✅ 3-phase currents balanced within ±5%
   - ✅ Voltage drop under load matches real-world (2-3% per 25% load)
   - ✅ Temperature follows thermal time constant (τ = 180s ± 20s)

3. **Performance:**
   - ✅ Response time < 100ms for Modbus queries
   - ✅ State updates every 1 second
   - ✅ CPU usage < 5% (single core)
   - ✅ Memory usage < 100MB

4. **Operational:**
   - ✅ Runs continuously for 24+ hours without errors
   - ✅ Fault injection works via environment variables
   - ✅ Logs are clear and actionable
   - ✅ Documentation covers all use cases

## Future Enhancements

### Phase 5+ (Post-MVP)
1. **Advanced Features:**
   - Parallel operation simulation (2+ generators in sync)
   - Load sharing with droop control
   - Power factor correction simulation
   - Harmonic distortion modeling

2. **Communication:**
   - Modbus RTU support (serial)
   - CANopen J1939 support (common in generators)
   - SNMP MIB for monitoring
   - RESTful API for external control

3. **Cloud Integration:**
   - Publish telemetry to MQTT topics
   - WebSocket for real-time monitoring
   - Grafana dashboard support
   - Historical data logging

4. **Fault Scenarios:**
   - Battery failure simulation
   - Alternator field loss
   - Fuel starvation
   - Grid synchronization failures

## Appendix: References

### COMAP Controller Documentation
- **InteliGen NT Controller Manual** (ComAp) - Register mapping reference
- **Modbus Protocol Specification** (Modbus Organization) - Communication standard
- **IEEE 1547-2018** - Interconnection standard for distributed generation

### Generator Physics
- **"Electric Machinery Fundamentals"** by Stephen J. Chapman - Synchronous generator theory
- **"Power System Analysis"** by John J. Grainger - 3-phase power calculations
- **Diesel Engine Thermodynamics** - Fuel consumption and temperature modeling

### Genmon Project
- **Repository:** https://github.com/jgyates/genmon
- **Custom Controller Framework:** `genmonlib/custom_controller.py`
- **Modbus File Simulation:** `genmonlib/modbus_file.py`

---

**Document Version:** 1.0  
**Last Updated:** 2025-01-15  
**Author:** GitHub Copilot  
**Status:** Ready for Implementation
