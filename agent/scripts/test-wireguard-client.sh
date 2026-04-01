#!/bin/bash
# Test WireGuard VPN Connection from Raspberry Pi
# 
# Prerequisites:
# 1. WireGuard installed: sudo apt install wireguard
# 2. VPN config file from provisioning endpoint
# 3. Windows machine's public IP or hostname
#
# Usage:
#   ./test-wireguard-client.sh

set -e

echo "========================================="
echo "WireGuard VPN Client Test Script"
echo "========================================="
echo ""

# Configuration
WG_INTERFACE="wg0"
CONFIG_DIR="/etc/wireguard"
CONFIG_FILE="${CONFIG_DIR}/${WG_INTERFACE}.conf"

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "❌ This script must be run as root (use sudo)"
    exit 1
fi

# Check if WireGuard is installed
if ! command -v wg &> /dev/null; then
    echo "❌ WireGuard is not installed"
    echo ""
    echo "Install with:"
    echo "  sudo apt update"
    echo "  sudo apt install wireguard"
    exit 1
fi

echo "✅ WireGuard is installed"
echo ""

# Check if config exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "⚠️  Config file not found: $CONFIG_FILE"
    echo ""
    echo "To create the config:"
    echo "  1. Get device UUID from provisioning"
    echo "  2. Call provisioning API to get VPN config"
    echo "  3. Save to $CONFIG_FILE"
    echo "  4. Set permissions: chmod 600 $CONFIG_FILE"
    echo ""
    echo "Example API call (replace YOUR_KEY and YOUR_DEVICE_UUID):"
    echo '  curl -X POST http://YOUR_WINDOWS_IP:4002/api/v1/device/register \'
    echo '    -H "Content-Type: application/json" \'
    echo '    -H "X-Provisioning-Key: YOUR_KEY" \'
    echo '    -d '"'"'{"deviceUuid": "YOUR_DEVICE_UUID", "deviceName": "rpi-test"}'"'"' \'
    echo '    | jq -r .vpnConfig.wgConfig > /tmp/wg0.conf'
    echo ""
    echo "  sudo mv /tmp/wg0.conf $CONFIG_FILE"
    echo "  sudo chmod 600 $CONFIG_FILE"
    exit 1
fi

echo "✅ Config file exists: $CONFIG_FILE"
echo ""

# Display config (without private key)
echo "📄 Current configuration (private key hidden):"
echo "---"
grep -v "PrivateKey" "$CONFIG_FILE" || true
echo "---"
echo ""

# Check if interface is already up
if ip link show "$WG_INTERFACE" &> /dev/null; then
    echo "⚠️  Interface $WG_INTERFACE already exists"
    echo ""
    read -p "Do you want to restart it? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🔄 Stopping existing interface..."
        wg-quick down "$WG_INTERFACE" || true
    else
        echo "ℹ️  Using existing interface"
    fi
else
    echo "🚀 Bringing up WireGuard interface..."
    wg-quick up "$WG_INTERFACE"
fi

echo ""
echo "========================================="
echo "🔍 Connection Status"
echo "========================================="
echo ""

# Show interface status
wg show "$WG_INTERFACE"

echo ""
echo "========================================="
echo "🧪 Testing Connectivity"
echo "========================================="
echo ""

# Extract server IP from config
SERVER_IP=$(grep -oP 'Endpoint = \K[^:]+' "$CONFIG_FILE" || echo "")
VPN_GATEWAY="10.8.0.1"
VPN_CLIENT_IP=$(ip addr show "$WG_INTERFACE" | grep -oP 'inet \K[\d.]+' || echo "")

echo "📍 VPN Client IP: ${VPN_CLIENT_IP:-Not assigned}"
echo "📍 VPN Gateway: $VPN_GATEWAY"
echo "📍 Server Endpoint: ${SERVER_IP:-Not found}"
echo ""

# Test 1: Ping VPN gateway
echo "Test 1: Ping VPN Gateway ($VPN_GATEWAY)..."
if ping -c 3 -W 2 "$VPN_GATEWAY" > /dev/null 2>&1; then
    echo "✅ VPN tunnel is working!"
else
    echo "❌ Cannot reach VPN gateway"
    echo ""
    echo "Troubleshooting:"
    echo "  1. Check firewall on Windows machine (allow UDP 51820)"
    echo "  2. Verify Endpoint IP in config matches your Windows machine"
    echo "  3. Check Docker port mapping: docker ps | grep wg-server"
    echo "  4. View server logs: docker logs wg-server"
fi

echo ""

# Test 2: Check handshake
echo "Test 2: Check last handshake..."
HANDSHAKE=$(wg show "$WG_INTERFACE" latest-handshakes | awk '{print $2}')
if [ "$HANDSHAKE" != "0" ]; then
    SECONDS_AGO=$(($(date +%s) - HANDSHAKE))
    echo "✅ Last handshake: ${SECONDS_AGO}s ago"
else
    echo "⚠️  No handshake yet (VPN may still be connecting)"
fi

echo ""

# Test 3: Try to reach API through VPN
echo "Test 3: Test API connectivity through VPN..."
API_URL="http://${VPN_GATEWAY}:3002/health"
echo "Trying: $API_URL"
if curl -s -m 5 "$API_URL" > /dev/null 2>&1; then
    echo "✅ Can reach API through VPN tunnel!"
else
    echo "⚠️  Cannot reach API (may be normal if API not exposed on VPN)"
fi

echo ""
echo "========================================="
echo "📊 Summary"
echo "========================================="
echo ""
echo "Interface: $WG_INTERFACE"
echo "Status: $(ip link show "$WG_INTERFACE" | grep -o 'state [A-Z]*' | cut -d' ' -f2)"
echo "Client IP: ${VPN_CLIENT_IP:-Not assigned}"
echo ""
echo "To monitor connection:"
echo "  watch -n 2 'sudo wg show $WG_INTERFACE'"
echo ""
echo "To stop VPN:"
echo "  sudo wg-quick down $WG_INTERFACE"
echo ""
echo "To view detailed stats:"
echo "  sudo wg show $WG_INTERFACE dump"
echo ""
