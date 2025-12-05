# MQTT External Host Provisioning Fix

## Problem Summary

After device provisioning, agents received internal Kubernetes service names (e.g., `iotistic-mosquitto:1883`) as the MQTT broker address. External devices cannot resolve these internal K8s DNS names, preventing them from connecting to the broker.

The Mosquitto service is exposed via NodePort 30883 on the K8s node, but this external address wasn't being communicated to devices during provisioning.

## Architecture Pattern

### Internal vs External Connections

**Internal connections** (API → Mosquitto within K8s):
- Use K8s service name: `iotistic-mosquitto:1883`
- ClusterIP networking, DNS-based discovery
- Works within the same K8s cluster

**External connections** (Devices → Mosquitto from outside K8s):
- Use NodePort address: `<K8s-node-IP>:30883`
- Or LoadBalancer address if configured
- Requires external routable address

## Solution Implementation

### 1. Helm Chart Configuration

**File**: `k8s/charts/iotistic/values.yaml`

Added external host configuration:

```yaml
mosquitto:
  # Internal service name (for API connections within K8s)
  host: iotistic-mosquitto
  ports:
    mqtt: 1883
    websockets: 9001
  
  # External host for device connections (set to your K8s node IP or LoadBalancer)
  # This is what devices will use to connect to MQTT broker
  externalHost: ""  # Empty = use MQTT_BROKER_EXTERNAL_HOST env var
  
  nodePorts:
    mqtt: 30883
    websockets: 30901
```

**File**: `k8s/charts/iotistic/templates/api.yaml`

Added environment variables for external broker address:

```yaml
- name: MQTT_BROKER_EXTERNAL_HOST
  value: {{ .Values.mosquitto.externalHost | default (printf "%s-mosquitto" (include "iotistic.fullname" .)) }}
- name: MQTT_BROKER_EXTERNAL_PORT
  value: {{ .Values.mosquitto.nodePorts.mqtt | default .Values.mosquitto.ports.mqtt | quote }}
```

### 2. Broker Configuration Utility

**File**: `api/src/utils/mqtt-broker-config.ts`

Added two new functions:

#### `createConfigFromEnvExternal()`

Creates broker configuration using external host/port environment variables:

```typescript
function createConfigFromEnvExternal(): MqttBrokerConfig {
  const config = createConfigFromEnv();
  
  // Use external host/port if configured (for devices connecting from outside K8s)
  if (process.env.MQTT_BROKER_EXTERNAL_HOST) {
    config.host = process.env.MQTT_BROKER_EXTERNAL_HOST;
  }
  if (process.env.MQTT_BROKER_EXTERNAL_PORT) {
    config.port = parseInt(process.env.MQTT_BROKER_EXTERNAL_PORT, 10);
  }
  
  return config;
}
```

#### `getBrokerConfigForExternalDevice()`

Exported function for provisioning external devices:

```typescript
export async function getBrokerConfigForExternalDevice(
  deviceUuid: string
): Promise<MqttBrokerConfig | null> {
  // Priority 1: Environment override with external host
  const envHost = process.env.MQTT_BROKER_HOST;
  const envPort = process.env.MQTT_BROKER_PORT;
  const envProtocol = process.env.MQTT_BROKER_PROTOCOL;
  const externalHost = process.env.MQTT_BROKER_EXTERNAL_HOST;
  const externalPort = process.env.MQTT_BROKER_EXTERNAL_PORT;
  
  if (envHost && envPort && envProtocol) {
    return createConfigFromEnvExternal();
  }
  
  // Priority 2 & 3: Fall back to internal device broker lookup
  return getBrokerConfigForDevice(deviceUuid);
}
```

**Priority order**:
1. Environment variables with external host override (`MQTT_BROKER_EXTERNAL_HOST`)
2. Device-specific broker from database
3. Default broker from database

### 3. Provisioning Service Update

**File**: `api/src/services/provisioning.service.ts`

