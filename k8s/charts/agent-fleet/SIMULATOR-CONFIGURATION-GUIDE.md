# Agent Fleet Simulator Configuration Guide

## Overview

The agent fleet Helm chart now supports **flexible simulator configurations** for testing different IoT scenarios. You can deploy 0-3 Modbus simulators, toggle OPC-UA simulator, and enable/disable sensor simulator independently.

## Architecture

Each agent pod can run multiple protocol simulators as sidecars:

```
┌─────────────────────────────────────────────────┐
│ Agent Pod (StatefulSet replica)                │
│                                                 │
│  ┌────────────┐  ┌──────────────────────────┐  │
│  │   Agent    │  │  Modbus Simulator 0      │  │
│  │ Container  │◄─┤  Port: 502               │  │
│  │            │  └──────────────────────────┘  │
│  │ Localhost  │  ┌──────────────────────────┐  │
│  │ comms only │◄─┤  Modbus Simulator 1      │  │
│  │            │  │  Port: 503               │  │
│  └────────────┘  └──────────────────────────┘  │
│                  ┌──────────────────────────┐  │
│                  │  Modbus Simulator 2      │  │
│                  │  Port: 504               │  │
│                  └──────────────────────────┘  │
│                  ┌──────────────────────────┐  │
│                  │  OPC-UA Simulator        │  │
│                  │  Port: 4840              │  │
│                  └──────────────────────────┘  │
│                  ┌──────────────────────────┐  │
│                  │  Sensor Simulator        │  │
│                  │  (BME688 emulation)      │  │
│                  └──────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

**Key Design Principles:**
- All simulators communicate via **localhost only** (no network exposure)
- Each Modbus simulator runs on unique port: 502, 503, 504
- Sidecars are conditionally deployed based on Helm values
- Agent receives env vars with simulator discovery info

## Configuration Options

### values.yaml

```yaml
simulator:
  modbusCount: 1  # Number of Modbus simulators (0-3)
  image:
    repository: iotistic/modbus-simulator
    tag: latest
  resources:
    requests:
      memory: "64Mi"
      cpu: "50m"
    limits:
      memory: "128Mi"
      cpu: "100m"

opcuaSimulator:
  count: 1       # Number of OPC-UA simulators (0-3)
  image:
    repository: iotistic/opcua-simulator
    tag: latest
  resources:
    requests:
      memory: "128Mi"
      cpu: "100m"
    limits:
      memory: "256Mi"
      cpu: "200m"

sensorSimulator:
  enabled: false  # Toggle sensor simulator (BME688)
  image:
    repository: iotistic/sensor-simulator
    tag: latest
  resources:
    requests:
      memory: "32Mi"
      cpu: "25m"
    limits:
      memory: "64Mi"
      cpu: "50m"
```

### GitHub Actions Workflow Inputs

The workflow `release-agent-fleet.yml` supports two configuration modes:

#### 1. Preset Mode (Recommended)

```yaml
simulator_preset: full-stack  # Options: custom, modbus-only, opcua-only, full-stack, minimal, heavy-load
```

**Preset Definitions:**
- `custom` - Use slider values (below)
- `modbus-only` - 2 Modbus simulators, no OPC-UA, no sensors
- `opcua-only` - 0 Modbus, 1 OPC-UA, no sensors
- `full-stack` - 2 Modbus + OPC-UA + sensors (heavy load testing)
- `minimal` - 0 simulators (production-like)
- `heavy-load` - 3 Modbus + OPC-UA + sensors (stress testing)

#### 2. Custom Mode (Fine-Grained Control)

Set `simulator_preset: custom`, then use:

```yaml
modbus_simulator_count: 1       # 0-3
opcua_simulator_enabled: true   # true/false
sensor_simulator_enabled: false # true/false
```

## Agent Environment Variables

The agent container automatically receives these environment variables based on enabled simulators:

### MODBUS_SIMULATOR_PORTS
**Set when:** `simulator.modbusCount > 0`

Comma-separated list of Modbus TCP ports to scan:
```bash
# 1 simulator
MODBUS_SIMULATOR_PORTS=502

# 2 simulators
MODBUS_SIMULATOR_PORTS=502,503

# 3 simulators
MODBUS_SIMULATOR_PORTS=502,503,504
```

**Agent Usage:**
```typescript
const modbusP = process.env.MODBUS_SIMULATOR_PORTS?.split(',').map(Number) || [];
modbusP.forEach(port => {
  initModbusConnection({ host: 'localhost', port });
});
```

### OPCUA_DISCOVERY_URLS
**Set when:** `opcuaSimulator.count > 0`

Comma-separated list of OPC-UA discovery endpoints:
```bash
# 1 simulator
OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840

