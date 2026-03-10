# Modbus Simulator with Web GUI

Profile-aware Modbus TCP/RTU simulator with real-time control interface and slave failure simulation.

## Features

- **Dual Transport**: Supports both Modbus TCP and RTU (serial) via TRANSPORT environment variable
- **Profile-Agnostic**: Automatically adapts to any profile in `dataPoints.json`
- **Real-time Control**: Adjust register values via web interface
- **Slave Failure Simulation**: Enable/disable individual slaves to test fault tolerance
- **Response Delay Simulation**: Configurable latency and jitter per slave
- **Register Access Logging**: Track read/write patterns with detailed statistics
- **Scenario Presets**: Apply common scenarios (Normal, High Load, Fault, Unstable)
- **Dynamic Data Points**: GUI auto-generates controls based on profile config
- **Shared State**: Web GUI and Modbus server share register overrides and slave states
- **Export Capabilities**: Export access logs as CSV or JSON for analysis

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

## Slave Failure Simulation

### Industry Best Practices

This simulator follows common patterns from commercial Modbus simulation tools:

1. **Per-Slave Controls**: Individual start/stop buttons for each slave device
2. **Visual Status Indicators**: Online (green) / Offline (red) status badges
3. **Modbus Exception Handling**: Disabled slaves return proper Modbus exceptions (not just timeouts)
4. **Real-time State Management**: Changes take effect immediately without restart
5. **Response Delay Simulation**: Configurable latency and jitter per slave

### Response Delay Simulation

Test timeout handling and retry logic by adding realistic network delays:

**Features**:
- **Base Delay** (0-5000ms): Fixed delay added to every response
- **Random Jitter** (0-500ms): Random variance (±) to simulate network instability
- **Per-Slave Configuration**: Each slave can have different delay characteristics
- **Real-time Updates**: Delays apply immediately to all subsequent requests

**Use Cases**:
- **Timeout Testing**: Set delay > client timeout to verify timeout handling
- **Retry Logic**: Verify application retries after slow responses
- **Concurrent Requests**: Test if client handles multiple slow slaves correctly
- **Network Simulation**: Jitter simulates Wi-Fi, cellular, or satellite links
- **Performance Testing**: Measure how delays impact overall system performance

**Example Configurations**:
```
Local Network:     delay=10ms  jitter=5ms   (fast, stable)
WiFi/4G:          delay=50ms  jitter=20ms  (medium, some variance)
Satellite/WAN:    delay=500ms jitter=100ms (slow, unstable)
Timeout Test:     delay=3000ms jitter=0ms  (exceeds typical 2s timeout)
Unreliable Link:  delay=100ms jitter=200ms (highly variable)
```

### Usage

1. Open Web GUI at http://localhost:5001
2. Locate "Slave Devices" section in control panel
3. For each slave, adjust:
   - **Delay slider** (0-5000ms): Base response time
   - **Jitter slider** (0-500ms): Random variance range
   - Changes apply on slider release
4. Monitor "Response time" indicator showing configured delay ±jitter

**Slave Failure Simulation**:
1. Click Stop (⏹) button to simulate device failure - slave will:
   - Reject all Modbus requests with validation errors
   - Show "offline" status in red
   - Allow testing of fault tolerance and retry logic
2. Click Start (▶) button to restore slave operation

### API Endpoints

```bash
# Get slave states (includes delay configuration)
curl http://localhost:5001/api/status

# Response includes:
{
  "slave_states": [
    {
      "id": 1, 
      "enabled": true, 
      "status": "online",
      "delay_ms": 100,
      "jitter_ms": 20
    },
    {
      "id": 2, 
      "enabled": false, 
      "status": "offline",
      "delay_ms": 0,
      "jitter_ms": 0
    }
  ]
}

# Toggle specific slave (enable/disable)
curl -X POST http://localhost:5001/api/slave/2/toggle

# Set response delay for slave
curl -X POST http://localhost:5001/api/slave/1/delay \
  -H "Content-Type: application/json" \
  -d '{"delay_ms": 500, "jitter_ms": 100}'

# Clear delay (instant responses)
curl -X POST http://localhost:5001/api/slave/1/delay \
  -H "Content-Type: application/json" \
  -d '{"delay_ms": 0, "jitter_ms": 0}'
```

