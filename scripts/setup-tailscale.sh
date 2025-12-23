#!/bin/bash

# Tailscale VPN Quick Setup Script
# This script helps you configure Tailscale VPN for your IoT platform

set -e

echo "=============================================="
echo "Tailscale VPN Integration - Quick Setup"
echo "=============================================="
echo ""

# Check if we're in the right directory
if [ ! -f "api/package.json" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

echo "📋 Prerequisites Check"
echo "----------------------"
echo ""

# Check if user has Tailscale account
read -p "Do you have a Tailscale account? (y/n): " has_account
if [ "$has_account" != "y" ]; then
    echo ""
    echo "Please sign up at: https://tailscale.com"
    echo "Then run this script again."
    exit 0
fi

# Get Tailscale credentials
echo ""
echo "🔑 Tailscale Configuration"
echo "--------------------------"
echo ""
echo "You'll need:"
echo "1. API Key (from https://login.tailscale.com/admin/settings/keys)"
echo "2. Tailnet Name (shown in admin console, e.g., 'example.com')"
echo ""

read -p "Enter your Tailscale API Key: " api_key
read -p "Enter your Tailnet Name: " tailnet

# Validate inputs
if [ -z "$api_key" ] || [ -z "$tailnet" ]; then
    echo "❌ Error: API Key and Tailnet Name are required"
    exit 1
fi

# Ask about VPN type
echo ""
echo "🔧 VPN Configuration"
echo "--------------------"
echo ""
echo "Choose VPN type for new devices:"
echo "1. Tailscale only (recommended for new deployments)"
echo "2. Keep WireGuard for existing devices, use Tailscale for new ones"
echo "3. WireGuard only (no changes)"
echo ""

read -p "Enter choice (1-3): " vpn_choice

case $vpn_choice in
    1)
        vpn_type="tailscale"
        keep_wireguard=false
        ;;
    2)
        vpn_type="tailscale"
        keep_wireguard=true
        ;;
    3)
        echo ""
        echo "ℹ️  Keeping WireGuard configuration unchanged"
        echo "No changes will be made to your VPN setup"
        exit 0
        ;;
    *)
        echo "❌ Invalid choice"
        exit 1
        ;;
esac

# Create or update .env file
echo ""
echo "📝 Updating Configuration"
echo "-------------------------"
echo ""

ENV_FILE="api/.env"

# Backup existing .env if it exists
if [ -f "$ENV_FILE" ]; then
    echo "Backing up existing .env to .env.backup..."
    cp "$ENV_FILE" "${ENV_FILE}.backup"
fi

# Add Tailscale configuration
echo "" >> "$ENV_FILE"
echo "# ============================================" >> "$ENV_FILE"
echo "# Tailscale VPN Configuration" >> "$ENV_FILE"
echo "# Generated: $(date)" >> "$ENV_FILE"
echo "# ============================================" >> "$ENV_FILE"
echo "VPN_TYPE=$vpn_type" >> "$ENV_FILE"
echo "TAILSCALE_ENABLED=true" >> "$ENV_FILE"
echo "TAILSCALE_API_KEY=$api_key" >> "$ENV_FILE"
echo "TAILSCALE_TAILNET=$tailnet" >> "$ENV_FILE"
echo "" >> "$ENV_FILE"

echo "✅ Configuration updated successfully"
echo ""

# Test API connection
echo "🧪 Testing Tailscale API Connection"
echo "------------------------------------"
echo ""

response=$(curl -s -w "%{http_code}" -o /dev/null \
    -H "Authorization: Bearer $api_key" \
    "https://api.tailscale.com/api/v2/tailnet/$tailnet/devices")

if [ "$response" = "200" ]; then
    echo "✅ Successfully connected to Tailscale API"
    echo "   Your credentials are valid!"
else
    echo "⚠️  Warning: Could not verify Tailscale API connection (HTTP $response)"
    echo "   Please check your credentials manually"
fi

echo ""
echo "=============================================="
echo "Setup Complete!"
echo "=============================================="
echo ""
echo "Next steps:"
echo "1. Restart your API service:"
echo "   cd api && npm run dev"
echo ""
echo "2. Provision a test device to verify VPN setup"
echo ""
echo "3. Check device in Tailscale admin console:"
echo "   https://login.tailscale.com/admin/machines"
echo ""
echo "4. View full documentation:"
echo "   docs/TAILSCALE-VPN-INTEGRATION.md"
echo ""

if [ "$keep_wireguard" = true ]; then
    echo "ℹ️  Note: WireGuard is still enabled for existing devices"
    echo "   New devices will use Tailscale"
    echo "   You can migrate existing devices gradually"
    echo ""
fi

echo "Configuration saved to: $ENV_FILE"
echo "Backup saved to: ${ENV_FILE}.backup"
echo ""
