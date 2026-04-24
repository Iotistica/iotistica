# Dashboard API Configuration Guide

## Overview

The dashboard web application needs to communicate with the API service. The API endpoint configuration is flexible to support both local development and Kubernetes deployments.

## Architecture

### Local Development
- **Dashboard**: `http://localhost:3000` (Vite dev server)
- **API**: `http://localhost:4002` (Node.js server)
- Dashboard directly calls API at `localhost:4002`

### Kubernetes Deployment
- **Ingress**: Single domain (e.g., `customer-xyz.iotistic.local`)
- **Dashboard**: Root path `/` → Dashboard service
- **API**: Path `/api` → API service
- Dashboard uses **relative path** `/api` (same origin)

## Configuration Methods

### Method 1: Automatic Detection (Recommended)

The dashboard automatically detects the environment and uses appropriate defaults:

```typescript
// src/config/api.ts
export function getApiUrl(): string {
  // Production (K8s): Use current origin (relative path)
  if (import.meta.env.PROD) {
    return window.location.origin; // https://customer-xyz.iotistic.local
  }
  
  // Development: Use localhost
  return 'http://localhost:4002';
}
```

**When to use**: All standard deployments

**No configuration required!** ✅

### Method 2: Environment Variable Override

Set `VITE_API_URL` to override the automatic detection:

#### Local Development (.env file)
```bash
# .env.local
VITE_API_URL=http://localhost:4002
```

#### Kubernetes (Helm values.yaml)
```yaml
dashboard:
  apiUrl: "https://api.example.com"  # Custom API URL
```

**When to use**:
- Custom API domain (not on same ingress)
- Testing against remote API
- Multi-region deployments

### Method 3: Build-Time Injection

For production builds, the API URL is baked into the compiled JavaScript:

```dockerfile
# Dockerfile
ARG VITE_API_URL=""
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build
```

```bash
# Build with custom API URL
docker build --build-arg VITE_API_URL=https://api.example.com -t dashboard .
```

**When to use**:
- Pre-built images for specific environments
- Immutable deployments
- CDN-hosted dashboards

## Usage in Components

All components should use the centralized configuration:

```typescript
import { buildApiUrl } from '@/config/api';

// Fetch MQTT stats
const response = await fetch(buildApiUrl('/api/v1/mqtt-monitor/stats'));

// Fetch device processes
const response = await fetch(buildApiUrl(`/api/v1/devices/${deviceId}/processes`));
```

**❌ Don't do this:**
```typescript
// Hard-coded localhost - breaks in K8s!
const response = await fetch('http://localhost:4002/api/v1/mqtt-monitor/stats');
```

**✅ Do this:**
```typescript
// Flexible configuration - works everywhere!
const response = await fetch(buildApiUrl('/api/v1/mqtt-monitor/stats'));
```

## Deployment Scenarios

### Scenario 1: Local Development (Default)
```bash
cd dashboard
npm install
npm run dev  # Starts on localhost:3000
```
**API URL**: `http://localhost:4002` (automatic)

### Scenario 2: Local Development with Remote API
```bash
# .env.local
VITE_API_URL=https://api.staging.iotistic.ca

npm run dev
```
**API URL**: `https://api.staging.iotistic.ca` (override)

### Scenario 3: Kubernetes with Shared Ingress (Standard)
```yaml
# Helm values.yaml
ingress:
  enabled: true
  rules:
    - host: customer-abc.iotistic.local
      paths:
        - path: /
          backend: dashboard
        - path: /api
          backend: api

dashboard:
  apiUrl: ""  # Empty = use automatic detection
```
**API URL**: `https://customer-abc.iotistic.local` (automatic, uses relative `/api` path)

### Scenario 4: Kubernetes with Separate API Domain
```yaml
# Helm values.yaml
dashboard:
  apiUrl: "https://api-customer-abc.iotistic.ca"
```
**API URL**: `https://api-customer-abc.iotistic.ca` (explicit override)

### Scenario 5: Pre-Built Image for Specific Environment
```bash
# Build for production
docker build \
  --build-arg VITE_API_URL=https://api.production.iotistic.ca \
  -t iotistic/dashboard:production \
  .
```
**API URL**: `https://api.production.iotistic.ca` (baked into build)