### Testing Scenarios

**Fault Tolerance Testing**:
```python
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient('localhost', port=502)

# Try disabled slave (will fail)
result = client.read_holding_registers(100, 5, slave=2)
# Returns error - slave offline

# Try enabled slave (succeeds)
result = client.read_holding_registers(100, 5, slave=1)
print(result.registers)  # [123, 456, ...]
```

**Failover Testing**:
- Disable primary slave (slave 1)
- Verify application switches to backup slave (slave 2)
- Re-enable primary and verify recovery

## Register Access Logging

Track register usage patterns to optimize polling, debug client code, and identify performance bottlenecks.

### Features

- **Per-Register Statistics**: Tracks reads, writes, and last access time for every register
- **Slave & Type Aware**: Distinguishes between slaves and register types (holding, input, coil, discrete)
- **Top N Analysis**: Identifies most frequently accessed registers
- **Export Capabilities**: Download logs as CSV or JSON for external analysis
- **Real-time Dashboard**: Live statistics with sortable tables

### Use Cases

1. **Optimize Polling Frequency**: Identify which registers are polled most often
2. **Detect Unused Registers**: Find registers that are never accessed
3. **Debug Client Issues**: Verify if client is reading/writing expected registers
4. **Performance Analysis**: Correlate register access with system performance
5. **Documentation**: Generate actual usage reports vs. configured data points

### Usage

1. Open Web GUI at http://localhost:5001
2. Click **"📊 View Statistics"** to see access log dashboard
3. Review:
   - **Summary stats**: Total registers accessed, total reads/writes
   - **Top 50 table**: Most accessed registers with read/write counts
   - **Last access times**: When each register was last read/written
4. Export data:
   - **📥 Export JSON**: Full log in JSON format
   - **📥 Export CSV**: Spreadsheet-compatible format
5. Clear log with **"Clear Log"** button to reset statistics

### API Endpoints

```bash
# Get full access log
curl http://localhost:5001/api/access-log

# Response:
{
  "total_registers": 42,
  "total_reads": 15234,
  "total_writes": 892,
  "log": [
    {
      "slave_id": 1,
      "register_type": "holding",
      "address": 100,
      "reads": 1523,
      "writes": 45,
      "last_read": 1734791234.567,
      "last_write": 1734791200.123,
      "last_read_ago": "5.2s",
      "last_write_ago": "39.4s"
    },
    ...
  ]
}

# Get top 10 most accessed registers
curl http://localhost:5001/api/access-log/top/10

# Export as CSV
curl http://localhost:5001/api/access-log/export/csv > access_log.csv

# Export as JSON
curl http://localhost:5001/api/access-log/export/json > access_log.json

# Clear all statistics
curl -X POST http://localhost:5001/api/access-log/clear
```

### Analysis Examples

**Find polling bottlenecks**:
```bash
# Get top 10 registers by total access
curl http://localhost:5001/api/access-log/top/10 | jq '.registers[] | {addr: .address, total: .total_access}'
```

**Identify write-heavy registers** (CSV analysis):
```bash
curl http://localhost:5001/api/access-log/export/csv | \
  awk -F',' 'NR>1 {print $3, $5}' | \
  sort -k2 -nr | \
  head -10
```

**Monitor live access rates**:
```bash
# Take snapshots 10 seconds apart
curl http://localhost:5001/api/access-log > snapshot1.json
sleep 10
curl http://localhost:5001/api/access-log > snapshot2.json
# Compare total_reads/total_writes to calculate ops/second
```

## Exception Code Injection

Test client error handling by simulating Modbus exception responses. This feature allows you to inject specific exception codes on a per-slave basis to verify that your client application properly handles error conditions.

### Available Exception Codes

- **Illegal Function (0x01)** - Function code not supported by slave
- **Illegal Address (0x02)** - Register address out of range or not available
- **Illegal Value (0x03)** - Written value is outside valid bounds
- **Slave Failure (0x04)** - Unrecoverable error occurred in slave device
- **Acknowledge (0x05)** - Long operation in progress, client should retry
- **Slave Busy (0x06)** - Slave is processing another request, retry later

### Usage

