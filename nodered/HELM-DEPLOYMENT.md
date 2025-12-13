# Node-RED Helm Deployment Guide

## Overview

Node-RED is deployed as an optional component in the Iotistic customer-instance Helm chart. It integrates with the Iotistic platform through three custom plugins:

### Custom Plugin Architecture

1. **@iotistic/nr-devices-plugin** (`nr-devices-plugin/`)
   - **Type**: Node-RED plugin + custom nodes
   - **Purpose**: Adds Iotistic-specific tools to Node-RED editor
   - **Components**:
     - Plugin: `dist/plugin.js` - Extends editor UI with device management tools
     - Nodes:
       - `virtual-device.js` - Creates virtual IoT devices for testing
       - `mqtt-tree-viewer.js` - Visualizes MQTT topic hierarchies
       - `remote-subflow.js` - Enables reusable subflows across instances
   - **Build**: Requires `npm run build` (Rollup bundler)
   - **Registration**: `node-red.plugins` + `node-red.nodes` in package.json

2. **@iotistic/nr-auth** (`nr-auth/`)
   - **Type**: Authentication plugin
   - **Purpose**: Integrates Node-RED login with Iotistic platform
   - **Components**:
     - `lib/adminAuth.js` - Main auth module (Passport.js strategy)
     - `lib/httpAuthPlugin.js` - HTTP middleware plugin
   - **Configuration**: Loaded via `settings.js` → `adminAuth` property
   - **Registration**: `node-red.plugins.auth-plugin` in package.json

3. **@iotistic/nr-storage** (`nr-storage/`)
   - **Type**: Storage module
   - **Purpose**: Stores flows, credentials, settings in Iotistic API (not local files)
   - **Implementation**: HTTP REST client for CRUD operations
   - **Configuration**: Loaded via `settings.js` → `storageModule` property
   - **Authentication**: Service API key (`IOTISTIC_STORAGE_TOKEN`)

### Plugin Loading Mechanism

Node-RED loads plugins in this order:

1. **Build time** (Dockerfile):
   ```dockerfile
   # Install plugin dependencies in /data
   WORKDIR /data/@iotistic/nr-auth
   RUN npm install --production
   
   # Link plugins to Node-RED
   WORKDIR /usr/src/node-red
   RUN npm install /data/@iotistic/nr-auth
   ```

2. **Runtime** (settings.js):
   ```javascript
   module.exports = {
     adminAuth: require("@iotistic/nr-auth")({ ... }),
     storageModule: require('@iotistic/nr-storage')({ ... }),
     // Plugins auto-loaded from node-red.plugins in package.json
   }
   ```

3. **Node-RED startup**:
   - Scans `node_modules/` for packages with `node-red.plugins` or `node-red.nodes`
   - Registers plugins via package.json metadata
   - Loads nodes into palette

## Architecture

### Helm Template Structure

- **ConfigMap**: `nodered-settings` - Contains `settings.js` with environment-specific configuration
- **PVC**: `nodered-data` - Persistent storage for flows and user data (5Gi default)
- **Deployment**: `nodered` - Single replica Node-RED instance
- **Service**: `nodered` - ClusterIP service on port 1880
- **Ingress**: Routes `/nodered` path to Node-RED service

### Environment Variables

| Variable | Source | Purpose |
|----------|--------|---------|
| `IOTISTIC_BASE_URL` | Auto (API service) | API endpoint for auth/storage |
| `IOTISTIC_STORAGE_TOKEN` | Secret (auto-generated) | Service API key for storage |
| `MQTT_BROKER_URL` | Auto (Mosquitto service) | MQTT broker connection |
| `MQTT_USERNAME` | Secret (auto-generated) | MQTT auth username |
| `MQTT_PASSWORD` | Secret (auto-generated) | MQTT auth password |
| `NODE_RED_ENABLE_SAFE_MODE` | Static | Disable safe mode |
| `TZ` | values.yaml | Timezone configuration |

### Secret Management

Secrets are auto-generated on first install and reused on upgrades:

```yaml
# values.yaml
nodered:
  mqtt:
    username: "nodered"
    password: ""  # Auto-generated 32-char random string
```

Helper templates in `_helpers.tpl`:
- `customer-instance.noderedMqttPassword` - Generates/retrieves MQTT password
- `customer-instance.noderedStorageToken` - Generates/retrieves storage token (64-char)

## Deployment

### Enable Node-RED for Customer