## Debugging

### Check Current Configuration

Add this to any component:
```typescript
import { apiConfig } from '@/config/api';

console.log('API Configuration:', apiConfig);
// Output:
// {
//   baseUrl: "http://localhost:4002",
//   isDevelopment: true,
//   isProduction: false,
//   envApiUrl: undefined
// }
```

### Browser Developer Tools

Open browser console (F12):
```javascript
// Check what the dashboard thinks the API URL is
console.log('API URL:', window.location.origin);

// Test API connectivity
fetch('/api/v1/mqtt-monitor/stats')
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);
```

### Network Tab

1. Open Developer Tools → Network tab
2. Trigger an API call (refresh dashboard)
3. Look for requests to `/api/v1/*`
4. Check:
   - **Request URL**: Should match expected API endpoint
   - **Status**: Should be 200 (not 404 or CORS error)
   - **Response**: Should contain valid JSON

### Common Issues

#### Issue: "CORS error" in browser console
**Cause**: Dashboard trying to access API on different domain without CORS headers

**Fix**:
- **K8s**: Ensure dashboard and API share same ingress (recommended)
- **Local**: Set `VITE_API_URL=http://localhost:4002` in `.env.local`
- **API**: Add CORS headers if cross-origin access is required

#### Issue: "404 Not Found" for `/api/*` requests
**Cause**: Ingress routing not configured

**Fix**: Update Helm chart `ingress.yaml`:
```yaml
paths:
  - path: /
    backend: dashboard
  - path: /api      # ← Add this!
    backend: api
```

#### Issue: Dashboard shows "localhost:4002" in production
**Cause**: Build in development mode (`npm run build` with `NODE_ENV=development`)

**Fix**: Ensure production build:
```bash
NODE_ENV=production npm run build
# or
docker build .  # Dockerfile sets NODE_ENV=production
```

## Environment Variables Reference

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VITE_API_URL` | string | (auto-detect) | Override API base URL |
| `NODE_ENV` | string | `development` | Build mode (`development` or `production`) |

## Migration Guide

If you have existing components with hardcoded `localhost:4002`:

1. **Import the config utility**:
   ```typescript
   import { buildApiUrl } from '@/config/api';
   ```

2. **Replace hardcoded URLs**:
   ```typescript
   // Before
   fetch('http://localhost:4002/api/v1/mqtt-monitor/stats')
   
   // After
   fetch(buildApiUrl('/api/v1/mqtt-monitor/stats'))
   ```

3. **Test both environments**:
   ```bash
   # Local dev
   npm run dev
   
   # Production build
   npm run build && npm run preview
   ```

## Testing

### Test Local Development
```bash
cd dashboard
npm run dev
# Dashboard: http://localhost:3000
# API: http://localhost:4002 (must be running separately)
```

### Test Production Build
```bash
cd dashboard
npm run build
npx serve -s build -l 3000
# Dashboard: http://localhost:3000
# Should use same-origin API calls
```

### Test Kubernetes Deployment
```bash
# Deploy to K8s
helm install customer-test ./charts/customer-instance \
  --set customer.id=customer-test \
  --set domain.base=iotistic.local

# Check ingress
kubectl get ingress

# Test API access
curl https://customer-test.iotistic.local/api/v1/mqtt-monitor/stats
```

## Best Practices

1. **Never hardcode API URLs** in components
2. **Always use `buildApiUrl()`** for API calls
3. **Use automatic detection** unless you have a specific reason to override
4. **Share ingress** for dashboard + API in K8s (simpler, no CORS issues)
5. **Test both dev and prod builds** before deploying
6. **Log API config** in development mode for debugging

## See Also

- [`src/config/api.ts`](../src/config/api.ts) - Configuration implementation
- [`vite.config.ts`](../vite.config.ts) - Vite environment variable handling
- [`Dockerfile`](../Dockerfile) - Build-time API URL injection
- [`charts/customer-instance/values.yaml`](../../charts/customer-instance/values.yaml) - Helm configuration
- [`charts/customer-instance/templates/ingress.yaml`](../../charts/customer-instance/templates/ingress.yaml) - K8s ingress routing
