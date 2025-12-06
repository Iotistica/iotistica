# Multi-Broker MQTT Configuration Guide

## Overview

The Iotistic platform supports multiple MQTT broker options to meet different deployment needs:

- **Local Mosquitto** (self-hosted): Full control, infrastructure management required
- **HiveMQ Cloud** (managed): Zero infrastructure, automatic scaling, usage-based pricing
- **Custom Cloud Brokers**: AWS IoT Core, Azure IoT Hub, or other MQTT-compatible services

## Architecture

### Broker Selection Priority

1. **Environment Variables** (highest priority)
   - Full override: `MQTT_BROKER_HOST`, `MQTT_BROKER_PORT`, `MQTT_BROKER_PROTOCOL`
   - Type preference: `MQTT_BROKER_TYPE=local` or `MQTT_BROKER_TYPE=cloud`

2. **Environment Broker Type**
   - Query database for active broker matching `MQTT_BROKER_TYPE`
   - Example: `MQTT_BROKER_TYPE=cloud` selects HiveMQ Cloud if configured

3. **Device-Specific Assignment**
   - Per-device broker via `devices.mqtt_broker_id`
   - Allows routing specific devices to different brokers

4. **Default Broker** (lowest priority)
   - Database broker with `is_default=true`
   - Typically "Local Broker" (Mosquitto)

### Database Schema

```sql
CREATE TABLE mqtt_broker_config (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    broker_type VARCHAR(50) DEFAULT 'local',  -- 'local', 'cloud', 'edge', 'test'
    protocol VARCHAR(10) NOT NULL,            -- 'mqtt', 'mqtts', 'ws', 'wss'
    host VARCHAR(255) NOT NULL,
    port INTEGER NOT NULL,
    use_tls BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    is_default BOOLEAN DEFAULT false,
    -- ... additional fields
);
```

## Configuration

### 1. Local Mosquitto (Default)

**Helm Values** (`values.yaml`):
```yaml
mqttBroker:
  type: local

mosquitto:
  enabled: true
  externalHost: "23.233.80.107"
  nodePorts:
    mqtt: 30883
```

**Environment Variables**:
```bash
MQTT_BROKER_TYPE=local
MQTT_BROKER_HOST=iotistic-mosquitto
MQTT_BROKER_PORT=1883
MQTT_BROKER_PROTOCOL=mqtt
```

**Database**:
```sql
-- Local Mosquitto is default
SELECT * FROM mqtt_broker_config WHERE name = 'Local Broker';
-- is_default: true
-- is_active: true
-- broker_type: 'local'
```

### 2. HiveMQ Cloud

#### Step 1: Create HiveMQ Cluster