Changed provisioning to use external broker configuration:

```typescript
// OLD (returned internal addresses):
const brokerConfig = await getBrokerConfigForDevice(device.uuid);

// NEW (returns external addresses):
const brokerConfig = await getBrokerConfigForExternalDevice(device.uuid);
```

Added logging to distinguish external vs internal broker usage:

```typescript
if (brokerConfig) {
  logger.info(`Using MQTT broker for external device: ${brokerConfig.name} (${buildBrokerUrl(brokerConfig)})`);
}
```

## Deployment Steps

### 1. Set External Host Value

Update `k8s/charts/iotistic/values.yaml` with your actual K8s node IP or LoadBalancer domain:

```yaml
mosquitto:
  externalHost: "23.233.80.107"  # Or "mqtt.iotistic.ca"
  nodePorts:
    mqtt: 30883
```

### 2. Deploy Helm Chart

```bash
helm upgrade iotistic ./k8s/charts/iotistic \
  --namespace iotistic-nodeport \
  --create-namespace
```

### 3. Verify Environment Variables

Check that the API pod has the external host environment variables:

```bash
kubectl get pods -n iotistic-nodeport
kubectl exec -it -n iotistic-nodeport deployment/iotistic-api -- env | grep MQTT_BROKER_EXTERNAL
```

Expected output:
```
MQTT_BROKER_EXTERNAL_HOST=23.233.80.107
MQTT_BROKER_EXTERNAL_PORT=30883
```

### 4. Test Device Provisioning

Provision a new test device:

```bash
curl -X POST https://api.iotistic.ca/provision \
  -H "Content-Type: application/json" \
  -d '{
    "provisioningKey": "your-key",
    "deviceName": "test-device",
    "deviceType": "raspberry-pi"
  }'
```

Verify the response contains external broker address:

```json
{
  "mqtt": {
    "broker": "mqtt://23.233.80.107:30883",
    "brokerConfig": {
      "protocol": "mqtt",
      "host": "23.233.80.107",
      "port": 30883,
      "use_tls": false
    }
  }
}
```

### 5. Test MQTT Connection

From the device, test MQTT connectivity:

```bash
mosquitto_sub -h 23.233.80.107 -p 30883 \
  -u <mqtt-username> -P <mqtt-password> \
  -t "test" -v
```

## Environment Variables Reference

| Variable | Purpose | Example | Required |
|----------|---------|---------|----------|
| `MQTT_BROKER_HOST` | Internal K8s service name for API connections | `iotistic-mosquitto` | Yes |
| `MQTT_BROKER_PORT` | Internal MQTT port | `1883` | Yes |
| `MQTT_BROKER_EXTERNAL_HOST` | External address for device provisioning | `23.233.80.107` | Yes |
| `MQTT_BROKER_EXTERNAL_PORT` | External MQTT port (NodePort) | `30883` | Yes |
| `MQTT_BROKER_PROTOCOL` | MQTT protocol | `mqtt` or `mqtts` | Yes |

## Verification Checklist

- [ ] Helm chart deployed with `mosquitto.externalHost` set
- [ ] API pod has `MQTT_BROKER_EXTERNAL_HOST` and `MQTT_BROKER_EXTERNAL_PORT` env vars
- [ ] Provisioning response contains external broker address
- [ ] Device can resolve external host address
- [ ] Device successfully connects to MQTT broker on NodePort
- [ ] MQTT authentication works with provisioned credentials
- [ ] Device can publish/subscribe to topics

## Troubleshooting

### Issue: API still returns internal service name

**Check**:
```bash
kubectl logs -n iotistic-nodeport deployment/iotistic-api | grep "MQTT broker for external device"
```

**Solution**: Verify environment variables are set in API pod. Restart deployment if needed:
```bash
kubectl rollout restart deployment/iotistic-api -n iotistic-nodeport
```

### Issue: Device cannot connect to external address

