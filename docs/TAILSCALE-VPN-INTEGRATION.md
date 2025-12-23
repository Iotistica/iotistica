# Tailscale VPN Integration

Complete integration of Tailscale mesh VPN for IoT device connectivity. Provides an alternative to WireGuard with automatic NAT traversal, peer discovery, and simplified management.

## Overview

This integration adds Tailscale as a VPN option alongside the existing WireGuard implementation. Tailscale offers:

- **Zero-configuration NAT traversal**: Works behind any firewall/NAT
- **Automatic peer discovery**: Devices find each other automatically
- **Mesh networking**: Direct peer-to-peer connections when possible
- **ACL-based access control**: Fine-grained permission management
- **Easy management**: Web-based admin console
- **Open-source client**: Full client code transparency (control server is managed)

## Architecture

### API Side (Provisioning)

**File**: `api/src/services/tailscale.service.ts`

- Calls Tailscale Admin API to generate auth keys
- Creates device-specific tags for ACL management
- Manages device lifecycle (registration, deletion)
- Supports both WireGuard and Tailscale simultaneously

### Agent Side (Device)

**File**: `agent/src/network/vpn/tailscale-manager.ts`

- Automatic Tailscale client installation
- Auth key-based device authentication
- Connection status monitoring
- Graceful shutdown and cleanup

### Provisioning Flow

```
1. Device requests provisioning
   ↓
2. API checks VPN_TYPE environment variable
   ↓
3. If "tailscale":
   - Call Tailscale Admin API
   - Generate auth key with device tags
   - Return auth key in provisioning response
   ↓
4. Device receives provisioning response
   ↓
5. Agent checks if Tailscale client installed
   ↓
6. If not installed:
   - Download and install Tailscale client
   ↓
7. Configure and connect to Tailnet
   - Run: tailscale up --authkey <key> --hostname <device-name>
   ↓
8. Verify connection and report status
```

## Configuration

### API Environment Variables

Add these to your API `.env` file:

```bash
# VPN Configuration
VPN_TYPE=tailscale              # Options: "wireguard" | "tailscale" (default: wireguard)

# Tailscale Configuration (required if VPN_TYPE=tailscale)
TAILSCALE_ENABLED=true          # Enable Tailscale VPN
TAILSCALE_API_KEY=tskey-api-... # Tailscale API key (from admin console)
TAILSCALE_TAILNET=example.com   # Your Tailnet name (e.g., example.com or user@example.com)
```

### Agent Environment Variables

No additional configuration needed on the agent side. The agent automatically:
- Receives auth key in provisioning response
- Installs Tailscale client if not present
- Connects to the Tailnet using the provided auth key

## Getting Started

### 1. Create Tailscale Account

1. Sign up at https://tailscale.com
2. Create a Tailnet (your private network)
3. Generate an API key:
   - Go to Settings → Keys → API Keys
   - Click "Generate API Key"
   - Copy the key (starts with `tskey-api-...`)

### 2. Configure ACL Tags (Optional but Recommended)

Edit your Tailscale ACL to define device tags:

```json
{
  "tagOwners": {
    "tag:device": ["autogroup:admin"],
    "tag:iot": ["autogroup:admin"]
  },
  "acls": [
    {
      "action": "accept",
      "src": ["tag:device"],
      "dst": ["*:*"]
    }
  ]
}
```

### 3. Configure API

```bash
# In api/.env
# VPN_TYPE defaults to tailscale (can omit this line)
TAILSCALE_ENABLED=true
TAILSCALE_API_KEY=tskey-api-xxxxxxxxxxxxx
TAILSCALE_TAILNET=yourcompany.com
```

### 4. Restart API

```bash
cd api
npm run dev  # or restart your production API
```

### 5. Provision a Device

When a device provisions, it will automatically:
- Receive a Tailscale auth key
- Install the Tailscale client
- Join your Tailnet

## API Reference

### Tailscale Admin API

The integration uses the official Tailscale Admin API v2:

**Endpoint**: `https://api.tailscale.com/api/v2`

**Methods Used**:
- `POST /tailnet/{tailnet}/keys` - Create auth key
- `GET /tailnet/{tailnet}/devices` - List devices
- `GET /device/{deviceId}` - Get device details
- `DELETE /device/{deviceId}` - Remove device
- `DELETE /tailnet/{tailnet}/keys/{keyId}` - Revoke auth key

**Documentation**: https://tailscale.com/api

### Auth Key Options

When creating an auth key, you can configure:

```typescript
{
  reusable: false,       // One-time use (more secure)
  ephemeral: false,      // Persistent device (not removed on disconnect)
  preauthorized: true,   // Auto-approve device (no manual approval needed)
  expiryDays: 90,        // Auth key expires after 90 days
  tags: ['tag:device']   // Device tags for ACL matching
}
```

## Monitoring

### Check Device Connection (Agent)

```bash
# On the device
tailscale status

# Get Tailscale IP
tailscale ip
```

### Check Device in Tailnet (API)

```bash
# List all devices
curl -H "Authorization: Bearer $TAILSCALE_API_KEY" \
  https://api.tailscale.com/api/v2/tailnet/$TAILSCALE_TAILNET/devices
```

### View in Admin Console

Visit https://login.tailscale.com/admin/machines to see all connected devices.

## Comparison: Tailscale vs WireGuard

| Feature | Tailscale | WireGuard |
|---------|-----------|-----------|
| NAT Traversal | Automatic (STUN/DERP) | Manual port forwarding |
| Setup Complexity | Simple (one command) | Moderate (key exchange, config files) |
| Peer Discovery | Automatic | Manual configuration |
| Client Installation | Official packages | Built into kernel (Linux) |
| Management | Web UI + API | Config files |
| Performance | Good (WireGuard protocol) | Excellent (native) |
| Open Source | Client only | Fully open source |
| Scalability | High (100s of devices) | High (requires management) |
| ACL Support | Built-in | Manual (firewall rules) |

## Switching Between VPN Types

### Use Tailscale for New Devices (Default)

```bash
# API .env
# VPN_TYPE=tailscale  # This is the default, no need to set
TAILSCALE_ENABLED=true
```

### Use WireGuard for New Devices

```bash
# API .env
VPN_TYPE=wireguard  # Override default
VPN_ENABLED=true
WG_SERVER_URL=http://wg-server:8089
```

### Run Both Simultaneously

Both VPN types can coexist:
- Existing devices keep their WireGuard connections
- New devices get Tailscale
- Devices can have both (not recommended, but possible)

## Troubleshooting

### Device Not Appearing in Tailnet

1. Check agent logs for Tailscale installation errors
2. Verify auth key is valid (not expired)
3. Check firewall allows UDP port 41641 (Tailscale)
4. Verify device has internet connectivity

### Auth Key Creation Fails

1. Verify `TAILSCALE_API_KEY` is correct
2. Check API key has "Devices" write permission
3. Verify `TAILSCALE_TAILNET` format (e.g., `example.com` or `user@example.com`)

### Connection Issues

```bash
# On device, check Tailscale status
tailscale status

# Check Tailscale logs
journalctl -u tailscaled -f

# Ping another device
tailscale ping <hostname>
```

## Security Considerations

1. **Auth Key Storage**: Auth keys are stored in `/etc/iotistic/tailscale/authkey` with `0600` permissions
2. **One-Time Keys**: By default, auth keys are single-use (more secure)
3. **Key Expiry**: Auth keys expire after 90 days (configurable)
4. **Device Tags**: Use tags for ACL-based access control
5. **Revocation**: Devices can be removed from the Tailnet via API or admin console

## Migration from WireGuard

If you have existing devices using WireGuard:

1. Keep `VPN_ENABLED=true` for backward compatibility
2. Set `VPN_TYPE=tailscale` for new device provisioning
3. Gradually migrate devices by:
   - Decommissioning device (removes WireGuard config)
   - Re-provisioning device (gets Tailscale config)

## Advanced Features

### Advertise Routes

Devices can advertise subnet routes:

```typescript
// In provisioning response customization
tailscale.configure({
  authKey: '...',
  advertiseRoutes: ['192.168.1.0/24'],  // Advertise local network
  acceptRoutes: true                      // Accept routes from other nodes
});
```

### Exit Nodes

Devices can act as exit nodes (route internet traffic):

```bash
# On device
tailscale up --advertise-exit-node
```

### MagicDNS

Tailscale provides automatic DNS for devices:

```bash
# Ping by hostname instead of IP
ping device-name.tailnet-name.ts.net
```

## References

- [Tailscale Documentation](https://tailscale.com/kb)
- [Tailscale API Reference](https://tailscale.com/api)
- [Tailscale ACL Documentation](https://tailscale.com/kb/1018/acls)
- [WireGuard Protocol](https://www.wireguard.com/)

## Support

For Tailscale-specific issues:
- Community forum: https://forum.tailscale.com
- GitHub: https://github.com/tailscale/tailscale

For integration issues:
- Check agent logs: `docker logs <agent-container>`
- Check API logs: `docker logs <api-container>`
- Verify environment variables are set correctly
