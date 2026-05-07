# VPN Local Testing Guide - Windows Agent + Docker Desktop

This guide helps you test VPN connectivity with:
- **Windows Agent**: Running natively on Windows (not containerized)
- **VPN Server**: Running in Docker Desktop
- **Services**: MQTT, PostgreSQL, API in Docker Desktop

## Architecture

```
┌─────────────────────────────────────────────────┐
│ Windows Host (Your PC)                          │
│                                                  │
│  ┌────────────┐                                 │
│  │   Agent    │─────┐                           │
│  │ (Native)   │     │ VPN Tunnel                │
│  └────────────┘     │ to localhost:1194         │
│                     │                            │
│  ┌─────────────────▼──────────────────────────┐ │
│  │ Docker Desktop                              │ │
│  │                                             │ │
│  │  ┌──────────────┐  VPN creates tun0        │ │
│  │  │  VPN Server  │  IP: 10.8.0.1            │ │
│  │  │  172.25.0.20 │  Routes to 172.25.0.0/24 │ │
│  │  └───────┬──────┘                           │ │
│  │          │ iptables NAT                     │ │
│  │          ▼                                  │ │
│  │  ┌───────────────────────────────────┐     │ │
│  │  │ Docker Network: 172.25.0.0/24     │     │ │
│  │  │                                   │     │ │
│  │  │  • MQTT:     172.25.0.12:1883     │     │ │
│  │  │  • API:      172.25.0.13:3002     │     │ │
│  │  │  • Postgres: 172.25.0.10:5432     │     │ │
│  │  │  • Redis:    172.25.0.11:6379     │     │ │
│  │  └───────────────────────────────────┘     │ │
│  └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

## Traffic Flow

**After VPN Connection:**
```
Agent (Windows)
  ↓ Sends packet to 172.25.0.12:1883 (MQTT)
  ↓ 
tun0 interface (10.8.0.5 → 10.8.0.1)
  ↓
VPN Server Container (receives on tun0)
  ↓ iptables NAT masquerade
  ↓
Docker Bridge Network (172.25.0.0/24)
  ↓
Mosquitto Container (172.25.0.12)
```

## Prerequisites

### 1. Docker Desktop Running
```powershell
docker ps
# Should show Docker daemon is running
```

### 2. OpenVPN Client Installed on Windows
```powershell
# Download from: https://openvpn.net/community-downloads/
# Or install via Chocolatey:
choco install openvpn
```

### 3. Agent Built and Ready
```powershell
cd C:\Users\Dan\zemfyre-sensor\agent
npm install
npm run build
```

## Step-by-Step Test

### Step 1: Start Docker Services

```powershell
cd C:\Users\Dan\zemfyre-sensor

# Start all services (Postgres, Redis, MQTT, API, VPN)
docker-compose -f vpn-server\docker-compose.test-vpn.yml up -d

# Wait for services to be healthy (30-60 seconds)
docker-compose -f vpn-server\docker-compose.test-vpn.yml ps

# Check VPN server logs
docker logs iotistic-vpn-test -f
```

**Expected Output:**
```
✅ VPN Server is running
✅ PKI certificates generated
✅ Listening on 0.0.0.0:1194 (UDP)
✅ Management interface on 0.0.0.0:7505
✅ CA certificate server on 0.0.0.0:8080
```

### Step 2: Run Database Migration

```powershell
# Create vpn_config table
cd C:\Users\Dan\zemfyre-sensor\api
npm run migrate

# Or run migration inside container if API is containerized
docker exec iotistic-api-test npm run migrate
```

### Step 3: Provision a Test Device

```powershell
# Create provisioning key (if not exists)
curl -X POST http://localhost:3002/api/v1/provisioning-keys `
  -H "Content-Type: application/json" `
  -d '{
    "name": "Test VPN Key",
    "fleetId": 1,
    "maxUses": 10,
    "validDuration": 86400
  }'

# Save the returned key ID and secret

# Register a test device
$body = @{
    deviceUuid = "test-windows-agent-001"
    deviceName = "Windows Test Agent"
    deviceType = "windows-pc"
    provisioningKeyId = 1
    provisioningKeySecret = "<secret-from-above>"
} | ConvertTo-Json

curl -X POST http://localhost:3002/api/v1/agent/register `
  -H "Content-Type: application/json" `
  -d $body

# Save the response - it contains VPN credentials and .ovpn config
```

**Expected Response:**
```json
{
  "status": "ok",
  "device": { "uuid": "test-windows-agent-001", ... },
  "credentials": { ... },
  "vpn": {
    "enabled": true,
    "server_host": "localhost",
    "server_port": 1194,
    "credentials": {
      "username": "device-test-windows-agent-001",
      "password": "generated-password"
    },
    "config": "client\nremote localhost 1194\n...",
    "ca_cert": "-----BEGIN CERTIFICATE-----..."
  }
}
```

### Step 4: Save VPN Configuration

