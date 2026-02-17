# MQTT Broker Configuration for Standalone Agents

## Problem
Standalone (local/physical) agents were receiving K8s internal DNS (`demo-release-iotistic-mosquitto.demo.svc.cluster.local`) during provisioning, causing connection failures with error `getaddrinfo ENOTFOUND`.

## Solution
Modified provisioning flow to differentiate between virtual and standalone agents:

### Virtual Agents (K8s pods)
- Use `MQTT_BROKER_URL` environment variable
- Contains K8s internal DNS for low-latency cluster communication
- Example: `mqtt://demo-release-iotistic-mosquitto.demo.svc.cluster.local:1883`

### Standalone Agents (Local/Physical)
- Use `mqtt_broker_config` database table (skips env variables)
- Contains public Gateway IP or DNS for external access
- Example: `mqtt://20.220.137.172:1883` or `mqtt://mqtt1.iotistica.com:1883`

## Code Changes

### provisioning.service.ts
- Added conditional broker config fetching based on `device_type === 'virtual'`
- Virtual: Calls `getBrokerConfigForExternalDevice()` (uses env variables)
- Standalone: Calls `getStandaloneBrokerConfig()` (skips env, uses database only)
- Added detailed logging for both paths
- Throws error if no config found (fail fast instead of silent failure)

### mqtt-broker-config.ts
- Added `getStandaloneBrokerConfig()` function
- Queries database directly without checking environment variables
- Prevents K8s internal DNS from being passed to standalone agents

## Database Configuration

### Current Broker (from migration 124)
```sql
SELECT * FROM mqtt_broker_config WHERE is_default = true;
```

Current values (from migration 124_update_mqtt_broker_to_cloud.sql):
- **host**: `mqtt1.iotistica.com`
- **port**: `1883`
- **broker_type**: `cloud`

### Update to Gateway IP (Required for standalone agents)

Option 1: Use Gateway IP directly
```sql
UPDATE mqtt_broker_config
SET 
    host = '20.220.137.172',  -- Envoy Gateway external IP
    description = 'Cloud MQTT broker via Envoy Gateway',
    updated_at = CURRENT_TIMESTAMP
WHERE is_default = true;
```

Option 2: Set up DNS and use hostname (Recommended for production)
```bash
# 1. Add DNS A record: mqtt.iotistica.ca -> 20.220.137.172
# 2. Update database:
UPDATE mqtt_broker_config
SET 
    host = 'mqtt.iotistica.ca',
    description = 'Cloud MQTT broker via Envoy Gateway',
    updated_at = CURRENT_TIMESTAMP
WHERE is_default = true;
```

## Testing

### Test Virtual Agent Provisioning
```bash
# Should receive K8s internal DNS
curl -X POST http://localhost:3002/api/v1/device/register \
  -H "Content-Type: application/json" \
  -d '{
    "uuid": "test-virtual-001",
    "deviceName": "Test Virtual Agent",
    "deviceType": "virtual",
    "deviceApiKey": "test-key",
    "provisioningApiKey": "your-provisioning-key"
  }' | jq '.mqtt.brokerConfig.host'

# Expected: demo-release-iotistic-mosquitto.demo.svc.cluster.local
```

### Test Standalone Agent Provisioning
```bash
# Should receive public Gateway IP or DNS
curl -X POST http://localhost:3002/api/v1/device/register \
  -H "Content-Type: application/json" \
  -d '{
    "uuid": "test-standalone-001",
    "deviceName": "Test Standalone Agent",
    "deviceType": "physical",
    "deviceApiKey": "test-key",
    "provisioningApiKey": "your-provisioning-key"
  }' | jq '.mqtt.brokerConfig.host'

# Expected: 20.220.137.172 (or mqtt.iotistica.ca if DNS configured)
```

### Verify MQTT Connection
```bash
# Test connection to Gateway IP
mosquitto_pub -h 20.220.137.172 -p 1883 -t test -m "hello" -u <username> -P <password>

# Test connection to DNS (if configured)
mosquitto_pub -h mqtt.iotistica.ca -p 1883 -t test -m "hello" -u <username> -P <password>
```

## Environment Variables

### API Service (K8s deployment)
```yaml
env:
- name: MQTT_BROKER_URL
  value: "mqtt://demo-release-iotistic-mosquitto.demo.svc.cluster.local:1883"
```

This env variable is **only used by**:
1. API service itself for internal MQTT operations
2. Virtual agent provisioning (device_type === 'virtual')

Standalone agents **ignore** this env variable and use database config instead.

## Deployment Checklist

- [ ] Code changes deployed (provisioning.service.ts, mqtt-broker-config.ts)
- [ ] Database updated with public Gateway IP or DNS
- [ ] DNS configured (if using hostname instead of IP)
- [ ] Virtual agent provisioning tested (receives K8s internal DNS)
- [ ] Standalone agent provisioning tested (receives public IP/DNS)
- [ ] Standalone agent can connect to MQTT broker
- [ ] Virtual agent can connect to MQTT broker

## Next Steps

1. **Immediate**: Update mqtt_broker_config table with Gateway IP (20.220.137.172)
2. **Production**: Set up DNS (mqtt.iotistica.ca -> 20.220.137.172) and update database
3. **Test**: Provision both virtual and standalone agents to verify correct MQTT configuration
4. **Monitor**: Check agent logs for successful MQTT connections

## Related Files
- `api/src/services/provisioning.service.ts` - Provisioning logic with virtual/standalone detection
- `api/src/utils/mqtt-broker-config.ts` - MQTT config fetchers (getBrokerConfigForExternalDevice, getStandaloneBrokerConfig)
- `api/database/migrations/124_update_mqtt_broker_to_cloud.sql` - Current broker config
- `docs/K8S-IMAGE-UPDATE.md` - K8s deployment commands