# 2 simulators
OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840,opc.tcp://localhost:4841

# 3 simulators
OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840,opc.tcp://localhost:4841,opc.tcp://localhost:4842
```

**Agent Usage:**
```typescript
const opcuaUrls = process.env.OPCUA_DISCOVERY_URLS?.split(',') || [];
opcuaUrls.forEach(url => {
  discoverOpcuaServer(url);
});
```

### SENSOR_SIMULATOR_ENABLED
**Set when:** `sensorSimulator.enabled: true`

Flag to enable sensor data collection:
```bash
SENSOR_SIMULATOR_ENABLED=true
```

**Agent Usage:**
```typescript
if (process.env.SENSOR_SIMULATOR_ENABLED === 'true') {
  startSensorPolling();
}
```

## Deployment Examples

### Example 1: Development (1 Modbus + OPC-UA)

**Helm:**
```bash
helm install agent-fleet ./charts/agent-fleet \
  --set simulator.modbusCount=1 \
  --set opcuaSimulator.enabled=true \
  --set sensorSimulator.enabled=false
```

**GitHub Actions:**
```yaml
simulator_preset: custom
modbus_simulator_count: 1
opcua_simulator_enabled: true
sensor_simulator_enabled: false
```

**Result:**
- 1 Modbus simulator (port 502)
- 1 OPC-UA simulator (port 4840)
- Agent env: `MODBUS_SIMULATOR_PORTS=502`, `OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840`

### Example 2: Heavy Load Testing (3 Modbus + OPC-UA + Sensors)

**Helm:**
```bash
helm install agent-fleet ./charts/agent-fleet \
  --set simulator.modbusCount=3 \
  --set opcuaSimulator.enabled=true \
  --set sensorSimulator.enabled=true
```

**GitHub Actions:**
```yaml
simulator_preset: heavy-load
```

**Result:**
- 3 Modbus simulators (ports 502, 503, 504)
- 1 OPC-UA simulator (port 4840)
- 1 Sensor simulator (BME688 emulation)
- Agent env: `MODBUS_SIMULATOR_PORTS=502,503,504`, `OPCUA_DISCOVERY_URLS=...`, `SENSOR_SIMULATOR_ENABLED=true`

### Example 3: Modbus-Only Testing (2 instances)

**Helm:**
```bash
helm install agent-fleet ./charts/agent-fleet \
  --set simulator.modbusCount=2 \
  --set opcuaSimulator.enabled=false \
  --set sensorSimulator.enabled=false
```

**GitHub Actions:**
```yaml
simulator_preset: modbus-only
```

**Result:**
- 2 Modbus simulators (ports 502, 503)
- Agent env: `MODBUS_SIMULATOR_PORTS=502,503`

### Example 4: Production (No Simulators)

**Helm:**
```bash
helm install agent-fleet ./charts/agent-fleet \
  --set simulator.modbusCount=0 \
  --set opcuaSimulator.enabled=false \
  --set sensorSimulator.enabled=false
```

**GitHub Actions:**
```yaml
simulator_preset: minimal
```

**Result:**
- No sidecar containers
- Agent runs standalone (ready for real device connections)

## Testing Simulator Configurations

Use the provided test script to verify Helm template rendering:

```powershell
cd k8s/charts/agent-fleet
./test-simulator-configs.ps1
```

This will test all preset configurations and show the rendered sidecar containers.

**Manual Helm Template Inspection:**
```bash
# Render full template with full-stack preset
helm template agent-fleet . \
  --set simulator.modbusCount=2 \
  --set opcuaSimulator.enabled=true \
  --set sensorSimulator.enabled=true \
  > rendered.yaml

# Check sidecars
grep -A10 "containers:" rendered.yaml
```

## Workflow Integration

### Triggering Deployment with Simulator Configuration

```bash
gh workflow run release-agent-fleet.yml \
  -f environment=dev \
  -f fleet_replicas=3 \
  -f simulator_preset=full-stack
```

**Or with custom settings:**
```bash
gh workflow run release-agent-fleet.yml \
  -f environment=staging \
  -f fleet_replicas=5 \
  -f simulator_preset=custom \
  -f modbus_simulator_count=2 \
  -f opcua_simulator_enabled=true \
  -f sensor_simulator_enabled=false