```powershell
# Create VPN config directory
mkdir C:\Users\Dan\openvpn-config -Force

# Save the .ovpn config from response
$vpnConfig | Out-File -FilePath "C:\Users\Dan\openvpn-config\iotistic-test.ovpn" -Encoding UTF8

# The config should already include:
# - remote localhost 1194 udp
# - ca certificate (inline)
# - auth-user-pass (credentials)
# - routes to Docker network (172.25.0.0/24)
```

### Step 5: Connect to VPN

```powershell
# Option 1: OpenVPN GUI (Recommended)
# 1. Right-click OpenVPN GUI in system tray
# 2. Click "Import" → "Import file..."
# 3. Select C:\Users\Dan\openvpn-config\iotistic-test.ovpn
# 4. Right-click profile → "Connect"

# Option 2: Command Line
cd "C:\Program Files\OpenVPN\bin"
.\openvpn.exe --config "C:\Users\Dan\openvpn-config\iotistic-test.ovpn"
```

**Expected Output:**
```
Initialization Sequence Completed
Peer Connection Initiated with [AF_INET]127.0.0.1:1194
Assigned IP: 10.8.0.5/16
Route added: 172.25.0.0/24 via 10.8.0.1
```

### Step 6: Verify VPN Connectivity

```powershell
# Check VPN interface
ipconfig
# Should show "OpenVPN TAP-Windows6" adapter with IP 10.8.0.5

# Test connectivity to Docker services via VPN tunnel
ping 172.25.0.20  # VPN server (should work)
ping 172.25.0.10  # Postgres (should work after routes are set)

# Test MQTT connection via VPN
# You can use MQTT Explorer or mosquitto_pub
mosquitto_pub -h 172.25.0.12 -p 1883 -t test -m "hello via vpn"
```

### Step 7: Configure Agent to Use VPN

Edit your agent configuration:

```json
// agent/data/device-config.json (or environment variables)
{
  "cloudApiEndpoint": "http://172.25.0.13:3002",
  "mqttBroker": "mqtt://172.25.0.12:1883",
  "mqttUsername": "device-test-windows-agent-001",
  "mqttPassword": "from-provisioning-response",
  "deviceUuid": "test-windows-agent-001"
}
```

Or use environment variables:
```powershell
$env:CLOUD_API_ENDPOINT = "http://172.25.0.13:3002"
$env:MQTT_BROKER = "mqtt://172.25.0.12:1883"
$env:MQTT_USERNAME = "device-test-windows-agent-001"
$env:MQTT_PASSWORD = "your-mqtt-password"
$env:DEVICE_UUID = "test-windows-agent-001"
```

### Step 8: Run Agent

```powershell
cd C:\Users\Dan\zemfyre-sensor\agent
npm start

# Or run in development mode
npm run dev
```

**Expected Logs:**
```
🌐 Agent starting...
✅ VPN Connected: 10.8.0.5
🔌 Connecting to MQTT: mqtt://172.25.0.12:1883
✅ MQTT Connected
📡 Connecting to API: http://172.25.0.13:3002
✅ API Connected
🚀 Agent ready
```

### Step 9: Verify Traffic Flow

```powershell
# Check MQTT messages
docker exec iotistic-mosquitto-test mosquitto_sub -t '#' -v

# Check API logs
docker logs iotistic-api-test -f

# Check VPN server logs (should show client connections)
docker logs iotistic-vpn-test -f
# Should show: "device-test-windows-agent-001 connected from 172.17.0.1"

# Check agent device state in database
docker exec iotistic-postgres-test psql -U postgres -d iotistic -c "SELECT uuid, last_seen_at, vpn_ip_address, is_online FROM devices WHERE uuid = 'test-windows-agent-001';"
```

**Expected Result:**
```
         uuid            |      last_seen_at       | vpn_ip_address | is_online
-------------------------+-------------------------+----------------+-----------
 test-windows-agent-001  | 2025-11-05 10:30:00     | 10.8.0.5       | t
```

## Troubleshooting

### Issue 1: VPN Server Not Starting

```powershell
# Check container logs
docker logs iotistic-vpn-test

# Common issues:
# - Port 1194 already in use
# - Insufficient privileges (needs NET_ADMIN capability)
# - Missing TUN/TAP device

# Fix: Make sure Docker Desktop is running in Windows subsystem for Linux 2 (WSL2)
docker info | Select-String -Pattern "Operating System"
```

### Issue 2: VPN Connects But Can't Reach Services

```powershell
# Check routes on Windows
route print
# Should see: 172.25.0.0/24 → 10.8.0.1 (via VPN gateway)

# Check if VPN server has NAT enabled
docker exec iotistic-vpn-test iptables -t nat -L -n -v
# Should show MASQUERADE rule

# Test connectivity step by step
ping 10.8.0.1        # VPN server gateway (should work)
ping 172.25.0.20     # VPN server container IP (should work)
ping 172.25.0.12     # MQTT container (might fail if NAT not working)
```

