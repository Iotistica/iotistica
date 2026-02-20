# Iotistic Unified API

Unified REST API server combining Grafana management, Docker control, system notifications, and cloud multi-device management for the Iotistic Sensor IoT system.

## Features

- **Grafana Management**: Control dashboards, alerts, and variablesdfff
- **Docker Management**: List and control containers
- **System Notifications**: Send desktop notifications
- **Cloud Multi-Device Management**: Manage multiple IoT devices from a central server

## Architecture

This API replaces and combines:
- Previous `api/index.js` (Grafana + Docker + Notifications)
- `agent/src/api/cloud-server.ts` (Multi-device cloud management)

Built with TypeScript, Express, and runs on port 3002 by default.

## Quick Start

### Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Or build and run
npm run build
npm start
```

### Docker

```bash
# Build
docker build -t Iotistic-api .

# Run
docker run -d \
  -p 3002:3002 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e GRAFANA_URL=http://grafana:3000 \
  -e GRAFANA_API_TOKEN=your_token_here \
  --name Iotistic-api \
  Iotistic-api
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3002` | Server port |
| `GRAFANA_URL` | `http://grafana:3000` | Grafana server URL |
| `GRAFANA_API_TOKEN` | - | Grafana API token (required for Grafana endpoints) |
| `IOTISTIC_LICENSE_KEY` | - | License JWT for feature control (optional, runs in unlicensed mode if not set) |
| `LICENSE_PUBLIC_KEY` | - | RSA public key for license validation |
| `BILLING_API_URL` | - | Global billing API URL (for usage reporting) |
| `BILLING_UPGRADE_URL` | `https://iotistic.ca/upgrade` | Upgrade page URL (shown in feature-blocked errors) |
| `AI_PROVIDER` | `ollama` | AI backend selection (`ollama` or `openai`) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama base URL when using local models |
| `OLLAMA_MODEL` | `llama3.1` | Ollama model name to load |
| `OPENAI_API_KEY` | - | Required when `AI_PROVIDER=openai`; OpenAI API key |
| `OPENAI_BASE_URL` | - | Optional custom base URL (useful for Azure OpenAI) |
| `OPENAI_MODEL` | `gpt-4o-mini` | OpenAI model ID when OpenAI provider is enabled |

## API Endpoints

### General

- `GET /` - Health check
- `GET /api/docs` - API documentation

### Grafana Management

- `GET /grafana/dashboards` - List all dashboards
- `GET /grafana/alert-rules` - List all alert rules
- `POST /grafana/update-alert-threshold` - Update alert threshold
  ```json
  {
    "rule_uid": "alert_rule_uid",
    "new_threshold": 85
  }
  ```
- `GET /grafana/dashboards/:uid/variables` - Get dashboard variables
- `POST /grafana/dashboards/:uid/variables/:varName` - Update dashboard variable
  ```json
  {
    "value": "new_value"
  }
  ```

### Docker Management

- `GET /containers` - List all Docker containers
- `POST /containers/:id/restart` - Restart a container

### System Notifications

- `POST /notify` - Send desktop notification
  ```json
  {
    "title": "Alert Title",
    "message": "Alert message"
  }
  ```

### Cloud Multi-Device Management

#### Device Polling (for devices)

- `GET /api/v1/device/:uuid/state` - Device polls for target state (supports ETag caching)
- `POST /api/v1/device/:uuid/logs` - Device uploads logs (NDJSON, optional gzip)
- `PATCH /api/v1/device/state` - Device reports current state + metrics
  ```json
  {
    "device-uuid-1": {
      "apps": { "1001": {...} },
      "cpu_usage": 45.2,
      "memory_usage": 512,
      "memory_total": 1024,
      "temperature": 58.3,
      "uptime": 86400
    }
  }
  ```

#### Device Management (for admin UI)