**Web Interface**:
1. Click "⚠️ Inject Exceptions" button
2. Select exception type from dropdown for each slave
3. Click "⚠️ Inject" button to activate
4. Select "No Exception" and click "⚠️ Inject" to clear

**API Endpoints**:
```bash
# Get current exception injections
curl http://localhost:5001/api/exceptions

# Inject slave_busy exception on Slave 1 (all operations fail)
curl -X POST http://localhost:5001/api/exception/slave/1 \
  -H "Content-Type: application/json" \
  -d '{"exception": "slave_busy"}'

# Clear exception for Slave 1
curl -X POST http://localhost:5001/api/exception/clear \
  -H "Content-Type: application/json" \
  -d '{"slave_id": 1}'

# Clear all exceptions
curl -X POST http://localhost:5001/api/exception/clear
```

### Testing Scenarios

**Timeout Handling**:
```bash
# Inject 'acknowledge' to test long-running operations
curl -X POST http://localhost:5001/api/exception/slave/1 \
  -d '{"exception": "acknowledge"}'
# Verify client implements exponential backoff
```

**Invalid Address Handling**:
```bash
# Test how client handles address errors
curl -X POST http://localhost:5001/api/exception/slave/2 \
  -d '{"exception": "illegal_address"}'
# Verify client logs error and doesn't retry indefinitely
```

**Failover Testing**:
```bash
# Inject slave_failure on primary slave
curl -X POST http://localhost:5001/api/exception/slave/1 \
  -d '{"exception": "slave_failure"}'
# Verify client switches to backup slave
```

**Retry Logic**:
```bash
# Test exponential backoff with slave_busy
curl -X POST http://localhost:5001/api/exception/slave/1 \
  -d '{"exception": "slave_busy"}'
# Verify client increases retry delay after each failure
```

### How It Works

When an exception is injected for a slave:
1. All read/write requests to that slave will fail with the specified exception code
2. The Modbus server returns the standard exception response format
3. Client libraries typically raise an exception or return an error
4. Exceptions persist until cleared via API or web interface
5. Can be combined with response delay simulation for realistic network conditions

### Industry Comparison

This feature is comparable to:
- **Diagslave**: Exception injection via command-line flags
- **ModRSsim2**: Error simulation dialog with exception code selection
- **pyModSlave**: Python-based exception configuration
- **Modbus Doctor**: Built-in error injection for protocol testing

## Environment Variables

**Transport Configuration**:
- `TRANSPORT`: Transport type - `tcp` or `rtu` (default: `tcp`)

**TCP Mode**:
- `MODBUS_PORT`: TCP port number (default: `502`)
- `MODBUS_HOST`: TCP bind address (default: `0.0.0.0`)

**RTU Mode**:
- `MODBUS_PORT`: Serial port device (default: `/dev/ttyUSB0`)
- `MODBUS_BAUDRATE`: Baudrate (default: `19200`)
- `MODBUS_BYTESIZE`: Data bits (default: `8`)
- `MODBUS_PARITY`: Parity - `N` (none), `E` (even), `O` (odd) (default: `N`)
- `MODBUS_STOPBITS`: Stop bits (default: `1`)

**General**:
- `MODBUS_PROFILE`: Profile to simulate (default: `Generic`)
- `MODBUS_SLAVES`: Number of slave IDs (default: `3`)
- `MODBUS_API_URL`: API URL to fetch profile data (default: `http://api:3002`)
- `MODBUS_PROFILE_JSON`: Fallback JSON file path (default: `./profiles/dataPoints.json`)
- `GUI_PORT`: Web GUI port (default: `5000`)
- `GUI_HOST`: Web GUI host (default: `0.0.0.0`)

**Examples**:

```bash
# Modbus TCP (default)
docker run -e TRANSPORT=tcp -e MODBUS_PORT=502 iotistic/modbus-simulator

# Modbus RTU over serial
docker run --device=/dev/ttyUSB0 \
  -e TRANSPORT=rtu \
  -e MODBUS_PORT=/dev/ttyUSB0 \
  -e MODBUS_BAUDRATE=9600 \
  -e MODBUS_PARITY=E \
  iotistic/modbus-simulator
```

## Adding New Profiles

Just add to `dataPoints.json` - GUI adapts automatically:

```json
{
  "MyProfile": {
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
