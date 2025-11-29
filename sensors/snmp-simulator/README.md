# SNMP Simulator

A lightweight SNMP agent simulator for testing the Iotistic SNMP protocol adapter.

## Features

- **SNMPv2c** support with community string authentication
- **MIB-II** standard OIDs (System, Interface, IP, TCP, UDP groups)
- **Host Resources MIB** (Memory, CPU, Storage)
- **Custom Enterprise OIDs** for industrial sensors
- **Dynamic data generation** with realistic patterns (sine waves, random noise)
- Runs in Docker container for easy deployment

## Quick Start

### Docker Compose

```bash
# Start simulator
docker-compose up -d snmp-simulator

# View logs
docker logs -f iotistic-snmp-sim

# Test with snmpwalk
snmpwalk -v2c -c public localhost:161

# Test specific OID
snmpget -v2c -c public localhost:161 1.3.6.1.2.1.1.5.0
```

### Standalone Docker

```bash
# Build image
cd sensors/snmp-simulator
docker build -t iotistic-snmp-sim .

# Run container
docker run -d -p 161:161/udp --name snmp-sim iotistic-snmp-sim

# Test
snmpwalk -v2c -c public localhost
```

## Available OIDs

### System Group (1.3.6.1.2.1.1)
- `.1.0` - sysDescr (System description)
- `.2.0` - sysObjectID
- `.3.0` - sysUpTime (Uptime in timeticks)
- `.4.0` - sysContact
- `.5.0` - sysName (Device hostname)
- `.6.0` - sysLocation
- `.7.0` - sysServices

### Interface Group (1.3.6.1.2.1.2)
- `.1.0` - ifNumber (Number of interfaces)
- `.2.2.1.2.1` - ifDescr (Interface description - eth0)
- `.2.2.1.5.1` - ifSpeed (Interface speed - 1 Gbps)
- `.2.2.1.8.1` - ifOperStatus (Operational status - up/down)
- `.2.2.1.10.1` - ifInOctets (Incoming bytes with dynamic variation)
- `.2.2.1.11.1` - ifInUcastPkts (Incoming unicast packets)
- `.2.2.1.13.1` - ifInDiscards
- `.2.2.1.14.1` - ifInErrors
- `.2.2.1.16.1` - ifOutOctets (Outgoing bytes with dynamic variation)
- `.2.2.1.17.1` - ifOutUcastPkts

### IP Group (1.3.6.1.2.1.4)
- `.3.0` - ipInReceives
- `.9.0` - ipInDelivers
- `.10.0` - ipOutRequests

### ICMP Group (1.3.6.1.2.1.5)
- `.1.0` - icmpInMsgs
- `.14.0` - icmpOutMsgs

### TCP Group (1.3.6.1.2.1.6)
- `.5.0` - tcpActiveOpens
- `.9.0` - tcpCurrEstab (Current established connections)

### UDP Group (1.3.6.1.2.1.7)
- `.1.0` - udpInDatagrams
- `.4.0` - udpOutDatagrams

### Host Resources MIB (1.3.6.1.2.1.25)
- `.2.2.0` - hrMemorySize (Total RAM in KB)
- `.2.3.1.5.1` - hrStorageSize (Disk size)
- `.2.3.1.6.1` - hrStorageUsed (Disk usage with variation)
- `.3.3.1.2.1` - hrProcessorLoad (CPU load percentage)

### Custom Enterprise OIDs (1.3.6.1.4.1.99999)
Industrial sensor data with dynamic values:

- `.1.1.0` - Temperature sensor 1 (°C × 10, range: 200-300)
- `.1.1.1` - Temperature sensor 2
- `.1.2.0` - Humidity sensor 1 (%, range: 40-70)
- `.1.2.1` - Humidity sensor 2
- `.1.3.0` - Pressure sensor 1 (mbar, range: 993-1033)
- `.1.3.1` - Pressure sensor 2
- `.1.4.0` - Power consumption sensor 1 (W, range: 3000-7000)
- `.1.4.1` - Power consumption sensor 2

## Data Patterns

All simulated data uses realistic patterns:

1. **Sine Wave Variations** - Smooth periodic changes
2. **Random Noise** - Small random fluctuations
3. **Bounded Values** - Realistic min/max limits
4. **Time-based** - Values evolve over time
5. **Counter Increments** - Network counters increase monotonically

## Testing Examples

```bash
# Get system information
snmpget -v2c -c public localhost 1.3.6.1.2.1.1.5.0  # sysName
snmpget -v2c -c public localhost 1.3.6.1.2.1.1.3.0  # sysUpTime

# Get interface statistics
snmpget -v2c -c public localhost 1.3.6.1.2.1.2.2.1.10.1  # ifInOctets
snmpget -v2c -c public localhost 1.3.6.1.2.1.2.2.1.16.1  # ifOutOctets

# Get custom sensor data
snmpget -v2c -c public localhost 1.3.6.1.4.1.99999.1.1.0  # Temperature
snmpget -v2c -c public localhost 1.3.6.1.4.1.99999.1.2.0  # Humidity
snmpget -v2c -c public localhost 1.3.6.1.4.1.99999.1.3.0  # Pressure

# Walk entire MIB tree
snmpwalk -v2c -c public localhost

# Walk only custom sensors
snmpwalk -v2c -c public localhost 1.3.6.1.4.1.99999
```

## Configuration

Default settings:
- **Port**: 161/udp
- **Community**: public
- **Version**: SNMPv2c

To customize, modify `snmp_simulator.py`:

```python
simulator = SNMPSimulator(
    host='0.0.0.0',
    port=161,
    community='my-secret-community'
)
```

## Integration with Iotistic Agent

The SNMP adapter can connect to this simulator for testing:

```json
{
  "name": "snmp-simulator",
  "protocol": "snmp",
  "enabled": true,
  "poll_interval": 10000,
  "connection": {
    "host": "localhost",
    "port": 161,
    "version": "v2c",
    "community": "public",
    "timeout": 5000,
    "retries": 3
  },
  "data_points": [
    {
      "name": "sysName",
      "oid": "1.3.6.1.2.1.1.5.0",
      "dataType": "string"
    },
    {
      "name": "ifInOctets",
      "oid": "1.3.6.1.2.1.2.2.1.10.1",
      "dataType": "counter32",
      "unit": "bytes"
    },
    {
      "name": "temperature",
      "oid": "1.3.6.1.4.1.99999.1.1.0",
      "dataType": "integer",
      "unit": "°C",
      "scale": 0.1
    }
  ]
}
```

## Troubleshooting

### Permission Denied (Port 161)

Port 161 requires root privileges. Solutions:

1. **Use Docker** (recommended) - Container runs as root
2. **Use high port** - Change to port > 1024
3. **Grant capabilities**: `sudo setcap cap_net_bind_service=+ep $(which python3)`

### No Response

Check firewall:
```bash
# Linux
sudo ufw allow 161/udp

# Check if listening
sudo netstat -ulnp | grep 161
```

## Architecture

```
┌─────────────────────────────────────────┐
│  SNMP Simulator                         │
├─────────────────────────────────────────┤
│  • PySNMP Engine                        │
│  • Dynamic OID Value Generation         │
│  • MIB-II Standard Objects              │
│  • Custom Enterprise OIDs               │
│  • Realistic Data Patterns              │
└─────────────────────────────────────────┘
              ↓ UDP Port 161
┌─────────────────────────────────────────┐
│  SNMP Clients (snmpget/snmpwalk)        │
│  or Iotistic SNMP Adapter               │
└─────────────────────────────────────────┘
```

## License

MIT License - Part of the Iotistic IoT Platform
