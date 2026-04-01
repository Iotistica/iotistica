#!/bin/bash
# Test script to simulate agent installation with VPN on Raspberry Pi
# This simulates what happens when a user runs the install script

set -e

echo "==========================================="
echo "Simulating Agent Installation with VPN"
echo "==========================================="
echo ""

# Configuration (CHANGE THESE)
API_ENDPOINT="${API_ENDPOINT:-http://YOUR_WINDOWS_IP:4002}"
PROVISIONING_KEY="${PROVISIONING_KEY:-your-provisioning-key-here}"

echo "Configuration:"
echo "  API Endpoint: $API_ENDPOINT"
echo "  Provisioning Key: ${PROVISIONING_KEY:0:20}..."
echo ""

# Check prerequisites
echo "Checking prerequisites..."

if ! command -v curl &> /dev/null; then
    echo "✗ curl is not installed"
    exit 1
fi
echo "✓ curl found"

if ! command -v jq &> /dev/null; then
    echo "⚠️  jq is not installed (install with: sudo apt install jq)"
    echo "This test requires jq to parse JSON responses"
    exit 1
fi
echo "✓ jq found"

if ! command -v wg &> /dev/null; then
    echo "⚠️  WireGuard is not installed (install with: sudo apt install wireguard)"
    echo "Continuing without WireGuard setup..."
    WG_AVAILABLE=false
else
    echo "✓ WireGuard found"
    WG_AVAILABLE=true
fi

echo ""
echo "==========================================="
echo "Step 1: Testing API connectivity"
echo "==========================================="
echo ""

# Test API health
echo "Testing API endpoint..."
if curl -sf "${API_ENDPOINT}/health" > /dev/null; then
    echo "✓ API is reachable"
else
    echo "✗ Cannot reach API at $API_ENDPOINT"
    echo ""
    echo "Make sure:"
    echo "  1. API is running: docker ps | grep iotistic-api"
    echo "  2. Port 4002 is accessible"
    echo "  3. You're using the correct IP address"
    exit 1
fi

echo ""
echo "==========================================="
echo "Step 2: Device Provisioning"
echo "==========================================="
echo ""

# Generate device UUID
DEVICE_UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
DEVICE_NAME="test-$(hostname)-$(date +%s)"

echo "Device UUID: $DEVICE_UUID"
echo "Device Name: $DEVICE_NAME"
echo ""

echo "Calling provisioning API..."
PROVISION_RESPONSE=$(curl -s -X POST "${API_ENDPOINT}/api/v1/device/register" \
    -H "Content-Type: application/json" \
    -H "X-Provisioning-Key: ${PROVISIONING_KEY}" \
    -d "{
        \"deviceUuid\": \"${DEVICE_UUID}\",
        \"deviceName\": \"${DEVICE_NAME}\",
        \"deviceType\": \"test-device\",
        \"metadata\": {
            \"test\": true,
            \"hostname\": \"$(hostname)\"
        }
    }")

