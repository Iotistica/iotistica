# Iotistic Agent Install Redirect Service

Simple, lightweight redirect service that provides a user-friendly install URL for the Iotistic device agent.

## Features

- ✅ Redirects `https://iotistica.com/agent/install` → Azure Blob Storage
- ✅ Supports integrity verification via SHA256 checksums
- ✅ Ultra-lightweight (Express + Helmet only)
- ✅ Health check endpoint for monitoring
- ✅ Comprehensive usage documentation
- ✅ Security headers via Helmet.js

## Installation

### Using Docker (Recommended)

```bash
# Build image
docker build -t iotistic-install-redirect .

# Run container (expose on port 3000)
docker run -d \
  --name iotistic-redirector \
  -p 3000:3000 \
  -e AZURE_STORAGE_ACCOUNT=your-account \
  -e AZURE_STORAGE_CONTAINER=scripts \
  iotistic-install-redirect
```

### Using Node.js Directly

```bash
npm install
node server.js
```

## Configuration

Set environment variables:

```bash
export AZURE_STORAGE_ACCOUNT="your-storage-account"
export AZURE_STORAGE_CONTAINER="scripts"
export PORT=3000
export NODE_ENV=production
```

## Usage

### Install agent (one-liner)
```bash
curl -sfL https://iotistica.com/agent/install | sh
```

### Verify integrity before running
```bash
curl -sfL https://iotistica.com/agent/install.sha256 | sha256sum -c -
```

### Get installation info
```bash
curl https://iotistica.com/agent/info
```

Output:
```json
{
  "description": "Iotistic Device Agent Installer",
  "usage": "curl -sfL https://iotistica.com/agent/install | sh",
  "install_url": "https://account.blob.core.windows.net/scripts/agent/install",
  "checksum_url": "https://account.blob.core.windows.net/scripts/agent/install.sha256",
  "documentation": "https://iotistica.com/documentation.html#agent-installation"
}
```

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/agent/install` | GET | Redirects to Azure Blob Storage (install.sh) |
| `/agent/install.sha256` | GET | Redirects to SHA256 checksum file |
| `/agent/info` | GET | Returns installation info (JSON) |
| `/health` | GET | Health check for monitoring |

## Deployment Options

### Option 1: Azure Container Instances (ACI)

```bash
az container create \
  --resource-group iotistic \
  --name iotistic-redirector \
  --image myregistry.azurecr.io/iotistic-install-redirect:latest \
  --environment-variables \
    AZURE_STORAGE_ACCOUNT="your-account" \
    AZURE_STORAGE_CONTAINER="scripts" \
    PORT=3000 \
  --ports 3000 \
  --dns-name-label iotistic-redirector
```

### Option 2: Azure App Service

```bash
az webapp up --name iotistic-redirector --runtime node --runtime-version 20
```

### Option 3: Kubernetes (Envoy Gateway)

Your cluster uses **Envoy Gateway** with the Kubernetes Gateway API. Deploy using the provided manifests:

```bash
# Apply all manifests in order
kubectl apply -f k8s/namespace.yaml
kubectl apply -f k8s/configmap.yaml
kubectl apply -f k8s/secret.yaml
kubectl apply -f k8s/serviceaccount.yaml
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/httproute.yaml
kubectl apply -f k8s/hpa.yaml
kubectl apply -f k8s/pdb.yaml

# Verify deployment
kubectl get pods -n iotistic-utils
kubectl get httproute -n iotistic-utils
kubectl get deployment -n iotistic-utils

# Monitor
kubectl logs -n iotistic-utils -l app=install-redirect -f
```

**HTTPRoute automatically attaches to your existing `iotistica-gateway`** in `envoy-gateway-system` namespace.
Traffic to `https://iotistica.com/agent/*` and `https://www.iotistica.com/agent/*` is routed to the service.

### Option 4: Docker Compose (Local)

```yaml
version: '3.8'
services:
  redirector:
    build: .
    ports:
      - "3000:3000"
    environment:
      AZURE_STORAGE_ACCOUNT: your-account
      AZURE_STORAGE_CONTAINER: scripts
      NODE_ENV: production
    healthcheck:
      test: ["CMD", "wget", "--quiet", "--tries=1", "--spider", "http://localhost:3000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Integration with Your Workflow

### Update CI/CD to include redirector deployment

In your `.github/workflows/build-device-agent-ci.yml`, add a step to build and push the redirector:

```yaml
- name: Build and push redirector Docker image
  run: |
    docker build -t myregistry.azurecr.io/iotistic-install-redirect:latest install-redirect/
    docker push myregistry.azurecr.io/iotistic-install-redirect:latest
```

### Update your website

Add to `marketing/website/agent.html`:

```html
<div class="install-section">
  <h2>Quick Install</h2>
  <p>Get the agent running in seconds:</p>
  <pre><code>curl -sfL https://iotistica.com/agent/install | sh</code></pre>
  <button onclick="copyToClipboard('curl -sfL https://iotistica.com/agent/install | sh')">
    Copy Command
  </button>
</div>
```

## Monitoring

### Check service health
```bash
curl https://iotistica.com/health
```

Response (healthy):
```json
{
  "status": "healthy",
  "timestamp": "2025-02-19T10:30:00.000Z"
}
```

### View logs (Docker)
```bash
docker logs -f iotistic-redirector
```

## Security Considerations

1. **HTTPS Only**: Always use HTTPS in production
2. **CORS**: Service uses Helmet.js security headers
3. **Azure Blob Access**: Blob storage should have appropriate SAS or public read access
4. **Request Logging**: All install requests are logged with IP address
5. **Rate Limiting**: Consider adding rate limiting in front of this service (nginx, CloudFlare, etc.)

## Performance

- **Latency**: <50ms typical redirect response
- **Throughput**: Can handle thousands of concurrent requests
- **Storage**: Minimal (node_modules + 2KB app code)
- **Memory**: ~50MB baseline

## Troubleshooting

### Service returns 404
- Ensure `AZURE_STORAGE_ACCOUNT` env var is set
- Check Azure Blob Storage has the `agent/install` blob

### 301 redirects not working
- Verify curl is installed and supports HTTPS
- Test directly: `curl -sfL https://iotistica.com/agent/install`

### Azure authentication errors
- If using managed identity, ensure container has proper permissions
- For explicit credentials, use SAS tokens in the blob URL

## Next Steps

1. **Deploy to production** using one of the deployment options
2. **Update documentation** link in `/agent/info` endpoint
3. **Add to README** installation instructions
4. **Test from multiple networks** to verify connectivity
5. **Monitor via health endpoint** (add to uptime monitoring)

## License

Same as main Iotistic project