**Check**:
1. Firewall rules allow traffic on port 30883
2. K8s NodePort service is listening:
   ```bash
   kubectl get svc -n iotistic-nodeport | grep mosquitto
   netstat -an | grep 30883
   ```
3. External IP is correct (node IP or LoadBalancer):
   ```bash
   kubectl get nodes -o wide
   ```

### Issue: TLS/SSL errors

If using `mqtts://` protocol, ensure:
- `MQTT_BROKER_USE_TLS=true`
- CA certificate provided in provisioning response
- Mosquitto configured with valid certificates

## Related Files

- `k8s/charts/iotistic/values.yaml` - Helm values configuration
- `k8s/charts/iotistic/templates/api.yaml` - API deployment with env vars
- `k8s/charts/iotistic/templates/mosquitto.yaml` - Mosquitto service/deployment
- `api/src/utils/mqtt-broker-config.ts` - Broker configuration utilities
- `api/src/services/provisioning.service.ts` - Device provisioning logic

## Architecture Decision Record

**Decision**: Separate internal and external broker addresses at provisioning time

**Context**: K8s uses internal DNS for service discovery, but external devices need routable addresses. Single broker configuration caused connectivity issues.

**Alternatives Considered**:
1. VPN for all devices (complex, adds latency)
2. Ingress controller with DNS (requires domain setup, TLS complexity)
3. Dual broker configuration (internal + external) - **SELECTED**

**Consequences**:
- ✅ Simple: No additional infrastructure needed
- ✅ Flexible: Works with NodePort, LoadBalancer, or Ingress
- ✅ Secure: Broker authentication still enforced
- ⚠️ Requires external address configuration in Helm values
- ⚠️ NodePort limitation: Only one instance per cluster (unless using different ports)

## Future Enhancements

1. **Automatic external address detection**: Query K8s API for node IPs or LoadBalancer status
2. **LoadBalancer support**: Automatically use LoadBalancer external IP if service type is LoadBalancer
3. **Regional brokers**: Support multiple external brokers for geo-distributed deployments
4. **Database-based external addresses**: Store external host per broker in `mqtt_broker_config` table
5. **DNS-based discovery**: Use SRV records for automatic broker discovery

## Testing Strategy

### Unit Tests

Test `getBrokerConfigForExternalDevice()` function:

```typescript
describe('getBrokerConfigForExternalDevice', () => {
  it('should use external host when MQTT_BROKER_EXTERNAL_HOST is set', async () => {
    process.env.MQTT_BROKER_EXTERNAL_HOST = '23.233.80.107';
    process.env.MQTT_BROKER_EXTERNAL_PORT = '30883';
    
    const config = await getBrokerConfigForExternalDevice('test-uuid');
    
    expect(config.host).toBe('23.233.80.107');
    expect(config.port).toBe(30883);
  });
  
  it('should fall back to internal host when external not set', async () => {
    delete process.env.MQTT_BROKER_EXTERNAL_HOST;
    
    const config = await getBrokerConfigForExternalDevice('test-uuid');
    
    expect(config.host).toBe('iotistic-mosquitto');
  });
});
```

### Integration Tests

Test end-to-end provisioning flow:

```typescript
describe('Provisioning with external broker', () => {
  it('should return external broker address in provisioning response', async () => {
    const response = await request(app)
      .post('/provision')
      .send({
        provisioningKey: 'test-key',
        deviceName: 'test-device'
      });
    
    expect(response.body.mqtt.brokerConfig.host).toBe('23.233.80.107');
    expect(response.body.mqtt.brokerConfig.port).toBe(30883);
  });
});
```

### E2E Tests

1. Deploy agent with provisioned credentials
2. Verify agent connects to external MQTT broker
3. Publish message from agent
4. Subscribe from dashboard and verify message received

---

**Status**: ✅ Implementation complete, ready for deployment testing
**Date**: 2025-01-25
**Version**: 1.0.0