```

### Workflow Step Logic

The workflow applies preset logic in the `Deploy to Kubernetes` step:

```yaml
- name: Deploy to Kubernetes
  run: |
    # Apply preset logic
    MODBUS_COUNT=${{ inputs.modbus_simulator_count }}
    OPCUA_ENABLED=${{ inputs.opcua_simulator_enabled }}
    SENSOR_ENABLED=${{ inputs.sensor_simulator_enabled }}
    
    case "${{ inputs.simulator_preset }}" in
      modbus-only)
        MODBUS_COUNT=2
        OPCUA_ENABLED=false
        SENSOR_ENABLED=false
        ;;
      full-stack)
        MODBUS_COUNT=2
        OPCUA_ENABLED=true
        SENSOR_ENABLED=true
        ;;
      heavy-load)
        MODBUS_COUNT=3
        OPCUA_ENABLED=true
        SENSOR_ENABLED=true
        ;;
    esac
    
    helm upgrade --install agent-fleet ./charts/agent-fleet \
      --set simulator.modbusCount=$MODBUS_COUNT \
      --set opcuaSimulator.enabled=$OPCUA_ENABLED \
      --set sensorSimulator.enabled=$SENSOR_ENABLED
```

## Resource Planning

### Per-Pod Resource Consumption

| Configuration | Modbus | OPC-UA | Sensors | Total Memory | Total CPU |
|---------------|--------|--------|---------|--------------|-----------|
| Minimal       | 0      | ❌     | ❌      | 256Mi (agent) | 200m |
| Modbus-only   | 2      | ❌     | ❌      | 512Mi | 400m |
| Full-stack    | 2      | ✅     | ✅      | 768Mi | 600m |
| Heavy-load    | 3      | ✅     | ✅      | 896Mi | 725m |

**Planning for 10-replica fleet:**
- Minimal: 2.5GB RAM, 2 CPU cores
- Full-stack: 7.68GB RAM, 6 CPU cores
- Heavy-load: 8.96GB RAM, 7.25 CPU cores

## Troubleshooting

### Issue: Agent not discovering Modbus simulators

**Check:**
```bash
kubectl exec -it agent-fleet-0 -c agent -- env | grep MODBUS_SIMULATOR_PORTS
```

**Expected:** `MODBUS_SIMULATOR_PORTS=502` (or `502,503` etc.)

**Solution:** Verify `simulator.modbusCount > 0` in Helm values

### Issue: Modbus simulator port conflicts

**Symptom:** Pods crash with "Address already in use"

**Cause:** Multiple simulators trying to bind same port

**Solution:** StatefulSet template uses `{{ add 502 $idx }}` - check rendering:
```bash
helm template agent-fleet . --set simulator.modbusCount=3 | grep MODBUS_TCP_PORT
```

### Issue: OPC-UA simulator not starting

**Check logs:**
```bash
kubectl logs agent-fleet-0 -c opcua-simulator
```

**Verify enabled:**
```bash
kubectl get pod agent-fleet-0 -o jsonpath='{.spec.containers[*].name}'
```

**Expected:** Should include `opcua-simulator` if `opcuaSimulator.enabled: true`

## Best Practices

1. **Development:** Use `full-stack` preset for comprehensive testing
2. **CI/CD:** Use `modbus-only` or `opcua-only` for protocol-specific tests
3. **Performance Testing:** Use `heavy-load` preset with high replica count (10+)
4. **Production:** Use `minimal` preset (no simulators, real devices only)
5. **Resource Constraints:** Start with `simulator.modbusCount=1` to conserve memory
6. **Multi-Protocol Testing:** Use `custom` mode to mix exact simulator counts

## Migration from Fixed Configuration

**Before (old values.yaml):**
```yaml
simulator:
  enabled: true  # Binary on/off
```

**After (new values.yaml):**
```yaml
simulator:
  modbusCount: 1  # 0-3 instances
opcuaSimulator:
  enabled: true   # Independent toggle
sensorSimulator:
  enabled: false  # New capability
```

**Action Required:**
- Update CI/CD pipelines to use new `simulator_preset` or explicit `modbusCount`
- Review resource quotas (multi-simulator pods consume more RAM/CPU)
- Update agent code to read `MODBUS_SIMULATOR_PORTS` env var for discovery

## Related Documentation

- [Agent Fleet Deployment Guide](../README.md)
- [Modbus Implementation Guide](../../../docs/MODBUS-MULTI-CONNECTION-PROPOSAL.md)
- [GitHub Actions Workflows](../../../.github/workflows/README.md)
- [values.yaml Reference](./values.yaml)