```bash
helm upgrade customer-abc123 ./k8s/charts/customer-instance \
  --namespace customer-abc123 \
  --reuse-values \
  --set nodered.enabled=true \
  --set nodered.image.tag=latest
```

### Disable Node-RED

```bash
helm upgrade customer-abc123 ./k8s/charts/customer-instance \
  --namespace customer-abc123 \
  --reuse-values \
  --set nodered.enabled=false
```

### Upgrade Node-RED Version

```bash
# After new image is built by CI
helm upgrade customer-abc123 ./k8s/charts/customer-instance \
  --namespace customer-abc123 \
  --reuse-values \
  --set nodered.image.tag=2025.01.15-1234
```

### Custom Configuration

```bash
helm upgrade customer-abc123 ./k8s/charts/customer-instance \
  --namespace customer-abc123 \
  --reuse-values \
  --set nodered.enabled=true \
  --set nodered.logLevel=debug \
  --set nodered.timezone="America/New_York" \
  --set nodered.storage.size=10Gi
```

## CI/CD Workflow

### Workflow: `.github/workflows/release-nodered.yml`

**Trigger**:
- Push to `master` with changes in `nodered/`
- Manual workflow dispatch

**Jobs**:

1. **version** - Generate semantic version (YYYY.MM.DD-commitCount)
2. **build-plugins** - Build nr-devices-plugin, verify nr-auth/nr-storage
3. **build-push** - Build Docker image with all plugins, push to Docker Hub
4. **deploy-test** (manual only) - Deploy to test customer instance
5. **report** - Generate changelog and deployment instructions

**Image Tags**:
- `iotistic/nodered:latest`
- `iotistic/nodered:<sha>` (e.g., `abc1234`)
- `iotistic/nodered:<version>` (e.g., `2025.01.15-1234`)

**Artifacts**:
- `nodered-plugins` - Built plugin files (retention: 1 day)
- `release-changelog` - Commit history (retention: 90 days)

### Plugin Build Process

```bash
# Local development
cd nodered/data/@iotistic/nr-devices-plugin
npm ci
npm run build  # Rollup bundles src/ -> dist/

# CI workflow
- uses: actions/upload-artifact@v4
  with:
    name: nodered-plugins
    path: |
      nodered/data/@iotistic/nr-devices-plugin/dist
      nodered/data/@iotistic/nr-auth/lib
      nodered/data/@iotistic/nr-storage/*.js
```

### Docker Build Integration

```dockerfile
# Download pre-built plugins from CI artifact
- uses: actions/download-artifact@v4
  with:
    name: nodered-plugins
    path: nodered/data/@iotistic/

# Build with plugins included
- uses: docker/build-push-action@v5
  with:
    context: ./nodered
    push: true
    tags: iotistic/nodered:${{ version }}
```

## Configuration Reference

### values.yaml

```yaml
nodered:
  enabled: false  # Enable per customer
  image:
    repository: iotistic/nodered
    tag: latest
    pullPolicy: IfNotPresent
  replicas: 1
  port: 1880
  resources:
    requests:
      cpu: 200m
      memory: 256Mi
    limits:
      cpu: 500m
      memory: 512Mi
  storage:
    size: 5Gi
    storageClass: ""
  mqtt:
    username: "nodered"
    password: ""  # Auto-generated
  logLevel: "info"  # debug, info, warn, error
  timezone: "UTC"
```

### settings.js Template

Key configuration points:

```javascript
// API integration
iotisticURL: process.env.IOTISTIC_BASE_URL
adminAuth: require("@iotistic/nr-auth")({ iotisticURL })
storageModule: require('@iotistic/nr-storage')({ iotisticURL, token })

// MQTT defaults
mqttBroker: "mqtt://mosquitto:1883"
mqttUsername: "nodered"
mqttPassword: "<from-secret>"

// UI customization
editorTheme: {
  page: { title: "Customer Name - Node-RED" },
  header: { title: "Customer Name" },
  menu: {
    "menu-item-help": {
      label: "Iotistic Documentation",
      url: "https://docs.iotistic.com"
    }
  }
}
```

## Monitoring

### Health Checks

```yaml
livenessProbe:
  httpGet:
    path: /
    port: 1880
  initialDelaySeconds: 30
  periodSeconds: 30

readinessProbe:
  httpGet:
    path: /
    port: 1880
  initialDelaySeconds: 10
  periodSeconds: 10
```

### Logs

