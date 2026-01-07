# Agent Fleet Simulator Configuration - Quick Reference

## 🎯 TL;DR

Deploy IoT agent fleets with **flexible simulator combinations** (0-3 Modbus + 0-3 OPC-UA + sensors) using GitHub Actions presets or custom sliders.

## 🚀 Quick Deploy

### GitHub Actions (Recommended)

**Full-stack testing:**
```bash
gh workflow run release-agent-fleet.yml \
  -f environment=dev \
  -f simulator_preset=full-stack
```

**Custom combination:**
```bash
gh workflow run release-agent-fleet.yml \
  -f environment=staging \
  -f simulator_preset=custom \
  -f modbus_simulator_count=2 \
  -f opcua_simulator_count=2
```

### Direct Helm

**2 Modbus + OPC-UA:**
```bash
helm install agent-fleet ./charts/agent-fleet \
  --set simulator.modbusCount=2 \
  --set opcuaSimulator.count=1
```

**Production (no simulators):**
```bash
helm install agent-fleet ./charts/agent-fleet \
  --set simulator.modbusCount=0 \
  --set opcuaSimulator.count=0 \
  --set sensorSimulator.enabled=false
```

## 📋 Preset Configurations

| Preset | Modbus | OPC-UA | Sensors | Use Case |
|--------|--------|--------|---------|----------|
| `minimal` | 0 | ❌ | ❌ | Production (real devices) |
| `modbus-only` | 2 | ❌ | ❌ | Modbus protocol testing |
| `opcua-only` | 0 | ✅ | ❌ | OPC-UA protocol testing |
| `full-stack` | 2 | ✅ | ✅ | Comprehensive testing |
| `heavy-load` | 3 | ✅ | ✅ | Stress/performance testing |
| `custom` | 0-3 | ✅/❌ | ✅/❌ | Fine-grained control |

## 🔧 Values.yaml Configuration

```yaml
simulator:
  modbusCount: 1  # 0-3 instances per pod
  
opcuaSimulator:
  count: 1        # 0-3 instances per pod
  
sensorSimulator:
  enabled: false  # BME688 emulation
```

## 🌐 Agent Environment Variables

Automatically set based on simulator configuration:

```bash
# Comma-separated Modbus ports
MODBUS_SIMULATOR_PORTS=502,503,504

# OPC-UA discovery endpoints (one per simulator)
OPCUA_DISCOVERY_URLS=opc.tcp://localhost:4840,opc.tcp://localhost:4841

# Sensor polling flag
SENSOR_SIMULATOR_ENABLED=true
```

## 🧪 Testing

**Validate template rendering:**
```powershell
cd k8s/charts/agent-fleet
./test-simulator-configs.ps1
```

**Manual inspection:**
```bash
helm template agent-fleet . \
  --set simulator.modbusCount=3 \
  --set opcuaSimulator.enabled=true \
  | grep -A5 "modbus-simulator"
```

## 🐛 Troubleshooting

**Agent not finding Modbus simulators:**
```bash
kubectl exec -it agent-fleet-0 -c agent -- env | grep MODBUS_SIMULATOR_PORTS
# Should output: MODBUS_SIMULATOR_PORTS=502,503
```

**Check sidecar containers:**
```bash
kubectl get pod agent-fleet-0 -o jsonpath='{.spec.containers[*].name}'
# Expected: agent modbus-simulator-0 modbus-simulator-1 opcua-simulator
```

**View simulator logs:**
```bash
kubectl logs agent-fleet-0 -c modbus-simulator-0
kubectl logs agent-fleet-0 -c opcua-simulator
```

## 📊 Resource Planning

| Preset | Memory/Pod | CPU/Pod | 10-Pod Fleet RAM |
|--------|------------|---------|------------------|
| minimal | 256Mi | 200m | 2.5GB |
| modbus-only | 512Mi | 400m | 5GB |
| full-stack | 768Mi | 600m | 7.68GB |
| heavy-load | 896Mi | 725m | 8.96GB |

## 📖 Full Documentation

- [Simulator Configuration Guide](k8s/charts/agent-fleet/SIMULATOR-CONFIGURATION-GUIDE.md) - Complete reference
- [Implementation Summary](AGENT-FLEET-SIMULATOR-CONFIG-SUMMARY.md) - Technical details
- [values.yaml](k8s/charts/agent-fleet/values.yaml) - Default configuration

## 🔑 Key Files

```
k8s/charts/agent-fleet/
├── values.yaml                         # Default simulator config
├── templates/statefulset.yaml          # Dynamic sidecar rendering
├── test-simulator-configs.ps1          # Test script
└── SIMULATOR-CONFIGURATION-GUIDE.md    # Full documentation

.github/workflows/
└── release-agent-fleet.yml             # Workflow with presets
```

## 💡 Pro Tips

1. **Start small:** Use `modbus-only` preset before `heavy-load`
2. **Resource quotas:** Set namespace limits to prevent runaway deployments
3. **Pin versions:** Change simulator image tags from `:latest` to specific versions in production
4. **Monitor costs:** 10 `heavy-load` replicas = 9GB RAM + 7 CPU cores
5. **Test locally:** Use `helm template` to validate before deploying to cluster

## 🎓 Common Workflows

**Development:**
```bash
# 1 Modbus + OPC-UA for comprehensive testing
--set simulator.modbusCount=1 \
--set opcuaSimulator.enabled=true
```

**CI/CD:**
```bash
# Protocol-specific testing (faster than full-stack)
--set simulator.modbusCount=2 \
--set opcuaSimulator.enabled=false  # Modbus-only
```

**Performance Testing:**
```bash
# Maximum simulator load
--set simulator.modbusCount=3 \
--set opcuaSimulator.enabled=true \
--set sensorSimulator.enabled=true
```

**Production:**
```bash
# No simulators, real devices only
--set simulator.modbusCount=0 \
--set opcuaSimulator.enabled=false
```

---

**Questions?** See [SIMULATOR-CONFIGURATION-GUIDE.md](k8s/charts/agent-fleet/SIMULATOR-CONFIGURATION-GUIDE.md) or contact DevOps team.