**Fix**: Check VPN server's iptables rules:
```bash
# Inside VPN container
docker exec -it iotistic-vpn-test sh

# Enable IP forwarding
sysctl -w net.ipv4.ip_forward=1

# Add NAT masquerade rule
iptables -t nat -A POSTROUTING -s 10.8.0.0/16 -o eth0 -j MASQUERADE

# Allow forwarding
iptables -A FORWARD -i tun0 -o eth0 -j ACCEPT
iptables -A FORWARD -i eth0 -o tun0 -m state --state RELATED,ESTABLISHED -j ACCEPT
```

### Issue 3: Agent Can't Connect to MQTT

```powershell
# Test MQTT directly from Windows (without agent)
mosquitto_pub -h 172.25.0.12 -p 1883 -u admin -P iotistic42! -t test -m "hello"

# If this works, check agent MQTT configuration
# If this fails, VPN routing issue

# Check MQTT is listening
docker exec iotistic-mosquitto-test netstat -tuln | grep 1883
```

### Issue 4: DNS Resolution Issues

**Problem**: Agent tries to connect to `mqtt://mosquitto:1883` but can't resolve hostname.

**Solution**: Use IP addresses instead:
```json
{
  "mqttBroker": "mqtt://172.25.0.12:1883",
  "cloudApiEndpoint": "http://172.25.0.13:3002"
}
```

## Testing Checklist

- [ ] Docker services running (`docker ps` shows 5 containers)
- [ ] VPN server healthy (`docker logs iotistic-vpn-test` shows "Initialization Sequence Completed")
- [ ] Database migration completed (`vpn_config` table exists)
- [ ] Device provisioned (API returns VPN credentials)
- [ ] OpenVPN client installed on Windows
- [ ] VPN connected (ipconfig shows 10.8.0.x IP)
- [ ] Routes configured (route print shows 172.25.0.0/24)
- [ ] Can ping VPN gateway (ping 10.8.0.1)
- [ ] Can ping Docker services (ping 172.25.0.12)
- [ ] MQTT connection works (mosquitto_pub test)
- [ ] Agent connects successfully
- [ ] Agent publishes data to MQTT
- [ ] API receives device state updates

## Network Diagram with IP Addresses

```
Windows Host (Your PC)
├─ Network Adapter (Wi-Fi/Ethernet): 192.168.1.100 (example)
├─ Docker Bridge (docker0): 172.17.0.1
├─ VPN TAP Adapter (tun0): 10.8.0.5 (assigned by VPN server)
└─ Agent Process: Binds to all interfaces

Docker Desktop (WSL2)
├─ Docker Network: iotistic-test-net (172.25.0.0/24)
│  ├─ Gateway: 172.25.0.1
│  ├─ Postgres: 172.25.0.10:5432
│  ├─ Redis: 172.25.0.11:6379
│  ├─ Mosquitto: 172.25.0.12:1883
│  ├─ API: 172.25.0.13:3002
│  └─ VPN Server: 172.25.0.20:1194
│
└─ VPN Server Internal
   ├─ tun0 interface: 10.8.0.1 (VPN gateway)
   ├─ eth0 interface: 172.25.0.20 (Docker network)
   └─ Client Pool: 10.8.0.5 - 10.8.0.254
```

## Alternative: Simplified Testing Without VPN

If VPN setup is too complex for initial testing, you can test without VPN first:

```powershell
# Agent connects directly to exposed Docker ports
$env:MQTT_BROKER = "mqtt://localhost:1883"
$env:CLOUD_API_ENDPOINT = "http://localhost:3002"

# Ports exposed to Windows host:
# - MQTT: localhost:1883
# - API: localhost:3002
# - Postgres: localhost:5432

# Start agent
cd C:\Users\Dan\zemfyre-sensor\agent
npm start
```

Then, once basic connectivity works, add VPN layer for secure routing.

## Next Steps

Once local VPN testing works:
1. Test with remote VPN server (cloud deployment)
2. Test with multiple devices connecting simultaneously
3. Implement VPN connection monitoring in agent
4. Add VPN reconnection logic (auto-reconnect on disconnect)
5. Add VPN status to agent heartbeat (vpn_ip_address, vpn_connected)

## Useful Commands

```powershell
# Check VPN status
ipconfig | Select-String -Pattern "OpenVPN"

# Monitor VPN traffic
# (Use Wireshark, filter: udp.port == 1194)

# Check Docker network
docker network inspect zemfyre-sensor_iotistic-test-net

# Check VPN server management interface
curl http://localhost:7505/status

# Download CA certificate
curl http://localhost:8080/ca.crt -o ca.crt

# Check device VPN config in database
docker exec iotistic-postgres-test psql -U postgres -d iotistic -c `
  "SELECT d.uuid, d.vpn_ip_address, v.name, v.enabled FROM devices d LEFT JOIN vpn_config v ON d.vpn_config_id = v.id WHERE d.uuid = 'test-windows-agent-001';"
```