```bash
# View Node-RED logs
kubectl logs -n customer-abc123 -l app.kubernetes.io/component=nodered

# Follow logs
kubectl logs -n customer-abc123 -l app.kubernetes.io/component=nodered -f

# Debug mode
helm upgrade customer-abc123 ./k8s/charts/customer-instance \
  --reuse-values \
  --set nodered.logLevel=debug
```

### Metrics

Node-RED exposes metrics at `/metrics` endpoint (if enabled in settings).

## Troubleshooting

### Plugin Not Loading

```bash
# Check plugin installation
kubectl exec -n customer-abc123 deployment/nodered -- ls -la /data/@iotistic

# Verify Node-RED recognizes plugins
kubectl exec -n customer-abc123 deployment/nodered -- \
  npm list --depth=0 --prefix /usr/src/node-red | grep @iotistic

# Expected output:
# ├── @iotistic/nr-auth@1.0.0
# ├── @iotistic/nr-devices-plugin@0.3.0
# └── @iotistic/nr-storage@1.3.0
```

### Storage Connection Fails

```bash
# Verify storage token exists
kubectl get secret -n customer-abc123 customer-abc123-secrets \
  -o jsonpath='{.data.NODERED_STORAGE_TOKEN}' | base64 -d

# Check API connectivity
kubectl exec -n customer-abc123 deployment/nodered -- \
  wget -O- http://customer-abc123-api:3002/health
```

### MQTT Connection Issues

```bash
# Test MQTT connectivity
kubectl exec -n customer-abc123 deployment/nodered -- \
  npm install -g mqtt
  
kubectl exec -n customer-abc123 deployment/nodered -- \
  mqtt pub -h customer-abc123-mosquitto -p 1883 \
  -u nodered -P <password> -t test -m "hello"
```

### Build Failures (CI)

**Plugin build fails**:
```bash
# Check plugin dependencies
cd nodered/data/@iotistic/nr-devices-plugin
npm ci
npm run build  # Should output dist/ directory
```

**Docker build fails**:
```bash
# Test locally
cd nodered
docker build -t test-nodered .
docker run -p 1880:1880 test-nodered
```

## Development

### Local Testing

```bash
# Build plugins
cd nodered/data/@iotistic/nr-devices-plugin
npm run build

# Run with Docker Compose
cd ../../../..
docker-compose up -d nodered

# Access at http://localhost:1880
```

### Plugin Development

```bash
# Watch mode for live rebuild
cd nodered/data/@iotistic/nr-devices-plugin
npm run watch

# Docker rebuild
docker-compose build nodered
docker-compose up -d nodered
```

### Helm Testing

```bash
# Dry run to verify templates
helm template test ./k8s/charts/customer-instance \
  --set nodered.enabled=true \
  --set customer.id=test \
  --set customer.email=test@example.com \
  --set customer.companyName="Test Co" \
  --set license.key=fake-jwt \
  --debug

# Install to test cluster
helm install test-customer ./k8s/charts/customer-instance \
  --namespace test-customer \
  --create-namespace \
  --set nodered.enabled=true \
  --set customer.id=test-customer \
  --set customer.email=test@example.com
```

## Security

### Authentication Flow

1. User accesses `https://<customer-id>.iotistic.ca/nodered`
2. Node-RED redirects to Iotistic login
3. User authenticates via Iotistic platform
4. Iotistic returns JWT token
5. @iotistic/nr-auth validates token
6. Node-RED grants access

### Storage Security

- Flows/credentials stored in Iotistic API (not local files)
- Storage API key (`NODERED_STORAGE_TOKEN`) unique per customer
- Token rotated on customer instance recreation

### MQTT Security

- Separate MQTT credentials for Node-RED (`nodered` user)
- ACLs managed by Mosquitto PostgreSQL auth
- Password auto-generated and stored in Kubernetes secrets

## Best Practices

1. **Enable only when needed** - Node-RED adds ~200-500MB RAM overhead
2. **Version pinning** - Use specific image tags in production (`nodered.image.tag=2025.01.15-1234`)
3. **Resource limits** - Adjust based on flow complexity
4. **Storage sizing** - 5Gi default, increase for large flows or historical data
5. **Log level** - Use `info` in production, `debug` for troubleshooting
6. **Timezone** - Set to customer's local timezone for accurate scheduling

## References

- [Node-RED Documentation](https://nodered.org/docs/)
- [Node-RED Plugin Development](https://nodered.org/docs/creating-nodes/packaging)
- [Iotistic API Documentation](https://docs.iotistic.com/api)
- [Customer Instance Helm Chart](../k8s/charts/customer-instance/README.md)