1. Sign up at [console.hivemq.cloud](https://console.hivemq.cloud)
2. Create a cluster:
   - Select region (e.g., `eu-central-1`)
   - Choose plan (Free, Starter, Professional, Enterprise)
3. Note cluster URL: `abc123.s1.eu.hivemq.cloud`
4. Create credentials (username/password)

#### Step 2: Configure Helm Chart

**values.yaml**:
```yaml
mqttBroker:
  type: cloud  # Switch to cloud broker
  
  cloud:
    enabled: true
    provider: hivemq
    host: "abc123.s1.eu.hivemq.cloud"
    port: 8883
    protocol: mqtts
    username: "your-hivemq-username"
    password: "your-hivemq-password"
    useTls: true
    verifyCertificate: true

# Optionally disable local Mosquitto to save resources
mosquitto:
  enabled: false
```

#### Step 3: Update Database

```sql
-- Activate HiveMQ Cloud broker
UPDATE mqtt_broker_config 
SET 
    host = 'abc123.s1.eu.hivemq.cloud',
    username = 'your-username',
    password_hash = crypt('your-password', gen_salt('bf')),
    is_active = true,
    is_default = true  -- Make it the default
WHERE name = 'HiveMQ Cloud';

-- Optionally deactivate local broker
UPDATE mqtt_broker_config 
SET is_default = false 
WHERE name = 'Local Broker';
```

#### Step 4: Deploy

```bash
helm upgrade --install iotistic ./k8s/charts/iotistic \
  --namespace iotistic-nodeport \
  -f values.yaml \
  --set mqttBroker.cloud.password="your-secure-password"
```

### 3. Hybrid Setup (Both Brokers)

Run both brokers and route devices individually:

**values.yaml**:
```yaml
mqttBroker:
  type: local  # Default to local

  local:
    username: admin
    password: iotistic42!
    
  cloud:
    enabled: true  # Also available
    host: "abc123.s1.eu.hivemq.cloud"
    username: "hivemq-user"
    password: "hivemq-pass"

mosquitto:
  enabled: true  # Keep local broker running
```

**Assign devices to specific brokers**:
```sql
-- Most devices use local broker (default)
-- Specific devices use HiveMQ Cloud
UPDATE devices 
SET mqtt_broker_id = (SELECT id FROM mqtt_broker_config WHERE name = 'HiveMQ Cloud')
WHERE uuid IN ('device-uuid-1', 'device-uuid-2');
```

## Deployment Scenarios

### Scenario 1: Starter Plan (Local Only)

- **Broker**: Local Mosquitto
- **Pros**: No additional costs, full control
- **Cons**: Infrastructure management required
- **Config**: `mqttBroker.type: local`

### Scenario 2: Professional Plan (HiveMQ Cloud)

- **Broker**: HiveMQ Cloud
- **Pros**: Managed service, automatic scaling, high availability
- **Cons**: Usage-based pricing
- **Config**: `mqttBroker.type: cloud`

### Scenario 3: Enterprise Plan (Hybrid)

- **Brokers**: Local + HiveMQ Cloud
- **Use Case**: Critical devices on cloud (high availability), bulk devices on local (cost)
- **Config**: Both enabled, per-device assignment

## Provisioning Flow

### Device Registration

1. **Device calls** `/api/v2/provisioning/register` with provisioning key
2. **API determines broker** using priority logic:
   - Check `MQTT_BROKER_TYPE` environment variable
   - Check device's `mqtt_broker_id` (if assigned)
   - Use default broker
3. **API returns broker config**:
   ```json
   {
     "mqtt": {
       "broker": "mqtts://abc123.s1.eu.hivemq.cloud:8883",
       "username": "device_abc",
       "password": "generated-password",
       "brokerConfig": {
         "protocol": "mqtts",
         "host": "abc123.s1.eu.hivemq.cloud",
         "port": 8883,
         "useTls": true,
         "verifyCertificate": true
       }
     }
   }
   ```
4. **Agent connects** to specified broker with credentials

### Dynamic Broker Switching

Change broker without device reprovisioning:

```sql
-- Switch device to HiveMQ Cloud
UPDATE devices 
SET mqtt_broker_id = (SELECT id FROM mqtt_broker_config WHERE name = 'HiveMQ Cloud')
WHERE uuid = 'device-uuid';

-- Notify agent via MQTT
-- Agent will fetch new broker config and reconnect
```

## API Endpoints

### List Brokers

```http
GET /api/mqtt/brokers
Authorization: Bearer <token>
```

**Response**:
```json
{
  "success": true,
  "brokers": [
    {
      "id": 1,
      "name": "Local Broker",
      "brokerType": "local",
      "protocol": "mqtt",
      "host": "iotistic-mosquitto",
      "port": 1883,
      "isActive": true,
      "isDefault": true
    },
    {
      "id": 2,
      "name": "HiveMQ Cloud",
      "brokerType": "cloud",
      "protocol": "mqtts",
      "host": "abc123.s1.eu.hivemq.cloud",
      "port": 8883,
      "isActive": false,
      "isDefault": false
    }
  ]
}
```

### Create/Update Broker

```http
POST /api/mqtt/brokers
Content-Type: application/json
Authorization: Bearer <token>

{
  "name": "HiveMQ Cloud",
  "broker_type": "cloud",
  "protocol": "mqtts",
  "host": "abc123.s1.eu.hivemq.cloud",
  "port": 8883,
  "username": "hivemq-user",
  "password": "hivemq-password",
  "use_tls": true,
  "verify_certificate": true,
  "is_active": true,
  "is_default": false
}
```

### Assign Broker to Device

```http
POST /api/mqtt/brokers/assign
Content-Type: application/json
Authorization: Bearer <token>

{
  "deviceUuid": "device-uuid-123",
  "brokerId": 2
}
```

## Cost Comparison

### Local Mosquitto

| Item | Cost |
|------|------|
| Infrastructure | K8s cluster costs (shared) |
| Management | DevOps time |
| Scaling | Manual |
| **Total** | Fixed (infrastructure) |

### HiveMQ Cloud

| Plan | Messages/Month | Connections | Cost |
|------|----------------|-------------|------|
| Free | 1M | 100 | $0 |
| Starter | 100M | 1,000 | ~$49/mo |
| Professional | 1B | 10,000 | ~$499/mo |
| Enterprise | Custom | Custom | Custom |

**Break-even**: ~100 devices using local Mosquitto vs HiveMQ Cloud Starter

## Troubleshooting

### Issue: Devices can't connect to HiveMQ Cloud

**Check**:
1. Cluster URL correct? `*.s1.eu.hivemq.cloud`
2. Credentials valid?
3. TLS enabled? HiveMQ requires `mqtts://` (port 8883)
4. Firewall allows outbound 8883?

**Test connection**:
```bash
mosquitto_pub -h abc123.s1.eu.hivemq.cloud -p 8883 \
  -u "username" -P "password" \
  --capath /etc/ssl/certs \
  -t test -m "hello" \
  -d
```

### Issue: Environment variable not taking effect

**Check priority**:
```sql
-- View current configuration
SELECT * FROM mqtt_broker_comparison;

-- Check environment
echo $MQTT_BROKER_TYPE

-- API logs show which broker selected
kubectl logs -n iotistic-nodeport deployment/iotistic-api | grep "MQTT Config"
```

### Issue: Migration didn't create HiveMQ broker

**Run migration**:
```bash
cd api
npx knex migrate:latest

# Verify
psql -U postgres -d iotistic -c "SELECT name, broker_type, is_active FROM mqtt_broker_config;"
```

## Security Best Practices

1. **Use Kubernetes Secrets** for cloud broker credentials:
   ```yaml
   apiVersion: v1
   kind: Secret
   metadata:
     name: hivemq-credentials
   stringData:
     username: your-username
     password: your-password
   ```

2. **Always use TLS** for cloud brokers (port 8883)

3. **Rotate credentials** periodically via HiveMQ console

4. **Limit device permissions** using ACLs (HiveMQ supports role-based access)

5. **Monitor connection metrics** via HiveMQ Cloud dashboard

## Migration Path

### From Local to Cloud

1. Configure HiveMQ Cloud broker (inactive)
2. Test with subset of devices
3. Set `MQTT_BROKER_TYPE=cloud` in Helm
4. Deploy
5. Monitor device connections
6. Set HiveMQ as default broker
7. Optionally disable local Mosquitto

### From Cloud to Local

1. Deploy Mosquitto (if not running)
2. Set `MQTT_BROKER_TYPE=local`
3. Deploy
4. Monitor device connections
5. Set Local Broker as default
6. Deactivate cloud broker

## Related Documentation

- `docs/MQTT-EXTERNAL-HOST-PROVISIONING.md` - External broker addresses
- `docs/PROVISIONING-BROKER-CONFIG.md` - Provisioning flow details
- `api/database/migrations/102_add_hivemq_cloud_broker.sql` - Database schema
- `api/src/utils/mqtt-broker-config.ts` - Broker selection logic