- `GET /api/v1/devices` - List all registered devices
- `GET /api/v1/devices/:uuid` - Get specific device info
- `GET /api/v1/devices/:uuid/target-state` - Get device target state
- `POST /api/v1/devices/:uuid/target-state` - Set device target state
  ```json
  {
    "apps": {
      "1001": {
        "appId": 1001,
        "appName": "My App",
        "services": [...]
      }
    }
  }
  ```
- `GET /api/v1/devices/:uuid/current-state` - Get device current state
- `DELETE /api/v1/devices/:uuid/target-state` - Clear device target state (stop all apps)

#### License & Billing

- `GET /api/v1/license` - Get license information, feature flags, and usage limits
  ```json
  {
    "plan": "professional",
    "features": {
      "maxDevices": 50,
      "canExportData": true,
      "hasAdvancedAlerts": true
    },
    "usage": {
      "devices": {
        "current": 23,
        "max": 50,
        "percentUsed": 46
      }
    }
  }
  ```

## Examples

### Restart a Container

```bash
curl -X POST http://localhost:3002/containers/my-container/restart
```

### Update Grafana Alert Threshold

```bash
curl -X POST http://localhost:3002/grafana/update-alert-threshold \
  -H "Content-Type: application/json" \
  -d '{
    "rule_uid": "temperature_alert",
    "new_threshold": 85
  }'
```

### Set Target State for a Device

```bash
curl -X POST http://localhost:3002/api/v1/devices/abc-123-def/target-state \
  -H "Content-Type: application/json" \
  -d '{
    "apps": {
      "1001": {
        "appId": 1001,
        "appName": "Web Server",
        "services": [
          {
            "serviceId": 1,
            "serviceName": "nginx",
            "imageName": "nginx:latest",
            "config": {
              "image": "nginx:latest",
              "ports": ["80:80"]
            }
          }
        ]
      }
    }
  }'
```

### Device Polling Example

```bash
# Device polls for changes (ETag prevents unnecessary data transfer)
curl -H "If-None-Match: prev_etag_value" \
  http://localhost:3002/api/v1/device/abc-123-def/state
```

## Development

### Project Structure

```
api/
├── src/
│   ├── index.ts           # Main server
│   └── routes/
│       ├── grafana.ts     # Grafana endpoints
│       ├── docker.ts      # Docker endpoints
│       ├── notify.ts      # Notification endpoints
│       └── cloud.ts       # Cloud multi-device endpoints
├── dist/                  # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── Dockerfile
└── README.md
```

### Build

```bash
# Compile TypeScript
npm run build

# Watch mode (auto-rebuild on changes)
npm run watch

# Clean build artifacts
npm run clean
```

## Notes

- **Grafana endpoints** require `GRAFANA_API_TOKEN` environment variable
- **Docker endpoints** require `/var/run/docker.sock` volume mount
- **Cloud storage** uses in-memory Map (replace with database for production)
- **ETag caching** reduces bandwidth for device polling
- **Notification endpoint** uses `notify-send` (Linux only)

## Production Considerations

For cloud multi-device management in production:

1. Replace in-memory storage with a real database (PostgreSQL, MongoDB, etc.)
2. Add authentication/authorization
3. Implement device authentication (API keys, JWT, etc.)
4. Add rate limiting
5. Set up log persistence (currently logs are transient)
6. Consider using Redis for ETag caching
7. Add WebSocket support for real-time device updates
8. **Configure license key** for feature control and device limits

## License-Based Feature Control

This API includes license-based feature control for per-customer deployments:

- **License Validation**: JWT-based license keys validated with RSA public key
- **Feature Flags**: Control access to export, advanced alerts, custom branding, etc.
- **Device Limits**: Enforce max devices per plan (starter: 10, professional: 50, enterprise: unlimited)
- **Usage Tracking**: Report device count to global billing API (when enabled)
- **Unlicensed Mode**: Falls back to limited trial mode (3 devices, 7 days retention) if no license

**See**: `docs/LICENSE-FEATURE-CONTROL.md` for implementation details and `docs/BILLING-ARCHITECTURE-DECISION.md` for architecture rationale.

## License

See main project LICENSE file.