# Check if provisioning was successful
if echo "$PROVISION_RESPONSE" | jq -e '.device' &> /dev/null; then
    echo "✓ Device provisioned successfully"
    
    # Show device details
    echo ""
    echo "Device Details:"
    echo "$PROVISION_RESPONSE" | jq -r '.device | "  UUID: \(.uuid)\n  Name: \(.device_name)\n  Type: \(.device_type)"'
    
    # Check VPN configuration
    if echo "$PROVISION_RESPONSE" | jq -e '.vpnConfig.enabled' &> /dev/null; then
        VPN_ENABLED=$(echo "$PROVISION_RESPONSE" | jq -r '.vpnConfig.enabled')
        
        if [ "$VPN_ENABLED" = "true" ]; then
            echo ""
            echo "✓ VPN is enabled for this device"
            
            VPN_IP=$(echo "$PROVISION_RESPONSE" | jq -r '.vpnConfig.ipAddress')
            echo "  VPN IP: $VPN_IP"
            
            # Save VPN config for testing
            if [ "$WG_AVAILABLE" = true ]; then
                echo ""
                echo "==========================================="
                echo "Step 3: WireGuard VPN Setup"
                echo "==========================================="
                echo ""
                
                # Extract WireGuard config
                WG_CONFIG=$(echo "$PROVISION_RESPONSE" | jq -r '.vpnConfig.wgConfig')
                
                # Save to temp file
                echo "$WG_CONFIG" > /tmp/wg-test.conf
                echo "✓ WireGuard config saved to /tmp/wg-test.conf"
                
                echo ""
                echo "WireGuard Configuration Preview:"
                echo "---"
                grep -v "PrivateKey" /tmp/wg-test.conf || cat /tmp/wg-test.conf
                echo "---"
                
                echo ""
                echo "⚠️  IMPORTANT: Update the Endpoint in the config!"
                echo "   The config uses 'vpn.example.com' - replace with your actual public IP"
                echo ""
                echo "To install this config manually:"
                echo "  1. Edit endpoint: sudo nano /tmp/wg-test.conf"
                echo "  2. Move to WireGuard: sudo mv /tmp/wg-test.conf /etc/wireguard/wg-test.conf"
                echo "  3. Set permissions: sudo chmod 600 /etc/wireguard/wg-test.conf"
                echo "  4. Start VPN: sudo wg-quick up wg-test"
                echo "  5. Test connectivity: ping 10.8.0.1"
                echo ""
                
                # Ask if user wants to continue with automatic setup
                if [ -t 0 ]; then  # Check if stdin is a terminal
                    read -p "Do you want to automatically setup WireGuard now? (y/N): " -n 1 -r
                    echo
                    
                    if [[ $REPLY =~ ^[Yy]$ ]]; then
                        echo ""
                        echo "Setting up WireGuard (requires sudo)..."
                        
                        # Check if running as root
                        if [ "$(id -u)" -ne 0 ]; then
                            echo "This requires root privileges..."
                            sudo mv /tmp/wg-test.conf /etc/wireguard/wg-test.conf
                            sudo chmod 600 /etc/wireguard/wg-test.conf
                            
                            echo ""
                            echo "⚠️  You need to update the Endpoint first!"
                            echo "   Run: sudo nano /etc/wireguard/wg-test.conf"
                            echo "   Change: Endpoint = vpn.example.com:51820"
                            echo "   To: Endpoint = YOUR_PUBLIC_IP:51820"
                            echo ""
                            read -p "Press Enter after updating the endpoint..."
                            
                            echo "Starting WireGuard..."
                            if sudo wg-quick up wg-test; then
                                echo "✓ WireGuard tunnel started"
                                
                                echo ""
                                echo "WireGuard Status:"
                                sudo wg show wg-test
                                
                                echo ""
                                echo "Testing connectivity..."
                                if ping -c 3 -W 2 10.8.0.1; then
                                    echo "✓ VPN tunnel is working!"
                                else
                                    echo "⚠️  Cannot reach VPN gateway"
                                    echo "Check firewall and endpoint configuration"
                                fi
                            else
                                echo "✗ Failed to start WireGuard"
                                echo "Check the logs and endpoint configuration"
                            fi
                        else
                            # Running as root
                            mv /tmp/wg-test.conf /etc/wireguard/wg-test.conf
                            chmod 600 /etc/wireguard/wg-test.conf
                            
                            echo ""
                            echo "⚠️  You need to update the Endpoint first!"
                            read -p "Press Enter after updating /etc/wireguard/wg-test.conf..."
                            
                            wg-quick up wg-test
                            wg show wg-test
                        fi
                    fi
                fi
            else
                echo ""
                echo "⚠️  WireGuard not installed, skipping VPN setup"
                echo "   Install WireGuard: sudo apt install wireguard"
            fi
        else
            echo ""
            echo "⚠️  VPN is not enabled for this device"
        fi
    else
        echo ""
        echo "⚠️  No VPN configuration in response"
    fi
    
    # Show MQTT credentials
    if echo "$PROVISION_RESPONSE" | jq -e '.mqtt' &> /dev/null; then
        echo ""
        echo "MQTT Credentials:"
        echo "$PROVISION_RESPONSE" | jq -r '.mqtt | "  Broker: \(.broker)\n  Username: \(.username)\n  Password: \(.password)"'
    fi
    
else
    echo "✗ Provisioning failed"
    echo ""
    echo "Response:"
    echo "$PROVISION_RESPONSE" | jq '.' 2>/dev/null || echo "$PROVISION_RESPONSE"
    exit 1
fi

echo ""
echo "==========================================="
echo "Test Complete"
echo "==========================================="
echo ""
echo "Summary:"
echo "  Device provisioned: ✓"
echo "  VPN configured: $([ "$VPN_ENABLED" = "true" ] && echo "✓" || echo "✗")"
echo "  WireGuard available: $([ "$WG_AVAILABLE" = true ] && echo "✓" || echo "✗")"
echo ""

if [ -f /tmp/wg-test.conf ]; then
    echo "Next steps:"
    echo "  1. Review config: cat /tmp/wg-test.conf"
    echo "  2. Update endpoint to your Windows machine's public IP"
    echo "  3. Install config: sudo mv /tmp/wg-test.conf /etc/wireguard/wg-test.conf"
    echo "  4. Start VPN: sudo wg-quick up wg-test"
    echo "  5. Test: ping 10.8.0.1"
fi
