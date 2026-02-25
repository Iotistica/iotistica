# Iotistic IoT Platform

A comprehensive multi-tenant SaaS IoT platform combining edge device management with cloud-based Kubernetes deployment, featuring real-time monitoring, Digital Twin visualization, and flexible device apps orchestration and configuration.



## Features

### Multi-Tenant SaaS Architecture
- **Kubernetes Deployment** - Isolated customer namespaces with automated provisioning
- **Stripe Billing Integration** - Subscription management with 14-day trials
- **JWT License Validation** - RS256-signed licenses with feature gating
- **Plan-Based Features** - Starter, Professional, Enterprise tiers
- **Usage Metering** - Prometheus metrics collection for billing
- **Automated Deployment** - Self-signup triggers K8s namespace creation
- **Web Dashboard** - React + TypeScript interface
- **Websockets** - Real-time dashboard updates with Redid Pub/Sub and Streams


![Device HTTP and MQTT Trafiic Monitor ](docs/images/traffic_monitor.JPG)

![API Usage](docs/images/api_usage.JPG)


### Security
- **JWT Authentication** - RS256-signed JSON Web Tokens for API authentication and license validation
- **Role-Based Access Control (RBAC)** - User roles with granular permissions (Admin, User, Viewer)
- **MQTT ACL Management** - PostgreSQL-backed topic access control with read/write permissions
- **Multi-Tenant Isolation** - Kubernetes namespace segregation and network policies
- **Certificate-Based VPN** - PKI infrastructure with device certificates and revocation support
- **API Key Rotation** - Automated key rotation with configurable expiration policies
- **License Feature Gating** - Plan-based feature access controlled via JWT claims
- **Password Hashing** - Bcrypt-based secure password storage
- **Session Management** - Redis-backed session store with configurable TTL

![Security](docs/images/security.JPG)

### Edge Device Management  
- **Container Orchestration** - Agent supports Docker Compose and K3s
- **Declarative State** - Target state JSON with automatic reconciliation
- **Container State Control** - Running/stopped/paused states
- **Device API** - REST API on port 48484 for local management
- **Multi-Platform** - Raspberry Pi (arm64, armv7l), x86_64 support
- **Cloud Sync** - Pull-based configuration updates
- **VPN Tunnel** - VPN tunnel for secure access

![System Metrics Dashboard](docs/images/system_metrics.JPG)

### Digital Twin
- **Graph Database** - Neo4j integration for spatial relationships
- **IFC File Support** - Import building information models
- **3D Visualization** - Force-directed graph with device mapping
- **Device-Space Mapping** - Link IoT devices to physical locations

![Digital Twin Graph Model](docs/images/digital_twin_graph.JPG)

### Monitoring
- **MQTT Broker** - MQTT Broker Topics and Statistics
- **Real-Time Metrics** - Redis Streams for live data
- **Monitoring** - Shared or dedicated Prometheus based on plan, Grafana dashboards
- **Remote Logging** - View real-time logs from all devices

![MQTT Explorer ](docs/images/mqtt.JPG)

## Table of Contents

- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Service Architecture](#service-architecture)
- [Configuration](#configuration)
- [Development](#development)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)
- [Support](#support)
- [License](#license)

## Architecture

### Two Deployment Models

## Architecture

### Two Deployment Models

#### 1. Edge Device Stack
Single-tenant deployment on customer hardware:

**Services:**
- Agent - Container orchestrator (Docker/K3s)
- API - Device management REST API  
- Dashboard - React web interface
- Mosquitto - MQTT broker
- PostgreSQL - Primary database
- Neo4j - Graph database for Digital Twin
- VPN Client - OpenVPN tunnel to cloud

#### 2. Multi-Tenant SaaS (Kubernetes)
Cloud-hosted with isolated customer namespaces:

```
┌─────────────────────────────────────────────────────────────────┐
│                     Kubernetes Cluster                          │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Global Namespace: billing                                │  │
│  │                                                          │  │
│  │  ┌────────────────┐    ┌──────────────────┐            │  │
│  │  │ Billing API    │    │  PostgreSQL      │            │  │
│  │  │ (Port 3100)    │───▶│  (Managed/RDS)   │            │  │
│  │  │                │    │                  │            │  │
│  │  │ - Stripe       │    │ - Customer data  │            │  │
│  │  │ - K8s deploy   │    │ - Subscriptions  │            │  │
│  │  │ - License gen  │    │ - Usage tracking │            │  │
│  │  └────────────────┘    └──────────────────┘            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Global Namespace: vpn-server                             │  │
│  │                                                          │  │
│  │  ┌────────────────┐    ┌──────────────────┐            │  │
│  │  │ OpenVPN Server │    │  Certificate     │            │  │
│  │  │ (Port 1194)    │───▶│  Manager API     │            │  │
│  │  │                │    │  (Port 8080)     │            │  │
│  │  │ - Device auth  │    │                  │            │  │
│  │  │ - VPN routing  │    │ - PKI management │            │  │
│  │  │ - 10.8.0.0/24  │    │ - Cert issuance  │            │  │
│  │  └────────────────┘    └──────────────────┘            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ Customer Namespace: customer-{id}                        │  │
│  │                                                          │  │
│  │  ┌────────────┐  ┌───────────┐  ┌──────────────────┐   │  │
│  │  │ API        │  │ Dashboard │  │  PostgreSQL      │   │  │
│  │  │ (Port 3002)│  │(Port 3000)│  │  (Dedicated)     │   │  │
│  │  │            │  │           │  │                  │   │  │
│  │  │ - Devices  │  │ - React   │  │ - Device shadow  │   │  │
│  │  │ - MQTT ACL │  │ - Digital │  │ - MQTT ACLs      │   │  │
│  │  │ - Neo4j    │──┤   Twin    │  │ - Metrics        │   │  │
│  │  └────────────┘  └───────────┘  └──────────────────┘   │  │
│  │         │              │                  │             │  │
│  │         │              │                  │             │  │
│  │  ┌──────▼──────┐  ┌───▼─────────────────▼──────────┐   │  │
│  │  │ Mosquitto   │  │        Redis                   │   │  │
│  │  │ (Port 1883) │  │     (Port 6379)                │   │  │
│  │  │             │  │                                │   │  │
│  │  │ - MQTT      │  │  - Real-time metrics          │   │  │
│  │  │   broker    │  │  - Deployment queue (Bull)    │   │  │
│  │  │ - Auth via  │  │  - Caching                    │   │  │
│  │  │   PostgreSQL│  │                                │   │  │
│  │  └─────────────┘  └────────────────────────────────┘   │  │
│  │         │                                               │  │
│  │  ┌──────▼───────────────┐     ┌────────────────────┐   │  │
│  │  │ Billing Exporter     │     │ Prometheus         │   │  │
│  │  │ (Metrics collector)  │────▶│ (Shared/Dedicated) │   │  │
│  │  │                      │     │                    │   │  │
│  │  │ - Device count       │     │ - Time-series DB   │   │  │
│  │  │ - MQTT messages      │     │ - Metrics storage  │   │  │
│  │  │ - Storage usage      │     │                    │   │  │
│  │  └──────────────────────┘     └────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                           ▲                                    │
│                           │                                    │
│                    VPN Tunnel (10.8.0.x)                       │
│                           │                                    │
└───────────────────────────┼────────────────────────────────────┘
                            │
                    ┌───────▼────────┐
                    │  Edge Devices  │
                    │                │
                    │ - Agent        │
                    │ - VPN Client   │
                    │ - Local API    │
                    └────────────────┘
```

**Architecture Highlights:**
- **Billing Namespace**: Global billing service with managed PostgreSQL (AWS RDS/Cloud SQL)
- **VPN Namespace**: Centralized OpenVPN server and certificate management
- **Customer Namespaces**: Isolated per-customer with API, Dashboard, PostgreSQL, Mosquitto, Redis
- **Shared Prometheus**: Starter/Professional plans (in monitoring namespace)
- **Dedicated Prometheus**: Enterprise plan (in customer namespace)
- **VPN Connectivity**: Devices connect via OpenVPN to access customer namespace services


## Quick Start

### Option 1: Automated Installation (Edge)
```bash
curl -sSL https://raw.githubusercontent.com/Iotistica/iotistic/master/bin/install.sh | bash
```

The installer will:
- Detect device architecture (arm64, armv7l, x86_64)
- Prompt for provisioning API key (first-time setup)
- Configure cloud endpoint
- Deploy Docker Compose stack
- Start all services
- ✅ Configure the system
- ✅ Deploy all services
- ✅ Set up vpn tunnel 
- ✅ Configure networking

### Option 2: Manual Installation

1. **Clone the repository**:
```bash
git clone https://github.com/Iotistica/iotistic.git
cd iotistic
```

2. **Run the installer**:
```bash
chmod +x bin/install.sh
./bin/install.sh
```

3. **Follow the interactive prompts** to configure your installation


### Option 2: Local Development
```bash
# Clone repository
git clone https://github.com/Iotistica/iotistic.git
cd iotistic

# Start development stack (build)
docker-compose -f docker-compose.yml up -d

# Start development stack (pull)
docker-compose -f docker-compose.dev.yml up -d

```

### Option 3: Kubernetes Deployment
```bash
# Install billing service
helm install billing ./charts/billing --namespace billing --create-namespace

# Customer signup creates namespace automatically
curl -X POST https://billing.iotistic.cloud/api/customers/signup \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "company": "ACME Corp", "plan": "starter"}'
```

See [K8S Deployment Guide](docs/K8S-DEPLOYMENT-GUIDE.md) for complete setup.

## Service Architecture

### API Service (`api/`)
**Port:** 3002 (internal), 4002 (external)

**Key Features:**
- Device management (CRUD, bulk operations)
- MQTT ACL management via PostgreSQL
- Digital Twin graph operations (Neo4j)
- License validation middleware
- Real-time metrics (Redis Streams)
- VPN certificate management

**Environment Variables:**
```bash
DB_HOST=postgres
DB_PORT=5432
MQTT_BROKER_URL=mqtt://mosquitto:1883
NEO4J_URI=bolt://neo4j:7687
LICENSE_PUBLIC_KEY=<RSA public key>
IOTISTIC_LICENSE_KEY=<JWT token>
```

### Agent Service (`agent/`)
**Port:** 48484 (Device API)

**Capabilities:**
- Container orchestration (Docker/K3s)
- Target state reconciliation
- Container state management (running/stopped/paused)
- Device provisioning
- Cloud API synchronization

**Container State Control:**
```json
{
  "services": [{
    "serviceName": "nodered",
    "state": "paused",
    "config": {
      "ports": ["1880:1880"],
      "volumes": ["nodered-data:/data"]
    }
  }]
}
```

### Dashboard (`dashboard/`)
**Port:** 3000

**Pages:**
- Devices - Device list and management
- Digital Twin - Graph visualization and device mapping
- Metrics - Real-time monitoring

**Tech Stack:** React 18 + TypeScript + Vite + Material-UI

### Billing Service (`billing/`)
**Port:** 3100

**Features:**
- Stripe checkout integration
- Customer lifecycle management  
- Kubernetes namespace deployment via Helm
- RS256 JWT license generation
- Deployment queue with Bull + Redis

**Plans:**
- **Starter** - 10 devices, shared Prometheus, 30-day retention
- **Professional** - 50 devices, shared Prometheus, 90-day retention  
- **Enterprise** - Unlimited devices, dedicated Prometheus + Grafana

## Configuration



### Database Schema

**PostgreSQL Tables:**
- `devices` - Device registry with shadow state
- `mqtt_acls` - MQTT topic access control
- `device_tags` - Flexible key-value device metadata
- `metrics` - Time-series data storage
- `vpn_certificates` - VPN CA/cert management

**Neo4j Graph:**
- Device nodes
- Space nodes (from IFC files)
- Relationships: LOCATED_IN, CONTAINS, MONITORS

### Multi-Tenant Settings
```yaml
# Customer namespace: customer-{12-char-hash}
# Example: customer-a3f5c8d9e2b1 (SHA256 hash of customer ID)
# Helm chart: charts/customer-instance/
# License JWT contains:
{
  "customerId": "cust_...",
  "plan": "starter",
  "features": {
    "maxDevices": 10,
    "hasDedicatedPrometheus": false
  }
}
```

## 📊 Usage

### Accessing Services

After installation, access your services at:

| Service | URL | Description |
|---------|-----|-------------|
| **Dashboard** | `http://<pi-ip>/dashboard/kiosk` | Full-screen monitoring dashboard |
| **Grafana** | `http://<pi-ip>:3000` | Data visualization (admin/admin) |
| **Node-RED** | `http://<pi-ip>:1880` | Flow programming interface |
| **InfluxDB** | `http://<pi-ip>:8086` | Database management |
| **Admin Panel** | `http://<pi-ip>:51850` | System management |

### Default Credentials

- **Grafana**: `admin` / `admin` (change on first login)
- **InfluxDB**: Setup wizard on first access

### MQTT Topics

- **Temperature Data**: `sensor/temperature`
- **Humidity Data**: `sensor/humidity`
- **Pressure Data**: `sensor/pressure`
- **Gas/Air Quality**: `sensor/gas`
- **System Status**: `system/status`
- **Alerts**: `alerts/environmental`

### Environmental Monitoring

The system automatically:
1. **Reads** environmental data from BME688 sensor every second (temperature, humidity, pressure, gas resistance)
2. **Publishes** data to MQTT broker on separate topics
3. **Stores** historical data in InfluxDB
4. **Visualizes** real-time and historical data in Grafana
5. **Triggers** alerts based on configured thresholds for air quality and environmental conditions

## Remote Device Access

The system uses an OpenVPN-based architecture for secure cloud-to-device connectivity, similar to Balena's VPN infrastructure.

### Why VPN?

- ✅ **Secure Tunneling**: Certificate-based authentication for each device
- ✅ **NAT Traversal**: Works through firewalls and NAT without port forwarding
- ✅ **Customer Isolation**: Network segmentation per customer namespace
- ✅ **Certificate Management**: PKI infrastructure with revocation support
- ✅ **Fleet Management**: Scalable for thousands of devices
- ✅ **Auto-Reconnect**: Automatic reconnection on network interruptions

### Architecture

```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Cloud API     │    │   VPN Gateway    │    │   Device Fleet  │
│                 │    │                  │    │                 │
│ ┌─────────────┐ │    │ ┌──────────────┐ │    │ ┌─────────────┐ │
│ │ Billing     │ │    │ │  OpenVPN     │ │    │ │   Device A  │ │
│ │ Service     │ │    │ │  Server      │ │    │ │             │ │
│ └─────────────┘ │    │ │              │ │    │ │ ┌─────────┐ │ │
│                 │    │ │ Port 1194    │ │    │ │ │ OpenVPN │ │ │
│ ┌─────────────┐ │    │ │              │ │◄───┼─┤ │ Client  │ │ │
│ │ Customer    │◄┼────┼─┤ Device       │ │    │ │ └─────────┘ │ │
│ │ Dashboard   │ │    │ │ Registry     │ │    │ │             │ │
│ └─────────────┘ │    │ │              │ │    │ │ Agent API   │ │
│                 │    │ └──────────────┘ │    │ │ :48484      │ │
└─────────────────┘    └──────────────────┘    │ └─────────────┘ │
                       VPN: 10.8.0.0/24        └─────────────────┘
```

Each device gets:
- Unique VPN IP address (e.g., `10.8.0.10`)
- Client certificate and private key
- Secure tunnel to cloud API

### VPN Server Setup (Cloud/K8s)

**Deploy VPN Server:**
```bash
cd vpn-server

# Initialize PKI (Certificate Authority)
./scripts/init-pki.sh

# Start VPN server
docker-compose up -d

# Or deploy to Kubernetes
kubectl apply -f k8s/
```

**VPN Server Configuration:**
```bash
# Environment variables (vpn-server/.env)
VPN_ENABLED=true
VPN_SERVER_HOST=vpn.iotistic.cloud
VPN_SERVER_PORT=1194
VPN_SUBNET=10.8.0.0
VPN_NETMASK=255.255.255.0
```

### Device VPN Client Setup

**Option 1: During Installation (Recommended)**

When running `bin/install.sh`, you'll be prompted:
```
╔═══════════════════════════════════════════════════════════╗
║     VPN Configuration Setup                                ║
╚═══════════════════════════════════════════════════════════╝

? Enable VPN connection to cloud? (y/N)
```

If you choose "Yes":
1. Enter VPN server hostname (e.g., `vpn.iotistic.cloud`)
2. Enter VPN server port (default: `1194`)
3. Provide device certificate URL or paste certificate content
4. VPN client will be configured and started automatically

**Option 2: Manual Configuration**

1. **Generate device certificate on VPN server**:
```bash
cd vpn-server
./scripts/generate-client.sh device-001 customer-abc123
```

This creates:
- `device-001.crt` - Client certificate
- `device-001.key` - Private key
- `device-001.ovpn` - Complete OpenVPN config

2. **Transfer certificate to device**:
```bash
# Download from certificate manager API
curl https://vpn.iotistic.cloud/api/certificates/device-001.ovpn > /home/pi/iotistic/vpn/device.ovpn

# Or use the web interface
# Dashboard → Devices → device-001 → Download VPN Config
```

3. **Configure device**:
```bash
# Add to .env
VPN_ENABLED=true
VPN_SERVER_HOST=vpn.iotistic.cloud
VPN_SERVER_PORT=1194
VPN_CA_URL=https://vpn.iotistic.cloud/api/ca.crt
VPN_CONFIG_PATH=/app/vpn/device.ovpn
```

4. **Restart services**:
```bash
docker-compose restart agent
```

### Environment Variables

**VPN Server** (`vpn-server/.env`):
| Variable | Default | Description |
|----------|---------|-------------|
| `VPN_SERVER_HOST` | - | Public hostname/IP of VPN server |
| `VPN_SERVER_PORT` | `1194` | OpenVPN server port (UDP) |
| `VPN_SUBNET` | `10.8.0.0` | VPN subnet |
| `VPN_NETMASK` | `255.255.255.0` | VPN netmask |
| `DB_HOST` | `postgres` | Database for device registry |
| `CA_CERT_PATH` | `/etc/openvpn/pki/ca.crt` | CA certificate |

**Device Agent** (`.env`):
| Variable | Default | Description |
|----------|---------|-------------|
| `VPN_ENABLED` | `false` | Enable VPN client |
| `VPN_SERVER_HOST` | - | VPN server hostname (required) |
| `VPN_SERVER_PORT` | `1194` | VPN server port |
| `VPN_CA_URL` | - | URL to download CA certificate |
| `VPN_CONFIG_PATH` | `/app/vpn/device.ovpn` | Path to OpenVPN config |
| `VPN_AUTO_RECONNECT` | `true` | Auto-reconnect on disconnect |

### Verify Connection

**From Cloud API:**
```bash
# Check device registry
curl https://vpn.iotistic.cloud/api/devices

# Access device via VPN IP
curl http://10.8.0.10:48484/v2/device

# View device status
curl https://api.iotistic.cloud/api/devices/device-001
```

**From Device:**
```bash
# Check VPN status
docker-compose logs vpn-client

# Test connectivity to cloud
ping 10.8.0.1  # VPN server
curl http://10.8.0.1:3002/health  # Cloud API via VPN
```

### Certificate Management

**Generate new certificate:**
```bash
cd vpn-server
./scripts/generate-client.sh <device-id> <customer-id>
```

**Revoke compromised certificate:**
```bash
./scripts/revoke-client.sh <device-id>

# Restart VPN server to apply CRL
docker-compose restart vpn-server
```

**List active connections:**
```bash
docker exec vpn-server cat /var/log/openvpn/status.log
```

### Multi-Device Fleet Management

Each customer namespace can have multiple devices:

```bash
# Generate certificates for fleet
./scripts/generate-client.sh device-001 customer-abc123
./scripts/generate-client.sh device-002 customer-abc123
./scripts/generate-client.sh device-003 customer-abc123
```

VPN IP allocation:
- `10.8.0.1` - VPN server
- `10.8.0.10-20` - Customer ABC123 devices
- `10.8.0.21-30` - Customer XYZ456 devices
- etc.

### Monitoring

**Check VPN connection status:**
```bash
# On device
docker-compose logs -f vpn-client

# Expected output
Initialization Sequence Completed
Connection established successfully
```

**View connected devices (VPN server):**
```bash
# Check status log
docker exec vpn-server cat /var/log/openvpn/status.log

# API endpoint
curl https://vpn.iotistic.cloud/api/devices/connected
```

**Connection metrics:**
```bash
# Prometheus metrics endpoint
curl http://vpn.iotistic.cloud:9090/metrics

# Key metrics:
# - vpn_connected_devices
# - vpn_bytes_in/vpn_bytes_out
# - vpn_connection_errors
```

### Troubleshooting

**VPN connection fails:**
- Verify VPN server is reachable: `ping vpn.iotistic.cloud`
- Check certificate validity: `openssl x509 -in device.crt -noout -dates`
- Test UDP port: `nc -u vpn.iotistic.cloud 1194`
- Check firewall rules on device and server

**Certificate errors:**
- Ensure CA certificate matches server CA
- Verify certificate not expired or revoked
- Check certificate permissions: `chmod 600 device.key`

**Connection drops frequently:**
- Check network stability
- Verify `VPN_AUTO_RECONNECT=true` in `.env`
- Increase keepalive intervals in OpenVPN config

**Can't access device via VPN:**
- Verify device VPN IP: `ip addr show tun0`
- Check routing table: `route -n`
- Test from VPN server: `ping 10.8.0.10`
- Ensure device firewall allows VPN subnet

For more details, see [`vpn-server/README.md`](vpn-server/README.md) and [`vpn-server/VPN-LOCAL-TEST-GUIDE.md`](vpn-server/VPN-LOCAL-TEST-GUIDE.md).

## �🛠️ Development

### Project Structure

```
iotistic/
├── agent/                 # Edge device container orchestrator
│   ├── src/
│   │   ├── compose/       # Docker Compose orchestration
│   │   ├── k3s/           # K3s Kubernetes orchestration
│   │   ├── device-api/    # REST API (port 48484)
│   │   └── orchestrator/  # State reconciliation logic
│   └── data/              # SQLite database, logs
├── api/                   # Cloud/device management API
│   ├── src/
│   │   ├── routes/        # REST endpoints
│   │   ├── services/      # Neo4j, MQTT, VPN
│   │   ├── middleware/    # License validation, auth
│   │   └── db/            # PostgreSQL connection
│   └── database/migrations/
├── dashboard/             # React web interface
│   ├── src/
│   │   ├── pages/         # Devices, Digital Twin
│   │   ├── components/    # Graph visualization, device mapping
│   │   └── utils/         # IFC parser, helpers
│   └── build/             # Production build (gitignored)
├── billing/               # Multi-tenant SaaS billing service
│   ├── src/
│   │   ├── services/      # K8s deployment, license generation
│   │   ├── workers/       # Bull queue for async deployments
│   │   └── routes/        # Customer signup, webhooks
│   ├── keys/              # RSA keys for JWT signing
│   └── migrations/        # Customer/subscription schema
├── billing-exporter/      # Prometheus metrics collector
│   └── src/collectors/    # Device, MQTT, storage metrics
├── charts/                # Helm charts for K8s deployment
│   ├── customer-instance/ # Per-customer namespace chart
│   ├── billing/           # Global billing service chart
│   └── docs/              # K8s setup guides
├── ansible/               # Deployment automation
│   ├── roles/
│   │   ├── system/        # System configuration
│   │   ├── network/       # Network setup
│   │   └── docker/        # Docker installation
│   └── run.sh             # Deployment script
├── docs/                  # Comprehensive documentation
│   ├── K8S-DEPLOYMENT-GUIDE.md
│   ├── CUSTOMER-SIGNUP-K8S-DEPLOYMENT.md
│   ├── provisioning/      # Device provisioning guides
│   ├── mqtt/              # MQTT architecture docs
│   └── database/          # PostgreSQL optimization
├── argocd/                # GitOps continuous deployment
│   ├── customers/         # Per-customer app configs
│   └── shared/            # Shared infrastructure
├── vpn-server/            # OpenVPN server for device connectivity
│   ├── src/               # Certificate manager, device registry
│   ├── config/            # OpenVPN server configuration
│   ├── scripts/           # PKI initialization, cert generation
│   ├── k8s/               # Kubernetes deployment manifests
│   └── web/               # Web interface for cert management
├── mosquitto/             # MQTT broker configuration
│   ├── mosquitto.conf     # PostgreSQL ACL integration
│   └── data/              # Persistence (gitignored)
├── postgres/              # PostgreSQL configuration
│   ├── pg_hba.conf        # Client authentication
│   └── data/              # Database files (gitignored)
├── sensor-simulator/      # Generic MQTT sensor simulator
│   └── src/               # Configurable test data generator
├── bin/                   # Installation and setup scripts
│   ├── install.sh         # Main installer
│   └── setup-remote-access.sh
├── docker-compose.yml     # Production stack
├── docker-compose.dev.yml # Development stack
└── .github/
    └── copilot-instructions.md  # AI coding guidelines
```

### Local Development Setup

**Start core services:**
```bash
# Start PostgreSQL, Mosquitto, Redis, Neo4j
docker-compose up -d postgres mosquitto redis neo4j

# Start API (Node.js)
cd api && npm install && npm run dev

# Start Dashboard (React)
cd dashboard && npm install && npm run dev

# Start Agent (for testing orchestration)
cd agent && npm install && npm run dev
```

**Important Docker Compose Commands:**
```bash
# Rebuild and restart a service (after code changes)
docker-compose up -d --build api

# Restart without rebuilding (faster, but doesn't apply code changes)
docker-compose restart api

# View logs
docker-compose logs -f api

# Stop and remove containers
docker-compose down
```

> **⚠️ Note:** `docker-compose restart` does NOT rebuild the image - it only restarts the container with the existing image. Always use `docker-compose up -d --build <service>` after making code changes to ensure they are applied.

**Access services:**
- API: http://localhost:4002
- Dashboard: http://localhost:3000  
- Agent Device API: http://localhost:48484
- PostgreSQL: localhost:5432
- Mosquitto MQTT: localhost:5883
- Neo4j Browser: http://localhost:7474

### Testing with Sensor Simulator

For testing MQTT data flows without physical hardware:

```bash
# Start simulator (publishes to MQTT)
docker-compose -f docker-compose.simulator.yml up -d

# Configure simulator
echo "NUM_SENSORS=5" >> .env
echo "PUBLISH_INTERVAL_MS=10000" >> .env

# View simulated data
docker-compose logs -f sensor-simulator
```

The simulator publishes generic sensor data to configurable MQTT topics.

### Debugging and Logs

**View service logs:**
```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f api
docker-compose logs -f mosquitto
docker-compose logs -f agent

# Application logs (when running locally)
tail -f api/logs/app.log
tail -f agent/logs/orchestrator.log
```

**Database debugging:**
```bash
# Connect to PostgreSQL
docker exec -it iotistic-postgres psql -U postgres -d iotistic

# View device state
SELECT * FROM devices LIMIT 10;

# Check MQTT ACLs
SELECT * FROM mqtt_acls;
```

### Performance Optimization

**For Raspberry Pi:**
- Use lightweight images (alpine variants)
- Limit Docker memory: `mem_limit: 512M` in docker-compose.yml
- Reduce PostgreSQL shared_buffers
- Disable unused services

**For Production:**
- Enable connection pooling (PostgreSQL, Redis)
- Use Redis for caching frequently accessed data
- Configure Prometheus retention based on plan
- Implement data retention policies

**Resource Limits Example:**
```yaml
# Add to docker-compose.yml services
deploy:
  resources:
    limits:
      memory: 512M
    reservations:
      memory: 256M
```

## Maintenance

### Regular Updates

```bash
# Update repository
cd ~/iotistic
git pull

# Update containers
docker-compose pull
docker-compose up -d

# Update dependencies (for local development)
cd api && npm install
cd ../dashboard && npm install
cd ../agent && npm install
```

### Backup Data

**PostgreSQL:**
```bash
# Backup database
docker exec iotistic-postgres pg_dump -U postgres iotistic > backup_$(date +%Y%m%d).sql

# Restore database
cat backup_20250107.sql | docker exec -i iotistic-postgres psql -U postgres -d iotistic
```

**Neo4j:**
```bash
# Backup Neo4j database
docker exec neo4j neo4j-admin dump --database=neo4j --to=/backups/neo4j_$(date +%Y%m%d).dump

# Restore
docker exec neo4j neo4j-admin load --from=/backups/neo4j_20250107.dump --database=neo4j --force
```

**Configuration:**
```bash
# Backup environment and configs
tar -czf config_backup_$(date +%Y%m%d).tar.gz .env docker-compose.yml postgres/pg_hba.conf mosquitto/mosquitto.conf
```

### Monitoring Health

```bash
# Check all services
docker-compose ps

# Monitor resource usage
docker stats

# Check disk space
df -h

# View API health
curl http://localhost:4002/health

# Check agent status
curl http://localhost:48484/v2/device
```

### Database Maintenance

```bash
# Vacuum PostgreSQL
docker exec -it iotistic-postgres psql -U postgres -d iotistic -c "VACUUM ANALYZE;"

# Check database size
docker exec -it iotistic-postgres psql -U postgres -d iotistic -c "SELECT pg_size_pretty(pg_database_size('iotistic'));"

# Clean old metrics (if needed)
docker exec -it iotistic-postgres psql -U postgres -d iotistic -c "DELETE FROM metrics WHERE timestamp < NOW() - INTERVAL '90 days';"
```

### Service Communication
Use container names for inter-service URLs:
```typescript
// Internal Docker networking
const mqttUrl = 'mqtt://mosquitto:1883';
const dbHost = 'postgres';
const apiUrl = 'http://api:3002';
```

### MQTT Topics
```
sensor/temperature
sensor/humidity
sensor/pressure
system/status
alerts/environmental
```

## Development

### Starting Services Locally
```powershell
# Start PostgreSQL
docker-compose up -d postgres

# Start API
cd api && npm run dev

# Start Dashboard
cd dashboard && npm run dev
```

### Database Migrations
```bash
# Create migration
cd api && npx knex migrate:make migration_name

# Run migrations
npx knex migrate:latest
```

## Deployment

### Kubernetes
See [K8S Deployment Guide](docs/K8S-DEPLOYMENT-GUIDE.md)

**Prerequisites:**
- Kubernetes cluster
- Helm 3+
- ServiceMonitor CRD installed
- Stripe account

### Edge Device (Ansible)
```bash
cd ansible && ./run.sh
```

## Troubleshooting

### License Validation Fails
```bash
# Verify keys
cd billing && npm run verify-keys

# Check JWT
echo $IOTISTIC_LICENSE_KEY | cut -d'.' -f2 | base64 -d | jq
```

### K8s Deployment Fails
```bash
# Install ServiceMonitor CRD
kubectl apply -f https://raw.githubusercontent.com/prometheus-operator/prometheus-operator/main/example/prometheus-operator-crd/monitoring.coreos.com_servicemonitors.yaml

# Check logs
kubectl logs -n billing deployment/billing-api
```

### MQTT Connection Issues
```bash
# Test connection
mosquitto_pub -h localhost -p 5883 -t test -m "hello"

# Check ACL
docker exec -it iotistic-postgres psql -U postgres -d iotistic \
  -c "SELECT * FROM mqtt_acls;"
```

## Documentation

- [Complete Implementation Guide](docs/COMPLETE-IMPLEMENTATION-GUIDE.md)
- [K8s Deployment Guide](docs/K8S-DEPLOYMENT-GUIDE.md)
- [Customer Signup Flow](docs/CUSTOMER-SIGNUP-K8S-DEPLOYMENT.md)
- [Helm Chart Documentation](charts/docs/README.md)
- [Billing System Guide](billing/docs/README.md)
- [Agent Documentation](agent/README.md)
- [API Documentation](api/README.md)

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/Iotistica/iotistic/issues)


## Version

Current version: **Latest** (rolling release from master branch)

For stable releases, check: [Releases](https://github.com/Iotistica/iotistic/releases)

---

**Built with:** Node.js, TypeScript, React, PostgreSQL, Neo4j, Mosquitto MQTT, Docker, Kubernetes, Helm, Stripe
         